// The Task API's rules (core/taskapi.ts): the switches, every endpoint, the AI Inbox, the errors, and the
// "Copy for AI" text (core/taskapidoc.ts). Runs every endpoint against a fake vault.
import assert from "node:assert/strict";
import { DEFAULT_SCOPES, SCOPES, cleanScopes, handleApi, type ApiStore, type Scopes, type SentryStartResult } from "../src/core/taskapi.ts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { INBOX, inboxMove, inboxTasks, openInboxCount } from "../src/core/aiinbox.ts";
import { aiConnect, aiGuide, KEY_SLOT } from "../src/core/taskapidoc.ts";
import { AI_MSG } from "../src/core/aimessage.ts";
import { tabLists } from "../src/core/groups.ts";
import { cleanRemind, type RemindRec } from "../src/core/remind.ts";

let n = 0;
const tests: [string, () => Promise<void> | void][] = [];
const ok = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const T = "2026-11-12";
type Data = Record<string, unknown>;
type Doc = { id: string; ws: null; kind: "todo"; author: null; updatedAt: null; data: Data };

function fake(init: { todos?: Doc[]; settings?: Data; locked?: boolean } = {}) {
  const docs = new Map<string, Doc>((init.todos ?? []).map((d) => [d.id, d]));
  let settings: Data = { ...(init.settings ?? {}) };
  let rem: RemindRec | null = null;
  let seq = 0, gseq = 0;
  const log: string[] = [];
  let sentry: SentryStartResult = { result: "engaged", phase: "covered" };
  const store: ApiStore & { docs: Map<string, Doc>; log: string[]; set: () => Data; rem: () => RemindRec | null; sentryWill: (r: SentryStartResult) => void } = {
    docs, log, set: () => settings, rem: () => rem, sentryWill: (r) => { sentry = r; },
    state: () => (init.locked ? "locked" : "ok"),
    todos: () => [...docs.values()].filter((d) => !d.data.clearedAt).sort((a, b) => ((a.data.order as number) ?? 0) - ((b.data.order as number) ?? 0)) as never,
    settings: () => settings as never,
    remind: () => rem,
    today: () => T, now: () => Date.parse(`${T}T10:00:00Z`), deviceTz: () => "UTC", red: () => false, version: () => "1.56",
    async add(t) {
      const id = `new${++seq}`;
      const all = [...docs.values()];
      const order = (t as Data).order ?? (all.length ? Math.max(...all.map((d) => (d.data.order as number) ?? 0)) + 1 : 0);
      docs.set(id, { id, ws: null, kind: "todo", author: null, updatedAt: null, data: { type: "once", done: false, ...t, order, createdAt: "2026-11-12T10:00:00.000Z" } });
      log.push(`add ${id}`);
      return id;
    },
    async update(id, patch) { const d = docs.get(id); if (d) d.data = { ...d.data, ...patch }; log.push(`update ${id} ${JSON.stringify(patch)}`); },
    async setDone(id, done) { const d = docs.get(id); if (d && !!d.data.done !== done) d.data = { ...d.data, done, doneAt: done ? "2026-11-12T10:00:00.000Z" : null }; log.push(`done ${id} ${done}`); },
    async remove(id) { docs.delete(id); log.push(`remove ${id}`); },
    async saveSettings(p) { settings = { ...settings, ...p }; log.push(`settings ${Object.keys(p).join(",")}`); },
    async saveRemind(change) { const next = change(rem); if (next) rem = cleanRemind(next); log.push("remind"); },
    newGroupId: () => `grp${++gseq}x`,
    async startSentry() { log.push("sentry start"); return sentry; },
    async setFocus(ids) { settings = { ...settings, workingIds: ids, workingOn: ids[0] ?? null }; log.push(`focus ${ids.join(",") || "none"}`); },
  };
  return store;
}
const d = (id: string, order: number, x: Data = {}): Doc => ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: `Task ${id}`, type: "once", done: false, order, ...x } });
const ALL: Scopes = Object.fromEntries(SCOPES.map((s) => [s.id, true])) as Scopes;
const ALL_BUT = (id: keyof Scopes): Scopes => ({ ...ALL, [id]: false });
const call = (s: ApiStore, method: string, path: string, body?: unknown, scopes: unknown = DEFAULT_SCOPES, query?: Record<string, string>) =>
  handleApi({ method, path, body, query }, scopes, s) as Promise<{ status: number; body: any }>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const SETTINGS = {
  tmGroups: [{ id: "errand1", name: "Errands" }],
  tmPages: [{ id: "work01", name: "Work", secs: ["g:errand1"] }, { id: "panel1", name: "Page 2", secs: [], kind: "panels" }],
  tmPageOrder: ["main", "work01", "panel1"],
};
const world = () => fake({
  settings: SETTINGS,
  todos: [d("a1", 0, { p1: true }), d("a2", 1), d("gym", 0, { type: "daily" }), d("e1", 0, { group: "errand1" }), d("ai1", 5, { ai: true, aiInbox: true, title: "Inbox one" })],
});

// ---------- switches ----------
ok("defaults: add, read and the AI Inbox on, everything else off", () => {
  assert.deepEqual(DEFAULT_SCOPES, { inbox: true, lists: false, goals: false, rename: false, read: true, add: true, edit: false, done: false, delete: false, remind: false, focus: false, sentry: false, gym: false, settings: false, message: false });
  assert.deepEqual(cleanScopes({ lists: true, delete: "yes", bogus: true }), { ...DEFAULT_SCOPES, lists: true });
  assert.deepEqual(cleanScopes(null), DEFAULT_SCOPES);
});

// ---------- GET /v1 and the lock ----------
ok("GET /v1 answers even while PS is locked, every other endpoint says 423", async () => {
  const s = fake({ locked: true });
  const r = await call(s, "GET", "/v1");
  assert.equal(r.status, 200);
  assert.equal(r.body.vault, "locked");
  assert.equal(r.body.inbox.id, INBOX);
  assert.ok(r.body.endpoints.includes("POST /v1/tasks"));
  const r2 = await call(s, "GET", "/v1/tasks");
  assert.equal(r2.status, 423);
  assert.equal(r2.body.error.code, "locked");
});
ok("unknown paths 404, wrong methods 405 with the allowed ones", async () => {
  const s = world();
  assert.equal((await call(s, "GET", "/v2/tasks")).status, 404);
  assert.equal((await call(s, "GET", "/v1/nope")).status, 404);
  const r = await call(s, "PUT", "/v1/tasks");
  assert.equal(r.status, 405);
  assert.deepEqual(r.body.error.allow, ["GET", "POST"]);
  assert.equal((await call(s, "POST", "/v1/lists")).status, 405);
  assert.equal((await call(s, "GET", "/v1/tasks/a2/explode")).status, 404);
  assert.equal((await call(s, "GET", "/v1/tasks/../../etc")).status, 404);
});

// ---------- reading ----------
ok("default switches: only the AI Inbox can be read", async () => {
  const s = world();
  const r = await call(s, "GET", "/v1/tasks");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map((t: { id: string }) => t.id), ["ai1"]);
  assert.equal(r.body.tasks[0].list, "inbox");
  assert.equal(r.body.tasks[0].addedByAi, true);
  const l = await call(s, "GET", "/v1/lists");
  assert.deepEqual(l.body.lists.map((x: { id: string }) => x.id), ["inbox"]);
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, DEFAULT_SCOPES, { list: "main" })).body.error.scope, "lists");
  const one = await call(s, "GET", "/v1/tasks/a2");
  assert.equal(one.status, 403);
  assert.equal(one.body.error.code, "scope_off");
  assert.equal(one.body.error.scope, "lists");
});
ok("read off: nothing can be read", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, read: false };
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, sc)).body.error.scope, "read");
  assert.equal((await call(s, "GET", "/v1/lists", undefined, sc)).body.error.scope, "read");
  assert.equal((await call(s, "GET", "/v1/tasks/ai1", undefined, sc)).body.error.scope, "read");
});
ok("lists on: every list in order, sections, what they take, panels pages marked", async () => {
  const s = world();
  const r = await call(s, "GET", "/v1/lists", undefined, ALL);
  const lists = r.body.lists;
  assert.deepEqual(lists.map((x: { id: string }) => x.id), ["inbox", "main", "work01", "panel1"]);
  const main = lists[1];
  assert.equal(main.name, "Main list");
  assert.equal(main.home, true);
  assert.deepEqual(main.sections.map((x: { key: string; takes: string; openTasks: number }) => [x.key, x.takes, x.openTasks]), [["p1", "once", 1], ["prio", "once", 1], ["daily", "daily", 1]]);
  assert.deepEqual(lists[2].sections, [{ key: "g:errand1", name: "Errands", takes: "any", openTasks: 1 }]);
  assert.equal(lists[3].kind, "panels");
  assert.equal(lists[0].openTasks, 1);
});
ok("tasks in order: inbox, then each list and section; filters by list, section, status, words", async () => {
  const s = world();
  s.docs.set("old", d("old", 9, { done: true, doneAt: "2026-11-11T08:00:00Z" }));
  const all = await call(s, "GET", "/v1/tasks", undefined, ALL);
  assert.deepEqual(all.body.tasks.map((t: { id: string }) => t.id), ["ai1", "a1", "a2", "gym", "e1"]);
  const p = (q: Record<string, string>) => call(s, "GET", "/v1/tasks", undefined, ALL, q).then((r) => r.body.tasks.map((t: { id: string }) => t.id));
  assert.deepEqual(await p({ list: "work01" }), ["e1"]);
  assert.deepEqual(await p({ section: "p1" }), ["a1"]);
  assert.deepEqual(await p({ status: "done" }), ["old"]);
  assert.deepEqual(await p({ q: "INBOX" }), ["ai1"]);
  assert.deepEqual(await p({ limit: "2" }), ["ai1", "a1"]);
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, ALL, { status: "maybe" })).status, 400);
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, ALL, { lmit: "2" })).body.error.code, "unknown_field");
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, ALL, { list: "nope" })).status, 404);
  const one = (await call(s, "GET", "/v1/tasks/e1", undefined, ALL)).body.task;
  assert.deepEqual([one.list, one.listName, one.section, one.sectionName, one.kind, one.p1], ["work01", "Work", "g:errand1", "Errands", "once", false]);
});

