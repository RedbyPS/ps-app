// Client email cards in PS (main window only, where the vault is open). Replaces the old 14 second
// pop-ups: every client email the developer has not dismissed stays as a card in the top right stack until he
// clicks its Dismiss button (or Clear all). The list lives in the vault (core/mailcards.ts), so the
// cards come back after a restart, a rebuild, sleep or a lock, and a Dismiss on the website clears
// them here (and the reverse). Cards travel as {type:"meetCard"} with tone "mail" (Toast.showMeet:
// discreet during a calendar meeting, never takes focus) and leave as {type:"cardHide"}.
// "Remind me in N mins" (cardAction "remind:N", or "remindUntil:<ms>" from a phone notification tapped
// while the page slept) hides the card everywhere until then (core/mailcards.ts); a timer here brings
// it back on time, and the phone shell is told when, so it can wake this page even in the background.
// Claude Code chats that just finished ride along as tone "done" cards (core/chatdone.ts): id "c:...",
// the chat's name only, gone on Dismiss (both devices) or by themselves after a few hours. They have
// Remind me in 2 mins too (core/chatdone.ts), and PS chimes when one finishes or comes back.
// V1.58: messages AIs sent through the Task API (core/aimessage.ts) ride along as tone "ai" cards: id "c:msg-...", who it
// is from, the message and its detail, kept like a chat card (Remind me in, Dismiss on every device, the chats' sound and
// time on screen). A chat that sent one gets no plain card as well; Settings can show plain cards only, or neither.
// Instantly replies from leads (core/leadcards.ts, the developer 30 Oct 2026) ride along as tone "lead" cards: id "n:...",
// human replies only, Open in Instantly (read only), Remind me in, Dismiss on every device; they chime too.
// Do Not Disturb (core/dnd.ts) holds a muted kind: not sent, taken off the Mac's stack (left alone in the
// phone's shade), and sent again the moment DND ends or that kind is let through. No chime while sounds are muted.
// Which sound, and whether a kind makes one at all, is the developer's pick in Settings, Notifications (core/notelook.ts, V1.36):
// by default chats and leads chime (Glass) and client emails stay quiet, as before. One sound per look, the newest card's.
import { feature } from "./core/features";
import { pokeCardsAfterSave, vaultStore } from "./core/vault";
import { settingsData } from "./core/select";
import { saveSettings, setReplyRemind, setReplySeen } from "./core/actions";
import { mailCards, nextRemind, REMIND } from "./core/mailcards";
import { CHAT_REMIND, chatDoneAnswer, chatLife, nextChatRemind } from "./core/chatdone";
import { AI_MSG_PRIVATE, aiCardsNow, aiMsgAnswer, isAiMsgCard, nextAiMsgRemind } from "./core/aimessage";
import { LEAD_REMIND, leadAnswer, leadCards, nextLeadRemind, type IRep } from "./core/leadcards";
import { cardKind, dndEndsAt, dndLetsSender, dndMutes, type DndKind } from "./core/dnd";
import { heldDismissed, type Dismissed } from "./core/cardsync";
import { notePrefs, noteSoundName, pickChime } from "./core/notelook";
import type { Snapshot } from "./core/vault";
import { mailOnSnap } from "./core/mailsnap";
import { waOnSnap } from "./core/wasnap";
import { isWaCard, nextWaRemind, prefsOf, waCards } from "./core/whatsapp";
import { saveWaPrefs, setWaRemind, setWaSeen } from "./core/waactions";
import { cleanLedger, ledgerDecide, noteKey, type Ledger } from "./core/maildedupe";
import { lpInterval } from "./core/lowpower.ts";

/** The Instantly reply feed (one "irep" record: replies and the developer's own Unibox sends). */
export function irepFeed(s: Snapshot): { replies?: IRep[]; sent?: IRep[] } | null {
  type Feed = { at?: string; replies?: IRep[]; sent?: IRep[] };
  let best: Feed | null = null;
  for (const d of s.docs.values()) {
    if ((d.kind as string) !== "irep") continue;
    const x = d.data as Feed;
    if (!best || (x.at || "") > (best.at || "")) best = x;
  }
  return best;
}

