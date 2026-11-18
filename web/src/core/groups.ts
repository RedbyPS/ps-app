// Sections and task groups in the Tab list (the developer, 29 Oct 2026). The list is a stack of sections the developer
// drags into any order by their headers: Priority 1, Priorities, Every day and his own task groups.
// A group is made by Cmd-clicking tasks and dragging them out of the list, gets a name he can change,
// and takes more tasks the same way. A task in a group (todo.group) shows there instead of in
// Priorities or Every day; a group that no longer exists is ignored, so the task comes back.
import type { Doc, TaskGroup, Todo } from "./model";
import { isP1, sortPrio } from "./prio.ts";
import { isDueNow } from "./repeat.ts";
import { isOverdue } from "./overdue.ts";

export const SEC_BUILTIN = ["p1", "prio", "daily"] as const;
export const groupKey = (id: string) => `g:${id}`;
export const groupOf = (key: string) => (key.startsWith("g:") ? key.slice(2) : null);
const GROUP_ID = /^[a-z0-9]{4,24}$/;
const SEC_KEY = /^(p1|prio|daily|g:[a-z0-9]{4,24})$/;
export const GROUP_NAME_MAX = 60;
export const GROUPS_MAX = 30;

export function newGroupId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => (x % 36).toString(36)).join("") + Date.now().toString(36).slice(-4);
}

/** Only well formed groups, each id once, names trimmed (a blank name reads "Group"). */
export function cleanGroups(v: unknown): TaskGroup[] {
  if (!Array.isArray(v)) return [];
  const out: TaskGroup[] = [];
  for (const g of v) {
    if (!g || typeof g !== "object") continue;
    const { id, name } = g as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !GROUP_ID.test(id) || out.some((x) => x.id === id)) continue;
    const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, GROUP_NAME_MAX) : "";
    out.push({ id, name: n || "Group" });
    if (out.length >= GROUPS_MAX) break;
  }
  return out;
}
export function cleanSecOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((k): k is string => typeof k === "string" && SEC_KEY.test(k)))].slice(0, GROUPS_MAX + 3);
}

export type TabLists = {
  p1: Doc<Todo>[];       // the Priority 1 group
  prio: Doc<Todo>[];     // the other one-off tasks, P2 onwards
  ranked: Doc<Todo>[];   // both together, P1 first (what "the priorities" meant before groups)
  daily: Doc<Todo>[];
  groups: Map<string, Doc<Todo>[]>;
};
const byOrder = (a: Doc<Todo>, b: Doc<Todo>) => (a.data.order ?? 0) - (b.data.order ?? 0);

/** Every section's tasks, in order. Repeating tasks show while due (as in Every day). */
/** With `overdue` (now and the developer's zone), tasks 48 hours past their due are left out: they show on the
 *  Overdue card instead (core/overdue.ts). */
export function tabLists(every: Doc<Todo>[], groups: TaskGroup[], today: string, overdue?: { now: number; tz: string }): TabLists {
  // The AI Inbox's tasks (core/aiinbox.ts) are on no list until they are moved out of it.
  const lists = every.filter((d) => d.data.aiInbox !== true);
  const all = overdue ? lists.filter((d) => !isOverdue(d.data, overdue.now, overdue.tz)) : lists;
  const known = new Set(groups.map((g) => g.id));
  const gid = (t: Todo) => (t.group && known.has(t.group) ? t.group : null);
  const showing = (t: Todo) => (t.type === "daily" ? isDueNow(t, today) : !t.done);
  const daily = all.filter((d) => d.data.type === "daily" && !gid(d.data) && isDueNow(d.data, today)).sort(byOrder);
  const ranked = sortPrio(all.filter((d) => d.data.type !== "daily" && !d.data.done && !gid(d.data)));
  const map = new Map<string, Doc<Todo>[]>(groups.map((g) => [g.id, []]));
  for (const d of all) { const g = gid(d.data); if (g && showing(d.data)) map.get(g)!.push(d); }
  map.forEach((l) => l.sort(byOrder));
  return { p1: ranked.filter((d) => isP1(d.data)), prio: ranked.filter((d) => !isP1(d.data)), ranked, daily, groups: map };
}

/** Every section top to bottom, shown or not: the saved order, with any missing one put back
 *  (Priority 1 just above Priorities, Every day and new groups at the end). Before 29 Oct 2026 only
 *  tmDailyFirst was saved. */
export function sectionOrder(saved: string[] | undefined, dailyFirst: boolean, groups: TaskGroup[]): string[] {
  const exist = new Set<string>([...SEC_BUILTIN, ...groups.map((g) => groupKey(g.id))]);
  const base = (saved?.length ? cleanSecOrder(saved) : dailyFirst ? ["daily", "p1", "prio"] : ["p1", "prio", "daily"]).filter((k) => exist.has(k));
  if (!base.includes("prio")) base.splice(base.includes("p1") ? base.indexOf("p1") + 1 : 0, 0, "prio");
  if (!base.includes("p1")) base.splice(base.indexOf("prio"), 0, "p1");
  if (!base.includes("daily")) base.push("daily");
  for (const g of groups) if (!base.includes(groupKey(g.id))) base.push(groupKey(g.id));
  return base;
}

/** The whole order after the shown sections were dragged into `shown`; hidden ones keep their slot. */
export function mergeOrder(full: string[], shown: string[]): string[] {
  const set = new Set(shown);
  let i = 0;
  const out = full.map((k) => (set.has(k) ? shown[i++] : k));
  for (const k of shown) if (!out.includes(k)) out.push(k);
  return out;
}

