// Run: node --experimental-strip-types tests/keep-unknown.test.ts
// PS 1.71 (item 3): no build ever deletes, collapses or saves over ids, pages or fields it does not know. For every
// synced record with a cleaner (the settings lists, the Tab layout, the phone layout) a record from a newer build
// survives a save by this build untouched, what the person removed stays removed, and a list changed on an old copy
// never drops what another device made meanwhile. Jan's report (19 Nov 2026) is the first case. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { carryGroups, carryPageOrder, carryPages, carrySecOrder, carrySettings, goneAfter, lostPanelPages, mergeLists, LIST_KEYS } from "../src/core/keepunknown.ts";
import { mergeSettings, settingsWrite } from "../src/core/cardsync.ts";
import { cleanPages, pageOfTask, pageOrder, renamePage, removePage, PAGES_MAX } from "../src/core/lists.ts";
import { carryUnknown, cleanLayout, moveSlot, onPage } from "../src/core/tablayout.ts";
import { carryUnknownPhone, cleanPhoneLayout } from "../src/core/phonelayout.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const DEFAULTS = { ownerName: "Owner", autoLockMin: 15, autoReset: "off", theme: "system" } as any;
const name = (k: number) => `Page ${k}`;

// A Mac with two lists and two pages of panels (fictional).
const pages = [
  { id: "work2026a", name: "Work", secs: ["g:chk1aaaa"] },
  { id: "gym2026bb", name: "Gym", secs: ["g:chk2bbbb", "daily"] },
  { id: "pnl0clock", name: "Clocks", secs: [], kind: "panels" },
  { id: "pnl0squad", name: "Squad", secs: [], kind: "panels" },
];
const server = {
  ...DEFAULTS, ownerName: "Sam", theme: "dark", autoReset: "midnight", whatsNewSeen: "1.69",
  tmPages: pages, tmPageOrder: ["gym2026bb", "main", "work2026a", "pnl0clock", "pnl0squad"],
  tmGroups: [{ id: "chk1aaaa", name: "Morning checklist" }, { id: "chk2bbbb", name: "Lifts" }],
  tmSecOrder: ["p1", "prio", "daily", "g:chk1aaaa", "g:chk2bbbb"],
} as any;
// What one save by this build sends, as core/actions.ts saveSettings and core/vault.ts flush do it: the carry, the
// change list, then the merge with the server's newer copy from the list's base.
function save(copy: any, patch: any, srv: any) {
  const w = settingsWrite(copy, carrySettings(copy, patch), DEFAULTS, true);
  const base: Record<string, unknown> = {};
  for (const k of w.changed) if (LIST_KEYS.has(k)) base[k] = copy?.[k] ?? null;
  return json(mergeSettings(w.data, srv, new Set(w.changed), base));
}

// ---------- Jan's report ----------
ok("Jan's case: a stale device's automatic save after an update keeps every list, page and panel", () => {
  const stale = { ...DEFAULTS, ownerName: "Sam", theme: "dark", autoReset: "midnight", whatsNewSeen: "1.67", tmGroups: server.tmGroups };
  const sent = save(stale, { whatsNewSeen: "1.70" }, server);
  assert.deepEqual(sent.tmPages, server.tmPages);
  assert.deepEqual(sent.tmPageOrder, server.tmPageOrder);
  assert.equal(sent.whatsNewSeen, "1.70");
  assert.equal(sent.theme, "dark");
});
ok("a list renamed on a device whose copy was old: the pages made elsewhere meanwhile stay", () => {
  const old = { ...server, tmPages: pages.slice(0, 2), tmPageOrder: ["gym2026bb", "main", "work2026a"] };
  const view = cleanPages(old.tmPages);
  const sent = save(old, { tmPages: renamePage(view, "work2026a", "Work stuff"), tmPageOrder: pageOrder(old.tmPageOrder, view) }, server);
  assert.deepEqual(sent.tmPages.map((p: any) => p.id), ["work2026a", "gym2026bb", "pnl0clock", "pnl0squad"]);
  assert.equal(sent.tmPages[0].name, "Work stuff");
  assert.deepEqual(sent.tmPageOrder, server.tmPageOrder);
});
ok("a list deleted here is deleted; one deleted on the other device meanwhile stays deleted", () => {
  const view = cleanPages(server.tmPages);
  const sent = save(server, { tmPages: removePage(view, "gym2026bb"), tmPageOrder: server.tmPageOrder.filter((x: string) => x !== "gym2026bb") }, server);
  assert.ok(!sent.tmPages.some((p: any) => p.id === "gym2026bb"));
  assert.deepEqual(sent.tmPagesGone, ["gym2026bb"]);
  // The other device deleted Clocks while this one renamed Work on its copy that still had Clocks.
  const srv2 = { ...server, tmPages: pages.filter((p) => p.id !== "pnl0clock"), tmPageOrder: server.tmPageOrder.filter((x: string) => x !== "pnl0clock") };
  const sent2 = save(server, { tmPages: renamePage(view, "work2026a", "W") }, srv2);
  assert.deepEqual(sent2.tmPages.map((p: any) => p.id), ["work2026a", "gym2026bb", "pnl0squad"]);
});
ok("an Undo that brings a deleted list back takes it off the deleted pages", () => {
  const gone = goneAfter(server.tmPages, cleanPages(server.tmPages).filter((p) => p.id !== "work2026a"), []);
  assert.deepEqual(gone, ["work2026a"]);
  assert.deepEqual(goneAfter(server.tmPages, cleanPages(server.tmPages), gone), []);
});

