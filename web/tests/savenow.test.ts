// Run: node --experimental-strip-types tests/savenow.test.ts
// PS 1.74: an edit made just before PS updates, reloads or quits is saved first (core/savenow.ts, core/vault.ts settled,
// mac/Sources/SaveFirstCore.swift and main.swift). The developer, 22 Nov 2026: "when I make updates to my checklist, on
// update it sometimes deletes the updates I made recently". Each loss is shown the old way first (the page simply went
// away), then kept. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const S = await import("../src/core/savenow.ts");

let n = 0;
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny page: storage on this device, saves that take a moment to encrypt and write (tracked like core/vault.ts), a
 *  mini task rename box that saves when it is left, and a notes box that waits a moment before it saves. */
function page() {
  const stored = new Map<string, string>();
  const inflight = new Set<Promise<unknown>>();
  const put = (k: string, v: string) => {
    const p = sleep(15).then(() => { stored.set(k, v); });
    inflight.add(p); void p.then(() => inflight.delete(p));
    return p;
  };
  // The same rule as core/vault.ts settled: nothing on its way, twice, a moment apart.
  const settle = async (maxMs: number) => {
    const end = Date.now() + maxMs;
    for (let quiet = 0; quiet < 2;) {
      if (Date.now() >= end) return false;
      if (inflight.size) { quiet = 0; await Promise.race([Promise.allSettled([...inflight]), sleep(end - Date.now())]); } else { quiet++; await sleep(5); }
    }
    return true;
  };
  const box = { tagName: "INPUT", value: "", blur() { if (doc.activeElement === box) { doc.activeElement = null; void put("mini:s1", box.value); } } };
  const doc: { activeElement: unknown; visibilityState: string; on: Map<string, () => void>; addEventListener: (t: string, f: () => void) => void } =
    { activeElement: null, visibilityState: "visible", on: new Map(), addEventListener(t, f) { this.on.set(t, f); } };
  const win: { __psSaveNow?: () => Promise<boolean>; on: Map<string, () => void>; addEventListener: (t: string, f: () => void) => void } =
    { on: new Map(), addEventListener(t, f) { this.on.set(t, f); } };
  return { stored, put, settle, box, doc, win };
}

// ---------- the three ways an edit was lost ----------
ok("a mini task renamed in a box that was never left: lost the old way, saved now", async () => {
  const old = page();
  old.doc.activeElement = old.box; old.box.value = "Stretch 5 min";
  // the old way: PS quit or reloaded, nothing asked the page
  assert.equal(old.stored.has("mini:s1"), false);
  const p = page();
  S.installSaveNow(p.win, p.doc, p.settle);
  p.doc.activeElement = p.box; p.box.value = "Stretch 5 min";
  assert.equal(await p.win.__psSaveNow!(), true);
  assert.equal(p.stored.get("mini:s1"), "Stretch 5 min");
});
ok("a save still waiting (Notes groups fast typing): it used to wait past the reload, now it runs at once", async () => {
  const p = page();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { timer = null; void p.put("notes", "Call on Friday"); }, 5000);
  const release = S.holdEdit(() => { if (!timer) return; clearTimeout(timer); timer = null; void p.put("notes", "Call on Friday"); });
  assert.equal(await S.saveNow({ settle: p.settle }), true);
  assert.equal(p.stored.get("notes"), "Call on Friday");
  release();
});
ok("a save on its way to storage: saveNow waits until it is written, and a save chained right after it too", async () => {
  const p = page();
  void p.put("todo:a", "one").then(() => p.put("todo:a", "two"));   // like a lane: the second starts when the first ends
  assert.equal(await S.saveNow({ settle: p.settle }), true);
  assert.equal(p.stored.get("todo:a"), "two");
});

