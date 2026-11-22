// PS 1.74: how a Reset saves its plan, and how its Undo takes it back (core/actions.ts resetTodos; tested in
// tests/reset-keep.test.ts). Reset works out every task first (core/resetplan.ts), then saves them one by one with waits in
// between. A mini task ticked, added or renamed in those waits used to be saved over on the same device, where no sync merge
// sees it, a task deleted meanwhile came back, and Undo put back the whole copy of every task from before the Reset.
// Now each save is made on top of the task as it is at that moment (only what Reset changes is changed, a change made
// meanwhile wins), a task that is gone is skipped, and Undo takes back only what Reset itself changed.
import type { Todo } from "./model.ts";
import type { DayLog } from "./daylog.ts";
import { itemKey } from "./daylog.ts";
import { mergeStale, same } from "./keepedits.ts";

/** What Reset changed on one task: the task as Reset read it, and as Reset wanted it. */
export type ResetWrite = { id: string; before: Todo; planned: Todo };
/** Where a Reset reads and saves tasks (the vault in the app, a model in the tests). */
export type ResetIO = { get: (id: string) => Todo | undefined; put: (id: string, data: Todo) => Promise<unknown> };

/** What Reset decides on: a task ticked, unticked, cleared or moved to another day meanwhile is no longer the task Reset
 *  planned for (a one-off unticked meanwhile must never be cleared as done). It stays as it is now, for the next Reset. */
const DECIDES = ["done", "doneAt", "type", "repeat", "due", "clearedAt"] as const;
export function stillPlanned(before: Todo, now: Todo): boolean {
  return DECIDES.every((k) => same(now[k], before[k]));
}

/** Reset's change, made on the task as it is now: what changed since Reset read it stays, the rest is Reset's. */
export function resetOnto(before: Todo, planned: Todo, now: Todo): Todo {
  if (same(now, before)) return planned;
  if (!stillPlanned(before, now)) return now;
  return mergeStale(before, now, planned);
}

/** Undo of Reset's change on the task as it is now: only what Reset changed goes back; anything changed since stays. */
export function undoOnto(before: Todo, planned: Todo, now: Todo): Todo {
  return mergeStale(planned, now, before);
}

/** Saves the plan one task at a time, each on its newest copy. A task gone meanwhile is skipped. Returns what was saved. */
export async function saveResetPuts(puts: { id: string; data: Todo }[], before: ReadonlyMap<string, Todo>, io: ResetIO): Promise<ResetWrite[]> {
  const out: ResetWrite[] = [];
  for (const x of puts) {
    const b = before.get(x.id), now = io.get(x.id);
    if (!b || !now) continue;   // deleted while Reset ran: it stays deleted
    const next = resetOnto(b, x.data, now);
    if (same(next, now)) continue;
    await io.put(x.id, next);
    out.push({ id: x.id, before: b, planned: x.data });
  }
  return out;
}

/** Undo: each task Reset saved gets back what Reset changed on it, on its newest copy. A task deleted since stays deleted. */
export async function undoResetPuts(written: ResetWrite[], io: ResetIO): Promise<number> {
  let n = 0;
  for (const w of written) {
    const now = io.get(w.id);
    if (!now) continue;
    const next = undoOnto(w.before, w.planned, now);
    if (same(next, now)) continue;
    await io.put(w.id, next);
    n++;
  }
  return n;
}

/** Undo of a day log Reset wrote: the ticks Reset added come off and the missed list and totals go back, unless they
 *  changed since; ticks filed since stay. null: nothing is left that Reset did not add (the log goes). */
export function undoLog(prev: DayLog | undefined, written: DayLog, now: DayLog): DayLog | null {
  const had = new Set((prev?.items || []).map(itemKey));
  const added = new Set(written.items.filter((i) => !had.has(itemKey(i))).map(itemKey));
  const out: DayLog = { ...now, items: now.items.filter((i) => !added.has(itemKey(i))) };
  for (const k of ["missed", "missedAt", "totals"] as const) {
    if (!same(now[k], written[k])) continue;   // changed since Reset: kept
    if (prev && prev[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = prev[k];
    else delete out[k];
  }
  if (prev) return out;
  const left = out.items.length || out.missed || out.totals || out.added?.length || out.deleted?.length || out.dimx?.length;
  return left ? out : null;
}

/** Break-it 1.74: one Reset at a time. Each Reset skips a task that changed after it read the list, so two at once (the auto
 *  reset and a click, the Tab list and the main window, two quick clicks) split the tasks between them and the Undo you get
 *  put back only its own share. A Reset asked for while one of the same kind runs gets that same run and its Undo; one of the
 *  other kind (auto or by hand) waits for it and then runs on the newest copy. A failed Reset never blocks the next one. */
export function resetLane<T>(): (auto: boolean, run: () => Promise<T>) => Promise<T> {
  let running: { auto: boolean; p: Promise<T> } | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return (auto, run) => {
    if (running && running.auto === auto) return running.p;
    const p = tail.then(run, run);
    const me = { auto, p };
    running = me;
    tail = p.catch(() => {});
    void tail.then(() => { if (running === me) running = null; });
    return p;
  };
}

/** Break-it 1.74 round 2: the Undo of the last Reset asked for. End day puts its Undo entry up before its Reset ends
 *  (views/TaskMap.tsx), so Undo can come while that Reset still saves. It used to take the Undo kept from the Reset before
 *  (yesterday's: its cleared one-offs came back) or none, and the Reset just asked for stayed. Now Undo waits for the Reset
 *  it belongs to and takes back that one only, once. */
export function resetUndoSlot() {
  let last: Promise<(() => Promise<void>) | null> | null = null;
  // Break-it 1.74 round 3: End day, Undo, End day. A Reset asked for after an Undo waits for that Undo to end: started at once
  // it joined the Reset still saving (resetLane gives a second one of the same kind that run), and the Undo then took it back,
  // so the last End day did nothing; started after its Reset ended it ran beside the Undo and the two split the tasks.
  let undoing: Promise<void> | null = null;
  return {
    reset(run: () => Promise<() => Promise<void>>): Promise<void> {
      const r = undoing ? undoing.then(run) : run();
      last = r.then((u) => u, () => null);
      return r.then(() => {});
    },
    undo(): Promise<void> {
      const p = last;
      last = null;
      const d = (async () => { const u = p ? await p : null; if (u) await u(); })();
      const me: Promise<void> = d.catch(() => {}).then(() => { if (undoing === me) undoing = null; });
      undoing = me;
      return d;
    },
  };
}