/** Groups take any task. Priority 1 and Priorities take one-off tasks, Every day repeating ones. */
export function accepts(key: string, types: Todo["type"][]): boolean {
  if (key.startsWith("g:")) return true;
  if (key === "daily") return types.every((t) => t === "daily");
  return key === "p1" || key === "prio" ? types.every((t) => t !== "daily") : false;
}

/** ids: the tasks moved, top to bottom. index: where they land among the section's rows as shown
 *  (moved rows already in that section count). */
export type TaskMove = { ids: string[]; to: string; index: number; inbox?: boolean };   // inbox (PS 1.68): the tasks come out of the AI Inbox

/** The saves a move makes: the order of its new section (Priority 1 and Priorities count as one
 *  order, as before), and the moved tasks' group, Priority 1 and "no priority yet" flags. */
/** inbox (PS 1.68, Dimension X): tasks on no list yet (the AI Inbox, core/aiinbox.ts) that join the section, and leave the inbox in the same write. */
export function planMove(lists: TabLists, m: TaskMove, inbox: Doc<Todo>[] = []): { id: string; patch: Partial<Todo> }[] {
  // No Priority 1 group yet: the very top of Priorities starts one (as a drag within it does).
  if (m.to === "prio" && m.index === 0 && !lists.p1.length) m = { ...m, to: "p1" };
  const find = new Map<string, Doc<Todo>>();
  for (const l of [lists.ranked, lists.daily, ...lists.groups.values()]) for (const d of l) find.set(d.id, d);
  for (const d of inbox) if (d.data.aiInbox === true && !find.has(d.id)) find.set(d.id, d);
  const moved = m.ids.map((id) => find.get(id)).filter((d): d is Doc<Todo> => !!d);
  const gid = groupOf(m.to);
  if (!moved.length || !accepts(m.to, moved.map((d) => d.data.type)) || (gid && !lists.groups.has(gid))) return [];
  const ids = new Set(moved.map((d) => d.id));
  const target = m.to === "p1" ? lists.p1 : m.to === "prio" ? lists.prio : m.to === "daily" ? lists.daily : lists.groups.get(gid!)!;
  const above = target.slice(0, Math.max(0, m.index)).filter((d) => ids.has(d.id)).length;
  const next = target.filter((d) => !ids.has(d.id));
  const at = Math.max(0, Math.min(next.length, m.index - above));
  next.splice(at, 0, ...moved);
  // One order for Priority 1 and Priorities, so a task added by its P number still lands right.
  const ordered = m.to === "p1" ? [...next, ...lists.prio.filter((d) => !ids.has(d.id))]
    : m.to === "prio" ? [...lists.p1.filter((d) => !ids.has(d.id)), ...next] : next;
  // Dropped below a task with no priority yet: it has none either (core/prio.ts).
  const unranked = m.to === "prio" && next.slice(0, at).some((d) => d.data.unranked);
  const out: { id: string; patch: Partial<Todo> }[] = [];
  ordered.forEach((d, i) => {
    const t = d.data, patch: Partial<Todo> = {};
    if (t.order !== i) patch.order = i;
    if (ids.has(d.id)) {
      if (t.aiInbox === true) patch.aiInbox = false;
      if ((t.group ?? null) !== (gid ?? null)) patch.group = gid ?? null;
      if (t.type !== "daily") {
        if (!!t.p1 !== (m.to === "p1")) patch.p1 = m.to === "p1";
        if (!!t.unranked !== unranked) patch.unranked = unranked;
      }
    }
    if (Object.keys(patch).length) out.push({ id: d.id, patch });
  });
  return out;
}

/** A group taken apart: one-off tasks go to the end of Priorities, repeating ones to Every day. */
export function planUngroup(lists: TabLists, gid: string): { id: string; patch: Partial<Todo> }[] {
  const list = lists.groups.get(gid) || [];
  const top = (l: Doc<Todo>[]) => l.reduce((m, d) => Math.max(m, d.data.order ?? 0), -1);
  let once = top(lists.ranked), daily = top(lists.daily);
  return list.map((d) => d.data.type === "daily"
    ? { id: d.id, patch: { group: null, order: ++daily } }
    : { id: d.id, patch: { group: null, order: ++once, p1: false, unranked: false } });
}

// ---------- where a dragged task is let go (the hit tests, pure so they can be tested) ----------
/** A section's box on screen. */
export type SecBox = { key: string; left: number; top: number; right: number; bottom: number };

/** The section under the pointer, with a little room either side (40 px), or null between sections.
 *  The developer's friend, 15 Nov 2026: a task dragged from Priorities onto Priority 1 stayed where it was,
 *  because the sections were looked for as direct children of the list box and the list pages (V1.55) put
 *  a page between them. The pointer found no section at all, so no drop on another section ever counted. */
export function hitSection(boxes: SecBox[], x: number, y: number): string | null {
  for (const b of boxes) if (x >= b.left - 40 && x <= b.right + 40 && y >= b.top && y <= b.bottom) return b.key;
  return null;
}

/** A task from Priorities let go above the Priorities section (the gap under Priority 1) while a Priority 1
 *  group exists is Priority 1 too: it joins the end of that group. */
export function dropAbovePrioIsP1(p1Count: number, prio: SecBox | null, p1: SecBox | null, x: number, y: number): boolean {
  if (!p1Count || !prio || !p1 || p1.top >= prio.top) return false;
  return y < prio.top && y >= p1.top && x >= prio.left - 40 && x <= prio.right + 40;
}
