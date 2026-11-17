// Run: node --experimental-strip-types tests/gsquad-v3.test.ts
// G Squad v3 (PS 1.65): Read more, bubble groups, picture fitting, the conversation list, the window size, the money board.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const M = await import("../src/core/gsmsg.ts");
const C = await import("../src/core/gsconv.ts");
const A = await import("../src/core/gsavatar.ts");
const W = await import("../src/core/gswinsize.ts");
const B = await import("../src/core/gsboard.ts");
const G = await import("../src/squad/chatgroups.ts");

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };

// ---------- Read more ----------
await ok("short and just over the line are shown whole", () => {
  assert.deepEqual(M.readMoreCut("hi"), { text: "hi", cut: false });
  const t = "a ".repeat(450);   // 900 characters: not past show + buffer
  assert.equal(M.readMoreCut(t).cut, false);
});
await ok("a long message is cut at a word edge near 800", () => {
  const t = "word ".repeat(400);
  const c = M.readMoreCut(t);
  assert.ok(c.cut && c.text.length <= 800 && c.text.length > 700);
  assert.ok(!c.text.endsWith(" ") && c.text.endsWith("word"));
});
await ok("one huge word is cut where it stands, an emoji is never split", () => {
  const c = M.readMoreCut("x".repeat(2000));
  assert.equal(c.text.length, 800);
  const e = "a".repeat(799) + "😀".repeat(300);
  const d = M.readMoreCut(e);
  assert.ok(d.cut && !/[\ud800-\udbff]$/.test(d.text));
});
await ok("each tap opens 3000 more, then the rest shows", () => {
  const t = "lorem ".repeat(1000);   // 6000
  const s1 = M.moreShown(M.READ_MORE.show);
  assert.equal(s1, 3800);
  assert.equal(M.readMoreCut(t, s1).cut, true);
  assert.equal(M.readMoreCut(t, M.moreShown(s1)).cut, false);
  assert.equal(M.readMoreCut(t, NaN).cut, true);
});

// ---------- bubble groups ----------
await ok("shapes of a group and radii", () => {
  assert.equal(M.bubbleShape(true, true), "solo");
  assert.equal(M.bubbleShape(true, false), "top");
  assert.equal(M.bubbleShape(false, false), "mid");
  assert.equal(M.bubbleShape(false, true), "bottom");
  assert.deepEqual(M.sideRadii("mid"), [4, 4]);
  assert.deepEqual(M.sideRadii("top"), [18, 4]);
  assert.deepEqual(M.sideRadii("bottom"), [4, 18]);
  assert.deepEqual(M.sideRadii("solo"), [18, 18]);
  assert.equal(M.showsAvatar(false, true), true);
  assert.equal(M.showsAvatar(true, true), false);
  assert.equal(M.showsAvatar(false, false), false);
});
await ok("messages group by sender, and a pause starts a new group", () => {
  const L = (id: string, from: string, min: number) => ({ id, from, name: from, mine: from === "me", t: "x", at: new Date(Date.UTC(2026, 10, 16, 10, min)).toISOString(), edited: false, left: false });
  const items = G.groupChat([L("1", "a", 0), L("2", "a", 1), L("3", "a", 30), L("4", "me", 31)]).filter((i) => i.kind === "msg") as { line: { id: string }; first: boolean; last: boolean }[];
  assert.deepEqual(items.map((i) => M.bubbleShape(i.first, i.last)), ["top", "bottom", "solo", "solo"]);
});

// ---------- the picture ----------
await ok("square crop in the middle and never upscaled", () => {
  assert.deepEqual(A.squareCrop(1000, 600), { x: 200, y: 0, side: 600 });
  assert.deepEqual(A.squareCrop(300, 900), { x: 0, y: 300, side: 300 });
  assert.equal(A.squareOut(2000), 256);
  assert.equal(A.squareOut(100), 100);
});
await ok("data url bytes", () => {
  assert.equal(A.dataUrlBytes("data:image/jpeg;base64,QUJD"), 3);
  assert.equal(A.dataUrlBytes("data:image/jpeg;base64,QUI="), 2);
  assert.equal(A.dataUrlBytes("nope"), 0);
  assert.equal(A.isPictureUrl("data:text/html;base64,AAAA"), false);
  assert.equal(A.isPictureUrl("data:image/jpeg;base64,QUJD"), true);
});
await ok("fitPicture steps down until it is under 40 KB", async () => {
  const calls: [number, number][] = [];
  const fake = (bytes: number) => "data:image/jpeg;base64," + "A".repeat(Math.ceil((bytes * 4) / 3));
  const r = await A.fitPicture(1000, async (px, q) => { calls.push([px, q]); return fake(px * px * q * 0.9); });
  assert.ok(r && A.dataUrlBytes(r) <= A.AVATAR_MAX_BYTES);
  assert.ok(calls[0][0] === 256 && calls.every(([p]) => p <= 256));
  assert.equal(await A.fitPicture(500, async () => fake(900000)), null);
});
await ok("letter tones are neutral and stable", () => {
  assert.equal(A.neutralTone("abc"), A.neutralTone("abc"));
  assert.ok(A.neutralTone("zzz") < A.NEUTRAL_TONES.length);
});

