// Derived views over the decrypted documents. Pure functions of the snapshot.
import type { Approval, ClientRec, CTask, Doc, Draft, Meeting, Project, Reply, ProjectPrivate, Settings, Tick, Todo, Update, WsMeta, Brief, CalendarSnap, IEmail, IThread, Agenda, JournalEntry, Quote, Note, ScreenTimeDay, ScreenTimeDevice, StLine, CampaignStats } from "./model";
import { DEFAULT_SETTINGS, currentStage, stageState, type ClientStatus } from "./model";
import type { Snapshot } from "./vault";
import { foldDayDocs, type DayLog } from "./daylog";
import type { TzPerson } from "./tzpeople";
import type { TzZones } from "./tzzones";
import { cleanLayout, emptyLayout, pickLayout, type TabLayout } from "./tablayout";
import { cleanPhoneLayout, defaultPhoneLayout, pickPhoneLayout, type PhoneKind, type PhoneLayout } from "./phonelayout";
import { phonesOf, type PhoneDev } from "./phonedevices";
import * as Dev from "./devicebg";
import { pickRemind, type RemindRec } from "./remind";
import { mainCalendar } from "./calfeeds";
import { isOpenReply } from "./mailopen";
import { hasOff, shownEvents, type CalInfo } from "./calpick";
import { belongsTo, daysOf } from "./screentime";
import { daysFromToday, todayISO } from "../ui/kit";
import { journalByKey } from "./keepedits";

function byKind<T>(s: Snapshot, kind: string, ws?: string | null): Doc<T>[] {
  const out: Doc<T>[] = [];
  for (const d of s.docs.values()) if (d.kind === kind && (ws === undefined || d.ws === ws)) out.push(d as Doc<T>);
  return out;
}

export interface TaskView { doc: Doc<CTask>; done: boolean; doneAt: string | null; tick?: Doc<Tick> }
export interface ProjectView {
  doc: Doc<Project>;
  p: Project;
  ws: string;
  priv?: Doc<ProjectPrivate>;
  client?: Doc<ClientRec>;
  tasks: TaskView[];
  approvals: Doc<Approval>[];
  updates: Doc<Update>[];
}
export interface ClientView {
  client: Doc<ClientRec> | null; // null on the client side (they never see the developer's private record)
  ws: string;
  meta?: Doc<WsMeta>;
  name: string;
  projects: ProjectView[];
}

// Settings can exist more than once: a device that saved a setting before its first download made a
// record of its own (the developer, 28 Oct 2026: the rule written on the Mac never showed on the phone, because
// each device read whichever settings record it happened to meet first). Every device now reads them
// the same way: merged oldest first, so for each field the newest save wins, kept under the lowest id.
// saveSettings folds the others into that one and removes them (extraSettingsIds).
const when = (d: Doc) => (d.pending ? Number.POSITIVE_INFINITY : Date.parse(d.updatedAt || "") || 0);
const merged = new WeakMap<Snapshot["docs"], Doc<Settings> | undefined>();
export function settings(s: Snapshot): Doc<Settings> | undefined {
  if (merged.has(s.docs)) return merged.get(s.docs);
  const all = byKind<Settings>(s, "settings").filter((d) => !d.ws);
  let out = all[0];
  if (all.length > 1) {
    const keep = [...all].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const data = Object.assign({}, ...[...all].sort((a, b) => when(a) - when(b)).map((d) => d.data)) as Settings;
    out = { ...keep, data };
  }
  merged.set(s.docs, out);
  return out;
}
/** Settings records beyond the one kept (see settings above): saveSettings removes them once folded in. */
export function extraSettingsIds(s: Snapshot): string[] {
  const keep = settings(s)?.id;
  return byKind<Settings>(s, "settings").filter((d) => !d.ws && d.id !== keep).map((d) => d.id);
}
export function settingsData(s: Snapshot): Settings {
  return { ...DEFAULT_SETTINGS, ...(settings(s)?.data || {}) };
}

