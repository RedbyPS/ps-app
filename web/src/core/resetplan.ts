// What one Reset does to the list, worked out without saving anything (actions.ts resetTodos saves it; tested in
// tests/resettime.test.ts). Repeating tasks stay and are unticked (longer repeats move on to their next date; one not
// done when due loses its streak); finished one-offs are cleared (clearedAt, so Undo can bring them back); unfinished
// one-offs stay. Every tick goes into the day log first, so the Map keeps it.
//
// auto: the automatic Reset at your reset time (core/resetday.ts). It files each tick into the day it was done on (by
// the reset time) and leaves alone anything ticked since today started: a Mac that slept through 4am and catches up
// at 9am never wipes the tasks ticked on the phone at 6am. A Reset you press saves every tick to one work day,
// "Your work day ends at" (core/daylog.ts), as before.
import type { Doc, Todo } from "./model.ts";
import { isRepeating, resetPatch, roundOver } from "./repeat.ts";
import { resetSubs } from "./subtasks.ts";
import { DAY_ENDS_DEFAULT, workDayOf, type DayLogItem } from "./daylog.ts";
import { addDays, byResetDay, dayStartAt, resetDayOf } from "./resetday.ts";
import { planMissed, type MissedItem } from "./taskhist.ts";

export interface ResetPlan {
  /** The day this Reset belongs to (settings.lastResetDay), also "today" for repeating tasks. */
  today: string;
  /** Ticks to add to the day logs, by day. */
  logs: Map<string, DayLogItem[]>;
  /** PS 1.65: the day this Reset closes and what was still open for it (core/taskhist.ts). The automatic Reset closes the day
   *  before `today`; one you press closes the work day set by "Your work day ends at", like its ticks. */
  missedDay: string;
  missed: MissedItem[];
  /** The tasks that change, with their new data. */
  puts: { id: string; data: Todo }[];
}

export function planReset(list: Doc<Todo>[], o: { at: string; tz: string; atMin: number; auto?: boolean; dayEndsHour?: number }): ResetPlan {
  const ms = Date.parse(o.at);
  const today = resetDayOf(ms, o.tz, o.atMin);
  const keepFrom = o.auto ? dayStartAt(today, o.tz, o.atMin) : Infinity;
  const fresh = (at?: string | null) => !!at && Date.parse(at) >= keepFrom;   // ticked since today started (auto only)
  const items: DayLogItem[] = list.filter((d) => d.data.done && d.data.doneAt && !fresh(d.data.doneAt))
    .map((d) => ({ todoId: d.id, title: d.data.title, at: d.data.doneAt!, repeat: d.data.type === "daily", clientId: d.data.clientId ?? null, ...(d.data.p1 ? { p1: true } : {}) }));
  // Mini tasks done go in too, under their parent (done or not).
  for (const d of list) for (const sub of d.data.subtasks || []) if (sub.done && sub.doneAt && !d.data.clearedAt && !fresh(sub.doneAt) && !fresh(d.data.doneAt))
    items.push({ todoId: `${d.id}/${sub.id}`, title: sub.title, at: sub.doneAt, repeat: d.data.type === "daily", clientId: d.data.clientId ?? null, parentId: d.id, parentTitle: d.data.title });
  const logs = o.auto ? byResetDay(items, o.tz, o.atMin)
    : new Map(items.length ? [[workDayOf(o.at, o.dayEndsHour ?? DAY_ENDS_DEFAULT), items]] : []);
  const puts: ResetPlan["puts"] = [];
  for (const d of list) {
    if (fresh(d.data.doneAt)) continue;   // ticked today (auto): it stays as it is until the next reset
    const rp = resetPatch(d.data, today);
    // Mini tasks: a repeating task's all untick with it (PS 1.68: keeping or ending each one's streak, and left as they are
    // while a longer repeat waits for its date); an unfinished one-off drops its done ones.
    const subs = d.data.type === "once" && d.data.done ? d.data.subtasks
      : keepFresh(d.data.subtasks, resetSubs(d.data.subtasks, isRepeating(d.data), roundOver(d.data, today) ? "over" : "wait"), fresh);
    const subPatch = subs !== d.data.subtasks && JSON.stringify(subs) !== JSON.stringify(d.data.subtasks) ? { subtasks: subs } : null;
    if (rp || subPatch) puts.push({ id: d.id, data: { ...d.data, ...rp, ...subPatch } as Todo });
    else if (d.data.type === "once" && d.data.done) puts.push({ id: d.id, data: { ...d.data, clearedAt: o.at } as Todo });
  }
  const missedDay = o.auto ? addDays(today, -1) : workDayOf(o.at, o.dayEndsHour ?? DAY_ENDS_DEFAULT);
  // Judged before anything is unticked: a task ticked since today started (auto) is not open, and a repeating task is read as it stands.
  const missed = planMissed(list.filter((d) => !fresh(d.data.doneAt) || !d.data.done), { day: missedDay, nowMs: ms,
    dayOf: (x) => o.auto ? resetDayOf(x, o.tz, o.atMin) : workDayOf(new Date(x).toISOString(), o.dayEndsHour ?? DAY_ENDS_DEFAULT) });
  return { today, logs, puts, missedDay, missed };
}

/** Mini tasks ticked since today started stay ticked, where they were. */
function keepFresh(old: Todo["subtasks"], next: Todo["subtasks"], fresh: (at?: string | null) => boolean): Todo["subtasks"] {
  if (!old?.length || !old.some((x) => x.done && fresh(x.doneAt))) return next;
  const by = new Map((next || []).map((x) => [x.id, x]));
  return old.flatMap((x) => (x.done && fresh(x.doneAt) ? [x] : by.has(x.id) ? [by.get(x.id)!] : []));
}