// ---------- the list ----------
const cv = (id: string, kind: "squad" | "group" | "dm", at: string | null, unread = 0) => ({ id, kind, title: id, memberIds: [], unread, ...(at ? { last: { text: "x", at, from: "a" } } : {}) });
await ok("newest first, empty last, squad wins a tie", () => {
  const s = C.sortConvs([cv("b", "dm", null), cv("a", "dm", "2026-11-16T09:00:00Z"), cv("squad", "squad", "2026-11-16T08:00:00Z"), cv("c", "group", "2026-11-16T10:00:00Z"), cv("z", "dm", null)]);
  assert.deepEqual(s.map((c) => c.id), ["c", "a", "squad", "b", "z"]);
  assert.equal(C.sortConvs([cv("x", "dm", null), cv("squad", "squad", null)])[0].id, "squad");
});
await ok("today's single chat becomes one conversation, convs are cleaned, the squad is always there", () => {
  const sq = { name: "The G Squad", memberIds: ["1", "2"], unread: 2, last: { text: "hi", at: "2026-11-16T09:00:00Z", from: "Sam" } };
  const one = C.convsFor({}, sq);
  assert.equal(one.length, 1); assert.equal(one[0].id, "squad"); assert.equal(one[0].unread, 2);
  const two = C.convsFor({ convs: [cv("d1", "dm", "2026-11-16T10:00:00Z", 1), { id: 5 }, null, { id: "q", kind: "weird" }] }, sq);
  assert.deepEqual(two.map((c) => c.id), ["d1", "squad"]);
  assert.equal(C.activeOf(two, "d1"), "d1"); assert.equal(C.activeOf(two, "gone"), "squad"); assert.equal(C.activeOf(two, undefined), "squad");
});
await ok("who you can message, and the preview line", () => {
  assert.equal(C.canMessage("a", "me"), true); assert.equal(C.canMessage("me", "me"), false); assert.equal(C.canMessage("", "me"), false);
  const names = (id: string) => (id === "Sam" ? "Sam" : "Someone");
  assert.equal(C.previewLine({ ...cv("d", "dm", "x"), last: { text: "hey  there", at: "", from: "Sam" } }, "Alex", names), "hey there");
  assert.equal(C.previewLine({ ...cv("g", "group", "x"), last: { text: "ok", at: "", from: "Sam" } }, "Alex", names), "Sam: ok");
  assert.equal(C.previewLine({ ...cv("g", "group", "x"), last: { text: "ok", at: "", from: "Alex" } }, "Alex", names), "You: ok");
});

// ---------- the window ----------
await ok("size is kept on screen and remembered", () => {
  assert.deepEqual(W.clampWin({ w: 5000, h: 5000 }, 1440, 900), { w: 1408, h: 868 });
  assert.deepEqual(W.clampWin({ w: 100, h: 100 }, 1440, 900), { w: 640, h: 480 });
  assert.deepEqual(W.clampWin({ w: NaN, h: 700 }, 1440, 900), { w: 1040, h: 700 });
  const mem: Record<string, string> = {};
  const st = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
  assert.deepEqual(W.readWin(st), W.DEFAULT_WIN);
  W.saveWin({ w: 900.4, h: 600 }, st);
  assert.deepEqual(W.readWin(st), { w: 900, h: 600 });
  mem[W.WIN_KEY] = "{broken"; assert.deepEqual(W.readWin(st), W.DEFAULT_WIN);
});
await ok("dragging an edge keeps it centred and inside", () => {
  assert.deepEqual(W.dragWin({ w: 1000, h: 700 }, 50, 0, { x: 1, y: 0 }, 1440, 900), { w: 1100, h: 700 });
  assert.deepEqual(W.dragWin({ w: 1000, h: 700 }, -500, 0, { x: 1, y: 0 }, 1440, 900), { w: 640, h: 700 });
  assert.deepEqual(W.dragWin({ w: 1000, h: 700 }, -30, 40, { x: -1, y: 1 }, 1440, 900), { w: 1060, h: 780 });
  assert.equal(W.floats(false, false), true); assert.equal(W.floats(true, false), false); assert.equal(W.floats(false, true), false);
});