type Post = (m: object) => void;
/** The phone shows these as notifications; its "Phone notifications" toggle mutes them all. */
const DEVICE = import.meta.env.MODE === "gos" ? "phone" : "mac";
/** Reply from PS (src/replyengine.ts, V1.44): the Mac's cards get a Reply button. The phone and the website have none. */
const REPLY = import.meta.env.MODE === "ps" ? { reply: true } : {};
let post: Post = () => {};
/** What the pop-up stack is showing right now (card id -> what was sent), this run of the page only. */
let shown = new Map<string, string>();
/** Dismissed (or reminded) a moment ago: not sent again while its vault save is still on its way. */
const justDismissed = new Map<string, number>();
/** Dismissed on this page run (for which email or finish): if the vault still shows it, the Dismiss is written
 *  again (at most once a minute) and the card stays away, so a save lost to the other device never brings it back. */
const dismissedHere: Dismissed = new Map();
const reapplied = new Map<string, number>();
/** The time each card on the stack carries (card id -> its "at"), for dismissedHere. */
const cardAt = new Map<string, string>();
/** Answers that came while the vault was still locked (a phone notification tapped while the page slept). */
let waiting: { id: string; action: string }[] = [];
let onNext: (at: number) => void = () => {};
let nextTimer = 0, lastNext = -1;
/** A full look has run since the cards last left the screen: only then does a client email new on the stack chime
 *  (after a sign in or with pop-ups switched back on, every card is "new" here, and none of them is news). */
let primed = false;

/** The emails this device has already announced (per device, kept across restarts): the same email never chimes twice here. */
const LEDGER_KEY = "ps-mail-announced";
let ledger: Ledger | null = null;
function announce(key: string): boolean {
  try { if (!ledger) ledger = cleanLedger(JSON.parse(localStorage.getItem(LEDGER_KEY) || "{}")); } catch { ledger = ledger ?? {}; }
  const r = ledgerDecide(ledger!, key, Date.now());
  ledger = r.ledger;
  if (r.fresh) { try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch { /* storage blocked: the page's own list still holds this run */ } }
  return r.fresh;
}

