// The Clients workspace's saves (PS 1.73). Every one goes through the same sealed records as the rest of the vault
// (core/vault.ts put: AES-GCM, owner private records with the vault key): clients (ClientRec), projects (Project, kept owner
// private with clientWs until 'Share with client' exists, so a client never sees a project made here), the checklist and notes
// (ProjectPrivate), tasks (ordinary Todo records, so they land in the normal to-do list), templates (kind "ptpl").
// Change only records, so the Supabase egress rule holds. The rules are core/clientwork.ts.
import type { ChecklistItem, ClientRec, Doc, Project, Stage, Todo } from "./model";
import { uid } from "./model";
import { doc, docs, put, remove } from "./vault";
import { addClient, addProject, addTodo, deleteTodo, privOf, updateClient, updatePrivate, updateProject, updateTodo } from "./actions";
import { STARTER, addStage, cleanTpl, fromTemplate, layStages, moveStage, removeStage, setDone, templateOf, type ProjectTpl } from "./clientwork";

const key = () => uid().replace(/-/g, "").slice(0, 12);

// ---------- clients ----------

/** + on the tabs: a new client (its own workspace and key) with a First project of three stages. Returns the client id. */
export async function newClient(name: string, order: number, today: string): Promise<string> {
  const id = await addClient({ name: name.trim() || "New client" });
  await updateClient(id, { status: "client", order });
  const c = doc<ClientRec>(id);
  if (c) await newProject(c.data.ws, "First project", today);
  return id;
}
export const renameClient = (id: string, name: string) => updateClient(id, { name: name.trim().slice(0, 80) || "New client" });
/** The tabs in their new order (only the ones that moved are saved). */
export async function orderClients(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    const c = doc<ClientRec>(ids[i]);
    if (c && c.data.order !== i) await updateClient(ids[i], { order: i });
  }
}
/** Remove a tab: the client is archived (kept in the vault with its projects and tasks, as the vault's Clients page does). */
export const removeClient = (id: string) => updateClient(id, { archived: true });

// ---------- projects ----------

/** A new project for the client's workspace: owner private until it is shared, three starter stages from today. */
export function newProject(ws: string, title: string, today: string, stages?: Stage[]): Promise<string> {
  return addProject(ws, "custom", title.trim().slice(0, 120) || "New project", {
    stages: stages ?? layStages(STARTER, today, key), current: 0, pipeline: "in_build", clientVisible: false, startDate: today, status: "on_track",
  });
}
export const renameProject = (id: string, title: string) => updateProject(id, { title: title.trim().slice(0, 120) || "Project" });
export const setProjectStatus = (id: string, status: Project["status"]) => updateProject(id, { status });
export const setNowLine = (id: string, nowLine: string) => updateProject(id, { nowLine: nowLine.trim().slice(0, 200) || null });

/** The stage line's edits, one record write each. */
export const stageDone = (id: string, k: number, today: string) => updateProject(id, (p) => { const r = setDone(p.stages, k, today); return { ...p, stages: r.stages, current: r.current }; });
export const stageAdd = (id: string, name: string, today: string) => updateProject(id, (p) => ({ ...p, stages: addStage(p.stages, name, today, key) }));
export const stageEdit = (id: string, i: number, patch: Partial<Pick<Stage, "name" | "start" | "due">>) =>
  updateProject(id, (p) => ({ ...p, stages: p.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
export const stageMove = (id: string, from: number, to: number) => updateProject(id, (p) => { const r = moveStage(p.stages, from, to, p.current); return { ...p, stages: r.stages, current: r.current }; });
export const stageRemove = (id: string, i: number) => updateProject(id, (p) => { const r = removeStage(p.stages, i, p.current); return { ...p, stages: r.stages, current: r.current }; });

// ---------- checklist and notes (owner only) ----------

export const checklistOf = (projectId: string): ChecklistItem[] => privOf(projectId)?.data.checklist ?? [];
export function checkAdd(projectId: string, text: string) {
  const t = text.trim().slice(0, 300);
  if (!t) return Promise.resolve();
  return updatePrivate(projectId, { checklist: [...checklistOf(projectId), { id: key(), text: t, done: false, at: null }] });
}
export function checkTick(projectId: string, id: string) {
  return updatePrivate(projectId, { checklist: checklistOf(projectId).map((c) => (c.id === id ? { ...c, done: !c.done, at: c.done ? null : new Date().toISOString() } : c)) });
}
export const checkRemove = (projectId: string, id: string) => updatePrivate(projectId, { checklist: checklistOf(projectId).filter((c) => c.id !== id) });
export const saveNotes = (projectId: string, notes: string) => updatePrivate(projectId, { notes: notes.slice(0, 20_000) });

// ---------- tasks (ordinary to-do tasks with the client on them) ----------

export type TaskInput = Pick<Todo, "title" | "type"> & Partial<Pick<Todo, "repeat" | "due" | "p1" | "doOn" | "deadline">>;
export function addClientTodo(clientId: string, projectId: string, t: TaskInput): Promise<string> {
  return addTodo({ ...t, title: t.title.trim().slice(0, 500), clientId, projectId, source: "project" });
}
export const editClientTodo = (id: string, patch: Partial<Todo>) => updateTodo(id, patch);
export const removeClientTodo = (id: string) => deleteTodo(id);

// ---------- templates (kind "ptpl", owner private) ----------

export function templates(): Doc<ProjectTpl>[] {
  return docs<ProjectTpl>("ptpl").filter((d) => cleanTpl(d.data)).sort((a, b) => a.data.name.localeCompare(b.data.name));
}
/** Save as template: the project's stages, checklist and tasks. Returns the template's name. */
export async function saveTemplate(projectId: string, clientName: string, tasks: Doc<Todo>[], today: string): Promise<string> {
  const p = doc<Project>(projectId);
  if (!p) return "";
  const tpl = templateOf({ name: p.data.title, client: clientName, stages: p.data.stages, checklist: checklistOf(projectId), tasks: tasks.map((d) => d.data), at: new Date().toISOString(), today });
  await put<ProjectTpl>("ptpl", tpl, { ws: null });
  return tpl.name;
}
/** New project from template: a copy laid out from today, then his to edit. Returns the new project's id and the counts. */
export async function projectFromTemplate(tplId: string, client: Doc<ClientRec>, today: string): Promise<{ id: string; stages: number; steps: number; tasks: number } | null> {
  const t = cleanTpl(doc<ProjectTpl>(tplId)?.data);
  if (!t) return null;
  const made = fromTemplate(t, client.data.name, today, key);
  const id = await newProject(client.data.ws, t.name, today, made.stages);
  if (made.checklist.length) await updatePrivate(id, { checklist: made.checklist });
  for (const x of made.tasks) await addClientTodo(client.id, id, x);
  return { id, stages: made.stages.length, steps: made.checklist.length, tasks: made.tasks.length };
}
export const removeTemplate = (id: string) => remove(id);
