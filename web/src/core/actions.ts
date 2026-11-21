// Everything that changes data goes through here, so views stay simple.
import type { Approval, AwareItem, ClientRec, CTask, DimxZone, Doc, Draft, Meeting, Payment, Reply, Pipeline, Preview, Project, ProjectPrivate, ProjectType, Settings, Suggestion, Tick, Todo, Update, WsMeta , ProjectDoc, Agenda, JournalEntry, Quote, Note, ScreenTimeApp, ScreenTimeDay, ScreenTimeDevice, StLine, TaskGroup } from "./model";
import { DEFAULT_SETTINGS, newProject, stagesFor, uid, workingIdsOf } from "./model";
import { OLD_SCENES, movedId, newTaskRank, sortPrio, unrankedAfterMove } from "./prio";
import { islandOnPatch } from "./islandon";
import { cleanGroups, cleanSecOrder, groupKey, planMove, planUngroup, tabLists, type TaskMove } from "./groups";
import { addPage, cleanPages, moveSec } from "./lists";
import { moveLeftovers, taskToIdea } from "./dimxmove";
import { createWorkspace, deleteBlob, doc, docs, put, putBlob, rematchMail, remove, roleConfirmed, setMerger, vaultStore } from "./vault";
import { parseMatchEntry } from "./mail";
import { agendas, dayLogs, extraSettingsIds, tzZonesDoc, journal, notes, projectViews, quotes, rawScreenTimeDays, settings, todos } from "./select";
import { addDays, todayISO } from "../ui/kit";
import { typedOrder } from "./typedprio";
import { tickPatch } from "./repeat";
import { tickParentSubs, withSubOp, type SubOp } from "./subtasks";
import { nextApps, planSplit } from "./screentime";
import { planLines, toHours, type Timeline } from "./stline";
import { isUnseen, mergeReply, remindPatch } from "./mailcards";
import { mergeSettings, settingsWrite } from "./cardsync";
import { LIST_KEYS, carrySettings } from "./keepunknown";
import { cleanRuleEntry, mergeSender, setRule, type MailSender, type RuleList } from "./mailrules";
import { addToLog, DAY_ENDS_DEFAULT, mergeDayLog, workDayOf, type DayLog } from "./daylog";
import { addEvent, historyOn, type EvKind } from "./taskhist";
import { feature } from "./features";
import { dndApply, type DndOp } from "./dnd";
import { overdueZone } from "./overdue";
import { autoResetDue, resetDayOf, resetMinOf } from "./resetday";
import { planReset } from "./resetplan";
import { cleanTzPerson, type TzPerson } from "./tzpeople";
import { cleanTzZones, sameZones, zonesOf, type TzZones } from "./tzzones";
import type { Zone } from "./tz";
import { carryUnknown, cleanLayout, isDefault, pickLayout, sameLayout, type TabLayout } from "./tablayout";
import { carryUnknownPhone, cleanPhoneLayout, isDefaultPhone, pickPhoneLayout, samePhoneLayout, type PhoneLayout } from "./phonelayout";
import { cleanPhoneDev, shouldBeat, type PhoneDev } from "./phonedevices";
import * as Dev from "./devicebg";
import { cleanMonth, mergeMonth } from "./monthhist";
import { cleanLive, cleanTMonth, mergeLive, mergeTMonth } from "./timeest";
import { clockFinish, clockStart, clockStop, clockStopAll, clockUntick, learnedEst } from "./timesave";
import { cleanRemind, mergeRemind, pickRemind, sameRemind, type RemindRec } from "./remind";
import { buildExamples, examplesLeft, withoutExamples, type ExampleState } from "./examples";

const now = () => new Date().toISOString();

// Two devices writing the settings or a reply record join their copies, so a Dismiss on one is never undone
// by the other's older copy (core/cardsync.ts).
setMerger("settings", (a, b) => { const out = mergeSettings(a as Settings, b as Settings, settingsDirty(), settingsBase()); rebase(b as Settings); return out; });
setMerger("reply", (a, b) => mergeReply(a as Reply, b as Reply));
setMerger("msender", (a, b) => mergeSender(a as MailSender, b as MailSender));
setMerger("daylog", (a, b) => mergeDayLog(a as DayLog, b as DayLog));
setMerger("mhist", (a, b) => { const x = cleanMonth(a), y = cleanMonth(b); return x && y ? mergeMonth(x, y) : (x || y || a); });
setMerger("remind", (a, b) => mergeRemind(cleanRemind(a), cleanRemind(b)));
// Time spent (PS 1.65, core/timeest.ts): the live clocks and each month's finishes merge, so two devices never undo each other.
setMerger("ttime", (a, b) => {
  if ((a as { t?: unknown })?.t === "live" && (b as { t?: unknown })?.t === "live") return mergeLive(cleanLive(a), cleanLive(b));
  const x = cleanTMonth(a), y = cleanTMonth(b);
  return x && y && x.mo === y.mo ? mergeTMonth(x, y) : (x || y || a);
});

// ---------- settings ----------
// One settings save at a time: put() encrypts before the new copy lands in memory, so two saves
// fired back to back (eg Dimension X moving a card onto Urgent: aware, then dimx) would each
// start from the old settings and the second would undo the first.
let settingsLane: Promise<unknown> = Promise.resolve();
function firstDownload(ms = 20_000): Promise<void> {
  return new Promise((done) => {
    if (vaultStore.get().lastSync) return done();
    const t = setTimeout(() => { off(); done(); }, ms);
    const off = vaultStore.subscribe(() => { if (vaultStore.get().lastSync) { clearTimeout(t); off(); done(); } });
  });
}
/** Do Not Disturb (core/dnd.ts): one action on the newest state, so the Mac and the phone never undo each other. */
export function setDnd(o: DndOp): Promise<void> {
  return saveSettings({ dnd: dndApply(settings(vaultStore.get())?.data?.dnd, o) });
}

// ---------- task history (PS 1.65, core/taskhist.ts) ----------
// What was added, deleted or moved to Dimension X goes on the day log of its day (the same owner only, sealed record the Reset
// writes). One at a time, so two events fired together never undo each other. Never allowed to break the action it follows.
let eventLane: Promise<unknown> = Promise.resolve();
export function eventDay(at: number, st: Settings | undefined | null): string {
  if (st?.autoReset === "midnight") return resetDayOf(at, overdueZone(st?.tmHomeTz), resetMinOf(st));
  return workDayOf(at, st?.dayEndsHour ?? DAY_ENDS_DEFAULT);
}
export function logTaskEvent(kind: EvKind, ev: { id: string; title: string; p1?: boolean; clientId?: string | null }): Promise<void> {
  const run = async () => {
    try {
      if (!feature("fuller-history") || !historyOn(settings(vaultStore.get())?.data)) return;
      const t = Date.now();
      const date = eventDay(t, settings(vaultStore.get())?.data);
      const prev = dayLogs(vaultStore.get()).get(date);
      const next = addEvent(prev?.data, date, kind, ev, new Date(t).toISOString());
      if (next) await put<DayLog>("daylog", next, { id: prev?.id, ws: null });
    } catch { /* history is a bonus, never a reason to fail */ }
  };
  const p = eventLane.then(run, run);
  eventLane = p.catch(() => {});
  return p;
}

/** A card the person moved into Dimension X (never the Urgent migration or a list sent from the Mac or phone). */
export const noteDimxMove = (id: string, title: string): Promise<void> => logTaskEvent("dimx", { id, title });

// PS 1.68: the settings this device changed and has not sent yet (core/cardsync.ts mergeSettings). When the server has a
// newer copy, only these come from this device's copy; everything else (pages made on the Mac, a choice made on the
// phone) stays as the server has it. Kept in localStorage too, so a change waiting from before a restart still knows.
const DIRTY_KEY = "ps.settingsDirty";
let dirty: Set<string> | null = null;
function settingsDirty(): Set<string> | undefined {
  if (!dirty) { try { const v = JSON.parse(localStorage.getItem(DIRTY_KEY) || "null"); if (Array.isArray(v)) dirty = new Set(v.filter((x): x is string => typeof x === "string").slice(0, 400)); } catch { /* no storage: as before */ } }
  return dirty ?? undefined;
}
function noteDirty(keys: string[], sentBefore: boolean, before?: Settings) {
  const d = sentBefore ? new Set<string>() : settingsDirty() ?? new Set<string>();
  // PS 1.71: a list (pages, their order, sections, groups) as it was here before its first unsent change: the base
  // core/keepunknown.ts mergeLists merges from, so a list changed on an old copy never drops what other devices made.
  const b = sentBefore ? {} : { ...(settingsBase() ?? {}) };
  for (const k of keys) {
    if (LIST_KEYS.has(k) && !d.has(k)) b[k] = (before as unknown as Record<string, unknown> | undefined)?.[k] ?? null;
    d.add(k);
  }
  dirty = d;
  setBase(b);
  try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...d])); } catch { /* in memory only */ }
}
const BASE_KEY = "ps.settingsBase";
let base: Record<string, unknown> | null = null;
function settingsBase(): Record<string, unknown> | undefined {
  if (!base) { try { const v = JSON.parse(localStorage.getItem(BASE_KEY) || "null"); if (v && typeof v === "object" && !Array.isArray(v)) base = v; } catch { /* no storage */ } }
  return base ?? undefined;
}
function setBase(b: Record<string, unknown>) {
  base = b;
  try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); } catch { /* in memory only */ }
}
/** The server's copy was just merged in: it is the base for the next merge (what it removed since is then removed). */
function rebase(remote: Settings) {
  const b = settingsBase();
  if (!b) return;
  const r = remote as unknown as Record<string, unknown>, n = { ...b };
  for (const k of Object.keys(b)) n[k] = r[k] ?? null;
  setBase(n);
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  const run = async () => {
    // No settings yet and nothing downloaded yet: wait for the first download instead of starting a
    // second settings record (that is how the phone got its own and lost the developer's rules).
    if (!settings(vaultStore.get())) await firstDownload();
    const snap = vaultStore.get();
    const s = settings(snap);
    // PS 1.68: still none (the download took longer than the wait): only the change goes in, never the defaults, so it
    // can never put the real record's choices back to their defaults when that arrives (core/cardsync.ts settingsWrite).
    // PS 1.71 (core/keepunknown.ts): pages, sections, groups and fields this build cannot read stay as they are stored.
    const w = settingsWrite(s?.data, carrySettings(s?.data, patch), DEFAULT_SETTINGS, !!snap.lastSync);
    // What was sent before is on the server: the list starts again with this change (a record not sent yet keeps adding).
    noteDirty(w.changed, !s?.pending, s?.data);
    await put<Settings>("settings", w.data, { id: s?.id, ws: null });
    for (const id of extraSettingsIds(vaultStore.get())) await remove(id);   // folded into the one kept
  };
  const p = settingsLane.then(run, run);
  settingsLane = p.catch(() => {});
  return p;
}

