// PS 1.74: Clients saves from the Mac's Tab list. The Tab list holds no keys, so it cannot save a record itself (core/vault.ts
// put refuses: "Not from the Tab list."), and in 1.73 Clients there showed the client tabs but no projects, and adding a
// client, a project, a stage, a checklist step, notes or a task did nothing. Now every Clients save in the Tab list becomes
// one small op, sent to the main window (ps.ts, "clientsOp"), checked again here and run there on the newest copy
// (core/clientsact.ts runClientsOp). New records get their id in the Tab list, so the screen can pick them at once.
// Pure: no vault, no window. Tested in tests/clients-tab.test.ts.
import type { Deadline } from "./clientwork.ts";
import type { Project, Todo } from "./model.ts";
import { cleanRepeat } from "./repeat.ts";

/** The task fields the Clients screen edits. */
export type ClientTaskPatch = Partial<Pick<Todo, "title" | "type" | "repeat" | "due" | "p1" | "doOn" | "deadline" | "notes">>;
export type StagePatch = { name?: string; start?: string | null; due?: string | null };

export type ClientsOp =
  | { op: "newClient"; id: string; name: string; order: number; today: string }
  | { op: "renameClient"; id: string; name: string }
  | { op: "orderClients"; ids: string[] }
  | { op: "removeClient"; id: string }
  | { op: "unarchiveClient"; id: string }
  | { op: "deleteClient"; id: string }
  | { op: "clientSettings"; id: string; patch: ClientSettings }
  | { op: "newProject"; id: string; ws: string; title: string; today: string }
  | { op: "renameProject"; id: string; title: string }
  | { op: "projectStatus"; id: string; status: NonNullable<Project["status"]> }
  | { op: "nowLine"; id: string; text: string }
  | { op: "stageDone"; id: string; k: number; today: string; key?: string }
  | { op: "stageAdd"; id: string; name: string; today: string }
  | { op: "stageEdit"; id: string; i: number; patch: StagePatch; key?: string }
  | { op: "stageMove"; id: string; from: number; to: number; key?: string }
  | { op: "stageRemove"; id: string; i: number; key?: string }
  | { op: "checkAdd"; id: string; text: string }
  | { op: "checkTick"; id: string; item: string; done?: boolean }
  | { op: "checkRemove"; id: string; item: string }
  | { op: "notes"; id: string; text: string }
  | { op: "addTodo"; id: string; clientId: string; projectId: string; task: ClientTaskPatch & { title: string; type: Todo["type"] } }
  | { op: "editTodo"; id: string; patch: ClientTaskPatch }
  | { op: "tickTodo"; id: string; done?: boolean }
  | { op: "removeTodo"; id: string }
  | { op: "saveTemplate"; id: string; clientName: string; taskIds: string[]; today: string }
  | { op: "fromTemplate"; id: string; tpl: string; clientId: string; today: string }
  | { op: "removeTemplate"; id: string };

type R = Record<string, unknown>;
const isObj = (v: unknown): v is R => !!v && typeof v === "object" && !Array.isArray(v);
/** Record ids: the vault's uuids, workspace ids and checklist keys. */
const okId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(v);
const sk = (v: unknown) => (okId(v) ? { key: v } : {});
const okDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const okTime = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v: unknown, max = 500): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const STATUS = new Set(["on_track", "action_needed", "at_risk"]);