export function wsOfClient(c: Doc<ClientRec>): string | null {
  return (c.data as ClientRec & { ws?: string }).ws ?? null;
}

export function projectViews(s: Snapshot, ws?: string): ProjectView[] {
  const clientsByWs = new Map<string, Doc<ClientRec>>();
  for (const c of byKind<ClientRec & { ws: string }>(s, "client")) clientsByWs.set(c.data.ws, c);
  const privByProject = new Map<string, Doc<ProjectPrivate>>();
  for (const p of byKind<ProjectPrivate>(s, "pprivate")) privByProject.set(p.data.projectId, p);
  const ticks = new Map<string, Doc<Tick>>();
  for (const t of byKind<Tick>(s, "tick")) {
    const prev = ticks.get(t.data.taskId);
    if (!prev || (prev.data.at || "") < (t.data.at || "")) ticks.set(t.data.taskId, t);
  }
  const tasks = byKind<CTask>(s, "ctask");
  const approvals = byKind<Approval>(s, "approval");
  const updates = byKind<Update>(s, "update");
  const effWs = (d: Doc<Project>) => d.ws ?? d.data.clientWs ?? "";
  return byKind<Project>(s, "project").filter((d) => effWs(d) && (ws === undefined || effWs(d) === ws)).map((doc) => {
    const id = doc.id;
    const tv = tasks.filter((t) => t.data.projectId === id)
      .sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0) || (a.data.due || "9").localeCompare(b.data.due || "9"))
      .map((t) => { const k = ticks.get(t.id); return { doc: t, done: !!k?.data.done, doneAt: k?.data.done ? k.data.at : null, tick: k }; });
    return {
      doc, p: doc.data, ws: effWs(doc),
      priv: privByProject.get(id),
      client: clientsByWs.get(effWs(doc)),
      tasks: tv,
      approvals: approvals.filter((a) => a.data.projectId === id).sort((a, b) => b.data.at.localeCompare(a.data.at)),
      updates: updates.filter((u) => u.data.projectId === id).sort((a, b) => b.data.date.localeCompare(a.data.date)),
    };
  });
}

// Projects you are actively working on come first inside a client.
const PIPE_RANK: Record<string, number> = { in_build: 0, client_review: 1, signed: 2, cro: 3, live: 4, proposal_sent: 5, lead: 6, finished: 7 };
export function projectRank(pv: ProjectView): number {
  return (pv.p.archived ? 100 : 0) + (PIPE_RANK[pv.p.pipeline] ?? 9);
}

/** The tab a client lives in: what the developer set, otherwise worked out from their projects. */
export function clientStatus(c: ClientView): ClientStatus {
  const set = c.client?.data.status;
  if (set) return set;
  const pipes = c.projects.filter((p) => !p.p.archived).map((p) => p.p.pipeline);
  if (pipes.some((x) => ["signed", "in_build", "client_review", "live", "cro"].includes(x))) return "client";
  if (pipes.includes("proposal_sent")) return "prospect";
  if (pipes.length && pipes.every((x) => x === "finished")) return "past";
  return "lead";
}

export function clientViews(s: Snapshot): ClientView[] {
  const pv = projectViews(s);
  const metas = byKind<WsMeta>(s, "wsmeta");
  if (s.role === "owner") {
    return byKind<ClientRec & { ws: string }>(s, "client")
      .filter((c) => !c.data.archived)
      .map((c) => ({
        client: c, ws: c.data.ws, meta: metas.find((m) => m.ws === c.data.ws), name: c.data.name,
        projects: pv.filter((p) => p.ws === c.data.ws).sort((a, b) => projectRank(a) - projectRank(b)),
      }))
      .sort((a, b) => (a.client!.data.order ?? 1e6) - (b.client!.data.order ?? 1e6) || a.name.localeCompare(b.name));
  }
  const wsSet = new Set<string>([...metas.map((m) => m.ws!), ...pv.map((p) => p.ws)]);
  return [...wsSet].map((ws) => {
    const meta = metas.find((m) => m.ws === ws);
    return { client: null, ws, meta, name: meta?.data.clientName || "Your project", projects: pv.filter((p) => p.ws === ws && p.p.clientVisible !== false && !p.p.archived) };
  });
}

