// A message from an AI on the island (V1.58, the developer 13 Nov 2026: "I want the AI to write to me at the end of each chat
// instead of the AI completion cards, because it just says the AI chat is complete ... the dynamic island will pop out
// with a message from the AI instead of just saying the chat's completed").
//
// How it gets here: an AI on this Mac (Claude Code, Codex, anything that can run a command) sends
// POST /v1/island/message to the Task API (core/taskapi.ts, switch "message", off unless switched on) with
// {"from": "Claude Code", "text": "Fixed the login bug, tests pass", "detail": "optional longer text", "chat": "<its chat id>"}.
// The page keeps it in settings.aiMsgs (the encrypted settings, like settings.chatDone), so it never goes through a
// server in the clear and the phone gets it too. src/mailcards.ts shows it as a card of tone "ai" on the same path as
// the AI chat finished cards (out of the island, or the top right), src/island.ts pops the island for it.
//
// No double pop up: when a message names its chat (Claude Code's CLAUDE_CODE_SESSION_ID, Codex's CODEX_THREAD_ID), the
// plain "Claude finished" card for that same chat around the same time is not shown (messagedChat). A chat that sends
// no message keeps its plain card. Settings picks: AI messages (that), Plain finished cards (messages are not shown), or
// Off (neither). Text only: every word is shown as plain text, never as HTML. Pure: no React, no DOM.
//
// PS 1.74 (Jan, 21 Nov 2026, for his AI coach: "the card then shows a Mark done button that ticks that task with one click"): a
// message may name one task ({"task": "<id>"}). The Task API keeps it only while the "Tick tasks done" switch is on and the
// task is open and within the AI's reach (core/taskapi.ts); the card then has Mark done (markDoneOk), and one click ticks it.
import type { AiNotes, AiMsg, ChatDone, Settings, Todo } from "./model";
import { CHAT_DONE, chatDoneCards } from "./chatdone.ts";
import { dndHeldMs, type Dnd } from "./dnd.ts";

export const AI_MSG = {
  fromMax: 40, textMax: 200, detailMax: 2000, chatMax: 64,
  keep: 20, stay: CHAT_DONE.stay,
  /** At most this many messages in this long (every AI together): more answer 429, so a looping AI cannot flood the island. */
  burst: 10, burstMs: 10 * 60_000,
  /** The same words from the same chat within this long is the same message sent again (a retry after a timeout). */
  again: 2 * 60_000,
  /** A message and a finished card are the same chat's end when the message came this long before the finish (the AI
   *  sends it as its last step, the finish comes a moment later) or this long after the newest finish folded into it. */
  before: 10 * 60_000, after: 3 * 60_000,
} as const;

/** The card's line in private mode (and on the island): nothing of what it says. */
export const AI_MSG_PRIVATE = "A message from an AI";

/** Settings > Notifications > AI chat finished cards, and AI task API > Connect your AI: what pops up when an AI's chat ends. */
export const AI_NOTES: { id: AiNotes; label: string; line: string }[] = [
  { id: "messages", label: "AI messages", line: "The AI's own message. A chat that sends none still gets the plain card." },
  { id: "plain", label: "Plain finished cards", line: "Only the plain finished card. Messages from AIs are not shown." },
  { id: "off", label: "Off", line: "Nothing pops up when an AI chat ends." },
];
export const aiNotesMode = (v: unknown): AiNotes => (v === "plain" || v === "off" ? v : "messages");