function cleanDeadline(v: unknown): Deadline | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !okDay(v.date)) return undefined;
  const d: Deadline = { date: v.date };
  if (v.time === null || okTime(v.time)) d.time = (v.time as string | null) ?? null;
  if (v.eventId === null || (typeof v.eventId === "string" && v.eventId.length <= 300)) d.eventId = (v.eventId as string | null) ?? null;
  if (v.title === null || typeof v.title === "string") d.title = v.title === null ? null : (v.title as string).slice(0, 200);
  if (typeof v.gone === "boolean") d.gone = v.gone;
  return d;
}
/** Only the fields the Clients screen edits, with the right types. */
export function cleanTaskPatch(v: unknown): ClientTaskPatch {
  const p = isObj(v) ? v : {};
  const o: ClientTaskPatch = {};
  if (typeof p.title === "string" && p.title.trim()) o.title = p.title.trim().slice(0, 500);
  if (p.type === "once" || p.type === "daily") o.type = p.type;
  if (p.due === null || okDay(p.due)) o.due = (p.due as string | null) ?? null;
  if ("repeat" in p) o.repeat = cleanRepeat(p.repeat, o.due || new Date().toISOString().slice(0, 10));
  if (typeof p.p1 === "boolean") o.p1 = p.p1;
  if (p.doOn === null || okDay(p.doOn)) o.doOn = (p.doOn as string | null) ?? null;
  if ("deadline" in p) { const d = cleanDeadline(p.deadline); if (d !== undefined) o.deadline = d; }
  if (p.notes === null || typeof p.notes === "string") o.notes = p.notes === null ? null : (p.notes as string).slice(0, 20_000);
  return o;
}
function cleanStagePatch(v: unknown): StagePatch | null {
  if (!isObj(v)) return null;
  const o: StagePatch = {};
  if (typeof v.name === "string" && v.name.trim()) o.name = v.name.trim().slice(0, 80);
  if (v.start === null || okDay(v.start)) o.start = (v.start as string | null) ?? null;
  if (v.due === null || okDay(v.due)) o.due = (v.due as string | null) ?? null;
  return Object.keys(o).length ? o : null;
}

/** One op from the Tab list, checked before it touches the vault. null: not a Clients op, or a broken one. */
export function cleanClientsOp(v: unknown): ClientsOp | null {
  if (!isObj(v) || typeof v.op !== "string") return null;
  const id = okId(v.id) ? v.id : null;
  const today = okDay(v.today) ? v.today : null;
  switch (v.op) {
    case "newClient": { const name = text(v.name, 80), order = int(v.order, 10_000); return id && name !== null && order !== null && today ? { op: "newClient", id, name, order, today } : null; }
    case "renameClient": { const name = text(v.name, 80); return id && name !== null ? { op: "renameClient", id, name } : null; }
    case "orderClients": { const ids = Array.isArray(v.ids) ? v.ids.filter(okId).slice(0, 500) : null; return ids && ids.length === (v.ids as unknown[]).length ? { op: "orderClients", ids } : null; }
    case "removeClient": case "removeTodo": case "removeTemplate": case "unarchiveClient": case "deleteClient": return id ? { op: v.op, id } : null;
    case "clientSettings": { const patch = cleanClientSettings(v.patch); return id && Object.keys(patch).length ? { op: "clientSettings", id, patch } : null; }
    // Break-it 1.74: a tick says which way (done or not), so a second tap or an out of date copy never flips it back.
    case "tickTodo": return id ? { op: "tickTodo", id, ...(typeof v.done === "boolean" ? { done: v.done } : {}) } : null;
    case "newProject": { const title = text(v.title, 120); return id && okId(v.ws) && title !== null && today ? { op: "newProject", id, ws: v.ws, title, today } : null; }
    case "renameProject": { const title = text(v.title, 120); return id && title !== null ? { op: "renameProject", id, title } : null; }
    case "projectStatus": return id && typeof v.status === "string" && STATUS.has(v.status) ? { op: "projectStatus", id, status: v.status as NonNullable<Project["status"]> } : null;
    case "nowLine": { const t = text(v.text, 200); return id && t !== null ? { op: "nowLine", id, text: t } : null; }
    case "stageDone": { const k = int(v.k); return id && k !== null && today ? { op: "stageDone", id, k, today, ...sk(v.key) } : null; }
    case "stageAdd": { const name = text(v.name, 80); return id && name !== null && today ? { op: "stageAdd", id, name, today } : null; }
    case "stageEdit": { const i = int(v.i), patch = cleanStagePatch(v.patch); return id && i !== null && patch ? { op: "stageEdit", id, i, patch, ...sk(v.key) } : null; }
    case "stageMove": { const from = int(v.from), to = int(v.to); return id && from !== null && to !== null ? { op: "stageMove", id, from, to, ...sk(v.key) } : null; }
    case "stageRemove": { const i = int(v.i); return id && i !== null ? { op: "stageRemove", id, i, ...sk(v.key) } : null; }
    case "checkAdd": { const t = text(v.text, 300); return id && t !== null && t.trim() ? { op: "checkAdd", id, text: t } : null; }
    case "checkTick": return id && okId(v.item) ? { op: "checkTick", id, item: v.item, ...(typeof v.done === "boolean" ? { done: v.done } : {}) } : null;
    case "checkRemove": return id && okId(v.item) ? { op: "checkRemove", id, item: v.item } : null;
    case "notes": { const t = text(v.text, 20_000); return id && t !== null ? { op: "notes", id, text: t } : null; }
    case "addTodo": {
      const t = cleanTaskPatch(v.task);
      if (!id || !okId(v.clientId) || !okId(v.projectId) || !t.title) return null;
      return { op: "addTodo", id, clientId: v.clientId, projectId: v.projectId, task: { ...t, title: t.title, type: t.type ?? "once" } };
    }
    case "editTodo": { const patch = cleanTaskPatch(v.patch); return id && Object.keys(patch).length ? { op: "editTodo", id, patch } : null; }
    case "saveTemplate": {
      const name = text(v.clientName, 80), ids = Array.isArray(v.taskIds) ? v.taskIds.filter(okId).slice(0, 300) : null;
      return id && name !== null && ids && today ? { op: "saveTemplate", id, clientName: name, taskIds: ids, today } : null;
    }
    case "fromTemplate": return id && okId(v.tpl) && okId(v.clientId) && today ? { op: "fromTemplate", id, tpl: v.tpl, clientId: v.clientId, today } : null;
    default: return null;
  }
}