// What still needs the client (open tasks + stages waiting on them without an approval yet).
export function clientNeeds(pv: ProjectView) {
  const openTasks = pv.tasks.filter((t) => !t.done);
  const st = currentStage(pv.p);
  const waitingGate = st && stageState(pv.p, pv.p.current) === "waiting" &&
    !pv.approvals.some((a) => a.data.stageKey === st.key) ? st : null;
  return { openTasks, waitingGate, count: openTasks.length + (waitingGate ? 1 : 0) };
}

export function latestBrief(s: Snapshot): Doc<Brief> | undefined {
  return byKind<Brief>(s, "brief").sort((a, b) => b.data.date.localeCompare(a.data.date) || (b.data.createdAt || "").localeCompare(a.data.createdAt || ""))[0];
}

/** Your list of clocks on the Time zones screen (core/tzzones.ts): the newest record (two devices that both made
 *  one before either had synced leave two; the next save folds them into this one). */
export function tzZonesDoc(s: Snapshot): Doc<TzZones> | undefined {
  return byKind<TzZones>(s, "tzzones").filter((d) => d.data && Array.isArray(d.data.zones))
    .sort((a, b) => (b.data.at || "").localeCompare(a.data.at || "") || a.id.localeCompare(b.id))[0];
}

/** People added on the Time zones screen (core/tzpeople.ts), not clients. Oldest first. */
export function tzPeople(s: Snapshot): Doc<TzPerson>[] {
  return byKind<TzPerson>(s, "tzperson").filter((d) => d.data && typeof d.data.name === "string" && typeof d.data.tz === "string")
    .sort((a, b) => (a.data.at || "").localeCompare(b.data.at || "") || a.id.localeCompare(b.id));
}

/** The Tab list's Edit mode places (core/tablayout.ts): this account's one record, the newest if two raced. */
export function tabLayoutDoc(s: Snapshot): Doc<TabLayout> | null {
  return pickLayout(byKind<TabLayout>(s, "tablayout")).keep;
}
/** The Annoying 15 min reminders (core/remind.ts): this account's one record, merged if two devices each made one.
 *  Null when nobody has saved any yet (Settings then shows reminder one from the defaults). */
export function remindDoc(s: Snapshot) { return pickRemind(byKind<RemindRec>(s, "remind")); }
export function remindRec(s: Snapshot): RemindRec | null { return remindDoc(s).rec; }
/** V1.56 phone layout editor (core/phonelayout.ts): one phone kind's layout, the newest record if two raced, or the
 *  phone as it always was when nobody changed it. */
export function phoneLayoutDoc(s: Snapshot, phone: PhoneKind): Doc<PhoneLayout> | null {
  return pickPhoneLayout(byKind<PhoneLayout>(s, "phonelayout"), phone).keep;
}
export function phoneLayout(s: Snapshot, phone: PhoneKind, red: boolean): PhoneLayout {
  const d = phoneLayoutDoc(s, phone);
  return d ? cleanPhoneLayout(d.data, phone, red) : defaultPhoneLayout(phone, red);
}
/** The phones that opened PS on this account (core/phonedevices.ts), most recently seen first. */
export function phoneDevs(s: Snapshot): PhoneDev[] {
  return phonesOf(byKind<unknown>(s, "phonedev").map((d) => d.data));
}
/** Every device that opened PS on this account (core/devicebg.ts), most recently seen first. */
export function bgDevices(s: Snapshot): Dev.Device[] {
  return Dev.devicesOf(byKind<unknown>(s, "bgdev").map((d) => d.data));
}
export function tabLayout(s: Snapshot): TabLayout {
  const d = tabLayoutDoc(s);
  return d ? cleanLayout(d.data) : emptyLayout();
}

