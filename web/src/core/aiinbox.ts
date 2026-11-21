// The AI Inbox (Task API, the developer's friend: "give it its own specific section where it can just dump tasks and then i can
// do whatever i want with it. mby it can be in dimension x").
//
// A task an AI adds through the Task API (core/taskapi.ts) is an ordinary task with two extra flags:
// - ai: true      the small AI marker. It stays on the task wherever it goes, so you always know an AI added it.
// - aiInbox: true it sits in the AI Inbox (shown in Dimension X) and on no list yet. Moving it anywhere clears this.
// While aiInbox is set the task is left out of every list section (core/groups.ts tabLists), so the AI can never
// clutter the lists you work from. Ticking, notes, reminders and deleting work on it as on any task.
// Pure: no React, no DOM.
import type { Doc, Settings, TaskGroup, Todo } from "./model";
import { accepts, cleanGroups, groupKey, groupOf, sectionOrder, type TabLists } from "./groups.ts";
import { MAIN, cleanPages, listMoveTarget, moveSec, secsByPage, type ListPage } from "./lists.ts";

export const INBOX = "inbox";
export const INBOX_NAME = "AI Inbox";
export const INBOX_MAX = 500;             // open tasks the inbox takes (the API answers "full" past this)

export const inInbox = (t: Pick<Todo, "aiInbox">) => t.aiInbox === true;
/** The inbox's tasks: open ones first in their order, then the ones ticked in the last day (crossed out). */
export function inboxTasks(all: Doc<Todo>[], now = Date.now()): Doc<Todo>[] {
  const mine = all.filter((d) => inInbox(d.data) && !d.data.clearedAt);
  const open = mine.filter((d) => !d.data.done).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  const done = mine.filter((d) => d.data.done && now - Date.parse(d.data.doneAt || "") < 86_400_000)
    .sort((a, b) => (b.data.doneAt || "").localeCompare(a.data.doneAt || ""));
  return [...open, ...done];
}
export const openInboxCount = (all: Doc<Todo>[]) => all.filter((d) => inInbox(d.data) && !d.data.done && !d.data.clearedAt).length;

/** Where a task goes when it leaves the inbox for a list page, as one patch, plus a settings change when that page
 *  needs a new "To do" group first (the same rule as the list menu's Move to list, views/ListPager.tsx moveToList).
 *  null: that page cannot take it (a page that holds panels, or 30 groups already). */
export function inboxMove(task: Pick<Todo, "type">, page: string, ctx: { lists: TabLists; full: string[]; pages: ListPage[]; groups: TaskGroup[] },
  newGroup: () => string): { patch: Partial<Todo>; settings?: Partial<Settings> } | null {
  const pg = ctx.pages.find((p) => p.id === page);
  if (page !== MAIN && (!pg || pg.kind === "panels")) return null;
  const secs = secsByPage(ctx.full, ctx.pages).get(page) ?? [];
  const t = listMoveTarget(ctx.lists, secs, [task.type]);
  if (t) return { patch: { ...intoSection(t.to, ctx.lists), aiInbox: false } };
  if (ctx.groups.length >= 30) return null;
  const gid = newGroup();
  const key = groupKey(gid);
  return {
    patch: { group: gid, order: 0, aiInbox: false },
    settings: { tmGroups: [...ctx.groups, { id: gid, name: "To do" }], tmSecOrder: [...ctx.full, key], ...(page === MAIN ? {} : { tmPages: moveSec(ctx.pages, key, page) }) },
  };
}
/** The fields that put a task at the end of one section. */
export function intoSection(key: string, lists: TabLists): Partial<Todo> {
  const top = (l: Doc<Todo>[]) => l.reduce((m, d) => Math.max(m, d.data.order ?? 0), -1) + 1;
  const g = groupOf(key);
  if (g) return { group: g, order: top(lists.groups.get(g) ?? []) };
  if (key === "daily") return { group: null, order: top(lists.daily) };
  // PS 1.73 (the developer: "stop adding in priorities at random"): into Priorities it has no priority, at the bottom; only a
  // task sent to Priority 1 gets one.
  return key === "p1" ? { group: null, order: top(lists.ranked), p1: true, unranked: false, prioGroup: null } : { group: null, order: top(lists.ranked), p1: false, unranked: true, prioGroup: null };
}
/** Can this section take a task of this kind (Every day only repeating ones, Priority 1 and Priorities only one-offs). */
export const sectionTakes = (key: string, type: Todo["type"]) => accepts(key, [type]);

/** Every section in order, split by page, from the settings (the same as the Tab list draws). */
export function listsCtx(st: Partial<Settings>) {
  const groups = cleanGroups(st.tmGroups);
  const pages = cleanPages(st.tmPages);
  const full = sectionOrder(st.tmSecOrder, !!st.tmDailyFirst, groups);
  return { groups, pages, full, byPage: secsByPage(full, pages) };
}