// ---------- the Annoying 15 min reminders (core/remind.ts) ----------
// Their own small record (never the big settings record), written only when something really changed. `change` gets
// the newest copy (merged) and returns the next one, so an answer from the phone that just arrived is never lost.
let remindLane: Promise<unknown> = Promise.resolve();
export function saveRemind(change: (rec: RemindRec | null) => RemindRec | null, newId?: string): Promise<void> {
  const run = async () => {
    if (!docs<RemindRec>("remind", null).length && !settings(vaultStore.get())) await firstDownload();
    const { keep, extra, rec, stale } = pickRemind(docs<RemindRec>("remind", null));
    const next = change(rec);
    if (!next) return;
    const data = cleanRemind(next);
    if (rec && keep && !extra.length && !stale && sameRemind(rec, data)) return;
    await put<RemindRec>("remind", data, { id: keep?.id ?? newId, ws: null });
    for (const d of extra) await remove(d.id);   // a second copy from two devices that each made one
  };
  const p = remindLane.then(run, run);
  remindLane = p.catch(() => {});
  return p;
}

// ---------- the Tab list's Edit mode (core/tablayout.ts) ----------
// Its own small record (never the big settings record), written only when a place really changed.
let layoutLane: Promise<unknown> = Promise.resolve();
export function saveTabLayout(next: TabLayout, newId?: string): Promise<void> {
  const run = async () => {
    // PS 1.68: never before the first download, so a layout made from nothing can never take the account's place.
    if (!docs<TabLayout>("tablayout", null).length && !vaultStore.get().lastSync) await firstDownload();
    const data = cleanLayout(next);
    const { keep, extra } = pickLayout(docs<TabLayout>("tablayout", null));
    if (keep && sameLayout(cleanLayout(keep.data), data)) return;
    if (!keep && isDefault(data)) return;   // V1.55: copies, pages, sizes and settings count as changes too
    // PS 1.68: what this build cannot show (a newer PS's panels and settings) stays in the record (core/tablayout.ts).
    await put<TabLayout>("tablayout", keep ? carryUnknown(keep.data, data) : data, { id: keep?.id ?? newId, ws: null });
    for (const d of extra) await remove(d.id);   // a second copy from a race between two Macs
  };
  const p = layoutLane.then(run, run);
  layoutLane = p.catch(() => {});
  return p;
}

// ---------- V1.56 the phone layout (core/phonelayout.ts) and the phones (core/phonedevices.ts) ----------
// One small record per phone kind, never the Mac's tablayout or the big settings record, written only when it changed.
let phoneLane: Promise<unknown> = Promise.resolve();
export function savePhoneLayout(next: PhoneLayout, newId?: string): Promise<void> {
  const run = async () => {
    const red = vaultStore.get().red;
    const data = cleanPhoneLayout(next, next.phone, red);
    const { keep, extra } = pickPhoneLayout(docs<PhoneLayout>("phonelayout", null), data.phone);
    if (keep && samePhoneLayout(cleanPhoneLayout(keep.data, data.phone, red), data, red)) return;
    if (!keep && isDefaultPhone(data, red)) return;
    // PS 1.71: pages, panels and buttons this build cannot draw stay in the record (core/phonelayout.ts carryUnknownPhone).
    await put<PhoneLayout>("phonelayout", keep ? carryUnknownPhone(keep.data, data, red) : data, { id: keep?.id ?? newId, ws: null });
    for (const d of extra) await remove(d.id);   // a second copy from two devices that each made one
  };
  const p = phoneLane.then(run, run);
  phoneLane = p.catch(() => {});
  return p;
}
/** This phone's own record (kind, name, screen, last seen): only when something changed or once a day. */
export async function beatPhoneDev(next: Omit<PhoneDev, "seen">): Promise<void> {
  const mine = docs<unknown>("phonedev", null).filter((d) => cleanPhoneDev(d.data)?.dev === next.dev);
  const prev = mine.map((d) => cleanPhoneDev(d.data)!).sort((a, b) => Date.parse(b.seen) - Date.parse(a.seen))[0] ?? null;
  if (!shouldBeat(prev, next)) return;
  await put<PhoneDev>("phonedev", { ...next, seen: now() }, { id: mine[0]?.id, ws: null });
  for (const d of mine.slice(1)) await remove(d.id);
}

// ---------- time zone people (core/tzpeople.ts) ----------
// One small record each, so a rename or a move uploads that one record and nothing else. Never a client record.
/** Someone added on the Time zones screen. Returns the new record's id. */
export function addTzPerson(p: { name: string; tz: string }): Promise<string> {
  const data = cleanTzPerson({ ...p, at: now() });
  if (!data) return Promise.reject(new Error("A name and a time zone, please."));
  return put<TzPerson>("tzperson", data, { ws: null });
}
/** Renamed, or moved to another zone. Nothing happens when nothing changed. */
export async function editTzPerson(id: string, patch: { name?: string; tz?: string }): Promise<void> {
  const d = doc<TzPerson>(id);
  if (!d || d.kind !== "tzperson") return;
  const data = cleanTzPerson({ ...d.data, ...patch });
  if (!data || (data.name === d.data.name && data.tz === d.data.tz)) return;
  await put<TzPerson>("tzperson", data, { id, ws: null });
}
/** Taken off. Undo adds them back as a new record with the same name, zone and date. */
export async function removeTzPerson(id: string): Promise<void> {
  if (doc(id)?.kind !== "tzperson") return;
  await remove(id);
}
export function restoreTzPerson(p: TzPerson): Promise<string> {
  const data = cleanTzPerson(p);
  if (!data) return Promise.reject(new Error("Nothing to put back."));
  return put<TzPerson>("tzperson", data, { ws: null });
}

// ---------- your time zones (core/tzzones.ts) ----------
// The whole list of clocks is one small record, so adding, taking off or moving a zone uploads just that.
// One change at a time, each made to the newest list (a quick Undo right after a remove builds on the remove).
let zonesLane: Promise<unknown> = Promise.resolve();
export function changeTzZones(change: (list: Zone[]) => Zone[]): Promise<void> {
  const run = async () => {
    // No list yet and nothing downloaded yet: wait for the first download, so a list saved on another
    // device is changed rather than replaced. (The PS Tab list and /dev have their copy already.)
    const st = vaultStore.get();
    if (!tzZonesDoc(st) && st.userId !== "ps-overlay" && st.userId !== "dev") await firstDownload(8000);
    const snap = vaultStore.get();
    const have = tzZonesDoc(snap);
    const before = zonesOf(have?.data);
    const next = change(before);
    if (sameZones(before, next)) return;
    const data = cleanTzZones({ zones: next, at: now() });
    if (!data) return;
    const id = await put<TzZones>("tzzones", data, { id: have?.id, ws: null });
    for (const d of vaultStore.get().docs.values()) if (d.kind === "tzzones" && d.id !== id) await remove(d.id);   // folded into this one
  };
  const p = zonesLane.then(run, run);
  zonesLane = p.catch(() => {});
  return p;
}

// ---------- clients ----------
// The name a client's portal shows for whoever runs the project. The developer's own workspaces carry none (his clients
// keep reading "Owner"); every other owner's carry their own first name from Settings, never the developer's.
function wsOwnerName(): { ownerName?: string } {
  const s = vaultStore.get();
  if (s.red || !roleConfirmed()) return {};
  const n = (settings(s)?.data.ownerName || "").trim();
  return { ownerName: n && n !== DEFAULT_SETTINGS.ownerName ? n : "your project lead" };
}
export async function addClient(input: { name: string; contactName?: string; email?: string; greetingName?: string; notes?: string; timezone?: string }): Promise<string> {
  const ws = await createWorkspace();
  await put<WsMeta>("wsmeta", { clientName: input.name, greetingName: input.greetingName || input.contactName?.split(" ")[0] || null, ...wsOwnerName() }, { ws });
  return put<ClientRec>("client", {
    name: input.name, ws, contactName: input.contactName || null, email: input.email || null,
    greetingName: input.greetingName || input.contactName?.split(" ")[0] || null,
    notes: input.notes || null, timezone: input.timezone || null, createdAt: now(),
  }, { ws: null });
}

