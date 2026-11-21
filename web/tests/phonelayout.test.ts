// Run: node --experimental-strip-types tests/phonelayout.test.ts
// V1.56 phone layout editor (core/phonelayout.ts): one layout per phone kind, kept apart from the Mac's; pages on both
// sides of the list; tiles on a four wide grid that never overlap; the navbar's edge, place and buttons; each page's
// background and look; the record and the PS Tab list's op.
import assert from "node:assert/strict";
import {
  COLS, HOME, MAX_NAV, MAX_PAGES, PHONE_PANELS, addPage, addTile, cleanNavItems, defaultNavItems, cleanPhoneLayout, cleanPhoneLayoutOp, defaultPhoneLayout, freeSpot,
  isDefaultPhone, lookOf, moveTile, navChoices, navLabel, orderPages, phoneCan, phoneGallery, pickPhoneLayout, removePage, removeTile, renamePage,
  resizeTile, samePhoneLayout, cellAt, cellBox, cellsFor, ROW_H, setLook, setNavAlign, setNavEdge, setNavItems, settle, shiftPage, tileToPage, toggleNav, type PhoneLayout, type Tile,
} from "../src/core/phonelayout.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const M = await import("../src/core/mailflag.ts");
const AT = "2026-11-13T12:00:00.000Z";
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const overlaps = (ts: Tile[]) => ts.some((a, i) => ts.some((b, j) => i !== j && a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h));
const inGrid = (ts: Tile[]) => ts.every((t) => t.c >= 0 && t.c + t.w <= COLS && t.r >= 0 && t.w >= 1 && t.h >= 1);

// ---------- the default and storage per phone ----------
ok("a phone with no record: Plan, List, Inbox and every dock button at the bottom but the Soundboard (PS 1.72)", () => {
  const g = defaultPhoneLayout("gos", false);
  assert.deepEqual(g.pages.map((p) => p.id), ["plan", "list", "inbox"]);
  assert.deepEqual(g.nav, { edge: "bottom", align: "full", items: ["plan", "list", "inbox", "gym", "vault", "settings"] });
  assert.ok(defaultPhoneLayout("gos", true).nav.items.includes("rules"), "The developer's dock has Rules");
  assert.ok(isDefaultPhone(g));
  assert.equal(HOME, "list");
});
ok("GOS and iPhone are separate records: the newest of each kind is picked, never the other kind's", () => {
  const g = { ...defaultPhoneLayout("gos"), at: "2026-11-13T10:00:00.000Z" };
  const g2 = { ...defaultPhoneLayout("gos"), at: "2026-11-13T11:00:00.000Z", nav: { ...g.nav, edge: "top" as const } };
  const i = { ...defaultPhoneLayout("ios"), at: "2026-11-13T12:00:00.000Z" };
  const docs = [{ id: "aaaaaaaa1", data: g }, { id: "bbbbbbbb2", data: g2 }, { id: "cccccccc3", data: i }];
  const pg = pickPhoneLayout(docs, "gos");
  assert.equal(pg.keep?.id, "bbbbbbbb2");
  assert.deepEqual(pg.extra.map((d) => d.id), ["aaaaaaaa1"]);
  assert.equal(pickPhoneLayout(docs, "ios").keep?.id, "cccccccc3");
  assert.equal(pickPhoneLayout([], "ios").keep, null);
});
ok("a changed layout is not the same as the default; the time alone never counts as a change", () => {
  const a = defaultPhoneLayout("ios");
  assert.ok(samePhoneLayout(a, { ...a, at: AT }));
  assert.ok(!samePhoneLayout(a, setNavEdge(a, "top", AT)));
  assert.ok(!samePhoneLayout(a, defaultPhoneLayout("gos")), "different phones never match");
});

