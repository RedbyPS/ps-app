// Run: node --experimental-strip-types tests/overview-layout.test.ts
// V1.55 Edit mode overview (core/tablayout.ts): pages of panels, copies from the Add panel gallery, sizes, each
// panel's own settings (a Meetings panel's own calendar), buttons dragged out of a panel and back in, and the
// migration of a layout from before V1.55 with nothing lost.
import assert from "node:assert/strict";
import {
  MAIN_PAGE, MAX_EXTRA, SIZE_MAX, SIZE_MIN, SLOTS, addPanel, canHide, cfgOf, cleanLayout, cleanLayoutOp, dropPage, emptyLayout, gallery, hideSlot,
  isDefault, kindOf, moveSlot, onPage, outOf, pageOf, pullOut, pushIn, putOnPage, removeCopy, resetLayout, sameLayout, setCfg, setSize, sizeOf,
  slotStyle, type TabLayout,
} from "../src/core/tablayout.ts";

let n = 0;
// Client emails is on for these accounts (core/mailswitch.ts via core/mailflag.ts): the panel is theirs, not the developer's.
(await import("../src/core/mailflag.ts")).setMailAllowed(true);
// PS 1.65: Second Computer is everyone's once its switch is on (core/secondswitch.ts via core/mailflag.ts), so its panel is too.
(await import("../src/core/mailflag.ts")).setSecondAllowed(true);
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const AT = "2026-11-12T22:00:00.000Z";
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const P2 = "pg2abc", P3 = "pg3xyz";
const pages = new Set([MAIN_PAGE, P2, P3]);
const allOriginals = SLOTS.filter((s) => !s.inner && !s.off && !s.optIn && !s.menu).map((s) => s.id);   // PS 1.70: menu ones live in the top right menu

// ---------- migration: a layout from before V1.55 ----------
ok("a V1.54 layout reads exactly as before: every panel on the main page, moved ones where they were, removed ones removed", () => {
  const old = { pos: { meetings: { x: 0.25, y: 0.75, w: 300, h: 180 }, sleep: { x: 1, y: 1, w: 120, h: 44 } }, hidden: ["overdue", "brief"], at: AT };
  const l = cleanLayout(old);
  assert.deepEqual(l, old, "the record is untouched (no new fields appear)");
  const main = onPage(l, MAIN_PAGE, true, pages);
  for (const id of allOriginals) {
    if (old.hidden.includes(id)) assert.ok(!main.includes(id), id);
    else assert.ok(main.includes(id), `${id} is still on the main page`);
  }
  assert.deepEqual(onPage(l, P2, true, pages), [], "a new page starts empty");
  const g = gallery(l, MAIN_PAGE, true, true, pages);
  assert.ok(g.find((x) => x.kind === "overdue")!.removed, "removed ones wait in the gallery");
  // PS 1.70: the Morning brief lives in the top right menu now, so an old removal of it no longer counts.
  assert.ok(!g.find((x) => x.kind === "brief")!.removed && g.find((x) => x.kind === "brief")!.menu, "the brief is in the menu");
  assert.equal(pageOf(l, "meetings"), MAIN_PAGE);
  assert.equal(sizeOf(l, "meetings"), 1);
  assert.ok(sameLayout(l, cleanLayout(JSON.parse(JSON.stringify(l)))));
});
ok("a V1.54 record with nothing changed is still the default, and Reset gives the default", () => {
  assert.ok(isDefault(cleanLayout({ pos: {}, hidden: [], at: AT })));
  assert.ok(isDefault(resetLayout(AT)));
});