// Client edits run one at a time, so two quick saves (eg a field saved on blur, then the
// modal's Save) never build on the same stale copy and drop each other's changes.
let clientQueue: Promise<unknown> = Promise.resolve();
export function updateClient(id: string, patch: Partial<ClientRec>): Promise<void> {
  const run = clientQueue.then(() => updateClientNow(id, patch));
  clientQueue = run.catch(() => undefined);
  return run;
}
async function updateClientNow(id: string, patch: Partial<ClientRec>) {
  const c = doc<ClientRec>(id);
  if (!c) return;
  const next = { ...c.data, ...patch };
  await put<ClientRec>("client", next, { id, ws: null });
  if (patch.name !== undefined || patch.greetingName !== undefined) {
    const meta = docs<WsMeta>("wsmeta", next.ws)[0];
    await put<WsMeta>("wsmeta", { clientName: next.name, greetingName: next.greetingName || null, ...wsOwnerName() }, { id: meta?.id, ws: next.ws });
  }
  if (patch.matchAddrs !== undefined || patch.email !== undefined) void rematchMail();
}

// ---------- Gmail replies ----------
export async function setReplyHandled(id: string, handled: boolean) {
  const r = doc<Reply>(id);
  if (!r) return;
  await put<Reply>("reply", { ...r.data, handled, handledAt: handled ? now() : null, handledHow: handled ? "you" : null }, { id, ws: null });
}

/** The developer dismissed the pop-up card for this email (on the Mac or the website): its card goes everywhere. */
export async function setReplySeen(id: string) {
  const r = doc<Reply>(id);
  if (!r || (r.data.seenAt && r.data.seenAt >= r.data.date)) return;
  await put<Reply>("reply", { ...r.data, seenAt: r.data.date }, { id, ws: null });
}

/** "Remind me in N mins" on a client email card: it leaves every device and comes back at that time. */
export async function setReplyRemind(id: string, mins: number, at = Date.now()) {
  const r = doc<Reply>(id);
  if (!r || !isUnseen(r.data, null)) return;   // dismissed already: a Dismiss always wins
  await put<Reply>("reply", { ...r.data, ...remindPatch(r.data, mins, at) }, { id, ws: null });
}

/** Gmail: put an address or a domain on Always notify me or Muted ("off" takes it off). Mail already waiting
 *  (the last 7 days) is looked at again, so a sender added now pops up for the email that just came. */
export async function setMailRule(entry: string, list: RuleList) {
  const e = cleanRuleEntry(entry);
  if ("error" in e) throw new Error(e.error);
  await saveSettings({ mailRules: setRule(settings(vaultStore.get())?.data.mailRules, e.v, list) });
  void rematchMail();
}

/** Link a sender (address or domain) to a client, so their mail shows up as replies. */
export async function addMatchAddr(clientId: string, entry: string) {
  const c = doc<ClientRec>(clientId);
  const e = parseMatchEntry(entry);
  if (!c || !e) throw new Error("That is not an email address or domain.");
  const list = c.data.matchAddrs || [];
  if (!list.includes(e.v)) await updateClient(clientId, { matchAddrs: [...list, e.v] });
}

// ---------- projects ----------
const HIDDEN_BY_DEFAULT = new Set(["lead", "proposal_sent"]);

export async function addProject(ws: string, type: ProjectType, title?: string, patch: Partial<Project> = {}): Promise<string> {
  const p = { ...newProject(type, title), ...patch };
  // Leads and unsigned proposals stay private (vault key) until the developer shows them to the client.
  const hidden = patch.clientVisible === false || (patch.clientVisible === undefined && HIDDEN_BY_DEFAULT.has(p.pipeline));
  p.clientVisible = !hidden;
  const id = hidden
    ? await put<Project>("project", { ...p, clientWs: ws }, { ws: null })
    : await put<Project>("project", { ...p, clientWs: null }, { ws });
  await put<ProjectPrivate>("pprivate", { projectId: id, history: [{ date: todayISO(), text: "Project created" }] }, { ws: null });
  return id;
}

export async function updateProject(id: string, patch: Partial<Project> | ((p: Project) => Project)) {
  const d = doc<Project>(id);
  if (!d) return;
  const next = typeof patch === "function" ? patch(structuredClone(d.data)) : { ...d.data, ...patch };
  await put<Project>("project", next, { id, ws: d.ws });
}

/**
 * Show or hide a project on the client's page. A hidden project is encrypted with the developer's own
 * vault key, so the client cannot decrypt it at all; showing it re-encrypts it under the
 * client's workspace key. Records cannot change scope, so this writes a new record, points
 * everything that referenced the old one at it, and removes the old one. Returns the new id.
 */
export async function setProjectVisible(projectId: string, visible: boolean): Promise<string> {
  const d = doc<Project>(projectId);
  if (!d) return projectId;
  const ws = d.ws ?? d.data.clientWs;
  if (!ws) throw new Error("This project is not linked to a client.");
  const isShared = d.ws !== null;
  if (visible === isShared) {
    if (d.data.clientVisible !== visible) await updateProject(projectId, { clientVisible: visible });
    return projectId;
  }
  const data: Project = { ...structuredClone(d.data), clientVisible: visible, clientWs: visible ? null : ws };
  const newId = await put<Project>("project", data, { ws: visible ? ws : null });
  for (const x of [...vaultStore.get().docs.values()]) {
    const dd = x.data as { projectId?: string | null };
    if (x.id === projectId || dd?.projectId !== projectId) continue;
    await put(x.kind, { ...dd, projectId: newId }, { id: x.id, ws: x.ws });
  }
  await remove(projectId);
  await updatePrivate(newId, {}, visible ? "Shown to the client" : "Hidden from the client");
  return newId;
}

function assertShared(projectId: string) {
  const d = doc<Project>(projectId);
  if (d && d.ws === null) throw new Error("This project is hidden from the client. Show it to them first.");
}

export function privOf(projectId: string): Doc<ProjectPrivate> | undefined {
  return docs<ProjectPrivate>("pprivate").find((p) => p.data.projectId === projectId);
}
export async function updatePrivate(projectId: string, patch: Partial<ProjectPrivate>, historyText?: string) {
  const d = privOf(projectId);
  const base: ProjectPrivate = d?.data ?? { projectId, history: [] };
  const history = historyText ? [{ date: todayISO(), text: historyText }, ...(base.history || [])].slice(0, 200) : base.history;
  await put<ProjectPrivate>("pprivate", { ...base, ...patch, projectId, history }, { id: d?.id, ws: null });
}

export async function setPipeline(projectId: string, pipeline: Pipeline) {
  await updateProject(projectId, { pipeline });
  await updatePrivate(projectId, {}, `Moved to ${pipeline.replace("_", " ")}`);
}

/** Move the tracker to stage index i (stamps doneAt on the stages before it). */
export async function setStage(projectId: string, i: number) {
  await updateProject(projectId, (p) => {
    const t = todayISO();
    p.stages = p.stages.map((s, j) => {
      if (j < i) return { ...s, doneAt: s.doneAt || t };
      return { ...s, doneAt: null };
    });
    p.current = Math.max(0, Math.min(i, p.stages.length));
    if (p.current >= p.stages.length) p.pipeline = p.type === "cro_retainer" ? "cro" : p.pipeline === "cro" ? "cro" : "live";
    return p;
  });
  const d = doc<Project>(projectId);
  const st = d?.data.stages[i];
  await updatePrivate(projectId, {}, st ? `Stage now: ${st.name}` : "All stages done");
}

export async function advanceStage(projectId: string) {
  const d = doc<Project>(projectId);
  if (d) await setStage(projectId, d.data.current + 1);
}

/** Push the promised delivery date, keeping a history of every change. */
export async function pushDelivery(projectId: string, to: string, reason?: string) {
  const d = doc<Project>(projectId);
  if (!d) return;
  await updateProject(projectId, (p) => {
    p.originalDelivery = p.originalDelivery || p.promisedDelivery || null;
    p.deliveryChanges = [{ from: p.promisedDelivery || null, to, reason: reason || null, at: now() }, ...(p.deliveryChanges || [])];
    p.promisedDelivery = to;
    return p;
  });
  await updatePrivate(projectId, {}, `Delivery moved to ${to}${reason ? ` (${reason})` : ""}`);
}

export async function shiftStageDates(projectId: string, fromIndex: number, days: number) {
  await updateProject(projectId, (p) => {
    p.stages = p.stages.map((s, j) => j < fromIndex ? s : {
      ...s,
      start: s.start ? addDays(s.start, days) : s.start,
      due: s.due ? addDays(s.due, days) : s.due,
    });
    return p;
  });
}