// ---------- cleaning ----------
ok("cleaning: unknown pages and panels go, the built in pages come back where they belong, nothing overlaps", () => {
  const raw = {
    phone: "gos", at: AT,
    pages: [
      { id: "inbox", kind: "inbox" }, { id: "evil", kind: "panels" }, { id: "list", kind: "list" }, { id: "list", kind: "list" },
      { id: "pabcdef12", kind: "panels", name: "Morning\u2014stuff", tiles: [
        { id: "meetings", c: 0, r: 0, w: 4, h: 3 }, { id: "sleep", c: 1, r: 1, w: 2, h: 1 }, { id: "sentry", c: 0, r: 5, w: 1, h: 1 },
        { id: "<script>", c: 0, r: 0, w: 1, h: 1 }, { id: "timelines", c: 9, r: -4, w: 99, h: 0 },
      ] },
    ],
    nav: { edge: "left", align: "middle", items: ["list", "list", "nuke", "page:pabcdef12", "page:nope"] },
  };
  const l = cleanPhoneLayout(raw, "gos");
  assert.deepEqual(l.pages.map((p) => p.id), ["inbox", "plan", "list", "pabcdef12"].sort((a, b) => ["inbox", "plan", "list", "pabcdef12"].indexOf(a) - ["inbox", "plan", "list", "pabcdef12"].indexOf(b)));
  assert.ok(l.pages.findIndex((p) => p.id === "plan") < l.pages.findIndex((p) => p.id === "list"), "Plan returns left of the list");
  const t = l.pages.find((p) => p.id === "pabcdef12")!;
  assert.equal(t.name, "Morning stuff", "no dashes, ever");
  assert.deepEqual(t.tiles!.map((x) => x.id), ["meetings", "sleep", "timelines"], "the Mac only Sentry button and junk are dropped");
  assert.ok(!overlaps(t.tiles!) && inGrid(t.tiles!));
  assert.deepEqual(l.nav, { edge: "bottom", align: "full", items: ["list", "page:pabcdef12", "settings"] });
});
ok("cleaning keeps the developer only panels off a stranger's phone and GOS only ones off an iPhone", () => {
  const raw = { phone: "ios", pages: [{ id: "pqwerty12", kind: "panels", tiles: [{ id: "mail", c: 0, r: 0, w: 4, h: 3 }, { id: "clipboard", c: 0, r: 3, w: 1, h: 1 }, { id: "dnd", c: 1, r: 3, w: 1, h: 1 }] }] };
  M.setMailAllowed(false);   // Client emails (core/mailswitch.ts) off: the panel is not theirs, whoever they are
  assert.deepEqual(cleanPhoneLayout(raw, "ios", false).pages.find((p) => p.kind === "panels")!.tiles!.map((t) => t.id), ["dnd"]);
  assert.deepEqual(cleanPhoneLayout(raw, "ios", true).pages.find((p) => p.kind === "panels")!.tiles!.map((t) => t.id), ["dnd"]);
  M.setMailAllowed(true);    // switched on: anyone's, no matter whose account
  assert.deepEqual(cleanPhoneLayout(raw, "ios", false).pages.find((p) => p.kind === "panels")!.tiles!.map((t) => t.id), ["mail", "dnd"]);
  M.setMailAllowed(false);
  assert.ok(phoneCan("clipboard", "gos", false) && !phoneCan("clipboard", "ios", false));
  assert.ok(!phoneCan("sentry", "gos", true) && !phoneCan("glass", "ios", true) && !phoneCan("second", "gos", true), "Mac only panels never");
});

// ---------- pages ----------
ok("pages: added on both sides of the list, named, reordered, renamed and deleted; the built in ones stay", () => {
  let l = defaultPhoneLayout("gos");
  const a = addPage(l, 0, AT, rnd); l = a.layout;
  const b = addPage(l, l.pages.length, AT, rnd); l = b.layout;
  assert.ok(a.id && b.id);
  assert.deepEqual(l.pages.map((p) => p.id), [a.id, "plan", "list", "inbox", b.id]);
  assert.deepEqual(l.pages.filter((p) => p.kind === "panels").map((p) => p.name), ["Page 2", "Page 3"]);
  l = shiftPage(l, b.id!, -1, AT);
  assert.deepEqual(l.pages.map((p) => p.id), [a.id, "plan", "list", b.id, "inbox"]);
  l = orderPages(l, ["list", b.id!, a.id!, "inbox", "plan"], AT);
  assert.deepEqual(l.pages.map((p) => p.id), ["list", b.id, a.id, "inbox", "plan"]);
  l = renamePage(l, a.id!, "  Gym  ", AT);
  assert.equal(l.pages.find((p) => p.id === a.id)!.name, "Gym");
  assert.equal(removePage(l, "list", AT), l, "the list is never deleted");
  assert.equal(removePage(l, "plan", AT), l, "nor Plan");
  l = toggleNav(l, `page:${a.id}`, false, AT);
  assert.ok(l.nav.items.includes(`page:${a.id}`));
  l = removePage(l, a.id!, AT);
  assert.ok(!l.pages.some((p) => p.id === a.id));
  assert.ok(!l.nav.items.includes(`page:${a.id}`), "its navbar button goes with it");
});
ok("pages: no more than the limit", () => {
  let l = defaultPhoneLayout("ios");
  for (let i = 0; i < MAX_PAGES + 3; i++) l = addPage(l, 0, AT, rnd).layout;
  assert.equal(l.pages.filter((p) => p.kind === "panels").length, MAX_PAGES);
  assert.equal(addPage(l, 0, AT, rnd).id, null);
});