function sync(force = false) {
  const s = vaultStore.get();
  // Signed out (PS Lock): the cards leave the screen; they come back on the next sign in.
  if (s.status !== "unlocked" || s.role !== "owner") { hideAll(); return; }
  const st = settingsData(s);
  // Client emails and lead replies only with the Client emails switch on (core/mailswitch.ts, fails closed). The finished chat
  // and AI message cards below are everyone's and do not depend on it.
  const mailOn = mailOnSnap(s);
  if (mailOn && !st.mailCardsSince) { void saveSettings({ mailCardsSince: new Date().toISOString() }); return; }   // first run: start from now
  if (mailOn && !st.leadCards?.since) { void saveSettings({ leadCards: { since: new Date().toISOString() } }); return; }   // the same for Instantly replies
  const waOn = feature("whatsapp") && waOnSnap(s), waPrefs = prefsOf(st);   // the feature "whatsapp" (default on) and its switch
  if (waOn && !waPrefs.since) { void saveWaPrefs({ since: new Date().toISOString() }); return; }   // first run: start from now
  if (waiting.length) { const w = waiting; waiting = []; w.forEach((a) => apply(a.id, a.action)); }
  // The next reminded card: back on time here, and the phone shell wakes this page for it.
  // Do Not Disturb ending by itself counts too: the held cards come back on time (and the phone wakes for them).
  const now = Date.now();
  const next = [mailOn ? nextRemind(s.docs.values(), st.mailCardsSince) : 0, nextChatRemind(st.chatDone), nextAiMsgRemind(st.aiMsgs), mailOn ? nextLeadRemind(st.leadCards) : 0, waOn ? nextWaRemind(s.docs.values(), waPrefs.since, waPrefs) : 0, dndEndsAt(st.dnd, now)].filter(Boolean).sort((a, b) => a - b)[0] || 0;
  clearTimeout(nextTimer);
  if (next) nextTimer = window.setTimeout(() => sync(), Math.min(Math.max(next - Date.now() + 300, 300), 2 ** 31 - 1));
  if (next !== lastNext) { lastNext = next; onNext(next); }
  if (st.tmNotify === false) { hideAll(); return; }                                                    // pop-ups switched off in the gear
  const muted = (k: DndKind) => dndMutes(st.dnd, k, now, DEVICE);
  const mailAll = mailOn ? mailCards(s.docs.values(), st.mailCardsSince) : [];
  // V1.43: people the focus mode on now always lets through (its "Always gets through" list) are never held.
  const letThrough = new Set(mailAll.filter((c) => dndLetsSender(st.dnd, c.from, c.fromName, now)).map((c) => c.id));
  const held = (id: string) => { if (letThrough.has(id)) return false; const k = cardKind(id); return !!k && muted(k); };
  const waAll = waOn ? waCards(s.docs.values(), waPrefs.since, waPrefs) : [];   // WhatsApp (core/whatsapp.ts): the same cards, one per chat
  const ai = aiCardsNow(st, now);   // V1.58: the plain finished cards still to show, and the AI messages
  const doneAll = ai.chats;
  const leadsAll = mailOn ? leadCards(irepFeed(s), st.leadCards) : [];
  // Dismissed here but still in the vault: the save went missing. Write it again, keep the card away.
  const gone = (c: { id: string; at: string }) => {
    if (!heldDismissed(dismissedHere, c.id, c.at, now)) return false;
    if ((reapplied.get(c.id) || 0) < now - 60_000) { reapplied.set(c.id, now); apply(c.id, "dismiss"); }
    return true;
  };
  const wa = waAll.filter((c) => !gone(c)), want = mailAll.filter((c) => !gone(c)), done = doneAll.filter((c) => !gone(c)), leads = leadsAll.filter((c) => !gone(c)), msgs = ai.msgs.filter((c) => !gone(c));
  for (const c of [...want, ...wa, ...done, ...leads, ...msgs]) cardAt.set(c.id, c.at);
  const ids = new Set([...want.map((c) => c.id), ...wa.map((c) => c.id), ...done.map((c) => c.id), ...leads.map((c) => c.id), ...msgs.map((c) => c.id)]);
  // Held by Do Not Disturb: off the Mac's stack until it ends; a notification already in the phone's shade stays.
  for (const id of [...shown.keys()]) if (!ids.has(id) || (DEVICE === "mac" && held(id))) { post({ type: "cardHide", id }); shown.delete(id); }
  const look = notePrefs(st);
  const chimes: { at: string; name: string | null }[] = [];
  // Oldest first, so the newest ends up in front of the stack.
  for (const c of [...want].reverse()) {
    if (held(c.id)) continue;
    if ((justDismissed.get(c.id) || 0) > Date.now() - 15_000) continue;
    // rev: the phone shows each revision of a card once, across restarts (ps-gos NoteLedger.kt).
    const card = { id: c.id, rev: c.rev, tone: "mail", icon: "mail", title: c.title, sub: c.sub, body: c.body, url: c.url, at: c.at, discreetText: c.client ? "New client email" : "New email", ...REPLY,
      ...(letThrough.has(c.id) && muted("mail") ? { dndPass: true } : {}) };   // the Mac's own stack lets it through too (Toast.swift)
    const json = JSON.stringify(card);
    if (!force && shown.get(c.id) === json) continue;   // forced: send again anyway (the stack ignores an identical card)
    // New, or back from Remind me in, and never announced on this device before: one chime per email (core/maildedupe.ts ledger).
    if (!shown.has(c.id) && primed && announce(noteKey(c.rev.split("|")[0], c.rev.split("|")[1] || null))) chimes.push({ at: c.at, name: noteSoundName(look.mail) });
    shown.set(c.id, json);
    post({ type: "meetCard", card });
  }
  for (const c of [...wa].reverse()) {   // WhatsApp: tone "mail" with the green bubble icon (Toast.swift), Open in WhatsApp, Remind me in, Dismiss on every device
    if (held(c.id)) continue;
    if ((justDismissed.get(c.id) || 0) > Date.now() - 15_000) continue;
    const card = { id: c.id, rev: c.rev, tone: "mail", icon: "whatsapp", title: c.title, sub: c.sub, body: c.body, url: c.url, at: c.at, discreetText: "New WhatsApp message", ...REPLY };
    const json = JSON.stringify(card);
    if (!force && shown.get(c.id) === json) continue;
    // Each message notifies once per device: keyed by the WhatsApp message id (the chat's newest incoming message), and again when a Remind comes due.
    if (!shown.has(c.id) && primed && waPrefs.sound !== false && announce(`wa:${noteKey(c.rev.split("|")[0], c.rev.split("|")[1] || null)}`)) chimes.push({ at: c.at, name: noteSoundName(look.mail) });
    else if (!shown.has(c.id)) announce(`wa:${noteKey(c.rev.split("|")[0], c.rev.split("|")[1] || null)}`);
    shown.set(c.id, json);
    post({ type: "meetCard", card });
  }
  for (const c of [...done].reverse()) {
    if (held(c.id)) continue;
    if ((justDismissed.get(c.id) || 0) > Date.now() - 15_000) continue;
    const card = { id: c.id, rev: c.rev, tone: "done", icon: "done", title: c.chat, sub: c.sub, at: c.at, discreetText: `A ${c.sub.replace(/ finished$/, "")} chat finished`, remind: CHAT_REMIND,
      ...chatLife(st.chatFade) };   // V1.55: goes by itself after that many seconds (core/chatdone.ts chatFade)
    const json = JSON.stringify(card);
    if (!force && shown.get(c.id) === json) continue;
    if (!shown.has(c.id) && c.fresh) chimes.push({ at: c.at, name: noteSoundName(look.done) });   // new on screen and new in fact (not a restart sending it again)
    shown.set(c.id, json);
    post({ type: "meetCard", card });
  }
  for (const c of [...msgs].reverse()) {   // V1.58: a message from an AI (core/aimessage.ts)
    if (held(c.id)) continue;
    if ((justDismissed.get(c.id) || 0) > Date.now() - 15_000) continue;
    // The phone shows title and sub (ps-gos Notifier.kt chat()); the Mac's card also folds the detail (AiMessageCard.swift).
    const card = { id: c.id, rev: c.rev, tone: "ai", icon: "ai", title: c.from, sub: c.text, ...(c.detail ? { body: c.detail } : {}), at: c.at,
      discreetText: AI_MSG_PRIVATE, remind: CHAT_REMIND, ...chatLife(st.chatFade) };
    const json = JSON.stringify(card);
    if (!force && shown.get(c.id) === json) continue;
    if (!shown.has(c.id) && c.fresh) chimes.push({ at: c.at, name: noteSoundName(look.done) });   // the AI chats' sound
    shown.set(c.id, json);
    post({ type: "meetCard", card });
  }
  for (const c of [...leads].reverse()) {
    if (held(c.id)) continue;
    if ((justDismissed.get(c.id) || 0) > Date.now() - 15_000) continue;
    const card = { id: c.id, rev: c.rev, tone: "lead", icon: "reply", title: c.title, sub: c.sub, body: c.body, url: c.url, at: c.at, discreetText: "New lead reply", remind: LEAD_REMIND, ...REPLY };
    const json = JSON.stringify(card);
    if (!force && shown.get(c.id) === json) continue;
    if (!shown.has(c.id) && c.fresh && announce(`lead:${c.id}|${c.rev}`)) chimes.push({ at: c.at, name: noteSoundName(look.lead) });
    shown.set(c.id, json);
    post({ type: "meetCard", card });
  }
  const chime = pickChime(chimes);
  // card: a card's own sound, which PS on the Mac skips while private mode is on (V1.57, ps-mac PrivateCore.swift).
  if (chime && !muted("sounds")) post({ type: "sfx", name: chime, vol: 0.55, card: true });
  primed = true;
}
function hideAll() { for (const id of shown.keys()) post({ type: "cardHide", id }); shown = new Map(); primed = false; }

