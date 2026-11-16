// Gmail replies: pure helpers (no vault state), so the matching rules are easy to test.
// The gmail-inbox edge function seals every new inbox message (headers + snippet) to the developer's
// public key. The browser opens them, keeps the ones from a known client as "reply" records
// (owner private, vault key) and ignores the rest, which the server prunes after 7 days.
import type { ClientRec, Reply } from "./model";

/** Sealed inbound message, as built by supabase/functions/gmail-inbox/lib.ts inboundPayload. */
export interface GmailInbound {
  kind: "gmail";
  account: string;
  id: string;
  threadId: string;
  date: string | null;
  from: string | null;
  to?: string | null;
  cc?: string | null;
  subject: string | null;
  snippet: string | null;
  opening?: string | null;       // the start of the body, quotes and signature cut (lib.ts bodyOpening)
  msgId?: string | null;
  /** The verified send-as address of this Gmail account the email was addressed to (lib.ts replyFromOf). Absent: it came to the account itself. */
  replyFrom?: string | null;
}
/** The email's identity: its Message-ID header without the angle brackets, lower case. Without one (rare), the Gmail id. */
export function messageKey(m: { msgId?: string | null; account?: string | null; id?: string | null }): string {
  const h = (m.msgId || "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  if (h) return `mid:${h}`.slice(0, 200);
  return `g:${(m.account || "").toLowerCase()}:${m.id || ""}`.slice(0, 200);
}

/** Sealed marker that the developer sent something in a thread (lib.ts sentPayload). */
export interface GmailSent { kind: "gmail-sent"; account: string; id: string; threadId: string; date: string | null }

// Shared mailbox providers: a domain match here would catch strangers, so only exact addresses count.
export const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "outlook.com", "hotmail.com", "hotmail.co.uk",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "zoho.com", "mail.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "aliasmail.com",
]);

/** First address in a header like `"Morgan, Alex" <pmorgan@client4.example>` or `person1@b.co`. */
export function parseAddress(header: string | null | undefined): { name: string | null; email: string | null } {
  if (!header) return { name: null, email: null };
  const angle = header.match(/^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) return { name: angle[1]?.trim() || null, email: angle[2].toLowerCase() };
  const bare = header.match(/[^\s<>",;]+@[^\s<>",;]+/);
  return { name: null, email: bare ? bare[0].toLowerCase() : null };
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** One entry from a client's match list: a full address, or a domain ("acme.com", "@acme.com"). */
export function parseMatchEntry(raw: string): { type: "addr" | "domain"; v: string } | null {
  const s = raw.trim().toLowerCase().replace(/^mailto:/, "");
  if (!s) return null;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return { type: "addr", v: s };
  const d = s.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return { type: "domain", v: d };
  return null;
}

/** Split what the developer typed (commas, spaces, new lines) into clean, de-duplicated entries. */
export function cleanMatchList(text: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part.trim()) continue;
    const e = parseMatchEntry(part);
    if (!e) { bad.push(part.trim()); continue; }
    if (!ok.includes(e.v)) ok.push(e.v);
  }
  return { ok, bad };
}

type ClientLike = { id: string; data: Pick<ClientRec, "email" | "matchAddrs" | "archived" | "name"> };

/**
 * Who sent this? Exact address first (match list or the client's main email), then an explicit
 * domain from a match list (longest wins, subdomains count), then the company domain of the
 * client's main email when it is not a shared provider. Active clients beat archived ones.
 */
export function buildMatcher(clients: ClientLike[]): (email: string | null) => string | null {
  const exact = new Map<string, ClientLike>();
  const explicitDom: [string, ClientLike][] = [];
  const implicitDom: [string, ClientLike][] = [];
  const order = [...clients].sort((a, b) => Number(!!a.data.archived) - Number(!!b.data.archived) || a.data.name.localeCompare(b.data.name));
  for (const c of order) {
    for (const raw of c.data.matchAddrs || []) {
      const e = parseMatchEntry(raw);
      if (!e) continue;
      if (e.type === "addr") { if (!exact.has(e.v)) exact.set(e.v, c); }
      else if (!FREE_DOMAINS.has(e.v)) explicitDom.push([e.v, c]);
    }
    const main = c.data.email ? parseMatchEntry(c.data.email) : null;
    if (main?.type === "addr") {
      if (!exact.has(main.v)) exact.set(main.v, c);
      const d = domainOf(main.v);
      if (!FREE_DOMAINS.has(d)) implicitDom.push([d, c]);
    }
  }
  const byDomain = (list: [string, ClientLike][], d: string) => {
    let best: [string, ClientLike] | null = null;
    for (const x of list) if ((d === x[0] || d.endsWith("." + x[0])) && (!best || x[0].length > best[0].length)) best = x;
    return best?.[1].id ?? null;
  };
  return (email) => {
    if (!email) return null;
    const e = email.toLowerCase();
    const hit = exact.get(e);
    if (hit) return hit.id;
    const d = domainOf(e);
    return byDomain(explicitDom, d) ?? byDomain(implicitDom, d);
  };
}

