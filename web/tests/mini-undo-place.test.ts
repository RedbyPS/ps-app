// PS 1.74 check: a deleted mini task comes back in its own place, and the Menu key in a name being typed stays with the box.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { applySubOp, type Subtask } from "../src/core/subtasks.ts";

const P = process.env.PATCHED;
const read = (rel: string, alt: string) => readFileSync(P ? `${P}/${alt}` : new URL(`../${rel}`, import.meta.url), "utf8");
const mini = read("src/views/MiniTasks.tsx", "MiniTasks.tsx");
let n = 0, bad = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); n++; console.log("ok -", name); } catch (e) { bad++; console.log("FAIL -", name, "\n   ", (e as Error).message.split("\n")[0]); }
};
const AT = "2026-11-22T10:00:00.000Z";
const t = (id: string): Subtask => ({ id, title: id, done: false });

// d-1 (a): Backspace on a clicked mini task uses the place the click remembered (keys.sel.index), not where it is now.
await ok("d-1a model: click C, delete A from its menu, Backspace C, Undo twice: the list must come back as it was", () => {
  const start = [t("A"), t("B"), t("C"), t("D")];
  const clickedIndexOfC = 2;                                            // keys.sel = { s: C, index: 2 } at the click
  let l = applySubOp(start, { op: "remove", id: "A" }, AT);             // menu Delete (deleteMini looks the index up fresh: 0)
  const nowIndexOfC = l.findIndex((s) => s.id === "C");                 // 1
  const staleUndo = applySubOp(applySubOp(applySubOp(l, { op: "remove", id: "C" }, AT), { op: "restore", item: t("C"), index: clickedIndexOfC }, AT), { op: "restore", item: t("A"), index: 0 }, AT);
  const freshUndo = applySubOp(applySubOp(applySubOp(l, { op: "remove", id: "C" }, AT), { op: "restore", item: t("C"), index: nowIndexOfC }, AT), { op: "restore", item: t("A"), index: 0 }, AT);
  assert.deepEqual(freshUndo.map((s) => s.id), ["A", "B", "C", "D"], "the fresh place puts it back right");
  assert.notDeepEqual(staleUndo.map((s) => s.id), ["A", "B", "C", "D"], "the remembered place does not (A B D C)");
  l = l;
});
await ok("d-1a source: removeMini looks the mini task up in the newest list before it deletes (its place and its copy)", () => {
  const body = mini.slice(mini.indexOf("function removeMini"), mini.indexOf("// ---------- a mini task's own right click menu"));
  assert.match(body, /miniList\(\s*cur\s*\)|miniList\(\s*fresh\(d\)\s*\)/, "the index comes from the newest list, not the Pick");
  assert.doesNotMatch(body, /\{\s*d,\s*s,\s*index,\s*undo\s*\}\s*:\s*Pick/, "the remembered index is not used");
});

// d-1 (b): the Menu key in the name box being renamed opens the mini menu, which focuses its first item (TaskMenu.tsx
// MiniMenu), so the name box blurs and its onBlur={save} saves the half typed name before anything is chosen.
await ok("d-1b source: the Menu key while a name is typed stays with the box (no menu, so no blur save)", () => {
  const body = mini.slice(mini.indexOf("function onMenuKey"), mini.indexOf("function onKey("));
  assert.match(body, /INPUT\|TEXTAREA/, "onMenuKey must leave a focused text box alone");
  assert.match(mini, /onBlur=\{save\}/, "the chain: the name box saves on blur");
});

// d-2: the sw.js cache bump to v3 deletes the v2 cache, which holds the app files the new page just loaded through the
// old worker; the new cache has only the shell, so an offline start right after the update is a blank page.
console.log(`${n} passed, ${bad} failed`);
if (bad) process.exit(1);
