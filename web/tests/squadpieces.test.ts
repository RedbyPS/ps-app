// Run: node --experimental-strip-types tests/squadpieces.test.ts
// G Squad pieces (PS 1.65, core/squadpieces.ts + core/tablayout.ts optIn): the registry (which view each piece needs), that every piece
// is a placeable Edit mode panel that is OFF the page by default, the open counter (one chat open for the window and every piece), the
// conversation click rule, and the rows of the leaderboard, tasks done and who is working. Made up names and ids only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../src/core/squadpieces.ts";
import { MAIN_PAGE, SLOTS, addPanel, cleanLayout, drawsBare, emptyLayout, gallery, isOptIn, onPage, kindOf } from "../src/core/tablayout.ts";
import { INTROS } from "../src/core/featureintro.ts";
import type { BoardView } from "../src/core/squadboard.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const AT = "2026-11-17T10:00:00.000Z";
const A = "m-ana", B = "m-ben", C = "m-cleo", D = "m-dev";

ok("the registry: five new pieces plus Squad Priority 1, each names its view and where a click goes", () => {
  assert.deepEqual(P.PIECE_IDS, ["sqchat", "sqconvs", "sqboard", "sqdone", "sqnow"]);
  assert.deepEqual(P.ALL_PIECE_IDS.at(-1), "squadp1");
  for (const p of P.PIECES) { assert.ok(p.needs.length > 0 && p.label && p.opens, p.id); }
  assert.deepEqual(P.pieceOf("sqchat.k3f9a2b1")?.needs, ["squad", "chat"], "a copy is the same piece");
  assert.equal(P.pieceOf("sqboard")?.needs.includes("chat"), false, "the board needs only the squad view");
  assert.equal(P.pieceOf("clocks"), null);
  assert.deepEqual(P.PIECES.filter((p) => p.live).map((p) => p.id), ["sqchat"], "only the chat keeps the chat open");
});

ok("every piece is a Slot of Edit mode, off the page by default, never removable into the tray", () => {
  for (const id of P.PIECE_IDS) {
    const s = SLOTS.find((x) => x.id === id);
    assert.ok(s?.optIn, id);
    assert.ok(isOptIn(id) && !isOptIn(id + ".k3f9a2b1"), id);
    assert.equal(s?.label, P.pieceOf(id)?.label, "one label in both lists");
  }
  const ids = SLOTS.map((s) => s.id);
  assert.ok(ids.indexOf("sqchat") > ids.indexOf("squadp1") && ids.indexOf("sqnow") < ids.indexOf("meetnotes"), "right after Squad Priority 1");
  assert.equal(SLOTS.find((s) => s.id === "squadp1")?.optIn, undefined, "Squad Priority 1 keeps its place on the page");
});

ok("a fresh layout shows none of them; Add panel offers them; adding makes a copy that shows, the original never does", () => {
  const l = emptyLayout();
  const shown = onPage(l, MAIN_PAGE, false);
  for (const id of P.PIECE_IDS) assert.ok(!shown.includes(id), id);
  assert.ok(shown.includes("squadp1"));
  const g = gallery(l, MAIN_PAGE, false, true);
  for (const id of P.PIECE_IDS) { const it = g.find((x) => x.kind === id); assert.ok(it, id); assert.equal(it!.here, 0); assert.equal(it!.removed, false); }
  const r = addPanel(l, "sqchat", MAIN_PAGE, AT, { x: 0.5, y: 0.2, w: 320, h: 380 });
  assert.ok(r.id && r.id !== "sqchat" && kindOf(r.id) === "sqchat");
  assert.ok(onPage(r.layout, MAIN_PAGE, false).includes(r.id!));
  assert.ok(!onPage(r.layout, MAIN_PAGE, false).includes("sqchat"), "the original stays off the page");
  assert.equal(gallery(r.layout, MAIN_PAGE, false, true).find((x) => x.kind === "sqchat")!.here, 1);
  const two = addPanel(r.layout, "sqchat", MAIN_PAGE, AT);
  assert.equal(onPage(two.layout, MAIN_PAGE, false).filter((x) => kindOf(x) === "sqchat").length, 2, "more than one copy is fine");
});

