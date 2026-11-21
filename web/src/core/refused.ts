// A change the server refuses for good (PS 1.72, Jan 21 Nov 2026: "on my phone I just see one task list ... on my computer
// I see multiple"). Every account but the developer's has a storage limit on the server (supabase/migrations
// 025_multi_owner.sql space_quota_guard: 25 MB with background videos and files, and 1 MB a record). Past it, any save that
// makes a record bigger is refused: a new list makes the settings record bigger. The vault used to keep such a change
// unsent forever and try it again on every save, and the device that made it kept showing it (an unsent copy is the
// newest on that device, core/select.ts settings), so the Mac showed the lists and every other device never got them.
// Nothing said so: the refusal was dropped and the sync line read as fine.
//
// Now (core/vault.ts flush, these rules):
// - the change is never dropped and never cut down to fit: it stays saved on this device, shown there as before;
// - it waits before the next try, longer each time (1 minute up to an hour), so the other changes keep going up;
// - the refusal is logged ("vault: refused ...") and the sync status shows the server's own words (the existing "Sync
//   issue" line and its tooltip, Settings' banner), until the change goes up or the account has room again.
// Pure: no imports, so tests/refused.test.ts runs it with plain values.

/** The server's words for a change it will refuse every time while the account is full (or the record too big). */
const QUOTA = /storage limit reached|too large to store/i;
export function errText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  const o = e as { message?: unknown; details?: unknown; hint?: unknown };
  return [o.message, o.details, o.hint].filter((x): x is string => typeof x === "string").join(" ");
}
export const isQuotaRefusal = (e: unknown) => QUOTA.test(errText(e));

/** Minutes to wait before trying a refused change again, by how many times the server refused it. */
export const HOLD_MIN = [1, 2, 4, 8, 15, 30, 60] as const;
export interface Held { tries: number; until: number; words: string }

/** The server refused this change (again) at `now`: when to try it next. */
export function refusedAgain(prev: Held | undefined, e: unknown, now: number): Held {
  const tries = (prev?.tries ?? 0) + 1;
  const min = HOLD_MIN[Math.min(tries, HOLD_MIN.length) - 1];
  return { tries, until: now + min * 60_000, words: (errText(e) || "Refused by the server").slice(0, 160) };
}
/** Is this change waiting before its next try? */
export const waiting = (h: Held | undefined, now: number) => !!h && now < h.until;
/** The changes to send now: everything but those waiting. */
export function sendable<T extends { id: string }>(rows: Iterable<T>, held: ReadonlyMap<string, Held>, now: number): T[] {
  return [...rows].filter((r) => !waiting(held.get(r.id), now));
}
/** When the next waiting change may be tried (null: none waits). */
export function nextTry(held: ReadonlyMap<string, Held>): number | null {
  let t: number | null = null;
  for (const h of held.values()) if (t === null || h.until < t) t = h.until;
  return t;
}
/** The sync status while changes wait: the server's own words, or null when none waits. */
export function heldWords(held: ReadonlyMap<string, Held>): string | null {
  for (const h of held.values()) return h.words;
  return null;
}
/** One line for the log (never a record's content: its id and the server's words only). */
export function heldLog(id: string, h: Held, now: number): string {
  return `vault: the server refused change ${id.slice(0, 8)} (${h.words}); kept on this device, try ${h.tries + 1} in ${Math.round((h.until - now) / 60_000)} min`;
}