// ---------- what an AI sent ----------
/** Bidi and zero width marks (they can make a message read as something else), controls, and tabs. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** One line: no marks, spaces collapsed. */
const line = (s: string) => s.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
/** Several lines kept (at most two blank lines in a row), no marks. */
const lines = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(HIDDEN, "").split("\n").map((x) => x.replace(/ {2,}/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
/** A chat id as each AI tool gives it: letters, digits, - and _. */
const chatId = (s: string) => s.replace(/[^\w-]/g, "").slice(0, AI_MSG.chatMax);

export const AI_MSG_FIELDS = ["from", "text", "detail", "chat", "task"] as const;
/** A task id as the Task API gives it (core/taskapi.ts ID_RE). */
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
export type AiMsgCheck = { msg: Omit<AiMsg, "id" | "at"> } | { field: string; message: string };
/** The body as the API got it: text is needed, the rest optional. Too long is refused (never cut), so the AI knows. */
export function checkAiMsg(b: Record<string, unknown>): AiMsgCheck {
  const str = (k: string) => (b[k] === undefined || b[k] === null ? "" : b[k]);
  const from = str("from"), text = str("text"), detail = str("detail"), chat = str("chat"), task = str("task");
  if (typeof text !== "string" || !line(text)) return { field: "text", message: `text is needed: the message itself, 1 to ${AI_MSG.textMax} characters (one or two plain sentences).` };
  if (line(text).length > AI_MSG.textMax) return { field: "text", message: `text is over ${AI_MSG.textMax} characters. Keep it to one or two short sentences; put the rest in detail.` };
  if (typeof from !== "string") return { field: "from", message: "from must be text: who the message is from, like \"Claude Code\"." };
  if (line(from).length > AI_MSG.fromMax) return { field: "from", message: `from is over ${AI_MSG.fromMax} characters. Send just your name, like "Claude Code" or "Codex".` };
  if (typeof detail !== "string") return { field: "detail", message: "detail must be text." };
  if (lines(detail).length > AI_MSG.detailMax) return { field: "detail", message: `detail is over ${AI_MSG.detailMax} characters. Keep it short: what changed and anything the person must do.` };
  if (typeof chat !== "string") return { field: "chat", message: "chat must be text: this chat's id, or leave it out." };
  if (typeof task !== "string" || (task !== "" && !TASK_ID.test(task))) return { field: "task", message: "task must be a task id from GET /v1/tasks, or leave it out." };
  const c = chatId(chat);
  const d = lines(detail);
  return { msg: { from: line(from) || "AI", text: line(text), ...(d ? { detail: d } : {}), ...(c ? { chat: c } : {}), ...(task ? { task } : {}) } };
}

/** A new message's id: 12 letters and digits. */
export function newAiMsgId(): string {
  const b = new Uint8Array(9);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

/** Too many messages lately: how many seconds until one more may come, else 0. */
export function aiMsgWait(list: AiMsg[] | undefined, now: number): number {
  const recent = (list || []).map((m) => Date.parse(m.at)).filter((t) => t > now - AI_MSG.burstMs && t <= now).sort((a, b) => a - b);
  if (recent.length < AI_MSG.burst) return 0;
  return Math.max(1, Math.ceil((recent[recent.length - AI_MSG.burst] + AI_MSG.burstMs - now) / 1000));
}

/** The same message sent again (same chat, or both without one, the same words, a moment apart): the one already kept. */
export function sameAiMsg(list: AiMsg[] | undefined, m: Omit<AiMsg, "id" | "at">, now: number): AiMsg | null {
  return (list || []).find((x) => (x.chat || "") === (m.chat || "") && x.from === m.from && x.text === m.text && (x.detail || "") === (m.detail || "")
    && (x.task || "") === (m.task || "") && Math.abs(now - Date.parse(x.at)) < AI_MSG.again) ?? null;
}

const shownFrom = (x: AiMsg) => Math.max(Date.parse(x.at), x.remindAt ? Date.parse(x.remindAt) || 0 : 0);
const reminding = (x: AiMsg, now: number) => !!x.remindAt && Date.parse(x.remindAt) > now;
const upFor = (x: AiMsg, now: number, dnd?: Dnd) => now - shownFrom(x) - dndHeldMs(dnd, "chats", shownFrom(x), now);

/** The list with one more message: newest first, old ones dropped. */
export function addAiMsg(list: AiMsg[] | undefined, m: AiMsg, now: number, dnd?: Dnd): AiMsg[] {
  return [m, ...(list || []).filter((x) => x.id !== m.id)]
    .filter((x) => upFor(x, now, dnd) < AI_MSG.stay)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, AI_MSG.keep);
}

// ---------- no double pop up ----------
/** Does this message's chat id name this finished chat? Another tool's chat is kept as "<tool>-<id>" (core/chatdone.ts). */
export function sameChat(x: ChatDone, chat: string | undefined): boolean {
  if (!chat) return false;
  return x.id === chat.slice(0, 36) || (!!x.tool && x.id === `${x.tool}-${chat}`.slice(0, 36));
}
/** Did the AI already send a message for this finish? Then its plain card is not shown. Dismissed messages count too:
 *  the developer read it, the plain card would only be the same news again. */
export function messagedChat(x: ChatDone, msgs: AiMsg[] | undefined): boolean {
  const from = Date.parse(x.at) - AI_MSG.before;
  const to = Date.parse(x.last && x.last > x.at ? x.last : x.at) + AI_MSG.after;
  return (msgs || []).some((m) => { const t = Date.parse(m.at); return sameChat(x, m.chat) && t >= from && t <= to; });
}

export const aiMsgCardId = (m: Pick<AiMsg, "id">) => `c:msg-${m.id}`.slice(0, 40);
export const isAiMsgCard = (id: string) => id.startsWith("c:msg-");

/** What pops up for AI chats right now, by the person's choice: the plain finished cards still to show, and the messages.
 *  fresh: it arrived, or came back from a remind, in the last 3 minutes (so PS chimes and the island pops for it). */
export function aiCardsNow(st: Pick<Settings, "chatDone" | "aiMsgs" | "aiNotes" | "dnd">, now = Date.now()) {
  const mode = aiNotesMode(st.aiNotes);
  const msgs = st.aiMsgs || [];
  const chatList = mode === "off" ? [] : mode === "messages" ? (st.chatDone || []).filter((x) => !messagedChat(x, msgs)) : st.chatDone;
  const chats = chatDoneCards(chatList, now, st.dnd);
  const shown = mode === "messages" ? msgs.filter((x) => !x.seen && !reminding(x, now) && upFor(x, now, st.dnd) < AI_MSG.stay) : [];
  return {
    chats,
    msgs: shown.map((x) => ({ id: aiMsgCardId(x), from: x.from, text: x.text, detail: x.detail, task: x.task, at: x.at, rev: `${x.at}|${x.remindAt || ""}`, fresh: upFor(x, now, st.dnd) < 180_000 })),
  };
}

// ---------- Mark done (PS 1.74) ----------
/** The switches Mark done looks at: the AI task API's on this Mac (core/taskapi.ts cleanScopes). */
export type MarkDoneScopes = { done: boolean; inbox: boolean; lists: boolean };
/** May this message's Mark done tick its task right now? Only a task that is still in the list and open. `sc`: the Mac's
 *  switches now ("Tick tasks done" on, and the AI Inbox or All lists switch for where the task is), so a switch turned off
 *  after the message came takes the button away. null: a device without those switches (the phone), where the Task API's
 *  own check when the message came stands (it keeps a task only while the switch is on). */
export function markDoneOk(todo: Pick<Todo, "done" | "clearedAt" | "aiInbox"> | null | undefined, sc: MarkDoneScopes | null): boolean {
  if (!todo || todo.done || todo.clearedAt) return false;
  if (!sc) return true;
  return sc.done && (todo.aiInbox === true ? sc.inbox : sc.lists);
}
/** May a Mark done click (or a phone tap, maybe sent late) on this message tick its task now? Never once the message is
 *  dismissed: a tap queued on the phone after the Mac's Mark done must not tick again a task the person reopened since. */
export function markDoneFor(m: Pick<AiMsg, "task" | "seen"> | null | undefined, todo: Pick<Todo, "done" | "clearedAt" | "aiInbox"> | null | undefined, sc: MarkDoneScopes | null): boolean {
  return !!m?.task && !m.seen && markDoneOk(todo, sc);
}
/** A phone tap on Mark done waits until the phone has a copy fetched after the tap (break-it 1.74): its stored copy can be
 *  from before the Mac's Mark done and a reopen, and must not tick the task again. Fetches never overlap and each one ends
 *  with a new lastSync, so the SECOND new lastSync after the tap comes from a fetch that started after it (the first may be
 *  a fetch already running at the tap, or the stored copy shown on unlock). The device clock is never compared. Older than
 *  MARK_DONE_WAIT_MS: dropped. */
export const MARK_DONE_WAIT_MS = 10 * 60_000;
export type TapWait = { at: number; last: string | null; seen: number };
export const tapWait = (at: number, lastSync: string | null | undefined): TapWait => ({ at, last: lastSync ?? null, seen: 0 });
/** Counts a new lastSync (in place). fresh: the tap may be applied now. fetch: ask for the second fetch now. */
export function tapFresh(w: TapWait, lastSync: string | null | undefined): { fresh: boolean; fetch: boolean } {
  const now = lastSync ?? null;
  let fetch = false;
  if (now && now !== w.last) { w.last = now; w.seen++; fetch = w.seen === 1; }
  return { fresh: w.seen >= 2, fetch };
}
/** The message a card is showing (its card id), or null. */
export const aiMsgOfCard = (list: AiMsg[] | undefined, id: string): AiMsg | null => (list || []).find((x) => aiMsgCardId(x) === id) ?? null;
/** The card's button, and the action it sends back (mailcards.ts, ps-mac AiMessageCard.swift, ps-gos Notifier.kt). */
export const AI_MSG_DONE = { label: "Mark done", action: "done" } as const;

/** The list with one message dismissed, or reminded for `mins` minutes (1 minute to 4 hours). null: no such card. */
export function aiMsgAnswer(list: AiMsg[] | undefined, id: string, action: "dismiss" | number, now = Date.now()): AiMsg[] | null {
  const l = list || [];
  if (!l.some((x) => aiMsgCardId(x) === id && !x.seen)) return null;
  return l.map((x) => aiMsgCardId(x) !== id ? x : action === "dismiss" ? { ...x, seen: true }
    : { ...x, remindAt: new Date(now + Math.max(1, Math.min(240, Math.round(action))) * 60_000).toISOString() });
}

/** When the next reminded message comes back (ms since 1970), or 0. */
export function nextAiMsgRemind(list: AiMsg[] | undefined, now = Date.now()): number {
  let next = 0;
  for (const x of list || []) if (!x.seen && reminding(x, now)) { const at = Date.parse(x.remindAt!); if (!next || at < next) next = at; }
  return next;
}

/** Two devices' copies joined (core/cardsync.ts): one entry per message, a Dismiss on either holds, and the later remind. */
export function mergeAiMsgs(a: AiMsg[] | undefined, b: AiMsg[] | undefined): AiMsg[] | undefined {
  if (!a || !b) return a || b;
  const by = new Map<string, AiMsg>();
  for (const x of [...b, ...a]) {
    const was = by.get(x.id);
    if (!was) { by.set(x.id, x); continue; }
    const remindAt = [was.remindAt, x.remindAt].filter((v): v is string => !!v).sort().pop();
    by.set(x.id, { ...was, ...x, seen: !!(was.seen || x.seen) || undefined, remindAt });
  }
  return [...by.values()].map((x) => { const y = { ...x }; if (!y.seen) delete y.seen; if (!y.remindAt) delete y.remindAt; return y; })
    .sort((p, q) => q.at.localeCompare(p.at)).slice(0, AI_MSG.keep);
}
