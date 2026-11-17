// G Squad chat (V1.40) on the page that holds the vault: PS's main page on the Mac, and the website's own page (where
// the vault is unlocked in the page itself). The Tab list holds no keys: it gets chatView() in the state PS already
// sends it and sends its buttons back as a `sqChatOp` (squad/chatview.ts). The website calls runChatOp directly.
// Not on the phone yet: the phone has no G Squad screen (gos/GosLayer.tsx), so it would have nowhere to show it.
//
// Egress (the hub is on Supabase's free plan): only changes are read.
//   closed   one tick every 2 minutes (on the website only while the tab is visible): about 250 bytes back
//            (period, unread count, newest change time, votes that concern you). It pulls nothing else unless a new
//            period is due, history is to be handed over, or a vote needs names.
//   open     one pull every 5 seconds with a cursor: only rows changed since the last one (usually none, ~300 bytes).
//   keys     the period keys are opened from the hub on each start (a few hundred bytes each) and kept in memory only.
// Sound: none by default (the developer). The chat's own switch turns on a short sound for new messages, on the Mac only.
import { rewindNote } from "../rewind";
import { docs, vaultStore } from "../core/vault";
import { saveSettings } from "../core/actions";
import { settingsData } from "../core/select";
import { cleanSquadRec, type SquadRec } from "../core/squadrec";
import { joinerLine, replySnippet, voteCardDue, voteWords } from "../core/squadchat";
import { homeTz } from "../core/tz";
import { dndMutes } from "../core/dnd";
import { feature } from "../core/features";
import { GIF_FEATURE, GIFS_READY } from "./signal";
import { ISLAND_FEATURE, NOT_CONNECTED, NOTIFY_FEATURE, cleanNoteLedger, isNoteCard, laterSeen, noteCard, noteIsland, noteMuted, noteOn, noteSound, planNotes, replyOutcome, staleNotes, type NoteCard, type NoteMsg } from "../core/squadnotify";
import { buildSend } from "./chatsend";
import { ChatSession, type ChatMsg } from "./chatflows";
import { HubError } from "./hub";
import { gifApi, type GifApi } from "./gifhub";
import { foldReactions } from "./chatreact";
import { gifMemory, parseGifMessage } from "./chatgif";
import { DmSession } from "./dmflows";
import { dmApi } from "./dmhub";
import { buildConvs, sendRoute, SQUAD_CONV, type ConvInput } from "./dmview";
import type { HubMember } from "../core/squadrec";
import type { ReactEvent } from "./chatreact";
import { EMPTY_CHAT, EMPTY_GIF, type GifView, type ChatJump, type ChatLine, type ChatOp, type ChatView, type ChatVoteView, type QuoteView } from "./chatview";
import { lpClear, lpInterval } from "../core/lowpower.ts";   // PS 1.65 Low power mode: these timers stop while asleep

const TICK_MS = 2 * 60_000, OPEN_PULL_MS = 5_000, PAGE = 150;
const PS_PAGE = import.meta.env.MODE === "ps";
const SEEN = "ps.sqChatAgainSeen";
type Post = (m: object) => void;

let post: Post | null = null;
let s: ChatSession | null = null;
let who = "";                                   // squad:member of the session now
let view: ChatView = { ...EMPTY_CHAT };
let open = false, limit = PAGE, error: string | null = null;
let tickTimer: number | undefined, pullTimer: number | undefined;
let ticking = false, pulling = false;
const pending = new Map<string, { t: string; a?: ChatMsg["a"]; q?: ChatMsg["q"]; failed: boolean; at: string; conv: string }>();
// PS 1.65 (G Squad v3): DMs, group chats and pictures (squad/dmflows.ts). "squad" is the main chat above, exactly as before.
// With the hub's `dm` function missing (404) or the feature off, `dm.available` is not true and none of it shows or runs.
const DM_FEATURE = "gsquad-dm";
const GONE_NOTE = "A message was not sent because that chat is gone.";
let dm = null as DmSession | null, active = SQUAD_CONV;
const dmOn = () => !!dm && dm.available === true && feature(DM_FEATURE);
const avStore = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };
let jump: ChatJump | null = null, jumpN = 0, seeking = false;   // PS 1.64: the last "go to the original" and its answer
const cards = new Map<string, string>();       // vote cards on screen (Mac): card id to its JSON
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const chatStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => view,
};
/** The plain view for the Tab list (no keys). */
export function chatView(): ChatView { return view; }