export async function addPreview(projectId: string, stageKey: string, pv: { label: string; url: string; note?: string; expiresAt?: string | null }) {
  await updateProject(projectId, (p) => {
    p.stages = p.stages.map((s) => s.key !== stageKey ? s : {
      ...s, previews: [...(s.previews || []), { id: uid(), label: pv.label, url: pv.url, note: pv.note || null, addedAt: now(), expiresAt: pv.expiresAt ?? null } as Preview],
    });
    return p;
  });
}
export async function removePreview(projectId: string, stageKey: string, previewId: string) {
  await updateProject(projectId, (p) => {
    p.stages = p.stages.map((s) => s.key !== stageKey ? s : { ...s, previews: s.previews.filter((x) => x.id !== previewId) });
    return p;
  });
}

export async function setPayments(projectId: string, payments: Payment[]) {
  await updateProject(projectId, { payments });
}
export async function markPaid(projectId: string, paymentId: string) {
  await updateProject(projectId, (p) => {
    p.payments = p.payments.map((x) => x.id === paymentId ? { ...x, status: "paid", paidAt: todayISO() } : x);
    return p;
  });
  await updatePrivate(projectId, {}, "Payment marked as paid");
}

export async function addClientTask(projectId: string, ws: string, t: { title: string; detail?: string; due?: string | null }) {
  assertShared(projectId);
  const n = docs<CTask>("ctask", ws).filter((x) => x.data.projectId === projectId).length;
  await put<CTask>("ctask", { projectId, title: t.title, detail: t.detail || null, due: t.due || null, order: n }, { ws });
}

export async function addUpdate(projectId: string, ws: string, u: Omit<Update, "projectId">) {
  assertShared(projectId);
  await put<Update>("update", { ...u, projectId }, { ws });
}

// ---------- client side actions (also used by the developer when previewing) ----------
export async function tickTask(taskId: string, ws: string, done: boolean, by?: string) {
  const mine = docs<Tick>("tick", ws).find((t) => t.data.taskId === taskId && t.author === vaultStore.get().userId);
  await put<Tick>("tick", { taskId, done, at: now(), by: by || null }, { id: mine?.id, ws });
}

export async function approveStage(projectId: string, ws: string, stageKey: string, gate: string, by: string, note?: string) {
  await put<Approval>("approval", { projectId, stageKey, gate, at: now(), by, note: note || null }, { ws });
}

// ---------- to-do list ----------
/** id (PS 1.68): an idea card that becomes a task gives the task its own id (core/dimxmove.ts). */
export async function addTodo(t: Partial<Todo> & { title: string }, opts: { id?: string } = {}) {
  // New tasks join the bottom of the list (drag them up to raise their priority).
  const list = todos(vaultStore.get());
  const order = t.order ?? (list.length ? Math.max(...list.map((x) => x.data.order ?? 0)) + 1 : 0);
  // PS 1.73 (the developer, 21 Nov 2026: "stop adding in priorities at random ... Just have them at the bottom"): a one-off task
  // added with no place and no priority picked has NO priority: no P number, at the bottom (core/prio.ts unranked).
  // Only Priority 1, an explicit place (a drag to a spot, a typed P2, a picked place) or the caller's own "unranked"
  // gives it one.
  t = { ...t, ...newTaskRank(t) };
  // Time estimates (PS 1.65, core/timeest.ts): a name used before gets the usual time, marked as learned ("Usually takes about").
  const usual = !t.example && t.est == null ? learnedEst(t.title) : null;
  const id = await put<Todo>("todo", {
    type: "once", done: false, source: "manual", ...t, ...(usual ? { est: usual, estBy: "past" as const } : {}), order, createdAt: now(),
  } as Todo, { ws: null, ...(opts.id ? { id: opts.id } : {}) });
  if (!t.example && id) void logTaskEvent("added", { id, title: t.title, p1: t.p1, clientId: t.clientId });
  return id;
}
/** Drag to reorder: the list's new order, top first. `p1` also sets the moved task's Priority 1
 *  flag in the same write (one write per task, so the order and the flag never race). */
export async function setTodoOrder(ids: string[], p1?: { id: string; on: boolean }, level?: { id: string; prioGroup: string | null }) {
  // A task with no priority yet gets one when it is dragged among the numbered tasks (and loses it
  // when dragged below one with none), see core/prio.ts.
  const docsNow = ids.map((id) => doc<Todo>(id)).filter((d): d is Doc<Todo> => !!d && d.data.type !== "daily");
  const before = sortPrio(docsNow).map((d) => d.id);
  const moved = movedId(before, ids.filter((id) => before.includes(id)));
  const unranked = new Set(docsNow.filter((d) => d.data.unranked).map((d) => d.id));
  const nowUnranked = moved ? (p1?.id === moved && p1.on ? false : unrankedAfterMove(ids, moved, unranked)) : null;
  for (let i = 0; i < ids.length; i++) {
    const d = doc<Todo>(ids[i]);
    if (!d) continue;
    const flag = p1 && p1.id === d.id && !!d.data.p1 !== p1.on;
    const rank = moved === d.id && nowUnranked !== null && !!d.data.unranked !== nowUnranked;
    // PS 1.73: the moved task's priority level (core/prio.ts levelAfterMove); none once it is P1 or has no priority.
    const lvFor = level && level.id === d.id ? ((p1?.id === d.id && p1.on) || (moved === d.id && nowUnranked) ? null : level.prioGroup) : undefined;
    const lv = lvFor !== undefined && (d.data.prioGroup ?? null) !== lvFor;
    if (d.data.order !== i || flag || rank || lv)
      await put<Todo>("todo", { ...d.data, order: i, ...(flag ? { p1: p1!.on } : {}), ...(rank ? { unranked: nowUnranked! } : {}), ...(lv ? { prioGroup: lvFor } : {}) }, { id: d.id, ws: null });
  }
}
/** Tab list (core/groups.ts): tasks dragged into a section, or out into a new group (made first,
 *  with the whole new section order). */
export async function moveTasks(m: TaskMove, make?: { group: TaskGroup; order: string[]; page?: string; pageName?: string; pageOrder?: string[] }) {
  if (make) {
    const st = settings(vaultStore.get())?.data;
    const groups = cleanGroups(st?.tmGroups);
    const [g] = cleanGroups([make.group]);
    if (!g || groups.length >= 30) return;
    // V1.55: made on one of the developer's own lists, the group stays on that list; with pageName that list is new and made
    // here too (Move to list, New list). Same one write (core/lists.ts).
    const pages = cleanPages(st?.tmPages), key = groupKey(g.id);
    const onPage = !make.page ? {} : pages.some((p) => p.id === make.page) ? { tmPages: moveSec(pages, key, make.page) }
      : make.pageName ? { tmPages: addPage(pages, { id: make.page, name: make.pageName, secs: [key] }), ...(make.pageOrder ? { tmPageOrder: make.pageOrder } : {}) } : {};
    if (!groups.some((x) => x.id === g.id)) await saveSettings({ tmGroups: [...groups, g], tmSecOrder: cleanSecOrder(make.order), ...onPage });
    m = { ...m, to: groupKey(g.id) };
  }
  // PS 1.68: a task dragged out of the AI Inbox in Dimension X joins the section and leaves the inbox in one write.
  const inbox = m.inbox ? todos(vaultStore.get()).filter((d) => m.ids.includes(d.id) && d.data.aiInbox === true) : [];
  await writeMoves(planMove(tabListsNow(), m, inbox));
}
/** A group taken apart: its tasks go back to Priorities or Every day, then the group goes. */
export async function ungroupTasks(id: string) {
  await writeMoves(planUngroup(tabListsNow(), id));
  const st = settings(vaultStore.get())?.data;
  await saveSettings({ tmGroups: cleanGroups(st?.tmGroups).filter((g) => g.id !== id), tmSecOrder: cleanSecOrder(st?.tmSecOrder).filter((k) => k !== groupKey(id)) });
}
function tabListsNow() {
  const s = vaultStore.get();
  const st = settings(s)?.data;
  return tabLists(todos(s), cleanGroups(st?.tmGroups), todayISO(), { now: Date.now(), tz: overdueZone(st?.tmHomeTz) }, landDay?.(s));   // the list as shown (overdue tasks are on their own card)
}
async function writeMoves(list: { id: string; patch: Partial<Todo> }[]) {
  for (const w of list) {
    const d = doc<Todo>(w.id);
    if (d) await put<Todo>("todo", { ...d.data, ...w.patch }, { id: d.id, ws: null });
  }
}
/** Once, when Priority 1 became optional: the task that was on top (and so showed P1) keeps P1. */
/** Once: a screen wide look saved as the outline (before 18 Oct 2026) becomes the background. */
export async function migrateLooks() {
  const st = settings(vaultStore.get())?.data;
  const old = st?.tmP1Style ? OLD_SCENES[st.tmP1Style] : undefined;
  if (!st || !old) return;
  await saveSettings({ tmP1Style: old.outline, ...(st.tmBg ? {} : { tmBg: old.bg }) });
}
/** Once per account (PS 1.67, core/islandon.ts): an island switched off goes back on, and the marker means a later Off stays off. */
let islandOnBusy = false;
export async function migrateIslandOn() {
  const patch = islandOnPatch(settings(vaultStore.get())?.data);
  if (!patch || islandOnBusy) return;
  islandOnBusy = true;
  await saveSettings(patch).finally(() => { islandOnBusy = false; });
}
let migratingP1 = false;
/** Clients (PS 1.73): the person's day by their day end (src/clients/clientsday.ts sets it), so the list as shown lands client tasks
 *  at the day end. Set from outside: that file reads the countdown, which reads this one. */
