import { addClient, addProject, deleteTodo, privOf, setTodoDone, updateClient, updatePrivate, updateProject } from "./actions";
import { addClientTodo, editClientTodo } from "./clientsact";
import { CRM_ACTIVITY_MAX, CRM_FILE_MAX, crmFileName, type CrmActivity } from "./crmdata";
import { uid, type ClientRec, type Doc, type Project, type ProjectDoc } from "./model";
import { deleteBlob, doc, docs, getBlob, put, putBlob, remove, vaultStore } from "./vault";
import type { CrmStore } from "./crmapi";

function requireProject(projectId: string) {
  const project = doc<Project>(projectId);
  const vault = vaultStore.get();
  if (vault.status !== "unlocked" || vault.role !== "owner" || project?.kind !== "project") throw new Error("Project unavailable.");
  return project;
}

export async function addCrmActivity(projectId: string, activity: Omit<CrmActivity, "id"> & { id?: string }): Promise<CrmActivity> {
  requireProject(projectId);
  const entry = { ...activity, id: activity.id || uid() };
  await updatePrivate(projectId, (data) => {
    const list = data.activity ?? [];
    if (list.some((item) => item.id === entry.id)) return null;
    if (list.length >= CRM_ACTIVITY_MAX) throw new Error("Project activity is full.");
    return { activity: [entry, ...list] };
  });
  return privOf(projectId)?.data.activity?.find((item) => item.id === entry.id) ?? entry;
}

async function editCrmActivity(projectId: string, id: string, patch: Partial<Omit<CrmActivity, "id">>) {
  requireProject(projectId);
  await updatePrivate(projectId, (data) => ({
    activity: (data.activity ?? []).map((item) => item.id === id ? { ...item, ...patch } : item),
  }));
}

export async function removeCrmActivity(projectId: string, id: string): Promise<void> {
  requireProject(projectId);
  await updatePrivate(projectId, (data) => ({ activity: (data.activity ?? []).filter((item) => item.id !== id) }));
}

export function crmProjectDocs(projectId: string): Doc<ProjectDoc>[] {
  return docs<ProjectDoc>("doc", null).filter((d) => d.data.projectId === projectId);
}

let uploadQueue: Promise<unknown> = Promise.resolve();

export function attachCrmDoc(projectId: string, file: { bytes: Uint8Array; name: string }, label: string, docKind: ProjectDoc["docKind"], id: string = uid()): Promise<string> {
  const upload = uploadQueue.then(() => attachCrmDocNow(projectId, file, label, docKind, id));
  uploadQueue = upload.catch(() => undefined);
  return upload;
}

async function attachCrmDocNow(projectId: string, file: { bytes: Uint8Array; name: string }, label: string, docKind: ProjectDoc["docKind"], id: string) {
  requireProject(projectId);
  const old = doc<ProjectDoc>(id);
  if (old?.kind === "doc" && old.ws === null && old.data.projectId === projectId) return id;
  if (old) throw new Error("Document ID already in use.");
  if (file.bytes.length > CRM_FILE_MAX || new TextDecoder().decode(file.bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("Choose a PDF up to 5 MB.");
  }
  const blobId = await putBlob(null, file.bytes, { cache: false });
  try {
    requireProject(projectId);
    return await put<ProjectDoc>("doc", {
      projectId, blobId, name: crmFileName(file.name), mime: "application/pdf", size: file.bytes.length,
      label, docKind, addedAt: new Date().toISOString(),
    }, { ws: null, id });
  } catch (e) {
    await deleteBlob(blobId).catch(() => undefined);
    throw e;
  }
}

export async function readCrmDoc(projectId: string, documentId: string, includeShared = false): Promise<{ bytes: Uint8Array; name: string }> {
  requireProject(projectId);
  const d = doc<ProjectDoc>(documentId);
  if (d?.kind !== "doc" || d.data.projectId !== projectId || (!includeShared && d.ws !== null)) throw new Error("Document unavailable.");
  if (d.data.size > CRM_FILE_MAX) throw new Error("This PDF exceeds the CRM preview limit.");
  const bytes = await getBlob(d.data.blobId, d.ws, { cache: false });
  requireProject(projectId);
  return { bytes, name: d.data.name };
}

export async function removeCrmDoc(projectId: string, documentId: string): Promise<void> {
  requireProject(projectId);
  const d = crmProjectDocs(projectId).find((x) => x.id === documentId);
  if (!d) return;
  await remove(documentId);
  await deleteBlob(d.data.blobId).catch(() => undefined);
}

/** The local API reaches the same private data as CRM. Portal mirrors and shared projects are never written here. */
export const crmStore: CrmStore = {
  clients: () => docs<ClientRec>("client", null),
  projects: () => docs<Project>("project"),
  details: (id) => privOf(id)?.data,
  documents: crmProjectDocs,
  recordExists: (id) => !!doc(id),
  addClient: async (patch, id) => {
    const cid = await addClient({ name: patch.name ?? "New client", contactName: patch.contactName ?? undefined,
      email: patch.email ?? undefined, greetingName: patch.greetingName ?? undefined, notes: patch.notes ?? undefined,
      timezone: patch.timezone ?? undefined }, { id });
    await updateClient(cid, { status: "client", ...patch }, { syncPortal: false });
    return cid;
  },
  editClient: (id, patch) => updateClient(id, patch, { syncPortal: false }),
  addProject: (client, patch, today, id) => addProject(client.ws, patch.type ?? "custom", patch.title, {
    stages: [], current: 0, pipeline: "in_build", startDate: today, status: "on_track", ...patch, clientVisible: false,
  }, { id }),
  editProject: (id, patch) => updateProject(id, (data) => {
    if (doc(id)?.ws !== null) throw new Error("Shared project.");
    return { ...data, ...patch };
  }),
  saveDetails: (id, patch) => updatePrivate(id, patch),
  addActivity: addCrmActivity,
  editActivity: editCrmActivity,
  removeActivity: removeCrmActivity,
  attach: attachCrmDoc,
  readFile: readCrmDoc,
  removeFile: removeCrmDoc,
  setTaskDone: setTodoDone,
  deleteTask: deleteTodo,
  addTask: (cid, pid, input, id) => addClientTodo(cid, pid, { ...input, ai: true } as typeof input, id),
  editTask: editClientTodo,
};