// ---------- the settings lists from a newer build ----------
const newer = [
  { ...pages[0], icon: "briefcase", secs: ["g:chk1aaaa", "ideas", "g:newgroup1"] },
  { id: "notes2026", name: "Notes", secs: [], kind: "notes", body: "x" },
  { id: "PG-v2-0001", name: "New id form", secs: ["p1x"] },
  pages[2],
  { ...pages[3], bg: "a/b c" },   // a background in a form this build cannot read
];
ok("pages: a newer page field, section key, page kind, id form and background value survive a rename", () => {
  const view = cleanPages(newer);
  const out = carryPages(newer, renamePage(view, "work2026a", "Work stuff"));
  assert.deepEqual(json(out), json([
    { ...newer[0], name: "Work stuff" }, { ...newer[1] }, newer[2], newer[3], newer[4],
  ]));
});
ok("pages: what the person changed here wins, what they removed stays removed", () => {
  const view = cleanPages(newer).filter((p) => p.id !== "pnl0clock").map((p) => (p.id === "work2026a" ? { ...p, secs: ["g:newgroup1"] } : p));
  const out = carryPages(newer, view);
  assert.ok(!out.some((p) => p.id === "pnl0clock"));
  assert.deepEqual(out.find((p) => p.id === "work2026a")!.secs, ["ideas", "g:newgroup1"], "a known section moved out, the unknown one kept");
  const bgOff = carryPages([{ ...pages[0], bg: "aurora" }], [{ ...pages[0] }]);
  assert.equal((bgOff[0] as any).bg, undefined, "a background this build read and the person took off stays off");
});
ok("page order, section order and groups keep what this build cannot read, in place", () => {
  const order = ["main", "PG-v2-0001", "work2026a", "pnl0clock", "x-unknown"];
  const view = pageOrder(order, cleanPages(newer));
  assert.deepEqual(carryPageOrder(order, view.filter((x) => x !== "pnl0clock"), newer), ["main", "PG-v2-0001", "work2026a", "x-unknown", "notes2026", "pnl0squad"],
    "each after the stored id it followed that is still there");
  assert.deepEqual(carrySecOrder(["p1", "focus", "prio", "daily"], ["prio", "p1", "daily"]), ["prio", "p1", "focus", "daily"]);
  const groups = [{ id: "chk1aaaa", name: "Morning", color: "teal" }, { id: "G_NEW_1", name: "Newer id" }, { id: "chk2bbbb", name: "Lifts" }];
  assert.deepEqual(json(carryGroups(groups, [{ id: "chk1aaaa", name: "Mornings" }])), [{ id: "chk1aaaa", name: "Mornings", color: "teal" }, { id: "G_NEW_1", name: "Newer id" }]);
});
ok("settings: one save carries every list it sets and touches nothing else", () => {
  const stored = { ...server, tmPages: newer, tmSecOrder: ["p1", "focus", "prio"] } as any;
  const p = carrySettings(stored, { tmSecOrder: ["prio", "p1"], theme: "light" } as any) as any;
  assert.deepEqual(p.tmSecOrder, ["prio", "p1", "focus"]);
  assert.equal(p.theme, "light");
  assert.equal(p.tmPages, undefined, "pages not in the patch are not written");
});
ok("the list merge: each item from the side that changed it, new items from both, a change beats a remove", () => {
  const base = [{ id: "aaaa1111", name: "A" }, { id: "bbbb2222", name: "B" }];
  const local = [{ id: "aaaa1111", name: "A2" }, { id: "cccc3333", name: "C" }];
  const remote = [{ id: "bbbb2222", name: "B2" }, { id: "aaaa1111", name: "A" }, { id: "dddd4444", name: "D" }];
  assert.deepEqual(mergeLists("tmPages", base, local, remote), [{ id: "bbbb2222", name: "B2" }, { id: "aaaa1111", name: "A2" }, { id: "dddd4444", name: "D" }, { id: "cccc3333", name: "C" }],
    "the server's new items after the item they followed there");
  assert.deepEqual(mergeLists("tmPageOrder", ["main", "x1111", "y2222"], ["y2222", "main"], ["main", "x1111", "y2222", "z3333"]), ["y2222", "z3333", "main"]);
  assert.deepEqual(mergeLists("tmPages", undefined, local, remote), local, "no base (a change from before 1.71): this device's, as in 1.68");
});