let landDay: ((s: ReturnType<typeof vaultStore.get>) => string) | null = null;
export function setLandDay(f: typeof landDay) { landDay = f; }
export async function migrateP1() {
  const st = settings(vaultStore.get())?.data;
  if (!st || st.p1Migrated || migratingP1) return;
  migratingP1 = true;
  const open = todos(vaultStore.get()).filter((d) => d.data.type !== "daily" && !d.data.done).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  if (open[0] && !open.some((d) => d.data.p1)) await put<Todo>("todo", { ...open[0].data, p1: true }, { id: open[0].id, ws: null });
  await saveSettings({ p1Migrated: true }).finally(() => { migratingP1 = false; });
}
/** PS 1.73: one task's level tag only (the other half of a level that just became a group of two). */
export async function setLevelTag(id: string, prioGroup: string | null) {
  const d = doc<Todo>(id);
  if (d && (d.data.prioGroup ?? null) !== prioGroup) await put<Todo>("todo", { ...d.data, prioGroup }, { id, ws: null });
}
export async function updateTodo(id: string, patch: Partial<Todo>) {
  const d = doc<Todo>(id);
  if (d) await put<Todo>("todo", { ...d.data, ...patch }, { id, ws: null });
}
export async function toggleTodo(id: string) {
  const d = doc<Todo>(id);
  // Repeating tasks count their streak here (tick adds one, untick takes it back). Its mini tasks
  // are done with it; unticking it unticks the ones it ticked.
  if (d) {
    const p = tickPatch(d.data, now());
    const subs = tickParentSubs(d.data.subtasks, !!p.done, now(), d.data.type === "daily");   // PS 1.68: each mini task's streak too
    await updateTodo(id, subs ? { ...p, subtasks: subs } : p);
    // Time spent (core/timesave.ts): a tick ends the task's clock and keeps what it took; an untick takes that back. Never awaited.
    if (p.done) void clockFinish(id); else void clockUntick(id);
  }
  // Finishing a task you were working on clears its white highlight (the others stay).
  const ids = workingIdsOf(settings(vaultStore.get())?.data || {});
  if (d && !d.data.done && ids.includes(id)) { const next = ids.filter((x) => x !== id); await saveSettings({ workingIds: next, workingOn: next[0] ?? null }); }
}
/** A tick that says which way (V1.34): ticking a task already done (or unticking one already open) changes nothing,
 *  so a press sent twice, or a slow round trip from PS's Tab list, can never undo itself. */
export async function setTodoDone(id: string, done: boolean) {
  const d = doc<Todo>(id);
  if (!d || !!d.data.done === done) return;
  await toggleTodo(id);
}
/** Several tasks ticked or unticked at once (the Completed section's Resurrect and its Undo), one after another. */
export async function setTodosDone(ids: string[], done: boolean) {
  for (const id of ids) await setTodoDone(id, done);
}
/** Clear in the Completed section: those finished one-offs are cleared as a Reset would (kept, so Undo works). */
export async function clearTodos(ids: string[], on = true) {
  const t = new Date().toISOString();
  for (const id of ids) {
    const d = doc<Todo>(id);
    if (!d || d.data.type !== "once" || (on ? !d.data.done || !!d.data.clearedAt : !d.data.clearedAt)) continue;
    await put<Todo>("todo", { ...d.data, clearedAt: on ? t : null }, { id, ws: null });
  }
}
/** Resurrect (V1.47): tasks a reset, End day or Clear took off come back on the list, open; ones still in Completed
 *  are just unticked. One after another, so each write sees the last. */
export async function reviveTodos(ids: string[]) {
  for (const id of ids) {
    const d = doc<Todo>(id);
    if (!d || d.data.type !== "once") continue;
    if (d.data.clearedAt) await put<Todo>("todo", { ...d.data, clearedAt: null }, { id, ws: null });
    await setTodoDone(id, false);
  }
}
/** Resurrect's Undo: done again, and the ones that were cleared cleared again. */
export async function buryTodos(ids: string[], cleared: string[]) {
  await setTodosDone(ids, true);
  if (cleared.length) await clearTodos(cleared, true);
}
/** A task deleted from the right click menu, put back by Undo with its own id and everything it had. */
export async function restoreTodo(id: string, data: Todo) {
  if (doc<Todo>(id)) return;
  await put<Todo>("todo", data, { id, ws: null });
}
export async function pushTodo(id: string, days: number | string) {
  const d = doc<Todo>(id);
  if (!d) return;
  const base = d.data.due && d.data.due > todayISO() ? d.data.due : todayISO();
  const due = typeof days === "string" ? days : addDays(base, days);
  await updateTodo(id, { due, pushes: (d.data.pushes || 0) + 1 });
}
/** One change to a task's mini tasks, applied to its newest copy. One at a time, so a quick run
 *  of changes (Enter, Enter, Enter) never loses one. */
let subLane: Promise<unknown> = Promise.resolve();
export function subtaskOp(id: string, op: SubOp): Promise<void> {
  const run = async () => {
    const d = doc<Todo>(id);
    if (!d) return;
    await put<Todo>("todo", withSubOp(d.data, op, now()), { id, ws: null });   // only its mini tasks change (core/subtasks.ts)
  };
  const p = subLane.then(run, run);
  subLane = p.catch(() => {});
  return p;
}
// ---------- Dimension X: a task becomes an idea, an idea becomes a task (PS 1.68, core/dimxmove.ts) ----------
// One lane, so two moves (or a move and its tidy) never read the same old copy. Each move writes the new place first and
// only then takes the old one away, so nothing is ever lost; the item keeps its id both ways, so a move cut in half is
// found and finished by tidyMoves, and a move sent twice adds nothing the second time.
let dimxLane: Promise<unknown> = Promise.resolve();
function inDimxLane(f: () => Promise<void>): Promise<void> {
  const p = dimxLane.then(f, f);
  dimxLane = p.catch(() => {});
  return p;
}
/** A task (or an AI Inbox task) becomes an idea card in `zone` at `index` (counted in that band). */
export function moveTaskToIdea(id: string, zone: DimxZone, index: number): Promise<void> {
  return inDimxLane(async () => {
    const t = doc<Todo>(id), st = settings(vaultStore.get())?.data;
    if (!t || t.kind !== "todo" || !st) return;   // gone already: the same move ran before
    const dimx = st.dimx || [];
    const next = taskToIdea(dimx, { id, title: t.data.title }, zone, index, now());
    if (next !== dimx) await saveSettings({ dimx: next });
    await deleteTodo(id, { moved: true });
    void noteDimxMove(id, t.data.title);
    await tidyNow();
  });
}
/** An idea card becomes a task with the card's id, at `order` (p1: in the Priority 1 group). */
export function moveIdeaToTask(id: string, place: { order: number; p1?: boolean }): Promise<void> {
  return inDimxLane(async () => {
    const st = settings(vaultStore.get())?.data;
    const card = st?.dimx?.find((x) => x.id === id);
    if (!st || !card) return;   // gone already: the same move ran before
    const have = doc(id);
    if (!have) await addTodo({ title: card.text.slice(0, 500), due: null, type: "once", order: place.order, ...(place.p1 ? { p1: true } : {}) }, { id });
    else if (have.kind !== "todo") await addTodo({ title: card.text.slice(0, 500), due: null, type: "once", order: place.order, ...(place.p1 ? { p1: true } : {}) });
    const now2 = settings(vaultStore.get())?.data;
    await saveSettings({ dimx: (now2?.dimx || []).filter((x) => x.id !== id) });
    await tidyNow();
  });
}
/** Finishes half done moves (core/dimxmove.ts moveLeftovers): only a card and a task with the same id and words. */
export function tidyMoves(): Promise<void> { return inDimxLane(tidyNow); }
async function tidyNow() {
  const s = vaultStore.get(), st = settings(s)?.data;
  if (!st?.dimx?.length) return;
  const l = moveLeftovers(st.dimx, todos(s));
  if (l.dimx) await saveSettings({ dimx: l.dimx });
  for (const id of l.tasks) await deleteTodo(id, { moved: true });
}

/** moved: the task is leaving for Dimension X, which is one move (noted by noteDimxMove), not also a delete. */
export async function deleteTodo(id: string, o: { moved?: boolean } = {}) {
  const d = doc<Todo>(id);
  await remove(id);
  if (d?.data && !d.data.example && !o.moved) void logTaskEvent("deleted", { id, title: d.data.title, p1: d.data.p1, clientId: d.data.clientId });
}

/**
 * RESET (core/resetplan.ts says what it does to each task). Returns an undo function.
 * auto: the automatic Reset at your reset time (core/resetday.ts): each tick is filed into its own day and anything
 * ticked since today started is left alone.
 */
