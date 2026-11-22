// The Clients workspace's saves (PS 1.73). Every one goes through the same sealed records as the rest of the vault
// (core/vault.ts put: AES-GCM, owner private records with the vault key): clients (ClientRec), projects (Project, kept owner
// private with clientWs until 'Share with client' exists, so a client never sees a project made here), the checklist and notes
// (ProjectPrivate), tasks (ordinary Todo records, so they land in the normal to-do list), templates (kind "ptpl").
// Change only records, so the Supabase egress rule holds. The rules are core/clientwork.ts.
import type { ChecklistItem, ClientRec, Doc, Project, Stage, Todo } from "./model";
import { uid } from "./model";
import { doc, docs, put, remove } from "./vault";
import { addClient, addProject, addTodo, deleteTodo, privOf, setTodoDone, toggleTodo, updateClient, updatePrivate, updateProject, updateTodo } from "./actions";
import { STARTER, addStage, cleanTpl, fromTemplate, layStages, moveStage, removeStage, setDone, templateOf, type ProjectTpl } from "./clientwork";
import { OpLane, cleanTaskPatch, stageAt, type ClientsOp } from "./clientsop";

const key = () => uid().replace(/-/g, "").slice(0, 12);

// PS 1.74 (core/clientsop.ts): on the Mac's Tab list (no keys there) every save below becomes one op that the main window
// runs on its newest copy (runClientsOp). Everywhere else (the main window, the website, the phone) the relay is not set and
// the saves run here as before.
let relay: ((op: ClientsOp) => void) | null = null;
/** ps.ts, the Tab list only: where Clients saves go. */
export function setClientsRelay(f: ((op: ClientsOp) => void) | null) { relay = f; }
const sent = (op: ClientsOp) => { relay!(op); return Promise.resolve(); };

// ---------- clients ----------

/** + on the tabs: a new client (its own workspace and key) with a First project of three stages. Returns the client id. */
export async function newClient(name: string, order: number, today: string, id?: string): Promise<string> {
  if (relay) { const nid = id ?? uid(); relay({ op: "newClient", id: nid, name, order, today }); return nid; }
  if (id && doc(id)) return id;   // the same op twice: made already
  const cid = await addClient({ name: name.trim() || "New client" }, { id });
  await updateClient(cid, { status: "client", order });
  const c = doc<ClientRec>(cid);
  if (c) await newProject(c.data.ws, "First project", today);
  return cid;
}
export const renameClient = (id: string, name: string) => relay ? sent({ op: "renameClient", id, name }) : updateClient(id, { name: name.trim().slice(0, 80) || "New client" });
/** The tabs in their new order (only the ones that moved are saved). */
export async function orderClients(ids: string[]): Promise<void> {
  if (relay) return sent({ op: "orderClients", ids });
  for (let i = 0; i < ids.length; i++) {
    const c = doc<ClientRec>(ids[i]);
    if (c && c.data.order !== i) await updateClient(ids[i], { order: i });
  }
}
/** Remove a tab: the client is archived (kept in the vault with its projects and tasks, as the vault's Clients page does). */
export const removeClient = (id: string) => relay ? sent({ op: "removeClient", id }) : updateClient(id, { archived: true });

// ---------- projects ----------

/** A new project for the client's workspace: owner private until it is shared, three starter stages from today. */
export function newProject(ws: string, title: string, today: string, stages?: Stage[], id?: string): Promise<string> {
  if (relay && !stages) { const nid = id ?? uid(); relay({ op: "newProject", id: nid, ws, title, today }); return Promise.resolve(nid); }
  if (id && doc(id)) return Promise.resolve(id);
  return addProject(ws, "custom", title.trim().slice(0, 120) || "New project", {
    stages: stages ?? layStages(STARTER, today, key), current: 0, pipeline: "in_build", clientVisible: false, startDate: today, status: "on_track",
  }, { id });
}
export const renameProject = (id: string, title: string) => relay ? sent({ op: "renameProject", id, title }) : updateProject(id, { title: title.trim().slice(0, 120) || "Project" });
export const setProjectStatus = (id: string, status: NonNullable<Project["status"]>) => relay ? sent({ op: "projectStatus", id, status }) : updateProject(id, { status });
export const setNowLine = (id: string, nowLine: string) => relay ? sent({ op: "nowLine", id, text: nowLine }) : updateProject(id, { nowLine: nowLine.trim().slice(0, 200) || null });