ok("the saved layout keeps the copies and pages checked (an unknown piece or a stray original is dropped)", () => {
  const r = addPanel(addPanel(emptyLayout(), "sqboard", MAIN_PAGE, AT, { x: 0.1, y: 0.1, w: 300, h: 260 }).layout, "sqnow", "pg2abc", AT);
  const c = cleanLayout(JSON.parse(JSON.stringify(r.layout)));
  assert.equal(c.extra?.length, 2);
  assert.deepEqual(cleanLayout({ pos: {}, hidden: [], at: AT, extra: ["sqzzz.abcd1234"] }).extra ?? [], []);
});

ok("the open counter: one open for the window and every chat piece, a close only when the last screen is gone", () => {
  const sent: boolean[] = [];
  const c = P.openCounter((on) => sent.push(on));
  c.add(); c.add(); c.add();
  assert.deepEqual(sent, [true], "three screens, one open");
  c.drop(); c.drop();
  assert.deepEqual(sent, [true], "two gone, one still there");
  c.drop();
  assert.deepEqual(sent, [true, false]);
  c.drop(); c.drop();
  assert.equal(c.n(), 0, "never below zero");
  assert.deepEqual(sent, [true, false], "a stray drop sends nothing");
  c.add();
  assert.deepEqual(sent, [true, false, true], "opens again after");
});

ok("a click on a conversation: with a chat piece on screen it only switches, else it also opens the window", () => {
  assert.equal(P.convClick(true), "switch");
  assert.equal(P.convClick(false), "switch-open");
  assert.equal(P.unreadTotal([{ unread: 2 }, { unread: 0 }, { unread: 3 }, { unread: -1 }]), 5);
});

const board = (): BoardView => ({
  rules: { money: "revenue", show: "exact", currency: "GBP" },
  money: { "1": [
    { member: B, state: "ok", rank: 2, amount: 9000 }, { member: A, state: "ok", rank: 1, amount: 12000 }, { member: D, state: "none", rank: null },
    { member: C, state: "off", rank: null }, { member: "m-e", state: "ok", rank: 3, amount: 9000 }, { member: "m-f", state: "ok", rank: 5, amount: 100 }, { member: "m-g", state: "ok", rank: 6, amount: 50 },
  ], "3": [{ member: C, state: "ok", rank: 1, amount: 1 }], "6": [] },
  tasks: { "7d": [{ member: A, state: "ok", rank: 1, n: 5 }, { member: B, state: "ok", rank: 2, n: 9 }, { member: C, state: "off", rank: null }, { member: D, state: "ok", rank: 3, n: 5 }], month: [], "3m": [] },
  screen: [], days: [], mine: { tz: "UTC", on: true, months: [] }, due: null, loaded: true,
});

ok("leaderboard: money only, last month on top, biggest first, equal amounts share a place, the rest folded into 'more'", () => {
  const r = P.boardRows(board(), 4);
  assert.deepEqual(r.rows.map((x) => x.member), [A, B, "m-e", "m-f"]);
  assert.deepEqual(r.rows.map((x) => x.rank), [1, 2, 2, 4]);
  assert.equal(r.more, 3);
  assert.equal(r.exact, true);
  assert.deepEqual(P.boardRows(null), { rows: [], more: 0, exact: false });
  assert.equal(P.boardRows(board(), 0).rows.length, 1, "never fewer than one row");
  const rank = board(); rank.rules.show = "rank";
  assert.equal(P.boardRows(rank).exact, false, "the 'rank' rule shows places only");
});