export async function resetTodos(opts: { auto?: boolean } = {}): Promise<() => Promise<void>> {
  const list = todos(vaultStore.get());
  const t = now();
  const before = list.map((d) => ({ id: d.id, data: structuredClone(d.data) }));
  const st = settings(vaultStore.get())?.data;
  const plan = planReset(list, { at: t, tz: overdueZone(st?.tmHomeTz), atMin: resetMinOf(st), auto: opts.auto, dayEndsHour: st?.dayEndsHour });
  // History first: every ticked task goes into the log of its day.
  const logUndo: { prev: Doc<DayLog> | undefined; id: string | null }[] = [];
  const recordMissed = feature("fuller-history") && historyOn(st);
  const logDays = new Map(plan.logs);
  if (recordMissed && !logDays.has(plan.missedDay)) logDays.set(plan.missedDay, []);   // a day with nothing ticked still gets its missed list
  for (const [date, its] of logDays) {
    const prevLog = dayLogs(vaultStore.get()).get(date);
    const nextLog = addToLog(prevLog?.data, date, its, t, date === plan.missedDay && recordMissed ? plan.missed : undefined);
    if (!nextLog) continue;
    logUndo.push({ prev: prevLog, id: await put<DayLog>("daylog", nextLog, { id: prevLog?.id, ws: null }) });
  }
  for (const x of plan.puts) await put<Todo>("todo", x.data, { id: x.id, ws: null });
  await saveSettings({ lastResetAt: t, lastResetDay: plan.today });
  return async () => {
    for (const b of before) await put<Todo>("todo", b.data, { id: b.id, ws: null });
    for (const l of logUndo) {
      if (l.prev) await put<DayLog>("daylog", l.prev.data, { id: l.prev.id, ws: null });
      else if (l.id) await remove(l.id);
    }
  };
}

// ---------- suggested tasks (Claude never adds to the list itself) ----------
// New tasks wait in settings.suggestions until the developer accepts or declines each one (the New tasks
// pop-up in the Tab list). Every change runs one after another: Accept all fires several at once
// and each one rewrites the whole list, so two at the same time would lose one.
let suggestLane: Promise<unknown> = Promise.resolve();
function inLane<T>(f: () => Promise<T>): Promise<T> {
  const p = suggestLane.then(f, f);
  suggestLane = p.catch(() => {});
  return p;
}
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export function suggestTodo(s: Omit<Suggestion, "id" | "createdAt">) {
  return inLane(async () => {
    const list = settings(vaultStore.get())?.data.suggestions || [];
    const open = todos(vaultStore.get()).some((d) => !d.data.done && sameTitle(d.data.title, s.title));
    if (open || list.some((x) => sameTitle(x.title, s.title))) return;
    await saveSettings({ suggestions: [...list, { ...s, id: crypto.randomUUID(), createdAt: now() }] });
  });
}
/**
 * Add Telegram Bot (V1.47, src/tgbot.ts): tasks the person texted their own bot go straight where they said, with no
 * New tasks pop-up (that pop-up is the developer's own AT bot): Urgent, a Dimension X band, or the list at the P1, P2 or P3 they
 * typed (core/typedprio.ts typedOrder, like the add box) and due today or tomorrow. Without a P it waits below the
 * numbered tasks like a task added with no priority. Ids are chosen by the caller from the bot and the message, so the
 * same message read twice (two devices, a retry) adds nothing. Returns what was added, for Undo.
 */
export type BotAdd = { id: string; text: string; urgent: boolean; zone: DimxZone | null; prio: 1 | 2 | 3 | null; due: "today" | "tomorrow" | null };
export type BotRef = { k: "todo" | "aware" | "dimx"; id: string; title: string };
export function addBotTasks(list: BotAdd[]): Promise<BotRef[]> {
  return inLane(async () => {
    const out: BotRef[] = [];
    const st = settings(vaultStore.get())?.data;
    const aware = [...(st?.aware || [])], dimx = [...(st?.dimx || [])];
    let touched = false;
    for (const t of list) {
      const title = t.text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
      if (!title) continue;
      if (t.urgent) {
        if (aware.some((a) => a.id === t.id)) continue;
        aware.push({ id: t.id, text: title.slice(0, 300), createdAt: now() }); touched = true;
        out.push({ k: "aware", id: t.id, title }); continue;
      }
      if (t.zone) {
        if (dimx.some((d) => d.id === t.id)) continue;
        dimx.push({ id: t.id, text: title, zone: t.zone, createdAt: now() }); touched = true;
        out.push({ k: "dimx", id: t.id, title }); continue;
      }
      if (doc(t.id)) continue;
      const all = todos(vaultStore.get());
      const ranked = sortPrio(all.filter((d) => d.data.type !== "daily" && !d.data.done && !d.data.group));
      const due = t.due === "today" ? todayISO() : t.due === "tomorrow" ? addDays(todayISO(), 1) : null;
      const at = t.prio ? typedOrder(ranked.map((d) => d.data), t.prio) : null;
      const order = at ? at.order : all.length ? Math.max(...all.map((x) => x.data.order ?? 0)) + 1 : 0;
      await put<Todo>("todo", {
        title, type: "once", done: false, source: "manual", due, order, createdAt: now(),
        ...(at?.p1 ? { p1: true } : {}), ...(at ? {} : { unranked: true }), ...(at?.prioGroup ? { prioGroup: at.prioGroup } : {}),
      } as Todo, { id: t.id, ws: null });
      if (at?.pair) await setLevelTag(at.pair.id, at.pair.prioGroup);
      out.push({ k: "todo", id: t.id, title });
    }
    if (touched) await saveSettings({ aware, dimx });
    return out;
  });
}
/** Undo for addBotTasks: whatever of it is still there goes. Returns the titles taken away. */
export function removeBotTasks(refs: BotRef[]): Promise<string[]> {
  return inLane(async () => {
    const gone: string[] = [];
    const st = settings(vaultStore.get())?.data;
    const ids = (k: BotRef["k"]) => new Set(refs.filter((r) => r.k === k).map((r) => r.id));
    const aw = ids("aware"), dx = ids("dimx");
    const aware = (st?.aware || []).filter((a) => !aw.has(a.id)), dimx = (st?.dimx || []).filter((d) => !dx.has(d.id));
    for (const r of refs) {
      if (r.k === "todo" && doc(r.id)) { await remove(r.id); gone.push(r.title); }
      if (r.k === "aware" && st?.aware?.some((a) => a.id === r.id)) gone.push(r.title);
      if (r.k === "dimx" && st?.dimx?.some((d) => d.id === r.id)) gone.push(r.title);
    }
    if (aware.length !== (st?.aware || []).length || dimx.length !== (st?.dimx || []).length) await saveSettings({ aware, dimx });
    return gone;
  });
}
/** Add a suggestion to the list. `place` is where it was dropped: which list and its order there. */
export function approveSuggestion(id: string, place?: { type: "daily" | "once"; order: number; p1?: boolean }) {
  return inLane(async () => {
    const list = settings(vaultStore.get())?.data.suggestions || [];
    const s = list.find((x) => x.id === id);
    if (!s) return;
    await saveSettings({ suggestions: list.filter((x) => x.id !== id) });
    const type = place?.type ?? s.type;
    await addTodo({ title: s.title, type, due: type === "daily" ? null : s.due ?? null, clientId: s.clientId ?? null, source: "manual",
      ...(place && Number.isFinite(place.order) ? { order: place.order } : {}),
      ...(place?.p1 && type === "once" ? { p1: true } : {}),   // dropped inside the Priority 1 outline
      ...(s.claudeDone ? { claudeDoneAt: now(), claudeNote: s.note ?? null } : {}) });
  });
}
/** Accept a suggestion onto Urgent (settings.aware; ASAP ones go here by default): one save moves it across. */
export function suggestionToAware(id: string) {
  return inLane(async () => {
    const st = settings(vaultStore.get())?.data;
    const s = st?.suggestions?.find((x) => x.id === id);
    if (!st || !s) return;
    const aware = st.aware || [];
    await saveSettings({
      suggestions: (st.suggestions || []).filter((x) => x.id !== id),
      aware: aware.some((a) => a.id === s.id) ? aware : [...aware, { id: s.id, text: s.title.slice(0, 300), createdAt: now() }],
    });
  });
}
/** Accept a suggestion into a Dimension X band (act, soon, x): one save moves it across. */
export function suggestionToDimx(id: string, zone: DimxZone) {
  return inLane(async () => {
    const st = settings(vaultStore.get())?.data;
    const s = st?.suggestions?.find((x) => x.id === id);
    if (!st || !s) return;
    const dimx = st.dimx || [];
    const fresh = !dimx.some((d) => d.id === s.id);
    await saveSettings({
      suggestions: (st.suggestions || []).filter((x) => x.id !== id),
      dimx: fresh ? [...dimx, { id: s.id, text: s.title.slice(0, 500), zone, createdAt: now() }] : dimx,
    });
    if (fresh) void noteDimxMove(s.id, s.title);
  });
}
/**
 * Urgent item done (its tick): it leaves Urgent and joins the list as a FINISHED task (todoId is
 * picked by the caller so Undo can find it), so it shows in Done and counts toward the day.
 */