const settings = () => settingsData(vaultStore.get());
const seenAgain = (): string[] => { try { const v = JSON.parse(localStorage.getItem(SEEN) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
const markSeenAgain = (id: string) => { try { localStorage.setItem(SEEN, JSON.stringify([...seenAgain().filter((x) => x !== id), id].slice(-40))); } catch { /* storage off */ } };
/** The first line a quote shows (a GIF message shows "GIF"). */
const quoteLine = (t: string) => (parseGifMessage(t) ? "GIF" : replySnippet(t));
const say = (e: unknown) => (e instanceof HubError
  ? e.status === 401 && /clock/.test(e.message) ? "This device's clock is off. Set the date and time to automatic and try again."
  : e.status === 429 ? "Slow down a little: that was a lot of messages in one minute."
  : "G Squad could not be reached. Try again in a moment."
  : "Something went wrong. Try again.");

// ---------- GIFs (PS 1.63, squad/gifhub.ts) ----------
// Whether the hub's `gif` function is deployed and has its key is asked ONCE per session and remembered on this device
// (a yes for a week, a no for 6 hours); until it says yes the GIF button stays hidden, and any trouble is a quiet no.
const GIF_MEM = "ps.sqGifOn";
let gifOn: boolean | null = null, gifApiNow: GifApi | null = null, gifState: GifView = EMPTY_GIF, gifAsk = 0;
const gifView = (): GifView => ({ ...gifState, on: gifOn });
function gifSetup(cur: ChatSession) {
  gifApiNow = gifApi({ member: cur.rec.memberId, priv: cur.rec.sign.priv });
  let mem: string | null = null;
  try { mem = localStorage.getItem(GIF_MEM); } catch { /* storage off: ask */ }
  const want = GIFS_READY && feature(GIF_FEATURE);   // GIFs skipped for now (signal.ts GIFS_READY): no GIF calls at all
  gifOn = want ? gifMemory(mem, Date.now()) : false;   // the feature off means no GIF calls at all
  if (gifOn !== null || !want) return;
  const api = gifApiNow;
  void api.status().then((on) => {
    if (gifApiNow !== api) return;
    gifOn = on;
    try { localStorage.setItem(GIF_MEM, JSON.stringify({ on, at: Date.now() })); } catch { /* storage off: asked again next time */ }
    rebuild();
  });
}
async function gifSearch(q: string, more: boolean) {
  const api = gifApiNow;
  if (!api || gifOn !== true) return;
  const ask = ++gifAsk;
  gifState = { ...gifState, q, busy: true, failed: false, ...(more ? {} : { items: [], next: null }) };
  rebuild();
  try {
    const r = await api.search(q, more ? gifState.next ?? 0 : 0);
    if (ask !== gifAsk) return;
    const seen = new Set(more ? gifState.items.map((g) => g.id) : []);
    gifState = { ...gifState, busy: false, items: [...(more ? gifState.items : []), ...r.items.filter((g) => !seen.has(g.id))].slice(0, 120), next: r.next };
  } catch (e) {
    if (ask !== gifAsk) return;
    gifState = { ...gifState, busy: false, failed: true };
    if (e instanceof HubError && e.status === 404) { gifOn = false; try { localStorage.setItem(GIF_MEM, JSON.stringify({ on: false, at: Date.now() })); } catch { /* ignore */ } }
  }
  rebuild();
}

// ---------- the view ----------
interface Src { msgs: Map<string, ChatMsg>; gone: Set<string>; done: boolean; list: ChatMsg[]; reacts: Map<string, ReactEvent> }
/** The messages of the conversation on screen: the squad chat, or a DM or group when one is open and the hub has them. */
function src(): Src | null {
  if (!s) return null;
  const c = active !== SQUAD_CONV && dmOn() ? dm!.convs.get(active) : null;
  if (c) return { msgs: c.msgs, gone: c.gone, done: c.loaded && !c.more, list: dm!.list(active, limit), reacts: c.reacts };
  return { msgs: s.msgs, gone: s.gone, done: s.loaded && !s.more, list: s.list(limit), reacts: s.reacts };
}
function lines(): ChatLine[] {
  const c = src();
  if (!s || !c) return [];
  const me = s.rec.memberId;
  const msgs = c.list;
  const shown = new Set(msgs.map((m) => m.id));
  const pills = foldReactions([...c.reacts.values()], (id) => shown.has(id), me, (id) => s!.people.get(id)?.name ?? "Someone");
  const out: ChatLine[] = msgs.map((m) => {
    const p = s!.people.get(m.from);
    const q = m.q ? quoteOf(m.q, c) : null;
    return { id: m.id, from: m.from, name: m.from === me ? "You" : p?.name ?? "Someone", mine: m.from === me, t: m.t,
      ...(m.a ? { a: m.a } : {}), ...(q ? { q } : {}), at: m.at, edited: m.edited, left: !!p?.left, ...(pills.get(m.id) ? { r: pills.get(m.id) } : {}) };
  });
  for (const [id, p] of pending) if (p.conv === active && !c.msgs.has(id)) { const q = p.q ? quoteOf(p.q, c) : null; out.push({ id, from: me, name: "You", mine: true, t: p.t, ...(p.a ? { a: p.a } : {}), ...(q ? { q } : {}), at: p.at, edited: false, left: false, ...(p.failed ? { failed: true } : { sending: true }) }); }
  return out;
}
/** PS 1.64: the quote above a reply. The original's words as they are now when it is here (an edit shows); the line the
 *  reply carried while the original is further up; "not available" once it is known deleted or not there for you. */
function quoteOf(q: NonNullable<ChatMsg["q"]>, c: Src): QuoteView {
  const cur = s!;
  const me = cur.rec.memberId;
  const orig = c.msgs.get(q.id);
  const name = q.w === me ? "You" : cur.people.get(q.w)?.name ?? "Someone";
  if (orig) return { id: q.id, name, from: q.w, s: quoteLine(orig.t), gone: false };
  const gone = c.gone.has(q.id) || c.done;
  return { id: q.id, name, from: q.w, s: gone ? "" : q.s, gone };
}
function votes(): ChatVoteView[] {
  if (!s) return [];
  const seen = new Set(seenAgain()), tz = homeTz();
  return s.votes.filter((v) => v.voter && !v.res).map((v) => {
    const stage = voteCardDue(v, (id) => seen.has(id));
    const name = s!.people.get(v.j)?.name ?? "Someone new";
    const w = voteWords(name, v, stage ?? (v.again ? "again" : "ask"), tz);
    return { id: v.id, joiner: v.j, name, stage, mine: v.mine, n: v.n, k: v.k, ...w };
  });
}
/** The conversation list and the members with their pictures (PS 1.65). Messages are only decoded for the one on screen. */
function convList(): ConvInput[] {
  if (!s) return [];
  const me = s.rec.memberId, name = (id: string) => (id === me ? "You" : s!.people.get(id)?.name ?? "Someone");
  const all = [...s.people.values()].filter((p) => !p.left).map((p) => p.id);
  const lastSquad = s.list(1)[0];
  const out: ConvInput[] = [{ id: SQUAD_CONV, kind: "squad", title: "G Squad", memberIds: all, unread: open && active === SQUAD_CONV ? 0 : s.status?.u ?? 0,
    ...(lastSquad ? { last: { text: quoteLine(lastSquad.t), at: lastSquad.at, from: name(lastSquad.from) } } : {}) }];
  if (!dmOn()) return out;
  for (const c of dm!.convs.values()) {
    const l = dm!.list(c.id, 1)[0];
    const peer = c.people.find((p) => p !== me);
    out.push({ id: c.id, kind: c.kind, title: c.kind === "dm" ? (peer ? name(peer) : "Chat") : c.title ?? "Group", memberIds: c.people, unread: open && active === c.id ? 0 : c.status.u,
      ...(l ? { last: { text: quoteLine(l.t), at: l.at, from: name(l.from) } } : {}), ...(c.kind === "dm" && peer ? { avatar: peer } : {}) });
  }
  return out;
}
function rebuild() {
  if (active !== SQUAD_CONV && (!dmOn() || !dm!.convs.has(active))) active = SQUAD_CONV;   // removed from it, or the hub lost DMs
  const st = s?.status;
  const mine = s?.myVote();
  view = {
    in: !!s, ready: !!s && !!st && !st.rot && s.keys.has(st.epoch), open, unread: open ? 0 : (st?.u ?? 0) + (dmOn() ? [...dm!.convs.values()].reduce((n, c) => n + c.status.u, 0) : 0),
    lines: open ? lines() : [], more: !!s?.more, votes: votes(), note: s ? joinerLine(mine, s.hasHistory()) : null,
    sound: settings().squadChatSound === true, notify: feature(NOTIFY_FEATURE), notifyOn: settings().squadNotify !== false, noteSound: settings().squadNotifySound !== false, islandOk: PS_PAGE && feature(ISLAND_FEATURE), noteIsland: settings().squadNoteIsland !== false, sending: [...pending.values()].filter((p) => !p.failed).length, error, loaded: !!s?.loaded, gif: gifView(),
    convs: buildConvs(convList()), activeConv: active, dm: dmOn(),
    members: open && s ? [...s.people.values()].filter((p) => !p.left).map((p) => ({ id: p.id, name: p.me ? "You" : p.name, me: p.me, left: false, ...(dm?.pics.get(p.id) ? { pic: dm.pics.get(p.id)! } : {}) })) : [],
  };
  emit();
  showCards();
}

// ---------- the history vote pop-up on the Mac (a PS card, top right, with Yes and No; it stays until answered) ----------
function showCards() {
  if (!post || !PS_PAGE) return;
  const want = new Map<string, string>();
  for (const v of view.votes) {
    if (!v.stage) continue;
    const id = `sqv:${v.id}`;
    want.set(id, JSON.stringify({ id, sticky: true, title: v.title, sub: v.sub, body: v.body, actions: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }));
  }
  for (const [id, json] of want) if (cards.get(id) !== json) { cards.set(id, json); post({ type: "cardShow", card: JSON.parse(json) }); }
  for (const id of [...cards.keys()]) if (!want.has(id)) { cards.delete(id); post({ type: "cardHide", id }); }
}
/** The card's buttons (Mac): Yes, No. */
export function chatCardMessage(m: { type?: string; id?: string; action?: string; text?: string }): boolean {
  if (m.type === "cardAction" && isNoteCard(m.id)) { noteAction(m.id, String(m.action || ""), typeof m.text === "string" ? m.text : undefined); return true; }
  if (m.type !== "cardAction" || typeof m.id !== "string" || !m.id.startsWith("sqv:")) return false;
  const id = m.id.slice(4);
  if (m.action === "yes" || m.action === "no") void runChatOp({ op: "vote", id, yes: m.action === "yes" });
  return true;
}

// ---------- message notifications (PS 1.60, PR 10, core/squadnotify.ts has the rules) ----------
// A new message from someone else becomes a card: the Mac's top right stack (cardShow path "meetCard", tone "squad"), the
// website's corner (noteStore, drawn by views/SquadNoteCards.tsx) or the phone's notification (notePost, gos/bridge.ts).
// Reply goes through the same send request as the chat's box (squad/chatsend.ts buildSend).
const LEDGER_KEY = "ps-gsquad-announced", SINCE_KEY = "ps-gsquad-notify-since";
let notePost: Post | null = null;
let noteLedger: Record<string, number> | null = null;
const noteShown = new Map<string, NoteCard>();     // cards on screen on this device: card id to its card
const noteSubs = new Set<() => void>();
let noteList: NoteCard[] = [];
export const noteStore = {
  subscribe(l: () => void) { noteSubs.add(l); return () => { noteSubs.delete(l); }; },
  get: () => noteList,
};
/** The dev page only (?fake&gsquad&note): a made up card on the website's corner, never real data. */
export function devShowNote(c: NoteCard) { noteShown.set(c.id, c); publishNotes(); }
/** The phone's page: where its notifications go (gos/bridge.ts hands its card poster). */
export function setNotePost(p: Post | null) { notePost = p; }
const noteDevice = (): "mac" | "phone" | "web" => (PS_PAGE ? "mac" : notePost ? "phone" : "web");
// Read from storage each time, so two tabs of the website share one list.
const readLedger = () => { try { noteLedger = cleanNoteLedger(JSON.parse(localStorage.getItem(LEDGER_KEY) || "{}")); } catch { noteLedger = noteLedger ?? {}; } return noteLedger!; };
const writeLedger = (l: Record<string, number>) => { noteLedger = l; try { localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch { /* storage blocked: this run's list still holds */ } };
const getSince = (): string | null => { try { return localStorage.getItem(SINCE_KEY) || null; } catch { return null; } };
const setSince = (v: string | null) => { try { if (v) localStorage.setItem(SINCE_KEY, v); else localStorage.removeItem(SINCE_KEY); } catch { /* storage blocked */ } };
const noteEnabled = () => noteOn(feature("gsquad-notify"), settings());
const putNote = (c: NoteCard) => {
  noteShown.set(c.id, c);
  if (PS_PAGE && post) post({ type: "meetCard", card: c });
  else if (notePost) notePost({ type: "meetCard", card: c });
};
const dropNote = (id: string) => {
  if (!noteShown.delete(id)) return;
  if (PS_PAGE && post) post({ type: "cardHide", id });
  else if (notePost) notePost({ type: "cardHide", id });
};
function publishNotes() {
  noteList = [...noteShown.values()].sort((a, b) => a.at.localeCompare(b.at));
  noteSubs.forEach((l) => l());
}
/** Look at the messages this device has: new ones become cards, cards that are no longer wanted go. Cheap, runs after
 *  every pull and every settings change. Does nothing and clears every card while the feature or the switch is off. */
function refreshNotes(announce = true) {
  const cur = s;
  const st = settings();
  const now = Date.now();
  if (!cur || !noteEnabled()) {
    if (noteShown.size) { for (const id of [...noteShown.keys()]) dropNote(id); publishNotes(); }
    if (getSince()) setSince(null);   // switched off: when it comes back on, only newer messages count
    return;
  }
  if (!getSince()) { setSince(new Date(now).toISOString()); return; }
  const muted = noteMuted(st, now, noteDevice());
  const read = cur.status?.read ?? null, seen = st.squadNoteSeen ?? null;
  const stale = staleNotes([...noteShown.values()], { read, seen, chatOpen: open, muted, enabled: true });
  for (const id of stale) dropNote(id);
  let changed = stale.length > 0;
  if (announce && cur.loaded) {
    const msgs: NoteMsg[] = cur.list(60).map((m) => ({ id: m.id, from: m.from, name: cur.people.get(m.from)?.name ?? "Someone", t: m.t, at: m.at }));
    const plan = planNotes(msgs, { me: cur.rec.memberId, since: getSince(), read, seen, chatOpen: open, muted, now, ledger: readLedger() });
    writeLedger(plan.ledger);
    // PS 1.63: on the Mac the card says whether the person wants it on the island; the Mac decides if the island can take it.
    const island = PS_PAGE && noteIsland(feature(ISLAND_FEATURE), st), sound = noteSound(st, now, noteDevice());
    for (const m of plan.show) { putNote(noteCard(m, { island, sound })); changed = true; }
    if (plan.show.length && noteSound(st, now, noteDevice()) && post && PS_PAGE) post({ type: "sfx", name: "note-drop", vol: Math.max(0.3, (st.tmSound ?? 40) / 100), card: true });
  }
  if (changed) publishNotes();
}
/** One note is finished with (Dismiss, Open, a sent Reply): it goes from this device, and "seen up to here" is saved so
 *  the other devices drop it too (their cards leave when the settings reach them). */
function finishNote(id: string) {
  const c = noteShown.get(id);
  dropNote(id);
  publishNotes();
  if (c) void saveSettings({ squadNoteSeen: laterSeen(settings().squadNoteSeen, c.at) });
}
/** A card's button, from the Mac's stack or the phone (ids "g:<message id>"). */
export function noteAction(id: string, action: string, text?: string): void {
  if (!isNoteCard(id)) return;
  if (action === "dismiss") { finishNote(id); return; }
  if (action === "open") {
    finishNote(id);
    // The Mac shell brings the Tab list up on the chat by itself (ps-mac main.swift, "squadOpen" to the Tab list, ps.ts).
    if (!PS_PAGE) void import("./chatopen").then((m) => m.openSquadChat({}));
    return;
  }
  if (action === "reply" && typeof text === "string") {
    finishNote(id);
    sendIslandReply(id, text);
    return;
  }
  // PS 1.63: Retry on the island's "Not sent": the chat still holds the failed reply, so it is sent again, never typed twice.
  // A reply that never reached the chat (it was locked or gone during the Undo) is kept in `held` and goes now.
  if (action === "retry") {
    const h = held.get(id);
    if (h !== undefined) { held.delete(id); sendIslandReply(id, h); return; }
    if (!chatReady()) { tellIsland(id, NOT_CONNECTED); return; }
    void runChatOp({ op: "retry" }).then(() => tellIsland(id));
  }
}
/** Replies the island handed over while the chat was not there (vault locked, squad record changed): kept for its Retry. */
const held = new Map<string, string>();
const chatReady = () => { const st = vaultStore.get(); return !!s && st.status === "unlocked" && st.role === "owner"; };
function sendIslandReply(id: string, text: string) {
  const op = buildSend(text);
  if (!op) { tellIsland(id, "Nothing to send"); return; }
  if (!chatReady()) {
    // The island must never show Sent for a reply that went nowhere (PS 1.63 review M7): say so, and keep the words for Retry.
    held.set(id, text);
    if (held.size > 20) held.delete(held.keys().next().value as string);
    tellIsland(id, NOT_CONNECTED);
    return;
  }
  void runChatOp(op).then(() => tellIsland(id));
}
/** The Mac's island waits for the answer to a reply (ps-mac SquadIsland.swift): it went, or the chat still holds it as not sent. */
function tellIsland(id: string, why?: string) {
  if (!PS_PAGE || !post) return;
  const o = why ? { ok: false, why } : replyOutcome([...pending.values()].filter((p) => p.failed).length, error);
  post({ type: "sqresult", id, ok: o.ok, ...(o.why ? { why: o.why } : {}) });
}

// ---------- the hub ----------
async function tick() {
  if (!s || ticking || !navigator.onLine) return;
  if (!PS_PAGE && document.visibilityState === "hidden") return;
  ticking = true;
  const cur = s;
  try {
    const before = cur.status;
    const st = await cur.tick();
    if (st.rot) await cur.rotateIfDue();
    if (st.give.length) await cur.giveIfDue();
    const needNames = cur.votes.some((v) => !cur.people.has(v.j));
    if (!cur.loaded && (needNames || open)) await cur.pull();
    else if (open && st.last && st.last !== before?.last) await cur.pull();
    else if (needNames) await cur.pull();
    else if (!open && st.u > 0 && st.last && st.last !== before?.last && noteEnabled() && getSince()) await cur.pull();   // a new message: read it to show the card
    if (before && !open && st.u > before.u && !noteEnabled()) chime();   // with notifications on the card has its own sound
    try { await dmTick(cur); } catch { /* DMs are extra: the squad chat above is never held up by them */ }
    if (cur === s) { error = null; rebuild(); refreshNotes(); }
  } catch (e) { if (!gone(e) && cur === s) { error = say(e); rebuild(); } }
  finally { ticking = false; }
}
async function pull() {
  if (!s || pulling || !navigator.onLine) return;
  pulling = true;
  const cur = s;
  try {
    if (inDm()) {
      // A DM or group is on screen: only its change is read (the squad chat's unread count still comes from the 2 minute tick).
      await dm!.pull(active);
      if (open && (PS_PAGE || document.visibilityState === "visible")) await dm!.markRead(active);
      if (cur === s) { error = null; rebuild(); }
      return;
    }
    await cur.pull();
    if (cur.status?.rot) await cur.rotateIfDue();
    if (cur.status?.give.length) await cur.giveIfDue();
    if (open && (PS_PAGE || document.visibilityState === "visible")) await cur.markRead();
    if (cur === s) { error = null; rebuild(); }
  } catch (e) { if (!gone(e) && cur === s) { error = say(e); rebuild(); } }
  finally { pulling = false; }
}
function chime() {
  const st = settings();
  if (st.squadChatSound !== true || !post || !PS_PAGE || st.tmMuted || dndMutes(st.dnd, "sounds", Date.now(), "mac") || dndMutes(st.dnd, "gsquad", Date.now(), "mac")) return;
  post({ type: "sfx", name: "note-drop", vol: Math.max(0.3, (st.tmSound ?? 40) / 100), card: true });   // card: silent in private mode (V1.57)
}
/** The hub no longer knows you: the core's engine drops your squad record; the chat just stops. */
function gone(e: unknown) {
  if (e instanceof HubError && e.status === 403) { stop(); return true; }
  return false;
}

function setOpen(on: boolean) {
  if (open === on) { if (on) void pull(); return; }
  open = on;
  if (pullTimer !== undefined) { lpClear(pullTimer); pullTimer = undefined; }
  if (on) {
    void pull();
    pullTimer = lpInterval("squad-chat", () => { if (PS_PAGE || document.visibilityState === "visible") void pull(); }, OPEN_PULL_MS);
  } else limit = PAGE;
  rebuild();
  refreshNotes(false);   // the chat opened: its cards are done with
}

// ---------- DMs, groups and pictures (PS 1.65) ----------
const inDm = () => active !== SQUAD_CONV && dmOn() && !!dm!.convs.get(active);
const DM_OPS = new Set(["openConv", "newDm", "newGroup", "setAvatar", "clearAvatar", "groupAdd", "groupRemove", "leaveConv"]);
const isDmOp = (o: ChatOp): o is Extract<ChatOp, { op: "openConv" | "newDm" | "newGroup" | "setAvatar" | "clearAvatar" | "groupAdd" | "groupRemove" | "leaveConv" }> => DM_OPS.has(o.op);
const members = () => (s ? ([...s.rows.values()] as HubMember[]) : []);
async function runDmOp(cur: ChatSession, o: Extract<ChatOp, { op: "openConv" | "newDm" | "newGroup" | "setAvatar" | "clearAvatar" | "groupAdd" | "groupRemove" | "leaveConv" }>) {
  if (!dmOn()) return;   // the hub has no DMs (or the switch is off): nothing happens, nothing is said
  const d = dm!;
  try {
    if (!cur.rows.size) await cur.pull();   // the members' keys come from the chat's own pull
    switch (o.op) {
      case "openConv":
        if (o.id !== SQUAD_CONV && !d.convs.has(o.id)) return;
        active = o.id; limit = PAGE; rebuild();
        if (o.id !== SQUAD_CONV) { await d.pull(o.id); await d.markRead(o.id); }
        else void pull();
        break;
      case "newDm": { active = await d.newDm(o.memberId); limit = PAGE; rebuild(); await d.pull(active); break; }
      case "newGroup": { active = await d.newGroup(o.title, o.memberIds); limit = PAGE; break; }
      case "groupAdd": await d.addMembers(o.id, o.memberIds); break;
      case "groupRemove": await d.removeMember(o.id, o.memberId); break;
      case "leaveConv": await d.leave(o.id); if (active === o.id) active = SQUAD_CONV; break;
      case "setAvatar": await d.setAvatar(o.dataUrl); break;
      case "clearAvatar": await d.clearAvatar(); break;
    }
    error = null;
  } catch (e) {
    error = e instanceof HubError ? say(e) : e instanceof Error && e.message ? e.message.slice(0, 160) : "Something went wrong. Try again.";
  }
  rebuild();
}
/** One cheap look at the DMs and groups (rides on the chat's own 2 minute tick): only changed conversations are pulled,
 *  and only a few at a time. Quiet when the hub has no `dm` function. */
async function dmTick(cur: ChatSession) {
  if (!dm || !feature(DM_FEATURE) || (!PS_PAGE && document.visibilityState === "hidden")) return;
  const changed = await dm.tick();
  if (!dm.available || !changed.length) return;
  if (!cur.rows.size) await cur.pull();
  const want = changed.filter((id) => id === active || dm!.convs.get(id)!.status.u > 0 || !dm!.convs.get(id)!.loaded).slice(0, 8);
  for (const id of want) { try { await dm.pull(id); if (open && id === active) await dm.markRead(id); } catch (e) { if (e instanceof HubError && e.status === 429) break; } }
  for (const c of dm.convs.values()) if (c.kind === "group" && c.status.rot) { try { await dm.rotateIfDue(c.id); } catch { /* next tick */ } }
}

// ---------- what the chat asks for ----------
export async function runChatOp(o: ChatOp): Promise<void> {
  const st = vaultStore.get();
  if (st.status !== "unlocked" || st.role !== "owner") return;
  if (o.op === "sound") { await saveSettings({ squadChatSound: o.on }); rebuild(); return; }
  if (o.op === "notify") { await saveSettings({ squadNotify: o.on }); rebuild(); refreshNotes(); return; }
  if (o.op === "noteSound") { await saveSettings({ squadNotifySound: o.on }); rebuild(); return; }
  if (o.op === "noteIsland") { await saveSettings({ squadNoteIsland: o.on }); rebuild(); return; }
  if (o.op === "open") { setOpen(o.on); return; }
  if (o.op === "gifclear") { gifAsk++; gifState = EMPTY_GIF; rebuild(); return; }
  if (o.op === "gifs") { await gifSearch(o.q, o.more === true); return; }
  const cur = s;
  if (!cur) return;
  if (isDmOp(o)) { await runDmOp(cur, o); return; }
  try {
    switch (o.op) {
      case "send": {
        const id = globalThis.crypto.randomUUID();
        pending.set(id, { t: o.text, ...(o.a ? { a: o.a } : {}), ...(o.q ? { q: o.q } : {}), failed: false, at: new Date().toISOString(), conv: active });
        rewindNote("squadSent");   // Rewind (PS 1.64): a count only, never the words (src/rewind.ts)
        rebuild();
        await send(cur, id);
        return;
      }
      case "retry":
        for (const id of [...pending.keys()]) { const p = pending.get(id)!; if (p.failed) { pending.set(id, { ...p, failed: false }); rebuild(); await send(cur, id); } }
        return;
      case "react": if (inDm()) await dm!.react(active, o.to, o.e, rebuild); else await cur.react(o.to, o.e, rebuild); break;
      case "edit": if (inDm()) await dm!.edit(active, o.id, o.text); else await cur.edit(o.id, o.text); break;
      case "del": if (inDm()) await dm!.del(active, o.id); else await cur.del(o.id); break;
      case "older": {
        limit += PAGE;
        if (inDm()) { const c = dm!.convs.get(active)!; if (dm!.list(active, limit).length < limit && c.more) await dm!.older(active); }
        else if (cur.list(limit).length < limit && cur.more) await cur.older();
        break;
      }
      case "seek": {
        // A reply's quote was clicked and its original is not on screen: older pages until it is here (one request a
        // page, only on this click), then the screen scrolls to it, or says it is not available.
        if (seeking || inDm()) return;   // replies in a DM or group quote what is loaded (no history search there)
        seeking = true; rebuild();
        let found = false;
        try { found = await cur.seek(o.id); } finally { seeking = false; }
        if (found) { const at = cur.list(Infinity).findIndex((m) => m.id === o.id), n = cur.msgs.size; if (at >= 0) limit = Math.max(limit, n - at + 20); }
        jump = { id: o.id, ok: found, n: ++jumpN };
        break;
      }
      case "vote": {
        await cur.vote(o.id, o.yes);
        markSeenAgain(o.id);
        void tick();
        break;
      }
    }
    error = null;
  } catch (e) { if (!gone(e)) error = say(e); }
  rebuild();
}
async function send(cur: ChatSession, id: string) {
  const p = pending.get(id);
  if (!p) return;
  // A private message is never rerouted: if its conversation is gone (removed, left, a 403, the feature off) it is dropped with a note.
  const route = sendRoute(p.conv, dmOn() && dm!.convs.has(p.conv));
  if (route === "gone") { pending.delete(id); error = GONE_NOTE; rebuild(); return; }
  const conv = route === "dm" ? p.conv : null;
  const body = { t: p.t, ...(p.a ? { a: p.a } : {}), ...(p.q ? { q: p.q } : {}) };
  try {
    if (conv) await dm!.send(conv, body, id); else await cur.send(body, id);
    pending.delete(id);
    error = null;
  } catch (e) {
    // A send whose answer was lost may have landed: look before calling it failed.
    try { if (conv) await dm!.pull(conv); else await cur.pull(); } catch { /* offline */ }
    if (conv && !dm!.convs.has(conv)) { pending.delete(id); error = GONE_NOTE; }
    else if (conv ? dm!.convs.get(conv)?.msgs.has(id) : cur.msgs.has(id)) pending.delete(id);
    else { pending.set(id, { ...p, failed: true }); if (!gone(e)) error = e instanceof Error && /key is not here/.test(e.message) ? "The chat is getting its new key. Try again in a moment." : say(e); }
  }
  rebuild();
}

// ---------- start ----------
function readRec(): SquadRec | null {
  const list = docs<SquadRec>("squad").map((d) => cleanSquadRec(d.data)).filter((r): r is SquadRec => !!r).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
  return list[0] ?? null;
}
function stop() {
  s = null; who = ""; pending.clear(); error = null; jump = null; seeking = false; dm = null; active = SQUAD_CONV;
  gifOn = null; gifApiNow = null; gifState = EMPTY_GIF; gifAsk++;
  if (tickTimer !== undefined) lpClear(tickTimer);
  if (pullTimer !== undefined) lpClear(pullTimer);
  tickTimer = pullTimer = undefined; open = false;
  view = { ...EMPTY_CHAT };
  for (const id of [...noteShown.keys()]) dropNote(id);
  publishNotes();
  emit();
  showCards();
}
function sync() {
  const st = vaultStore.get();
  if (st.status !== "unlocked" || st.role !== "owner" || st.userId === "ps-overlay" || st.userId === "dev") { if (s) stop(); return; }
  const rec = readRec();
  const next = rec ? `${rec.squadId}:${rec.memberId}` : "";
  if (next === who) { if (s && (view.sound !== (settings().squadChatSound === true) || view.notifyOn !== (settings().squadNotify !== false) || view.noteSound !== (settings().squadNotifySound !== false))) rebuild(); refreshNotes(); return; }
  if (s) stop();
  if (!rec) return;
  s = new ChatSession(rec); who = next;
  gifSetup(s);
  if (feature(DM_FEATURE)) {
    dm = new DmSession(rec, members, dmApi({ member: rec.memberId, priv: rec.sign.priv }), avStore);
    void dm.loadCache().then(rebuild);
  }
  rebuild();
  tickTimer = lpInterval("squad-chat", () => void tick(), TICK_MS);
  void tick();
}

let started = false;
/** PS's main page (post = PS's message to the shell, for the vote card and the sound) and the website (null). */
export function startChat(p: Post | null) {
  if (started) return;
  started = true;
  post = p;
  vaultStore.subscribe(sync);
  sync();
  window.addEventListener("online", () => void tick());
  if (!PS_PAGE) document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void tick(); });
}