// ---------- the money board ----------
await ok("money ranking: biggest first, equal share a place, not shared then not added last", () => {
  const e = (member: string, state: "ok" | "off" | "none", amount?: number, rank: number | null = null) => ({ member, state, rank, ...(amount !== undefined ? { amount } : {}) });
  const r = B.moneyRows([e("kit", "none"), e("ana", "ok", 500, 9), e("sam", "ok", 900, 9), e("max", "off"), e("lee", "ok", 500, 9)]);
  assert.deepEqual(r.map((x) => x.member), ["sam", "ana", "lee", "max", "kit"].map((m) => m).sort((a, b) => 0) && ["sam", "ana", "lee", "max", "kit"]);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 2, null, null]);
});
await ok("money ranking with ranks only (no amounts) keeps the hub order", () => {
  const r = B.moneyRows([{ member: "b", state: "ok", rank: 2 }, { member: "a", state: "ok", rank: 1 }]);
  assert.deepEqual(r.map((x) => [x.member, x.rank, x.amount]), [["a", 1, null], ["b", 2, null]]);
  assert.equal(B.barShare(null, 10), null); assert.equal(B.barShare(5, 10), 0.5); assert.equal(B.barShare(0, 10), 0.03); assert.equal(B.barShare(5, 0), null);
});

