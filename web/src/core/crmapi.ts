import { CRM_ACTIVITY_KINDS, CRM_ACTIVITY_MAX, CRM_FILE_KINDS, CRM_LOOKS, cleanCrmAppearance, decodeCrmFile, encodeCrmFile, projectDetails, type CrmActivity, type CrmAppearance } from "./crmdata.ts";
import { CLIENT_STATUSES, PIPELINE, PROJECT_TYPES, type ClientRec, type Doc, type Project, type ProjectDoc, type ProjectPrivate, type Todo } from "./model.ts";
import { cleanGroups, tabLists } from "./groups.ts";
import { prioNumbers } from "./prio.ts";
import { cleanRepeat } from "./repeat.ts";
import { okTz, removeReminder, reminderOfTask } from "./remind.ts";
import type { ApiReq, ApiRes, ApiStore, ScopeId, Scopes } from "./taskapi.ts";

type WriteTask = Partial<Todo> & { priority?: number | null };
export interface CrmStore {
  clients(): Doc<ClientRec>[];
  projects(): Doc<Project>[];
  details(id: string): ProjectPrivate | undefined;
  documents(id: string): Doc<ProjectDoc>[];
  recordExists(id: string): boolean;
  addClient(patch: Partial<ClientRec>, id?: string): Promise<string>;
  editClient(id: string, patch: Partial<ClientRec>): Promise<void>;
  addProject(client: ClientRec, patch: Partial<Project>, today: string, id?: string): Promise<string>;
  editProject(id: string, patch: Partial<Project>): Promise<void>;
  saveDetails(id: string, patch: Partial<ProjectPrivate>): Promise<void>;
  addActivity(id: string, entry: Omit<CrmActivity, "id"> & { id?: string }): Promise<CrmActivity>;
  editActivity(id: string, activityId: string, patch: Partial<Omit<CrmActivity, "id">>): Promise<void>;
  removeActivity(id: string, activityId: string): Promise<void>;
  attach(id: string, file: { bytes: Uint8Array; name: string }, label: string, kind: ProjectDoc["docKind"], docId?: string): Promise<string>;
  readFile(id: string, docId: string): Promise<{ bytes: Uint8Array; name: string }>;
  removeFile(id: string, docId: string): Promise<void>;
  addTask(clientId: string, projectId: string, input: WriteTask & Pick<Todo, "title" | "type">, id?: string): Promise<string>;
  editTask(id: string, patch: WriteTask): Promise<void>;
  setTaskDone(id: string, done: boolean): Promise<void>;
  deleteTask(id: string): Promise<void>;
}

export const CRM_ENDPOINTS = [
  "GET /v1/crm", "GET /v1/crm/appearance", "PATCH /v1/crm/appearance",
  "GET /v1/crm/clients", "POST /v1/crm/clients", "GET /v1/crm/clients/{id}", "PATCH /v1/crm/clients/{id}", "DELETE /v1/crm/clients/{id}",
  "GET /v1/crm/clients/{id}/projects", "POST /v1/crm/clients/{id}/projects",
  "GET /v1/crm/projects/{id}", "PATCH /v1/crm/projects/{id}", "DELETE /v1/crm/projects/{id}",
  "GET /v1/crm/projects/{id}/details", "PATCH /v1/crm/projects/{id}/details",
  "GET /v1/crm/projects/{id}/activity", "POST /v1/crm/projects/{id}/activity",
  "GET /v1/crm/projects/{id}/activity/{entryId}", "PATCH /v1/crm/projects/{id}/activity/{entryId}", "DELETE /v1/crm/projects/{id}/activity/{entryId}",
  "GET /v1/crm/projects/{id}/documents", "POST /v1/crm/projects/{id}/documents",
  "GET /v1/crm/projects/{id}/documents/{documentId}", "DELETE /v1/crm/projects/{id}/documents/{documentId}",
  "GET /v1/crm/projects/{id}/tasks", "POST /v1/crm/projects/{id}/tasks",
  "GET /v1/crm/projects/{id}/tasks/{taskId}", "PATCH /v1/crm/projects/{id}/tasks/{taskId}", "DELETE /v1/crm/projects/{id}/tasks/{taskId}",
];

