// What we truthfully know about Gmail (V1.63, the developer 16 Nov 2026: Gmail was connected and mail was arriving, yet Settings said
// "No Gmail accounts connected yet" and the email panel said "Connect your Gmail"). The status check (gmail_status) can fail or
// come back empty for reasons we cannot see from the app, so it is never the only witness: mail that already arrived is proof
// too. Pure: no React, no network, so tests/gmailtruth.test.ts loads it.
import { ownAccounts } from "./mailrules.ts";
import type { MailRules } from "./mailrules.ts";

export interface GmailRow { account: string; last_ok: string | null; last_error: string | null; readonly: boolean | null }
export interface SeenAccount { account: string; last: string | null }
type AnyDoc = { kind: string; data: unknown; id?: string };

/** The status rows, cleaned (anything that is not a row with an account is dropped). */
export function cleanRows(rows: unknown): GmailRow[] {
  if (!Array.isArray(rows)) return [];
  const out: GmailRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.account !== "string" || !r.account) continue;
    out.push({ account: r.account, last_ok: typeof r.last_ok === "string" ? r.last_ok : null, last_error: typeof r.last_error === "string" ? r.last_error : null, readonly: typeof r.readonly === "boolean" ? r.readonly : null });
  }
  return out;
}

/** Gmail accounts this vault already holds mail for (reply records and "Who emails me" records), each with the newest time we know. */
export function seenAccounts(docs: Iterable<AnyDoc>): SeenAccount[] {
  const list = [...docs];
  const last = new Map<string, string | null>();
  for (const a of ownAccounts(list as never)) last.set(a, null);
  for (const d of list) {
    if (d.kind !== "msender") continue;
    const m = d.data as { accounts?: string[]; last?: string } | null;
    for (const a of m?.accounts || []) {
      const k = a.toLowerCase();
      const old = last.get(k) ?? null;
      if (m?.last && (!old || m.last > old)) last.set(k, m.last);
    }
  }
  return [...last].filter(([a]) => !!a).sort((x, y) => x[0].localeCompare(y[0])).map(([account, l]) => ({ account, last: l }));
}

/** A failed status call in plain words (small, muted line). */
export function checkWords(err: unknown): string {
  const raw = typeof err === "string" ? err : err && typeof err === "object" ? String((err as { message?: unknown }).message || "") : "";
  const m = raw.replace(/\s+/g, " ").trim();
  if (!m) return "The status check did not answer.";
  if (/failed to fetch|network|timeout|timed out|abort/i.test(m)) return "The status check could not be reached.";
  if (/jwt|not authenticated|permission denied|401|403/i.test(m)) return "The status check was refused: " + m.slice(0, 100);
  if (/could not find the function|PGRST202|404/i.test(m)) return "The status check is missing on the server: " + m.slice(0, 100);
  return "The status check said: " + m.slice(0, 120);
}

export type GmailView =
  | { state: "status"; rows: GmailRow[]; note: string | null }                    // the status check answered with accounts
  | { state: "seen"; accounts: SeenAccount[]; note: string | null }               // no status rows, but mail arrived: connected
  | { state: "none" }                                                              // asked, nothing anywhere: not connected
  | { state: "error"; note: string }                                               // check failed, no mail seen: unknown, say why
  | { state: "asking" };

/** One answer for Settings: the status rows when there are any, else the mail that arrived, else honest "none" or the error. */
export function gmailView(o: { rows: unknown; asked: boolean; error: unknown; seen: SeenAccount[] }): GmailView {
  const rows = cleanRows(o.rows);
  const failed = o.error !== null && o.error !== undefined && o.error !== false;
  const note = failed ? checkWords(o.error) : null;
  if (rows.length) return { state: "status", rows, note: null };
  if (o.seen.length) return { state: "seen", accounts: o.seen, note: failed ? note : o.asked ? "The status check lists no account, but your mail is arriving." : null };
  if (failed) return { state: "error", note: note! };
  return o.asked ? { state: "none" } : { state: "asking" };
}

/** Has anyone been picked: a client with an address to match, or someone on the Always notify me list. */
export function mailPicked(clients: Iterable<{ data: { email?: string | null; matchAddrs?: string[]; archived?: boolean } }>, rules: MailRules | undefined): boolean {
  for (const c of clients) {
    if (c.data.archived) continue;
    if ((c.data.email || "").trim() || (c.data.matchAddrs || []).some((x) => (x || "").trim())) return true;
  }
  return Object.values(rules?.e || {}).some((x) => x.l === "notify");
}

/** How the cached answer moves. A failed call is not an answer: it never replaces a "connected", and it is asked again soon. */
export const RETRY_FAILED_MS = 60_000;
export function nextKnown(prev: boolean | null, o: { rows: unknown; failed: boolean; evidence: boolean }): boolean | null {
  if (o.evidence) return true;
  if (o.failed) return prev === true ? true : false;
  return cleanRows(o.rows).length > 0;
}