// ---------- adding ----------
ok("add: lands in the AI Inbox with the AI marker, nothing on the lists changes", async () => {
  const s = world();
  const r = await call(s, "POST", "/v1/tasks", { title: "  Email Sam  ", notes: "Attach the PDF", due: "2026-11-15" });
  assert.equal(r.status, 201);
  const t = r.body.task;
  assert.deepEqual([t.title, t.notes, t.due, t.list, t.section, t.addedByAi, t.inInbox], ["Email Sam", "Attach the PDF", "2026-11-15", "inbox", "inbox", true, true]);
  const saved = s.docs.get(t.id)!.data;
  assert.equal(saved.ai, true);
  assert.equal(saved.aiInbox, true);
  // The Tab list's sections never show it.
  const lists = tabLists(s.todos(), [{ id: "errand1", name: "Errands" }], T);
  assert.ok(![...lists.ranked, ...lists.daily].some((x) => x.id === t.id));
  assert.deepEqual(inboxTasks(s.todos() as never, Date.parse(`${T}T10:00:00Z`)).map((x) => x.id), ["ai1", t.id]);
  assert.equal(openInboxCount(s.todos() as never), 2);
});
ok("add: a batch keeps its order, and one bad task means none are added", async () => {
  const s = world();
  const bad = await call(s, "POST", "/v1/tasks", { tasks: [{ title: "One" }, { title: "" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, "title");
  assert.match(bad.body.error.message, /tasks\[1\]/);
  assert.ok(!s.log.some((x) => x.startsWith("add")));
  const r = await call(s, "POST", "/v1/tasks", { tasks: [{ title: "One" }, { title: "Two", kind: "daily" }] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.tasks.map((t: { title: string; kind: string }) => [t.title, t.kind]), [["One", "once"], ["Two", "daily"]]);
  const many = await call(s, "POST", "/v1/tasks", { tasks: Array.from({ length: 51 }, (_, i) => ({ title: `T${i}` })) });
  assert.equal(many.body.error.code, "too_many");
});
ok("add: checks every field, names unknown ones", async () => {
  const s = world();
  const e = async (b: unknown) => (await call(s, "POST", "/v1/tasks", b)).body.error;
  assert.equal((await e({ title: "x", prority: 1 })).code, "unknown_field");
  assert.equal((await e({ title: "x", due: "2026-02-30" })).field, "due");
  assert.equal((await e({ title: "x", due: "tomorrow" })).field, "due");
  assert.equal((await e({ title: "x", kind: "weekly" })).field, "kind");
  assert.equal((await e({ title: "x", kind: "daily", due: "2026-11-20" })).field, "due");
  assert.equal((await e({ title: "x", kind: "daily", p1: true })).field, "p1");
  assert.equal((await e("just text")).code, "bad_request");
  assert.equal((await e([{ title: "x" }])).code, "bad_request");
  assert.equal((await e({ title: "x".repeat(600) })), undefined);   // trimmed, not refused
});
ok("add off: refused; adding to a list needs lists on", async () => {
  const s = world();
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x" }, { ...DEFAULT_SCOPES, add: false })).body.error.scope, "add");
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x", list: "main" })).body.error.scope, "lists");
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x" }, { ...DEFAULT_SCOPES, inbox: false, lists: true })).body.error.scope, "inbox");
});
ok("add to a list: the right section, at its end, with the AI marker", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, lists: true };
  const main = (await call(s, "POST", "/v1/tasks", { title: "Main one", list: "main" }, sc)).body.task;
  assert.deepEqual([main.list, main.section, main.inInbox, main.addedByAi], ["main", "prio", false, true]);
  assert.equal(s.docs.get(main.id)!.data.order, 2);   // after a1 (0) and a2 (1)
  const p1 = (await call(s, "POST", "/v1/tasks", { title: "Urgent", section: "p1" }, sc)).body.task;
  assert.deepEqual([p1.section, p1.p1], ["p1", true]);
  const work = (await call(s, "POST", "/v1/tasks", { title: "Buy milk", list: "work01" }, sc)).body.task;
  assert.deepEqual([work.list, work.section], ["work01", "g:errand1"]);
  const daily = (await call(s, "POST", "/v1/tasks", { title: "Walk", kind: "daily", list: "main" }, sc)).body.task;
  assert.equal(daily.section, "daily");
  const wrong = await call(s, "POST", "/v1/tasks", { title: "Walk", kind: "daily", section: "prio" }, sc);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error.code, "wrong_section");
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x", list: "panel1" }, sc)).body.error.code, "not_a_task_list");
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x", list: "main", section: "g:errand1" }, sc)).body.error.field, "section");
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x", section: "g:zzzz9" }, sc)).status, 404);
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "x", list: "inbox", section: "prio" }, sc)).status, 400);
});
ok("add to a list with no section that takes it: a new To do group on that list", async () => {
  const s = fake({ settings: { tmPages: [{ id: "daily1", name: "Streaks", secs: ["daily"] }], tmPageOrder: ["main", "daily1"] }, todos: [] });
  const r = await call(s, "POST", "/v1/tasks", { title: "One off", list: "daily1" }, { ...DEFAULT_SCOPES, lists: true });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.task.list, r.body.task.section, r.body.task.sectionName], ["daily1", "g:grp1x", "To do"]);
  const st = s.set() as { tmPages: { id: string; secs: string[] }[]; tmGroups: { id: string }[] };
  assert.deepEqual(st.tmPages.find((p) => p.id === "daily1")!.secs, ["daily", "g:grp1x"]);
  assert.deepEqual(st.tmGroups.map((g) => g.id), ["grp1x"]);
});

// ---------- editing, moving, ticking, deleting ----------
ok("edit needs edit; done needs done; nothing else changes", async () => {
  const s = world();
  assert.equal((await call(s, "PATCH", "/v1/tasks/ai1", { title: "New" })).body.error.scope, "edit");
  assert.equal((await call(s, "PATCH", "/v1/tasks/ai1", { done: true })).body.error.scope, "done");
  const sc = { ...DEFAULT_SCOPES, edit: true, done: true };
  const r = await call(s, "PATCH", "/v1/tasks/ai1", { title: "Renamed", notes: "n", due: "2026-12-01", done: true }, sc);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.task.title, r.body.task.notes, r.body.task.due, r.body.task.done, r.body.task.inInbox], ["Renamed", "n", "2026-12-01", true, true]);
  const c = await call(s, "PATCH", "/v1/tasks/ai1", { notes: null, due: null }, sc);
  assert.deepEqual([c.body.task.notes, c.body.task.due], [null, null]);
  assert.equal((await call(s, "PATCH", "/v1/tasks/ai1", {}, sc)).status, 400);
  assert.equal((await call(s, "PATCH", "/v1/tasks/ai1", { colour: "red" }, sc)).body.error.code, "unknown_field");
  assert.equal((await call(s, "PATCH", "/v1/tasks/nope", { title: "x" }, sc)).status, 404);
});
ok("move out of the AI Inbox needs lists; it clears the inbox flag and keeps the AI marker", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, edit: true };
  assert.equal((await call(s, "PATCH", "/v1/tasks/ai1", { list: "main" }, sc)).body.error.scope, "lists");
  const r = await call(s, "PATCH", "/v1/tasks/ai1", { list: "main" }, { ...sc, lists: true });
  assert.deepEqual([r.body.task.list, r.body.task.section, r.body.task.inInbox, r.body.task.addedByAi], ["main", "prio", false, true]);
  assert.equal(s.docs.get("ai1")!.data.aiInbox, false);
  const back = await call(s, "PATCH", "/v1/tasks/ai1", { list: "inbox" }, { ...sc, lists: true });
  assert.equal(back.body.task.inInbox, true);
  const g = await call(s, "PATCH", "/v1/tasks/a2", { section: "g:errand1" }, ALL);
  assert.deepEqual([g.body.task.list, g.body.task.section], ["work01", "g:errand1"]);
  assert.equal((await call(s, "PATCH", "/v1/tasks/gym", { section: "prio" }, ALL)).body.error.code, "wrong_section");
  assert.equal((await call(s, "PATCH", "/v1/tasks/gym", { p1: true }, ALL)).body.error.field, "p1");
  assert.equal((await call(s, "PATCH", "/v1/tasks/e1", { p1: true }, ALL)).body.error.code, "wrong_section");
  const p = await call(s, "PATCH", "/v1/tasks/a2", { section: "prio", p1: true }, ALL);
  assert.deepEqual([p.body.task.section, p.body.task.p1], ["p1", true]);
});
ok("complete and reopen need done; delete needs delete and takes the reminder with it", async () => {
  const s = world();
  assert.equal((await call(s, "POST", "/v1/tasks/ai1/complete")).body.error.scope, "done");
  const sc = { ...DEFAULT_SCOPES, done: true, delete: true, remind: true };
  assert.equal((await call(s, "POST", "/v1/tasks/ai1/complete", undefined, sc)).body.task.done, true);
  assert.equal((await call(s, "POST", "/v1/tasks/ai1/reopen", undefined, sc)).body.task.done, false);
  assert.equal((await call(s, "GET", "/v1/tasks/ai1/complete", undefined, sc)).status, 405);
  await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30" }, sc);
  assert.equal(s.rem()!.list.filter((r) => r.task === "ai1").length, 1);
  assert.equal((await call(s, "DELETE", "/v1/tasks/ai1", undefined, DEFAULT_SCOPES)).body.error.scope, "delete");
  const r = await call(s, "DELETE", "/v1/tasks/ai1", undefined, sc);
  assert.deepEqual(r.body, { deleted: "ai1" });
  assert.ok(!s.docs.has("ai1"));
  assert.equal(s.rem()!.list.filter((x) => x.task === "ai1").length, 0);
});
ok("tasks on lists stay out of reach while lists is off, whatever else is on", async () => {
  const s = world();
  const sc = { ...ALL, lists: false };
  for (const [m, p, b] of [["PATCH", "/v1/tasks/a1", { title: "x" }], ["POST", "/v1/tasks/a1/complete"], ["DELETE", "/v1/tasks/a1"], ["PUT", "/v1/tasks/a1/reminder", { time: "10:00" }]] as const) {
    const r = await call(s, m, p, b, sc);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.error.scope, "lists");
  }
  assert.equal(s.docs.get("a1")!.data.title, "Task a1");
});