/** Every task, the cleared ones too (Resurrect, V1.47, can bring back what a reset took off). */
export function allTodos(s: Snapshot): Doc<Todo>[] { return byKind<Todo>(s, "todo"); }
export function todos(s: Snapshot): Doc<Todo>[] {
  return byKind<Todo>(s, "todo").filter((t) => !t.data.clearedAt)
    .sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
}
/** Every Instantly email kept in the vault, newest first. */
export function iemails(s: Snapshot): Doc<IEmail>[] {
  return byKind<IEmail>(s, "iemail").sort((a, b) => (b.data.at || "").localeCompare(a.data.at || ""));
}
/** Quotes for the To-do page, in the developer's order. */
export function quotes(s: Snapshot): Doc<Quote>[] {
  return byKind<Quote>(s, "quote").sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0) || a.data.createdAt.localeCompare(b.data.createdAt));
}
/** Notes: live ones (pinned first, then newest edit) and recently deleted ones. */
export function notes(s: Snapshot): { live: Doc<Note>[]; deleted: Doc<Note>[] } {
  const all = byKind<Note>(s, "note");
  return {
    live: all.filter((d) => !d.data.deletedAt).sort((a, b) => Number(!!b.data.pinned) - Number(!!a.data.pinned) || b.data.updatedAt.localeCompare(a.data.updatedAt)),
    deleted: all.filter((d) => !!d.data.deletedAt).sort((a, b) => (b.data.deletedAt || "").localeCompare(a.data.deletedAt || "")),
  };
}
/** Agendas: running ones by their order, past ones newest first. */
export function agendas(s: Snapshot): { current: Doc<Agenda>[]; past: Doc<Agenda>[] } {
  const all = byKind<Agenda>(s, "agenda");
  return {
    current: all.filter((d) => !d.data.endedAt).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0) || a.data.startedAt.localeCompare(b.data.startedAt)),
    past: all.filter((d) => !!d.data.endedAt).sort((a, b) => (b.data.endedAt || "").localeCompare(a.data.endedAt || "")),
  };
}
/** The series map entries by key ("m:2026-10", "w:2026-10-12", "d:2026-10-15"). */
/** What the developer got done, one log per work day (written by Reset). */
export function dayLogs(s: Snapshot): Map<string, Doc<DayLog>> {
  return foldDayDocs(byKind<DayLog>(s, "daylog"));   // two devices that both started a day read as one (core/daylog.ts)
}
/** Screen time, one record per local day per device (the Mac by default; old records are the Mac's). */
/** The stored records as they are (saving uses this, so it can scrub them). */
export function rawScreenTimeDays(s: Snapshot, device: ScreenTimeDevice = "mac"): Map<string, Doc<ScreenTimeDay>> {
  return daysOf(byKind<ScreenTimeDay>(s, "screentime"), device);
}
/** What the screens show: 1Password and Signal never (golden rule), even if an older record holds them,
 *  and only that device's apps (a Mac record from before the split may still hold the phone's for a while). */
export function screenTimeDays(s: Snapshot, device: ScreenTimeDevice = "mac"): Map<string, Doc<ScreenTimeDay>> {
  const keep = belongsTo(device);
  return new Map([...rawScreenTimeDays(s, device)].map(([k, d]) => [k, { ...d, data: { ...d.data, apps: d.data.apps.filter(keep) } }]));
}
/** Every device's saved screen time line hours (core/stline.ts joins them into a timeline). */
export function screenLines(s: Snapshot): Doc<StLine>[] {
  return byKind<StLine>(s, "stline");
}
export function journal(s: Snapshot): Map<string, Doc<JournalEntry>> {
  return journalByKey(byKind<JournalEntry>(s, "journal"));
}
/** The Instantly conversations (full threads), newest first. */
export function ithreads(s: Snapshot): Doc<IThread>[] {
  return byKind<IThread>(s, "ithread").sort((a, b) => (b.data.lastAt || "").localeCompare(a.data.lastAt || ""));
}
/** A calendar copy without the events of calendars set to Off (core/calpick.ts). The same object when nothing is Off, so the
 *  developer's calendar and everyone who never chose are exactly as before. */