export function awareDone(id: string, todoId: string) {
  return inLane(async () => {
    const st = settings(vaultStore.get())?.data;
    const a = st?.aware?.find((x) => x.id === id);
    if (!st || !a) return;
    await saveSettings({ aware: (st.aware || []).filter((x) => x.id !== id) });
    const list = todos(vaultStore.get());
    const order = list.length ? Math.max(...list.map((x) => x.data.order ?? 0)) + 1 : 0;
    if (!doc(todoId)) await put<Todo>("todo", { title: a.text.slice(0, 500), type: "once", done: true, doneAt: now(), source: "manual", order, createdAt: now() }, { id: todoId, ws: null });
  });
}
/** Undo for awareDone: back on Urgent where it was, the finished task removed. */
export function awareUndone(item: AwareItem, index: number, todoId: string) {
  return inLane(async () => {
    const aware = settings(vaultStore.get())?.data.aware || [];
    if (!aware.some((x) => x.id === item.id)) await saveSettings({ aware: [...aware.slice(0, index), item, ...aware.slice(index)] });
    if (doc(todoId)) await remove(todoId);
  });
}
/** An Urgent item dragged onto the list: a task at that place (order), off Urgent, in one go. */
export function awareToList(id: string, order: number, type: "once" | "daily" = "once", p1 = false) {
  return inLane(async () => {
    const st = settings(vaultStore.get())?.data;
    const a = st?.aware?.find((x) => x.id === id);
    if (!st || !a) return;
    await addTodo({ title: a.text.slice(0, 500), type, due: null, order, ...(p1 && type === "once" ? { p1: true } : {}) });
    await saveSettings({ aware: (settings(vaultStore.get())?.data.aware || []).filter((x) => x.id !== id) });
  });
}
export function dismissSuggestion(id: string) {
  return inLane(async () => {
    const list = settings(vaultStore.get())?.data.suggestions || [];
    await saveSettings({ suggestions: list.filter((x) => x.id !== id) });
  });
}
/**
 * Once: tasks Claude had put straight on the list (added and purple ticked in the same moment, still
 * open) move into the suggestions, so the developer decides which ones he wants.
 */
export async function migrateClaudeAdds() {
  const st = settings(vaultStore.get())?.data;
  if (!st || st.suggestMigrated) return;
  const added = todos(vaultStore.get()).filter((d) => !d.data.done && !d.data.clearedAt && d.data.claudeDoneAt && d.data.createdAt
    && Math.abs(new Date(d.data.claudeDoneAt).getTime() - new Date(d.data.createdAt).getTime()) < 10_000);
  const list = [...(st.suggestions || [])];
  for (const d of added) {
    if (!list.some((x) => sameTitle(x.title, d.data.title)))
      list.push({ id: crypto.randomUUID(), title: d.data.title, type: d.data.type, due: d.data.due ?? null, clientId: d.data.clientId ?? null,
        note: d.data.claudeNote ?? null, claudeDone: true, createdAt: d.data.createdAt! });
  }
  await saveSettings({ suggestions: list, suggestMigrated: true });
  for (const d of added) await remove(d.id);
}

/** Optional automatic reset at your reset time, midnight unless you change it (off by default, the developer prefers the
 *  button). Called every minute and when PS starts, so a device that slept through the time catches up once. */
let autoResetting = false;
export async function maybeAutoReset() {
  const s = settings(vaultStore.get())?.data;
  if (!s || s.autoReset !== "midnight" || autoResetting) return;
  if (s.rules?.length) return;   // with rules written, only the rule check ends the day (views/RuleBook.tsx)
  if (!autoResetDue(s, Date.now(), overdueZone(s.tmHomeTz))) return;
  autoResetting = true;   // one at a time: the next minute's check waits for this one's lastResetDay
  try { await resetTodos({ auto: true }); } finally { autoResetting = false; }
}

export async function reorderTodo(id: string, dir: -1 | 1) {
  const list = todos(vaultStore.get());
  const i = list.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i], b = list[j];
  await put<Todo>("todo", { ...a.data, order: b.data.order }, { id: a.id, ws: null });
  await put<Todo>("todo", { ...b.data, order: a.data.order }, { id: b.id, ws: null });
}

// ---------- meetings ----------
export async function addMeeting(m: Omit<Meeting, "addedToTodo">) {
  return put<Meeting>("meeting", { ...m, addedToTodo: [] }, { ws: null });
}
export async function actionItemToTodo(meetingId: string, item: string, due?: string | null) {
  const m = doc<Meeting>(meetingId);
  if (!m) return;
  await addTodo({ title: item, source: "fireflies", due: due ?? null, clientId: m.data.clientId ?? null });
  await put<Meeting>("meeting", { ...m.data, addedToTodo: [...(m.data.addedToTodo || []), item] }, { id: meetingId, ws: null });
}

// ---------- email drafts (never sent by the app: Rule Zero) ----------
export async function saveDraft(d: Draft, id?: string) {
  return put<Draft>("draft", d, { id, ws: null });
}
export async function approveDraft(id: string) {
  const d = doc<Draft>(id);
  if (!d) return;
  await put<Draft>("draft", { ...d.data, status: "approved", approvedAt: now(), approvedText: `To: ${d.data.to || "(not set)"}\nSubject: ${d.data.subject}\n\n${d.data.body}` }, { id, ws: null });
}
export async function markDraftSent(id: string) {
  const d = doc<Draft>(id);
  if (d) await put<Draft>("draft", { ...d.data, status: "sent", sentAt: now() }, { id, ws: null });
}

// ---------- export one client's data (NDA 6.2 return of information) ----------
export function exportClient(clientId: string) {
  const s = vaultStore.get();
  const c = doc<ClientRec>(clientId);
  if (!c) return null;
  const pvs = projectViews(s, c.data.ws);
  const ids = new Set(pvs.map((p) => p.doc.id));
  const all = [...s.docs.values()].filter((d) =>
    d.ws === c.data.ws || d.id === clientId ||
    (d.kind === "pprivate" && ids.has((d.data as ProjectPrivate).projectId)) ||
    ((d.kind === "draft" || d.kind === "meeting" || d.kind === "todo" || d.kind === "reply") && (d.data as { clientId?: string }).clientId === clientId));
  return { exportedAt: now(), client: c.data.name, documents: all.map((d) => ({ id: d.id, kind: d.kind, data: d.data })) };
}

/** Owner private docs that belong to a client (removed when a client is destroyed). */
export function privateDocsOfClient(clientId: string): string[] {
  const s = vaultStore.get();
  const c = doc<ClientRec>(clientId);
  if (!c) return [];
  const ids = new Set(projectViews(s, c.data.ws).map((p) => p.doc.id));
  return [...s.docs.values()].filter((d) => d.id === clientId ||
    (d.kind === "pprivate" && ids.has((d.data as ProjectPrivate).projectId)) ||
    ((d.kind === "draft" || d.kind === "meeting" || d.kind === "todo" || d.kind === "reply") && (d.data as { clientId?: string }).clientId === clientId)).map((d) => d.id);
}

export { stagesFor };

// ---------- documents (proposal PDFs, agreements), encrypted like everything else ----------
export async function attachDoc(projectId: string, file: { bytes: Uint8Array; name: string; mime: string }, label: string, docKind: ProjectDoc["docKind"]) {
  const d = doc<Project>(projectId);
  if (!d) throw new Error("Project not found.");
  const ws = d.ws; // null for a hidden project: the file is then encrypted with the vault key
  const blobId = await putBlob(ws, file.bytes);
  return put<ProjectDoc>("doc", {
    projectId, blobId, name: file.name, mime: file.mime || "application/pdf", size: file.bytes.length,
    label, docKind, addedAt: now(),
  }, { ws });
}
export async function removeDoc(docId: string) {
  const d = doc<ProjectDoc>(docId);
  if (!d) return;
  await remove(docId);
  await deleteBlob(d.data.blobId).catch(() => {});
}

// ---------- agendas (To-do page) ----------
export async function addAgenda(title: string) {
  const { current } = agendas(vaultStore.get());
  return put<Agenda>("agenda", { title: title.trim() || "New agenda", startedAt: todayISO(), endedAt: null, order: current.length }, { ws: null });
}
export async function updateAgenda(id: string, patch: Partial<Agenda>) {
  const d = doc<Agenda>(id);
  if (!d) return;
  await put<Agenda>("agenda", { ...d.data, ...patch }, { id, ws: null });
}
export const endAgenda = (id: string) => updateAgenda(id, { endedAt: todayISO() });
export const reopenAgenda = (id: string) => updateAgenda(id, { endedAt: null });
export const deleteAgenda = (id: string) => remove(id);

// ---------- series map (month titles, notes per day, week and month) ----------
// PS 1.74: one journal save at a time, on the newest copy, so a month title and a note saved back to back (or two
// titles from the Tab list's map) never start two records for one month; a second record left over is folded in.
let journalLane: Promise<unknown> = Promise.resolve();
export function setJournal(key: string, patch: { title?: string | null; note?: string | null }): Promise<void> {
  const run = async () => {
    const ex = journal(vaultStore.get()).get(key);
    const extra = [...vaultStore.get().docs.values()].filter((d) => d.kind === "journal" && (d.data as JournalEntry)?.key === key && d.id !== ex?.id) as Doc<JournalEntry>[];
    // A title or note only an older second record still has is kept, never removed with it.
    const kept = (f: "title" | "note") => ex?.data[f] || extra.map((d) => d.data[f]).find((v) => !!v?.trim()) || null;
    const next: JournalEntry = { key, title: kept("title"), note: kept("note"), ...patch, updatedAt: now() };
    if (!next.title?.trim() && !next.note?.trim()) { if (ex) await remove(ex.id); }
    else await put<JournalEntry>("journal", next, { id: ex?.id, ws: null });
    for (const d of extra) await remove(d.id);
  };
  const p = journalLane.then(run, run);
  journalLane = p.catch(() => {});
  return p;
}