// ---------- tiles ----------
ok("tiles: added at their usual size in the first free place; the first is the original, then copies", () => {
  let l = addPage(defaultPhoneLayout("gos"), 3, AT, rnd).layout;
  const pg = l.pages[3].id;
  const r1 = addTile(l, pg, "meetings", false, AT, rnd); l = r1.layout;
  const r2 = addTile(l, pg, "sleep", false, AT, rnd); l = r2.layout;
  const r3 = addTile(l, pg, "sleep", false, AT, rnd); l = r3.layout;
  const r4 = addTile(l, pg, "dnd", false, AT, rnd); l = r4.layout;
  assert.equal(r1.id, "meetings");
  assert.equal(r2.id, "sleep");
  assert.match(r3.id!, /^sleep\.[a-z0-9]{8}$/, "the second Sleep is a copy");
  const ts = l.pages[3].tiles!;
  assert.deepEqual(ts.find((t) => t.id === "meetings"), { id: "meetings", c: 0, r: 0, w: 4, h: 4 });
  assert.deepEqual(ts.find((t) => t.id === "sleep"), { id: "sleep", c: 0, r: 4, w: 2, h: 1 });
  assert.deepEqual(ts.find((t) => t.id === r3.id), { id: r3.id, c: 2, r: 4, w: 2, h: 1 });
  assert.deepEqual(ts.find((t) => t.id === "dnd"), { id: "dnd", c: 0, r: 5, w: 1, h: 1 });
  assert.equal(addTile(l, "list", "sleep", false, AT, rnd).id, null, "only pages of panels hold tiles");
  assert.equal(addTile(l, pg, "sentry", true, AT, rnd).id, null, "never a panel the phone cannot draw");
  assert.equal(addTile(l, pg, "mail", false, AT, rnd).id, null, "The developer only panels only on the developer's account");
});
ok("tiles: moving one makes room (the others move down), never off the grid, never overlapping", () => {
  let l = addPage(defaultPhoneLayout("gos"), 3, AT, rnd).layout;
  const pg = l.pages[3].id;
  for (const k of ["meetings", "sleep", "fitness", "soundboard", "timelines"]) l = addTile(l, pg, k, false, AT, rnd).layout;
  l = moveTile(l, pg, "timelines", 0, 0, AT);
  const ts = l.pages[3].tiles!;
  assert.deepEqual(ts.find((t) => t.id === "timelines"), { id: "timelines", c: 0, r: 0, w: 4, h: 1 }, "the moved one keeps the place it was dropped");
  assert.equal(ts.find((t) => t.id === "meetings")!.r, 1, "Meetings moved down one row to make room");
  assert.ok(!overlaps(ts) && inGrid(ts));
  const far = moveTile(l, pg, "sleep", 99, -5, AT).pages[3].tiles!;
  assert.deepEqual(far.find((t) => t.id === "sleep")!.c, COLS - 2, "kept on the grid");
  assert.ok(!overlaps(far) && inGrid(far));
  assert.equal(moveTile(l, pg, "timelines", 0, 0, AT), l, "dropped where it was: nothing changes");
});
ok("tiles: sizing keeps them on the grid and makes room", () => {
  let l = addPage(defaultPhoneLayout("ios"), 3, AT, rnd).layout;
  const pg = l.pages[3].id;
  for (const k of ["fitness", "soundboard", "dnd", "undo"]) l = addTile(l, pg, k, false, AT, rnd).layout;
  l = moveTile(l, pg, "dnd", 3, 0, AT);
  l = resizeTile(l, pg, "dnd", 3, 2, AT);
  const ts = l.pages[3].tiles!;
  assert.deepEqual(ts.find((t) => t.id === "dnd"), { id: "dnd", c: 1, r: 0, w: 3, h: 2 }, "too wide for its column: it moved left");
  assert.ok(!overlaps(ts) && inGrid(ts));
  const big = resizeTile(l, pg, "dnd", 99, 99, AT).pages[3].tiles!.find((t) => t.id === "dnd")!;
  assert.ok(big.w === COLS && big.h === 8, "the largest is the full width and eight rows");
});
ok("tiles: moved to another page, removed, and the gallery counts them", () => {
  let l = defaultPhoneLayout("gos");
  l = addPage(l, 0, AT, rnd).layout; const a = l.pages[0].id;
  l = addPage(l, l.pages.length, AT, rnd).layout; const b = l.pages[l.pages.length - 1].id;
  l = addTile(l, a, "meetings", false, AT, rnd).layout;
  l = addTile(l, b, "meetings", false, AT, rnd).layout;
  l = addTile(l, a, "sleep", false, AT, rnd).layout;
  let g = phoneGallery(l, a, false).find((x) => x.kind === "meetings")!;
  assert.deepEqual([g.here, g.all], [1, 2]);
  l = tileToPage(l, a, "sleep", b, AT);
  assert.ok(!l.pages[0].tiles!.some((t) => t.id === "sleep") && l.pages.at(-1)!.tiles!.some((t) => t.id === "sleep"));
  assert.ok(!overlaps(l.pages.at(-1)!.tiles!));
  assert.equal(tileToPage(l, b, "sleep", "list", AT), l, "never onto a built in page");
  l = removeTile(l, b, "sleep", AT);
  g = phoneGallery(l, b, false).find((x) => x.kind === "sleep")!;
  assert.deepEqual([g.here, g.all], [0, 0], "removed for good, still in the gallery");
  const kinds = phoneGallery(l, b, false).map((x) => x.kind);
  assert.ok(kinds.includes("clipboard") && !kinds.includes("mail"), "GOS has Clear clipboard; a stranger never sees Client emails");
  assert.ok(!phoneGallery(defaultPhoneLayout("ios"), "list", true).some((x) => x.kind === "clipboard" || x.kind === "screentime"), "the iPhone cannot do these");
});
ok("settle and freeSpot: a full row is skipped; settling twice changes nothing", () => {
  const ts: Tile[] = [{ id: "a", c: 0, r: 0, w: 4, h: 1 }, { id: "b", c: 0, r: 0, w: 2, h: 2 }, { id: "c", c: 1, r: 1, w: 2, h: 1 }];
  const s1 = settle(ts, "a");
  assert.ok(!overlaps(s1));
  assert.deepEqual(settle(s1, null), s1);
  assert.deepEqual(freeSpot(s1, 4, 1), { c: 0, r: 4 });
  assert.equal(PHONE_PANELS.every((p) => p.w >= 1 && p.w <= COLS), true);
});

