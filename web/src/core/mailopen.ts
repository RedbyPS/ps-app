// The island's email counts (PS 1.61). The developer: a "1" on the island "opens nothing useful" (it opened Gmail, and it showed with
// no email panel to go to). Now:
//  - the counts only show while the Tab list's email panel is allowed: Client emails switched on (core/mailswitch.ts) and
//    the panel not taken off the Tab list in Edit mode. Otherwise the island gets 0 and shows no envelope or arrow;
//  - a click on the envelope (client emails) or the reply arrow (lead replies) brings the Tab list up (ps-mac
//    IslandMailOpen.swift) and sends "mailOpen" with which kind. The panel may not be on screen yet, so the wish waits
//    here a few seconds; the panel goes to its page and opens its newest email of that kind (views/TaskMap.tsx ClientMail).
// Pure (no DOM, no vault), unit tested (tests/mailopen.test.ts). Never sends anything.
import { kindOf, type TabLayout } from "./tablayout.ts";

export type MailVia = "gmail" | "instantly";
const WAIT_MS = 10_000;
let want: { via: MailVia; at: number } | null = null;
const listeners = new Set<() => void>();

export const cleanMailVia = (v: unknown): MailVia | null => (v === "gmail" || v === "instantly" ? v : null);

/** The island asked for the newest email of this kind. */
export function requestMailOpen(via: unknown, now = Date.now()) {
  const v = cleanMailVia(via);
  if (!v) return;
  want = { via: v, at: now };
  listeners.forEach((l) => l());
}
/** The kind waiting to open, or null when none waits or it is too old (it stays until taken). */
export const peekMailOpen = (now = Date.now()): MailVia | null => (want && now - want.at <= WAIT_MS ? want.via : null);
/** Taken once: the panel opened it. */
export function takeMailOpen(now = Date.now()): MailVia | null {
  const v = peekMailOpen(now);
  want = null;
  return v;
}
export function onMailOpen(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** The newest email of that kind in the panel's rows: its card id. Null when there is none. */
export function newestOf(rows: readonly { cardId: string; via: string; at: string }[], via: MailVia): string | null {
  let best: { cardId: string; at: string } | null = null;
  for (const r of rows) if (r.via === via && (!best || r.at > best.at)) best = r;
  return best ? best.cardId : null;
}

/** The email panel on the Tab list: the panel itself unless Edit mode took it off, else a copy of it, else null. */
export function mailPanelId(l: TabLayout | null | undefined): string | null {
  if (!l) return "mail";
  if (!l.hidden.includes("mail")) return "mail";
  return (l.extra ?? []).find((id) => kindOf(id) === "mail") ?? null;
}

/** PS 1.68 (Jan, 18 Nov 2026: the island said 20 emails "but I have no clue what these 20 emails are"): the envelope counts the
 *  client emails the email panel lists, the ones not dealt with yet from a client still on the list (core/select.ts openReplies
 *  uses this same test). It used to count the pop-up cards not dismissed yet, which also held emails already answered or marked
 *  Done and stopped at 20, so the number matched nothing on screen. */
export function isOpenReply(r: { handled?: boolean | null; clientId?: string | null }, liveClients: ReadonlySet<string>): boolean {
  return !r.handled && !!r.clientId && liveClients.has(r.clientId);
}
export function openMailCount(replies: Iterable<{ handled?: boolean | null; clientId?: string | null }>, liveClients: ReadonlySet<string>): number {
  let n = 0;
  for (const r of replies) if (isOpenReply(r, liveClients)) n++;
  return n;
}

/** May the island show its email counts? Only with the panel to open: Client emails on and the panel on the Tab list. */
export const islandMailOk = (mailOn: boolean, l: TabLayout | null | undefined) => mailOn && mailPanelId(l) !== null;