// ---------- the Tab layout ----------
const layout = {
  at: "2026-11-18T10:00:00.000Z",
  pos: { "clocks.k3f9a2b1": { x: 0.6, y: 0.1, w: 300, h: 170 }, "hologram.ab12cd34": { x: 0.3, y: 0.4, w: 200, h: 100 } },
  hidden: [],
  extra: ["clocks.k3f9a2b1", "sleep.zz11aa22", "hologram.ab12cd34", "squadp1.q1w2e3r4", "meetings.m1e2e3t4"],
  page: { "clocks.k3f9a2b1": "pnl0clock", "hologram.ab12cd34": "pnl0clock", "squadp1.q1w2e3r4": "pnl0squad", "sleep.zz11aa22": "PG-v2-0001" },
  size: { "hologram.ab12cd34": 1.5 },
  cfg: { "hologram.ab12cd34": { mode: "orbit" }, "squadp1.q1w2e3r4": { rows: 6 }, "meetings.m1e2e3t4": { cal: "o:outlook1", zoom: 2 } },
  lock: true, theme: { glass: 0.4 },
};
ok("Tab layout: a move keeps an unknown panel, its page, size and setting, newer fields and setting values", () => {
  const next = moveSlot(cleanLayout(layout), "clocks.k3f9a2b1", { x: 0.1, y: 0.1, w: 320, h: 180 }, "2026-11-19T09:00:00.000Z");
  const out = carryUnknown(layout, cleanLayout(next)) as any;
  assert.ok(out.extra.includes("hologram.ab12cd34"));
  assert.equal(out.page["hologram.ab12cd34"], "pnl0clock"); assert.equal(out.size["hologram.ab12cd34"], 1.5);
  assert.deepEqual(out.cfg["hologram.ab12cd34"], { mode: "orbit" });
  assert.deepEqual(out.cfg["squadp1.q1w2e3r4"], { rows: 6 });
  assert.deepEqual(out.cfg["meetings.m1e2e3t4"], { cal: "o:outlook1", zoom: 2 }, "a calendar kind this build cannot read, untouched");
  assert.equal(out.page["sleep.zz11aa22"], "PG-v2-0001", "a page id in a newer form");
  assert.equal(out.lock, true); assert.deepEqual(out.theme, { glass: 0.4 });
  assert.deepEqual(out.pos["clocks.k3f9a2b1"], { x: 0.1, y: 0.1, w: 320, h: 180 });
});
ok("Tab layout: a setting the person changed here is theirs; a panel they removed stays removed", () => {
  const c = cleanLayout(layout);
  const next = { ...c, cfg: { ...c.cfg, "meetings.m1e2e3t4": { cal: "g:primary" } }, extra: c.extra!.filter((x) => x !== "sleep.zz11aa22") };
  const out = carryUnknown(layout, next) as any;
  assert.equal(out.cfg["meetings.m1e2e3t4"].cal, "g:primary"); assert.equal(out.cfg["meetings.m1e2e3t4"].zoom, 2);
  assert.ok(!out.extra.includes("sleep.zz11aa22"));
  assert.equal(out.page["sleep.zz11aa22"], undefined);
});

// ---------- the phone layout ----------
const phone = { phone: "gos", at: "2026-11-18T10:00:00.000Z", grid: { dense: true },
  // given: a newer build's navbar has had the PS 1.73 Clients button put in once (core/phonelayout.ts ONE_TIME_NAV), and this one took it out.
  nav: { edge: "bottom", align: "full", items: ["plan", "list", "hologram", "page:pnotes1", "settings"], blur: 3, given: ["clients", "holodeck"] },
  pages: [{ id: "plan", kind: "plan" }, { id: "list", kind: "list", pin: true }, { id: "inbox", kind: "inbox" },
    { id: "pnotes1", kind: "notes", name: "Notes" },
    { id: "pnl0phone", kind: "panels", name: "Mine", tiles: [{ id: "hologram.ab12cd34", c: 0, r: 0, w: 2, h: 2 }, { id: "sleep.zz11aa22", c: 2, r: 0, w: 2, h: 1 }, { id: "dnd.d1n2d3x4", c: 2, r: 1, w: 1, h: 1 }] }] };
