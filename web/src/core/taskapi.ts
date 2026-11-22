// The Task API (the developer's friend: "api so that my claude code can add tasks into the ps app"; the developer: "make the API have a
// dedicated tab in settings and set up the scope with everything changeable via API").
//
// How it runs: PS on the Mac (ps-mac TaskApi.swift) listens on 127.0.0.1 only, while PS is open. It checks the key,
// the Host and that no browser sent the request, keeps a rate limit, then hands the request to the main page as
// {type:"api:req"} with this Mac's switches. The main page (src/taskapi.ts) runs handleApi below against the open
// vault, through the same actions the Tab list uses, and answers {type:"api:res"}. The vault stays end to end
// encrypted: the request never leaves this Mac and nothing new is sent to a server in the clear.
//
// This file is the rules: the switches (scopes), every endpoint, what it checks, what it answers. Pure: the vault is
// behind the ApiStore interface, so the unit tests (tests/taskapi.test.ts) run every endpoint against a fake one.
// Never log a task's text (the shell logs the method, the path and the status only).
import type { Doc, Goal, Settings, Todo } from "./model";
import { GROUP_NAME_MAX, cleanGroups, groupKey, groupOf, tabLists, type TabLists } from "./groups.ts";
import { DEFAULT_NAMES, LIST_NAME_MAX, MAIN, SEC_NAME_MAX, allPages, cleanNames, listMoveTarget, pageOfSec, pageOrder, renamePage, shownName, tidyName } from "./lists.ts";
import { INBOX, INBOX_MAX, INBOX_NAME, inInbox, intoSection, listsCtx, sectionTakes } from "./aiinbox.ts";
import { API_GYM_FIELDS, API_GYM_YES, API_NO_YES, apiGym, apiGymPatch, gymPrefs } from "./gym.ts";
import { AI_MSG, AI_MSG_FIELDS, addAiMsg, aiMsgWait, aiNotesMode, checkAiMsg, newAiMsgId, sameAiMsg } from "./aimessage.ts";
import { GOALS_MAX, GOAL_COLORS, GOAL_NOTE_MAX, GOAL_TITLE_MAX, endFor, goalLevel, levelName, nextGoalColor } from "./goals.ts";
import { okResetAt, resetAtOf } from "./resetday.ts";
import { cdPatch, cleanCd, okHm, type CdPrefs } from "./daycount.ts";
import { isClientTask, landsOn } from "./clientwork.ts";
import { scheduledOn } from "./scheduled.ts";
const isISODay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
import { REM_TEXT_MAX, okTz, addTaskReminder, freshId, minutesOf, newTaskReminder, oneLine, patchReminder, reminderOfTask, remindOrDefault, removeReminder, type RemindRec } from "./remind.ts";

export const API_PORT = 47836;
export const API_VERSION = 1;
export const BATCH_MAX = 50;
export const TITLE_MAX = 500, NOTES_MAX = 2000;
export const LIST_LIMIT_DEF = 200, LIST_LIMIT_MAX = 500;

// ---------- the switches ----------
export type ScopeId = "inbox" | "lists" | "goals" | "rename" | "read" | "add" | "edit" | "done" | "delete" | "remind" | "focus" | "sentry" | "gym" | "settings" | "message";
export interface ScopeDef { id: ScopeId; group: "where" | "what"; label: string; line: string; def: boolean }
/** One switch per thing an AI may do (Settings, AI task API). Off unless switched on, except add, read and the inbox. */
export const SCOPES: ScopeDef[] = [
  { id: "inbox", group: "where", label: "AI Inbox", line: "Tasks in the AI Inbox, its own section in Dimension X.", def: true },
  { id: "lists", group: "where", label: "All lists and pages", line: "Every list, page and section you have, not just the AI Inbox.", def: false },
  // PS 1.72 (Jan, 21 Nov 2026: "make sure that you can edit this with API as well, add and delete"). Off unless switched
  // on; Read, Add, Edit, Tick done and Delete below then say what it may do there, as they do for tasks.
  { id: "goals", group: "where", label: "Goals timeline", line: "Your goals on the Timeline. The What switches below say what it may do there.", def: false },
  { id: "rename", group: "where", label: "Rename lists and sections", line: "Change the names of your lists and sections.", def: false },
  { id: "read", group: "what", label: "Read tasks", line: "See tasks, lists and sections it can reach.", def: true },
  { id: "add", group: "what", label: "Add tasks", line: "Add new tasks (into the AI Inbox unless All lists is on).", def: true },
  { id: "edit", group: "what", label: "Edit and move tasks", line: "Change a task's name, notes, date or priority, or move it.", def: false },
  { id: "done", group: "what", label: "Tick tasks done", line: "Tick a task done or open it again.", def: false },
  { id: "delete", group: "what", label: "Delete tasks", line: "Delete tasks for good.", def: false },
  { id: "remind", group: "what", label: "Set reminders", line: "Put a reminder on a task, change it or take it off.", def: false },
  // PS 1.74 (Jan, 21 Nov 2026, for his AI coach: "read and set the working on task"). Its own switch, like Sentry mode and the gym:
  // it changes what the island shows and starts the task's clock, which is neither editing a task nor ticking it.
  { id: "focus", group: "what", label: "Working on", line: "See and set the task you are working on, the one the island shows.", def: false },
  // The developer, 13 Nov 2026: "tell Claude Code to deploy Sentry Mode and it will get the PS app to deploy Sentry mode too". Start only.
  { id: "sentry", group: "what", label: "Start Sentry mode", line: "Lock this Mac and keep it awake for AI jobs. An AI can never turn it off.", def: false },
  // The developer, 13 Nov 2026 (V1.57): "a new switch "gym" ... (off by default) ... The API can never answer Yes for me."
  { id: "gym", group: "what", label: "Gym reminder", line: "Read and change your gym reminder times. An AI can never say Yes for you.", def: false },
  // The developer, 13 Nov 2026 (V1.57): Invert swipe "accessible via the API as well, so you can just tell your Claude to do it".
  // PS 1.74: also the automatic Reset (on or off, its time) and the countdown's Day ends (Jan, 21 Nov 2026).
  { id: "settings", group: "what", label: "Change settings", line: "Read and change the settings listed for AI: Invert swipe, the automatic Reset and its time, and Day ends.", def: false },
  // V1.58 (the developer, 13 Nov 2026: "I want the AI to write to me at the end of each chat instead of the AI completion cards").
  { id: "message", group: "what", label: "Send you messages", line: "Pop a short message up on the Dynamic Island, like what it finished. Words only.", def: false },
];
export type Scopes = Record<ScopeId, boolean>;
export const DEFAULT_SCOPES: Scopes = Object.fromEntries(SCOPES.map((s) => [s.id, s.def])) as Scopes;
export const scopeLabel = (id: ScopeId) => SCOPES.find((s) => s.id === id)?.label ?? id;
/** Known switches only; a missing one takes its default. */
export function cleanScopes(v: unknown): Scopes {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SCOPES };
  for (const s of SCOPES) if (typeof o[s.id] === "boolean") out[s.id] = o[s.id] as boolean;
  return out;
}

// ---------- the request, the answer and the vault ----------
export interface ApiReq { method: string; path: string; query?: Record<string, string>; body?: unknown }
export interface ApiRes { status: number; body: unknown }
/** What the endpoints need from the vault (src/taskapi.ts gives the real one). */
export interface ApiStore {
  /** ok: the vault is open. locked: PS is open but signed out or locked. */
  state(): "ok" | "locked";
  todos(): Doc<Todo>[];               // every task not cleared by a reset
  settings(): Partial<Settings>;
  remind(): RemindRec | null;
  today(): string;                    // YYYY-MM-DD in the user's day
  /** Clients (PS 1.73): the person's day by their day end (clients/clientsday.ts landDayNow), the day client tasks land on.
   *  Missing: nothing waits, as before 1.74. */
  land?(): string;
  now(): number;
  deviceTz(): string;
  red(): boolean;
  version(): string;
  add(t: Partial<Todo> & { title: string }): Promise<string>;
  update(id: string, patch: Partial<Todo>): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  saveRemind(change: (rec: RemindRec | null) => RemindRec | null): Promise<void>;
  newGroupId(): string;
  /** PS 1.74: the tasks being worked on, in order (the first is the island's), as clicks on tasks make them: clocks start
   *  for the new ones and stop for the ones taken off. core/taskapi.ts keeps the ones outside the AI's reach in the list. */
  setFocus(ids: string[]): Promise<void>;
  /** Sentry mode, started exactly as the AI button starts it (views/Sentry.tsx startSentryForApi). There is no stop. */
  startSentry(): Promise<SentryStartResult>;
}
/** What starting Sentry mode came to (the same shape as views/Sentry.tsx SentryStart). */
export type SentryStartResult = { result: "engaged" | "already"; phase: "covered" | "locked" } | { result: "blocked"; title: string; lines: string[] }
  | { result: "refused"; note: string } | { result: "notStarted" } | { result: "noAnswer" } | { result: "unavailable" };

