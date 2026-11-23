// PS 1.77 Clients screen asks (the developer, 23 Nov 2026): the client tag on tasks, the tab x, the tab right click menu (Rename,
// Delete, Archive, Settings), new projects and clients start empty, and Tasks vs Project steps made plain.
// Pure parts: core/clienttag.ts, core/clientsop.ts. Source checks for the screen wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientTags, tagOfTask } from "../src/core/clienttag.ts";
import { cleanClientSettings, cleanClientsOp, clientProjects } from "../src/core/clientsop.ts";
import { CLIENT_COLOURS, undoWindow } from "../src/core/clientwork.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const ID = "0f6c1b2a-1111-4222-8333-944455556666", ID2 = "1f6c1b2a-1111-4222-8333-944455556666";

// ---------- 1. the client tag ----------
const all = [
  { id: "a", data: { name: "Vale and Clientthree" } },
  { id: "b", data: { name: "Chris page", colour: "#123456" } },
  { id: "c", data: { name: "Old Client", archived: true } },
  { id: "d", data: { name: "  " } },
];
ok("tag: the client's name, in its tab's colour; its own colour wins", () => {
  const t = clientTags(all, ["b", "a"]);
  assert.deepEqual(t.get("a"), { name: "Vale and Clientthree", colour: CLIENT_COLOURS[1] }, "second tab, second colour");
  assert.deepEqual(t.get("b"), { name: "Chris page", colour: "#123456" });
});
ok("tag: an archived client (no tab) still names its tasks, drawn plain; a client with no name gives none", () => {
  const t = clientTags(all, ["a", "b"]);
  assert.deepEqual(t.get("c"), { name: "Old Client", colour: null });
  assert.equal(t.has("d"), false);
});
ok("tag: a task with no client, or a deleted client, shows none", () => {
  const t = clientTags(all, ["a"]);
  assert.equal(tagOfTask({ clientId: null }, t), null);
  assert.equal(tagOfTask({}, t), null);
  assert.equal(tagOfTask({ clientId: "gone" }, t), null);
  assert.equal(tagOfTask({ clientId: "a" }, t)?.name, "Vale and Clientthree");
});
ok("tag: drawn on every task row just left of the P badge, cut short with an ellipsis", () => {
  const tm = src("views/TaskMap.tsx");
  const row = tm.slice(tm.indexOf("function Row("), tm.indexOf("export function Editor("));
  const tag = row.indexOf("<ClientTag t={t} />"), badge = row.indexOf('className="tm-prio num"');
  assert.ok(tag > 0 && badge > tag, "the tag comes before the P badge");
  assert.match(row, /<ClientTag t=\{t\} \/>[^\n]*\n\s*\{n != null && <span className="tm-prio num"/, "nothing between the tag and the badge");
  const css = src("views/taskmap.css");
  assert.match(css, /\.tm-ctag \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(css, /\.tm-row\.working \.tm-ctag/, "readable on the Working on look");
});

// ---------- 2. and 3. the tab x and its right click menu ----------
ok("the x archives the tab (with Undo), it never deletes", () => {
  const cs = src("clients/ClientsScreen.tsx");
  const x = cs.slice(cs.indexOf('className="clw-tabx"'), cs.indexOf('className="clw-tabx"') + 400);
  assert.match(x, /archive\(d\)/);
  assert.doesNotMatch(x, /delete/i);
  assert.match(cs, /const archive = \(d: Doc<ClientRec>\) => \{ setPop\(null\); void archiveClient\(d\.id\); say\(`\$\{d\.data\.name\} archived\. It is under Archived\.`, \(\) => void unarchiveClient\(d\.id\)\); \};/);
});
ok("the x's boxes open under the strip, not inside the sideways scrolling strip that cut them off", () => {
  const cs = src("clients/ClientsScreen.tsx");
  const tabs = cs.slice(cs.indexOf("function Tabs("), cs.indexOf("function ClientSettingsPop("));
  const strip = tabs.slice(tabs.indexOf('<div className="clw-tabwrap"'), tabs.indexOf('<div className="clw-right">'));
  assert.doesNotMatch(strip, /<Pop\b/, "no box inside the strip");
  assert.match(tabs, /<Pop className="clw-menu clw-tabmenu"/);
  assert.match(src("clients/clients.css"), /\.clw-tabs \{ position: relative;/);
  assert.match(src("clients/clients.css"), /\.clw-tabwrap \{[^}]*overflow-x: auto; overflow-y: hidden/, "the reason: the strip clips");
});
ok("right click (and a long press on the phone) opens exactly Rename, Delete, Archive, Settings", () => {
  const cs = src("clients/ClientsScreen.tsx");
  assert.match(cs, /onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); if \(ren !== d\.id\) open\("menu", d\.id, e\.currentTarget\); \}\}/);
  assert.match(cs, /pointerType === "mouse"\) return;[\s\S]{0,300}open\("menu", d\.id, el\)/, "long press");
  const menu = cs.slice(cs.indexOf('{pop?.kind === "menu"'), cs.indexOf('{pop?.kind === "ask"'));
  const items = [...menu.matchAll(/\{I\.\w+\}(\w+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(items, ["Rename", "Delete", "Archive", "Settings"]);
});
ok("Delete asks first, then waits out its Undo before it deletes; closing Clients deletes what is still waiting", () => {
  const cs = src("clients/ClientsScreen.tsx");
  const menu = cs.slice(cs.indexOf('{pop?.kind === "menu"'), cs.indexOf('{pop?.kind === "ask"'));
  assert.match(menu, /onClick=\{\(\) => open\("ask", target\.id/, "Delete in the menu only asks");
  assert.doesNotMatch(menu, /deleteClient|deleteLater/);
  const ask = cs.slice(cs.indexOf('{pop?.kind === "ask"'), cs.indexOf('{pop?.kind === "settings"'));
  assert.match(ask, /Cancel<\/button>[\s\S]*deleteLater\(target\.id, target\.data\.name\)/);
  assert.match(cs, /window\.setTimeout\(\(\) => \{ waiting\.current\.delete\(id\); void deleteClient\(id\); \}, undoWindow\)/);
  assert.match(cs, /say\(`\$\{name\} deleted\.`, \(\) => \{ window\.clearTimeout\(h\);/);
  assert.match(cs, /useEffect\(\(\) => \(\) => \{ for \(const \[id, h\] of waiting\.current\) \{ window\.clearTimeout\(h\); void deleteClient\(id\); \}/);
  assert.ok(undoWindow >= 5000);
});
ok("Archived lists the archived clients, each with Bring back", () => {
  const cs = src("clients/ClientsScreen.tsx");
  assert.match(cs, /archivedClients\(s\)/);
  assert.match(cs, /void unarchiveClient\(a\.id\);[^\n]*Bring back<\/button>/);
  assert.match(src("core/select.ts"), /export function archivedClients\(s: Snapshot\)/);
});
ok("Settings: name, colour, contact and email; Esc and Cancel leave them", () => {
  const cs = src("clients/ClientsScreen.tsx");
  const sp = cs.slice(cs.indexOf("function ClientSettingsPop("), cs.indexOf("// ---------- one client ----------"));
  for (const w of [">Name<", ">Colour<", ">Contact<", ">Email<", ">Cancel<", ">Save<"]) assert.ok(sp.includes(w), w);
  assert.match(sp, /<Pop className="clw-spop clw-tabmenu clw-cset" style=\{\{ left \}\} onClose=\{onClose\}>/, "Esc closes without saving");
  assert.match(sp, /setClientSettings\(d\.id,/);
});
ok("settings are cleaned: a name never empty, a colour #rrggbb or none, contact and email trimmed", () => {
  assert.deepEqual(cleanClientSettings({ name: "  Vale  ", colour: "#AbCdEf", contactName: " Jo ", email: "" }), { name: "Vale", colour: "#AbCdEf", contactName: "Jo", email: null });
  assert.deepEqual(cleanClientSettings({ name: "  ", colour: "red", ws: "x", archived: true }), {});
  assert.deepEqual(cleanClientSettings({ colour: null }), { colour: null });
});
ok("the Tab list sends the new saves as ops the main window checks", () => {
  assert.deepEqual(cleanClientsOp({ op: "unarchiveClient", id: ID }), { op: "unarchiveClient", id: ID });
  assert.deepEqual(cleanClientsOp({ op: "deleteClient", id: ID }), { op: "deleteClient", id: ID });
  assert.equal(cleanClientsOp({ op: "deleteClient", id: "../x" }), null);
  assert.deepEqual(cleanClientsOp({ op: "clientSettings", id: ID, patch: { name: "Vale", ws: "evil" } }), { op: "clientSettings", id: ID, patch: { name: "Vale" } });
  assert.equal(cleanClientsOp({ op: "clientSettings", id: ID, patch: { ws: "evil" } }), null);
  const a = src("core/clientsact.ts");
  assert.match(a, /const CLIENT = new Set\(\["renameClient", "removeClient", "unarchiveClient", "deleteClient", "clientSettings"\]\)/, "only ever on a client record");
});
ok("delete takes the client's projects with their steps and notes; its tasks stay", () => {
  const ps = [{ id: "p1", ws: "W", data: {} }, { id: "p2", ws: null, data: { clientWs: "W" } }, { id: "p3", ws: null, data: { clientWs: "X" } }, { id: "p4", ws: "X", data: {} }];
  assert.deepEqual(clientProjects(ps, "W").map((p) => p.id), ["p1", "p2"]);
  const a = src("core/clientsact.ts");
  const del = a.slice(a.indexOf("export async function deleteClient"), a.indexOf("// ---------- projects ----------"));
  assert.match(del, /privOf\(p\.id\)/);
  assert.doesNotMatch(del, /todo/i, "tasks are left alone");
});

// ---------- 4. new projects and clients start empty ----------
ok("a new project (and a new client's First project) has no starter stages; a template still brings its own", () => {
  const a = src("core/clientsact.ts");
  assert.match(a, /stages: stages \?\? \[\], current: 0/);
  assert.doesNotMatch(a, /STARTER|name: "Kickoff"/);
  assert.doesNotMatch(src("core/clientwork.ts"), /STARTER|name: "Kickoff"/);
  assert.match(a, /const pid = await newProject\(client\.data\.ws, t\.name, today, made\.stages, id\)/, "templates");
  assert.doesNotMatch(src("clients/ClientsScreen.tsx"), /three stages/);
});
ok("the empty stage line invites the first stage", () => {
  const sl = src("clients/StageLine.tsx");
  assert.match(sl, /if \(!n\) \{[\s\S]*className="clw-stl-first" onClick=\{\(\) => void add\(\)\}[\s\S]*Add the first stage/);
});

// ---------- 5. Tasks vs Project steps (words approved by the developer, 23 Nov 2026) ----------
ok("the approved headings and hints, word for word", () => {
  const t = src("clients/Tasks.tsx"), cs = src("clients/ClientsScreen.tsx");
  assert.match(t, /<b>TASKS FOR YOUR LIST<\/b>[\s\S]{0,120}<div className="clw-col-hint">These go into your to-do list on their day\.<\/div>/);
  assert.match(cs, /<b>PROJECT STEPS<\/b>[\s\S]{0,120}<div className="clw-col-hint">Only here\. Tick them off as the project moves\.<\/div>/);
});

ok("no em or en dashes in any of the changed screens", () => {
  for (const f of ["clients/ClientsScreen.tsx", "clients/StageLine.tsx", "clients/Tasks.tsx", "views/ClientTag.tsx", "core/clienttag.ts"]) assert.doesNotMatch(src(f), /[–—]/, f);
});

console.log(`\n${n} passed`);