type Body = Record<string, unknown>;
type Field = (v: unknown, k: string) => unknown;
type Fields = Record<string, Field>;
const denied = (scope: ScopeId): ApiRes => error(403, "scope_off", `The "${scope}" switch is off in PS, Settings, AI task API.`, { scope });
const error = (status: number, code: string, message: string, extra: Body = {}): ApiRes => ({ status, body: { error: { code, message, ...extra } } });
const ok = (body: unknown, status = 200): ApiRes => ({ status, body });
const missing = () => error(404, "not_found", "No matching CRM record or endpoint.");
const collision = () => error(409, "id_in_use", "This ID already belongs to another record.");
const wrongMethod = (...allow: string[]) => error(405, "method_not_allowed", `Use ${allow.join(", ")} here.`, { allow });
const isObj = (v: unknown): v is Body => !!v && typeof v === "object" && !Array.isArray(v);
const HEX = /^#[\da-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class InvalidField extends Error {
  readonly field: string;
  readonly code: string;
  constructor(field: string, message: string, code = "bad_field") {
    super(message);
    this.field = field;
    this.code = code;
  }
}
const bad = (key: string, words: string): never => { throw new InvalidField(key, `${key} ${words}`); };
const text = (max: number, empty = false): Field => (v, k) => {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim())) return bad(k, `must be text up to ${max} characters.`);
  return v.trim();
};
const optional = (f: Field): Field => (v, k) => v === null ? null : f(v, k);
const choice = (choices: readonly string[]): Field => (v, k) => typeof v === "string" && choices.includes(v) ? v : bad(k, `must be one of ${choices.join(", ")}.`);
const numeric = (min: number, max: number, integer = true): Field => (v, k) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)) ? v : bad(k, `must be a number from ${min} to ${max}.`);
const bool: Field = (v, k) => typeof v === "boolean" ? v : bad(k, "must be true or false.");
const matching = (re: RegExp, words: string): Field => (v, k) => typeof v === "string" && re.test(v) ? v : bad(k, words);
const day: Field = (v, k) => {
  if (typeof v !== "string" || !DAY.test(v)) return bad(k, "must be YYYY-MM-DD.");
  const d = new Date(`${v}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) return bad(k, "must be a real date.");
  return v;
};
const dateTime: Field = (v, k) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) {
    return bad(k, "must be an ISO date and time with a time zone.");
  }
  return new Date(v).toISOString();
};
const url: Field = (v, k) => {
  if (typeof v !== "string" || v.length > 2000) return bad(k, "must be an HTTPS URL.");
  try {
    const u = new URL(v);
    if (u.protocol === "https:" && !u.username && !u.password) return u.href;
  } catch {}
  return bad(k, "must be an HTTPS URL.");
};
const array = (max: number, field: Field): Field => (v, k) => {
  if (!Array.isArray(v) || v.length > max) return bad(k, `must be a list with at most ${max} entries.`);
  return v.map((value, i) => field(value, `${k}[${i}]`));
};
function shape<T>(raw: unknown, fields: Fields, required: string[] = [], label = ""): T {
  if (!isObj(raw)) return bad(label || "body", "must be a JSON object.");
  const key = (k: string) => label ? `${label}.${k}` : k;
  for (const k of required) if (!Object.hasOwn(raw, k)) bad(key(k), "is required.");
  const out: Body = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(fields, k)) throw new InvalidField(key(k), `Unknown field ${key(k)}.`, "unknown_field");
    out[k] = fields[k](v, key(k));
  }
  return out as T;
}
const nested = (fields: Fields, required: string[] = []): Field => (v, k) => shape(v, fields, required, k);
const idField: Field = (v, k) => typeof v === "string" && UUID.test(v) ? v.toLowerCase() : bad(k, "must be a UUID.");
const clientFields = {
  name: text(80), status: optional(choice(CLIENT_STATUSES.map((x) => x.key))), order: optional(numeric(0, 10_000)),
  colour: optional(matching(HEX, "must be a hex colour such as #9966CC or null.")), archived: bool,
  contactName: optional(text(120)), email: optional(matching(/^(?=.{1,200}$)[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address or null.")),
  phone: optional(text(60)), phones: array(20, text(60)), greetingName: optional(text(60)), notes: optional(text(20_000, true)),
  matchAddrs: array(30, text(200)), timezone: optional((v, k) => okTz(v) || bad(k, "must be an IANA time zone or null.")),
};
const stageFields = {
  key: matching(/^[\w-]{1,80}$/, "must use letters, numbers, underscores or hyphens."), name: text(120),
  info: optional(text(2000, true)), start: optional(day), due: optional(day), doneAt: optional(day), clientAction: optional(text(2000)),
  gate: optional(choice(["direction", "design", "launch", "review"])),
  previews: array(20, nested({ id: text(64), label: text(120), url, note: optional(text(2000)), addedAt: dateTime, expiresAt: optional(dateTime) }, ["id", "label", "url", "addedAt"])),
};
const proposalFields = {
  url: optional(url), sentAt: optional(day), signedAt: optional(day), price: optional(numeric(0, 1e9, false)),
  currency: optional(matching(/^[A-Z]{3}$/, "must be a three-letter currency code.")), scope: array(100, text(2000)),
  timelineText: optional(text(2000, true)), status: optional(choice(["draft", "sent", "accepted", "superseded", "declined"])),
  links: array(40, nested({ label: text(120), url, kind: choice(["live", "pdf", "superseded", "other"]), date: optional(day) }, ["label", "url"])),
  splitText: optional(text(2000, true)), afterLaunch: optional(text(2000, true)), priceUnit: optional(choice(["month", "video"])),
};
const projectFields = {
  title: text(120), type: choice(PROJECT_TYPES.map((x) => x.key)), pipeline: choice(PIPELINE.map((x) => x.key)),
  status: optional(choice(["on_track", "at_risk", "action_needed"])), archived: bool,
  nowLine: optional(text(200, true)), nowWindow: optional(text(200, true)), startDate: optional(day), promisedDelivery: optional(day),
  originalDelivery: optional(day), startsMonth: optional(matching(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM.")),
  liveUrls: array(30, url), current: numeric(0, 100),
  stages: array(100, nested(stageFields, ["key", "name", "previews"])), proposal: nested(proposalFields),
  payments: array(100, nested({ id: text(64), label: text(120), amount: numeric(0, 1e9, false), currency: proposalFields.currency,
    due: optional(day), status: choice(["paid", "owed", "upcoming"]), paidAt: optional(day) }, ["id", "label", "amount", "currency", "status"])),
};
const detailsFields = {
  notes: optional(text(20_000, true)), nextStep: optional(text(2000)), nextDue: optional(day), waitingOn: optional(choice(["me", "client"])),
  waitingWhat: optional(text(2000)), waitingSince: optional(day), nextInvoiceDate: optional(day),
  checklist: array(200, nested({ id: text(64), text: text(300), done: bool, at: optional(dateTime) }, ["id", "text", "done", "at"])),
};
const activityFields = { kind: choice(CRM_ACTIVITY_KINDS), text: text(20_000), at: dateTime, source: optional(text(120)), url: optional(url) };
const lookFields = { look: choice(CRM_LOOKS), density: choice(["comfortable", "compact"]), showClientColours: bool, showTaskColours: bool };
const taskFields = {
  title: text(500), type: choice(["once", "daily"]), notes: optional(text(20_000, true)),
  due: optional(day), doOn: optional(day), priority: optional(numeric(1, 500)), done: bool,
  est: optional(numeric(1, 1440)), checkEvery: optional(numeric(0, 1440)),
  repeat: optional((v, k) => isObj(v) ? v : bad(k, "must be a recurring task rule or null.")),
  deadline: optional(nested({ date: day, time: optional(matching(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM.")), title: optional(text(200)) }, ["date"])),
};
const clientView = (d: Doc<ClientRec>) => ({
  id: d.id, name: d.data.name, status: d.data.status ?? null, order: d.data.order ?? null, archived: !!d.data.archived,
  colour: d.data.colour ?? null, contactName: d.data.contactName ?? null, email: d.data.email ?? null,
  phone: d.data.phone ?? null, phones: d.data.phones ?? [], greetingName: d.data.greetingName ?? null,
  timezone: d.data.timezone ?? null, matchAddrs: d.data.matchAddrs ?? [], notes: d.data.notes ?? null, createdAt: d.data.createdAt,
});
const projectView = (d: Doc<Project>, clientId: string) => {
  const { clientWs, clientVisible, ...p } = d.data;
  return { ...p, id: d.id, clientId, portalShared: d.ws !== null };
};
const documentView = (d: Doc<ProjectDoc>) => {
  const { blobId, ...file } = d.data;
  return { ...file, id: d.id };
};
const taskView = (d: Doc<Todo>, ranks: Map<string, number>) => ({ ...d.data, id: d.id, priority: ranks.get(d.id) ?? (d.data.p1 ? 1 : null) });
const taskRanks = (store: ApiStore) => prioNumbers(tabLists(store.todos(), cleanGroups(store.settings().tmGroups), store.today(), undefined, store.land?.()).ranked
  .map((d) => ({ ...d.data, id: d.id, p1: d.data.p1 === true })));
const withId = <T>(body: unknown, fields: Fields, required: string[]): { id?: string; patch: T } => {
  const { id, ...patch } = shape<{ id?: string } & Body>(body, { ...fields, id: idField }, required);
  return { id, patch: patch as T };
};
const filtered = <T>(list: T[], query: ApiReq["query"]) => {
  const offset = query?.offset === undefined ? 0 : Number(query.offset);
  const limit = query?.limit === undefined ? 100 : Number(query.limit);
  numeric(0, 100_000)(offset, "offset");
  numeric(1, 200)(limit, "limit");
  return { list: list.slice(offset, offset + limit), nextOffset: offset + limit < list.length ? offset + limit : null };
};
const httpScope: Record<string, ScopeId> = { GET: "read", POST: "add", PATCH: "edit", DELETE: "delete" };
const projectClient = (d: Doc<Project>, clients: Doc<ClientRec>[]) => clients.find((c) => c.data.ws === (d.ws ?? d.data.clientWs));

export async function handleCrmApi(method: string, seg: string[], req: ApiReq, scopes: Scopes, store: ApiStore): Promise<ApiRes> {
  if (!scopes.crm) return denied("crm");
  const crm = store.crm;
  if (!crm) return error(503, "not_ready", "CRM is unavailable here.");
  const scope = httpScope[method];
  if (!scope) return wrongMethod("GET", "POST", "PATCH", "DELETE");
  if (!scopes[scope]) return denied(scope);
  try { return await routeCrm(method, seg, req, scopes, store, crm); }
  catch (e) {
    if (e instanceof InvalidField) return error(400, e.code, e.message, { field: e.field });
    throw e;
  }
}

async function routeCrm(method: string, seg: string[], req: ApiReq, scopes: Scopes, store: ApiStore, crm: CrmStore): Promise<ApiRes> {
  const [kind, id, child, sub] = seg;
  if (seg.length > 4) return missing();
  if (!kind) return method === "GET" ? ok({ endpoints: CRM_ENDPOINTS }) : wrongMethod("GET");
  if (kind === "appearance" && !id) {
    if (method === "PATCH") await store.saveSettings({ crmAppearance: shape<Partial<CrmAppearance>>(req.body, lookFields) });
    else if (method !== "GET") return wrongMethod("GET", "PATCH");
    return ok({ appearance: cleanCrmAppearance(store.settings().crmAppearance) });
  }
  const clients = crm.clients();
  const projects = crm.projects();
  if (kind === "clients" && !sub) return clientRoute(method, id, child, req, store, crm, clients, projects);
  if (kind !== "projects" || !id) return missing();
  const project = projects.find((d) => d.id === id);
  const client = project && projectClient(project, clients);
  if (!project || !client) return missing();
  if (!child) {
    if (method === "GET") return ok({ project: projectView(project, client.id) });
    if (!["PATCH", "DELETE"].includes(method)) return wrongMethod("GET", "PATCH", "DELETE");
    if (project.ws !== null) return error(403, "shared_project", "Change private details here. Edit shared project fields in PS.");
    const patch = method === "DELETE" ? { archived: true } : parseProject(req.body, project.data);
    await crm.editProject(id, patch);
    return ok({ project: projectView({ ...project, data: { ...project.data, ...patch } }, client.id) });
  }
  if (child === "details" && !sub) {
    if (method === "GET") return ok({ details: projectDetails(crm.details(id)) });
    if (method !== "PATCH") return wrongMethod("GET", "PATCH");
    const patch = shape<Partial<ProjectPrivate>>(req.body, detailsFields);
    await crm.saveDetails(id, patch);
    return ok({ details: projectDetails(crm.details(id)) });
  }
  if (child === "activity") return activityRoute(method, id, sub, req, store, crm);
  if (child === "documents") return documentRoute(method, id, sub, req, crm);
  if (child === "tasks") return taskRoute(method, client.id, id, sub, req, scopes, store, crm);
  return missing();
}

function parseProject(body: unknown, current?: Project): Partial<Project> {
  const p = shape<Omit<Partial<Project>, "proposal"> & { proposal?: Partial<Project["proposal"]> }>(body, projectFields);
  const { proposal, ...fields } = p;
  const n = p.stages?.length ?? current?.stages?.length ?? 0;
  if (p.current !== undefined && p.current > n) return bad("current", "cannot be past the last stage.");
  if (p.stages?.length !== undefined && p.current === undefined && (current?.current ?? 0) > n) p.current = n;
  if (p.stages && new Set(p.stages.map((s) => s.key)).size !== n) return bad("stages", "must use distinct stage keys.");
  return { ...fields, ...(p.current === undefined ? {} : { current: p.current }), ...(proposal ? { proposal: { scope: [], ...current?.proposal, ...proposal } } : {}) };
}

async function clientRoute(method: string, id: string | undefined, child: string | undefined, req: ApiReq, store: ApiStore, crm: CrmStore, clients: Doc<ClientRec>[], projects: Doc<Project>[]): Promise<ApiRes> {
  if (!id) {
    if (method === "GET") {
      const query = req.query?.q?.toLocaleLowerCase();
      const matches = clients.filter((d) => (!query || d.data.name.toLocaleLowerCase().includes(query))
        && (!req.query?.status || d.data.status === req.query.status)
        && (req.query?.archived !== "true" || d.data.archived)).sort((a, b) => (a.data.order ?? Infinity) - (b.data.order ?? Infinity) || a.data.name.localeCompare(b.data.name));
      const { list, nextOffset } = filtered(matches, req.query);
      return ok({ clients: list.map(clientView), nextOffset });
    }
    if (method !== "POST") return wrongMethod("GET", "POST");
    const input = withId<Partial<ClientRec>>(req.body, clientFields, ["name"]);
    const old = clients.find((c) => c.id === input.id);
    if (old) return ok({ client: clientView(old) });
    if (input.id && crm.recordExists(input.id)) return collision();
    const cid = await crm.addClient(input.patch, input.id);
    const doc = crm.clients().find((c) => c.id === cid);
    return ok({ client: doc ? clientView(doc) : { id: cid } }, 201);
  }
  const client = clients.find((c) => c.id === id);
  if (!client) return missing();
  if (!child) {
    if (method === "GET") return ok({ client: clientView(client) });
    if (!["PATCH", "DELETE"].includes(method)) return wrongMethod("GET", "PATCH", "DELETE");
    const patch = method === "DELETE" ? { archived: true } : shape<Partial<ClientRec>>(req.body, clientFields);
    await crm.editClient(id, patch);
    return ok({ client: clientView({ ...client, data: { ...client.data, ...patch } }) });
  }
  if (child !== "projects") return missing();
  const own = projects.filter((p) => projectClient(p, [client]));
  if (method === "GET") {
    const { list, nextOffset } = filtered(own, req.query);
    return ok({ projects: list.map((p) => projectView(p, id)), nextOffset });
  }
  if (method !== "POST") return wrongMethod("GET", "POST");
  const input = withId<Partial<Project>>(req.body, projectFields, ["title"]);
  const old = own.find((p) => p.id === input.id && p.ws === null);
  if (old) return ok({ project: projectView(old, id) });
  if (input.id && crm.recordExists(input.id)) return collision();
  const pid = await crm.addProject(client.data, parseProject(input.patch), store.today(), input.id);
  const doc = crm.projects().find((p) => p.id === pid);
  return ok({ project: doc ? projectView(doc, id) : { id: pid } }, 201);
}

async function activityRoute(method: string, id: string, sub: string | undefined, req: ApiReq, store: ApiStore, crm: CrmStore): Promise<ApiRes> {
  const list = crm.details(id)?.activity ?? [];
  if (!sub) {
    if (method === "GET") return ok({ activity: list });
    if (method !== "POST") return wrongMethod("GET", "POST");
    const input = withId<Omit<CrmActivity, "id" | "at"> & { at?: string }>(req.body, activityFields, ["kind", "text"]);
    const old = list.find((d) => d.id === input.id);
    if (old) return ok({ entry: old });
    if (list.length >= CRM_ACTIVITY_MAX) return error(409, "too_many", "This project already has 200 activity entries.");
    const entry = await crm.addActivity(id, { at: new Date(store.now()).toISOString(), ...input.patch, id: input.id });
    return ok({ entry }, 201);
  }
  const entry = list.find((d) => d.id === sub);
  if (!entry) return missing();
  if (method === "GET") return ok({ entry });
  if (method === "PATCH") {
    const patch = shape<Partial<CrmActivity>>(req.body, activityFields);
    await crm.editActivity(id, sub, patch);
    return ok({ entry: { ...entry, ...patch } });
  }
  if (method !== "DELETE") return wrongMethod("GET", "PATCH", "DELETE");
  await crm.removeActivity(id, sub);
  return ok({ deleted: sub });
}

async function documentRoute(method: string, id: string, sub: string | undefined, req: ApiReq, crm: CrmStore): Promise<ApiRes> {
  const list = crm.documents(id);
  if (!sub) {
    if (method === "GET") {
      const { list: page, nextOffset } = filtered(list, req.query);
      return ok({ documents: page.map(documentView), nextOffset });
    }
    if (method !== "POST") return wrongMethod("GET", "POST");
    const file: Field = (v, k) => decodeCrmFile(v) ?? bad(k, "must be a base64 PDF up to 5 MB.");
    const input = withId<{ name: string; label?: string; kind?: ProjectDoc["docKind"]; file: Uint8Array }>(req.body,
      { name: text(200), label: text(120), kind: choice(CRM_FILE_KINDS), file }, ["name", "file"]);
    const old = list.find((d) => d.id === input.id);
    if (old) return ok({ document: documentView(old) });
    if (input.id && crm.recordExists(input.id)) return collision();
    const p = input.patch;
    const docId = await crm.attach(id, { bytes: p.file, name: p.name }, p.label ?? p.name, p.kind ?? "other", input.id);
    const doc = crm.documents(id).find((d) => d.id === docId);
    return ok({ document: doc ? documentView(doc) : { id: docId } }, 201);
  }
  const doc = list.find((d) => d.id === sub);
  if (!doc) return missing();
  if (method === "GET") {
    const document = documentView(doc);
    if (req.query?.file !== "true") return ok({ document });
    const file = await crm.readFile(id, sub);
    return ok({ document, file: encodeCrmFile(file.bytes) });
  }
  if (method !== "DELETE") return wrongMethod("GET", "DELETE");
  await crm.removeFile(id, sub);
  return ok({ deleted: sub });
}

async function taskRoute(method: string, clientId: string, projectId: string, sub: string | undefined, req: ApiReq, scopes: Scopes, store: ApiStore, crm: CrmStore): Promise<ApiRes> {
  if (!scopes.lists) return denied("lists");
  const list = store.todos().filter((d) => d.ws === null && d.data.clientId === clientId && d.data.projectId === projectId && !d.data.aiInbox);
  if (!sub) {
    if (method === "GET") {
      const { list: page, nextOffset } = filtered(list, req.query);
      const ranks = taskRanks(store);
      return ok({ tasks: page.map((d) => taskView(d, ranks)), nextOffset });
    }
    if (method !== "POST") return wrongMethod("GET", "POST");
    const { id, patch: { done, ...task } } = withId<WriteTask>(req.body, taskFields, ["title"]);
    if (done !== undefined && !scopes.done) return denied("done");
    const old = list.find((d) => d.id === id);
    if (old) return ok({ task: taskView(old, taskRanks(store)) });
    if (id && crm.recordExists(id)) return collision();
    const patch = parseTask(task, task.type ?? "once", store.today());
    const tid = await crm.addTask(clientId, projectId, { ...patch, title: task.title!, type: task.type ?? "once" }, id);
    if (done === true) await crm.setTaskDone(tid, true);
    const saved = store.todos().find((d) => d.id === tid);
    return ok({ task: saved ? taskView(saved, taskRanks(store)) : { id: tid } }, 201);
  }
  const task = list.find((d) => d.id === sub);
  if (!task) return missing();
  if (method === "GET") return ok({ task: taskView(task, taskRanks(store)) });
  if (method === "PATCH") {
    const { done, ...patch } = shape<WriteTask>(req.body, taskFields);
    if (done !== undefined && !scopes.done) return denied("done");
    const next = parseTask(patch, patch.type ?? task.data.type, store.today());
    if (Object.keys(next).length) await crm.editTask(sub, next);
    if (done !== undefined) await crm.setTaskDone(sub, done);
    const saved = store.todos().find((d) => d.id === sub);
    return ok({ task: taskView(saved ?? { ...task, data: { ...task.data, ...next, ...(done === undefined ? {} : { done }) } }, taskRanks(store)) });
  }
  if (method !== "DELETE") return wrongMethod("GET", "PATCH", "DELETE");
  await crm.deleteTask(sub);
  await store.saveRemind((rec) => {
    const reminder = reminderOfTask(rec, sub);
    return rec && reminder ? removeReminder(rec, reminder.id, store.now()) : null;
  });
  return ok({ deleted: sub });
}
function parseTask(patch: WriteTask, type: Todo["type"], today: string): WriteTask {
  if (patch.repeat) {
    const rule = cleanRepeat(patch.repeat, today);
    if (!rule || type !== "daily") return bad("repeat", "takes a valid rule on a daily task.");
    patch.repeat = rule;
  }
  if (type === "daily") {
    if ((patch.priority ?? 0) > 1) return bad("priority", "must be 1 or null for a daily task.");
    if (patch.doOn || patch.due) return bad("due", "a daily task uses its recurring rule.");
    if (patch.type === "daily") Object.assign(patch, { due: null, doOn: null });
  } else if (patch.type === "once") patch.repeat = null;
  return patch;
}