export type ErrCode = "bad_request" | "bad_field" | "unknown_field" | "not_found" | "method_not_allowed" | "scope_off" | "locked"
  | "wrong_section" | "not_a_task_list" | "inbox_full" | "too_many" | "internal" | "sentry_checks" | "sentry_refused" | "not_ready" | "rate_limited" | "task_done" | "not_landed";
export const fail = (status: number, code: ErrCode, message: string, extra: Record<string, unknown> = {}): ApiRes =>
  ({ status, body: { error: { code, message, ...extra } } });
const ok = (body: unknown, status = 200): ApiRes => ({ status, body });
const scopeOff = (id: ScopeId): ApiRes => fail(403, "scope_off", `The "${scopeLabel(id)}" switch is off in PS (Settings, AI task API). Ask the person to switch it on if they want this.`, { scope: id });

// ---------- the task as the API shows it ----------
export interface ApiTask {
  id: string; title: string; notes: string | null; kind: "once" | "daily"; done: boolean; doneAt: string | null; due: string | null;
  p1: boolean; list: string; listName: string; section: string; sectionName: string; addedByAi: boolean; inInbox: boolean;
  createdAt: string | null; subtasks: { title: string; done: boolean }[];
  /** Clients (PS 1.73): the do date of a task that waits out of the list until then (core/clientwork.ts waitsToLand), else null.
   *  PS 1.75: also the day a scheduled task lands on (core/scheduled.ts), with `scheduled` true. */
  waitsUntil: string | null;
  /** PS 1.75: scheduled for a later day (its `due`), so not in any list and not a task to work on yet. Only while the
   *  "scheduled-tasks" switch is on (off: the task looks as in 1.74). */
  scheduled?: boolean;
  reminder: { date: string | null; time: string; until: string; on: boolean; message: string | null } | null;
}
type Ctx = ReturnType<typeof makeCtx>;
function makeCtx(store: ApiStore) {
  const st = store.settings();
  const { groups, pages, full, byPage } = listsCtx(st);
  const names = cleanNames(st.tmNames);
  const order = pageOrder(st.tmPageOrder, pages);
  const all = store.todos();
  // As the Tab list shows it on the person's day (break-it 1.74): a client task waiting for its do date is not in it yet.
  const land = store.land?.();
  const lists = tabLists(all, groups, store.today(), undefined, land);
  const known = new Set(groups.map((g) => g.id));
  return { st, groups, pages, full, byPage, names, order, all, lists, known, land, rem: store.remind() };
}
const secName = (c: Ctx, key: string): string => {
  if (key === INBOX) return INBOX_NAME;
  const g = groupOf(key);
  if (g) return c.groups.find((x) => x.id === g)?.name ?? "Group";
  return shownName(c.names, key as "p1" | "prio" | "daily");
};
const listName = (c: Ctx, id: string): string => (id === INBOX ? INBOX_NAME : allPages(c.pages, c.names, c.order).find((p) => p.id === id)?.name ?? "List");
/** The section a task shows in (inbox: the AI Inbox). */
export function sectionOf(t: Todo, known: Set<string>): string {
  if (inInbox(t)) return INBOX;
  if (t.group && known.has(t.group)) return groupKey(t.group);
  // Clients (PS 1.73, core/groups.ts tabLists): a repeating client task with P1 on lands in Priority 1 on its days.
  if (t.type === "daily") return t.p1 === true && isClientTask(t) ? "p1" : "daily";
  return t.p1 ? "p1" : "prio";
}
function view(d: Doc<Todo>, c: Ctx): ApiTask {
  const t = d.data;
  const section = sectionOf(t, c.known);
  const list = section === INBOX ? INBOX : pageOfSec(c.pages, section);
  const r = reminderOfTask(c.rem, d.id);
  return {
    id: d.id, title: t.title, notes: t.notes ?? null, kind: t.type === "daily" ? "daily" : "once", done: !!t.done, doneAt: t.doneAt ?? null,
    due: t.due ?? null, p1: t.type !== "daily" ? !!t.p1 : section === "p1", list, listName: listName(c, list), section, sectionName: secName(c, section),
    addedByAi: t.ai === true, inInbox: inInbox(t), createdAt: t.createdAt ?? null,
    subtasks: (t.subtasks ?? []).map((s) => ({ title: s.title, done: !!s.done })),
    reminder: r ? { date: r.date ?? null, time: r.at, until: r.until, on: r.on, message: r.text || null } : null,
    waitsUntil: c.land ? landsOn(t, c.land) : null,
    ...(scheduledOn() ? { scheduled: !!c.land && !isISODay(t.doOn) && landsOn(t, c.land) !== null } : {}),
  };
}
/** Can this AI reach this task with its switches. */
const reach = (t: Todo, sc: Scopes) => (inInbox(t) ? sc.inbox : sc.lists);
const reachOff = (t: Todo): ScopeId => (inInbox(t) ? "inbox" : "lists");

// ---------- checking what was sent ----------
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const okDay = (v: string) => DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
type Body = Record<string, unknown>;
const isObj = (v: unknown): v is Body => !!v && typeof v === "object" && !Array.isArray(v);
function unknownField(b: Body, allowed: string[]): ApiRes | null {
  const bad = Object.keys(b).find((k) => !allowed.includes(k));
  return bad ? fail(400, "unknown_field", `Unknown field "${bad}". Allowed here: ${allowed.join(", ")}.`, { field: bad }) : null;
}
const badField = (field: string, message: string) => fail(400, "bad_field", message, { field });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** Where a task should go: a list page and/or a section, as sent. */
type Dest = { inbox: true } | { inbox: false; key: string | null; page: string };
function destOf(b: Body, c: Ctx): Dest | ApiRes {
  const list = b.list === undefined || b.list === null ? null : b.list, section = b.section === undefined || b.section === null ? null : b.section;
  if (list !== null && typeof list !== "string") return badField("list", "list must be a list id from GET /v1/lists, or \"inbox\".");
  if (section !== null && typeof section !== "string") return badField("section", "section must be a section key from GET /v1/lists.");
  if ((list === null || list === INBOX) && (section === null || section === INBOX)) return { inbox: true };
  if (list === INBOX || section === INBOX) return badField(list === INBOX ? "section" : "list", "The AI Inbox is its own list and section: send list \"inbox\" alone.");
  let page = list;
  if (page !== null && !c.order.includes(page)) return fail(404, "not_found", `No list "${page}". GET /v1/lists shows the lists.`, { field: "list" });
  if (section !== null) {
    const exists = ["p1", "prio", "daily"].includes(section) || (groupOf(section) !== null && c.known.has(groupOf(section)!));
    if (!exists) return fail(404, "not_found", `No section "${section}". GET /v1/lists shows each list's sections.`, { field: "section" });
    const on = pageOfSec(c.pages, section);
    if (page !== null && on !== page) return badField("section", `Section "${section}" is on list "${on}", not "${page}".`);
    page = on;
  }
  if (page !== MAIN && c.pages.find((p) => p.id === page)?.kind === "panels") return fail(409, "not_a_task_list", `"${listName(c, page!)}" is a page of panels, not a to-do list.`, { field: "list" });
  return { inbox: false, key: section, page: page! };
}
/** The fields that put a task of this kind at the end of the destination, plus a settings change when the list needs
 *  a new "To do" group first. */