// ---------- pages ----------
ok("a panel moves to another page and back; its place comes with it", () => {
  let l = moveSlot(emptyLayout(), "sleep", { x: 0.5, y: 0.5, w: 120, h: 44 }, AT);
  l = putOnPage(l, "sleep", P2, AT);
  assert.equal(pageOf(l, "sleep"), P2);
  assert.ok(!onPage(l, MAIN_PAGE, true, pages).includes("sleep") && onPage(l, P2, true, pages).includes("sleep"));
  assert.deepEqual(l.pos.sleep, { x: 0.5, y: 0.5, w: 120, h: 44 });
  l = putOnPage(l, "sleep", MAIN_PAGE, AT);
  assert.equal(l.page, undefined, "the main page is never written down");
  assert.ok(onPage(l, MAIN_PAGE, true, pages).includes("sleep"));
});
ok("a panel on a page that is gone shows on the main page (never lost)", () => {
  const l = putOnPage(emptyLayout(), "dimx", "gonepage", AT);
  assert.equal(pageOf(l, "dimx", pages), MAIN_PAGE);
  assert.ok(onPage(l, MAIN_PAGE, true, pages).includes("dimx"));
});
ok("deleting a page: its originals go back to the main page, its copies go (the gallery keeps them)", () => {
  let l = putOnPage(emptyLayout(), "sleep", P2, AT);
  const a = addPanel(l, "meetings", P2, AT, undefined, rnd); l = a.layout;
  l = dropPage(l, P2, AT);
  assert.equal(pageOf(l, "sleep"), MAIN_PAGE);
  assert.ok(!(l.extra ?? []).includes(a.id!));
  assert.ok(gallery(l, MAIN_PAGE, true, true).some((g) => g.kind === "meetings"));
  assert.equal(dropPage(l, MAIN_PAGE, AT), l, "the main page can never be dropped");
});