// ---------- source checks ----------
await ok("no dashes, no calling in the new files", () => {
  for (const f of ["core/gsmsg.ts", "core/gsconv.ts", "core/gsavatar.ts", "core/gswinsize.ts", "core/gsboard.ts"]) {
    const s = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.ok(!/[–—]/.test(s), f);
    assert.ok(!/RTCPeerConnection|getUserMedia/.test(s), f);
  }
});
await ok("the feature is registered, has an intro, and the window and chat use the new parts", () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const feats = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")).features;
  const f = feats.find((x: { id: string }) => x.id === "gsquad-v3");
  assert.ok(f && f.default === "on" && f.owner === "jan" && f.since === "1.65");
  assert.match(src("core/featureintro.ts"), /id: "gsquad-v3-165"/);
  assert.match(src("views/FeatureIntro.tsx"), /"gsquad-v3-165"/);
  const w = src("views/GSquadWindow.tsx");
  for (const k of ["useConvs", "ConvRow", "clampWin", "dragWin", "saveWin", "newDm", "GroupCard", "NewGroupCard"]) assert.ok(w.includes(k), k);
  assert.match(src("views/GSquadChat.tsx"), /MsgText/);
  assert.match(src("views/GSquadSettings.tsx"), /PictureEdit/);
  const css = src("views/gssignal3.css");
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /#2267f5/); assert.match(css, /#191919/);
  // the hover buttons never take room: opacity only
  assert.match(css, /\.gc-acts \{[^}]*position: absolute/);
  for (const f2 of ["views/GSquadV3.tsx", "views/gssignal3.css", "views/GSquadWindow.tsx", "views/GSquad.tsx", "views/GSquadBoard.tsx"]) {
    assert.ok(!/[–—]/.test(src(f2)), f2);
    assert.ok(!/RTCPeerConnection|getUserMedia|\bcall(s|ing)?\b.*(button|start)/i.test(src(f2).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")) || f2.endsWith(".css"), f2);
  }
});

// ---------- integration with the data side (jan/gsquad-dm, merged as #30) ----------
const CV = await import("../src/squad/chatview.ts");
const DV = await import("../src/squad/dmview.ts");
const GR = await import("../src/core/gsgroup.ts");
const U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2", U3 = "00000000-0000-4000-8000-0000000000a3";
await ok("the real view keeps convs, activeConv, dm and the member pictures, and the list is built from them", () => {
  const pic = "data:image/jpeg;base64,/9j/AAAA";
  const view = CV.cleanChatView({ ...CV.EMPTY_CHAT, in: true, dm: true, activeConv: "d1",
    convs: [{ id: "squad", kind: "squad", title: "G Squad", memberIds: [U1], unread: 0 }, { id: "d1", kind: "dm", title: "Sam", memberIds: [U1, U2], unread: 3, avatar: U2, last: { text: "hi", at: "2026-11-17T09:00:00Z", from: "Sam" } }],
    members: [{ id: U2, name: "Sam", me: false, left: false, pic }] });
  assert.equal(view.convs?.length, 2); assert.equal(view.activeConv, "d1"); assert.equal(view.dm, true); assert.equal(view.members?.[0].pic, pic);
  const list = C.convsFor({ convs: view.convs }, { name: "G Squad", memberIds: [], unread: 0 });
  assert.deepEqual(list.map((c) => c.id), ["d1", "squad"]);   // newest first
  assert.equal(C.activeOf(list, view.activeConv), "d1");
  assert.equal(C.activeOf(list, "gone-chat"), "squad");        // a chat that left the list falls back to the squad
  assert.equal(CV.EMPTY_CHAT.dm, false);                       // a hub without dm: false, the screen shows no DM or group button
});
await ok("the ops the screen sends are the ones the data side accepts, and bad ones are dropped", () => {
  assert.deepEqual(DV.cleanDmOp({ op: "newDm", memberId: U2 }), { op: "newDm", memberId: U2 });
  assert.deepEqual(DV.cleanDmOp({ op: "newGroup", title: " Gym crew ", memberIds: [U2, U3] }), { op: "newGroup", title: "Gym crew", memberIds: [U2, U3] });
  assert.equal(DV.cleanDmOp({ op: "newGroup", title: "Solo", memberIds: [U2] }), null);   // two or more other people
  assert.deepEqual(DV.cleanDmOp({ op: "groupAdd", id: U3, memberIds: [U1] }), { op: "groupAdd", id: U3, memberIds: [U1] });
  assert.deepEqual(DV.cleanDmOp({ op: "groupRemove", id: U3, memberId: U1 }), { op: "groupRemove", id: U3, memberId: U1 });
  assert.deepEqual(DV.cleanDmOp({ op: "leaveConv", id: U3 }), { op: "leaveConv", id: U3 });
  assert.deepEqual(CV.cleanChatOp({ op: "clearAvatar" }), { op: "clearAvatar" });
  assert.equal(GR.groupTitleOk("   "), false); assert.equal(GR.groupTitleOk("Gym crew"), true);
  assert.equal(GR.GROUP_MIN_OTHERS, 2); assert.equal(GR.GROUP_MAX_OTHERS, 23);
});
await ok("the chat words fit the conversation and the two notes show in the new look", () => {
  assert.match(C.convWords("dm").foot, /two of you/); assert.match(C.convWords("group").empty, /group/); assert.match(C.convWords("squad").foot, /squad/);
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  // the notes are the chat's own error line (a hub or engine note), drawn by the chat panel in every look
  assert.match(src("views/GSquadChat.tsx"), /v\.error && <p className="gs-err"/);
  assert.match(src("squad/chatengine.ts"), /A message was not sent because that chat is gone\./);
  assert.match(src("squad/dmflows.ts"), /You cannot leave a private message\./);
});
await ok("DMs and groups are hidden while the hub has no dm function", () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const w = src("views/GSquadWindow.tsx");
  assert.match(w, /v3 && conv\.dm \? \(m\)/);                    // the Message button on a member
  assert.match(w, /conv\.dm && v\.members\.length > 2/);    // New group
  assert.match(src("views/GSquadV3.tsx"), /dm: chat\.dm === true/);
  assert.match(w, /chatConv\.kind === "group" && <button/);       // the group card only for a group
});
await ok("quality pass: at the newest message the chat stays there when its own height changes (the box grows, the window is resized)", () => {
  assert.equal(M.nearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }), true);
  assert.equal(M.nearBottom({ scrollHeight: 1000, scrollTop: 661, clientHeight: 300 }), true);
  assert.equal(M.nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }), false);
  assert.equal(M.nearBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }), true);   // a short chat is always at the bottom
  const c = readFileSync(new URL("../src/views/GSquadChat.tsx", import.meta.url), "utf8");
  assert.match(c, /new ResizeObserver\(\(\) => \{ if \(atBottom\.current\) el\.scrollTop = el\.scrollHeight; \}\)/);
  assert.match(c, /atBottom\.current = nearBottom\(e\.currentTarget\)/);
});
console.log(`${n} passed`);