async function placeIn(dest: Dest & { inbox: false }, type: Todo["type"], c: Ctx, store: ApiStore): Promise<Partial<Todo> | ApiRes> {
  let key = dest.key;
  if (key === null) {
    const t = listMoveTarget(c.lists, c.byPage.get(dest.page) ?? [], [type]);
    key = t?.to ?? null;
  }
  if (key !== null) {
    if (!sectionTakes(key, type)) return fail(409, "wrong_section", type === "daily"
      ? `"${secName(c, key)}" holds one-off tasks. A repeating (daily) task can go to "daily" or a task group.`
      : `"${secName(c, key)}" holds repeating tasks only. Send kind "daily", or pick another section.`, { field: "section" });
    return intoSection(key, c.lists);
  }
  // No section on that list takes it: a new "To do" group there, as the Tab list's Move to list does.
  if (c.groups.length >= 30) return fail(409, "too_many", "That list has no section for this task and there are already 30 task groups.");
  const gid = store.newGroupId();
  const gk = groupKey(gid);
  const tmPages = dest.page === MAIN ? undefined : c.pages.map((p) => ({ ...p, secs: p.id === dest.page ? [...p.secs, gk] : p.secs.filter((k) => k !== gk) }));
  await store.saveSettings({ tmGroups: [...c.groups, { id: gid, name: "To do" }], tmSecOrder: [...c.full, gk], ...(tmPages ? { tmPages } : {}) });
  c.groups.push({ id: gid, name: "To do" }); c.known.add(gid); c.full.push(gk);
  if (tmPages) { c.pages.splice(0, c.pages.length, ...tmPages); }
  c.byPage.set(dest.page, [...(c.byPage.get(dest.page) ?? []), gk]);
  c.lists.groups.set(gid, []);
  return { group: gid, order: 0 };
}

// ---------- the endpoints ----------
const ENDPOINTS = [
  "GET /v1", "GET /v1/lists", "PATCH /v1/lists/{id}", "PATCH /v1/sections/{key}",
  "GET /v1/tasks", "POST /v1/tasks", "GET /v1/tasks/{id}", "PATCH /v1/tasks/{id}", "DELETE /v1/tasks/{id}",
  "POST /v1/tasks/{id}/complete", "POST /v1/tasks/{id}/reopen", "PUT /v1/tasks/{id}/reminder", "DELETE /v1/tasks/{id}/reminder",
  "GET /v1/focus", "PUT /v1/focus",
  "POST /v1/sentry/start",
  "GET /v1/gym", "PATCH /v1/gym",
  "GET /v1/settings", "PATCH /v1/settings",
  "POST /v1/island/message",
  "GET /v1/goals", "POST /v1/goals", "GET /v1/goals/{id}", "PATCH /v1/goals/{id}", "DELETE /v1/goals/{id}",
];
/** The settings an AI may read and change (GET and PATCH /v1/settings): the API name, the settings record's field.
 *  PS 1.74: autoReset (true or false: settings.autoReset "midnight" or "off"), autoResetAt ("HH:MM", core/resetday.ts) and
 *  dayEnds (the countdown's Day ends beside the reset time, settings.countdown mode and at, core/daycount.ts). */
export const API_SETTINGS = { invertSwipe: "swipeInvert", autoReset: "autoReset", autoResetAt: "autoResetAt", dayEnds: "countdown" } as const;
/** The countdown's Day ends as the API says it: "reset" (it follows the reset time), "HH:MM" (Every day at), or "week"
 *  (a time for each day, set in PS only). */
export function apiDayEnds(cd: Pick<CdPrefs, "mode" | "at">): string {
  return cd.mode === "reset" ? "reset" : cd.mode === "week" ? "week" : cd.at;
}
/** Said whenever anything but POST /v1/sentry/start is asked of Sentry mode. */
export const SENTRY_NO_STOP = "Sentry mode can only be started through the API, never stopped, paused or changed. Leaving it needs the person's Mac password or Touch ID.";

/** One request, start to end. Never throws: a broken write answers 500 with no task text in it. */
export async function handleApi(req: ApiReq, scopesIn: unknown, store: ApiStore): Promise<ApiRes> {
  try { return await route(req, cleanScopes(scopesIn), store); }
  catch { return fail(500, "internal", "PS could not do that just now. Nothing was half done on purpose; read the task again before retrying."); }
}