// ---------- screen time (PS on the Mac, PS GOS on the phone) ----------
// Each device sends its own day's running totals every few minutes and saves only its own record
// (one per day per device). Keep the larger count per app (totals only grow), write only when
// something changed, one save at a time so a day never gets two records. The first save after
// unlock also splits the days both devices once wrote into one record (planSplit), once.
let screenTimeQueue: Promise<void> = Promise.resolve();
let screenTimeSplit = false;
export function saveScreenTime(day: string, apps: ScreenTimeApp[], device: ScreenTimeDevice, exact = false) {
  screenTimeQueue = screenTimeQueue.then(async () => {
    if (!screenTimeSplit) {
      const all = [...vaultStore.get().docs.values()].filter((d) => d.kind === "screentime") as Doc<ScreenTimeDay>[];
      for (const w of planSplit(all, device, now())) await put<ScreenTimeDay>("screentime", w.data, { id: w.id, ws: null });
      screenTimeSplit = true;
    }
    const ex = rawScreenTimeDays(vaultStore.get(), device).get(day);
    // Golden rule: 1Password and Signal never stay in a record (this also scrubs older ones).
    const list = nextApps(ex?.data, apps, device, exact);
    if (!list || (!list.length && !ex)) return;
    await put<ScreenTimeDay>("screentime", { day, device, apps: list, ...(exact || ex?.data.exact ? { exact: true } : {}), updatedAt: now() }, { id: ex?.id, ws: null });
  }).catch(() => { /* locked mid save: the device sends again in a few minutes */ });
  return screenTimeQueue;
}

// The screen time line (core/stline.ts): each device saves its own last day cut into hours, so the
// other device can draw the same timeline. At most once every 9 minutes per device, only the hours
// that changed (egress: a few small records an hour).
let lineQueue: Promise<void> = Promise.resolve();
const lineSent: Partial<Record<ScreenTimeDevice, number>> = {};
export function saveScreenLine(device: ScreenTimeDevice, tl: Timeline) {
  const at = Date.now();
  if (at - (lineSent[device] ?? 0) < 9 * 60_000) return lineQueue;
  lineSent[device] = at;
  lineQueue = lineQueue.then(async () => {
    const all = [...vaultStore.get().docs.values()].filter((d) => d.kind === "stline") as Doc<StLine>[];
    for (const w of planLines(all, toHours(tl, device, now()))) await put<StLine>("stline", w.data, { id: w.id, ws: null });
  }).catch(() => { lineSent[device] = 0; /* locked mid save: the next count tries again */ });
  return lineQueue;
}

// ---------- quotes (To-do page) ----------
export async function addQuote(text: string, author?: string | null) {
  return put<Quote>("quote", { text: text.trim(), author: author?.trim() || null, order: quotes(vaultStore.get()).length, createdAt: now() }, { ws: null });
}
export async function updateQuote(id: string, patch: Partial<Quote>) {
  const d = doc<Quote>(id);
  if (d) await put<Quote>("quote", { ...d.data, ...patch }, { id, ws: null });
}
export const deleteQuote = (id: string) => remove(id);

// ---------- notes window ----------
export async function newNote(id?: string): Promise<string> {
  const t = now();
  return put<Note>("note", { title: "", html: "", createdAt: t, updatedAt: t, pinned: false, deletedAt: null }, { ...(id ? { id } : {}), ws: null });
}
export async function saveNote(id: string, patch: Partial<Note>) {
  const d = doc<Note>(id);
  if (!d) return;
  await put<Note>("note", { ...d.data, ...patch, updatedAt: patch.deletedAt !== undefined || patch.pinned !== undefined ? d.data.updatedAt : now() }, { id, ws: null });
}
/** Deleting is soft (Recently deleted); emptying a note that was never written removes it. */
export const trashNote = (id: string) => saveNote(id, { deletedAt: now() });
export const restoreNote = (id: string) => saveNote(id, { deletedAt: null });
export const purgeNote = (id: string) => remove(id);
export function liveNotes() { return notes(vaultStore.get()).live; }

// ---------- the task the developer is working on right now ----------
/** Click a task: add it to (or take it off) the tasks you are working on. null clears them all. */
export function setWorkingOn(id: string | null) {
  // Time spent (core/timesave.ts): Working on starts a task's clock, taking it off stops it. Never awaited.
  if (id === null) { void clockStopAll(); return saveSettings({ workingIds: [], workingOn: null }); }
  const ids = workingIdsOf(settings(vaultStore.get())?.data || {});
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  void (next.includes(id) ? clockStart(id) : clockStop(id));
  return saveSettings({ workingIds: next, workingOn: next[0] ?? null });
}

// ---------- example tasks (core/examples.ts, G Squad) ----------
// A brand new account in PS starts with a few made up tasks, a time zone person, an Urgent note and a countdown, each
// found again by its id (settings.examples), never by its words. Deleting removes exactly those, with Undo.
let examplesBusy = false;
export async function seedExamples(): Promise<void> {
  if (examplesBusy) return;
  examplesBusy = true;
  try {
    const b = buildExamples(Date.now(), uid);
    const st = settings(vaultStore.get())?.data;
    // The state first, so a second device or a reload never adds them twice.
    await saveSettings({ examples: b.state, aware: [...(st?.aware ?? []), b.aware], timelines: [...(st?.timelines ?? []), b.timeline] });
    for (const t of b.todos) await put<Todo>("todo", t.data as Todo, { id: t.id, ws: null });
    await put<TzPerson>("tzperson", b.person.data, { id: b.person.id, ws: null });
  } finally { examplesBusy = false; }
}
type ExampleBackup = { docs: { id: string; kind: "todo" | "tzperson"; data: unknown }[]; aware: AwareItem[]; timelines: Settings["timelines"] };
let exampleBackup: ExampleBackup | null = null;
/** "Delete all example tasks": only the example records, Urgent notes and countdowns. Undo puts them back as they were. */
export async function deleteExamples(): Promise<number> {
  const s = vaultStore.get();
  const st = settings(s)?.data;
  const state = st?.examples ?? null;
  const ids = examplesLeft(state, s.docs.values());
  const keepAware = new Set(state?.aware ?? []), keepTl = new Set(state?.timelines ?? []);
  exampleBackup = {
    docs: ids.map((id) => s.docs.get(id)).filter((d): d is NonNullable<typeof d> => !!d && (d.kind === "todo" || d.kind === "tzperson"))
      .map((d) => ({ id: d.id, kind: d.kind as "todo" | "tzperson", data: structuredClone(d.data) })),
    aware: (st?.aware ?? []).filter((a) => keepAware.has(a.id)),
    timelines: (st?.timelines ?? []).filter((t) => keepTl.has(t.id)),
  };
  for (const d of exampleBackup.docs) await remove(d.id);
  await saveSettings({ aware: withoutExamples(st?.aware, state?.aware), timelines: withoutExamples(st?.timelines, state?.timelines),
    examples: { ...(state ?? { at: new Date().toISOString(), ids: [] }), gone: new Date().toISOString() } as ExampleState });
  return exampleBackup.docs.length;
}
export async function undoExamples(): Promise<void> {
  const b = exampleBackup;
  if (!b) return;
  exampleBackup = null;
  for (const d of b.docs) await put(d.kind, d.data, { id: d.id, ws: null });
  const st = settings(vaultStore.get())?.data;
  await saveSettings({ aware: [...(st?.aware ?? []), ...b.aware], timelines: [...(st?.timelines ?? []), ...(b.timelines ?? [])],
    ...(st?.examples ? { examples: { ...st.examples, gone: null } } : {}) });
}


// ---------- PS 1.65 a background for each device (core/devicebg.ts) ----------
/** This device's own record (kind, name, last seen): only when new, changed, or once a day. A name the person chose is kept. */
export async function beatDevice(id: { dev: string; kind: Dev.DevKind; name: string }): Promise<void> {
  const mine = docs<unknown>("bgdev", null).filter((d) => Dev.cleanDevice(d.data)?.dev === id.dev);
  const prev = mine.map((d) => Dev.cleanDevice(d.data)!).sort((a, b) => Date.parse(b.seen) - Date.parse(a.seen))[0] ?? null;
  if (!Dev.shouldBeat(prev, id)) return;
  await put<Dev.Device>("bgdev", Dev.beatRecord(prev, id), { id: mine[0]?.id, ws: null });
  for (const d of mine.slice(1)) await remove(d.id);   // a second copy from two writes at once
  // Records of devices not seen for 90 days are deleted now, so private windows and cleared storage do not pile them up.
  for (const sid of Dev.staleIds(docs<unknown>("bgdev", null).map((d) => ({ id: d.id, data: d.data })))) await remove(sid).catch(() => {});
}
/** The person renames a device (empty goes back to the default name). */
export async function renameDevice(dev: string, name: string): Promise<void> {
  const mine = docs<unknown>("bgdev", null).filter((d) => Dev.cleanDevice(d.data)?.dev === dev);
  const prev = mine.map((d) => Dev.cleanDevice(d.data)!).sort((a, b) => Date.parse(b.seen) - Date.parse(a.seen))[0];
  if (!prev) return;
  await put<Dev.Device>("bgdev", Dev.renamed(prev, name), { id: mine[0]?.id, ws: null });
}