ok("tasks done: most first, equal numbers share a place, people who do not share go last, never a made up number", () => {
  const r = P.doneRows(board(), "7d");
  assert.deepEqual(r.rows.map((x) => [x.member, x.n, x.rank]), [[B, 9, 1], [A, 5, 2], [D, 5, 2], [C, 0, null]]);
  assert.equal(r.more, 0);
  assert.deepEqual(P.doneRows(board(), "month").rows, []);
  assert.deepEqual(P.doneRows(undefined, "7d"), { rows: [], more: 0 });
  assert.equal(P.doneShare(0, 9), null);
  assert.equal(P.doneShare(9, 9), 1);
  assert.equal(P.doneShare(1, 1000), 0.04, "never invisible");
});

ok("who is working now: you first, then by name; a member who shares nothing is never shown as not working by guess", () => {
  const w = P.workRows([
    { id: B, name: "Ben", me: false, working: true }, { id: A, name: "Ana", me: true, working: false }, { id: C, name: "Cleo", me: false, working: false },
    { id: D, name: "Dev", me: false, working: true }, { id: "m-x", name: "Xi", me: false, working: undefined as unknown as boolean },
  ]);
  assert.deepEqual(w.working.map((x) => x.id), [B, D]);
  assert.deepEqual(w.rest.map((x) => x.id), [A, C, "m-x"]);
  assert.equal(P.workHeadline(0), "Nobody is working right now");
  assert.equal(P.workHeadline(3), "3 working now");
});

ok("a piece shows only for someone in a squad with the feature on", () => {
  assert.equal(P.pieceShows(true, true), true);
  assert.equal(P.pieceShows(false, true), false);
  assert.equal(P.pieceShows(true, false), false);
});