// ---------- the navbar ----------
ok("navbar: top or bottom, full, left, centre or right; buttons in and out in any order; Settings always stays", () => {
  let l = defaultPhoneLayout("gos");
  l = setNavEdge(l, "top", AT);
  l = setNavAlign(l, "center", AT);
  assert.deepEqual([l.nav.edge, l.nav.align], ["top", "center"]);
  l = toggleNav(l, "vault", false, AT);
  assert.deepEqual(l.nav.items, ["plan", "list", "inbox", "gym", "settings"]);
  assert.equal(toggleNav(l, "settings", false, AT), l, "Settings never leaves");
  l = toggleNav(l, "vault", false, AT);
  assert.deepEqual(l.nav.items, ["plan", "list", "inbox", "gym", "vault", "settings"], "a button comes back before Settings");
  l = setNavItems(l, ["settings", "list", "gym"], false, AT);
  assert.deepEqual(l.nav.items, ["settings", "list", "gym"], "any order, Settings too");
  assert.deepEqual(setNavItems(l, ["list"], false, AT).nav.items, ["list", "settings"]);
  assert.ok(!setNavItems(l, ["rules", "list"], false, AT).nav.items.includes("rules"), "Rules only on the developer's account");
  assert.equal(cleanNavItems(["plan", "list", "inbox", "gym", "soundboard", "vault", "rules", "x", "page:a", "list"], l.pages, true).length, 8);
  assert.ok(cleanNavItems(Array(20).fill(0).map((_, i) => `n${i}`), l.pages, true).length <= MAX_NAV);
});
ok("navbar: a page of panels can have its own button, named after the page", () => {
  let l = addPage(defaultPhoneLayout("ios"), 3, AT, rnd).layout;
  const id = l.pages[3].id;
  l = renamePage(l, id, "Focus", AT);
  const c = navChoices(l, false);
  assert.ok(c.some((x) => x.id === `page:${id}` && x.label === "Focus" && !x.on));
  l = toggleNav(l, `page:${id}`, false, AT);
  assert.equal(navLabel(l, `page:${id}`), "Focus");
  assert.equal(l.nav.items.at(-1), "settings");
});

// ---------- looks ----------
ok("each page's own background and look, and the phone's own for every other page", () => {
  let l = defaultPhoneLayout("gos");
  l = setLook(l, null, "bg", "storm-forked", AT);
  l = setLook(l, "plan", "bg", "spotlight", AT);
  l = setLook(l, "plan", "look", "midnight", AT);
  assert.deepEqual(lookOf(l, "plan"), { bg: "spotlight", look: "midnight" });
  assert.deepEqual(lookOf(l, "list"), { bg: "storm-forked", look: null });
  l = setLook(l, "plan", "bg", null, AT);
  assert.deepEqual(lookOf(l, "plan"), { bg: "storm-forked", look: "midnight" }, "back to the phone's own");
  assert.equal(setLook(l, "plan", "bg", "<img onerror>", AT), l, "junk is refused");
});