// ---------- copies and the gallery ----------
ok("any panel can be added many times: fifteen Sleep buttons on one page", () => {
  let l = emptyLayout();
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) { const r = addPanel(l, "sleep", P2, AT, undefined, rnd); l = r.layout; ids.push(r.id!); }
  assert.equal(new Set(ids).size, 15);
  assert.ok(ids.every((id) => kindOf(id) === "sleep" && id !== "sleep"));
  assert.equal(onPage(l, P2, true, pages).filter((id) => kindOf(id) === "sleep").length, 15);
  const g = gallery(l, P2, true, true, pages).find((x) => x.kind === "sleep")!;
  assert.equal(g.here, 15); assert.equal(g.all, 16, "fifteen copies and the original on the main page");
  assert.ok(sameLayout(l, cleanLayout(JSON.parse(JSON.stringify(l)))), "every copy survives the round trip");
});
ok("three Meetings panels, each its own calendar (the developer's Google accounts), kept per panel", () => {
  let l = emptyLayout();
  const a = addPanel(l, "meetings", MAIN_PAGE, AT, undefined, rnd); l = a.layout;
  const b = addPanel(l, "meetings", P2, AT, undefined, rnd); l = b.layout;
  l = setCfg(l, a.id!, { cal: "g:work01" }, AT);
  l = setCfg(l, b.id!, { cal: "m:iCloud" }, AT);
  const c = cleanLayout(JSON.parse(JSON.stringify(l)));
  assert.equal(cfgOf(c, "meetings").cal, undefined, "the original keeps the usual calendar");
  assert.equal(cfgOf(c, a.id!).cal, "g:work01");
  assert.equal(cfgOf(c, b.id!).cal, "m:iCloud");
  l = setCfg(c, a.id!, { cal: "" }, AT);
  assert.equal(cfgOf(l, a.id!).cal, undefined, "an empty value goes back to the usual calendar");
  assert.equal(cleanLayout({ ...l, cfg: { sleep: { cal: "g:work01" } } }).cfg?.sleep, undefined, "only a Meetings panel has a calendar");
  assert.equal(cleanLayout({ ...l, cfg: { [b.id!]: { cal: "http://evil" } } }).cfg?.[b.id!], undefined, "a calendar setting is a feed id or an account name, never an address");
});
ok("V1.57: a Time zones panel kept open, each copy on its own page on its own, and only Time zones", () => {
  let l = emptyLayout();
  const a = addPanel(l, "clocks", P2, AT, undefined, rnd); l = a.layout;
  l = setCfg(l, a.id!, { open: true }, AT);
  const c = cleanLayout(JSON.parse(JSON.stringify(l)));
  assert.equal(cfgOf(c, a.id!).open, true, "the copy on the other page stays open");
  assert.equal(cfgOf(c, "clocks").open, undefined, "the original still opens on hover");
  l = setCfg(c, "clocks", { open: true }, AT);
  assert.equal(cfgOf(l, "clocks").open, true);
  l = setCfg(l, a.id!, { open: false }, AT);
  assert.equal(cfgOf(l, a.id!).open, undefined, "clicked again: back to hover only, and the setting goes");
  assert.equal(l.cfg?.[a.id!], undefined);
  assert.equal(cleanLayout({ ...l, cfg: { meetings: { open: true } } }).cfg?.meetings, undefined, "only Time zones keeps open");
  assert.equal(cleanLayout({ ...l, cfg: { clocks: { open: "yes" } } }).cfg?.clocks, undefined, "only true counts");
  assert.ok(isDefault(setCfg(setCfg(emptyLayout(), "clocks", { open: true }, AT), "clocks", { open: false }, AT)), "nothing left behind");
});
ok("removing: the original goes to the gallery as removed; a copy goes for good; both can always be added again", () => {
  let l = hideSlot(emptyLayout(), "sleep", AT);
  assert.ok(!onPage(l, MAIN_PAGE, true).includes("sleep"));
  let g = gallery(l, MAIN_PAGE, true, true).find((x) => x.kind === "sleep")!;
  assert.ok(g.removed && g.all === 0);
  // Adding a removed original brings the original back first, on the page you are on.
  const r = addPanel(l, "sleep", P2, AT, undefined, rnd);
  assert.equal(r.id, "sleep");
  l = r.layout;
  assert.ok(!l.hidden.includes("sleep") && pageOf(l, "sleep") === P2);
  const c = addPanel(l, "sleep", P2, AT, undefined, rnd);
  l = hideSlot(c.layout, c.id!, AT);
  assert.ok(!(l.extra ?? []).includes(c.id!) && !l.hidden.includes(c.id!), "a copy is not kept as removed");
  g = gallery(l, P2, true, true, pages).find((x) => x.kind === "sleep")!;
  assert.equal(g.here, 1);
  assert.ok(canHide(c.id!) && !canHide("gear"));
});
ok("the gallery lists every panel and button always, the developer's own only for him, the gear and Tab and Lock never", () => {
  const g = gallery(emptyLayout(), MAIN_PAGE, false, true);
  const kinds = new Set(g.map((x) => x.kind));
  for (const s of SLOTS) {
    if (s.off || s.keep || s.red) assert.ok(!kinds.has(s.id), s.id);
    else assert.ok(kinds.has(s.id), s.id);
  }
  assert.ok(gallery(emptyLayout(), MAIN_PAGE, true, true).some((x) => x.kind === "brief"));
  assert.ok(!gallery(emptyLayout(), MAIN_PAGE, true, false).some((x) => x.kind === "islandsw"), "the island switch only in PS on a Mac");
});
ok("there is a limit on copies, and a cleaned record never names a copy that does not exist", () => {
  let l = emptyLayout();
  for (let i = 0; i < MAX_EXTRA + 5; i++) l = addPanel(l, "undo", MAIN_PAGE, AT, undefined, rnd).layout;
  assert.equal(l.extra!.length, MAX_EXTRA);
  const bad = cleanLayout({ pos: { "sleep.zzzz9999": { x: 0, y: 0, w: 10, h: 10 } }, hidden: [], at: AT, page: { "sleep.zzzz9999": P2 }, extra: ["nope.abcd1234", "gear.abcd1234x"] });
  assert.deepEqual(bad.pos, {}); assert.equal(bad.page, undefined);
  assert.ok(!(bad.extra ?? []).includes("nope.abcd1234"));
});

// ---------- sizes ----------
ok("the size handle: half to two and a half times, 1 is not written down, a moved panel's place grows with it", () => {
  let l = setSize(emptyLayout(), "sleep", 1.8, AT);
  assert.equal(sizeOf(l, "sleep"), 1.8);
  l = setSize(l, "sleep", 9, AT); assert.equal(sizeOf(l, "sleep"), SIZE_MAX);
  l = setSize(l, "sleep", 0.1, AT); assert.equal(sizeOf(l, "sleep"), SIZE_MIN);
  l = setSize(l, "sleep", 1, AT); assert.equal(l.size, undefined);
  const s = slotStyle({ x: 0, y: 0, w: 100, h: 40 }, 2);
  assert.match(s.width, /200px/);
});