// ---------- reminders ----------
ok("reminder: once on a date, default 3 hours, changed by a second PUT, taken off by DELETE", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, remind: true };
  assert.equal((await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30" })).body.error.scope, "remind");
  const r = await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30", date: "2026-11-13" }, sc);
  assert.deepEqual(r.body.task.reminder, { date: "2026-11-13", time: "09:30", until: "12:30", on: true, message: null });
  const r2 = await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "22:00", until: "01:00", message: "Do it now" }, sc);
  assert.deepEqual(r2.body.task.reminder, { date: T, time: "22:00", until: "01:00", on: true, message: "Do it now" });
  assert.equal(s.rem()!.list.filter((x) => x.task === "ai1").length, 1);
  assert.equal((await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "9:30" }, sc)).body.error.field, "time");
  assert.equal((await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30", date: "2026-11-01" }, sc)).body.error.field, "date");
  assert.equal((await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30", until: "09:30" }, sc)).body.error.field, "until");
  assert.equal((await call(s, "PUT", "/v1/tasks/ai1/reminder", { time: "09:30", sound: "loud" }, sc)).body.error.code, "unknown_field");
  const del = await call(s, "DELETE", "/v1/tasks/ai1/reminder", undefined, sc);
  assert.equal(del.body.task.reminder, null);
  assert.equal((await call(s, "DELETE", "/v1/tasks/ai1/reminder", undefined, sc)).status, 404);
});

// ---------- renaming ----------
ok("rename lists and sections: needs rename and lists, blank brings the usual name back", async () => {
  const s = world();
  assert.equal((await call(s, "PATCH", "/v1/lists/main", { name: "Work" })).body.error.scope, "rename");
  assert.equal((await call(s, "PATCH", "/v1/lists/main", { name: "Work" }, { ...DEFAULT_SCOPES, rename: true })).body.error.scope, "lists");
  const sc = { ...DEFAULT_SCOPES, rename: true, lists: true };
  assert.deepEqual((await call(s, "PATCH", "/v1/lists/main", { name: "Home base" }, sc)).body, { list: { id: "main", name: "Home base" } });
  assert.equal((s.set().tmNames as Data).main, "Home base");
  await call(s, "PATCH", "/v1/lists/main", { name: "" }, sc);
  assert.equal((s.set().tmNames as Data).main, undefined);
  await call(s, "PATCH", "/v1/lists/work01", { name: "Office" }, sc);
  assert.equal((s.set().tmPages as { name: string }[])[0].name, "Office");
  assert.equal((await call(s, "PATCH", "/v1/lists/work01", { name: "  " }, sc)).body.error.field, "name");
  assert.equal((await call(s, "PATCH", "/v1/lists/inbox", { name: "Mine" }, sc)).status, 400);
  assert.equal((await call(s, "PATCH", "/v1/lists/zzzz11", { name: "x" }, sc)).status, 404);
  assert.deepEqual((await call(s, "PATCH", "/v1/sections/prio", { name: "This week" }, sc)).body, { section: { key: "prio", name: "This week" } });
  assert.equal((await call(s, "PATCH", "/v1/sections/g:errand1", { name: "Shops" }, sc)).body.section.name, "Shops");
  assert.equal((s.set().tmGroups as { name: string }[])[0].name, "Shops");
  assert.equal((await call(s, "PATCH", "/v1/sections/g%3Aerrand1", { name: "Shops 2" }, sc)).body.section.name, "Shops 2");
  assert.equal((await call(s, "PATCH", "/v1/sections/nope", { name: "x" }, sc)).status, 404);
  assert.equal((await call(s, "PATCH", "/v1/sections/prio", { name: "x", colour: 1 }, sc)).body.error.code, "unknown_field");
});

// ---------- robustness ----------
ok("a store that throws answers 500 with no task text", async () => {
  const s = world();
  s.update = async () => { throw new Error("secret task text"); };
  const r = await call(s, "PATCH", "/v1/tasks/ai1", { title: "x" }, { ...DEFAULT_SCOPES, edit: true });
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(r.body).includes("secret"));
});
ok("the inbox fills up at 500 open tasks", async () => {
  const s = fake({ todos: Array.from({ length: 500 }, (_, i) => d(`i${i}`, i, { aiInbox: true, ai: true })) });
  assert.equal((await call(s, "POST", "/v1/tasks", { title: "one more" })).body.error.code, "inbox_full");
});
ok("inboxMove: to a list's first section that takes it, or a new To do group there", () => {
  const groups = [{ id: "errand1", name: "Errands" }];
  const lists = tabLists([d("a2", 3) as never], groups, T);
  const pages = [{ id: "work01", name: "Work", secs: ["g:errand1"] }, { id: "dd0001", name: "Streaks", secs: ["daily"] }, { id: "pp0001", name: "P", secs: [], kind: "panels" as const }];
  const full = ["p1", "prio", "daily", "g:errand1"];
  const ctx = { lists, full, pages, groups };
  // PS 1.73 (the developer: "stop adding in priorities at random"): into Priorities with no priority, at the bottom.
  assert.deepEqual(inboxMove({ type: "once" }, "main", ctx, () => "zz")!.patch, { group: null, order: 4, p1: false, unranked: true, prioGroup: null, aiInbox: false });
  assert.deepEqual(inboxMove({ type: "once" }, "work01", ctx, () => "zz")!.patch, { group: "errand1", order: 0, aiInbox: false });
  const made = inboxMove({ type: "once" }, "dd0001", ctx, () => "newg1")!;
  assert.deepEqual(made.patch, { group: "newg1", order: 0, aiInbox: false });
  assert.deepEqual(made.settings!.tmPages!.find((p) => p.id === "dd0001")!.secs, ["daily", "g:newg1"]);
  assert.equal(inboxMove({ type: "once" }, "pp0001", ctx, () => "zz"), null);
  assert.equal(inboxMove({ type: "once" }, "gone99", ctx, () => "zz"), null);
});

// ---------- Sentry mode: start only ----------
ok("Start Sentry mode: off by default, so refused and nothing runs", async () => {
  const s = world();
  const r = await call(s, "POST", "/v1/sentry/start");
  assert.equal(r.status, 403);
  assert.equal(r.body.error.scope, "sentry");
  assert.ok(!s.log.includes("sentry start"));
  assert.equal(SCOPES.find((x) => x.id === "sentry")!.label, "Start Sentry mode");
  assert.equal((await call(s, "POST", "/v1/sentry/start", undefined, { ...ALL, sentry: false })).body.error.scope, "sentry");
});
ok("Start Sentry mode: switched on, it starts exactly once and says it cannot be stopped here", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, sentry: true };
  const r = await call(s, "POST", "/v1/sentry/start", undefined, sc);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.sentry.started, r.body.sentry.phase], [true, "covered"]);
  assert.match(r.body.sentry.note, /never stopped/);
  assert.deepEqual(s.log, ["sentry start"]);
  assert.equal((await call(s, "POST", "/v1/sentry/start", {}, sc)).status, 200);   // an empty object is fine
  s.sentryWill({ result: "already", phase: "locked" });
  const a = await call(s, "POST", "/v1/sentry/start", undefined, sc);
  assert.deepEqual([a.status, a.body.sentry.started, a.body.sentry.alreadyOn, a.body.sentry.phase], [200, false, true, "locked"]);
});
ok("Start Sentry mode: the button's checks failing means no start, with what to fix", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, sentry: true };
  s.sentryWill({ result: "blocked", title: "The restart is not ready", lines: ["The restart helper is off."] });
  const b = await call(s, "POST", "/v1/sentry/start", undefined, sc);
  assert.deepEqual([b.status, b.body.error.code], [409, "sentry_checks"]);
  assert.deepEqual(b.body.error.lines, ["The restart helper is off."]);
  s.sentryWill({ result: "refused", note: "Sentry mode did not start: a protected app is in front." });
  assert.deepEqual(await call(s, "POST", "/v1/sentry/start", undefined, sc).then((r) => [r.status, r.body.error.code, r.body.error.message]), [409, "sentry_refused", "Sentry mode did not start: a protected app is in front."]);
  s.sentryWill({ result: "notStarted" });
  assert.equal((await call(s, "POST", "/v1/sentry/start", undefined, sc)).body.error.code, "sentry_refused");
  s.sentryWill({ result: "noAnswer" });
  assert.equal((await call(s, "POST", "/v1/sentry/start", undefined, sc)).status, 503);
  assert.equal((await call(fake({ locked: true }), "POST", "/v1/sentry/start", undefined, sc)).status, 423);
});
ok("Start Sentry mode takes no settings: any field or query is refused before anything runs", async () => {
  const s = world();
  const sc = { ...ALL, sentry: true };
  for (const b of [{ restartH: 0 }, { lid: false }, { stop: true }, { minutes: 5 }, "now", [1]]) {
    const r = await call(s, "POST", "/v1/sentry/start", b, sc);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal((await call(s, "POST", "/v1/sentry/start", undefined, sc, { until: "10:00" })).status, 400);
  assert.ok(!s.log.includes("sentry start"));
});
ok("no route stops, pauses or changes Sentry mode: every other path and method is refused untouched", async () => {
  const s = world();
  const sc = { ...ALL, sentry: true };
  const paths = ["/v1/sentry", "/v1/sentry/stop", "/v1/sentry/end", "/v1/sentry/off", "/v1/sentry/pause", "/v1/sentry/leave", "/v1/sentry/unlock",
    "/v1/sentry/disable", "/v1/sentry/settings", "/v1/sentry/start/stop", "/v1/sentry/start/cancel", "/v1/sentry/stop/now", "/v1/sentries/stop"];
  for (const p of paths) for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const r = await call(s, m, p, {}, sc);
    assert.ok(r.status === 404 || r.status === 405, `${m} ${p}: ${r.status}`);
  }
  for (const m of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal((await call(s, m, "/v1/sentry/start", undefined, sc)).status, 405, m);
  assert.deepEqual(s.log, [], "nothing ran, not even a start");
  const e = (await call(s, "DELETE", "/v1/sentry/start", undefined, sc)).body.error.message;
  assert.match(e, /never stopped/);
  // The API's store can only start it; GET /v1 lists one Sentry endpoint and it is a start.
  const list = (await call(s, "GET", "/v1")).body.endpoints.filter((x: string) => /sentry/i.test(x));
  assert.deepEqual(list, ["POST /v1/sentry/start"]);
});
ok("nowhere in the page code is there a message or store call that stops Sentry mode", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = `${d}/${f}`; if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
  walk(new URL("../src", import.meta.url).pathname);
  const sent = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/type:\s*"(sentry:[a-zA-Z]+)"/g)) sent.add(m[1]);
  const allowed = new Set(["sentry:start", "sentry:get", "sentry:lidCheck", "sentry:fileVault"]);   // none of them stops it
  assert.ok(sent.has("sentry:start"), "the scan found the start message");
  for (const x of sent) assert.ok(allowed.has(x), `unexpected Sentry message ${x}`);
  const api = readFileSync(new URL("../src/core/taskapi.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/taskapi.ts", import.meta.url), "utf8");
  assert.ok(!/(stop|end|pause|leave|disengage|cancel)Sentry/i.test(api), "no stop in the API or its store");
});

