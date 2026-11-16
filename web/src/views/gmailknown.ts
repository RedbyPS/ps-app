// Is any Gmail account connected (V1.62)? One gmail_status call per page, kept 10 minutes, shared by the email panel and
// Settings, Client emails. Only asked while the answer matters (the panel is empty, or Settings is open), so it adds
// almost no traffic (Supabase egress rule: only move what changed).
// V1.63: Gmail mail that already arrived is proof of a connection, so the panel never says "not connected" over it, and the
// cached "not connected" is forgotten the moment mail shows up. A failed call is not an answer: it is asked again after a
// minute (not ten), never turns a "connected" into "not connected", and its reason is kept so Settings can show it.
import { useEffect, useSyncExternalStore } from "react";
import { sb } from "../core/vault";
import { type GmailKnown } from "../core/mailempty";
import { RETRY_FAILED_MS, nextKnown } from "../core/gmailtruth";

const KEEP_MS = 10 * 60_000;
let known: GmailKnown = null;
let at = 0;
let wait = KEEP_MS;
let failure: string | null = null;
let asking: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

function ask(): void {
  if (asking || (known !== null && Date.now() - at < wait)) return;
  asking = (async () => {
    let data: unknown = null, failed = false, why: string | null = null;
    try { const r = await sb.rpc("gmail_status"); data = r.data; if (r.error) { failed = true; why = r.error.message || "error"; } }
    catch (e) { failed = true; why = String((e as Error)?.message || e); }
    known = nextKnown(known, { rows: data, failed, evidence: false });
    failure = failed ? why : null;
    wait = failed ? RETRY_FAILED_MS : KEEP_MS;
    at = Date.now(); asking = null;
    tell();
  })();
}
/** Settings calls this after a change, so the panel asks again on its next look. */
export function forgetGmailKnown(): void { at = 0; }
/** Gmail mail has arrived: whatever was cached as "not connected" is wrong now. */
function noteMail(): void {
  if (known === true && !failure) return;
  known = true; failure = null; at = Date.now(); wait = KEEP_MS; tell();
}

/** The answer, asking once when `need` is true. `mail`: this vault already holds Gmail mail, which settles it as connected. */
export function useGmailKnown(need: boolean, mail = false): GmailKnown {
  const v = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => known);
  useEffect(() => { if (mail) noteMail(); else if (need) ask(); }, [need, mail]);
  return mail ? true : v;
}
/** Why the last status check failed (null when it did not). */
export function useGmailFailure(): string | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => failure);
}