function shownDoc(d: Doc<CalendarSnap> | null, s: Snapshot): Doc<CalendarSnap> | null {
  if (!d) return d;
  const choices = settingsData(s).calChoices;
  return hasOff(choices) ? { ...d, data: { ...d.data, events: shownEvents(d.data.events || [], choices) } } : d;
}
/** The latest calendar snapshot (Google for the developer, the Mac's Calendar for everyone else), if connected. Calendars set
 *  to Off are already left out: everything that shows an event uses this. What counts as a meeting is `meetingEvents`. */
export function calendarSnap(s: Snapshot): Doc<CalendarSnap> | null {
  return shownDoc(mainCalendar(byKind<CalendarSnap>(s, "calendar")), s);   // V1.55: never a calendar linked to one panel (core/calfeeds.ts)
}
/** The Mac's calendars as the last read saw them (names, colours, account), for the picker. */
export function calendarList(s: Snapshot): CalInfo[] {
  return mainCalendar(byKind<CalendarSnap>(s, "calendar"))?.data.cals ?? [];
}
/** Every calendar copy (the usual one and those linked to single Meetings panels), calendars set to Off left out. */
export const calendarDocs = (s: Snapshot): Doc<CalendarSnap>[] => byKind<CalendarSnap>(s, "calendar").map((d) => shownDoc(d, s)!);
/** The newest campaign statistics package (Tab list > Campaign stats), or null. */
export function campaignStats(s: Snapshot): Doc<CampaignStats> | null {
  return byKind<CampaignStats>(s, "cstats").sort((a, b) => (b.data.exportedAt || "").localeCompare(a.data.exportedAt || ""))[0] ?? null;
}
export function meetings(s: Snapshot): Doc<Meeting>[] {
  return byKind<Meeting>(s, "meeting").sort((a, b) => b.data.date.localeCompare(a.data.date));
}
/** Client replies from Gmail, newest first. */
export function replies(s: Snapshot, clientId?: string): Doc<Reply>[] {
  return byKind<Reply>(s, "reply").filter((r) => !clientId || r.data.clientId === clientId)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
}
export function openReplies(s: Snapshot, clientId?: string): Doc<Reply>[] {
  const live = new Set(byKind<ClientRec>(s, "client").map((c) => c.id));
  return replies(s, clientId).filter((r) => isOpenReply(r.data, live));   // the island's envelope counts the same (core/mailopen.ts)
}
export function drafts(s: Snapshot): Doc<Draft>[] {
  return byKind<Draft>(s, "draft").sort((a, b) => (a.updatedAt || "").localeCompare(b.updatedAt || ""));
}

// ---------- the owner's agenda: everything that needs the developer, in one list ----------
export type AgendaKind = "todo" | "next" | "approval" | "payment" | "invoice" | "delivery" | "draft" | "meeting" | "waiting";
export interface AgendaItem {
  key: string;
  kind: AgendaKind;
  title: string;
  who?: string;
  due?: string | null;
  late: boolean;
  today: boolean;
  href?: string;
  docId?: string;
}