// ---------- the gym reminder (V1.57) ----------
ok("gym: the switch is off by default, both endpoints refuse with scope_off and nothing is saved", async () => {
  const s = world();
  for (const m of ["GET", "PATCH"]) {
    const r = await call(s, m, "/v1/gym", m === "PATCH" ? { time: "23:00" } : undefined);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.scope], [403, "scope_off", "gym"], m);
  }
  assert.equal(DEFAULT_SCOPES.gym, false);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
  assert.equal((await call(fake({ locked: true }), "GET", "/v1/gym", undefined, { ...DEFAULT_SCOPES, gym: true })).status, 423);
});
ok("GET /v1/gym: the times as they are, old settings with the defaults", async () => {
  const s = fake({ settings: { gym: { on: true, time: "08:00", days: [1, 3, 5] } } });
  const r = await call(s, "GET", "/v1/gym", undefined, { ...DEFAULT_SCOPES, gym: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.gym, { on: true, time: "08:00", endTime: "09:30", days: ["mon", "wed", "fri"], nag: false, nagStart: "10:00", nagEvery: 15, ringTime: "07:44", saidYesToday: false });
  // Someone else's, never saved: off (the public default).
  assert.equal((await call(fake(), "GET", "/v1/gym", undefined, { ...DEFAULT_SCOPES, gym: true })).body.gym.on, false);
});
ok("PATCH /v1/gym: the developer's night gym, nag mode and ring time; only the fields sent change", async () => {
  const s = fake({ settings: { gym: { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] } } });
  const sc = { ...DEFAULT_SCOPES, gym: true };
  const r = await call(s, "PATCH", "/v1/gym", { time: "23:00", endTime: "01:00", ringTime: "22:55", nag: true, nagStart: "10:00", nagEvery: 15, days: ["Mon", "tue", 3] }, sc);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.gym, { on: true, time: "23:00", endTime: "01:00", days: ["mon", "tue", "wed"], nag: true, nagStart: "10:00", nagEvery: 15, ringTime: "22:55", saidYesToday: false });
  assert.deepEqual(s.set().gym, { on: true, time: "23:00", end: "01:00", days: [1, 2, 3], nag: true, nagStart: "10:00", nagEvery: 15, ringAt: "22:55" });
  const back = await call(s, "PATCH", "/v1/gym", { ringTime: null, endTime: null }, sc);
  assert.deepEqual([back.body.gym.ringTime, back.body.gym.endTime, back.body.gym.time], ["22:44", "00:30", "23:00"]);
});
ok("PATCH /v1/gym: bad values and unknown fields are refused, nothing saved", async () => {
  const s = fake({ settings: { gym: { on: true, time: "08:00", days: [1] } } });
  const sc = { ...DEFAULT_SCOPES, gym: true };
  for (const [b, field] of [[{ time: "25:00" }, "time"], [{ nagEvery: 2 }, "nagEvery"], [{ nagEvery: 15.5 }, "nagEvery"], [{ days: ["someday"] }, "days"],
    [{ on: "yes" }, "on"], [{ endTime: "08:00" }, "endTime"], [{ ringTime: "7:44" }, "ringTime"], [{ colour: "red" }, "colour"]] as const) {
    const r = await call(s, "PATCH", "/v1/gym", b, sc);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.error.field, field, JSON.stringify(b));
  }
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
});
ok("the API can never say Yes to the gym: no field, path or method does, gymAck is never written", async () => {
  const s = fake({ settings: { gym: { on: true, time: "08:00" }, gymAck: [] } });
  const sc = { ...ALL, gym: true };
  for (const k of ["yes", "ack", "acknowledge", "gymAck", "saidYes", "saidYesToday", "going", "done"]) {
    const r = await call(s, "PATCH", "/v1/gym", { [k]: true }, sc);
    assert.deepEqual([r.status, r.body.error.field], [400, k], k);
    assert.match(r.body.error.message, /never say Yes/);
  }
  for (const p of ["/v1/gym/yes", "/v1/gym/ack", "/v1/gym/acknowledge", "/v1/gym/today", "/v1/gym/going"])
    for (const m of ["GET", "POST", "PUT", "PATCH"]) assert.equal((await call(s, m, p, { yes: true }, sc)).status, 404, `${m} ${p}`);
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await call(s, m, "/v1/gym", {}, sc)).status, 405, m);
  assert.deepEqual(s.set().gymAck, []);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
  // A real PATCH carries the gym prefs only, never gymAck.
  await call(s, "PATCH", "/v1/gym", { time: "09:00" }, sc);
  assert.deepEqual(s.log.filter((x) => x.startsWith("settings")), ["settings gym"]);
  const src = readFileSync(new URL("../src/core/taskapi.ts", import.meta.url), "utf8");
  assert.ok(!/gymAck\s*:/.test(src) && !/ackGym/.test(src), "the API's code never writes a Yes");
});
ok("GET /v1 lists the gym endpoints; saidYesToday reads the day the nagging started", async () => {
  const list = (await call(world(), "GET", "/v1")).body.endpoints;
  assert.ok(list.includes("GET /v1/gym") && list.includes("PATCH /v1/gym"));
  // 12 Nov 10:00 UTC; nag from 10:00, gym 23:00 to 01:00: the day is 12 Nov.
  const s = fake({ settings: { gym: { on: true, time: "23:00", end: "01:00", nag: true, nagStart: "10:00", days: [0, 1, 2, 3, 4, 5, 6] }, gymAck: ["2026-11-12"] } });
  assert.equal((await call(s, "GET", "/v1/gym", undefined, { ...DEFAULT_SCOPES, gym: true })).body.gym.saidYesToday, true);
});

// ---------- settings (V1.57: Invert swipe) ----------
ok("settings: the switch is off by default, both endpoints refuse with scope_off and nothing is saved", async () => {
  const s = world();
  for (const m of ["GET", "PATCH"]) {
    const r = await call(s, m, "/v1/settings", m === "PATCH" ? { invertSwipe: true } : undefined);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.scope], [403, "scope_off", "settings"], m);
  }
  assert.equal(DEFAULT_SCOPES.settings, false);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
});
ok("GET and PATCH /v1/settings: Invert swipe read, switched on and off, saved as swipeInvert only", async () => {
  const s = world();
  const sc = { ...DEFAULT_SCOPES, settings: true };
  const base = { autoReset: false, autoResetAt: "00:00", dayEnds: "reset" };
  assert.deepEqual((await call(s, "GET", "/v1/settings", undefined, sc)).body, { settings: { invertSwipe: false, ...base } });
  const on = await call(s, "PATCH", "/v1/settings", { invertSwipe: true }, sc);
  assert.deepEqual([on.status, on.body], [200, { settings: { invertSwipe: true, ...base } }]);
  assert.equal(s.set().swipeInvert, true);
  assert.deepEqual(s.log.filter((x) => x.startsWith("settings")), ["settings swipeInvert"]);
  assert.deepEqual((await call(s, "GET", "/v1/settings", undefined, sc)).body.settings, { invertSwipe: true, ...base });
  await call(s, "PATCH", "/v1/settings", { invertSwipe: false }, sc);
  assert.equal(s.set().swipeInvert, false);
  assert.equal((await call(fake({ locked: true }), "GET", "/v1/settings", undefined, sc)).status, 423);
});
ok("PATCH /v1/settings refuses anything else: other fields, bad values, an empty body, sub paths, other methods", async () => {
  const s = world();
  const sc = { ...ALL, settings: true };
  for (const [b, code, field] of [[{ invertSwipe: "yes" }, "bad_field", "invertSwipe"], [{ tmNames: {} }, "unknown_field", "tmNames"], [{ gymAck: ["2026-11-12"] }, "unknown_field", "gymAck"],
    [{ swipeInvert: true }, "unknown_field", "swipeInvert"], [{}, "bad_request", undefined]] as const) {
    const r = await call(s, "PATCH", "/v1/settings", b, sc);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.field], [400, code, field], JSON.stringify(b));
  }
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await call(s, m, "/v1/settings", { invertSwipe: true }, sc)).status, 405, m);
  assert.equal((await call(s, "PATCH", "/v1/settings/invertSwipe", { invertSwipe: true }, sc)).status, 404);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
  const list = (await call(s, "GET", "/v1")).body.endpoints;
  assert.ok(list.includes("GET /v1/settings") && list.includes("PATCH /v1/settings"));
});

