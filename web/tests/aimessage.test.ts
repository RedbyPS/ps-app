// Run: node --experimental-strip-types tests/aimessage.test.ts
// Messages from AIs on the island (V1.58, src/core/aimessage.ts), with FICTIONAL chats: no double pop up (a chat that
// sent a message has no plain finished card as well, a chat that sent none keeps it), the three choices, Dismiss and
// Remind me in on every device, Do Not Disturb, the merger, the island's private line, and where it is wired in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const A = await import("../src/core/aimessage.ts");
const C = await import("../src/core/chatdone.ts");
const I = await import("../src/core/island.ts");
const { mergeSettings } = await import("../src/core/cardsync.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const now = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SID = "43eece02-c43a-4a02-8e1d-2619fc41f9cf", SID2 = "9b1f1d2a-1111-4222-8333-944455556666", TID = "0199aa00-bbbb-7ccc-8ddd-eeeeffff0000";
const chat = (id: string, agoMin: number, x: Record<string, unknown> = {}) => ({ id, chat: "Fictional " + id.slice(0, 4), at: iso(now - agoMin * 60_000), ...x });
const msg = (id: string, agoMin: number, x: Record<string, unknown> = {}) => ({ id, from: "Claude Code", text: "Fixed the fictional bug", at: iso(now - agoMin * 60_000), ...x });
const src = (p: string) => readFileSync(p, "utf8");

// ---------- no double pop up ----------
ok("a chat that sent a message just before it finished has no plain card; the message shows", () => {
  const st = { chatDone: [chat(SID, 1)], aiMsgs: [msg("m1", 1.2, { chat: SID })] };
  const r = A.aiCardsNow(st, now);
  assert.equal(r.chats.length, 0);
  assert.equal(r.msgs.length, 1);
  assert.equal(r.msgs[0].id, "c:msg-m1");
  assert.equal(r.msgs[0].fresh, true);
});
ok("a chat that sent no message keeps its plain card, beside another chat's message", () => {
  const st = { chatDone: [chat(SID, 1), chat(SID2, 2)], aiMsgs: [msg("m1", 1, { chat: SID })] };
  const r = A.aiCardsNow(st, now);
  assert.deepEqual(r.chats.map((c) => c.id), [`c:${SID2}`]);
  assert.equal(r.msgs.length, 1);
});
ok("a message with no chat id never hides a plain card (it cannot say which chat it is)", () => {
  const r = A.aiCardsNow({ chatDone: [chat(SID, 1)], aiMsgs: [msg("m1", 1)] }, now);
  assert.equal(r.chats.length, 1);
  assert.equal(r.msgs.length, 1);
});
ok("the message arriving a moment after the plain card takes its place", () => {
  assert.equal(A.aiCardsNow({ chatDone: [chat(SID, 2)], aiMsgs: [msg("m1", 1, { chat: SID })] }, now).chats.length, 0);
});
ok("an old message from the same chat (an earlier turn) does not hide a new finish", () => {
  const r = A.aiCardsNow({ chatDone: [chat(SID, 1)], aiMsgs: [msg("m1", 1 + 11, { chat: SID })] }, now);
  assert.equal(r.chats.length, 1, "11 minutes before the finish: another turn");
  const late = A.aiCardsNow({ chatDone: [chat(SID, 10)], aiMsgs: [msg("m1", 6, { chat: SID })] }, now);
  assert.equal(late.chats.length, 1, "4 minutes after the finish: no longer this one");
});
ok("a finish folded in later (the chat woke by itself) still counts as this message's", () => {
  const r = A.aiCardsNow({ chatDone: [chat(SID, 30, { last: iso(now - 60_000) })], aiMsgs: [msg("m1", 1.5, { chat: SID })] }, now);
  assert.equal(r.chats.length, 0);
});
ok("Codex and other tools: their chat is kept as <tool>-<id>, and the message's plain id still matches", () => {
  const d = C.chatDoneFrom({ id: TID, chat: "proj", at: iso(now - 60_000), tool: "codex" })!;
  assert.ok(d.id.startsWith("codex-") && d.id.length === 36);
  assert.equal(A.sameChat(d, TID), true);
  assert.equal(A.sameChat(d, SID), false);
  assert.equal(A.aiCardsNow({ chatDone: [d], aiMsgs: [msg("m1", 1.1, { chat: TID, from: "Codex" })] }, now).chats.length, 0);
});
ok("a dismissed message still keeps the plain card away (it would be the same news again)", () => {
  const r = A.aiCardsNow({ chatDone: [chat(SID, 1)], aiMsgs: [msg("m1", 1, { chat: SID, seen: true })] }, now);
  assert.equal(r.chats.length, 0);
  assert.equal(r.msgs.length, 0);
});

// ---------- the three choices ----------
ok("AI messages is the default; anything unknown is too", () => {
  assert.equal(A.aiNotesMode(undefined), "messages");
  assert.equal(A.aiNotesMode("bogus"), "messages");
  assert.deepEqual(A.AI_NOTES.map((x) => x.id), ["messages", "plain", "off"]);
});
ok("Plain finished cards: every plain card shows, no message does", () => {
  const r = A.aiCardsNow({ aiNotes: "plain", chatDone: [chat(SID, 1)], aiMsgs: [msg("m1", 1, { chat: SID })] }, now);
  assert.equal(r.chats.length, 1);
  assert.equal(r.msgs.length, 0);
});
ok("Off: nothing at all", () => {
  const r = A.aiCardsNow({ aiNotes: "off", chatDone: [chat(SID, 1), chat(SID2, 1)], aiMsgs: [msg("m1", 1)] }, now);
  assert.equal(r.chats.length + r.msgs.length, 0);
});

// ---------- Dismiss, Remind me in, the list ----------
ok("Dismiss and Remind me in on a message; the timer knows when it comes back", () => {
  const l = [msg("m1", 1)];
  assert.equal(A.aiMsgAnswer(l, "c:msg-nope", "dismiss", now), null);
  const gone = A.aiMsgAnswer(l, "c:msg-m1", "dismiss", now)!;
  assert.equal(A.aiCardsNow({ aiMsgs: gone }, now).msgs.length, 0);
  const later = A.aiMsgAnswer(l, "c:msg-m1", 2, now)!;
  assert.equal(A.aiCardsNow({ aiMsgs: later }, now).msgs.length, 0);
  assert.equal(A.nextAiMsgRemind(later, now), now + 2 * 60_000);
  const back = A.aiCardsNow({ aiMsgs: later }, now + 2 * 60_000 + 1).msgs;
  assert.equal(back.length, 1);
  assert.equal(back[0].fresh, true, "coming back chimes");
  assert.equal(A.nextAiMsgRemind(A.aiMsgAnswer(l, "c:msg-m1", 999, now)!, now), now + 240 * 60_000, "4 hours at most");
});
ok("a message card id is a chat card id (c:), so Do Not Disturb, the island and the phone treat it as an AI chat", () => {
  assert.ok(A.aiMsgCardId({ id: "abcdefghijkl" }).startsWith("c:msg-"));
  assert.ok(A.aiMsgCardId({ id: "abcdefghijkl" }).length <= 40);
  assert.equal(A.isAiMsgCard("c:msg-x"), true);
  assert.equal(A.isAiMsgCard(`c:${SID}`), false);
  assert.equal(A.isAiMsgCard("c:codex-123"), false);
});
ok("a message goes after 3 hours, and Do Not Disturb's quiet stretch does not count", () => {
  assert.equal(A.aiCardsNow({ aiMsgs: [msg("m1", 181)] }, now).msgs.length, 0);
  const dnd = { on: true, since: iso(now - 200 * 60_000), mute: { chats: true } };
  assert.equal(A.aiCardsNow({ aiMsgs: [msg("m1", 181)], dnd } as never, now).msgs.length, 1);
});
ok("the list: newest first, at most 20, old ones dropped", () => {
  let l: ReturnType<typeof A.addAiMsg> = [];
  for (let i = 0; i < 25; i++) l = A.addAiMsg(l, msg(`m${i}`, 25 - i) as never, now);
  assert.equal(l.length, A.AI_MSG.keep);
  assert.equal(l[0].id, "m24");
  assert.equal(A.addAiMsg([msg("old", 200)] as never, msg("new", 0) as never, now).length, 1);
});
ok("the rate: 10 in 10 minutes, then a wait until the oldest of them is 10 minutes old", () => {
  const l = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 9 - i * 0.5));
  assert.equal(A.aiMsgWait(l.slice(0, 9), now), 0);
  assert.equal(A.aiMsgWait(l, now), 60);
  assert.equal(A.aiMsgWait(l, now + 61_000), 0);
});
ok("the same message sent again within 2 minutes is the one kept; another chat's or later is new", () => {
  const l = [msg("m1", 1, { chat: SID })];
  const m = { from: "Claude Code", text: "Fixed the fictional bug", chat: SID };
  assert.equal(A.sameAiMsg(l, m, now)?.id, "m1");
  assert.equal(A.sameAiMsg(l, { ...m, chat: SID2 }, now), null);
  assert.equal(A.sameAiMsg(l, m, now + 2 * 60_000), null);
});
ok("checking: plain text, marks out, limits refused not cut", () => {
  const r = A.checkAiMsg({ text: "a\tb\n c", from: "", detail: "x\n\n\n\ny", chat: "ab c$1" });
  assert.ok("msg" in r);
  if ("msg" in r) { assert.equal(r.msg.text, "a b c"); assert.equal(r.msg.from, "AI"); assert.equal(r.msg.detail, "x\n\ny"); assert.equal(r.msg.chat, "abc1"); }
  const long = A.checkAiMsg({ text: "x".repeat(201) });
  assert.ok("field" in long && long.field === "text");
});
ok("two devices: one entry per message, a Dismiss on either holds, the later remind wins", () => {
  const a = [msg("m1", 1, { seen: true }), msg("m2", 2)], b = [msg("m1", 1), msg("m2", 2, { remindAt: iso(now + 60_000) }), msg("m3", 3)];
  const out = A.mergeAiMsgs(a as never, b as never)!;
  assert.deepEqual(out.map((x) => x.id), ["m1", "m2", "m3"]);
  assert.equal(out[0].seen, true);
  assert.equal(out[1].remindAt, iso(now + 60_000));
  const st = mergeSettings({ aiMsgs: a } as never, { aiMsgs: b } as never);
  assert.equal(st.aiMsgs?.length, 3, "the settings merger joins them too");
  assert.equal(A.mergeAiMsgs(undefined, b as never), b);
});

