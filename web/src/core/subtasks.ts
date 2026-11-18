// Mini tasks (the developer, 24 Oct 2026): small steps under any task on his list, eg a task "Follow-ups"
// with one mini task per person. They live inside the task's own record, so they are encrypted
// with it and sync with it. The order is the array order.
//
// Changes go as small ops (add, tick, rename, remove, restore, order) applied to the newest copy
// of the task, one after another, so quick changes from PS's floating list never overwrite each
// other. Pure functions only.
//
// Streaks (PS 1.68, feature "task-streaks", Jan 18 Nov 2026: "I have 16 tasks in my morning routine in this one task"):
// under a repeating task every mini task keeps its own streak, the same way the task does (core/repeat.ts): a tick adds
// one, an untick takes it back, and the Reset that ends the task's round (it was done, or it was due and missed) keeps
// the streak of every mini task that was done and ends the streak of every one that was not. A Reset that finds the task
// still waiting for its next date (a longer repeat, not due yet) leaves its mini tasks as they are. The numbers live in
// the task's own record, so they are encrypted and synced with it like everything else.

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
  doneAt?: string | null;
  byParent?: boolean;            // ticked by ticking the parent (unticking the parent unticks it again)
  claudeDoneAt?: string | null;  // Claude finished it in a chat: a purple tick until the developer ticks it
  claudeNote?: string | null;
  streak?: number;               // PS 1.68, under a repeating task: rounds in a row this mini task was done
  streakTicked?: boolean;        // this round's tick is already in the streak (untick, tick again stays fair)
  bestStreak?: number;
}

export type SubOp =
  | { op: "add"; id: string; title: string; index?: number }
  | { op: "tick"; id: string }
  | { op: "rename"; id: string; title: string }
  | { op: "remove"; id: string }
  | { op: "restore"; item: Subtask; index: number }
  | { op: "order"; ids: string[] };

export const SUB_MAX = 60;
const STREAK_MAX = 100_000;
const TITLE_MAX = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function newSubId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return "s" + [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** One mini task from outside (PS's list, a sealed package): only known fields, sane sizes. */
export function cleanSub(v: unknown): Subtask | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !ID_RE.test(o.id)) return null;
  const title = str(o.title, TITLE_MAX);
  if (!title) return null;
  const s: Subtask = { id: o.id, title, done: o.done === true };
  if (s.done) s.doneAt = iso(o.doneAt);
  if (o.byParent === true && s.done) s.byParent = true;
  if (iso(o.claudeDoneAt)) { s.claudeDoneAt = iso(o.claudeDoneAt); s.claudeNote = str(o.claudeNote, TITLE_MAX) || null; }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(STREAK_MAX, Math.round(v))) : 0);
  if (n(o.streak)) s.streak = n(o.streak);
  if (n(o.bestStreak)) s.bestStreak = n(o.bestStreak);
  if (o.streakTicked === true) s.streakTicked = true;
  return s;
}

export function cleanSubOp(v: unknown): SubOp | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const id = typeof o.id === "string" && ID_RE.test(o.id) ? o.id : null;
  switch (o.op) {
    case "add": { const title = str(o.title, TITLE_MAX); if (!id || !title) return null;
      return { op: "add", id, title, ...(Number.isInteger(o.index) ? { index: o.index as number } : {}) }; }
    case "tick": return id ? { op: "tick", id } : null;
    case "rename": { const title = str(o.title, TITLE_MAX); return id && title ? { op: "rename", id, title } : null; }
    case "remove": return id ? { op: "remove", id } : null;
    case "restore": { const item = cleanSub(o.item); return item && Number.isInteger(o.index) ? { op: "restore", item, index: o.index as number } : null; }
    case "order": return Array.isArray(o.ids) ? { op: "order", ids: o.ids.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, SUB_MAX) } : null;
    default: return null;
  }
}