// ---------- POST /v1/island/message (V1.58) ----------
const MSG = { ...DEFAULT_SCOPES, message: true };
const msgs = (s: ReturnType<typeof fake>) => (s.set().aiMsgs ?? []) as { id: string; from: string; text: string; detail?: string; chat?: string; at: string }[];
ok("message: the switch is off by default, refused with scope_off and nothing is saved", async () => {
  const s = world();
  const r = await call(s, "POST", "/v1/island/message", { from: "Claude Code", text: "Done" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "scope_off");
  assert.equal(r.body.error.scope, "message");
  assert.equal(msgs(s).length, 0);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
});
ok("message: kept in the settings with who, the words, the detail and the chat id; 201", async () => {
  const s = world();
  const r = await call(s, "POST", "/v1/island/message", { from: "  Claude   Code ", text: "Fixed the login bug,\n tests pass", detail: "Line one\r\nLine two\n\n\n\nEnd", chat: "43eece02-c43a-4a02-8e1d-2619fc41f9cf" }, MSG);
  assert.equal(r.status, 201);
  assert.equal(r.body.shown, true);
  const [m] = msgs(s);
  assert.equal(m.id, r.body.message.id);
  assert.match(m.id, /^[a-z0-9]{12}$/);
  assert.equal(m.from, "Claude Code");
  assert.equal(m.text, "Fixed the login bug, tests pass");
  assert.equal(m.detail, "Line one\nLine two\n\nEnd");
  assert.equal(m.chat, "43eece02-c43a-4a02-8e1d-2619fc41f9cf");
  assert.equal(m.at, "2026-11-12T10:00:00.000Z");
  assert.ok((await call(s, "GET", "/v1")).body.endpoints.includes("POST /v1/island/message"));
});
ok("message: text is needed; from defaults to AI; detail and chat are optional", async () => {
  const s = world();
  for (const b of [{}, { text: "" }, { text: "   " }, { text: 5 }, { from: "Codex" }]) {
    const r = await call(s, "POST", "/v1/island/message", b, MSG);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.error.field, "text");
  }
  const r = await call(s, "POST", "/v1/island/message", { text: "Hi" }, MSG);
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(msgs(s)[0]).sort(), ["at", "from", "id", "text"]);
  assert.equal(msgs(s)[0].from, "AI");
});
ok("message: limits are refused, never cut; unknown fields and wrong types are refused", async () => {
  const s = world();
  const at = (b: unknown) => call(s, "POST", "/v1/island/message", b, MSG);
  assert.equal((await at({ text: "x".repeat(AI_MSG.textMax) })).status, 201);
  for (const [b, f] of [[{ text: "x".repeat(AI_MSG.textMax + 1) }, "text"], [{ text: "a", from: "x".repeat(AI_MSG.fromMax + 1) }, "from"],
    [{ text: "a", detail: "x".repeat(AI_MSG.detailMax + 1) }, "detail"], [{ text: "a", from: 3 }, "from"], [{ text: "a", detail: ["x"] }, "detail"],
    [{ text: "a", chat: 12 }, "chat"]] as const) {
    const r = await at(b);
    assert.equal(r.status, 400, f);
    assert.equal(r.body.error.code, "bad_field");
    assert.equal(r.body.error.field, f);
  }
  const u = await at({ text: "a", html: "<b>hi</b>" });
  assert.equal(u.status, 400);
  assert.equal(u.body.error.code, "unknown_field");
  assert.equal(msgs(s).length, 1);
});
ok("message: bad JSON shapes, other methods and paths", async () => {
  const s = world();
  for (const b of [null, undefined, "text", ["a"], 5]) assert.equal((await call(s, "POST", "/v1/island/message", b, MSG)).status, 400, String(b));
  for (const m of ["GET", "PATCH", "PUT", "DELETE"]) assert.equal((await call(s, m, "/v1/island/message", { text: "a" }, MSG)).status, 405, m);
  for (const p of ["/v1/island", "/v1/island/messages", "/v1/island/message/1"]) assert.equal((await call(s, "POST", p, { text: "a" }, MSG)).status, 404, p);
  assert.equal(msgs(s).length, 0);
});
ok("message: words only; hidden marks and controls are taken out, HTML stays as typed", async () => {
  const s = world();
  const bidi = String.fromCharCode(0x202e), zw = String.fromCharCode(0x200b), bell = String.fromCharCode(7);
  await call(s, "POST", "/v1/island/message", { from: `Cl${zw}aude`, text: `<img src=x onerror=alert(1)> done${bidi}txt.exe${bell}` }, MSG);
  const [m] = msgs(s);
  assert.equal(m.from, "Cl aude");
  assert.equal(m.text, "<img src=x onerror=alert(1)> done txt.exe");
  assert.ok(![...m.text].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 0x200b && c.charCodeAt(0) <= 0x206f)));
});
ok("message: while PS is locked, 423 and nothing kept", async () => {
  const s = fake({ settings: SETTINGS, locked: true });
  assert.equal((await call(s, "POST", "/v1/island/message", { text: "a" }, MSG)).status, 423);
  assert.equal(msgs(s).length, 0);
});
ok("message: at most 10 in 10 minutes (429 with retryAfter); the same message again is not a second one", async () => {
  const s = world();
  for (let i = 0; i < AI_MSG.burst; i++) assert.equal((await call(s, "POST", "/v1/island/message", { text: `Task ${i} done` }, MSG)).status, 201, String(i));
  const r = await call(s, "POST", "/v1/island/message", { text: "One more" }, MSG);
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, "rate_limited");
  assert.ok(r.body.error.retryAfter >= 1 && r.body.error.retryAfter <= 600);
  assert.equal(msgs(s).length, AI_MSG.burst);
  const again = await call(s, "POST", "/v1/island/message", { text: "Task 3 done" }, MSG);   // a retry of one already kept
  assert.equal(again.status, 200);
  assert.equal(msgs(s).length, AI_MSG.burst);
});
ok("message: the person chose plain cards or Off: 200, shown false, nothing kept", async () => {
  for (const aiNotes of ["plain", "off"]) {
    const s = fake({ settings: { ...SETTINGS, aiNotes } });
    const r = await call(s, "POST", "/v1/island/message", { text: "Done" }, MSG);
    assert.equal(r.status, 200, aiNotes);
    assert.equal(r.body.shown, false);
    assert.ok(r.body.note.length > 10);
    assert.equal(msgs(s).length, 0);
  }
});

// ---------- Copy for AI ----------
ok("Copy for AI: self explaining, every endpoint, the switches as they are, the key slot, no dashes", () => {
  const g = aiGuide({ scopes: { ...DEFAULT_SCOPES, delete: true }, today: T });
  assert.ok(g.includes("http://127.0.0.1:47836"));
  assert.ok(g.includes(KEY_SLOT));
  for (const e of ["GET /v1/lists", "GET /v1/tasks", "POST /v1/tasks", "PATCH /v1/tasks/{id}", "DELETE /v1/tasks/{id}", "/complete", "/reopen", "PUT /v1/tasks/{id}/reminder", "PATCH /v1/lists/{id}", "PATCH /v1/sections/{key}"])
    assert.ok(g.includes(e), e);
  assert.ok(g.includes("- delete: ON."));
  assert.ok(g.includes("- edit: OFF."));
  for (const c of ["401", "403 scope_off", "404", "409", "423", "429", "browser_blocked"]) assert.ok(g.includes(c), c);
  assert.ok(g.includes("AI Inbox"));
  assert.ok(g.includes("curl -s -X POST http://127.0.0.1:47836/v1/sentry/start"), "Sentry mode has its curl example");
  assert.ok(g.includes("It cannot be turned off through the API"), "and its one plain line");
  assert.ok(g.includes("- sentry: OFF."), "and its switch");
  assert.ok(g.includes("- gym: OFF.") && g.includes("GET /v1/gym") && g.includes("PATCH /v1/gym"), "the gym switch and endpoints");
  assert.ok(g.includes("You can NEVER say Yes"), "and that it can never say Yes");
  assert.ok(g.includes("- settings: OFF.") && g.includes("PATCH /v1/settings") && g.includes('{"invertSwipe": true}'), "the settings switch, endpoints and example");
  assert.ok(!/[\u2013\u2014]/.test(g), "no en or em dashes");
  assert.ok(!/\bRed\b|Cincee/.test(g), "nothing personal");
  assert.ok(g.includes("- message: OFF.") && g.includes("### POST /v1/island/message") && g.includes("curl -s -X POST http://127.0.0.1:47836/v1/island/message"), "the message switch, endpoint and example");
  assert.ok(aiGuide({ scopes: { ...DEFAULT_SCOPES, message: true }, today: T }).includes("- message: ON."));
});
// ---------- the goals timeline (PS 1.72, Jan: "make sure that you can edit this with API as well, add and delete") ----------
const GOALS = [
  { id: "goal-big", title: "Launch the shop", level: "macro", start: "2026-10-01", end: "2026-12-31", color: "#EC4E86", note: "First 100 orders", done: false, createdAt: "2026-10-01T09:00:00.000Z", extra: "kept" },
  { id: "goal-month", title: "Finish the redesign", level: "meso", start: "2026-11-01", end: "2026-11-30", color: "#A855F7", note: null, done: true, createdAt: "2026-11-01T09:00:00.000Z" },
  { id: "goal-week", title: "Write the copy", level: "micro", start: "2026-11-09", end: "2026-11-15", color: "#38BDF8", createdAt: "2026-11-09T09:00:00.000Z" },
];
const goalWorld = () => fake({ settings: { ...SETTINGS, goals: GOALS.map((g) => ({ ...g })) } });
const G = { ...DEFAULT_SCOPES, goals: true };
const goalsOf = (s: ReturnType<typeof fake>) => (s.set().goals ?? []) as Data[];