// ---------- the rules ----------
ok("a mini task typed but not yet added ('leave') is added only when PS goes away, never when the page merely hides", async () => {
  const p = page();
  let added = 0;
  const release = S.holdEdit(() => { added++; }, "leave");
  S.installSaveNow(p.win, p.doc, p.settle);
  p.doc.visibilityState = "hidden"; p.doc.on.get("visibilitychange")!();
  p.win.on.get("pagehide")!();
  assert.equal(added, 0);
  await p.win.__psSaveNow!();
  assert.equal(added, 1);
  release();
  await p.win.__psSaveNow!();
  assert.equal(added, 1, "taken off once the box closed");
});
ok("hidden or closed: the waiting saves run, the open box stays open (nothing is blurred)", () => {
  const p = page();
  let ran = 0;
  const release = S.holdEdit(() => { ran++; });
  S.installSaveNow(p.win, p.doc, p.settle);
  p.doc.activeElement = p.box;
  p.doc.visibilityState = "visible"; p.doc.on.get("visibilitychange")!();
  assert.equal(ran, 0, "shown again: nothing runs");
  p.doc.visibilityState = "hidden"; p.doc.on.get("visibilitychange")!();
  p.win.on.get("pagehide")!();
  assert.equal(ran, 2);
  assert.equal(p.doc.activeElement, p.box);
  release();
});
ok("the waiting saves run before the box is left (a box's words are read while it is still open)", async () => {
  const order: string[] = [];
  const release = S.holdEdit(() => order.push("waiting"), "leave");
  await S.saveNow({ leaveBox: () => order.push("box"), settle: async () => { order.push("settle"); return true; } });
  assert.deepEqual(order, ["waiting", "box", "settle"]);
  release();
});
ok("one failing save never stops the others, and a storage that gives up says false", async () => {
  let b = 0;
  const r1 = S.holdEdit(() => { throw new Error("gone"); }), r2 = S.holdEdit(() => { b++; });
  assert.equal(await S.saveNow({ settle: async () => false }), false);
  assert.equal(await S.saveNow({ settle: async () => { throw new Error("locked"); } }), false);
  assert.equal(b, 2);
  r1(); r2();
});
ok("the same save held twice is two entries; each release takes off only its own", () => {
  let n2 = 0;
  const f = () => { n2++; };
  const a = S.holdEdit(f), b = S.holdEdit(f);
  S.flushWaiting(); assert.equal(n2, 2);
  a(); S.flushWaiting(); assert.equal(n2, 3);
  b(); S.flushWaiting(); assert.equal(n2, 3);
});
ok("leaveOpenBox: only a box being typed in (input, text area, select, editable area), never a button", () => {
  const blurred: string[] = [];
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable, blur() { blurred.push(tagName + (isContentEditable ? "+edit" : "")); } });
  for (const e of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true), el("BUTTON"), el("DIV")]) S.leaveOpenBox({ activeElement: e });
  S.leaveOpenBox({ activeElement: null }); S.leaveOpenBox(undefined);
  assert.deepEqual(blurred, ["INPUT", "TEXTAREA", "SELECT", "DIV+edit"]);
});
ok("installed once per page; saveBeforeLeaving never waits past its limit", async () => {
  const p = page();
  S.installSaveNow(p.win, p.doc, p.settle);
  const first = p.win.__psSaveNow;
  S.installSaveNow(p.win, p.doc, p.settle);
  assert.equal(p.win.__psSaveNow, first);
  assert.equal(await S.saveBeforeLeaving(undefined), true, "an older page with nothing to save");
  const hung = { __psSaveNow: () => new Promise<boolean>(() => {}), addEventListener() {} };
  const t = Date.now();
  assert.equal(await S.saveBeforeLeaving(hung, 50), false);
  assert.ok(Date.now() - t < 1500);
});

// ---------- wiring: every way PS updates, reloads or quits ----------
ok("vault.ts: every put and remove is tracked, settled waits until none is on its way (twice, a moment apart)", () => {
  const v = src("../src/core/vault.ts");
  assert.match(v, /export function put<T>\([^)]*\): Promise<string> \{\n  return track\(putRecord\(kind, data, opts\)\);/);
  assert.match(v, /export function remove\(id: string\): Promise<void> \{\n  return track\(removeRecord\(id\)\);/);
  assert.match(v, /export async function settled\(maxMs = 3000\)/);
  assert.match(v, /for \(let quiet = 0; quiet < 2;\)/);
});
ok("every page installs it, and the web's own reloads and the phone's update save first", () => {
  assert.match(src("../src/main.tsx"), /installSaveNow\(window, document, settled\);/);
  assert.match(src("../src/mobile/app.tsx"), /installSaveNow\(window, document, settled\);/);
  assert.match(src("../src/App.tsx"), /await saveBeforeLeaving\(window\); location\.reload\(\);/);
  const w = src("../src/views/WebUpdateNote.tsx");
  assert.match(w.slice(w.indexOf("async function reloadNow")), /^async function reloadNow\(\) \{\n  await saveBeforeLeaving\(window\);/);
  assert.match(src("../src/gos/GosUpdate.tsx"), /void saveBeforeLeaving\(window\)\.then\(\(\) => gos\.installUpdate\(\)\)/);
});
ok("the editors that wait: a new mini task not yet added (leave), the Notes dock's body", () => {
  const m = src("../src/views/MiniTasks.tsx");
  assert.match(m, /holdEdit\(\(\) => \{[\s\S]{0,300}miniAct\(task, \{ op: "add"[\s\S]{0,80}\}, "leave"\)/);
  const nd = src("../src/views/NotesDock.tsx");
  assert.match(nd, /useEffect\(\(\) => holdEdit\(\(\) => \{/);
  assert.match(nd, /timer\.current = window\.setTimeout\(\(\) => \{\n      timer\.current = undefined;/);
});
ok("the Mac: Quit (an update's relaunch and the Hatch restart go through it) and the reload for a new web build save both pages first", () => {
  const m = readFileSync(new URL("../../mac/Sources/main.swift", import.meta.url), "utf8");
  const q = m.slice(m.indexOf("func applicationShouldTerminate"), m.indexOf("func applicationWillTerminate"));
  assert.match(q, /savePagesFirst \{ all\.finished\("pages"\) \}/);
  assert.match(q, /return \.terminateLater/);
  assert.doesNotMatch(q, /terminateNow/);
  const r = m.slice(m.indexOf("func autoReload()"), m.indexOf("func savePagesFirst"));
  assert.match(r, /self\.savePagesFirst \{ \[weak self\] in\n        guard let self else \{ return \}\n        self\.loadMain\(\)/);
  assert.doesNotMatch(r.replace(/self\.savePagesFirst[\s\S]*$/, ""), /self\.loadMain\(\)/, "never a reload before the save");
  const c = m.slice(m.indexOf("func checkLocalUpdate()"), m.indexOf("func autoReload()"));
  assert.match(c, /savePagesFirst\(only: \["overlay"\]\) \{ \[weak self\] in self\?\.overlay\.load/);
  const u = readFileSync(new URL("../../mac/Sources/Updater.swift", import.meta.url), "utf8");
  assert.match(u, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ 0\.9\) \{ NSApp\.terminate\(nil\) \}/, "the relaunch quits through applicationShouldTerminate");
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok -", name); }
console.log(`\n${n} passed`);
