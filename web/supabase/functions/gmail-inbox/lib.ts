// Pure helpers for gmail-inbox (no imports, so Node tests can load this file as is).

const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

/** Seal a payload to the owner's ECDH P-256 public key. Same scheme as fireflies-inbox and crypto.ts sealTo. */
export async function seal(publicKeyB64: string, payload: unknown): Promise<string> {
  const pub = await crypto.subtle.importKey("spki", unb64(publicKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey) as ArrayBuffer);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: enc.encode("cincee-inbox-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload))));
  return JSON.stringify({ v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) });
}

export async function sha256hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// readonly false = an existing Gmail connector login you chose to reuse because Google blocked a
// new read-only sign-in for that account. The function still only ever reads with it.
export interface Account { email: string; client_id: string; client_secret: string; refresh_token: string; readonly?: boolean }

export function parseAccounts(raw: string | null | undefined): Account[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a.email === "string" && a.client_id && a.client_secret && a.refresh_token)
      .map((a) => ({ email: a.email.toLowerCase(), client_id: a.client_id, client_secret: a.client_secret, refresh_token: a.refresh_token, readonly: a.readonly !== false }));
  } catch { return []; }
}

/** Merge newly connected accounts into the stored list (same email = replaced). */
export function mergeAccounts(old: Account[], add: Account[]): Account[] {
  const m = new Map(old.map((a) => [a.email, a]));
  for (const a of add) m.set(a.email.toLowerCase(), { ...a, email: a.email.toLowerCase() });
  return [...m.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export const BACKFILL_MS = 7 * 86_400_000;
export const OVERLAP_MS = 15 * 60_000;

/** Gmail search window. Overlaps the last cursor so late-indexed mail is not missed (the seen table dedupes). */
export function afterSec(cursorMs: number | null | undefined, nowMs: number): number {
  const from = cursorMs ? cursorMs - OVERLAP_MS : nowMs - BACKFILL_MS;
  return Math.floor(Math.max(from, nowMs - BACKFILL_MS) / 1000);
}

// Inbound: anything in the inbox not from you, minus the bulk tabs. The browser matches clients.
export const inboundQuery = (after: number) => `in:inbox -from:me -in:chats -category:promotions -category:social -category:forums after:${after}`;
export const sentQuery = (after: number) => `in:sent after:${after}`;

type Header = { name: string; value: string };
export interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: Header[] }
export interface GmailMessage {
  id: string; threadId: string; internalDate?: string; snippet?: string; labelIds?: string[];
  payload?: GmailPart;
}

const hdr = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

const cut = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n) : s);

// The opening of the message (you, 17 Oct 2026: so PS can show the first 4 sentences): the start
// of the plain text body, with quoted replies, forwards and signatures cut off, at most 800
// characters. Never attachments, never the rest of the body. Sealed like everything else.
const OPENING_MAX = 800;
function b64urlText(data: string): string {
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ""; }
}
function findPart(p: GmailPart | undefined, type: string): GmailPart | null {
  if (!p) return null;
  if (p.mimeType?.toLowerCase() === type && p.body?.data) return p;
  for (const c of p.parts || []) { const f = findPart(c, type); if (f) return f; }
  return null;
}
function htmlText(h: string): string {
  return decodeEntities(h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote[\s\S]*$/i, " ")                          // quoted thread (Gmail, Outlook)
    .replace(/<div[^>]*class="?gmail_quote[\s\S]*$/i, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""));
}
/** The new words at the top of an email, without the thread below or the signature. */
export function bodyOpening(m: GmailMessage): string {
  const plain = findPart(m.payload, "text/plain");
  const html = plain ? null : findPart(m.payload, "text/html");
  let t = plain ? b64urlText(plain.body!.data!) : html ? htmlText(b64urlText(html.body!.data!)) : "";
  t = t.replace(/\r\n?/g, "\n");
  const cuts = [
    /^>/m,                                         // quoted lines
    /^On [^\n]{4,200}(?:\n[^\n]{0,120})?wrote:\s*$/m, // "On Fri, ... Alex <p@x> wrote:"
    /^-{2,}\s*(?:Original|Forwarded) Message/mi,
    /^_{8,}\s*$/m,                                 // Outlook's line above the old message
    /^From:\s/m,
    /^Sent from my /m,
    /^-- ?$/m,                                     // signature
  ].map((r) => t.search(r)).filter((i) => i >= 0);
  if (cuts.length) t = t.slice(0, Math.min(...cuts));
  return t.replace(/\s+/g, " ").trim().slice(0, OPENING_MAX);
}

/** What gets sealed for one inbound message: headers, Gmail's snippet and the opening (above). */
export function inboundPayload(account: string, m: GmailMessage) {
  return {
    kind: "gmail",
    account,
    id: m.id,
    threadId: m.threadId,
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    from: cut(hdr(m, "From"), 400),
    to: cut(hdr(m, "To"), 1000),
    cc: cut(hdr(m, "Cc"), 1000),
    subject: cut(hdr(m, "Subject"), 400),
    snippet: cut(decodeEntities(m.snippet || ""), 400),
    opening: bodyOpening(m) || null,
    msgId: cut(hdr(m, "Message-ID") || hdr(m, "Message-Id"), 400),
  };
}

export function sentPayload(account: string, m: GmailMessage) {
  return {
    kind: "gmail-sent",
    account,
    id: m.id,
    threadId: m.threadId,
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
  };
}

/** Gmail snippets come HTML-escaped ("&#39;", "&amp;"). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Short, content-free error text for gmail_state (never mail content, never tokens). */
/** True when Google refused only because of its per minute quota (the next run continues). */
export function isSlowDown(e: unknown): boolean {
  return /^gmail (429|403 (rateLimitExceeded|userRateLimitExceeded))/.test(e instanceof Error ? e.message : String(e));
}

export function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/ya29\.[\w.-]+/g, "[token]").replace(/1\/\/[\w.-]+/g, "[token]").slice(0, 200);
}
