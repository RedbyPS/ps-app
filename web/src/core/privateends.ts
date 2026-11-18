// Private mode ends with the meeting (PS 1.68, feature "private-ends"; Jan, 18 Nov 2026: "Private mode should automatically
// disable once you leave a meeting. It shouldn't be turned on all the time.").
//
// Private mode (settings.privateMode) comes on by hand (the mask on the Meetings panel) or from the "Start private mode?" card
// when a meeting starts. Each time it comes on, settings.privateAt says when. The rule:
//  - It turns itself off once a real meeting (people or a video link, on a calendar set to Meetings, not one taken off the
//    panel) has ENDED after it came on, and no real meeting is on now or starts within PRIVATE_NEXT_MS. So a meeting that was
//    on when it came on, or one that started later, both end it; back to back meetings keep it on until the last one ends.
//  - Turned on by hand with no meeting around, it stays on until a meeting ends or the person turns it off: nothing has ended
//    after it came on.
//  - No privateAt (it came on in an older build, or on a device that does not stamp it): the Mac's meeting watcher stamps the
//    first time it sees it on (src/meetwatch.ts), so the rule then counts from that moment and never ends it on a meeting
//    that was already over before.
// Pure, tested in tests/privateends.test.ts. Runs only where meetings are watched (PS on the Mac, src/meetwatch.ts), so nothing
// polls while PS is closed: a Mac that was asleep through the end of a meeting turns it off as soon as it runs again.
import type { CalEvent } from "./model";
import { isMeeting } from "./notescard.ts";

export const PRIVATE_ENDS_FEATURE = "private-ends";
/** A real meeting starting this soon after another ends keeps private mode on (back to back calls). */
export const PRIVATE_NEXT_MS = 5 * 60_000;

/** The settings to save when private mode is switched (privateAt: when it came on, or null when it goes off). */
export function privatePatch(on: boolean, now: number): { privateMode: boolean; privateAt: string | null } {
  return { privateMode: on, privateAt: on ? new Date(now).toISOString() : null };
}

/** When private mode came on (ms), or null when that is not known. */
export function privateSince(privateAt: unknown): number | null {
  const t = typeof privateAt === "string" ? Date.parse(privateAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Should private mode turn itself off now? `events`: the meetings the panel shows (Meetings calendars, hidden ones left out). */
export function privateShouldEnd(o: { privateMode: boolean | undefined; privateAt: unknown; events: CalEvent[]; now: number }): boolean {
  if (o.privateMode !== true) return false;
  const since = privateSince(o.privateAt);
  if (since === null) return false;
  const real = o.events.filter(isMeeting).map((e) => ({ s: Date.parse(e.start!), e: Date.parse(e.end!) }))
    .filter((m) => Number.isFinite(m.s) && Number.isFinite(m.e) && m.e > m.s);
  const ended = real.some((m) => m.e > since && m.e <= o.now);
  if (!ended) return false;
  return !real.some((m) => m.s - PRIVATE_NEXT_MS <= o.now && m.e > o.now);
}

/** What the watcher writes, or null: stamp a missing privateAt while it is on, clear a left over one while it is off. */
export function privateStamp(privateMode: boolean | undefined, privateAt: unknown, now: number): { privateAt: string | null } | null {
  const has = privateSince(privateAt) !== null;
  if (privateMode === true && !has) return { privateAt: new Date(now).toISOString() };
  if (privateMode !== true && privateAt != null) return { privateAt: null };
  return null;
}