/**
 * Which client an inbound message belongs to. The sender first (buildMatcher). Failing that, the thread: a
 * message in a thread that is already a client's reply record counts for that client, so a colleague writing
 * from another address (a partner, an assistant on Gmail) still shows a card (the developer, 4 Nov 2026: an assistant
 * email gave no pop up). Never the developer's own accounts, so his mail between his own inboxes never makes a card.
 */
export function clientForInbound(
  match: (email: string | null) => string | null, m: Pick<GmailInbound, "from">,
  thread: Pick<Reply, "clientId"> | undefined, own: Set<string>,
): string | null {
  const email = parseAddress(m.from).email;
  const hit = match(email);
  if (hit) return hit;
  if (!email || own.has(email) || !thread?.clientId) return null;
  return thread.clientId;
}

/** A plain address, lower case, and not the account itself; anything else is null (the reply goes From the account). */
export function cleanReplyFrom(v: unknown, account: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const a = v.trim().toLowerCase();
  return a.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(a) && a !== (account || "").toLowerCase() ? a : null;
}

const MAX_IDS = 50;

/** Fold one inbound message into the thread's reply record. Returns null when nothing changes. */
export function applyInbound(existing: Reply | undefined, m: GmailInbound, clientId: string): Reply | null {
  const { name, email } = parseAddress(m.from);
  const date = m.date || new Date().toISOString();
  const fresh = {
    lastKey: messageKey(m),
    from: email || "", fromName: name, subject: (m.subject || "(no subject)").trim(), snippet: (m.snippet || "").trim(), date,
    opening: (m.opening || "").trim() || null,
    replyFrom: cleanReplyFrom(m.replyFrom, m.account),
  };
  if (!existing) {
    return { clientId, account: m.account, threadId: m.threadId, msgIds: [m.id], ...fresh, count: 1, handled: false, handledAt: null, handledHow: null };
  }
  if (existing.msgIds.includes(m.id)) return null;
  const newer = date >= existing.date;
  // A message that arrived after the developer dealt with the thread makes it actionable again.
  const reopen = existing.handled && date > (existing.handledAt || "");
  return {
    ...existing,
    ...(newer ? fresh : {}),
    clientId,
    msgIds: [...existing.msgIds, m.id].slice(-MAX_IDS),
    count: existing.count + 1,
    handled: reopen ? false : existing.handled,
    handledAt: reopen ? null : existing.handledAt,
    handledHow: reopen ? null : existing.handledHow,
  };
}

/** The developer answered in Gmail after the client's latest message: the reply is handled. */
export function applySent(existing: Reply | undefined, s: GmailSent): Reply | null {
  if (!existing || existing.handled || !s.date) return null;
  if (s.date < existing.date) return null;
  return { ...existing, handled: true, handledAt: s.date, handledHow: "replied" };
}

/** Opens the thread in the right Gmail account. */
export function gmailThreadLink(account: string, threadId: string) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${encodeURIComponent(threadId)}`;
}

/** A Gmail address without its Gmail ending: owner1 plus the Gmail domain gives "owner1". */
export const accountLabel = (account: string) => account.replace(/@gmail\.com$/i, "");

/** First name from a display name: "Alex morgan" and "Morgan, Alex" both give "Alex". */
export function firstName(display: string | null | undefined): string | null {
  if (!display) return null;
  const s = display.replace(/^["']|["']$/g, "").trim();
  if (!s || s.includes("@")) return null;
  const parts = s.includes(",") ? s.split(",").slice(1).join(" ").trim().split(/\s+/) : s.split(/\s+/);
  return parts[0] || null;
}

/** "Alex" for "Alex replied". The client's own contact gets their greeting name; a colleague gets theirs. */
export function replierName(c: Pick<ClientRec, "greetingName" | "contactName" | "name" | "email"> | undefined, r: Pick<Reply, "fromName" | "from">) {
  const own = !!c?.email && c.email.trim().toLowerCase() === r.from.toLowerCase();
  const contactFirst = c?.contactName?.split(" ")[0] || null;
  const sender = firstName(r.fromName);
  if (own) return c?.greetingName || contactFirst || sender || c?.name || r.from;
  return sender || (r.from ? r.from.split("@")[0] : null) || c?.greetingName || c?.name || "Someone";
}

/** The first few sentences of a preview ("Hi the developer. Loved it! Can we..." -> up to n of them). */
export function firstSentences(text: string, n: number) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  const parts = t.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [t];
  return parts.slice(0, n).join("").trim();
}
