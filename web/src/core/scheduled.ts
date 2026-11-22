// Scheduled tasks (PS 1.75, Jan 22 Nov 2026: "when you schedule a task, it should not show up ... maybe it can be at the very
// bottom of the list ... and when you click a button it will show all the scheduled tasks for the future. ... if it's P1 ...
// the timer shouldn't start on it until it's actually the day when it's scheduled").
//
// The rule, in plain words:
//  - A one-off task that is not done, has no Clients do date (`doOn`, PS 1.73, which lands by its own rule) and whose `due` day
//    is after the person's day is SCHEDULED for that day. The day is the one client tasks land on (core/clientwork.ts
//    landDayAt: the countdown's Day ends, else "Your work day ends at", in the person's zone), so both kinds land together.
//  - Until then it is in no list, no priority group, never the island's task or the working task, its Priority 1 clock and
//    alarm wait and it cannot be overdue. It waits in one closed "Scheduled" row at the bottom of the list (views/Scheduled.tsx).
//  - On its day it is an ordinary task again, where it belongs (P1 included), and its P1 clock starts at the start of that day.
//  - No new field: the day is `due`, which every version syncs and merges per field (core/keepedits.ts). A version before 1.75
//    shows the task as it always did, so nothing is lost. Repeating tasks and client tasks keep landing as they did.
//  - The switch: feature "scheduled-tasks" (Settings, Your list, "Hide tasks until their day"). Off: exactly as in 1.74.
// Pure apart from the switch: no DOM, no clock of its own, so tests/scheduled.test.ts checks every rule.
import type { Doc, Todo } from "./model";
import { feature } from "./features.ts";
import { dayLabel } from "./nldates.ts";

/** The feature id, written out where it is asked (the registry check reads the literal). */
export const SCHEDULED_FEATURE = "scheduled-tasks";

let gate: () => boolean = () => feature("scheduled-tasks");
/** Is the feature on for this person (their own switch wins, core/features.ts). */
export const scheduledOn = (): boolean => { try { return gate(); } catch { return false; } };
/** Tests only: answer the switch without a build registry. */
export function setScheduledGate(f: (() => boolean) | null): void { gate = f ?? (() => feature("scheduled-tasks")); }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type SchedLike = Pick<Todo, "type" | "done"> & { due?: string | null; doOn?: string | null; clearedAt?: string | null };

/** The day this task is scheduled for (its `due`), or null when it is not the kind that waits: repeating, done, cleared,
 *  without a date, or a Clients task with its own do date. Past or today's days still answer: waitsForDay compares. */
export function schedDay(t: SchedLike | null | undefined): string | null {
  if (!t || t.type !== "once" || t.done || t.clearedAt) return null;
  if (typeof t.doOn === "string" && DAY.test(t.doOn)) return null;
  return typeof t.due === "string" && DAY.test(t.due) ? t.due : null;
}

// Break-it 1.75: `due` is a calendar date (the parser, the pickers and Overdue all read it so), while the land day can lag
// behind the calendar for hours (a noon day end: at 08:00 on Wednesday it is still Tuesday). A task is never kept out on its own
// calendar date, so "call at 9" typed at 02:00 is in the list before 9:00 and "today" is always today. The app sets the
// calendar day (clients/clientsday.ts, in the Tab list's zone); without it (tests) only the land day counts.
let wallDay: () => string | null = () => null;
/** The app (and tests): the person's calendar date now, "YYYY-MM-DD", or null to compare with the land day only. */
export function setSchedWall(f: (() => string | null) | null): void { wallDay = f ?? (() => null); }
const wallNow = (): string | null => { try { const w = wallDay(); return typeof w === "string" && DAY.test(w) ? w : null; } catch { return null; } };
/** The day a scheduled task has to be after to wait: the later of the land day and the calendar date. */
export function schedCut(day: string, wall: string | null = wallNow()): string {
  return wall && wall > day ? wall : day;
}

/** Does this task wait out of the list on `day` (the person's land day)? Only while the feature is on. */
export function waitsForDay(t: SchedLike | null | undefined, day: string, on = scheduledOn(), wall: string | null = wallNow()): boolean {
  if (!on) return false;
  const d = schedDay(t);
  return !!d && DAY.test(day) && d > schedCut(day, wall);
}

/** The tasks waiting for their day, soonest first (then in list order), for the Scheduled row. AI Inbox tasks stay there. */
export function scheduledList<T extends Doc<Todo>>(all: T[], day: string, on = scheduledOn()): T[] {
  if (!on) return [];
  const wall = wallNow();
  return all
    .filter((d) => d.data.aiInbox !== true && waitsForDay(d.data, day, true, wall))
    .sort((a, b) => (a.data.due! < b.data.due! ? -1 : a.data.due! > b.data.due! ? 1 : (a.data.order ?? 0) - (b.data.order ?? 0)));
}

/** The day on a waiting row: "Tomorrow", "Fri 27 Nov", "Mon 4 Jan 2027". `day` is the person's land day. */
export const schedLabel = (due: string, day: string): string => dayLabel(due, day);

/** The row's count words ("Scheduled", "3"): the count shows only when there is something. */
export const SCHED_TITLE = "Scheduled";

/** "Do today": the patch that brings a waiting task into today's list (its day becomes the person's day). */
export const doTodayPatch = (day: string): { due: string } => ({ due: day });

/** Leaving out the tasks that wait (for the due nags and the P1 alarm, src/duewatch.ts). */
export function withoutWaiting<T extends { data: SchedLike }>(list: T[], day: string, on = scheduledOn()): T[] {
  const wall = wallNow();
  return on ? list.filter((d) => !waitsForDay(d.data, day, true, wall)) : list;
}
