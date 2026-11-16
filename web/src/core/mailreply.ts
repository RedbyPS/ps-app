// Reply to a client email from inside PS (the developer, 8 Nov 2026: "when I click Reply I want the email to come up with an
// animation in the middle of my screen, type a reply, a full email screen with my email signature that I can save.
// Save different responses... and schedule send: in 3 minutes, 5 minutes, and scroll the mouse wheel on the time").
// The developer's permission (8 Nov 2026): "I give PS permission to send emails for me", ONLY for replies HE types and sends or
// schedules himself. PS never sends by itself: no auto replies, nothing written for him and sent. The send is always
// his click on Send, or the time he picked for a scheduled send.
//
// This file is pure (no DOM, no network): what the compose screen fills in, the saved responses and signatures kept
// in settings.mailReply (encrypted with the rest of the settings, so the website, PS and the phone share them), the
// schedule times, and the job handed to the Mac (ps-mac MailSend.swift sends it from the right account in the same
// thread; the tokens and the Instantly key live only in the Mac's Keychain, never here or in the vault).
import type { ClientRec, Reply } from "./model";
import { cleanReplyFrom, FREE_DOMAINS, domainOf, firstName, parseMatchEntry, replierName } from "./mail.ts";

/** A quick reply. `clients` empty or unset: General, offered for every email. Otherwise only for those clients. */
export interface SavedResponse { id: string; name: string; text: string; clients?: string[] }
/** What Send does (the developer, 8 Nov 2026: "so I don't seem like a robot"): now with the short Undo, or at a random time
 *  between min and max minutes from now, picked once at Send and never picked again. */
export interface SendMode { random: boolean; min: number; max: number }
export interface MailReplyPrefs {
  /** The signature for every account without one of its own. Plain text, line breaks kept. */
  sig?: string;
  /** A signature per sending account (lower case address). */
  sigs?: Record<string, string>;
  /** Saved responses, in the developer's order. Unset: the starter ones show (nothing is written until he changes one). */
  responses?: SavedResponse[];
  /** What Send does, remembered for next time. Unset: Send now. */
  send?: SendMode;
  /** When this changed last: two devices' copies join by the newer one. */
  at?: string;
}

/** Where a reply goes out: the Gmail account the email came to, or the Instantly inbox the lead wrote to. */
export type Via = "gmail" | "instantly";

/** Everything the compose screen needs about the email being answered (made by the main page from the card). */
export interface ReplyCtx {
  cardId: string;
  via: Via;
  account: string;            // the Gmail account (or Instantly inbox) the email came to: its sign in sends, its signature is used
  /** Gmail only: the verified send-as address the email was addressed to, when it is not the account. The reply goes From it. */
  replyFrom?: string | null;
  to: string;
  toName: string | null;
  first: string;              // for {first name}
  name: string;               // for {name}
  company: string;            // for {company}
  subject: string;            // the email's own subject
  threadId: string | null;    // Gmail thread (the reply goes in it) or Instantly thread
  clientIds: string[];        // the clients this sender is (their own quick replies show first)
  emailId: string | null;     // Instantly: the email answered (reply_to_uuid)
  quote: { at: string; who: string; text: string };
}

export interface ReplyJob {
  id: string;
  cardId: string;
  via: Via;
  account: string;
  /** Gmail: the send-as address to put in From instead of the account (the Mac checks it again). Absent: From the account. */
  replyFrom?: string | null;
  to: string;
  toName: string | null;
  subject: string;
  text: string;
  html: string;
  threadId: string | null;
  emailId: string | null;
  sendAt: number;             // ms since 1970
  createdAt: number;
  /** What the compose screen showed, so Edit on a scheduled send opens it again as it was. */
  draft: { message: string; sig: string; quote: boolean; ctx: ReplyCtx };
}