async function route(req: ApiReq, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  const method = String(req.method || "").toUpperCase();
  const path = String(req.path || "").split("?")[0].replace(/\/+$/, "") || "/";
  let seg: string[];
  try { seg = path.split("/").filter(Boolean).map(decodeURIComponent); } catch { return fail(400, "bad_request", "The path is not valid."); }
  if (seg[0] !== "v1") return fail(404, "not_found", "Every endpoint starts with /v1. GET /v1 lists them.");
  const q = req.query ?? {};
  const body = req.body;
  const allow = (...m: string[]) => (m.includes(method) ? null : fail(405, "method_not_allowed", `${method} is not used here. This path takes: ${m.join(", ")}.`, { allow: m }));
  const needBody = (): Body | ApiRes => (isObj(body) ? body : fail(400, "bad_request", "Send a JSON object as the body, with Content-Type: application/json."));

  // GET /v1: who is here, which switches are on. Answers even while the vault is locked.
  if (seg.length === 1) {
    const no = allow("GET"); if (no) return no;
    return ok({ app: "PS", api: API_VERSION, version: store.version(), vault: store.state() === "ok" ? "open" : "locked", scopes: sc, inbox: { id: INBOX, name: INBOX_NAME }, endpoints: ENDPOINTS });
  }
  if (store.state() !== "ok") return fail(423, "locked", "PS is open but signed out or locked, so it cannot read or change tasks. Ask the person to unlock PS, then try again.");

  // /v1/lists
  if (seg[1] === "lists" && seg.length === 2) {
    const no = allow("GET"); if (no) return no;
    if (!sc.read) return scopeOff("read");
    if (!sc.inbox && !sc.lists) return scopeOff("lists");
    const c = makeCtx(store);
    const out: unknown[] = [];
    if (sc.inbox) {
      const n = c.all.filter((d) => inInbox(d.data) && !d.data.done).length;
      out.push({ id: INBOX, name: INBOX_NAME, kind: "inbox", openTasks: n, sections: [{ key: INBOX, name: INBOX_NAME, takes: "any", openTasks: n }] });
    }
    if (sc.lists) {
      c.order.forEach((id, position) => {
        const page = c.pages.find((p) => p.id === id);
        const kind = page?.kind === "panels" ? "panels" : "list";
        const secs = kind === "panels" ? [] : (c.byPage.get(id) ?? []).map((key) => ({ key, name: secName(c, key), takes: key === "daily" ? "daily" : groupOf(key) ? "any" : "once", openTasks: openIn(c.lists, key) }));
        out.push({ id, name: listName(c, id), kind, position, home: id === MAIN, openTasks: secs.reduce((n, s) => n + s.openTasks, 0), sections: secs });
      });
    }
    return ok({ lists: out });
  }
  // PATCH /v1/lists/{id}: rename a list
  if (seg[1] === "lists" && seg.length === 3) {
    const no = allow("PATCH"); if (no) return no;
    if (!sc.rename) return scopeOff("rename");
    if (!sc.lists) return scopeOff("lists");
    const b = needBody(); if (!isObj(b)) return b;
    const u = unknownField(b, ["name"]); if (u) return u;
    const c = makeCtx(store);
    const id = seg[2];
    if (id === INBOX) return badField("name", "The AI Inbox keeps its name.");
    if (!c.order.includes(id)) return fail(404, "not_found", `No list "${id}". GET /v1/lists shows the lists.`);
    const name = tidyName(b.name, LIST_NAME_MAX);
    if (id === MAIN) {
      const names = { ...c.names };
      if (name && name !== DEFAULT_NAMES.main) names.main = name; else delete names.main;
      await store.saveSettings({ tmNames: names });
      return ok({ list: { id, name: name || DEFAULT_NAMES.main } });
    }
    if (!name) return badField("name", `name must be 1 to ${LIST_NAME_MAX} characters.`);
    await store.saveSettings({ tmPages: renamePage(c.pages, id, name) });
    return ok({ list: { id, name } });
  }
  // PATCH /v1/sections/{key}: rename a section
  if (seg[1] === "sections" && seg.length === 3) {
    const no = allow("PATCH"); if (no) return no;
    if (!sc.rename) return scopeOff("rename");
    if (!sc.lists) return scopeOff("lists");
    const b = needBody(); if (!isObj(b)) return b;
    const u = unknownField(b, ["name"]); if (u) return u;
    const c = makeCtx(store);
    const key = seg[2];
    const g = groupOf(key);
    if (g) {
      if (!c.known.has(g)) return fail(404, "not_found", `No section "${key}". GET /v1/lists shows the sections.`);
      const name = tidyName(b.name, GROUP_NAME_MAX);
      if (!name) return badField("name", `name must be 1 to ${GROUP_NAME_MAX} characters.`);
      await store.saveSettings({ tmGroups: cleanGroups(c.groups.map((x) => (x.id === g ? { ...x, name } : x))) });
      return ok({ section: { key, name } });
    }
    if (!["p1", "prio", "daily", "done"].includes(key)) return fail(404, "not_found", `No section "${key}". GET /v1/lists shows the sections.`);
    const k = key as "p1" | "prio" | "daily" | "done";
    const name = tidyName(b.name, SEC_NAME_MAX);
    const names = { ...c.names };
    if (name && name !== DEFAULT_NAMES[k]) names[k] = name; else delete names[k];
    await store.saveSettings({ tmNames: names });
    return ok({ section: { key, name: name || DEFAULT_NAMES[k] } });
  }

  // POST /v1/sentry/start: the one and only Sentry mode endpoint. Start only, no fields, no query: nothing can stop,
  // pause or weaken it from here (tests/taskapi.test.ts proves every other path and method is refused untouched).
  if (seg[1] === "sentry") {
    if (seg.length !== 3 || seg[2] !== "start") return fail(404, "not_found", `The only Sentry mode endpoint is POST /v1/sentry/start. ${SENTRY_NO_STOP}`);
    const no = allow("POST"); if (no) return fail(405, "method_not_allowed", `Use POST. ${SENTRY_NO_STOP}`, { allow: ["POST"] });
    if (!sc.sentry) return scopeOff("sentry");
    if (Object.keys(q).length) return fail(400, "unknown_field", `Sentry mode takes no settings through the API: it starts with the person's own Sentry settings. ${SENTRY_NO_STOP}`, { field: Object.keys(q)[0] });
    if (body !== undefined && body !== null && !(isObj(body) && !Object.keys(body).length))
      return fail(400, "unknown_field", `Sentry mode takes no settings through the API: send no body. ${SENTRY_NO_STOP}`, { field: isObj(body) ? Object.keys(body)[0] : "body" });
    const r = await store.startSentry();
    if (r.result === "engaged") return ok({ sentry: { started: true, phase: r.phase, note: SENTRY_NO_STOP } });
    if (r.result === "already") return ok({ sentry: { started: false, alreadyOn: true, phase: r.phase, note: SENTRY_NO_STOP } });
    if (r.result === "blocked") return fail(409, "sentry_checks", `PS did not start Sentry mode. ${r.title}: ${r.lines.join(" ")} Ask the person to fix this (PS Settings, Sentry mode, or Security), or to start Sentry mode in PS themselves.`, { title: r.title, lines: r.lines });
    if (r.result === "refused") return fail(409, "sentry_refused", r.note);
    if (r.result === "notStarted") return fail(409, "sentry_refused", "PS did not start Sentry mode just now (Sleep mode may be up). Ask the person.");
    return fail(503, "not_ready", r.result === "unavailable" ? "Sentry mode runs only in the PS app on a Mac." : "PS did not say whether Sentry mode started. Ask the person to look at the Mac before trying again.");
  }

  // GET and PATCH /v1/gym (V1.57): the gym reminder's times. Never a Yes: no field, path or method says Yes for the person.
  if (seg[1] === "gym") {
    if (seg.length !== 2) return fail(404, "not_found", `The gym endpoints are GET /v1/gym and PATCH /v1/gym. ${API_NO_YES}`);
    const no = allow("GET", "PATCH"); if (no) return no;
    if (!sc.gym) return scopeOff("gym");
    const st = store.settings();
    const tz = okTz(st.tmHomeTz) || store.deviceTz();
    const p = gymPrefs(st.gym, store.red());
    const acked = st.gymAck ?? [];
    if (method === "GET") return ok({ gym: apiGym(p, acked, store.now(), tz) });
    const b = needBody(); if (!isObj(b)) return b;
    const yes = Object.keys(b).find((k) => API_GYM_YES.includes(k));
    if (yes) return fail(400, "unknown_field", API_NO_YES, { field: yes });
    const u = unknownField(b, [...API_GYM_FIELDS]); if (u) return u;
    const r = apiGymPatch(p, b);
    if ("field" in r) return badField(r.field, r.message);
    await store.saveSettings({ gym: r.prefs });
    return ok({ gym: apiGym(r.prefs, acked, store.now(), tz) });
  }

  // GET and PATCH /v1/settings (V1.57): only the settings in API_SETTINGS, nothing else in the settings record.
  if (seg[1] === "settings") {
    if (seg.length !== 2) return fail(404, "not_found", "The settings endpoints are GET /v1/settings and PATCH /v1/settings.");
    const no = allow("GET", "PATCH"); if (no) return no;
    if (!sc.settings) return scopeOff("settings");
    const red = store.red();
    const view = (st: Partial<Settings>) => ({ invertSwipe: st.swipeInvert === true, autoReset: st.autoReset === "midnight", autoResetAt: resetAtOf(st),
      dayEnds: apiDayEnds(cleanCd(st.countdown, red)) });
    if (method === "GET") return ok({ settings: view(store.settings()) });
    const b = needBody(); if (!isObj(b)) return b;
    const u = unknownField(b, Object.keys(API_SETTINGS)); if (u) return u;
    if (!Object.keys(b).length) return fail(400, "bad_request", `Send at least one of: ${Object.keys(API_SETTINGS).join(", ")}.`);
    // Everything is checked before anything is saved: one bad field changes nothing.
    if ("invertSwipe" in b && typeof b.invertSwipe !== "boolean") return badField("invertSwipe", "invertSwipe must be true or false.");
    if ("autoReset" in b && typeof b.autoReset !== "boolean") return badField("autoReset", "autoReset must be true (your list resets by itself at autoResetAt) or false (only when you press Reset).");
    if ("autoResetAt" in b && !okResetAt(b.autoResetAt)) return badField("autoResetAt", "autoResetAt is a 24 hour time like 04:00, from 00:00 (midnight) to 23:59.");
    if ("dayEnds" in b && b.dayEnds !== "reset" && !okHm(b.dayEnds))
      return badField("dayEnds", b.dayEnds === "week" ? "A time for each day is set in PS itself (Settings, Countdown text). Send \"reset\" or a time like 23:00." : "dayEnds is \"reset\" (the day ends at the reset time) or a 24 hour time like 23:00.");
    const st = store.settings();
    const patch: Partial<Settings> = {};
    if (typeof b.invertSwipe === "boolean") patch.swipeInvert = b.invertSwipe;
    if (typeof b.autoReset === "boolean") patch.autoReset = b.autoReset ? "midnight" : "off";
    if (okResetAt(b.autoResetAt)) patch.autoResetAt = b.autoResetAt;
    // As Settings' own Day ends does (views/AutoReset.tsx): a time is "Every day at" that time, "reset" follows the reset time.
    if ("dayEnds" in b) patch.countdown = cdPatch(cleanCd(st.countdown, red), b.dayEnds === "reset" ? { mode: "reset" } : { mode: "daily", at: b.dayEnds as string });
    await store.saveSettings(patch);
    return ok({ settings: view({ ...store.settings(), ...patch }) });
  }

  // POST /v1/island/message (V1.58): a short message from the AI on the island (core/aimessage.ts has the rules).
  if (seg[1] === "island") {
    if (seg.length !== 3 || seg[2] !== "message") return fail(404, "not_found", "The island endpoint is POST /v1/island/message.");
    const no = allow("POST"); if (no) return no;
    if (!sc.message) return scopeOff("message");
    return islandMessage(body, sc, store);
  }

  // GET and PUT /v1/focus (PS 1.74): the task the person is working on, the one the island shows (a click on a task in the
  // Tab list, settings.workingIds). Setting it is what that click does: the island shows it and its clock starts.
  if (seg[1] === "focus") {
    if (seg.length !== 2) return fail(404, "not_found", "The focus endpoints are GET /v1/focus and PUT /v1/focus.");
    const no = allow("GET", "PUT"); if (no) return no;
    if (!sc.focus) return scopeOff("focus");
    return method === "GET" ? getFocus(sc, store) : putFocus(body, sc, store);
  }

  // /v1/goals (PS 1.72): the goals timeline, kept in the encrypted settings record like everything else.
  if (seg[1] === "goals") {
    if (seg.length > 3) return fail(404, "not_found", "The goals endpoints are /v1/goals and /v1/goals/{id}.");
    if (!sc.goals) return scopeOff("goals");
    if (seg.length === 2) {
      const no = allow("GET", "POST"); if (no) return no;
      return method === "GET" ? listGoals(q, sc, store) : addGoals(body, sc, store);
    }
    const no = allow("GET", "PATCH", "DELETE"); if (no) return no;
    const gid = seg[2];
    const goals = store.settings().goals ?? [];
    const g = ID_RE.test(gid) ? goals.find((x) => x.id === gid) : undefined;
    if (!g) return fail(404, "not_found", "No goal with that id (it may have been deleted). GET /v1/goals shows them.");
    if (method === "GET") { if (!sc.read) return scopeOff("read"); return ok({ goal: goalView(g) }); }
    if (method === "DELETE") {
      if (!sc.delete) return scopeOff("delete");
      await store.saveSettings({ goals: goals.filter((x) => x.id !== gid) });
      return ok({ deleted: gid });
    }
    return editGoal(g, goals, body, sc, store);
  }

  if (seg[1] !== "tasks" || seg.length > 4) return fail(404, "not_found", "No such endpoint. GET /v1 lists them.");

  // /v1/tasks
  if (seg.length === 2) {
    const no = allow("GET", "POST"); if (no) return no;
    return method === "GET" ? listTasks(q, sc, store) : addTasks(body, sc, store);
  }
  const id = seg[2];
  if (seg.length === 4 && !["complete", "reopen", "reminder"].includes(seg[3])) return fail(404, "not_found", "No such endpoint. GET /v1 lists them.");
  if (!ID_RE.test(id)) return fail(404, "not_found", "No task with that id.");
  const c = makeCtx(store);
  const d = c.all.find((x) => x.id === id);
  if (!d) return fail(404, "not_found", "No task with that id (it may have been deleted or cleared by a reset).");
  if (!reach(d.data, sc)) return scopeOff(reachOff(d.data));

  if (seg.length === 3) {
    const no = allow("GET", "PATCH", "DELETE"); if (no) return no;
    if (method === "GET") { if (!sc.read) return scopeOff("read"); return ok({ task: view(d, c) }); }
    if (method === "DELETE") {
      if (!sc.delete) return scopeOff("delete");
      await store.remove(id);
      if (reminderOfTask(c.rem, id)) await store.saveRemind((rec) => { const r = rec && reminderOfTask(rec, id); return rec && r ? removeReminder(rec, r.id, store.now()) : null; });
      return ok({ deleted: id });
    }
    return editTask(d, body, sc, store, c);
  }
  // /v1/tasks/{id}/complete, /reopen, /reminder
  const act = seg[3];
  if (act === "complete" || act === "reopen") {
    const no = allow("POST"); if (no) return no;
    if (!sc.done) return scopeOff("done");
    await store.setDone(id, act === "complete");
    return ok({ task: fresh(id, store, d, { done: act === "complete" }) });
  }
  if (act === "reminder") {
    const no = allow("PUT", "DELETE"); if (no) return no;
    if (!sc.remind) return scopeOff("remind");
    return reminder(d, method, body, store, c);
  }
  return fail(404, "not_found", "No such endpoint. GET /v1 lists them.");
}