ok("goals: the switch is off by default, and with it off every goals endpoint says scope_off and nothing is saved", async () => {
  const s = goalWorld();
  for (const [m, p, b] of [["GET", "/v1/goals"], ["POST", "/v1/goals", { title: "x" }], ["GET", "/v1/goals/goal-big"], ["PATCH", "/v1/goals/goal-big", { title: "y" }], ["DELETE", "/v1/goals/goal-big"]] as const) {
    const r = await call(s, m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.error.scope, "goals");
  }
  assert.deepEqual(s.log, []);
  assert.ok((await call(s, "GET", "/v1")).body.endpoints.includes("PATCH /v1/goals/{id}"));
  assert.equal((await call(fake({ locked: true }), "GET", "/v1/goals", undefined, G)).status, 423, "locked: 423 like everything else");
});
ok("goals: GET lists them in level order with the editor's words, and filters by level, status, days and words", async () => {
  const s = goalWorld();
  const r = await call(s, "GET", "/v1/goals", undefined, G);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.goals.map((g: Data) => g.id), ["goal-big", "goal-month", "goal-week"]);
  assert.deepEqual(r.body.goals[0], { id: "goal-big", title: "Launch the shop", level: "macro", levelName: "Macro", color: "#EC4E86", from: "2026-10-01", to: "2026-12-31", notes: "First 100 orders", done: false, createdAt: "2026-10-01T09:00:00.000Z" });
  assert.equal(r.body.goals[0].extra, undefined, "only the API's own fields");
  assert.equal(r.body.colors.length, 8);
  const ids = async (query: Record<string, string>) => (await call(s, "GET", "/v1/goals", undefined, G, query)).body.goals.map((g: Data) => g.id);
  assert.deepEqual(await ids({ level: "Micro" }), ["goal-week"]);
  assert.deepEqual(await ids({ status: "done" }), ["goal-month"]);
  assert.deepEqual(await ids({ status: "open" }), ["goal-big", "goal-week"]);
  assert.deepEqual(await ids({ from: "2026-11-20", to: "2026-11-25" }), ["goal-big", "goal-month"]);
  assert.deepEqual(await ids({ q: "copy" }), ["goal-week"]);
  assert.equal((await call(s, "GET", "/v1/goals", undefined, G, { level: "huge" })).body.error.field, "level");
  assert.equal((await call(s, "GET", "/v1/goals", undefined, G, { limit: "3" })).body.error.code, "unknown_field");
  assert.equal((await call(s, "GET", "/v1/goals", undefined, { ...G, read: false })).body.error.scope, "read");
  const one = await call(s, "GET", "/v1/goals/goal-week", undefined, G);
  assert.equal(one.body.goal.title, "Write the copy");
  assert.equal(one.body.goal.notes, null);
  assert.equal(one.body.goal.done, false);
  assert.equal((await call(s, "GET", "/v1/goals/nope", undefined, G)).status, 404);
  assert.equal((await call(s, "GET", "/v1/goals/goal-big/x", undefined, G)).status, 404);
  assert.equal((await call(s, "PUT", "/v1/goals/goal-big", {}, G)).status, 405);
  assert.deepEqual(s.log, [], "reading saves nothing");
});
ok("goals: POST adds one with defaults that match a click on the Timeline, saved in the settings record", async () => {
  const s = goalWorld();
  const r = await call(s, "POST", "/v1/goals", { title: "  Run a half marathon  " }, G);
  assert.equal(r.status, 201);
  assert.equal(r.body.goal.title, "Run a half marathon");
  assert.equal(r.body.goal.level, "macro");
  assert.equal(r.body.goal.from, T, "from: today");
  assert.equal(r.body.goal.to, "2027-01-31", "macro: to the end of the month two after");
  assert.equal(r.body.goal.color, "#34D399", "the next colour in turn, as the Timeline does");
  assert.deepEqual(s.log, ["settings goals"], "one save, through the encrypted settings");
  assert.equal(goalsOf(s).length, 4);
  assert.equal(goalsOf(s)[0].extra, "kept", "the other goals stay as they were, unknown fields too");
  const m = await call(s, "POST", "/v1/goals", { title: "Ship v2", level: "Meso", from: "2026-12-10", color: "#fbbf24", notes: "Beta first" }, G);
  assert.equal(m.body.goal.to, "2026-12-31", "meso: to the end of that month");
  assert.equal(m.body.goal.color, "#FBBF24");
  assert.equal(m.body.goal.notes, "Beta first");
  const w = await call(s, "POST", "/v1/goals", { title: "Plan the week", level: "micro", from: "2026-12-28" }, G);
  assert.equal(w.body.goal.to, "2027-01-03", "micro: a week, across the new year");
  const stored = goalsOf(s).find((g) => g.id === w.body.goal.id)!;
  assert.deepEqual(Object.keys(stored).sort(), ["color", "createdAt", "done", "end", "id", "level", "note", "start", "title"], "stored as the Timeline stores it");
  assert.equal(stored.createdAt, "2026-11-12T10:00:00.000Z");
});
ok("goals: POST checks every field, and a batch is all or nothing", async () => {
  const s = goalWorld();
  const bad = async (b: unknown, field: string, sc: unknown = G) => { const r = await call(s, "POST", "/v1/goals", b, sc); assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.body.error.field, field, JSON.stringify(b)); };
  await bad({}, "title");
  await bad({ title: "   " }, "title");
  await bad({ title: "x", level: "mega" }, "level");
  await bad({ title: "x", color: "pink" }, "color");
  await bad({ title: "x", from: "2026-02-30" }, "from");
  await bad({ title: "x", from: "2026-12-10", to: "2026-12-01" }, "to");
  await bad({ title: "x", notes: 5 }, "notes");
  await bad({ title: "x", start: "2026-12-01" }, "start");
  await bad({ title: "x", done: "yes" }, "done");
  assert.equal((await call(s, "POST", "/v1/goals", { title: "x", done: true }, G)).body.error.scope, "done", "adding a goal as done needs Tick done");
  assert.equal((await call(s, "POST", "/v1/goals", { title: "x" }, { ...G, add: false })).body.error.scope, "add");
  assert.equal((await call(s, "POST", "/v1/goals", { goals: [{ title: "ok" }, { title: "bad", level: "x" }] }, G)).status, 400);
  assert.equal((await call(s, "POST", "/v1/goals", { goals: [] }, G)).status, 400);
  assert.equal((await call(s, "POST", "/v1/goals", { goals: Array.from({ length: 51 }, () => ({ title: "x" })) }, G)).body.error.code, "too_many");
  assert.deepEqual(s.log, [], "nothing saved by any of them");
  const long = await call(s, "POST", "/v1/goals", { title: "y".repeat(300) }, G);
  assert.equal(long.body.goal.title.length, 120, "names are cut to the Timeline's 120");
  const b = await call(s, "POST", "/v1/goals", { goals: [{ title: "One", level: "micro" }, { title: "Two", level: "meso", done: true }] }, { ...G, done: true });
  assert.equal(b.status, 201);
  assert.equal(b.body.count, 2);
  assert.deepEqual(b.body.goals.map((g: Data) => g.title), ["One", "Two"]);
  assert.equal(b.body.goals[1].done, true);
  assert.notEqual(b.body.goals[0].color, b.body.goals[1].color, "each its own colour");
  assert.equal(s.log.filter((x) => x === "settings goals").length, 2, "the batch is one save");
  const full = fake({ settings: { goals: Array.from({ length: 499 }, (_, i) => ({ ...GOALS[2], id: `g${i}` })) } });
  assert.equal((await call(full, "POST", "/v1/goals", { goals: [{ title: "a" }, { title: "b" }] }, G)).status, 409, "the Timeline holds 500");
});
ok("goals: PATCH changes only what is sent; edit and done have their own switches", async () => {
  const s = goalWorld();
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", { title: "Grow the shop" }, G)).body.error.scope, "edit");
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", { done: true }, { ...G, edit: true })).body.error.scope, "done");
  assert.deepEqual(s.log, []);
  const E = { ...G, edit: true, done: true };
  const r = await call(s, "PATCH", "/v1/goals/goal-big", { title: "Grow the shop", level: "meso", color: "#34d399", from: "2026-11-01", to: "2026-11-30", notes: null }, E);
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body.goal, createdAt: undefined }, { id: "goal-big", title: "Grow the shop", level: "meso", levelName: "Meso", color: "#34D399", from: "2026-11-01", to: "2026-11-30", notes: null, done: false, createdAt: undefined });
  const saved = goalsOf(s).find((g) => g.id === "goal-big")!;
  assert.equal(saved.extra, "kept", "fields this build does not know stay");
  assert.equal(saved.note, null);
  assert.equal(goalsOf(s).length, 3);
  assert.equal(goalsOf(s)[1].title, "Finish the redesign", "the others untouched");
  const d = await call(s, "PATCH", "/v1/goals/goal-big", { done: true }, { ...G, done: true });
  assert.equal(d.body.goal.done, true, "done alone needs only Tick done");
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", { to: "2026-10-01" }, E)).body.error.field, "to", "to before the goal's from");
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", { title: "" }, E)).body.error.field, "title", "a goal keeps a name");
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", {}, E)).status, 400);
  assert.equal((await call(s, "PATCH", "/v1/goals/goal-big", { id: "other" }, E)).body.error.code, "unknown_field", "the id never changes");
  assert.equal((await call(s, "PATCH", "/v1/goals/missing", { title: "x" }, E)).status, 404);
});
ok("goals: DELETE needs its switch and removes only that goal", async () => {
  const s = goalWorld();
  assert.equal((await call(s, "DELETE", "/v1/goals/goal-week", undefined, G)).body.error.scope, "delete");
  assert.equal(goalsOf(s).length, 3);
  const r = await call(s, "DELETE", "/v1/goals/goal-week", undefined, { ...G, delete: true });
  assert.deepEqual(r.body, { deleted: "goal-week" });
  assert.deepEqual(goalsOf(s).map((g) => g.id), ["goal-big", "goal-month"]);
  assert.equal((await call(s, "DELETE", "/v1/goals/goal-week", undefined, { ...G, delete: true })).status, 404, "gone");
  assert.equal((await call(s, "DELETE", "/v1/tasks/goal-big", undefined, ALL)).status, 404, "a goal is never a task");
});
ok("goals: the task switches alone never reach goals, and the goals switch alone never reaches tasks", async () => {
  const s = goalWorld();
  assert.equal((await call(s, "GET", "/v1/goals", undefined, { ...ALL, goals: false })).body.error.scope, "goals");
  const onlyGoals = { ...cleanScopes({}), inbox: false, goals: true };
  assert.equal((await call(s, "GET", "/v1/tasks", undefined, onlyGoals)).status, 403);
  assert.equal((await call(s, "GET", "/v1/goals", undefined, onlyGoals)).status, 200);
});
ok("goals: Copy for AI explains the switch, the goal object and every endpoint with an example", () => {
  const g = aiGuide({ scopes: DEFAULT_SCOPES, today: T });
  assert.ok(g.includes("- goals: OFF."));
  assert.ok(aiGuide({ scopes: { ...DEFAULT_SCOPES, goals: true }, today: T }).includes("- goals: ON."));
  for (const e of ["### GET /v1/goals", "### POST /v1/goals", "### PATCH /v1/goals/{id}", "### DELETE /v1/goals/{id}", "curl -s -X POST http://127.0.0.1:47836/v1/goals", "\"levelName\": \"Macro\""]) assert.ok(g.includes(e), e);
  assert.ok(!/[\u2013\u2014]/.test(g), "no en or em dashes");
});

ok("Connect your AI: a short rule with the key slot (never a key), the curl, the chat id, where to save it, no dashes", () => {
  const c = aiConnect({});
  assert.equal(c.split(KEY_SLOT).length - 1, 1, "the key slot once, in the curl");
  assert.ok(!/ps_[A-Za-z0-9]{20,}/.test(c), "never a key");
  assert.ok(c.includes("http://127.0.0.1:47836/v1/island/message"));
  assert.ok(c.includes(`Authorization: Bearer ${KEY_SLOT}`));
  assert.ok(c.includes("CLAUDE_CODE_SESSION_ID") && c.includes("CODEX_THREAD_ID") && c.includes("__CHAT__"), "the chat id for Claude Code and Codex");
  assert.ok(c.includes("~/.claude/CLAUDE.md") && c.includes("~/.codex/AGENTS.md"), "where to save it");
  assert.ok(c.includes("never put it in a project file that goes into git"), "keep the key out of git");
  assert.ok(c.includes("cat <<'PSMSG'"), "a quoted here document: the words stay as typed");
  assert.ok(c.length < 2500, "short");
  assert.ok(!/[\u2013\u2014]/.test(c), "no en or em dashes");
  assert.ok(!/\bRed\b|Cincee/.test(c), "nothing personal");
  assert.ok(aiConnect({ port: 5000 }).includes("http://127.0.0.1:5000/v1/island/message"));
});

