// Run: node --experimental-strip-types tests/keep-my-layout.test.ts
// PS 1.68 (18 Nov 2026): "On every single update it resets my things ... the layout ... the time zones, I have multiple
// screens, multiple checklists, multiple pages. It deletes all of it and moves it all on the main page", and "sometimes
// it's resetting my settings". The reset is reproduced first with a realistic saved setup, then shown fixed:
// - the pages live in the ONE settings record (tmPages), which every device writes whole from its own copy. A device
//   that was closed for a while (the phone, a second Mac) opens after an update, writes one small thing at once (What's
//   new seen) and its old copy of the pages went up with it (core/cardsync.ts mergeSettings kept the whole local copy),
//   so every panel on a page made since fell back to the main page (core/tablayout.ts pageOf);
// - a save never drops what this build cannot show (carryUnknown), a draw before the layout loaded never saves
//   (layoutReady), and the Edit button's spot is taken while editing (keepClear).
// FICTIONAL data only.
import assert from "node:assert/strict";
const S = await import("../src/core/cardsync.ts");
const T = await import("../src/core/tablayout.ts");
const L = await import("../src/core/lists.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const DEFAULTS = { ownerName: "Owner", autoLockMin: 15, autoReset: "off", theme: "system" } as any;
const json = (x: unknown) => JSON.parse(JSON.stringify(x));   // what the vault stores (undefined keys vanish)

// ---------- a realistic setup: several pages, copies of Time zones and checklists, sizes, a panel setting ----------
const pagesNow = [
  { id: "work2026a", name: "Work", secs: ["g:chk1aaaa"] },
  { id: "pnl0clock", name: "Clocks", secs: [], kind: "panels" },
  { id: "pnl0squad", name: "Squad", secs: [], kind: "panels" },
];
const mac = {
  ...DEFAULTS, autoReset: "midnight", theme: "dark", ownerName: "Alex",
  tmPages: pagesNow, tmPageOrder: ["main", "work2026a", "pnl0clock", "pnl0squad"],
  tmGroups: [{ id: "chk1aaaa", name: "Morning checklist" }], whatsNewSeen: "1.66",
} as any;
const layout = T.cleanLayout({
  at: "2026-11-17T10:00:00.000Z",
  pos: { clocks: { x: 0.1, y: 0.2, w: 320, h: 180 }, "clocks.k3f9a2b1": { x: 0.6, y: 0.1, w: 300, h: 170 }, "sleep.zz11aa22": { x: 0.9, y: 0.9, w: 60, h: 60 } },
  hidden: ["screentime"],
  extra: ["clocks.k3f9a2b1", "clocks.q8w7e6r5", "sqchat.c4h5a6t7", "sleep.zz11aa22"],
  page: { "clocks.k3f9a2b1": "pnl0clock", "clocks.q8w7e6r5": "pnl0clock", "sqchat.c4h5a6t7": "pnl0squad", dimx: "work2026a", "sleep.zz11aa22": "pnl0clock" },
  size: { "clocks.k3f9a2b1": 1.4, "sleep.zz11aa22": 0.8 },
  cfg: { "clocks.k3f9a2b1": { open: true }, clocks: { open: true } },
});
const pageSet = (st: any) => new Set(L.pageOrder(st.tmPageOrder, L.cleanPages(st.tmPages)));
const where = (st: any) => Object.fromEntries([...pageSet(st)].map((p) => [p, T.onPage(layout, p, false, pageSet(st))]));

// The phone (or a second Mac) last synced before the pages were made: its copy has the old settings.
const phoneCopy = { ...DEFAULTS, ownerName: "Alex", autoReset: "midnight", theme: "dark", whatsNewSeen: "1.66" } as any;

ok("the reset, reproduced: the phone's What's new write after an update used to send its old pages over the Mac's", () => {
  const before = where(mac);
  assert.deepEqual(before.pnl0clock.sort(), ["clocks.k3f9a2b1", "clocks.q8w7e6r5", "sleep.zz11aa22"].sort());
  const w = S.settingsWrite(phoneCopy, { whatsNewSeen: "1.68" } as any, DEFAULTS);
  // The old merge (no list of what changed): the phone's whole copy wins.
  const sent = json(S.mergeSettings(w.data, mac));
  const after = where(sent);
  assert.deepEqual(Object.keys(after), ["main"]);   // every page gone ...
  for (const id of ["clocks.k3f9a2b1", "clocks.q8w7e6r5", "sqchat.c4h5a6t7", "sleep.zz11aa22", "dimx"]) assert.ok(after.main.includes(id), id);   // ... and all of it on the main page
});
ok("fixed: only what the phone changed comes from its copy, the pages and every panel stay where they were", () => {
  const w = S.settingsWrite(phoneCopy, { whatsNewSeen: "1.68" } as any, DEFAULTS);
  assert.deepEqual(w.changed, ["whatsNewSeen"]);
  const sent = json(S.mergeSettings(w.data, mac, new Set(w.changed)));
  assert.deepEqual(where(sent), where(mac));
  assert.deepEqual(sent.tmPages, mac.tmPages);
  assert.deepEqual(sent.tmPageOrder, mac.tmPageOrder);
  assert.equal(sent.whatsNewSeen, "1.68");
});

// ---------- settings: an update never puts a choice back ----------
ok("settings: a choice made on the Mac survives the phone's small write; the phone's own change still goes up", () => {
  const server = { ...mac, autoReset: "midnight", theme: "dark", tmScale: 90 };
  const old = { ...DEFAULTS, ownerName: "Alex", tmScale: 100 } as any;   // the phone's copy from before those choices
  const w = S.settingsWrite(old, { tipsSeen: { edit: 1 }, swipeInvert: true } as any, DEFAULTS);
  const sent = json(S.mergeSettings(w.data, server, new Set(w.changed)));
  assert.equal(sent.autoReset, "midnight"); assert.equal(sent.theme, "dark"); assert.equal(sent.tmScale, 90);
  assert.deepEqual(sent.tipsSeen, { edit: 1 }); assert.equal(sent.swipeInvert, true);
});
ok("settings: a value written the same as before is no change, so the other device's newer value of it wins", () => {
  const w = S.settingsWrite({ ...DEFAULTS, tmScale: 100 } as any, { tmScale: 100 } as any, DEFAULTS);
  assert.deepEqual(w.changed, []);
  assert.equal(S.mergeSettings(w.data, { ...DEFAULTS, tmScale: 80 } as any, new Set(w.changed)).tmScale, 80);
});
ok("settings: taking a setting away (undefined) still takes it away on the other device's copy", () => {
  const w = S.settingsWrite({ ...DEFAULTS, workingOn: "t1" } as any, { workingOn: undefined } as any, DEFAULTS);
  assert.deepEqual(w.changed, ["workingOn"]);
  const sent = json(S.mergeSettings(json(w.data), { ...DEFAULTS, workingOn: "t1", tmScale: 80 } as any, new Set(w.changed)));
  assert.equal("workingOn" in sent, false); assert.equal(sent.tmScale, 80);
});
ok("settings: the same setting changed on both: this device's unsent change wins, as before", () => {
  const w = S.settingsWrite({ ...DEFAULTS, tmScale: 100 } as any, { tmScale: 120 } as any, DEFAULTS);
  assert.equal(S.mergeSettings(w.data, { ...DEFAULTS, tmScale: 80 } as any, new Set(w.changed)).tmScale, 120);
});
ok("settings: the card merges still join both copies with the list of changes", () => {
  const a = { ...DEFAULTS, chatDone: [{ id: "chatA", chat: "Fictional chat", at: "2026-11-18T10:00:00.000Z" }] } as any;
  const b = { ...DEFAULTS, chatDone: [{ id: "chatB", chat: "Another chat", at: "2026-11-18T10:05:00.000Z" }] } as any;
  const sent = S.mergeSettings(a, b, new Set(["tmScale"]));
  assert.equal(sent.chatDone!.length, 2);
});
ok("settings: no record here yet (the first download ran past its wait): only the change is written, never the defaults", () => {
  const w = S.settingsWrite(null, { whatsNewSeen: "1.68" } as any, DEFAULTS, false);
  assert.deepEqual(json(w.data), { whatsNewSeen: "1.68" });
  // The account's real record arrives; two records fold by time, the newer one's keys win (core/select.ts settings).
  const folded = Object.assign({}, mac, w.data);
  assert.equal(folded.autoReset, "midnight"); assert.equal(folded.theme, "dark"); assert.equal(folded.ownerName, "Alex");
  assert.deepEqual(folded.tmPages, mac.tmPages);
  // The old write put the defaults in that record, and they won over the real choices.
  const oldWay = Object.assign({}, mac, { ...DEFAULTS, whatsNewSeen: "1.68" });
  assert.equal(oldWay.autoReset, "off"); assert.equal(oldWay.theme, "system");
});
ok("settings: a really new account (download done, no record) still starts from the defaults", () => {
  const w = S.settingsWrite(undefined, { tmScale: 90 } as any, DEFAULTS, true);
  assert.deepEqual(json(w.data), { ...DEFAULTS, tmScale: 90 });
});

// ---------- the layout record: never drops what this build cannot show ----------
const stored = {
  at: "2026-11-17T10:00:00.000Z",
  pos: { "clocks.k3f9a2b1": { x: 0.6, y: 0.1, w: 300, h: 170 }, "hologram.ab12cd34": { x: 0.3, y: 0.4, w: 200, h: 100 }, oldpanel: { x: 0.5, y: 0.5, w: 90, h: 40 } },
  hidden: ["screentime", "oldtimer"],
  extra: ["clocks.k3f9a2b1", "hologram.ab12cd34", "campaigns.cc11dd22"],
  page: { "clocks.k3f9a2b1": "pnl0clock", "hologram.ab12cd34": "pnl0clock", "campaigns.cc11dd22": "pnl0squad" },
  size: { "hologram.ab12cd34": 1.5 },
  cfg: { "clocks.k3f9a2b1": { open: true, zoneSort: "east" }, "hologram.ab12cd34": { glow: 3 } },
};
ok("an older or newer record reads exactly as before: what this build knows is drawn where it was", () => {
  const c = T.cleanLayout(stored);
  assert.deepEqual(c.extra, ["clocks.k3f9a2b1"]);   // a kind this build does not know, or switched off here (campaigns), is not drawn
  assert.equal(T.pageOf(c, "clocks.k3f9a2b1"), "pnl0clock");
  assert.deepEqual(T.cfgOf(c, "clocks.k3f9a2b1"), { open: true });
});
ok("a save from this build keeps every copy, place, page, size, removed panel and setting it cannot show", () => {
  const moved = T.moveSlot(T.cleanLayout(stored), "clocks.k3f9a2b1", { x: 0.7, y: 0.1, w: 300, h: 170 }, "2026-11-18T09:00:00.000Z");
  const out = json(T.carryUnknown(stored, moved));
  assert.deepEqual(out.extra, ["clocks.k3f9a2b1", "hologram.ab12cd34", "campaigns.cc11dd22"]);
  assert.deepEqual(out.pos["hologram.ab12cd34"], stored.pos["hologram.ab12cd34"]);
  assert.deepEqual(out.pos.oldpanel, stored.pos.oldpanel);
  assert.equal(out.pos["clocks.k3f9a2b1"].x, 0.7);   // this build's own change
  assert.deepEqual([...out.hidden].sort(), ["oldtimer", "screentime"]);
  assert.equal(out.page["hologram.ab12cd34"], "pnl0clock"); assert.equal(out.page["campaigns.cc11dd22"], "pnl0squad");
  assert.equal(out.size["hologram.ab12cd34"], 1.5);
  assert.deepEqual(out.cfg["hologram.ab12cd34"], { glow: 3 });
  assert.deepEqual(out.cfg["clocks.k3f9a2b1"], { zoneSort: "east", open: true });
  // What is drawn is only this build's part, exactly as without the carry.
  assert.ok(T.sameLayout(T.cleanLayout(out), moved));
  // And the newer build reading it back gets its own things back untouched (it knows "hologram" here as an unknown, so check the raw record).
  const canon = (v: any): any => Array.isArray(v) ? [...v].map(canon).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const again = json(T.carryUnknown(out, T.cleanLayout(out)));
  assert.deepEqual(canon(again), canon(out));   // a second save changes nothing
});
ok("a copy this build removed stays removed (only what it cannot show is carried)", () => {
  const removed = T.removeCopy(T.cleanLayout(stored), "clocks.k3f9a2b1", "2026-11-18T09:00:00.000Z");
  const out = T.carryUnknown(stored, removed);
  assert.equal(out.extra!.includes("clocks.k3f9a2b1"), false);
  assert.equal(out.page?.["clocks.k3f9a2b1"], undefined);
  assert.equal(out.cfg?.["clocks.k3f9a2b1"], undefined);
});
ok("a record with nothing unknown goes through unchanged", () => {
  const out = T.carryUnknown(layout, layout);
  assert.deepEqual(json(out), json(layout));
  const pre155 = { pos: { clocks: { x: 0.2, y: 0.3, w: 300, h: 160 } }, hidden: ["afk"], at: "2026-10-01T10:00:00.000Z" };
  assert.deepEqual(json(T.carryUnknown(pre155, T.cleanLayout(pre155))), pre155);
});
ok("junk in the saved record is never carried (bad ids, bad places, big values)", () => {
  const junk = { pos: { "Bad Id": { x: 0.5, y: 0.5, w: 10, h: 10 }, "zz.ab12cd34": { x: "a", y: 0, w: 1, h: 1 } }, extra: ["zz.ab12cd34", 42, "<script>.x"], cfg: { "zz.ab12cd34": { k: "x".repeat(500), ok: true, o: { deep: 1 } } }, hidden: [7] };
  const out = json(T.carryUnknown(junk, T.emptyLayout()));
  assert.deepEqual(out.extra, ["zz.ab12cd34"]);
  assert.deepEqual(out.pos, {});
  assert.deepEqual(out.cfg, { "zz.ab12cd34": { ok: true } });
  assert.deepEqual(out.hidden, []);
});

// ---------- a draw before everything has loaded never saves ----------
ok("layoutReady: only once the vault is open and its first download (or offline copy) is in", () => {
  assert.equal(T.layoutReady(false, null), false);
  assert.equal(T.layoutReady(false, "2026-11-18T09:00:00.000Z"), false);
  assert.equal(T.layoutReady(true, null), false);
  assert.equal(T.layoutReady(true, "2026-11-18T09:00:00.000Z"), true);
});

// ---------- the Edit button's spot is taken while editing ----------
const btn = { left: 24, top: 20, width: 70, height: 32 };
ok("keepClear: a panel dropped on the Edit button is pushed off it, the short way, and stays on screen", () => {
  const r = T.keepClear({ left: 30, top: 24, width: 200, height: 120 }, btn, 1440, 900);
  const hit = r.left < 24 + 70 + T.KEEP_CLEAR_GAP && r.top < 20 + 32 + T.KEEP_CLEAR_GAP;
  assert.equal(hit, false);
  assert.deepEqual(r, { left: 30, top: 60, width: 200, height: 120 });   // below it is the shorter way here
  const side = T.keepClear({ left: 60, top: 12, width: 80, height: 300 }, btn, 1440, 900);
  assert.deepEqual(side, { left: 102, top: 12, width: 80, height: 300 });   // to its right is shorter for a tall panel
});
ok("keepClear: a panel clear of it, or no button, is left where it is", () => {
  const r = { left: 400, top: 300, width: 200, height: 120 };
  assert.deepEqual(T.keepClear(r, btn, 1440, 900), r);
  assert.deepEqual(T.keepClear({ left: 30, top: 24, width: 200, height: 120 }, null, 1440, 900), { left: 30, top: 24, width: 200, height: 120 });
});
ok("keepClear: on a tiny screen it still ends on screen and off the button where it can", () => {
  const r = T.keepClear({ left: 12, top: 12, width: 300, height: 200 }, btn, 400, 300);
  assert.ok(r.left >= T.EDGE && r.top >= T.EDGE && r.left + r.width <= 400 - T.EDGE + 0.001 && r.top + r.height <= 300 - T.EDGE + 0.001);
});

console.log(`${n} passed`);
