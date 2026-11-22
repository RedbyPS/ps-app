// Run: node --experimental-strip-types tests/savenow-breakit.test.ts
// PS 1.74 item 2 checks (save before quit, update, reload). PS_ROOT=<folder with web/ and mac/> runs it on a patched copy.
// FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.env.PS_ROOT ? pathToFileURL(process.env.PS_ROOT.replace(/\/?$/, "/")) : new URL("../../", import.meta.url);
const S = await import(new URL("web/src/core/savenow.ts", root).href);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0, bad = 0;
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);

// a-1: View > Reload (Cmd+R) reloads the main page with no save first.
ok("a-1 the Mac's View > Reload (Cmd+R) saves the page first, like the update reload", () => {
  const m = read("mac/Sources/main.swift");
  const at = m.indexOf("@objc func reloadMain()");
  assert.ok(at > 0, "reloadMain exists");
  const body = m.slice(at, m.indexOf("@objc func", at + 10));
  assert.match(body, /savePagesFirst\(only: \["main"\]\)[^\n]*loadMain\(\)/, "reloadMain must save first, it is: " + body.split("\n")[0].trim());
  assert.doesNotMatch(body.replace(/savePagesFirst[\s\S]*$/, "").replace(/^.*\n/, ""), /\bloadMain\(\)/, "never a reload before the save");
});

// a-2: two saves asked at once (the Tab list: checkLocalUpdate's own save, then autoReload's) run the "leave" flush twice.
// MiniAdd's flush reads what it last rendered, which only changes on the next render, so the same mini task is added twice.
ok("a-2 two saves asked in one moment add a half typed mini task once", async () => {
  const added: string[] = [];
  let rendered = { v: "Buy milk", on: true };   // MiniAdd's latest ref, refreshed only when React renders again
  let typed = rendered.v;
  const release = S.holdEdit(() => {
    const t = rendered.v.trim();
    if (!rendered.on || !t) return;
    added.push(t);
    typed = "";                                  // setV(""): React renders a moment later
    setTimeout(() => { rendered = { ...rendered, v: typed }; }, 1);
  }, "leave");
  const doc = { activeElement: null, visibilityState: "visible", addEventListener() {} };
  const win: { __psSaveNow?: () => Promise<boolean>; addEventListener: () => void } = { addEventListener() {} };
  S.installSaveNow(win, doc, async () => { await sleep(5); return true; });
  const [a, b] = await Promise.all([win.__psSaveNow!(), win.__psSaveNow!()]);
  release();
  assert.equal(a, true); assert.equal(b, true);
  assert.deepEqual(added, ["Buy milk"], "added " + added.length + " times");
});

// a-3: savePagesFirst gives both pages ONE shared deadline and asks the main page only after the Tab list answered.
// A Tab list that does not answer (busy or stuck web process) uses the whole limit, so the main page, which holds the
// vault, is never asked. Shown on the Swift in mac/tests (a probe), pinned here.
ok("a-3 a Tab list that does not answer never stops the main page from saving", () => {
  const m = read("mac/Sources/main.swift");
  const f = m.slice(m.indexOf("func savePagesFirst"), m.indexOf("// Does the website run newer code than PS?"));
  assert.match(f, /SaveFirstCore\.pageLimit/, "each page needs its own share of the limit");
  const c = read("mac/Sources/SaveFirstCore.swift");
  const lim = Number(/static let limit: Double = ([\d.]+)/.exec(c)![1]), page = Number(/static let pageLimit: Double = ([\d.]+)/.exec(c)?.[1] ?? "NaN");
  assert.ok(page * 2 < lim, "two pages fit in the limit");
});

for (const [name, fn] of tests) {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { bad++; console.log("FAIL -", name, "\n   ", (e as Error).message.split("\n")[0]); }
}
console.log(`\n${n} passed, ${bad} failed`);
if (bad) process.exitCode = 1;