// ---------- PS 1.74: the AI coach (focus, Mark done on messages, the reset and Day ends settings) ----------
const FOCUS = { ...DEFAULT_SCOPES, focus: true };
ok("focus: its own switch, off by default; GET and PUT refuse with scope_off and nothing changes", async () => {
  const s = world();
  assert.equal(DEFAULT_SCOPES.focus, false);
  assert.ok(SCOPES.some((x) => x.id === "focus" && x.group === "what" && x.def === false));
  for (const [m, b] of [["GET", undefined], ["PUT", { task: "a1" }], ["PUT", { task: null }]] as const) {
    const r = await call(s, m, "/v1/focus", b, ALL_BUT("focus"));
    assert.deepEqual([r.status, r.body.error.code, r.body.error.scope], [403, "scope_off", "focus"], m);
  }
  assert.ok(!s.log.some((x) => x.startsWith("focus")));
  const list = (await call(s, "GET", "/v1")).body.endpoints;
  assert.ok(list.includes("GET /v1/focus") && list.includes("PUT /v1/focus"));
});
ok("GET /v1/focus: the open working tasks in order, the first is the island's; none is null; read needed", async () => {
  const s = fake({ settings: { ...SETTINGS, workingIds: ["ai1", "gone", "a2"] }, todos: [d("a1", 0), d("a2", 1), d("ai1", 5, { ai: true, aiInbox: true, title: "Inbox one" }), d("dn", 2, { done: true })] });
  const all = { ...ALL, focus: true };
  const r = await call(s, "GET", "/v1/focus", undefined, all);
  assert.equal(r.status, 200);
  assert.equal(r.body.focus.task.id, "ai1");
  assert.deepEqual(r.body.focus.tasks.map((t: { id: string }) => t.id), ["ai1", "a2"]);
  assert.equal(r.body.focus.hidden, 0);
  // Only the AI Inbox reachable: the list task is counted, never shown.
  const r2 = await call(s, "GET", "/v1/focus", undefined, FOCUS);
  assert.deepEqual([r2.body.focus.task.id, r2.body.focus.tasks.length, r2.body.focus.hidden], ["ai1", 1, 1]);
  assert.deepEqual((await call(s, "GET", "/v1/focus", undefined, { ...FOCUS, read: false })).body.error.scope, "read");
  // Older data: workingOn alone. A done working task is not shown (the island does not show it either).
  const old = fake({ settings: { workingOn: "a1" }, todos: [d("a1", 0)] });
  assert.equal((await call(old, "GET", "/v1/focus", undefined, all)).body.focus.task.id, "a1");
  const done = fake({ settings: { workingIds: ["dn"] }, todos: [d("dn", 0, { done: true })] });
  assert.deepEqual((await call(done, "GET", "/v1/focus", undefined, all)).body.focus, { task: null, tasks: [], hidden: 0 });
  assert.deepEqual((await call(fake(), "GET", "/v1/focus", undefined, all)).body.focus, { task: null, tasks: [], hidden: 0 });
  assert.equal((await call(fake({ locked: true }), "GET", "/v1/focus", undefined, all)).status, 423);
});
ok("PUT /v1/focus: sets one task (only that one), null clears; reach, done and bad ids are refused untouched", async () => {
  const s = fake({ settings: { ...SETTINGS, workingIds: ["a2"] }, todos: [d("a1", 0), d("a2", 1), d("ai1", 5, { ai: true, aiInbox: true }), d("dn", 2, { done: true })] });
  const r = await call(s, "PUT", "/v1/focus", { task: "ai1" }, FOCUS);
  assert.equal(r.status, 200);
  assert.equal(r.body.focus.task.id, "ai1");
  // a2 is on a list this AI cannot reach: it stays working (its clock is not stopped), after the AI's task.
  assert.deepEqual(s.set().workingIds, ["ai1", "a2"]);
  assert.equal(s.set().workingOn, "ai1");
  assert.equal(r.body.focus.hidden, 1);
  // A list task with only the AI Inbox switch: scope_off lists, nothing changes.
  const off = await call(s, "PUT", "/v1/focus", { task: "a1" }, FOCUS);
  assert.deepEqual([off.status, off.body.error.scope], [403, "lists"]);
  assert.deepEqual(s.set().workingIds, ["ai1", "a2"]);
  const lists = { ...FOCUS, lists: true };
  assert.equal((await call(s, "PUT", "/v1/focus", { task: "a1" }, lists)).body.focus.task.id, "a1");
  assert.deepEqual(s.set().workingIds, ["a1"]);
  for (const [b, st, code] of [[{ task: "dn" }, 409, "task_done"], [{ task: "nope" }, 404, "not_found"], [{ task: "bad id!" }, 400, "bad_field"], [{ task: 5 }, 400, "bad_field"],
    [{}, 400, "bad_field"], [{ task: "a1", also: 1 }, 400, "unknown_field"], [null, 400, "bad_request"], ["a1", 400, "bad_request"]] as const) {
    const x = await call(s, "PUT", "/v1/focus", b, lists);
    assert.deepEqual([x.status, x.body.error.code], [st, code], JSON.stringify(b));
  }
  assert.deepEqual(s.set().workingIds, ["a1"]);
  const clear = await call(s, "PUT", "/v1/focus", { task: null }, lists);
  assert.deepEqual([clear.status, clear.body.focus], [200, { task: null, tasks: [], hidden: 0 }]);
  assert.deepEqual(s.set().workingIds, []);
  for (const m of ["POST", "PATCH", "DELETE"]) assert.equal((await call(s, m, "/v1/focus", { task: "a1" }, lists)).status, 405, m);
  assert.equal((await call(s, "PUT", "/v1/focus/a1", { task: "a1" }, lists)).status, 404);
  assert.deepEqual(s.log.filter((x) => x.startsWith("focus")), ["focus ai1,a2", "focus a1", "focus none"]);
});
ok("PUT /v1/focus never touches working tasks outside the AI's reach (break-it 1.74): null keeps them, a set keeps them after", async () => {
  const s = fake({ settings: { ...SETTINGS, workingIds: ["a2", "ai1"], workingOn: "a2" }, todos: [d("a2", 1, { title: "Private list task" }), d("ai1", 5, { ai: true, aiInbox: true }), d("ai2", 6, { ai: true, aiInbox: true })] });
  const clear = await call(s, "PUT", "/v1/focus", { task: null }, FOCUS);
  assert.deepEqual([clear.status, clear.body.focus], [200, { task: null, tasks: [], hidden: 1 }]);
  assert.deepEqual(s.set().workingIds, ["a2"]);
  assert.ok(!JSON.stringify(clear.body).includes("Private"), "a hidden task's title never shows");
  await call(s, "PUT", "/v1/focus", { task: "ai2" }, FOCUS);
  assert.deepEqual(s.set().workingIds, ["ai2", "a2"]);
  // With every list in reach, the same PUT replaces them all, as a click would.
  await call(s, "PUT", "/v1/focus", { task: "ai1" }, { ...FOCUS, lists: true });
  assert.deepEqual(s.set().workingIds, ["ai1"]);
  // Without the read switch PUT still works, and names the task by id only.
  const r = await call(s, "PUT", "/v1/focus", { task: "ai2" }, { ...FOCUS, read: false });
  assert.deepEqual([r.status, r.body.focus.task], [200, { id: "ai2" }]);
});

const MSG_DONE = { ...DEFAULT_SCOPES, message: true, done: true };
ok("message with a task: kept and markDone only with the done switch on and an open task it can reach", async () => {
  const s = world();
  const r = await call(s, "POST", "/v1/island/message", { from: "Coach", text: "Time for the inbox task", task: "ai1" }, MSG_DONE);
  assert.deepEqual([r.status, r.body.shown, r.body.markDone, r.body.note], [201, true, true, undefined]);
  assert.equal(msgs(s)[0].task as unknown, "ai1");
  // Each reason the button is left off: the message is still shown, the task is not kept, the AI is told why.
  const t = fake({ settings: SETTINGS, todos: [d("a1", 0), d("ai1", 5, { aiInbox: true }), d("ai2", 6, { aiInbox: true, done: true })] });
  for (const [task, sc, why] of [["ai1", MSG, /Tick tasks done/], ["zzz", MSG_DONE, /No task with that id/], ["a1", MSG_DONE, /All lists and pages/], ["ai2", MSG_DONE, /already done/]] as const) {
    const x = await call(t, "POST", "/v1/island/message", { text: `About ${task}`, task }, sc);
    assert.deepEqual([x.status, x.body.shown, x.body.markDone], [201, true, false], task);
    assert.match(x.body.note, why, task);
    assert.equal((msgs(t)[0] as { task?: string }).task, undefined, task);
  }
  // No task: the answer is exactly as before 1.74.
  const plain = await call(world(), "POST", "/v1/island/message", { text: "Done" }, MSG_DONE);
  assert.deepEqual(Object.keys(plain.body).sort(), ["message", "shown"]);
});
ok("message with a task: a bad id is refused (400 task); a retry with the same task is the same message, another task is not", async () => {
  const s = world();
  for (const task of [5, true, "bad id", "x".repeat(65), ["ai1"]]) {
    const r = await call(s, "POST", "/v1/island/message", { text: "a", task }, MSG_DONE);
    assert.deepEqual([r.status, r.body.error.field], [400, "task"], JSON.stringify(task));
  }
  assert.equal((await call(s, "POST", "/v1/island/message", { text: "a", task: null }, MSG_DONE)).status, 201);
  const a = await call(s, "POST", "/v1/island/message", { text: "Same", task: "ai1" }, MSG_DONE);
  const b = await call(s, "POST", "/v1/island/message", { text: "Same", task: "ai1" }, MSG_DONE);
  assert.deepEqual([a.status, b.status, b.body.message.id, b.body.markDone], [201, 200, a.body.message.id, true]);
  const c = await call(s, "POST", "/v1/island/message", { text: "Same", task: "a1" }, { ...MSG_DONE, lists: true });
  assert.equal(c.status, 201);
  assert.notEqual(c.body.message.id, a.body.message.id);
  // Break-it 1.74: the done switch turned off between two identical sends is still the same message (no second card).
  const d2 = await call(s, "POST", "/v1/island/message", { text: "Same", task: "ai1" }, MSG);
  assert.deepEqual([d2.status, d2.body.message.id, d2.body.markDone], [200, a.body.message.id, false]);
  assert.match(d2.body.note, /already sent a moment ago\. The "Tick tasks done" switch is off/);
  // Dismissed by the person, then the same message again: not shown, no button, and said so.
  const st = s.set() as { aiMsgs: { id: string; seen?: boolean }[] };
  await s.saveSettings({ aiMsgs: st.aiMsgs.map((m) => (m.id === a.body.message.id ? { ...m, seen: true } : m)) } as never);
  const d3 = await call(s, "POST", "/v1/island/message", { text: "Same", task: "ai1" }, MSG_DONE);
  assert.deepEqual([d3.status, d3.body.shown, d3.body.markDone], [200, false, false]);
  assert.match(d3.body.note, /dismissed it/);
});
ok("focus: a task listed twice as working counts once and is kept once (break-it 1.74)", async () => {
  const s = fake({ settings: { ...SETTINGS, workingIds: ["a2", "a2"], workingOn: "a2" }, todos: [d("a2", 1), d("ai1", 5, { ai: true, aiInbox: true })] });
  assert.equal((await call(s, "GET", "/v1/focus", undefined, FOCUS)).body.focus.hidden, 1);
  const r = await call(s, "PUT", "/v1/focus", { task: "ai1" }, FOCUS);
  assert.equal(r.body.focus.hidden, 1);
  assert.deepEqual(s.set().workingIds, ["ai1", "a2"]);
});