// ---------- inner buttons out and back in ----------
ok("the Meetings panel's three buttons drag out to be their own, and back in", () => {
  let l = emptyLayout();
  const r = pullOut(l, "meetings", "privacy", MAIN_PAGE, { x: 0.9, y: 0.1, w: 34, h: 34 }, AT, rnd);
  assert.ok(r.id && kindOf(r.id) === "privacy");
  l = r.layout;
  assert.deepEqual([...outOf(l, "meetings")], ["privacy"], "the panel leaves it out while it is outside");
  assert.ok(onPage(l, MAIN_PAGE, true).includes(r.id!));
  assert.equal(pullOut(l, "meetings", "privacy", MAIN_PAGE, { x: 0, y: 0, w: 1, h: 1 }, AT, rnd).id, null, "only once per panel");
  assert.equal(pullOut(l, "sleep", "privacy", MAIN_PAGE, { x: 0, y: 0, w: 1, h: 1 }, AT, rnd).id, null, "only out of its own kind of panel");
  // It survives the round trip with its panel.
  const c = cleanLayout(JSON.parse(JSON.stringify(l)));
  assert.equal(cfgOf(c, r.id!).of, "meetings");
  l = pushIn(c, r.id!, "meetings", AT);
  assert.equal(outOf(l, "meetings").size, 0);
  assert.ok(!(l.extra ?? []).includes(r.id!));
});
ok("a copy of the Meetings panel has its own buttons; removing the panel keeps a dragged out button as its own", () => {
  let l = emptyLayout();
  const m = addPanel(l, "meetings", P2, AT, undefined, rnd); l = m.layout;
  const b = pullOut(l, m.id!, "calrefresh", P2, { x: 0.2, y: 0.2, w: 30, h: 30 }, AT, rnd); l = b.layout;
  assert.equal(outOf(l, "meetings").size, 0, "the original's button is still inside it");
  assert.ok(outOf(l, m.id!).has("calrefresh"));
  l = removeCopy(l, m.id!, AT);
  assert.ok((l.extra ?? []).includes(b.id!), "the button stays");
  assert.equal(cfgOf(l, b.id!).of, undefined);
});

// ---------- the record ----------
ok("the record stays small (change only) with pages, copies, sizes and settings", () => {
  let l: TabLayout = emptyLayout();
  for (let i = 0; i < 30; i++) { const r = addPanel(l, SLOTS[i % 20].id, i % 2 ? P2 : P3, AT, { x: 0.3, y: 0.6, w: 300, h: 200 }, rnd); l = setSize(r.layout, r.id ?? "sleep", 1.3, AT); }
  assert.ok(JSON.stringify(l).length < 6000, String(JSON.stringify(l).length));
});
ok("the PS Tab list's op carries the whole new record, checked again", () => {
  let l = addPanel(emptyLayout(), "sleep", P2, AT, undefined, rnd).layout;
  l = setSize(l, "dimx", 1.5, AT);
  const op = cleanLayoutOp({ op: "put", id: "abcdefgh1234", kind: "tablayout", data: l });
  assert.ok(op && op.op === "put" && sameLayout(op.data, l));
});
ok("same layout notices a page, size or setting change, never the time", () => {
  const a = addPanel(emptyLayout(), "sleep", P2, AT, undefined, rnd).layout;
  assert.ok(sameLayout(a, { ...a, at: "2027-01-01T00:00:00.000Z" }));
  assert.ok(!sameLayout(a, setSize(a, "sleep", 1.2, AT)));
  assert.ok(!sameLayout(a, putOnPage(a, "dimx", P3, AT)));
  assert.ok(!sameLayout(a, setCfg(a, "meetings", { cal: "g:abcd12" }, AT)));
});

console.log(`\n${n} passed`);
