// Run: node --experimental-strip-types tests/map-titles.test.ts
// PS 1.74, item 3 (the developer: "titled these months and it got deleted"): the Map's Year view reads the month titles back.
// The path, end to end: the Tab list's box (views/SeriesMap.tsx MonthTitle) -> taskMapActions.journal (views/PsApp.tsx)
// -> the main window checks it (ps.ts cleanJournalOp) -> setJournal saves it under the month's key (core/actions.ts) -> the
// Tab list gets the journal records again (ps.ts send) -> journal() picks the newest record per key (core/keepedits.ts
// journalByKey) -> the Year view's tile reads it under the same key. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { journalByKey } from "../src/core/keepedits.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const map = src("../src/views/SeriesMap.tsx"), ps = src("../src/ps.ts"), act = src("../src/core/actions.ts");

// The month key, exactly as the Map makes it.
const keyLine = map.match(/const mKey = \(y: number, m: number\) => `m:\$\{y\}-\$\{pad\(m \+ 1\)\}`;/);
const pad = (x: number) => String(x).padStart(2, "0");
const mKey = (y: number, m: number) => `m:${y}-${pad(m + 1)}`;
// The main window's check, taken from ps.ts as it is.
const re = new RegExp(ps.match(/\/\^\(d:\\d\{4\}-\\d\{2\}-\\d\{2\}\|w:\\d\{4\}-\\d\{2\}-\\d\{2\}\|m:\\d\{4\}-\\d\{2\}\)\$\//)![0].slice(1, -1));

ok("the month key is m:YYYY-MM in both the Year view and the Month view (one MonthTitle for both)", () => {
  assert.ok(keyLine, "mKey changed: check the Year view still reads what is saved");
  const year = map.slice(map.indexOf("function YearView"));
  assert.match(year, /<MonthTitle y=\{year\} m=\{m\} j=\{j\} \/>/);
  const title = map.slice(map.indexOf("function MonthTitle"), map.indexOf("function NoteBox"));
  assert.match(title, /const k = mKey\(y, m\);/);
  assert.match(title, /const saved = j\.get\(k\)\?\.data\.title \|\| "";/);
  assert.match(title, /void save\.journal\(k, \{ title: v\.trim\(\) \|\| null \}\)/);
  assert.match(map, /<MonthTitle y=\{cur\.getFullYear\(\)\} m=\{cur\.getMonth\(\)\} j=\{j\} big \/>|MonthTitle[^\n]*big/);
});
ok("the main window takes a month title from the Tab list (and refuses a key that is not a day, week or month)", () => {
  for (let m = 0; m < 12; m++) assert.ok(re.test(mKey(2026, m)), mKey(2026, m));
  assert.ok(!re.test("m:2026-3") && !re.test("x:2026-03") && !re.test("m:2026-03 "));
  assert.match(src("../src/views/PsApp.tsx"), /taskMapActions\.journal = async \(key, patch\) => psPost\(\{ type: "looks", patch: \{ journalOp: \{ key, \.\.\.patch \} \} \}\);/);
  assert.match(ps, /const o = cleanJournalOp\(patch\.journalOp\); if \(o\) void setJournal\(o\.key, o\.patch\);/);
});
ok("setJournal saves the title under that key and keeps the month note (a note saved later keeps the title)", () => {
  const sj = act.slice(act.indexOf("export function setJournal"), act.indexOf("// ---------- screen time"));
  assert.match(sj, /const next: JournalEntry = \{ key, title: kept\("title"\), note: kept\("note"\), \.\.\.patch, updatedAt: now\(\) \};/);
  assert.match(sj, /journalLane\.then\(run, run\)/);
});
ok("the Tab list gets the journal records back with the rest of its copy", () => {
  const send = ps.slice(ps.indexOf("const send = () => {"), ps.indexOf("if (cal) docs.push(cal);"));
  assert.match(send, /d\.kind === "journal"/);
});
ok("read back: the Year view finds every month's title under its key, the newest record when two raced", () => {
  const d = (id: string, key: string, title: string | null, at: string) => ({ id, ws: null, kind: "journal", author: null, updatedAt: at, data: { key, title, note: null, updatedAt: at } });
  const recs = [
    d("j1", mKey(2026, 0), "Fresh start", "2026-01-02T10:00:00Z"),
    d("j2", mKey(2026, 2), null, "2026-03-01T09:00:00Z"),            // an older empty copy of March
    d("j3", mKey(2026, 2), "Ship 1.74", "2026-03-01T09:05:00Z"),
    d("j4", "d:2026-03-04", null, "2026-03-04T09:00:00Z"),
  ];
  for (const order of [recs, [...recs].reverse()]) {
    const j = journalByKey(order);
    const titles = Array.from({ length: 12 }, (_, m) => j.get(mKey(2026, m))?.data.title || "");
    assert.deepEqual(titles, ["Fresh start", "", "Ship 1.74", "", "", "", "", "", "", "", "", ""]);
  }
});
console.log(`\n${n} passed`);
