import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = new URL("..", import.meta.url).pathname;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps-zze-stagedone-")));
const vaultShim = join(dir, "vault.ts"), actShim = join(dir, "actions.ts"), entry = join(dir, "entry.ts"), out = join(dir, "out.mjs");
writeFileSync(vaultShim, `
export const DB = new Map();
export function doc(id) { return DB.get(id); }
export function docs(kind) { return [...DB.values()].filter((d) => d.kind === kind); }
export async function put(kind, data, o = {}) { const id = o.id ?? "x" + DB.size; DB.set(id, { id, kind, data, ws: null }); return id; }
export async function remove(id) { DB.delete(id); }
`);
writeFileSync(actShim, `
import { DB } from ${JSON.stringify(vaultShim)};
export const privOf = () => undefined;
export async function updateProject(id, patch) { const d = DB.get(id); if (!d) return; d.data = typeof patch === "function" ? patch(structuredClone(d.data)) : { ...d.data, ...patch }; }
export async function updatePrivate() {} export async function toggleTodo() {} export async function setTodoDone() {}
export async function updateTodo() {} export async function deleteTodo() {} export async function addTodo() { return "t"; }
export async function addClient() { return "c"; } export async function addProject() { return "p"; } export async function updateClient() {}
`);
writeFileSync(entry, `export * from ${JSON.stringify(root + "src/core/clientsact.ts")}; export { DB } from ${JSON.stringify(vaultShim)};`);
await build({
  plugins: [{ name: "shims", setup(b) {
    b.onResolve({ filter: /^\.\/vault$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: vaultShim } : undefined);
    b.onResolve({ filter: /^\.\/actions$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: actShim } : undefined);
  } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent",
});
const M = await import(pathToFileURL(out).href);
const { cleanClientsOp } = await import("../src/core/clientsop.ts");

const P = "1c8e2d0f-aaaa-4bbb-8ccc-9dddeeeeffff";
const st = (key: string, name: string) => ({ key, name, start: null, due: null, doneAt: null, previews: [] });
const A = st("aaaa1111aaaa", "Plan"), B = st("bbbb2222bbbb", "Build"), C = st("cccc3333cccc", "Launch");
const project = (stages: unknown[]) => M.DB.set(P, { id: P, kind: "project", data: { title: "Website", stages: structuredClone(stages), current: 0 } });
const names = () => M.DB.get(P).data.stages.map((s: { name: string }) => s.name);
/** The Tab list makes the op on its copy (tabCopy), the main page runs it on the newest copy (newest). */
async function stale(tabCopy: unknown[], newest: unknown[], fn: () => unknown) {
  const sent: unknown[] = [];
  project(tabCopy);
  M.setClientsRelay((op: unknown) => sent.push(JSON.parse(JSON.stringify(op))));
  await fn();
  M.setClientsRelay(null);
  project(newest);
  for (const o of sent) { const c = cleanClientsOp(o); assert.ok(c, "the main window takes the op"); await M.runClientsOp(c); }
}
let n = 0;
let bad = 0;
const ok2 = async (name: string, fn: () => unknown) => { try { await fn(); n++; console.log("ok", name); } catch (e) { bad++; console.log("FAIL", name, "|", (e as Error).message.split("\n")[0]); } };
// PS 1.74 check: stageDone (drag along the stage line, "the first k stages done") still goes by place. The other
// stage ops find their stage by key since round 2; this one, from an out of date Tab list copy, ticks the wrong stages.
const done = () => M.DB.get(P).data.stages.filter((s: { doneAt: string | null }) => s.doneAt).map((s: { name: string }) => s.name);
const D = st("dddd4444dddd", "Docs");
await ok2("done up to Launch, after Docs moved to the front meanwhile: Launch is done (with every stage now before it)", async () => {
  await stale([A, B, C, D], [D, A, B, C], () => M.stageDone(P, 3, "2026-11-22"));
  assert.deepEqual(done().sort(), ["Build", "Docs", "Launch", "Plan"], "Launch was asked done");
});
await ok2("done up to Launch, after Plan was removed meanwhile: Docs stays open", async () => {
  await stale([A, B, C, D], [B, C, D], () => M.stageDone(P, 3, "2026-11-22"));
  assert.deepEqual(done().sort(), ["Build", "Launch"]);
});
await ok2("all open again (k 0) still works with no key", async () => {
  await stale([A, B], [{ ...A, doneAt: "2026-11-20" }, B], () => M.stageDone(P, 0, "2026-11-22"));
  assert.deepEqual(done(), []);
});
console.log(`${n} passed, ${bad} failed`);
if (bad) process.exit(1);
