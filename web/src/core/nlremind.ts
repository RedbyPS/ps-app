// A typed time on a new task (PS 1.65, dates in plain words, core/nldates.ts): "call the bank tomorrow at 10" also puts a
// reminder on the task, ONCE, 15 minutes before: 09:45 on that day (the owner, 17 Nov 2026; core/nldates.ts timeReminder). The time travels with the
// add itself (the Mac's floating list sends it in its "add" message, src/ps.ts), and the page that saves the task adds the
// reminder once the task has its id. Settings, Your list, "A typed time adds a reminder" switches it off (settings.tmNlRemind).
import { saveRemind } from "./actions";
import { vaultStore } from "./vault";
import { isRedAccount } from "./account";
import { addDraftTaskReminder, addTaskReminder, freshId, remindOrDefault } from "./remind";
import { timeReminder, type TimeRemind } from "./nldates.ts";

export { cleanTimeRemind, type TimeRemind } from "./nldates.ts";

/** Add it to the synced reminders. Nothing happens when the task has one already or the list of reminders on tasks is full. */
export function addTimeReminder(taskId: string, w: TimeRemind): Promise<void> {
  const red = isRedAccount(vaultStore.get());
  const now = Date.now();
  return saveRemind((cur) => {
    const base = remindOrDefault(cur, red);
    const next = addTaskReminder(base, timeReminder(freshId(base), taskId, w, now), now);
    return next === base ? null : next;
  }).catch(() => {});
}

/** PS 1.68: the reminder set up in the Add a task window (views/TaskRemind.tsx DraftRemindPop), added once the task has its id.
 *  Nothing happens when the task has one already or the list of reminders on tasks is full. */
export function addDraftReminder(taskId: string, draft: unknown): Promise<void> {
  const red = isRedAccount(vaultStore.get());
  const now = Date.now();
  return saveRemind((cur) => {
    const base = remindOrDefault(cur, red);
    const next = addDraftTaskReminder(base, draft, taskId, now);
    return next === base ? null : next;
  }).catch(() => {});
}