// ---------- limits ----------
export const LIMITS = { message: 20_000, sig: 2_000, respName: 60, respText: 5_000, responses: 40, subject: 300 } as const;
/** The safety window after Send: "Sending in 10 seconds, Undo". */
export const UNDO_SECONDS = 10;
/** The quick schedule choices (minutes). */
export const QUICK = [3, 5, 10, 15, 30] as const;
/** A scheduled send: 1 minute to 7 days ahead. One wheel notch is 1 minute (Shift: 5). */
export const SCHED = { min: 1, max: 7 * 24 * 60, step: 1, bigStep: 5, start: 5 } as const;

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const validEmail = (s: string) => s.length <= 254 && EMAIL.test(s.trim());
/** One line, no control characters (a header can never be split into two). */
export const oneLine = (s: string, max = 300) => (s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ---------- placeholders ----------
export interface Fill { first: string; name: string; company: string; email: string }

/** {first name}, {name}, {company} and {email}, any case, spaces or none ({firstname}, { First Name }).
 *  An empty value leaves no gap behind ("Hi {first name}," with no name: "Hi there,"). Unknown braces stay as typed. */
export function fillPlaceholders(text: string, f: Fill): string {
  const val = (k: string): string | null => {
    const key = k.toLowerCase().replace(/[\s_-]+/g, "");
    if (key === "firstname" || key === "first") return f.first || "there";
    if (key === "name" || key === "fullname") return f.name || f.first || "there";
    if (key === "company") return f.company;
    if (key === "email") return f.email;
    return null;
  };
  const GAP = "\u0000";   // an empty value, until the space next to it is taken away too
  return (text || "").replace(/\u0000/g, "")
    .replace(/\{\s*([a-z][a-z _-]{0,20}?)\s*\}/gi, (all, k: string) => { const v = val(k); return v === null ? all : v || GAP; })
    .replace(/[ \t]*\u0000(?=[,.!?;:])/g, "")    // "from {company}." with no company: no space left before the full stop
    .replace(/[ \t]*\u0000[ \t]*/g, (m) => /^[ \t]/.test(m) && /[ \t]$/.test(m) ? " " : "");
}
/** The words that fill them, from the email being answered. */
export const fillOf = (c: Pick<ReplyCtx, "first" | "name" | "company" | "to">): Fill => ({ first: c.first, name: c.name, company: c.company, email: c.to });

/** The placeholders the compose screen offers to insert. */
export const PLACEHOLDERS = ["{first name}", "{name}", "{company}"] as const;

// ---------- subject, quote, bodies ----------
/** "Re: " once: an email already starting Re: (or RE, Aw, Sv, Antw) keeps its subject as it is. */
export function reSubject(subject: string): string {
  const s = oneLine(subject, LIMITS.subject);
  if (!s) return "Re:";
  return /^(re|aw|sv|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** "On Sun, 8 Nov 2026 at 03:12, Alex <person13@x.com> wrote:" (the email's own time, this Mac's clock). */
export function quoteHeader(at: string, who: string): string {
  const d = new Date(at);
  const when = Number.isNaN(d.getTime()) ? "" : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} at ${hhmm(d.getTime())}`;
  return `On ${when ? when + ", " : ""}${who} wrote:`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const htmlLines = (s: string) => esc(s).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
const tidy = (s: string) => (s || "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "");

/** The reply as plain text and as HTML: the message, the signature under it, then the email being answered
 *  (when the quote is kept). The same words in both; the HTML only adds line breaks and the quote's left line. */
export function buildBodies(message: string, sig: string, quote: ReplyCtx["quote"] | null): { text: string; html: string } {
  const m = tidy(message).slice(0, LIMITS.message), g = tidy(sig).slice(0, LIMITS.sig);
  const q = quote && tidy(quote.text) ? { head: quoteHeader(quote.at, quote.who), body: tidy(quote.text) } : null;
  const text = [m, g ? `${g}` : "", q ? `${q.head}\n${q.body.split("\n").map((l) => `> ${l}`).join("\n")}` : ""].filter(Boolean).join("\n\n") + "\n";
  const html = `<div dir="ltr">${htmlLines(m)}${g ? `<br><br><div class="gmail_signature">${htmlLines(g)}</div>` : ""}</div>` +
    (q ? `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${esc(q.head)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${htmlLines(q.body)}</blockquote></div>` : "");
  return { text, html };
}

// ---------- the card -> what to answer ----------
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho)\./i;
const domainCompany = (email: string) => { const d = (email.split("@")[1] || "").toLowerCase(); return d && !FREE.test(d) ? d.split(".")[0].replace(/^./, (c) => c.toUpperCase()) : ""; };

/** A client email card (Gmail): the reply record and its client. */
export function ctxFromGmail(cardId: string, r: Reply, c: ClientRec | undefined): ReplyCtx | null {
  if (!r?.account || !validEmail(r.from || "") || !r.threadId) return null;
  const first = replierName(c, r);
  const full = oneLine(r.fromName || "", 120).replace(/^["']|["']$/g, "") || c?.contactName || first;
  const company = c && c.name && c.name.toLowerCase() !== first.toLowerCase() ? c.name : domainCompany(r.from);
  return {
    cardId, via: "gmail", account: r.account.toLowerCase(), replyFrom: cleanReplyFrom(r.replyFrom, r.account), to: r.from.trim(), toName: r.fromName ? oneLine(r.fromName, 120) : null,
    first: firstName(first) || first, name: full, company, subject: r.subject || "", threadId: r.threadId, emailId: null, clientIds: r.clientId ? [r.clientId] : [],
    quote: { at: r.date, who: r.fromName ? `${oneLine(r.fromName, 120)} <${r.from}>` : r.from, text: r.opening || r.snippet || "" },
  };
}

/** An Instantly reply card: the reply in the feed. */
export function ctxFromLead(cardId: string, r: { id?: string; threadId?: string | null; from?: string; lead?: string; fromName?: string | null; account?: string; at?: string | null; subject?: string | null; opening?: string | null }): ReplyCtx | null {
  const to = (r.from || r.lead || "").trim();
  if (!r.id || !r.account || !validEmail(to)) return null;
  const n = oneLine(r.fromName || "", 120).replace(/["']/g, "");
  const first = (n && !n.includes("@") ? n.split(/\s+/)[0] : "") || "";
  return {
    cardId, via: "instantly", account: r.account.toLowerCase(), to, toName: n || null, first, name: n || first, company: domainCompany(to),
    subject: r.subject || "", threadId: r.threadId || null, emailId: r.id, clientIds: [],
    quote: { at: r.at || "", who: n ? `${n} <${to}>` : to, text: r.opening || "" },
  };
}

// ---------- signatures and saved responses ----------
/** The starters shown until the developer saves his own list (the developer's own example words, 8 Nov 2026). */
/** The starter quick reply signs with the person's own name (Settings, their name), or nothing when none is set. */
export function starterResponses(name: string): SavedResponse[] {
  const sign = (name || "").trim().slice(0, 40);
  return [{ id: "starter-on-it", name: "On it", text: `Hi {first name},\n\nPerfect, I'm on it, I'll get back to you shortly.\n\nThanks${sign ? `,\n${sign}` : ""}` }];
}
export const responsesOf = (p: MailReplyPrefs | undefined, name: string) => p?.responses ?? starterResponses(name);
/** The account's own signature, else the one for every account, else none. */
export function sigFor(p: MailReplyPrefs | undefined, account: string): string {
  const own = p?.sigs?.[account.toLowerCase()];
  return own !== undefined ? own : p?.sig || "";
}

export type MailReplyOp =
  | { op: "sig"; account: string | null; text: string }        // account null: the signature for every account
  | { op: "sigClear"; account: string }                        // the account goes back to the one for every account
  | { op: "addResp"; id: string; name: string; text: string; clients?: string[] }
  | { op: "editResp"; id: string; name?: string; text?: string; clients?: string[] }
  | { op: "send"; mode: SendMode }
  | { op: "delResp"; id: string }
  | { op: "orderResp"; ids: string[] };

const str = (v: unknown, max: number) => typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, max) : null;
const idOk = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
/** Client ids for a response: undefined (not given), [] (General) or up to 50 ids. Null when malformed. */
const cleanClients = (v: unknown): string[] | undefined | null => v === undefined ? undefined : Array.isArray(v) && v.length <= 50 && v.every(idOk) ? [...new Set(v as string[])] : null;

/** A change from the compose screen or Settings, checked field by field (it crosses from another page). */
export function cleanMailReplyOp(o: unknown): MailReplyOp | null {
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  switch (x.op) {
    case "sig": {
      const text = str(x.text, LIMITS.sig); if (text === null) return null;
      const account = x.account === null || x.account === undefined ? null : typeof x.account === "string" && validEmail(x.account) ? x.account.toLowerCase() : undefined;
      return account === undefined ? null : { op: "sig", account, text };
    }
    case "sigClear": return typeof x.account === "string" && validEmail(x.account) ? { op: "sigClear", account: x.account.toLowerCase() } : null;
    case "addResp": {
      const name = str(x.name, LIMITS.respName), text = str(x.text, LIMITS.respText);
      const clients = cleanClients(x.clients);
      if (clients === null) return null;
      return idOk(x.id) && name !== null && text !== null && (name.trim() || text.trim()) ? { op: "addResp", id: x.id, name: oneLine(name, LIMITS.respName), text, ...(clients?.length ? { clients } : {}) } : null;
    }
    case "editResp": {
      if (!idOk(x.id)) return null;
      const name = x.name === undefined ? undefined : str(x.name, LIMITS.respName), text = x.text === undefined ? undefined : str(x.text, LIMITS.respText);
      const clients = cleanClients(x.clients);
      if (name === null || text === null || clients === null || (name === undefined && text === undefined && clients === undefined)) return null;
      return { op: "editResp", id: x.id, ...(name !== undefined ? { name: oneLine(name, LIMITS.respName) } : {}), ...(text !== undefined ? { text } : {}), ...(clients !== undefined ? { clients } : {}) };
    }
    case "delResp": return idOk(x.id) ? { op: "delResp", id: x.id } : null;
    case "send": { const m = cleanSendMode(x.mode); return m ? { op: "send", mode: m } : null; }
    case "orderResp": return Array.isArray(x.ids) && x.ids.every(idOk) && x.ids.length <= LIMITS.responses ? { op: "orderResp", ids: x.ids as string[] } : null;
    default: return null;
  }
}

/** The new prefs after one change. Starters become the developer's own list the first time he changes any response. */
export function applyMailReplyOp(p: MailReplyPrefs | undefined, op: MailReplyOp, name: string, now = Date.now()): MailReplyPrefs {
  const out: MailReplyPrefs = { ...(p || {}), at: new Date(now).toISOString() };
  const list = [...responsesOf(p, name)];
  switch (op.op) {
    case "sig":
      if (op.account === null) out.sig = op.text;
      else out.sigs = { ...(p?.sigs || {}), [op.account]: op.text };
      return out;
    case "sigClear": { const s = { ...(p?.sigs || {}) }; delete s[op.account]; out.sigs = s; return out; }
    case "addResp":
      if (list.length >= LIMITS.responses || list.some((r) => r.id === op.id)) return { ...out, responses: list };
      out.responses = [...list, { id: op.id, name: op.name || firstWords(op.text), text: op.text, ...(op.clients?.length ? { clients: op.clients } : {}) }];
      return out;
    case "editResp":
      out.responses = list.map((r) => {
        if (r.id !== op.id) return r;
        const n: SavedResponse = { ...r, ...(op.name !== undefined ? { name: op.name || firstWords(op.text ?? r.text) } : {}), ...(op.text !== undefined ? { text: op.text } : {}) };
        if (op.clients !== undefined) { if (op.clients.length) n.clients = op.clients; else delete n.clients; }   // [] = General again
        return n;
      });
      return out;
    case "send": out.send = op.mode; return out;
    case "delResp": out.responses = list.filter((r) => r.id !== op.id); return out;
    case "orderResp": {
      const by = new Map(list.map((r) => [r.id, r]));
      const seen = new Set<string>();
      const ordered = op.ids.map((id) => by.get(id)).filter((r): r is SavedResponse => !!r && !seen.has(r.id) && !!seen.add(r.id));
      out.responses = [...ordered, ...list.filter((r) => !seen.has(r.id))];   // any the list did not name keep their place at the end
      return out;
    }
  }
}
/** A name for a response saved without one: its first words. */
export const firstWords = (t: string) => oneLine(t.replace(/\{[^}]*\}/g, ""), 200).replace(/^(hi|hey|hello|dear)\b[^,.!?]*[,.!?]?\s*/i, "").split(/\s+/).slice(0, 4).join(" ").replace(/[,.!?;:]+$/, "") || "Response";

/** Two devices' copies: the newer change wins (one person edits these, rarely, by hand). */
export function mergeMailReply(a: MailReplyPrefs | undefined, b: MailReplyPrefs | undefined): MailReplyPrefs | undefined {
  if (!a || !b) return a || b;
  return (b.at || "") > (a.at || "") ? b : a;
}

// ---------- quick replies per client ----------
type ClientMatch = { id: string; name: string; email?: string | null; matchAddrs?: string[]; archived?: boolean };
/** Every client this sender is: their exact address (main email or a "replies come from" address), else the clients
 *  of the most exact domain in a match list, else clients whose own email is at that company domain (never a free
 *  mail domain). Several clients can share an address or a domain: all of them count. */
export function clientsForSender(email: string, clients: ClientMatch[]): string[] {
  const e = (email || "").trim().toLowerCase();
  if (!validEmail(e)) return [];
  const d = domainOf(e);
  const exact: string[] = [], explicit: [string, string][] = [], implicit: string[] = [];
  for (const c of clients) {
    for (const raw of c.matchAddrs || []) {
      const m = parseMatchEntry(raw);
      if (!m) continue;
      if (m.type === "addr" && m.v === e) exact.push(c.id);
      else if (m.type === "domain" && !FREE_DOMAINS.has(m.v) && (d === m.v || d.endsWith("." + m.v))) explicit.push([m.v, c.id]);
    }
    const main = c.email ? parseMatchEntry(c.email) : null;
    if (main?.type === "addr") {
      if (main.v === e) exact.push(c.id);
      else if (!FREE_DOMAINS.has(domainOf(main.v)) && domainOf(main.v) === d) implicit.push(c.id);
    }
  }
  const uniq = (a: string[]) => [...new Set(a)];
  if (exact.length) return uniq(exact);
  if (explicit.length) { const best = Math.max(...explicit.map(([v]) => v.length)); return uniq(explicit.filter(([v]) => v.length === best).map(([, id]) => id)); }
  return uniq(implicit);
}
export const isGeneral = (r: SavedResponse) => !r.clients?.length;
/** The right side of the reply panel: this sender's clients' own replies first (one group per client, named), then
 *  the General ones (unless hidden). A reply ticked for a client never shows for anyone else. */
export function responsesFor(list: SavedResponse[], clientIds: string[], names: Record<string, string>, showGeneral = true): { label: string; clientId: string | null; items: SavedResponse[] }[] {
  const groups = clientIds.map((id) => ({ label: names[id] || "This client", clientId: id as string | null, items: list.filter((r) => r.clients?.includes(id)) })).filter((g) => g.items.length);
  if (showGeneral) groups.push({ label: "General", clientId: null, items: list.filter(isGeneral) });
  return groups;
}

// ---------- send behaviour ----------
/** The one line the reply panel shows under From while this account cannot send yet (10 Nov 2026: Reply is in the Tab
 *  list now, so the panel itself says what to do, once, instead of the button hiding). Empty when it can send, while
 *  the Mac has not said yet (status null), or when the Mac gave its own problem line. Words only; nothing is sent. */
export function sendSetupHint(via: "gmail" | "instantly", ready: boolean, statusKnown: boolean, problem?: string | null): string {
  if (ready || !statusKnown || problem) return "";
  return via === "gmail"
    ? "Sending is not set up for this Gmail account yet. Click Connect Gmail for sending once: Google's own sign in opens in your browser and PS app keeps it in this Mac's Keychain. After that, Send works from here."
    : "Sending through Instantly is not set up yet. Click Add Instantly key once and paste your Instantly API key: PS app keeps it in this Mac's Keychain. After that, Send works from here.";
}

export const SEND_RANGE = { min: 1, max: 240, defMin: 2, defMax: 15 } as const;
export const DEFAULT_SEND: SendMode = { random: false, min: SEND_RANGE.defMin, max: SEND_RANGE.defMax };
/** Checked: whole minutes, 1 to 240, min never above max (swapped when typed the other way round). Null: not numbers. */
export function cleanSendMode(v: unknown): SendMode | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const n = (k: string) => typeof x[k] === "number" && Number.isFinite(x[k]) ? Math.max(SEND_RANGE.min, Math.min(SEND_RANGE.max, Math.round(x[k] as number))) : null;
  const a = n("min"), b = n("max");
  if (a === null || b === null) return null;
  return { random: x.random === true, min: Math.min(a, b), max: Math.max(a, b) };
}
export const sendModeOf = (p: MailReplyPrefs | undefined): SendMode => cleanSendMode(p?.send) || DEFAULT_SEND;
/** The delay for one Send with the random behaviour, in ms: anywhere from min to max minutes, to the second. Picked
 *  once, at the click; the job then carries a fixed time (the Mac never picks again, not after a sleep or a restart). */
export function randomDelayMs(m: SendMode, rnd: () => number = Math.random): number {
  const c = cleanSendMode(m) || DEFAULT_SEND;
  const r = Math.min(Math.max(rnd(), 0), 0.999999);
  return Math.round((c.min * 60 + r * (c.max - c.min) * 60)) * 1000;
}
/** One wheel notch on a range end: a minute, keeping min at or below max (the other end moves along). */
export function stepRange(m: SendMode, end: "min" | "max", dir: number): SendMode {
  const v = Math.max(SEND_RANGE.min, Math.min(SEND_RANGE.max, (end === "min" ? m.min : m.max) + Math.sign(dir)));
  if (end === "min") return { ...m, min: v, max: Math.max(m.max, v) };
  return { ...m, max: v, min: Math.min(m.min, v) };
}

// ---------- schedule ----------
const pad = (n: number) => String(n).padStart(2, "0");
/** "04:17" on this Mac's clock (24 hour, as the rest of PS). */
export const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const clampMins = (m: number) => Math.max(SCHED.min, Math.min(SCHED.max, Math.round(m)));
/** One wheel notch on the time: a minute (Shift: 5 minutes, snapping to a multiple of 5). */
export function stepMins(mins: number, dir: number, big = false): number {
  const m = Math.round(mins), d = Math.sign(dir);
  if (!big) return clampMins(m + d * SCHED.step);
  const s = SCHED.bigStep;   // to the next multiple of 5 that way: 7 goes to 10 or 5
  return clampMins(d > 0 ? Math.floor(m / s) * s + s : Math.ceil(m / s) * s - s);
}
/** "in 7 min", "in 1 h 05 min". */
export const inText = (mins: number) => mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h${mins % 60 ? ` ${pad(mins % 60)} min` : ""}`;
/** "Sends at 04:17", "Sends at 04:17 tomorrow", "Sends at 04:17 on Tue 10 Nov". */
export function sendsAtText(at: number, now = Date.now()): string {
  const a = new Date(at), n = new Date(now);
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  const when = day(a) === day(n) ? "" : day(a) === day(tomorrow) ? " tomorrow" : ` on ${a.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
  return `Sends at ${hhmm(at)}${when}`;
}
/** What the developer typed for the time: minutes ("7", "7m", "7 min"), hours ("1h", "1h 30", "1:30h"), or a clock time
 *  ("04:17", "4.17", "16:05") which means the next time the clock shows it. Minutes from now, or null. */
export function parseWhen(input: string, now = Date.now()): number | null {
  const s = (input || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,4})\s*(m|min|mins|minute|minutes)?$/))) return clampOrNull(Number(m[1]));
  if ((m = s.match(/^(\d{1,3})\s*(h|hr|hrs|hour|hours)(?:\s*(\d{1,2})\s*(m|min|mins)?)?$/))) return clampOrNull(Number(m[1]) * 60 + Number(m[3] || 0));
  if ((m = s.match(/^(\d{1,2})[:.](\d{2})$/))) {
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    const n = new Date(now), t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, mi, 0, 0);
    if (t.getTime() <= now + 30_000) t.setDate(t.getDate() + 1);
    return clampOrNull(Math.ceil((t.getTime() - now) / 60_000));
  }
  return null;
}
const clampOrNull = (m: number) => Number.isFinite(m) && m >= SCHED.min && m <= SCHED.max ? m : null;

/** The job for the Mac: checked here, and again natively before anything leaves. Throws a plain sentence when
 *  something is missing, which the compose screen shows. */
export function makeJob(ctx: ReplyCtx, d: { message: string; sig: string; quote: boolean; to?: string; subject?: string }, sendAt: number, now: number, id: string): ReplyJob {
  const to = (d.to ?? ctx.to).trim();
  if (!validEmail(to)) throw new Error("The To address does not look like an email address.");
  if (!tidy(d.message)) throw new Error("Type a reply first.");
  if (!validEmail(ctx.account)) throw new Error("PS app does not know which account this email came to.");
  if (ctx.via === "instantly" && !ctx.emailId) throw new Error("PS app does not know which Instantly email this answers.");
  if (ctx.via === "gmail" && !ctx.threadId) throw new Error("PS app does not know which Gmail thread this is in.");
  const { text, html } = buildBodies(d.message, d.sig, d.quote ? ctx.quote : null);
  return {
    id, cardId: ctx.cardId, via: ctx.via, account: ctx.account, ...(ctx.via === "gmail" && cleanReplyFrom(ctx.replyFrom, ctx.account) ? { replyFrom: cleanReplyFrom(ctx.replyFrom, ctx.account) } : {}), to, toName: to === ctx.to ? ctx.toName : null,
    subject: reSubject(d.subject ?? ctx.subject), text, html, threadId: ctx.threadId, emailId: ctx.emailId,
    sendAt: Math.max(now, Math.round(sendAt)), createdAt: now,
    draft: { message: d.message.slice(0, LIMITS.message), sig: d.sig.slice(0, LIMITS.sig), quote: d.quote, ctx: { ...ctx, to } },
  };
}

// ---------- the queue (what the Mac reports back) ----------
export type OutState = "queued" | "sending" | "sent" | "failed" | "cancelled";
export interface OutRow { id: string; cardId: string; via: Via; account: string; to: string; toName: string | null; subject: string; sendAt: number; state: OutState; error?: string; undo?: boolean }

/** The line under a queued send: "Sending in 8 s", "Sends at 04:17", "Sending now", "Sent", or why it failed. */
export function rowText(r: OutRow, now = Date.now()): string {
  if (r.state === "sending") return "Sending now";
  if (r.state === "sent") return "Sent";
  if (r.state === "cancelled") return "Cancelled";
  if (r.state === "failed") return r.error ? `Not sent: ${r.error}` : "Not sent";
  const s = Math.max(0, Math.ceil((r.sendAt - now) / 1000));
  return r.undo || s <= 60 ? `Sending in ${s} s` : `${sendsAtText(r.sendAt, now)} (${inText(Math.ceil(s / 60))})`;
}
/** Waiting first (soonest on top), then failed, newest send last. */
export const queueOrder = (list: OutRow[]) => [...list].sort((a, b) => rank(a) - rank(b) || a.sendAt - b.sendAt);
const rank = (r: OutRow) => r.state === "sending" ? 0 : r.state === "queued" ? 1 : r.state === "failed" ? 2 : 3;