/** PS 1.77, a tab's Settings: the client record's fields Clients lets him change there. */
export type ClientSettings = { name?: string; colour?: string | null; contactName?: string | null; email?: string | null };
/** Only those fields, with the right types: a name (never empty), a colour "#rrggbb" or none, a contact and an email. */
export function cleanClientSettings(v: unknown): ClientSettings {
  const p = isObj(v) ? v : {};
  const o: ClientSettings = {};
  if (typeof p.name === "string" && p.name.trim()) o.name = p.name.trim().slice(0, 80);
  if (p.colour === null || (typeof p.colour === "string" && /^#[0-9a-fA-F]{6}$/.test(p.colour))) o.colour = (p.colour as string | null) ?? null;
  if (p.contactName === null || typeof p.contactName === "string") o.contactName = typeof p.contactName === "string" ? p.contactName.trim().slice(0, 120) || null : null;
  if (p.email === null || typeof p.email === "string") o.email = typeof p.email === "string" ? p.email.trim().slice(0, 200) || null : null;
  return o;
}
/** The projects of the client with workspace `ws`: shared ones live in it, private ones carry it as clientWs. */
export function clientProjects<T extends { ws: string | null; data: { clientWs?: string | null } }>(projects: T[], ws: string): T[] {
  return projects.filter((p) => (p.ws ?? p.data.clientWs ?? null) === ws);
}

/** Steps for Clients run one after another, in the order they were asked for (a new client, then its rename, never the
 *  other way round). */
export class OpLane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

/** Break-it 1.74 round 2: a stage edit, move or remove from the Tab list names its stage by key, so an out of date copy (a
 *  stage moved or removed meanwhile) never hits another stage. The place is found again on the newest copy; a stage that is
 *  gone is left alone (null). Without a key (an older Tab list) the place is used as sent. */
export function stageAt(stages: readonly { key?: string }[] | undefined, i: number, key?: string): number | null {
  if (!key) return i;
  const j = (stages || []).findIndex((s) => s.key === key);
  return j < 0 ? null : j;
}