export function agenda(s: Snapshot, horizonDays = 7): AgendaItem[] {
  const out: AgendaItem[] = [];
  const t = todayISO();
  const within = (d?: string | null) => !!d && daysFromToday(d) <= horizonDays;
  const mk = (i: Omit<AgendaItem, "late" | "today">): AgendaItem => ({
    ...i, late: !!i.due && i.due < t, today: !!i.due && i.due === t,
  });

  for (const d of todos(s)) {
    if (d.data.done) continue;
    if (d.data.type === "daily" || !d.data.due || within(d.data.due)) {
      out.push(mk({ key: d.id, kind: "todo", title: d.data.title, due: d.data.due ?? null, href: "#/todo", docId: d.id }));
    }
  }
  for (const pv of projectViews(s)) {
    if (pv.p.archived) continue;
    const who = pv.client?.data.name;
    const href = pv.client ? `#/client/${pv.client.id}/project/${pv.doc.id}` : undefined;
    const pr = pv.priv?.data;
    if (pr?.nextStep && pr.waitingOn !== "client") {
      out.push(mk({ key: "n" + pv.doc.id, kind: "next", title: pr.nextStep, who, due: pr.nextDue ?? null, href }));
    }
    if (pr?.waitingOn === "client") {
      out.push(mk({ key: "w" + pv.doc.id, kind: "waiting", title: `Waiting on them: ${pr.waitingWhat || "a reply"}`, who, due: pr.nextDue ?? null, href }));
    }
    // Client approvals the developer has not acted on yet (stage still current).
    const st = currentStage(pv.p);
    if (st) {
      const a = pv.approvals.find((x) => x.data.stageKey === st.key);
      if (a) out.push(mk({ key: "a" + a.id, kind: "approval", title: `${a.data.by || "Client"} approved: ${st.name}. Move to the next stage`, who, due: a.data.at.slice(0, 10), href }));
    }
    for (const pay of pv.p.payments) {
      if (pay.status === "owed" || (pay.status === "upcoming" && within(pay.due))) {
        out.push(mk({ key: "p" + pay.id, kind: "payment", title: `${pay.status === "owed" ? "Owed" : "Invoice due"}: ${pay.label}`, who, due: pay.due ?? null, href }));
      }
    }
    if (pr?.nextInvoiceDate && within(pr.nextInvoiceDate)) {
      out.push(mk({ key: "i" + pv.doc.id, kind: "invoice", title: "Send the next invoice", who, due: pr.nextInvoiceDate, href }));
    }
    if (pv.p.promisedDelivery && pv.p.current < pv.p.stages.length && within(pv.p.promisedDelivery) && !["finished", "lead", "proposal_sent"].includes(pv.p.pipeline)) {
      out.push(mk({ key: "d" + pv.doc.id, kind: "delivery", title: `Promised delivery: ${pv.p.title}`, who, due: pv.p.promisedDelivery, href }));
    }
  }
  for (const d of drafts(s)) {
    if (d.data.status === "draft") out.push(mk({ key: d.id, kind: "draft", title: `Approve email: ${d.data.subject}`, due: null, href: "#/emails", docId: d.id }));
  }
  for (const m of meetings(s)) {
    const left = m.data.actionItems.filter((a) => !(m.data.addedToTodo || []).includes(a));
    if (m.data.source === "fireflies" && left.length && daysFromToday(m.data.date.slice(0, 10)) >= -14) {
      out.push(mk({ key: m.id, kind: "meeting", title: `${left.length} action item${left.length > 1 ? "s" : ""} from ${m.data.title}`, due: null, href: "#/meetings", docId: m.id }));
    }
  }
  const rank = (i: AgendaItem) => (i.late ? 0 : i.today ? 1 : i.due ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || (a.due || "9999").localeCompare(b.due || "9999"));
}

export function owedTotals(s: Snapshot) {
  const owed: { amount: number; currency: string }[] = [];
  const upcoming: { amount: number; currency: string; due?: string | null; who?: string; label: string }[] = [];
  for (const pv of projectViews(s)) {
    for (const p of pv.p.payments) {
      if (p.status === "owed") owed.push({ amount: p.amount, currency: p.currency });
      if (p.status === "upcoming") upcoming.push({ amount: p.amount, currency: p.currency, due: p.due, who: pv.client?.data.name, label: p.label });
    }
  }
  upcoming.sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
  return { owed, upcoming };
}