const openIn = (l: TabLists, key: string) => {
  const g = groupOf(key);
  if (g) return (l.groups.get(g) ?? []).filter((d) => !d.data.done).length;
  return key === "p1" ? l.p1.filter((d) => !d.data.done).length : key === "prio" ? l.prio.length : key === "daily" ? l.daily.filter((d) => !d.data.done).length : 0;
};
/** The task as saved now (a fake or slow store: what we sent, put on top of the copy we had). */
/** POST /v1/island/message: checked, then kept in the encrypted settings, where the cards and the island pick it up. */
async function islandMessage(body: unknown, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object as the body, with Content-Type: application/json: {\"from\": \"Claude Code\", \"text\": \"...\"}.");
  const u = unknownField(body, [...AI_MSG_FIELDS]); if (u) return u;
  const r = checkAiMsg(body);
  if ("field" in r) return badField(r.field, r.message);
  // PS 1.74: a task for the card's Mark done, kept only when that click may tick it. Otherwise the message is shown as
  // before, with no button, and the AI is told why (never an error: the message itself is fine).
  let noDone: string | null = null;
  const asSent = { ...r.msg };   // the same message sent again is found by what the AI sent, before any task is taken off
  if (r.msg.task) {
    const t = store.todos().find((x) => x.id === r.msg.task);
    if (!sc.done) noDone = `The "${scopeLabel("done")}" switch is off, so the message has no Mark done button.`;
    else if (!t) noDone = "No task with that id (it may have been deleted or cleared by a reset), so the message has no Mark done button.";
    else if (!reach(t.data, sc)) noDone = `The "${scopeLabel(reachOff(t.data))}" switch is off for that task, so the message has no Mark done button.`;
    else if (t.data.done) noDone = "That task is already done, so the message has no Mark done button.";
    if (noDone) delete r.msg.task;
  }
  const doneInfo = (task: string | undefined) => (r.msg.task || noDone ? { markDone: !!task, ...(noDone ? { note: noDone } : {}) } : {});
  const st = store.settings();
  const now = store.now();
  const mode = aiNotesMode(st.aiNotes);
  // The person chose plain finished cards, or nothing: nothing is kept or shown, and the AI is told so (no error).
  if (mode !== "messages") return ok({ message: null, shown: false, note: mode === "plain"
    ? "The person chose plain finished cards in PS, so messages are not shown. Nothing to fix; carry on."
    : "The person switched AI pop ups off in PS. Nothing to fix; carry on." });
  const again = sameAiMsg(st.aiMsgs, asSent, now) ?? sameAiMsg(st.aiMsgs, r.msg, now);
  if (again) {
    // Dismissed already: not on screen any more, so no button either (break-it 1.74). A reason for no button is kept.
    const said = again.seen ? "The same message was already sent a moment ago, and the person has dismissed it." : "The same message was already sent a moment ago.";
    return ok({ message: { id: again.id, at: again.at }, shown: !again.seen, ...doneInfo(noDone || again.seen ? undefined : again.task), note: noDone ? `${said} ${noDone}` : said });
  }
  const wait = aiMsgWait(st.aiMsgs, now);
  if (wait) return fail(429, "rate_limited", `Too many messages: at most ${AI_MSG.burst} in ${AI_MSG.burstMs / 60_000} minutes. Send one short message at the end of a task, not one per step.`, { retryAfter: wait });
  const m = { id: newAiMsgId(), ...r.msg, at: new Date(now).toISOString() };
  await store.saveSettings({ aiMsgs: addAiMsg(st.aiMsgs, m, now, st.dnd) });
  return ok({ message: { id: m.id, at: m.at }, shown: true, ...doneInfo(m.task) }, 201);
}

