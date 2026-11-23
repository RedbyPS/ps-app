// Run: node --experimental-strip-types tests/clients-tab.test.ts
// PS 1.74: Clients on the Mac's Tab list (core/clientsop.ts, core/clientsact.ts, wired in ps.ts). In 1.73 the Tab list got no
// projects and could not save anything in Clients ("+ New project" did nothing: vault.ts put refused with "Not from the Tab
// list."). Now the Tab list gets the Clients records and every save goes to the main window as an op, run there on the
// newest copy. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpLane, cleanClientsOp, cleanTaskPatch, type ClientsOp } from "../src/core/clientsop.ts";

let n = 0;
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const ID = "0b9f3c1e-1111-4222-8333-944455556666", P = "1c8e2d0f-aaaa-4bbb-8ccc-9dddeeeeffff", WS = "2d7f1e0a-bbbb-4ccc-8ddd-9eeeffff0000";
/** What psPost does to an op on its way to the main window. */
const travel = (o: unknown) => JSON.parse(JSON.stringify(o));

// ---------- every op the Tab list sends arrives as it was sent ----------
const ops: ClientsOp[] = [
  { op: "newClient", id: ID, name: "New client", order: 3, today: "2026-11-22" },
  { op: "renameClient", id: ID, name: "Example Co" },
  { op: "orderClients", ids: [ID, P] },
  { op: "removeClient", id: ID },
  { op: "newProject", id: P, ws: WS, title: "First project", today: "2026-11-22" },
  { op: "renameProject", id: P, title: "Website" },
  { op: "projectStatus", id: P, status: "action_needed" },
  { op: "nowLine", id: P, text: "Waiting on the logo" },
  { op: "stageDone", id: P, k: 1, today: "2026-11-22" },
  { op: "stageAdd", id: P, name: "New stage", today: "2026-11-22" },
  { op: "stageEdit", id: P, i: 0, patch: { name: "Design", start: "2026-11-23", due: null } },
  { op: "stageMove", id: P, from: 2, to: 0 },
  { op: "stageRemove", id: P, i: 2 },
  { op: "checkAdd", id: P, text: "Send the brief" },
  { op: "checkTick", id: P, item: "a1b2c3d4e5f6" },
  { op: "checkRemove", id: P, item: "a1b2c3d4e5f6" },
  { op: "notes", id: P, text: "Call on Friday.\nBring the plan." },
  { op: "addTodo", id: ID, clientId: ID, projectId: P, task: { title: "Prep for the call", type: "once", repeat: null, due: null, doOn: "2026-11-24",
    deadline: { date: "2026-11-25", time: "15:00", eventId: "ev1", title: "Kick off" } } },
  { op: "editTodo", id: ID, patch: { p1: true } },
  { op: "tickTodo", id: ID },
  { op: "removeTodo", id: ID },
  { op: "saveTemplate", id: P, clientName: "Example Co", taskIds: [ID], today: "2026-11-22" },
  { op: "fromTemplate", id: P, tpl: ID, clientId: ID, today: "2026-11-22" },
  { op: "removeTemplate", id: ID },
  // PS 1.77: the tab menu
  { op: "unarchiveClient", id: ID },
  { op: "deleteClient", id: ID },
  { op: "clientSettings", id: ID, patch: { name: "Example Co", colour: "#7FB7F5", contactName: "Jo", email: null } },
];
ok("every Clients op survives the trip to the main window unchanged", () => {
  for (const o of ops) assert.deepEqual(cleanClientsOp(travel(o)), o, o.op);
});
ok("every op the relay can build is covered (no op the main window would drop)", () => {
  const a = src("../src/core/clientsact.ts");
  const built = new Set([...a.matchAll(/op: "([a-zA-Z]+)"/g)].map((m) => m[1]));
  const known = new Set(ops.map((o) => o.op));
  for (const b of built) assert.ok(known.has(b as ClientsOp["op"]), b);
  for (const k of known) assert.ok(built.has(k), `${k} is never sent`);
});