/** A mini task's streak after a tick (done true) or an untick, under a repeating task. Counted once per round. */
export function subStreak(s: Subtask, done: boolean): Pick<Subtask, "streak" | "streakTicked" | "bestStreak"> {
  const streak = s.streak || 0;
  if (done && !s.streakTicked) { const next = streak + 1; return { streak: next, streakTicked: true, bestStreak: Math.max(s.bestStreak || 0, next) }; }
  if (!done && s.streakTicked) return { streak: Math.max(0, streak - 1), streakTicked: false, bestStreak: s.bestStreak };
  return { streak: s.streak, streakTicked: s.streakTicked, bestStreak: s.bestStreak };
}
const withStreak = (s: Subtask, done: boolean, repeating: boolean): Subtask => {
  if (!repeating) return s;
  const k = subStreak(s, done);
  const out: Subtask = { ...s };
  delete out.streak; delete out.streakTicked; delete out.bestStreak;
  if (k.streak) out.streak = k.streak;
  if (k.streakTicked) out.streakTicked = true;
  if (k.bestStreak) out.bestStreak = k.bestStreak;
  return out;
};

/** The list after one op. Unknown ids leave it as it is; never more than SUB_MAX. `repeating`: the task repeats, so a
 *  tick counts in the mini task's streak (PS 1.68). */
export function applySubOp(list: Subtask[] | undefined, op: SubOp, at: string, repeating = false): Subtask[] {
  const l = list ? [...list] : [];
  const i = "id" in op ? l.findIndex((s) => s.id === op.id) : -1;
  switch (op.op) {
    case "add": {
      if (i >= 0 || l.length >= SUB_MAX) return l;
      const at2 = op.index == null ? l.length : Math.max(0, Math.min(l.length, op.index));
      l.splice(at2, 0, { id: op.id, title: op.title, done: false });
      return l;
    }
    case "tick": {
      if (i < 0) return l;
      const s = l[i];
      l[i] = withStreak(s.done ? { ...s, done: false, doneAt: null, byParent: false } : { ...s, done: true, doneAt: at, byParent: false }, !s.done, repeating);
      return l;
    }
    case "rename": if (i >= 0) l[i] = { ...l[i], title: op.title }; return l;
    case "remove": if (i >= 0) l.splice(i, 1); return l;
    case "restore": {
      if (l.some((s) => s.id === op.item.id) || l.length >= SUB_MAX) return l;
      l.splice(Math.max(0, Math.min(l.length, op.index)), 0, op.item);
      return l;
    }
    case "order": {
      const byId = new Map(l.map((s) => [s.id, s]));
      const next = op.ids.map((id) => byId.get(id)).filter((s): s is Subtask => !!s);
      // anything the order did not mention keeps its place at the end
      for (const s of l) if (!op.ids.includes(s.id)) next.push(s);
      return next;
    }
  }
}

export function subCount(list: Subtask[] | undefined): { done: number; total: number } {
  const l = list || [];
  return { done: l.filter((s) => s.done).length, total: l.length };
}

/** The parent was ticked (all its mini tasks are done with it) or unticked (the ones it ticked untick). Under a
 *  repeating task those count in each mini task's streak like its own tick. */
export function tickParentSubs(list: Subtask[] | undefined, done: boolean, at: string, repeating = false): Subtask[] | undefined {
  if (!list?.length) return list;
  return done
    ? list.map((s) => (s.done ? s : withStreak({ ...s, done: true, doneAt: at, byParent: true }, true, repeating)))
    : list.map((s) => (s.byParent ? withStreak({ ...s, done: false, doneAt: null, byParent: false }, false, repeating) : s));
}

/** Reset: a repeating task's mini tasks all untick with it; an unfinished one-off drops its done ones.
 *  `round` (PS 1.68 streaks) for a repeating task: "over" when this Reset ends the task's round (it was done, or due and
 *  missed): a done mini task keeps its streak, one not done loses it. "wait": the task is still waiting for its next date,
 *  so its mini tasks stay exactly as they are. */
export function resetSubs(list: Subtask[] | undefined, repeating: boolean, round: "over" | "wait" = "over"): Subtask[] | undefined {
  if (!list?.length) return list;
  if (repeating) {
    if (round === "wait") return list;
    return list.map((s) => {
      const keep: Subtask = { id: s.id, title: s.title, done: false };
      if (s.done && s.streak) keep.streak = s.streak;
      const best = Math.max(s.bestStreak || 0, s.done ? s.streak || 0 : 0);
      if (best) keep.bestStreak = best;
      if (s.done || s.claudeDoneAt || s.streak || s.streakTicked) return keep;
      return s;
    });
  }
  return list.filter((s) => !s.done);
}

/** Words match: every word of `match` is in the title (case does not matter). */
export function titleMatches(title: string, match: string) {
  const t = title.toLowerCase();
  const words = match.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => t.includes(w));
}