/** The working task ids, as model.ts workingIdsOf (kept here so this file only imports types from model.ts). */
const workingOf = (st: Partial<Settings>): string[] => [...new Set(st.workingIds ?? (st.workingOn ? [st.workingOn] : []))];
// GET /v1/focus: the tasks being worked on now (open ones, as the island shows them), the first one being the island's.
function focusView(c: Ctx, sc: Scopes) {
  const byId = new Map(c.all.map((d) => [d.id, d]));
  const ids = workingOf(c.st);
  const working = ids.map((id) => byId.get(id)).filter((d): d is Doc<Todo> => !!d && !d.data.done);
  const mine = working.filter((d) => reach(d.data, sc));
  const tasks = mine.map((d) => view(d, c));
  // hidden: worked on, but outside the AI Inbox or All lists switch this AI has.
  return { task: tasks[0] ?? null, tasks, hidden: working.length - mine.length };
}
function getFocus(sc: Scopes, store: ApiStore): ApiRes {
  if (!sc.read) return scopeOff("read");
  return ok({ focus: focusView(makeCtx(store), sc) });
}
// PUT /v1/focus {"task": id}: this task, and only this one, is the one being worked on. {"task": null}: none.
async function putFocus(body: unknown, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!isObj(body)) return fail(400, "bad_request", "Send {\"task\": \"<task id>\"} to set the task being worked on, or {\"task\": null} for none.");
  const u = unknownField(body, ["task"]); if (u) return u;
  if (!("task" in body)) return badField("task", "task is a task id from GET /v1/tasks, or null for none.");
  if (body.task !== null && (typeof body.task !== "string" || !ID_RE.test(body.task))) return badField("task", "task is a task id from GET /v1/tasks, or null for none.");
  const c = makeCtx(store);
  // Working tasks outside this AI's reach (AI Inbox or All lists switch) stay exactly as they are: it cannot see them, so
  // it never takes them off or stops their clocks. Only what it can reach is replaced (or cleared with null).
  const byId = new Map(c.all.map((x) => [x.id, x]));
  const hidden = workingOf(c.st).filter((id) => { const x = byId.get(id); return !!x && !reach(x.data, sc); });
  const hiddenOpen = hidden.filter((id) => !byId.get(id)!.data.done).length;
  if (body.task === null) {
    await store.setFocus(hidden);
    return ok({ focus: { task: null, tasks: [], hidden: hiddenOpen } });
  }
  const d = byId.get(body.task);
  if (!d) return fail(404, "not_found", "No task with that id (it may have been deleted or cleared by a reset).");
  if (!reach(d.data, sc)) return scopeOff(reachOff(d.data));
  if (d.data.done) return fail(409, "task_done", "That task is done. Open it again first (POST /v1/tasks/{id}/reopen) if the person is working on it again.");
  // Break-it 1.74: a client task before its do date is in no list yet, so no click could make it the working task.
  const lands = c.land ? landsOn(d.data, c.land) : null;
  if (lands) return fail(409, "not_landed", isISODay(d.data.doOn)
    ? `That task comes into their list on ${lands} (its do date). Ask the person before working on it early.`
    : `That task is scheduled for ${lands} and comes into their list that day. Ask the person before working on it early.`);
  await store.setFocus([d.id, ...hidden]);
  // Without the read switch the answer names the task by id only (PUT may set it, never read it).
  const shown = sc.read ? view(d, c) : { id: d.id };
  return ok({ focus: { task: shown, tasks: [shown], hidden: hiddenOpen } });
}

function fresh(id: string, store: ApiStore, before: Doc<Todo>, patch: Partial<Todo>): ApiTask {
  const c = makeCtx(store);
  const d = c.all.find((x) => x.id === id) ?? { ...before, data: { ...before.data, ...patch } };
  return view(d, c);
}

// GET /v1/tasks
function listTasks(q: Record<string, string>, sc: Scopes, store: ApiStore): ApiRes {
  if (!sc.read) return scopeOff("read");
  const known = ["list", "section", "status", "q", "limit"];
  const bad = Object.keys(q).find((k) => !known.includes(k));
  if (bad) return fail(400, "unknown_field", `Unknown query "${bad}". Allowed: ${known.join(", ")}.`, { field: bad });
  const c = makeCtx(store);
  const list = q.list || null, section = q.section || null;
  if (list === INBOX || section === INBOX) { if (!sc.inbox) return scopeOff("inbox"); }
  else if (list || section) { if (!sc.lists) return scopeOff("lists"); }
  if (!sc.inbox && !sc.lists) return scopeOff("inbox");
  if (list && list !== INBOX && !c.order.includes(list)) return fail(404, "not_found", `No list "${list}". GET /v1/lists shows the lists.`);
  const status = q.status || "open";
  if (!["open", "done", "all"].includes(status)) return badField("status", "status is open (default), done or all.");
  const limit = q.limit ? Number(q.limit) : LIST_LIMIT_DEF;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return badField("limit", `limit is 1 to ${LIST_LIMIT_MAX}.`);
  const words = (q.q || "").toLowerCase().trim();
  const pageIx = new Map(c.order.map((id, i) => [id, i + 1]));
  const secIx = new Map(c.full.map((k, i) => [k, i]));
  const byId = new Map(c.all.map((d) => [d.id, d.data]));
  const rows = c.all.filter((d) => reach(d.data, sc)).map((d) => view(d, c)).filter((t) => {
    if (list && t.list !== list) return false;
    if (section && t.section !== section) return false;
    if (status === "open" ? t.done : status === "done" ? !t.done : false) return false;
    if (words && !`${t.title} ${t.notes ?? ""}`.toLowerCase().includes(words)) return false;
    return true;
  });
  rows.sort((a, b) => (pageIx.get(a.list) ?? 0) - (pageIx.get(b.list) ?? 0) || (secIx.get(a.section) ?? -1) - (secIx.get(b.section) ?? -1)
    || (a.p1 === b.p1 ? 0 : a.p1 ? -1 : 1) || (byId.get(a.id)?.order ?? 0) - (byId.get(b.id)?.order ?? 0));
  return ok({ tasks: rows.slice(0, limit), count: rows.length, more: rows.length > limit });
}