/** Dismiss, or Remind me in N mins, on one card: saved on its reply record, so every device follows. */
function apply(id: string, action: string): boolean {
  const s = vaultStore.get();
  if (s.status !== "unlocked" || s.role !== "owner") return false;
  pokeCardsAfterSave();   // V1.59: the other devices hear it within seconds (core/vault.ts)
  const mins = action.startsWith("remind:") ? Number(action.slice(7))
    : action.startsWith("remindUntil:") ? (Number(action.slice(12)) - Date.now()) / 60_000 : NaN;
  if (isAiMsgCard(id)) {   // V1.58: a message from an AI: Dismiss or Remind me in, on every device
    if (action !== "dismiss" && !(mins > 0)) return true;
    const list = aiMsgAnswer(settingsData(s).aiMsgs, id, action === "dismiss" ? "dismiss" : mins);
    if (list) void saveSettings({ aiMsgs: list });
    return true;
  }
  if (id.startsWith("c:")) {   // a finished chat: Dismiss (the X, a swipe) or Remind me in, on every device
    if (action !== "dismiss" && !(mins > 0)) return true;
    const list = chatDoneAnswer(settingsData(s).chatDone, id, action === "dismiss" ? "dismiss" : mins);
    if (list) void saveSettings({ chatDone: list });
    return true;
  }
  if (isWaCard(id)) {   // WhatsApp: Dismiss or Remind me in, on every device (saved on the chat record)
    if (!waOnSnap(s)) return true;
    const chat = [...s.docs.values()].find((x) => x.kind === "wachat" && `w:${x.id}`.slice(0, 40) === id);
    if (!chat) return true;
    if (action === "dismiss") void setWaSeen(chat.id);
    else if (mins > 0) void setWaRemind(chat.id, Math.round(mins));
    return true;
  }
  if ((id.startsWith("n:") || id.startsWith("m:")) && !mailOnSnap(s)) return true;   // Client emails is off: nothing to answer
  if (id.startsWith("n:")) {   // an Instantly reply: Dismiss or Remind me in, on every device (nothing changes in Instantly)
    if (action !== "dismiss" && !(mins > 0)) return true;
    const st = settingsData(s);
    if (!st.leadCards?.since) return true;
    // Every reply, not only the 20 newest: with more than 20 since leadCards.since, a Dismiss on an older card
    // found nothing to save and the card came back a minute later (3 Nov 2026).
    const next = leadAnswer(st.leadCards, leadCards(irepFeed(s), { ...st.leadCards, seen: {}, remind: {} }, Date.now(), Infinity), id, action === "dismiss" ? "dismiss" : mins);
    if (next) void saveSettings({ leadCards: next });
    return true;
  }
  const d = [...s.docs.values()].find((x) => x.kind === "reply" && `m:${x.id}`.slice(0, 40) === id);
  if (!d) return true;
  if (action === "dismiss") { void setReplySeen(d.id); return true; }
  if (!Number.isFinite(mins)) return true;
  // A late phone answer whose time has already come: nothing to hide any more.
  if (mins > 0) void setReplyRemind(d.id, Math.min(REMIND.max, Math.max(REMIND.min, Math.round(mins))));
  return true;
}

