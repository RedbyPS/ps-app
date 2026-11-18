// Run: node --experimental-strip-types tests/mailopen.test.ts
// PS 1.61: the island's email counts open the Tab list's email panel, and only show while that panel is allowed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const M = await import("../src/core/mailopen.ts");
const L = await import("../src/core/tablayout.ts");
let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };

ok("only the two kinds", () => {
  assert.equal(M.cleanMailVia("gmail"), "gmail"); assert.equal(M.cleanMailVia("instantly"), "instantly");
  for (const b of ["", "Gmail", "mail", 1, null, undefined, { via: "gmail" }]) assert.equal(M.cleanMailVia(b), null);
});
ok("a wish is taken once", () => {
  M.requestMailOpen("gmail", 1000);
  assert.equal(M.peekMailOpen(1500), "gmail"); assert.equal(M.peekMailOpen(1600), "gmail");
  assert.equal(M.takeMailOpen(2000), "gmail"); assert.equal(M.takeMailOpen(2000), null); assert.equal(M.peekMailOpen(2000), null);
});
ok("an old wish is dropped", () => { M.requestMailOpen("instantly", 1000); assert.equal(M.peekMailOpen(11_001), null); assert.equal(M.takeMailOpen(11_001), null); });
ok("a bad kind changes nothing", () => { M.requestMailOpen("x", 1000); assert.equal(M.peekMailOpen(1001), null); });
ok("a newer click replaces the older one", () => { M.requestMailOpen("gmail", 1000); M.requestMailOpen("instantly", 1200); assert.equal(M.takeMailOpen(1300), "instantly"); });
ok("listeners hear a wish, and stop when let go", () => {
  let c = 0; const off = M.onMailOpen(() => c++);
  M.requestMailOpen("gmail", 1); M.requestMailOpen("bad", 2); off(); M.requestMailOpen("gmail", 3);
  assert.equal(c, 1); M.takeMailOpen(4);
});

const rows = [
  { cardId: "m:old", via: "gmail", at: "2026-11-15T08:00:00Z" },
  { cardId: "n:lead1", via: "instantly", at: "2026-11-15T10:00:00Z" },
  { cardId: "m:new", via: "gmail", at: "2026-11-15T09:30:00Z" },
  { cardId: "n:lead0", via: "instantly", at: "2026-11-15T07:00:00Z" },
];
ok("the envelope opens the newest client email, the arrow the newest lead reply", () => {
  assert.equal(M.newestOf(rows, "gmail"), "m:new");
  assert.equal(M.newestOf(rows, "instantly"), "n:lead1");
  assert.equal(M.newestOf(rows.filter((r) => r.via === "gmail"), "instantly"), null);
  assert.equal(M.newestOf([], "gmail"), null);
});

ok("the email panel: itself, else a copy, else none", () => {
  const at = "2026-11-15T00:00:00Z";
  assert.equal(M.mailPanelId(null), "mail");
  assert.equal(M.mailPanelId(L.emptyLayout()), "mail");
  const off = L.hideSlot(L.emptyLayout(), "mail", at);
  assert.equal(M.mailPanelId(off), null);
  assert.equal(M.mailPanelId({ ...off, extra: ["clocks.abcd1234", "mail.efgh5678"] }), "mail.efgh5678");
});
ok("the island's counts: only with Client emails on and the panel on the Tab list", () => {
  const off = L.hideSlot(L.emptyLayout(), "mail", "2026-11-15T00:00:00Z");
  assert.equal(M.islandMailOk(true, null), true);
  assert.equal(M.islandMailOk(true, L.emptyLayout()), true);
  assert.equal(M.islandMailOk(false, L.emptyLayout()), false);
  assert.equal(M.islandMailOk(true, off), false);
  assert.equal(M.islandMailOk(false, null), false);
});

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
ok("wired: the island counts follow the Client emails switch and the panel", () => {
  const isl = src("../src/island.ts");
  assert.ok(/const mailOn = mailOnSnap\(s\);/.test(isl));
  assert.ok(isl.includes("const mail = mailOn ? mailCards(") && isl.includes("const leads = mailOn ? leadCards("));
  assert.ok(isl.includes("islandMailOk(mailOn, tabLayout(s))") && isl.includes("mail: counts && mailOn ? openReplies(s).length : 0, leads: counts ? leads.length : 0"));
});
ok("wired: the Tab list hears mailOpen, goes to the panel's page, and the panel opens the newest email", () => {
  assert.ok(src("../src/ps.ts").includes('m.type === "mailOpen") requestMailOpen('));
  const tm = src("../src/views/TaskMap.tsx");
  assert.ok(tm.includes("return onMailOpen(go);") && tm.includes("if (p !== curPage.id) goToPage(p);"));
  assert.ok(tm.includes("return onMailOpen(take);") && tm.includes("newestOf(list, via)") && tm.includes('focusId === r.cardId ? " focus" : ""'));
  assert.ok(src("../src/views/taskmap.css").includes(".tm-mail li.focus"));
});
// PS 1.68: the envelope counts what the email panel lists (not the pop-up cards), every one, no cap at 20.
ok("the envelope counts the client emails not dealt with yet, from clients still on the list", () => {
  const live = new Set(["c1", "c2"]);
  const many = Array.from({ length: 27 }, (_, i) => ({ handled: false, clientId: i % 2 ? "c1" : "c2" }));
  assert.equal(M.openMailCount(many, live), 27, "no cap");
  assert.equal(M.openMailCount([{ handled: true, clientId: "c1" }, { handled: false, clientId: "gone" }, { handled: false, clientId: null }, { clientId: "c2" }], live), 1,
    "answered or Done, a client deleted, or no client: not counted");
  assert.equal(M.isOpenReply({ handled: null, clientId: "c1" }, live), true);
  assert.equal(M.openMailCount([], live), 0);
});
ok("the island and the panel read the same rule", () => {
  assert.ok(src("../src/core/select.ts").includes("isOpenReply(r.data, live)"));
  assert.ok(src("../src/island.ts").includes("openReplies(s).length"));
});
console.log(`${n} passed`);