// ---------- broken or foreign ops are refused ----------
ok("refused: unknown op, bad ids, bad dates, bad status, empty checklist step, a patch with nothing in it", () => {
  const bad: unknown[] = [null, "x", {}, { op: "dropTable", id: ID }, { op: "renameClient", id: "../x", name: "a" },
    { op: "renameClient", id: ID }, { op: "newClient", id: ID, name: "a", order: -1, today: "2026-11-22" },
    { op: "newProject", id: P, ws: WS, title: "a", today: "22 Nov" }, { op: "projectStatus", id: P, status: "lost" },
    { op: "checkAdd", id: P, text: "   " }, { op: "editTodo", id: ID, patch: { done: true, order: 4, clientId: "x" } },
    { op: "orderClients", ids: [ID, 5] }, { op: "stageEdit", id: P, i: 0, patch: {} }, { op: "stageMove", id: P, from: 1.5, to: 0 },
    { op: "addTodo", id: ID, clientId: ID, projectId: P, task: { title: " " } }];
  for (const b of bad) assert.equal(cleanClientsOp(b), null, JSON.stringify(b));
});
ok("long words are cut to the screen's own limits", () => {
  const o = cleanClientsOp({ op: "notes", id: P, text: "n".repeat(30_000) }) as { text: string };
  assert.equal(o.text.length, 20_000);
  const r = cleanClientsOp({ op: "renameClient", id: ID, name: "c".repeat(300) }) as { name: string };
  assert.equal(r.name.length, 80);
});
ok("a task patch keeps only what the Clients screen edits (never done, order, client or project)", () => {
  const p = cleanTaskPatch({ title: "  Call back ", p1: true, done: true, order: 9, clientId: "x", projectId: "y", doOn: "2026-11-24", due: "soon",
    deadline: { date: "2026-11-25", time: "3pm", gone: true }, repeat: { every: 1, unit: "week", from: "2026-11-23", days: [1, 4] } });
  assert.equal(p.title, "Call back");
  assert.equal(p.p1, true);
  assert.equal(p.doOn, "2026-11-24");
  assert.equal("due" in p, false);
  assert.deepEqual(p.deadline, { date: "2026-11-25", gone: true });
  assert.equal(p.repeat?.unit, "week");
  for (const k of ["done", "order", "clientId", "projectId"]) assert.equal(k in p, false, k);
});
ok("ops run one after another in the order they came (a new client, then its rename)", async () => {
  const lane = new OpLane(), seen: string[] = [];
  const slow = (x: string, ms: number) => lane.run(async () => { await new Promise((r) => setTimeout(r, ms)); seen.push(x); });
  const fail = lane.run(async () => { throw new Error("offline"); });
  await Promise.all([slow("new", 20), slow("rename", 0), fail.catch(() => {}), slow("project", 5)]);
  assert.deepEqual(seen, ["new", "rename", "project"]);
});