// ---------- the island ----------
ok("the island pops with the message; private mode shows only 'A message from an AI'", () => {
  const base = { todos: [], today: "2026-11-13", mail: 0, leads: 0 };
  const ev = { id: "c:msg-m1", kind: "chat" as const, title: "Fixed the fictional bug", sub: "Claude Code", url: "", privTitle: A.AI_MSG_PRIVATE };
  const open = I.islandState({ ...base, settings: {} as never, event: ev });
  assert.equal(open.event?.title, "Fixed the fictional bug");
  assert.ok(!("privTitle" in (open.event as object)), "the Mac never gets privTitle");
  const priv = I.islandState({ ...base, settings: { privateMode: true } as never, event: ev });
  assert.equal(priv.event?.title, "A message from an AI");
  assert.equal(priv.event?.sub, "");
  const plain = I.islandState({ ...base, settings: { privateMode: true } as never, event: { ...ev, privTitle: undefined } });
  assert.equal(plain.event?.title, "A Claude chat finished", "other cards keep their line");
});

// ---------- wired in ----------
ok("the cards, the island and Settings use it; no dashes in any words", () => {
  const mail = src("src/mailcards.ts"), isl = src("src/island.ts"), api = src("src/views/TaskApi.tsx"), set = src("src/views/SettingsGroups.tsx"), view = src("src/views/AiMessage.tsx");
  assert.ok(mail.includes("aiCardsNow(st, now)") && mail.includes('tone: "ai"') && mail.includes("aiMsgAnswer(") && mail.includes("nextAiMsgRemind(st.aiMsgs)"));
  assert.ok(isl.includes("aiCardsNow(st, now)") && isl.includes("privTitle: AI_MSG_PRIVATE"));
  assert.ok(!mail.includes("chatDoneCards(st.chatDone"), "every plain card goes through the no double pop up rule");
  assert.ok(api.includes("<ConnectAi ") && set.includes("<AiNotesChoice />"));
  assert.ok(view.includes("ChatGPT or Claude in a browser or the phone app cannot reach it, because the API only listens on this Mac."));
  for (const t of [src("src/core/aimessage.ts"), view]) assert.ok(!/[–—]/.test(t), "no en or em dashes");
});