ok("no keys in a piece: the pieces import the plain views and ops only (the Tab list list rule)", () => {
  const t = src("views/SquadPieces.tsx") + src("core/squadpieces.ts") + src("squad/chathold.ts");
  assert.doesNotMatch(t, /squadcrypto|squadkey|newSecret|sealForSquad|openFromSquad|localStorage|fetch\(|hub\./i);
  assert.match(src("views/SquadPieces.tsx"), /useSquad\(\)/);
  assert.match(src("views/SquadPieces.tsx"), /useChat\(\)/);
  assert.match(src("views/SquadPieces.tsx"), /ChatPanel/, "the chat piece is the window's own chat, one engine");
  assert.match(src("views/GSquadChat.tsx"), /holdChatOpen\(\)/, "the window counts its open too");
  assert.doesNotMatch(src("views/GSquadChat.tsx"), /chatOp\(\{ op: "open", on: false \}\)/, "nothing closes the chat behind a piece's back");
});

ok("the Edit mode core is touched small: the original of a piece is never drawn, copies are", () => {
  const e = src("views/EditMode.tsx");
  assert.match(e, /if \(isOptIn\(id\)\) return false;/);
  assert.match(e, /hidden\.includes\(id\) \|\| isOptIn\(id\)/);
  const tm = src("views/TaskMap.tsx");
  assert.equal(tm.split("<SquadPieceSlots />").length, 2, "once");
  assert.match(tm, /<Slot id="squadp1"><SquadP1Panel \/><\/Slot>\s*\n\s*<Slot id="meetnotes">/, "Squad Priority 1 did not move");
});

ok("feature registry, docs and intro", () => {
  const f = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")).features.find((x: { id: string }) => x.id === P.PIECES_FEATURE);
  assert.ok(f && f.owner === "jan" && f.scope === "shared" && f.since === "1.65" && f.default === "on");
  assert.match(readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8"), /G Squad pieces/);
  const i = INTROS.find((x) => x.id === "gsquad-pieces-165");
  assert.ok(i && i.choice && i.show === "Ok");
  assert.match(src("views/FeatureIntro.tsx"), /"gsquad-pieces-165"/);
});

ok("review fix: a chat piece is live only while the Tab list is on screen", () => {
  const all = { on: true, shown: true, inSquad: true, listShown: true };
  assert.equal(P.chatPieceLive(all), true);
  assert.equal(P.chatPieceLive({ ...all, listShown: false }), false, "a hidden Tab list is not an open chat");
  assert.equal(P.chatPieceLive({ ...all, shown: false }), false);
  assert.equal(P.chatPieceLive({ ...all, inSquad: false }), false);
  assert.equal(P.chatPieceLive({ ...all, on: false }), false);
  const v = src("views/SquadPieces.tsx");
  assert.match(v, /useOverlayShown\(\)/, "the piece asks the real screen state");
  assert.match(v, /chatPieceLive\(\{ on, shown, inSquad: v\.in, listShown \}\)/);
});

ok("review fix: a piece keeps its text and quote per conversation, nothing crosses", () => {
  const k = P.draftKeeper<{ id: string }>();
  // typing in a DM with a quote, then switching to the squad: the squad box is empty
  const squad = k.swap("dm-1", { text: "private words", reply: { id: "x" } }, "squad");
  assert.deepEqual(squad, { text: "", reply: null });
  // typing in the squad, going back to the DM: the DM gets its own draft back
  const dm = k.swap("squad", { text: "hello all", reply: null }, "dm-1");
  assert.deepEqual(dm, { text: "private words", reply: { id: "x" } });
  // and the squad's own draft is still the squad's
  assert.deepEqual(k.swap("dm-1", { text: "", reply: null }, "squad"), { text: "hello all", reply: null });
  assert.equal(k.size(), 1, "an empty box keeps nothing");
  k.clear(); assert.equal(k.size(), 0);
  const c = src("views/GSquadComposer.tsx");
  assert.match(c, /convKey/);
  assert.match(c, /setEditing\(null\); setAbout\(null\)/, "an edit and a note chip stop on a switch");
  const v = src("views/SquadPieces.tsx");
  assert.match(v, /convKey=\{conv\.active\}/, "the piece passes the conversation");
  assert.match(v, /conv\.cur\.title/, "the title is the conversation's");
});

ok("review fix: Conversations is gone with the Signal style switch off, and Tasks done opens Tasks", () => {
  const v = src("views/SquadPieces.tsx");
  assert.match(v, /if \(!on \|\| !v3On\(\)\) return null;/);
  assert.match(v, /v3On\(\) && <Slot id="sqconvs">/, "not offered in the gallery either");
  assert.equal(P.pieceOf("sqdone")?.opens, "tasks");
});

ok("review fix: the window holds the chat open once, backdrop click needs press and release, resize draws once per frame", () => {
  const w = src("views/GSquadWindow.tsx");
  assert.match(w, /holdChatOpen\(\)/);
  assert.match(src("views/GSquadChat.tsx"), /ChatPanel hold=\{false\}/);
  assert.match(w, /bgDown\.current && e\.target === e\.currentTarget/);
  assert.match(w, /onPointerDown=\{\(e\) => \{ bgDown\.current = e\.target === e\.currentTarget/);
  assert.doesNotMatch(w, /move = \(m: PointerEvent\) => \{[^}]*setSize/, "no state write per move");
  assert.match(w, /lostpointercapture/);
});

ok("review fix: FEATURES.md has no merge markers", () => {
  const f = readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8");
  assert.doesNotMatch(f, /^(<<<<<<<|=======$|>>>>>>>)/m);
  assert.match(f, /\| G Squad pieces \|/); assert.match(f, /\| G Squad DMs, groups and pictures \|/); assert.match(f, /\| G Squad Signal style \|/);
});

ok("no em or en dashes in the new files", () => {
  for (const f of ["core/squadpieces.ts", "views/SquadPieces.tsx", "views/squadpieces.css", "squad/chathold.ts"]) assert.doesNotMatch(src(f), /[–—]/, f);
});
ok("quality pass: without Edit mode (the website To-do page, the phone) an opt in original draws nothing, its copies and other panels do", () => {
  for (const id of P.PIECE_IDS) { assert.equal(drawsBare(id), false, id); assert.equal(drawsBare(id + ".k3f9a2b1"), true, id); }
  assert.equal(drawsBare("clocks"), true);
  assert.equal(drawsBare("squadp1"), true);
  assert.match(src("views/EditMode.tsx"), /if \(!c\) return drawsBare\(id\) \? <>\{children\}<\/> : null;/);
});

console.log(`${n} passed`);