// ---------- wiring ----------
ok("the Tab list gets the Clients records: projects, their checklist and notes, templates", () => {
  const p = src("../src/ps.ts");
  const send = p.slice(p.indexOf("const send = () => {"), p.indexOf("if (cal) docs.push(cal);"));
  for (const k of ["client", "project", "pprivate", "ptpl", "todo"]) assert.match(send, new RegExp(`d\\.kind === "${k}"`), k);
});
ok("the Tab list sends Clients saves to the main window, which checks them and runs them", () => {
  const p = src("../src/ps.ts");
  const ov = p.slice(p.indexOf("export function startPsOverlay"), p.indexOf("setMirrorWriter((w) =>"));
  assert.match(ov, /setClientsRelay\(\(op\) => psPost\(\{ type: "looks", patch: \{ clientsOp: op \} \}\)\)/);
  assert.match(p, /cleanClientsOp\(patch\.clientsOp\); if \(o\) void runClientsOp\(o\)/);
});
ok("every Clients save asks the relay first (nothing in Clients reaches vault.ts put on the Tab list)", () => {
  const a = src("../src/core/clientsact.ts");
  const saves = ["newClient", "renameClient", "orderClients", "removeClient", "newProject", "renameProject", "setProjectStatus", "setNowLine",
    "stageDone", "stageAdd", "stageEdit", "stageMove", "stageRemove", "checkAdd", "checkTick", "checkRemove", "saveNotes", "addClientTodo",
    "editClientTodo", "tickClientTodo", "removeClientTodo", "saveTemplate", "projectFromTemplate", "removeTemplate",
    "archiveClient", "unarchiveClient", "setClientSettings", "deleteClient"];   // PS 1.77: the tab menu
  const exported = [...a.matchAll(/^export (?:const|function|async function) (\w+)/gm)].map((m) => m[1]);
  for (const s of saves) {
    assert.ok(exported.includes(s), s);
    const i = a.search(new RegExp(`^export (?:const|function|async function) ${s}\\b`, "m"));
    const next = a.slice(i + 1).search(/^export /m);
    assert.match(a.slice(i, next < 0 ? undefined : i + 1 + next), /relay/, `${s} has no relay branch`);
  }
  // Everything exported is a save with a relay branch, a read (templates, checklistOf), or the wiring itself.
  for (const e of exported) assert.ok(saves.includes(e) || ["templates", "checklistOf", "setClientsRelay", "runClientsOp"].includes(e), e);
  // And the screens use only these: no direct vault or actions writes left in the Clients folder.
  for (const f of ["ClientsScreen.tsx", "Tasks.tsx", "StageLine.tsx"]) {
    const t = src(`../src/clients/${f}`);
    assert.doesNotMatch(t, /from "\.\.\/core\/(vault|actions)"/, f);
  }
});
// Last check before the 1.74 release: with no sync or no internet the main window refuses a new client with only a log
// line, so the Tab list's "+" did nothing and said nothing. It now says why, before anything is sent.
ok("the Tab list's + says why a new client cannot be made (no sync, offline) instead of doing nothing", () => {
  const a = src("../src/core/clientsact.ts");
  const nc = a.slice(a.indexOf("export async function newClient"), a.indexOf("export const renameClient"));
  const local = nc.indexOf("if (vaultStore.get().local) throw new Error(NEEDS_SYNC);"), off = nc.indexOf('navigator.onLine === false) throw new Error("Connect to the internet to add a new client.");');
  const sends = nc.indexOf('relay({ op: "newClient"');
  assert.ok(local > 0 && off > local && sends > off, "both checks come before the op is sent");
  assert.ok(nc.indexOf("if (relay) {") < local, "and only on the Tab list");
  // the same words the main window uses
  const v = src("../src/core/vault.ts");
  assert.match(v, /if \(!navigator\.onLine\) throw new Error\("Connect to the internet to add a new client\."\);/);
  // and the screen shows a thrown message
  assert.match(src("../src/clients/ClientsScreen.tsx"), /catch \(e\) \{ say\(e instanceof Error \? e\.message : "Could not add a client now\."\); return; \}/);
});
ok("the main window runs each op only on its own kind of record, and a new record keeps the id the Tab list picked", () => {
  const a = src("../src/core/clientsact.ts");
  const run = a.slice(a.indexOf("export function runClientsOp"));
  assert.match(run, /if \(relay\) return;/);
  assert.match(run, /CLIENT\.has\(o\.op\) && kind\(oid\) !== "client"/);
  assert.match(run, /PROJECT\.has\(o\.op\) && kind\(oid\) !== "project"/);
  assert.match(run, /newClient\(o\.name, o\.order, o\.today, o\.id\)/);
  assert.match(run, /newProject\(o\.ws, o\.title, o\.today, undefined, o\.id\)/);
  assert.match(run, /addClientTodo\(o\.clientId, o\.projectId, o\.task, o\.id\)/);
  assert.match(a, /if \(id && doc\(id\)\) return id;/, "the same new client twice makes one");
  const act = src("../src/core/actions.ts");
  assert.match(act, /\{ ws: null, \.\.\.\(opts\.id \? \{ id: opts\.id \} : \{\}\) \}\);/);
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok -", name); }
console.log(`\n${n} passed`);