const SET = { ...DEFAULT_SCOPES, settings: true };
ok("settings 1.74: autoReset, autoResetAt and dayEnds read as Settings shows them", async () => {
  const g = async (st: Data, red = false) => { const s = fake({ settings: st }); if (red) s.red = () => true; return (await call(s, "GET", "/v1/settings", undefined, SET)).body.settings; };
  assert.deepEqual(await g({}), { invertSwipe: false, autoReset: false, autoResetAt: "00:00", dayEnds: "reset" });
  assert.deepEqual(await g({ autoReset: "midnight", autoResetAt: "04:30", countdown: { mode: "daily", at: "23:00" } }), { invertSwipe: false, autoReset: true, autoResetAt: "04:30", dayEnds: "23:00" });
  assert.equal((await g({ countdown: { mode: "week", days: ["", "", "", "", "", "", ""] } })).dayEnds, "week");
  assert.equal((await g({ autoResetAt: "25:00" })).autoResetAt, "00:00", "an unreadable time is midnight, as Settings reads it");
  assert.equal((await g({ countdown: { at: "18:00" } })).dayEnds, "18:00", "a time saved before 1.72 is Every day at");
  assert.equal((await g({}, true)).dayEnds, "12:00", "the developer's account keeps its noon (daycount.ts modeOf)");
});
ok("settings 1.74: PATCH saves each as Settings does; dayEnds a time or reset", async () => {
  const s = fake({ settings: { countdown: { font: "mono" } } });
  const r = await call(s, "PATCH", "/v1/settings", { autoReset: true, autoResetAt: "05:00", dayEnds: "23:30" }, SET);
  assert.deepEqual([r.status, r.body.settings], [200, { invertSwipe: false, autoReset: true, autoResetAt: "05:00", dayEnds: "23:30" }]);
  assert.equal(s.set().autoReset, "midnight");
  assert.equal(s.set().autoResetAt, "05:00");
  assert.deepEqual(s.set().countdown, { mode: "daily", at: "23:30", font: "mono" }, "the countdown's other picks stay");
  const back = await call(s, "PATCH", "/v1/settings", { dayEnds: "reset", autoReset: false }, SET);
  assert.deepEqual([back.body.settings.dayEnds, back.body.settings.autoReset, s.set().autoReset], ["reset", false, "off"]);
  assert.equal((s.set().countdown as Data).mode, "reset");
  assert.equal((s.set().countdown as Data).font, "mono");
  assert.equal((await call(s, "PATCH", "/v1/settings", { dayEnds: "00:00" }, SET)).body.settings.dayEnds, "00:00");
});
ok("settings 1.74: bad values are refused and nothing at all is saved", async () => {
  const s = fake({ settings: { autoReset: "off", autoResetAt: "03:00" } });
  for (const [b, field] of [[{ autoReset: "on" }, "autoReset"], [{ autoReset: 1 }, "autoReset"], [{ autoResetAt: "24:00" }, "autoResetAt"], [{ autoResetAt: "4:00" }, "autoResetAt"],
    [{ autoResetAt: 400 }, "autoResetAt"], [{ autoResetAt: null }, "autoResetAt"], [{ dayEnds: "week" }, "dayEnds"], [{ dayEnds: "noon" }, "dayEnds"], [{ dayEnds: null }, "dayEnds"],
    [{ autoReset: true, autoResetAt: "99:99" }, "autoResetAt"], [{ invertSwipe: true, dayEnds: "7pm" }, "dayEnds"]] as const) {
    const r = await call(s, "PATCH", "/v1/settings", b, SET);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.field], [400, "bad_field", field], JSON.stringify(b));
  }
  assert.match((await call(s, "PATCH", "/v1/settings", { dayEnds: "week" }, SET)).body.error.message, /Countdown text/);
  for (const k of ["lastResetDay", "dayEndsHour", "countdown"]) assert.equal((await call(s, "PATCH", "/v1/settings", { [k]: 1 }, SET)).body.error.code, "unknown_field", k);
  assert.ok(!s.log.some((x) => x.startsWith("settings")));
  assert.deepEqual([s.set().autoReset, s.set().autoResetAt], ["off", "03:00"]);
  assert.equal((await call(s, "PATCH", "/v1/settings", { autoReset: true }, DEFAULT_SCOPES)).body.error.scope, "settings");
});
ok("Copy for AI 1.74: focus, a message's task and the new settings are explained, with the switch", () => {
  const g = aiGuide({ scopes: DEFAULT_SCOPES, today: T });
  assert.ok(g.includes("- focus: OFF.") && aiGuide({ scopes: { ...DEFAULT_SCOPES, focus: true }, today: T }).includes("- focus: ON."));
  for (const e of ["### GET /v1/focus  and  PUT /v1/focus", "curl -s -X PUT http://127.0.0.1:47836/v1/focus", "{\"task\": null}", "\"markDone\": true",
    "autoResetAt", "\"dayEnds\"", "task_done"]) assert.ok(g.includes(e), e);
  assert.ok(!/[–—]/.test(g), "no en or em dashes");
});

// Break-it 1.74 round 1: Red's 1.74 Clients tasks (core/clientwork.ts) as the API shows them.
ok("Clients 1.74: a client task waiting for its do date says so, is not counted in the list, and cannot be the working task", async () => {
  const s = fake({ todos: [d("cw1", 0, { clientId: "cl1", doOn: "2026-11-14" }), d("cl2", 1, { clientId: "cl1", doOn: "2026-11-12" }), d("pl3", 2)], settings: SETTINGS });
  (s as ApiStore).land = () => T;
  const all = (await call(s, "GET", "/v1/tasks", undefined, ALL)).body.tasks;
  const by = (id: string) => all.find((t: { id: string }) => t.id === id);
  assert.equal(by("cw1").waitsUntil, "2026-11-14");
  assert.equal(by("cl2").waitsUntil, null);
  assert.equal(by("pl3").waitsUntil, null);
  const main = (await call(s, "GET", "/v1/lists", undefined, ALL)).body.lists.find((l: { id: string }) => l.id === "main");
  assert.equal(main.sections.find((x: { key: string }) => x.key === "prio").openTasks, 2, "as the Tab list shows it: the waiting one is not there yet");
  const r = await call(s, "PUT", "/v1/focus", { task: "cw1" }, ALL);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "not_landed");
  assert.ok(!s.log.some((x) => x.startsWith("focus")), "nothing saved");
  assert.equal((await call(s, "PUT", "/v1/focus", { task: "cl2" }, ALL)).status, 200);
  // A store without the person's day (older callers): as before, nothing waits.
  const o = fake({ todos: [d("cw1", 0, { clientId: "cl1", doOn: "2026-11-14" })], settings: SETTINGS });
  assert.equal((await call(o, "GET", "/v1/tasks/cw1", undefined, ALL)).body.task.waitsUntil, null);
});
ok("Clients 1.74: a repeating client task with P1 is shown in Priority 1, as the Tab list shows it", async () => {
  const s = fake({ todos: [d("rp1", 0, { type: "daily", p1: true, clientId: "cl1" }), d("rd2", 1, { type: "daily", p1: true })], settings: SETTINGS });
  const t1 = (await call(s, "GET", "/v1/tasks/rp1", undefined, ALL)).body.task;
  assert.equal(t1.section, "p1");
  assert.equal(t1.p1, true);
  assert.equal(t1.kind, "daily");
  const t2 = (await call(s, "GET", "/v1/tasks/rd2", undefined, ALL)).body.task;
  assert.equal(t2.section, "daily", "not a client task: a stray P1 flag on a daily task stays in Every day, as in the Tab list");
  assert.equal(t2.p1, false);
  const p1 = (await call(s, "GET", "/v1/tasks", undefined, ALL, { section: "p1" })).body.tasks.map((t: { id: string }) => t.id);
  assert.deepEqual(p1, ["rp1"]);
});
// Break-it 1.74 round 2: a repeating client task in Priority 1, moved and counted through the API.
ok("Clients 1.74: moving a repeating client P1 task to Every day takes its P1 off, so it really moves", async () => {
  const s = fake({ todos: [d("rp1", 0, { type: "daily", p1: true, clientId: "cl1" })], settings: SETTINGS });
  const r = await call(s, "PATCH", "/v1/tasks/rp1", { section: "daily" }, ALL);
  assert.equal(r.status, 200);
  assert.equal(r.body.task.section, "daily", "the answer says where it is now");
  assert.equal(s.docs.get("rp1")!.data.p1, false, "saved: out of Priority 1");
  assert.equal(s.docs.get("rp1")!.data.type, "daily", "still repeating");
  // Already in p1: sending p1 true again is no error and changes nothing that matters.
  const s2 = fake({ todos: [d("rp2", 0, { type: "daily", p1: true, clientId: "cl1" })], settings: SETTINGS });
  const r2 = await call(s2, "PATCH", "/v1/tasks/rp2", { p1: true }, ALL);
  assert.equal(r2.status, 200, "p1 true on a task that reads p1 true");
  assert.equal(r2.body.task.section, "p1");
  // A non-client daily task still cannot get P1, and a client daily without P1 is not given it (the Clients screen does that).
  const s3 = fake({ todos: [d("rd3", 0, { type: "daily" }), d("rd4", 1, { type: "daily", clientId: "cl1" })], settings: SETTINGS });
  assert.equal((await call(s3, "PATCH", "/v1/tasks/rd3", { p1: true }, ALL)).status, 400);
  assert.equal((await call(s3, "PATCH", "/v1/tasks/rd4", { p1: true }, ALL)).status, 400);
});
ok("Clients 1.74: GET /v1/lists counts open P1 tasks as GET /v1/tasks?section=p1 does (a ticked repeating one is not open)", async () => {
  const s = fake({ todos: [d("rp1", 0, { type: "daily", p1: true, clientId: "cl1", done: true }), d("rp2", 1, { type: "daily", p1: true, clientId: "cl1" }), d("o3", 2, { p1: true })], settings: SETTINGS });
  const main = (await call(s, "GET", "/v1/lists", undefined, ALL)).body.lists.find((l: { id: string }) => l.id === "main");
  const open = (await call(s, "GET", "/v1/tasks", undefined, ALL, { section: "p1" })).body.tasks.map((t: { id: string }) => t.id);
  assert.deepEqual(open.sort(), ["o3", "rp2"]);
  assert.equal(main.sections.find((x: { key: string }) => x.key === "p1").openTasks, open.length);
});
ok("Copy for AI 1.74: waitsUntil, not_landed and what dayEnds also moves are explained", () => {
  const g = aiGuide({ scopes: { ...DEFAULT_SCOPES, focus: true, settings: true }, today: T });
  for (const e of ["\"waitsUntil\"", "409 not_landed", "day turns over for client tasks"]) assert.ok(g.includes(e), e);
  assert.ok(!/[\u2013\u2014]/.test(g), "no en or em dashes");
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok -", name); }
console.log(`${n} passed`);