// POST /v1/tasks: one task, or {"tasks": [...]} for up to BATCH_MAX at once
const ADD_FIELDS = ["title", "notes", "due", "kind", "p1", "list", "section"];
type NewTask = { t: Partial<Todo> & { title: string }; dest: Dest };
function checkNew(b: unknown, c: Ctx, at: string): NewTask | ApiRes {
  if (!isObj(b)) return fail(400, "bad_request", `${at}: each task is a JSON object with at least a title.`);
  const u = unknownField(b, ADD_FIELDS); if (u) return u;
  const title = text(b.title, TITLE_MAX);
  if (!title) return badField("title", `${at}: title is required (1 to ${TITLE_MAX} characters).`);
  const t: Partial<Todo> & { title: string } = { title };
  if (b.notes !== undefined && b.notes !== null) { if (typeof b.notes !== "string") return badField("notes", `${at}: notes is text.`); const n = b.notes.trim().slice(0, NOTES_MAX); if (n) t.notes = n; }
  const kind = b.kind ?? "once";
  if (kind !== "once" && kind !== "daily") return badField("kind", `${at}: kind is "once" (default) or "daily" (repeats every day).`);
  t.type = kind;
  if (b.due !== undefined && b.due !== null) {
    if (typeof b.due !== "string" || !okDay(b.due)) return badField("due", `${at}: due is a date like 2026-11-20.`);
    if (kind === "daily") return badField("due", `${at}: a daily task repeats every day, so it has no due date.`);
    t.due = b.due;
  }
  if (b.p1 !== undefined) { if (typeof b.p1 !== "boolean") return badField("p1", `${at}: p1 is true or false.`); if (b.p1 && kind === "daily") return badField("p1", `${at}: a daily task cannot be Priority 1.`); if (b.p1) t.p1 = true; }
  const dest = destOf(b, c);
  if ("status" in dest) return dest;
  return { t, dest };
}
async function addTasks(body: unknown, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!sc.add) return scopeOff("add");
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object as the body: {\"title\": \"...\"}, or {\"tasks\": [{...}, ...]} for several.");
  const batch = Array.isArray(body.tasks);
  if (batch) { const u = unknownField(body, ["tasks"]); if (u) return u; }
  const items = batch ? body.tasks as unknown[] : [body];
  if (!items.length) return badField("tasks", "tasks is empty.");
  if (items.length > BATCH_MAX) return fail(400, "too_many", `At most ${BATCH_MAX} tasks in one request.`);
  const c = makeCtx(store);
  // Everything is checked before anything is added, so a bad one never leaves half a batch behind.
  const list: NewTask[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = checkNew(items[i], c, batch ? `tasks[${i}]` : "task");
    if ("status" in r) return r;
    if (r.dest.inbox ? !sc.inbox : !sc.lists) return scopeOff(r.dest.inbox ? "inbox" : "lists");
    list.push(r);
  }
  const inboxNow = c.all.filter((d) => inInbox(d.data) && !d.data.done).length;
  if (inboxNow + list.filter((x) => x.dest.inbox).length > INBOX_MAX) return fail(409, "inbox_full", `The AI Inbox holds at most ${INBOX_MAX} open tasks. Ask the person to sort it first.`);
  const made: ApiTask[] = [];
  for (const { t, dest } of list) {
    let place: Partial<Todo> = { aiInbox: true };
    if (!dest.inbox) {
      const p = await placeIn(dest, t.type ?? "once", c, store);
      if ("status" in p) return made.length ? { ...p, body: { ...(p.body as object), added: made } } : p;
      place = p;
      if (t.p1 && (place.group || t.type === "daily")) delete t.p1;   // Priority 1 is a section of its own
      if (t.p1) place.p1 = true;
    }
    const data: Partial<Todo> & { title: string } = { ...t, ...place, ai: true, source: "manual" };
    const id = await store.add(data);
    const doc: Doc<Todo> = { id, ws: null, kind: "todo", author: null, updatedAt: null, data: { done: false, order: 0, type: "once", ...data } as Todo };
    // Placed after the last one, so a batch keeps its order.
    if (!dest.inbox && place.order !== undefined) { const key = sectionOf(doc.data, c.known); placeAfter(c, key, doc); }
    made.push(fresh(id, store, doc, {}));
  }
  return batch ? ok({ tasks: made, count: made.length }, 201) : ok({ task: made[0] }, 201);
}
function placeAfter(c: Ctx, key: string, d: Doc<Todo>) {
  const g = groupOf(key);
  if (g) (c.lists.groups.get(g) ?? c.lists.groups.set(g, []).get(g)!).push(d);
  else if (key === "daily") c.lists.daily.push(d);
  else { c.lists.ranked.push(d); (key === "p1" ? c.lists.p1 : c.lists.prio).push(d); }
}

// PATCH /v1/tasks/{id}
const EDIT_FIELDS = ["title", "notes", "due", "p1", "list", "section", "done"];
async function editTask(d: Doc<Todo>, body: unknown, sc: Scopes, store: ApiStore, c: Ctx): Promise<ApiRes> {
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object with the fields to change.");
  const u = unknownField(body, EDIT_FIELDS); if (u) return u;
  if (!Object.keys(body).length) return fail(400, "bad_request", `Nothing to change. Fields: ${EDIT_FIELDS.join(", ")}.`);
  const t = d.data, patch: Partial<Todo> = {};
  const edits = ["title", "notes", "due", "p1", "list", "section"].some((k) => k in body);
  if (edits && !sc.edit) return scopeOff("edit");
  if ("done" in body && !sc.done) return scopeOff("done");
  if ("title" in body) { const v = text(body.title, TITLE_MAX); if (!v) return badField("title", `title is 1 to ${TITLE_MAX} characters.`); patch.title = v; }
  if ("notes" in body) { if (body.notes !== null && typeof body.notes !== "string") return badField("notes", "notes is text, or null to clear."); patch.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, NOTES_MAX) : null; }
  if ("due" in body) {
    if (body.due !== null && (typeof body.due !== "string" || !okDay(body.due))) return badField("due", "due is a date like 2026-11-20, or null to clear.");
    if (body.due && t.type === "daily") return badField("due", "A daily task repeats every day, so it has no due date.");
    patch.due = (body.due as string | null) || null;
  }
  if ("done" in body && typeof body.done !== "boolean") return badField("done", "done is true or false.");
  if ("list" in body || "section" in body) {
    const dest = destOf(body, c);
    if ("status" in dest) return dest;
    if (dest.inbox) { if (!sc.inbox) return scopeOff("inbox"); if (!inInbox(t)) Object.assign(patch, { aiInbox: true }); }
    else {
      if (!sc.lists) return scopeOff("lists");
      const here = sectionOf(t, c.known);
      const same = !inInbox(t) && (dest.key ? dest.key === here : pageOfSec(c.pages, here) === dest.page);
      if (!same) {
        const p = await placeIn(dest, t.type, c, store); if ("status" in p) return p; Object.assign(patch, p, { aiInbox: false });
        // Break-it 1.74 round 2: a repeating client task reads as Priority 1 by its P1 flag (sectionOf), so out of p1 it goes off.
        if (here === "p1" && t.type === "daily" && patch.group === null) patch.p1 = false;
      }
    }
  }
  if ("p1" in body) {
    if (typeof body.p1 !== "boolean") return badField("p1", "p1 is true or false.");
    // A repeating client task already in Priority 1 (Clients, PS 1.73) may be sent p1 true again: it changes nothing.
    if (body.p1 && t.type === "daily" && !(t.p1 === true && isClientTask(t))) return badField("p1", "A daily task cannot be Priority 1.");
    const where = patch.group !== undefined ? patch.group : t.group;
    if (body.p1 && where && c.known.has(where)) return fail(409, "wrong_section", "This task is in a task group. Move it to section \"p1\" (or \"prio\") instead.", { field: "p1" });
    patch.p1 = body.p1;
    if (body.p1) patch.unranked = false;
  }
  if (Object.keys(patch).length) await store.update(d.id, patch);
  if (typeof body.done === "boolean") await store.setDone(d.id, body.done);
  return ok({ task: fresh(d.id, store, d, typeof body.done === "boolean" ? { ...patch, done: body.done } : patch) });
}

// PUT and DELETE /v1/tasks/{id}/reminder
async function reminder(d: Doc<Todo>, method: string, body: unknown, store: ApiStore, c: Ctx): Promise<ApiRes> {
  const now = store.now();
  if (method === "DELETE") {
    const had = reminderOfTask(c.rem, d.id);
    if (!had) return fail(404, "not_found", "This task has no reminder.");
    await store.saveRemind((rec) => { const r = rec && reminderOfTask(rec, d.id); return rec && r ? removeReminder(rec, r.id, now) : null; });
    return ok({ task: fresh(d.id, store, d, {}) });
  }
  if (!isObj(body)) return fail(400, "bad_request", "Send {\"time\": \"HH:MM\"} and optionally date, until and message.");
  const u = unknownField(body, ["time", "date", "until", "message"]); if (u) return u;
  if (typeof body.time !== "string" || !HM_RE.test(body.time)) return badField("time", "time is when it starts popping up, 24 hour HH:MM like 09:30.");
  const date = body.date ?? store.today();
  if (typeof date !== "string" || !okDay(date)) return badField("date", "date is a day like 2026-11-20 (default today).");
  if (date < store.today()) return badField("date", "date is today or later.");
  let until = body.until;
  if (until === undefined || until === null) until = hm(minutesOf(body.time) + 180);
  if (typeof until !== "string" || !HM_RE.test(until) || until === body.time) return badField("until", "until is when it stops popping up, HH:MM, not the same as time (default 3 hours after).");
  if (body.message !== undefined && body.message !== null && typeof body.message !== "string") return badField("message", "message is text (default: the task's name).");
  const message = oneLine(body.message, REM_TEXT_MAX);
  const set = { at: body.time, until, date, text: message, on: true };
  let full = false;
  await store.saveRemind((rec) => {
    const base = remindOrDefault(rec, store.red());
    const have = reminderOfTask(base, d.id);
    if (have) return patchReminder(base, have.id, set, now);
    const next = addTaskReminder(base, { ...newTaskReminder(freshId(base), d.id, now, store.deviceTz()), ...set }, now);
    if (next === base) { full = true; return null; }
    return next;
  });
  if (full) return fail(409, "too_many", "PS holds at most 60 reminders on tasks. Ask the person to clear some first.");
  return ok({ task: fresh(d.id, store, d, {}) });
}
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ---------- the goals timeline (PS 1.72) ----------
/** A goal as the API shows it (the words the Timeline's editor uses: name, level, colour, From, To, notes, done). */
export interface ApiGoal { id: string; title: string; level: Goal["level"]; levelName: string; color: string; from: string; to: string; notes: string | null; done: boolean; createdAt: string | null }
const goalView = (g: Goal): ApiGoal => ({ id: g.id, title: g.title, level: g.level, levelName: levelName(g.level), color: g.color, from: g.start, to: g.end, notes: g.note ?? null, done: g.done === true, createdAt: g.createdAt ?? null });
const LEVEL_IX: Record<Goal["level"], number> = { macro: 0, meso: 1, micro: 2 };
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const GOAL_FIELDS = ["title", "level", "color", "from", "to", "notes", "done"];