/** The card's Dismiss or Remind button (or Clear all) in the pop-up stack, or the phone's notification. */
export function mailCardMessage(m: { type?: string; id?: string; action?: string }) {
  if (m.type === "cardAction" && typeof m.id === "string" && (m.id.startsWith("m:") || m.id.startsWith("c:") || m.id.startsWith("n:") || m.id.startsWith("w:"))) {
    const action = String(m.action || "");
    if (action === "dismiss" || action.startsWith("remind")) {
      shown.delete(m.id);
      justDismissed.set(m.id, Date.now());
      if (action === "dismiss") dismissedHere.set(m.id, { at: cardAt.get(m.id) || "", t: Date.now() });
      else dismissedHere.delete(m.id);   // Remind me in: it comes back on time
      if (!apply(m.id, action)) waiting.push({ id: m.id, action });   // the vault opens in a moment (sync applies it)
    }
    return true;
  }
  if (m.type === "wake") { window.setTimeout(() => sync(true), 3000); return false; }   // re-send after sleep (others handle wake too)
  return false;
}

/** A background check on the phone: look again now (a remind may be due without anything changing). */
export function refreshMailCards() { sync(true); }

/** PS main window only. */
export function startMailCards(p: Post, next?: (at: number) => void) {
  post = p;
  if (next) onNext = next;
  let t = 0;
  vaultStore.subscribe(() => { clearTimeout(t); t = window.setTimeout(sync, 400); });
  lpInterval("mail-cards", () => sync(true), 60_000);   // PS 1.65: asleep in Low power mode. Self healing: whatever happened to the stack, it matches the vault within a minute
  sync();
}