ok("phone layout: a newer page kind, tile, navbar button and field survive a save; what was removed stays removed", () => {
  const c = cleanPhoneLayout(phone, "gos", false);
  assert.ok(!c.pages.some((p) => p.id === "pnotes1"));
  const mine = c.pages.find((p) => p.id === "pnl0phone")!;
  const next = { ...c, pages: c.pages.map((p) => (p.id === "pnl0phone" ? { ...p, tiles: mine.tiles!.filter((t) => t.id !== "dnd.d1n2d3x4") } : p)) };
  const out = carryUnknownPhone(phone, next, false) as any;
  assert.deepEqual(out.pages.map((p: any) => p.id), ["plan", "list", "inbox", "pnotes1", "pnl0phone"]);
  assert.equal(out.pages[1].pin, true);
  const tiles = out.pages[4].tiles.map((t: any) => t.id);
  assert.ok(tiles.includes("hologram.ab12cd34") && tiles.includes("sleep.zz11aa22") && !tiles.includes("dnd.d1n2d3x4"));
  assert.deepEqual(out.nav.items, ["plan", "list", "hologram", "page:pnotes1", "settings"]);
  assert.equal(out.nav.blur, 3); assert.deepEqual(out.grid, { dense: true });
  assert.deepEqual(out.nav.given, ["clients", "holodeck"], "a removed Clients stays removed; a newer build's own given one stays");
  const noPage = carryUnknownPhone(phone, { ...c, pages: c.pages.filter((p) => p.id !== "pnl0phone") }, false) as any;
  assert.ok(!noPage.pages.some((p: any) => p.id === "pnl0phone"), "a page of panels the person deleted stays deleted");
});

// ---------- R4: pages of panels that got lost ----------
ok("lost pages of panels come back with their panels; never a deleted one, never past the limit", () => {
  const lost = { ...server, tmPages: pages.slice(0, 2), tmPagesGone: ["pnl0squad"] };
  const l = cleanLayout(layout);
  const back = lostPanelPages(l.page, lost, name);
  assert.deepEqual(back, [{ id: "pnl0clock", name: "Page 2", secs: [], kind: "panels" }]);
  const st = { ...lost, tmPages: [...lost.tmPages, ...back] };
  const set = new Set(pageOrder(undefined, cleanPages(st.tmPages)));
  assert.ok(onPage(l, "pnl0clock", false, set).includes("clocks.k3f9a2b1"), "the panels are on it again");
  assert.equal(pageOfTask({ id: "t1", type: "prio", group: "chk1aaaa" } as any, new Set(["chk1aaaa"]), cleanPages(st.tmPages)), "work2026a");
  const full = Array.from({ length: PAGES_MAX }, (_, i) => ({ id: `full${String(i).padStart(4, "0")}`, name: "L", secs: [] }));
  assert.deepEqual(lostPanelPages(l.page, { tmPages: full }, name), []);
});

// ---------- every write goes through its carry ----------
ok("every settings, Tab layout and phone layout write carries what it cannot read", () => {
  const act = src("core/actions.ts");
  assert.match(act, /settingsWrite\(s\?\.data, carrySettings\(s\?\.data, patch\)/);
  assert.match(act, /keep \? carryUnknown\(keep\.data, data\) : data/);
  assert.match(act, /keep \? carryUnknownPhone\(keep\.data, data, red\) : data/);
  assert.match(act, /mergeSettings\(a as Settings, b as Settings, settingsDirty\(\), settingsBase\(\)\)/);
  const puts = act.match(/put<(Settings|TabLayout|PhoneLayout)>\([^\n]*/g) ?? [];
  assert.equal(puts.length, 3, puts.join("\n"));
  for (const p of puts) assert.match(p, /w\.data|carryUnknown|carryUnknownPhone/, p);
  assert.match(src("views/ListPager.tsx"), /tmPages: \[\.\.\.c\.pages, \.\.\.lost\]/);
  assert.match(src("views/ListPager.tsx"), /export const RESTORE_LOST_PAGES = true;/, "R4 is on");
  assert.match(src("views/ListPager.tsx"), /const panelPageName = \(n: number\) => `Page \$\{n\}`;/, "the name a page made with + gets, nothing else");
});

console.log(`\n${n} passed`);