// GET /v1/goals
function listGoals(q: Record<string, string>, sc: Scopes, store: ApiStore): ApiRes {
  if (!sc.read) return scopeOff("read");
  const known = ["level", "status", "from", "to", "q"];
  const bad = Object.keys(q).find((k) => !known.includes(k));
  if (bad) return fail(400, "unknown_field", `Unknown query "${bad}". Allowed: ${known.join(", ")}.`, { field: bad });
  const level = q.level ? goalLevel(q.level) : null;
  if (q.level && !level) return badField("level", "level is macro, meso or micro.");
  const status = q.status || "all";
  if (!["open", "done", "all"].includes(status)) return badField("status", "status is all (default), open or done.");
  for (const k of ["from", "to"] as const) if (q[k] && !okDay(q[k])) return badField(k, `${k} is a date like 2026-11-20.`);
  const words = (q.q || "").toLowerCase().trim();
  const rows = (store.settings().goals ?? []).filter((g) => {
    if (level && g.level !== level) return false;
    if (status === "open" ? g.done === true : status === "done" ? g.done !== true : false) return false;
    if (q.from && g.end < q.from) return false;      // from and to: goals that reach into those days
    if (q.to && g.start > q.to) return false;
    if (words && !`${g.title} ${g.note ?? ""}`.toLowerCase().includes(words)) return false;
    return true;
  }).sort((a, b) => LEVEL_IX[a.level] - LEVEL_IX[b.level] || a.start.localeCompare(b.start) || a.title.localeCompare(b.title)).map(goalView);
  return ok({ goals: rows, count: rows.length, levels: ["macro", "meso", "micro"], colors: GOAL_COLORS });
}

/** The fields sent for a goal, checked. `was` is the goal being changed (PATCH), or null for a new one. */
function checkGoal(b: unknown, was: Goal | null, at: string): { patch: Partial<Goal> } | ApiRes {
  if (!isObj(b)) return fail(400, "bad_request", `${at}: send a JSON object, like {"title": "Launch the shop", "level": "macro"}.`);
  const u = unknownField(b, GOAL_FIELDS); if (u) return u;
  const patch: Partial<Goal> = {};
  if ("title" in b || !was) {
    const t = text(b.title, GOAL_TITLE_MAX);
    if (!t) return badField("title", `${at}: title is the goal's name, 1 to ${GOAL_TITLE_MAX} characters.`);
    patch.title = t;
  }
  if ("level" in b) { const l = goalLevel(b.level); if (!l) return badField("level", `${at}: level is macro (the big goals), meso (month by month) or micro (week by week).`); patch.level = l; }
  if ("color" in b) { if (typeof b.color !== "string" || !COLOR_RE.test(b.color)) return badField("color", `${at}: color is a colour like "#EC4E86". The Timeline's own: ${GOAL_COLORS.join(", ")}.`); patch.color = b.color.toUpperCase(); }
  for (const k of ["from", "to"] as const) {
    if (!(k in b)) continue;
    if (typeof b[k] !== "string" || !okDay(b[k] as string)) return badField(k, `${at}: ${k} is a date like 2026-11-20.`);
    patch[k === "from" ? "start" : "end"] = b[k] as string;
  }
  if ("notes" in b) {
    if (b.notes !== null && typeof b.notes !== "string") return badField("notes", `${at}: notes is text, or null to clear.`);
    patch.note = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, GOAL_NOTE_MAX) : null;
  }
  if ("done" in b) { if (typeof b.done !== "boolean") return badField("done", `${at}: done is true or false.`); patch.done = b.done; }
  const start = patch.start ?? was?.start, end = patch.end ?? was?.end;
  if (start && end && end < start) return badField("to", `${at}: to (${end}) is before from (${start}).`);
  return { patch };
}

// POST /v1/goals: one goal, or {"goals": [...]} for up to BATCH_MAX at once
async function addGoals(body: unknown, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!sc.add) return scopeOff("add");
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object as the body: {\"title\": \"...\"}, or {\"goals\": [{...}, ...]} for several.");
  const batch = Array.isArray(body.goals);
  if (batch) { const u = unknownField(body, ["goals"]); if (u) return u; }
  const items = batch ? body.goals as unknown[] : [body];
  if (!items.length) return badField("goals", "goals is empty.");
  if (items.length > BATCH_MAX) return fail(400, "too_many", `At most ${BATCH_MAX} goals in one request.`);
  const have = store.settings().goals ?? [];
  if (have.length + items.length > GOALS_MAX) return fail(409, "too_many", `The Timeline holds at most ${GOALS_MAX} goals (${have.length} now). Ask the person which to delete first.`);
  // Everything is checked before anything is saved, and all of them are saved at once: never half a batch.
  const made: Goal[] = [];
  const nowIso = new Date(store.now()).toISOString();
  for (let i = 0; i < items.length; i++) {
    const r = checkGoal(items[i], null, batch ? `goals[${i}]` : "goal");
    if ("status" in r) return r;
    if (r.patch.done !== undefined && !sc.done) return scopeOff("done");
    const level = r.patch.level ?? "macro";
    const start = r.patch.start ?? store.today();
    const end = r.patch.end ?? endFor(level, start);
    if (end < start) return badField("to", `${batch ? `goals[${i}]` : "goal"}: to (${end}) is before from (${start}).`);
    made.push({ id: newGoalId(), title: r.patch.title!, level, start, end, color: r.patch.color ?? nextGoalColor([...have, ...made]),
      note: r.patch.note ?? null, done: r.patch.done === true, createdAt: nowIso });
  }
  await store.saveSettings({ goals: [...have, ...made] });
  const out = made.map(goalView);
  return batch ? ok({ goals: out, count: out.length }, 201) : ok({ goal: out[0] }, 201);
}
const newGoalId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

// PATCH /v1/goals/{id}
async function editGoal(g: Goal, goals: Goal[], body: unknown, sc: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!isObj(body)) return fail(400, "bad_request", "Send a JSON object with the fields to change.");
  if (!Object.keys(body).length) return fail(400, "bad_request", `Nothing to change. Fields: ${GOAL_FIELDS.join(", ")}.`);
  const u = unknownField(body, GOAL_FIELDS); if (u) return u;
  if (GOAL_FIELDS.some((k) => k !== "done" && k in body) && !sc.edit) return scopeOff("edit");
  if ("done" in body && !sc.done) return scopeOff("done");
  const r = checkGoal(body, g, "goal");
  if ("status" in r) return r;
  const next = { ...g, ...r.patch };   // fields this build does not know stay as they were
  await store.saveSettings({ goals: goals.map((x) => (x.id === g.id ? next : x)) });
  return ok({ goal: goalView(next) });
}