// ---------- the op from the PS Tab list ----------
ok("the Tab list's op is checked again: only a phonelayout put with a known phone, cleaned", () => {
  const data = setNavEdge(defaultPhoneLayout("ios"), "top", AT);
  const op = cleanPhoneLayoutOp({ op: "put", id: "abcdef12-3456", kind: "phonelayout", data })!;
  assert.equal(op.data.nav.edge, "top");
  assert.equal(cleanPhoneLayoutOp({ op: "remove", id: "abcdef12-3456" }), null, "the Tab list never removes it");
  assert.equal(cleanPhoneLayoutOp({ op: "put", id: "abcdef12-3456", kind: "settings", data }), null);
  assert.equal(cleanPhoneLayoutOp({ op: "put", id: "abcdef12-3456", data: { ...data, phone: "windows" } }), null);
  assert.equal(cleanPhoneLayoutOp({ op: "put", id: "x", data }), null);
});
ok("the record stays small: a busy phone layout is a few KB", () => {
  let l: PhoneLayout = defaultPhoneLayout("gos", true);
  for (let i = 0; i < 6; i++) { const a = addPage(l, l.pages.length, AT, rnd); l = a.layout; for (const k of ["meetings", "sleep", "sleep", "dnd", "timelines"]) l = addTile(l, a.id!, k, true, AT, rnd).layout; }
  assert.ok(JSON.stringify(l).length < 6000, `${JSON.stringify(l).length} bytes`);
});

ok("the grid on screen: tiles land on whole cells, the inverse finds the same cell, sizes snap to cells", () => {
  const W = 393;
  const b = cellBox({ c: 1, r: 2, w: 2, h: 1 }, W);
  assert.equal(b.top, 2 * (ROW_H + 10));
  assert.deepEqual(cellAt(b.left + 3, b.top + 5, W, 2, 1), { c: 1, r: 2 });
  assert.deepEqual(cellAt(-500, -500, W, 2, 1), { c: 0, r: 0 });
  assert.deepEqual(cellAt(9999, 0, W, 2, 1), { c: COLS - 2, r: 0 });
  const full = cellBox({ c: 0, r: 0, w: COLS, h: 1 }, W);
  assert.ok(Math.abs(full.left * 2 + full.width - W) < 0.01, "the full width row is centred");
  assert.deepEqual(cellsFor(full.width, ROW_H * 3 + 20, W), { w: COLS, h: 3 });
  assert.deepEqual(cellsFor(5, 5, W), { w: 1, h: 1 });
});

// ---------- PS 1.72: the Soundboard off the navbar by default (the developer, 21 Nov 2026), like Pomodoro on the Tab list in 1.70 ----------
ok("the Soundboard: not in a new navbar, and a navbar saved before 1.72 with the old Sounds button no longer draws it", () => {
  assert.ok(!defaultNavItems(false).includes("soundboard") && !defaultNavItems(true).includes("soundboard"));
  const old = cleanPhoneLayout({ phone: "gos", pages: [], nav: { edge: "bottom", align: "full", items: ["plan", "list", "inbox", "gym", "sounds", "vault", "settings"] } }, "gos", false);
  assert.deepEqual(old.nav.items, ["plan", "list", "inbox", "gym", "vault", "settings"]);
});
ok("the Soundboard: Edit mode's navbar list offers it by its Soundboard name, and it goes back in its own place, between Gym and Vault", () => {
  let l = defaultPhoneLayout("gos");
  const c = navChoices(l, false).find((x) => x.id === "soundboard")!;
  assert.equal(c.label, "Soundboard"); assert.equal(c.on, false);
  l = toggleNav(l, "soundboard", false, AT);
  assert.deepEqual(l.nav.items, ["plan", "list", "inbox", "gym", "soundboard", "vault", "settings"]);
  assert.equal(navLabel(l, "soundboard"), "Sounds", "the button keeps its word");
  l = toggleNav(l, "soundboard", false, AT);
  assert.ok(!l.nav.items.includes("soundboard"));
  // A button that is not opt in still comes back before Settings.
  l = toggleNav(toggleNav(l, "gym", false, AT), "gym", false, AT);
  assert.deepEqual(l.nav.items, ["plan", "list", "inbox", "vault", "gym", "settings"]);
});
console.log(`\n${n} passed`);
