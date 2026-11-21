// PS 1.73: the nag for tasks due today and the Priority 1 alarm at work (core/duealerts.ts has the rules). Runs in the page
// that holds the vault, from the two watchers that already hand the shells their plans:
//  - remwatch.ts adds the nags (and, on the Mac and the iPhone web app, the P1 alarms) to the Annoying reminders' plan;
//  - gymwatch.ts adds the P1 alarms to the phone's rings (the gym ring, full screen, RingScreen.kt), next to your own alarms.
// The day end is the countdown's Day ends (src/daycount.ts dayPrefs and dayZone: the developer's 12:00 GST), never plain midnight.
// Other sources (the Clients workspace) hand in their due tasks with addDueSource.
import type { Snapshot } from "./core/vault";
import { allTodos, remindRec, settingsData } from "./core/select";
import { updateTodo } from "./core/actions";
import { cdEffective, nextEnd, prevEnd } from "./core/daycount";
import { resetAtOf } from "./core/resetday";
import { dayPrefs, dayZone } from "./daycount";
import { autoTask, dueNagItems, dueP1Items, dueTasks, p1OwnStamps, type DueCtx, type DueTask } from "./core/duealerts";
import type { AlarmRing, PlanItem } from "./core/remind";
import { vaultStore } from "./core/vault";
import { clientDueTasks } from "./clients/clientsday";

type Source = (ctx: DueCtx) => DueTask[];
const sources = new Map<string, Source>();
/** The hook for the Clients workspace (and anything else with tasks of its own): `fn` returns its tasks that are due, each with
 *  the moment it is due (use ctx.dayEndAfter for "the end of that day"). Client tasks kept as ordinary to-do tasks (Todo with
 *  clientId and a due date or weekday chips) need nothing: dueTasks already counts them. Returns the undo. */
export function addDueSource(name: string, fn: Source): () => void {
  sources.set(name, fn);
  return () => { if (sources.get(name) === fn) sources.delete(name); };
}

// PS 1.73: the Clients workspace hands in its due tasks (clients/clientsday.ts clientDueTasks).
addDueSource("clients", (ctx) => clientDueTasks(vaultStore.get(), ctx.now));

/** The day end maths for this vault: the zone and "the first day end after". */
export function dueCtx(s: Snapshot, now: number): DueCtx {
  const p = dayPrefs(s), tz = dayZone(s, p);
  const eff = cdEffective(p, resetAtOf(settingsData(s)));
  return { now, tz, dayEndAfter: (t) => nextEnd(eff, tz, t), dayEndAtOrBefore: (t) => prevEnd(eff, tz, t) };
}

let last: { items: PlanItem[] } = { items: [] };
/** Everything worked out now: the nag items, the P1 alarms (the Mac card or web card, and the phone ring). */
export function duePlan(s: Snapshot, now: number): { nags: PlanItem[]; p1: PlanItem[]; rings: AlarmRing[] } {
  const rec = remindRec(s);
  const red = !!s.red;
  const ctx = dueCtx(s, now);
  const extra: DueTask[] = [];
  for (const f of sources.values()) { try { extra.push(...f(ctx)); } catch { /* a broken source never stops the rest */ } }
  const mine = allTodos(s).filter((d) => d.ws === null);
  const tasks = dueTasks(mine, ctx, extra);
  const own = new Set((rec?.list ?? []).filter((r) => r.task && r.on).map((r) => r.task!));
  const nags = dueNagItems(tasks, rec, red, ctx, { ownTaskReminders: own });
  const { items: p1, rings } = dueP1Items(tasks, rec, red, ctx);
  last = { items: [...nags, ...p1] };
  return { nags, p1, rings };
}
/** A worked out item from the last plan (the iPhone's waiting pushes for it are cleared on Done), null when unknown. */
export function dueItemOf(id: string): PlanItem | null { return last.items.find((x) => x.id === id) ?? null; }
/** The task behind a worked out item from the last plan (Done on a nag ticks it), null for a P1 alarm or an unknown id. */
export function dueTaskOf(id: string): string | null { return autoTask(last.items, id); }

// ---------- your own Priority 1 clock (Todo.p1Since) ----------
let stamping = false;
/** After every change of your tasks: each one off Priority 1 gets its own 24 hour start, whether or not it is shared. */
export function stampP1Own(s: Snapshot) {
  if (stamping || s.status !== "unlocked" || s.role !== "owner" || s.userId === "ps-overlay" || s.userId === "dev") return;
  if (s.syncing || !(s.lastSync || s.local)) return;   // never on a list that has not really come yet
  const todo = p1OwnStamps(allTodos(s).filter((d) => d.ws === null), Date.now());
  if (!todo.length) return;
  stamping = true;
  void (async () => { for (const x of todo.slice(0, 60)) await updateTodo(x.id, { p1Since: x.p1Since }); })()
    .catch(() => { /* tried again at the next change */ }).finally(() => { stamping = false; });
}