/** The stage line's edits, one record write each. */
/** The stage at place i on this copy, by its key (core/clientsop.ts stageAt), for an op the main page runs on the newest copy. */
const stageKey = (id: string, i: number) => { const k = doc<Project>(id)?.data.stages?.[i]?.key; return k ? { key: k } : {}; };
// Break-it 1.74 round 3: "the first k stages done" names its last stage by key too, so an out of date copy ticks the right ones.
export const stageDone = (id: string, k: number, today: string) => relay ? sent({ op: "stageDone", id, k, today, ...(k > 0 ? stageKey(id, k - 1) : {}) })
  : updateProject(id, (p) => { const r = setDone(p.stages, k, today); return { ...p, stages: r.stages, current: r.current }; });
export const stageAdd = (id: string, name: string, today: string) => relay ? sent({ op: "stageAdd", id, name, today })
  : updateProject(id, (p) => ({ ...p, stages: addStage(p.stages, name, today, key) }));
export const stageEdit = (id: string, i: number, patch: Partial<Pick<Stage, "name" | "start" | "due">>) => relay ? sent({ op: "stageEdit", id, i, patch, ...stageKey(id, i) })
  : updateProject(id, (p) => ({ ...p, stages: p.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
export const stageMove = (id: string, from: number, to: number) => relay ? sent({ op: "stageMove", id, from, to, ...stageKey(id, from) })
  : updateProject(id, (p) => { const r = moveStage(p.stages, from, to, p.current); return { ...p, stages: r.stages, current: r.current }; });
export const stageRemove = (id: string, i: number) => relay ? sent({ op: "stageRemove", id, i, ...stageKey(id, i) })
  : updateProject(id, (p) => { const r = removeStage(p.stages, i, p.current); return { ...p, stages: r.stages, current: r.current }; });

// ---------- checklist and notes (owner only) ----------

export const checklistOf = (projectId: string): ChecklistItem[] => privOf(projectId)?.data.checklist ?? [];
export function checkAdd(projectId: string, text: string) {
  const t = text.trim().slice(0, 300);
  if (!t) return Promise.resolve();
  if (relay) return sent({ op: "checkAdd", id: projectId, text: t });
  return updatePrivate(projectId, { checklist: [...checklistOf(projectId), { id: key(), text: t, done: false, at: null }] });
}
/** done (break-it 1.74): the state the tap asked for, so a second tap or an out of date copy never flips it back. Left out: a toggle. */
export function checkTick(projectId: string, id: string, done?: boolean) {
  if (relay) return sent({ op: "checkTick", id: projectId, item: id, ...(done === undefined ? {} : { done }) });
  const list = checklistOf(projectId), c = list.find((x) => x.id === id);
  if (!c || (done !== undefined && !!c.done === done)) return Promise.resolve();
  return updatePrivate(projectId, { checklist: list.map((x) => (x.id === id ? { ...x, done: !x.done, at: x.done ? null : new Date().toISOString() } : x)) });
}
export const checkRemove = (projectId: string, id: string) => relay ? sent({ op: "checkRemove", id: projectId, item: id })
  : updatePrivate(projectId, { checklist: checklistOf(projectId).filter((c) => c.id !== id) });
export const saveNotes = (projectId: string, notes: string) => relay ? sent({ op: "notes", id: projectId, text: notes.slice(0, 20_000) })
  : updatePrivate(projectId, { notes: notes.slice(0, 20_000) });

// ---------- tasks (ordinary to-do tasks with the client on them) ----------

export type TaskInput = Pick<Todo, "title" | "type"> & Partial<Pick<Todo, "repeat" | "due" | "p1" | "doOn" | "deadline">>;
export function addClientTodo(clientId: string, projectId: string, t: TaskInput, id?: string): Promise<string> {
  if (relay) { const nid = id ?? uid(); relay({ op: "addTodo", id: nid, clientId, projectId, task: { ...cleanTaskPatch(t), title: t.title, type: t.type } }); return Promise.resolve(nid); }
  if (id && doc(id)) return Promise.resolve(id);
  return addTodo({ ...t, title: t.title.trim().slice(0, 500), clientId, projectId, source: "project" }, id ? { id } : {});
}
export const editClientTodo = (id: string, patch: Partial<Todo>) => relay ? sent({ op: "editTodo", id, patch: cleanTaskPatch(patch) }) : updateTodo(id, patch);
/** The tick on a client task (the same tick as the list's). */
export const tickClientTodo = (id: string, done?: boolean) => relay ? sent({ op: "tickTodo", id, ...(done === undefined ? {} : { done }) })
  : done === undefined ? toggleTodo(id) : setTodoDone(id, done);
export const removeClientTodo = (id: string) => relay ? sent({ op: "removeTodo", id }) : deleteTodo(id);

// ---------- templates (kind "ptpl", owner private) ----------

export function templates(): Doc<ProjectTpl>[] {
  return docs<ProjectTpl>("ptpl").filter((d) => cleanTpl(d.data)).sort((a, b) => a.data.name.localeCompare(b.data.name));
}
/** Save as template: the project's stages, checklist and tasks. Returns the template's name. */
export async function saveTemplate(projectId: string, clientName: string, tasks: Doc<Todo>[], today: string): Promise<string> {
  const p = doc<Project>(projectId);
  if (!p) return "";
  const tpl = templateOf({ name: p.data.title, client: clientName, stages: p.data.stages, checklist: checklistOf(projectId), tasks: tasks.map((d) => d.data), at: new Date().toISOString(), today });
  if (relay) { relay({ op: "saveTemplate", id: projectId, clientName, taskIds: tasks.map((d) => d.id), today }); return tpl.name; }
  await put<ProjectTpl>("ptpl", tpl, { ws: null });
  return tpl.name;
}
/** New project from template: a copy laid out from today, then his to edit. Returns the new project's id and the counts. */
export async function projectFromTemplate(tplId: string, client: Doc<ClientRec>, today: string, id?: string): Promise<{ id: string; stages: number; steps: number; tasks: number } | null> {
  const t = cleanTpl(doc<ProjectTpl>(tplId)?.data);
  if (!t) return null;
  const made = fromTemplate(t, client.data.name, today, key);
  const counts = { stages: made.stages.length, steps: made.checklist.length, tasks: made.tasks.length };
  if (relay) { const nid = id ?? uid(); relay({ op: "fromTemplate", id: nid, tpl: tplId, clientId: client.id, today }); return { id: nid, ...counts }; }
  if (id && doc(id)) return { id, ...counts };
  const pid = await newProject(client.data.ws, t.name, today, made.stages, id);
  if (made.checklist.length) await updatePrivate(pid, { checklist: made.checklist });
  for (const x of made.tasks) await addClientTodo(client.id, pid, x);
  return { id: pid, ...counts };
}
export const removeTemplate = (id: string) => relay ? sent({ op: "removeTemplate", id }) : remove(id);

// ---------- ops from the Tab list (the main window runs them, one at a time, on the newest copy) ----------

const lane = new OpLane();
/** ps.ts, the main window: one op from the Tab list (already checked by cleanClientsOp). */
export function runClientsOp(o: ClientsOp): Promise<unknown> {
  return lane.run(async () => {
    if (relay) return;   // never on the Tab list itself
    // Each op only ever touches its own kind of record.
    const kind = (id: string) => doc(id)?.kind;
    const CLIENT = new Set(["renameClient", "removeClient"]), PROJECT = new Set(["renameProject", "projectStatus", "nowLine", "stageDone", "stageAdd",
      "stageEdit", "stageMove", "stageRemove", "checkAdd", "checkTick", "checkRemove", "notes", "saveTemplate"]);
    const oid = "id" in o ? o.id : "";
    if (CLIENT.has(o.op) && kind(oid) !== "client") return;
    if (PROJECT.has(o.op) && kind(oid) !== "project") return;
    if (o.op === "newProject" && !docs<ClientRec>("client").some((c) => c.data.ws === o.ws)) return;
    if (o.op === "addTodo" && (kind(o.clientId) !== "client" || kind(o.projectId) !== "project")) return;
    if (o.op === "orderClients" && o.ids.some((x) => kind(x) !== "client")) return;
    switch (o.op) {
      case "newClient": return newClient(o.name, o.order, o.today, o.id);
      case "renameClient": return renameClient(o.id, o.name);
      case "orderClients": return orderClients(o.ids);
      case "removeClient": return removeClient(o.id);
      case "newProject": return newProject(o.ws, o.title, o.today, undefined, o.id);
      case "renameProject": return renameProject(o.id, o.title);
      case "projectStatus": return setProjectStatus(o.id, o.status);
      case "nowLine": return setNowLine(o.id, o.text);
      case "stageDone": { if (o.k <= 0 || !o.key) return stageDone(o.id, o.k, o.today); const j = stageAt(doc<Project>(o.id)?.data.stages, o.k - 1, o.key); return j === null ? undefined : stageDone(o.id, j + 1, o.today); }
      case "stageAdd": return stageAdd(o.id, o.name, o.today);
      // Break-it 1.74 round 2: the stage is found again by its key on the newest copy; one removed meanwhile is left alone.
      case "stageEdit": { const j = stageAt(doc<Project>(o.id)?.data.stages, o.i, o.key); return j === null ? undefined : stageEdit(o.id, j, o.patch); }
      case "stageMove": { const j = stageAt(doc<Project>(o.id)?.data.stages, o.from, o.key); return j === null ? undefined : stageMove(o.id, j, Math.max(0, j + o.to - o.from)); }
      case "stageRemove": { const j = stageAt(doc<Project>(o.id)?.data.stages, o.i, o.key); return j === null ? undefined : stageRemove(o.id, j); }
      case "checkAdd": return checkAdd(o.id, o.text);
      case "checkTick": return checkTick(o.id, o.item, o.done);
      case "checkRemove": return checkRemove(o.id, o.item);
      case "notes": return saveNotes(o.id, o.text);
      case "addTodo": return addClientTodo(o.clientId, o.projectId, o.task, o.id);
      case "editTodo": return doc<Todo>(o.id)?.kind === "todo" ? editClientTodo(o.id, o.patch) : undefined;
      case "tickTodo": return doc<Todo>(o.id)?.kind === "todo" ? tickClientTodo(o.id, o.done) : undefined;
      case "removeTodo": return doc<Todo>(o.id)?.kind === "todo" ? removeClientTodo(o.id) : undefined;
      case "saveTemplate": {
        const list = o.taskIds.map((x) => doc<Todo>(x)).filter((d): d is Doc<Todo> => !!d && d.kind === "todo");
        return saveTemplate(o.id, o.clientName, list, o.today);
      }
      case "fromTemplate": { const c = doc<ClientRec>(o.clientId); return c && c.kind === "client" ? projectFromTemplate(o.tpl, c, o.today, o.id) : undefined; }
      case "removeTemplate": return doc(o.id)?.kind === "ptpl" ? removeTemplate(o.id) : undefined;
    }
  });
}