// ---------- PS 1.74: a message tied to a task, and its Mark done ----------
ok("checkAiMsg: task is optional, kept as sent, refused when it is not a task id", () => {
  const r = A.checkAiMsg({ text: "Send the invoice", task: "abc-123" });
  assert.ok("msg" in r && r.msg.task === "abc-123");
  for (const t of [undefined, null, ""]) { const x = A.checkAiMsg({ text: "a", task: t }); assert.ok("msg" in x && !("task" in x.msg), String(t)); }
  for (const t of [5, "has space", "x".repeat(65), {}, "<b>"]) { const x = A.checkAiMsg({ text: "a", task: t }); assert.ok("field" in x && x.field === "task", JSON.stringify(t)); }
  assert.ok((A.AI_MSG_FIELDS as readonly string[]).includes("task"));
});
ok("markDoneOk: an open task only; on the Mac the done switch and the task's reach, on the phone the send time check", () => {
  const on = { done: true, inbox: true, lists: false };
  assert.equal(A.markDoneOk({ done: false, aiInbox: true }, on), true);
  assert.equal(A.markDoneOk({ done: false }, on), false, "a list task needs All lists");
  assert.equal(A.markDoneOk({ done: false }, { ...on, lists: true }), true);
  assert.equal(A.markDoneOk({ done: false, aiInbox: true }, { ...on, done: false }), false, "the done switch turned off after the message");
  assert.equal(A.markDoneOk({ done: true, aiInbox: true }, on), false, "already ticked");
  assert.equal(A.markDoneOk({ done: false, aiInbox: true, clearedAt: "2026-11-13T00:00:00Z" }, on), false, "cleared by a reset");
  assert.equal(A.markDoneOk(null, on), false, "deleted");
  assert.equal(A.markDoneOk({ done: false }, null), true, "the phone: no switches here");
  assert.equal(A.markDoneOk(undefined, null), false);
});
ok("markDoneFor (break-it 1.74): a dismissed message never ticks, so a late phone tap cannot re-tick a task reopened since", () => {
  const open = { done: false, aiInbox: true };
  assert.equal(A.markDoneFor({ task: "t1" }, open, null), true);
  assert.equal(A.markDoneFor({ task: "t1", seen: true }, open, null), false, "dismissed (the Mac's Mark done already ran)");
  assert.equal(A.markDoneFor({ task: "t1", seen: true }, open, { done: true, inbox: true, lists: true }), false);
  assert.equal(A.markDoneFor({}, open, null), false, "no task on the message");
  assert.equal(A.markDoneFor(null, open, null), false, "message gone");
  assert.equal(A.markDoneFor({ task: "t1" }, { ...open, done: true }, null), false);
  // mailcards.ts apply() uses it for every Mark done.
  const mc = readFileSync(new URL("../src/mailcards.ts", import.meta.url), "utf8");
  assert.ok(/markDoneFor\(m, todoIn\(s, m\.task\), doneScopes\(\)\)/.test(mc));
});
ok("tapFresh (break-it 1.74): a phone tap waits for the second new copy after it (the first may be a fetch already running), then is applied", () => {
  const w = A.tapWait(1000, "2026-11-21T09:59:00.000Z");
  assert.deepEqual(A.tapFresh(w, "2026-11-21T09:59:00.000Z"), { fresh: false, fetch: false }, "the stored copy");
  assert.deepEqual(A.tapFresh(w, "2026-11-21T10:00:01.000Z"), { fresh: false, fetch: true }, "a fetch that may have started before the tap: ask again");
  assert.deepEqual(A.tapFresh(w, "2026-11-21T10:00:01.000Z"), { fresh: false, fetch: false }, "no new copy yet, asked once only");
  assert.deepEqual(A.tapFresh(w, "2026-11-21T10:00:02.000Z"), { fresh: true, fetch: false });
  // Unlock shows the stored copy first (its own lastSync, maybe from a clock that was fast): that is only the first.
  const u = A.tapWait(1000, null);
  assert.equal(A.tapFresh(u, "2027-01-01T00:00:00.000Z").fresh, false);
  assert.equal(A.tapFresh(u, null).fresh, false);
  assert.equal(A.tapFresh(u, "2026-11-21T10:00:05.000Z").fresh, true);
  assert.equal(A.MARK_DONE_WAIT_MS, 600_000);
  // Wired: the phone fetches at once, holds the tap (apply false keeps it in waiting), asks for the second fetch, drops it
  // after the wait, all before any card poke or tick; local mode does not wait.
  const mc = readFileSync(new URL("../src/mailcards.ts", import.meta.url), "utf8");
  assert.ok(mc.includes('if (DEVICE === "phone") void syncVault();'));
  assert.ok(mc.includes('if (tap && DEVICE === "phone" && !s.local && action === AI_MSG_DONE.action) {'));
  assert.ok(mc.includes("if (f.fetch) void syncVault();") && mc.includes("if (!f.fresh) return false;"));
  assert.ok(mc.includes("if (Date.now() - tap.at > MARK_DONE_WAIT_MS) return true;"));
  assert.ok(mc.includes("w.forEach((a) => { if (!apply(a.id, a.action, a.tap)) waiting.push(a); });"), "a held tap stays queued");
  const ap = mc.slice(mc.indexOf("function apply("));
  assert.ok(ap.indexOf("if (!f.fresh) return false;") < ap.indexOf("pokeCardsAfterSave();"), "no card poke while it waits");
  assert.ok(ap.indexOf("if (!f.fresh) return false;") < ap.indexOf("markDoneFor(m, todoIn(s, m.task)"), "checked before any tick");
});
ok("the card carries the task; the same words for another task are another message; a merge keeps it", () => {
  const st = { aiMsgs: [msg("m1", 1, { task: "t1" })] };
  assert.equal(A.aiCardsNow(st, now).msgs[0].task, "t1");
  assert.equal(A.aiMsgOfCard(st.aiMsgs, A.aiMsgCardId({ id: "m1" }))?.task, "t1");
  assert.equal(A.aiMsgOfCard(st.aiMsgs, "c:msg-nope"), null);
  const m = { from: "Claude Code", text: "Fixed the fictional bug" };
  assert.ok(A.sameAiMsg(st.aiMsgs, { ...m, task: "t1" }, now));
  assert.equal(A.sameAiMsg(st.aiMsgs, { ...m, task: "t2" }, now), null);
  assert.equal(A.sameAiMsg(st.aiMsgs, m, now), null);
  const merged = A.mergeAiMsgs([msg("m1", 1, { task: "t1", seen: true })], st.aiMsgs)!;
  assert.deepEqual([merged[0].task, merged[0].seen], ["t1", true]);
});
ok("Mark done is wired in: the card asks markDoneOk, the click checks again, ticks, then dismisses; the Mac passes its switches", () => {
  const mc = src("src/mailcards.ts"), ps = src("src/ps.ts");
  assert.ok(mc.includes("markDoneOk(todoIn(s, c.task), doneScopes())") && mc.includes("{ markDone: true }"));
  assert.ok(mc.includes("action === AI_MSG_DONE.action") && mc.includes("setTodoDone(task, true).then"));
  assert.ok(/startMailCards\(psPost, undefined, \(\) => \{ const a = psSettings\?\.taskApi; return a\?\.on \? cleanScopes\(a\.scopes\) : \{ done: false/.test(ps), "the Mac: its switches now, the AI task API off or none known means no button");
  assert.ok(src("src/gos/bridge.ts").includes("startMailCards(card, (at) =>") && !/startMailCards\(card, [^\n]*doneScopes/.test(src("src/gos/bridge.ts")), "the phone: no switches, the send time check");
  assert.ok(!/[\u2013\u2014]/.test(mc), "no en or em dashes");
});

console.log(`${n} passed`);
