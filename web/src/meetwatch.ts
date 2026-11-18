// Meeting alerts in PS (the main window only, where the vault is open): runs src/core/meetalerts.ts
// on every vault change and every 30 s, and hands its cards to the native pop-up ({type:"meetCard"}).
// Sources, all already in the vault: the calendar snapshot (calendar-inbox, every 5 min), Instantly
// replies (Follow-up Radar feed "irep", about every minute, and instantly-inbox threads), Gmail
// (client replies, plus non client mail kept in this window's memory) and the follow-up leads ("fup").
// This Mac keeps only what it has already told the developer about (event ids, invite states, message ids
// and a date) in localStorage, never names or text. Read only: nothing here sends anything.
import { vaultStore } from "./core/vault";
import { settingsData } from "./core/select";
import type { CalendarSnap, ClientRec, Doc, IThread, Reply, Settings } from "./core/model";
import { MEET_DEFAULTS, emptySeen, meetAlerts, privateAskFor, type Lead, type LeadMsg, type MeetPrefs, type MeetSeen } from "./core/meetalerts";
import { saveSettings } from "./core/actions";
import { gmailThreadLink, parseAddress } from "./core/mail";
import { unmatchedMail } from "./core/vault";
import { homeTz, setHomeTz, tzLabel } from "./core/tz";
import { isMeeting } from "./core/notescard";
import { dndMutes } from "./core/dnd";
import { visibleEvents } from "./core/meethide";
import { meetingEvents } from "./core/calpick";
import { notePref, noteSoundName } from "./core/notelook";
import { afkMeetWindows, sameWindows, type MeetWindow } from "./core/afkmeet";
import { askScreenRec, screenRecNow } from "./screenrec";
import { meetingMessage } from "./core/screenrecmeet";
import { lpInterval } from "./core/lowpower.ts";
import { feature } from "./core/features";
import { PRIVATE_ENDS_FEATURE, privatePatch, privateShouldEnd, privateStamp } from "./core/privateends";

/** The phone shows these as notifications; its "Phone notifications" toggle mutes them all (core/dnd.ts). */
const DEVICE = import.meta.env.MODE === "gos" ? "phone" : "mac";

const SEEN = "ps.meetSeen";
type Post = (m: object) => void;

/** The prefs saved in the vault (gear menu > Meeting alerts), with defaults filled in. */
/** Also carries the meeting notes pop-up settings (src/notescard.ts): notes, notesAfter, notesSnooze, notesBlur. */
type NotesFields = { notes: boolean; notesAfter: number; notesSnooze: number[]; notesBlur: boolean };
export function meetPrefs(st: Settings): MeetPrefs & { sBooked: boolean; sMsg: boolean; sSoon: boolean } & NotesFields {
  const m = (st as Settings & { meetAlerts?: Partial<MeetPrefs & { sBooked: boolean; sMsg: boolean; sSoon: boolean } & NotesFields> }).meetAlerts || {};
  return { ...MEET_DEFAULTS, sBooked: true, sMsg: true, sSoon: true, notes: true, notesAfter: 5, notesSnooze: [5, 10, 15, 20, 25, 30, 40, 45, 50, 60], notesBlur: true, ...m };
}

/** Leads: follow-up leads (feed), prospects and leads in the vault, and everyone in an Instantly thread. */
function leadsOf(docs: Doc<unknown>[]): Lead[] {
  const out: Lead[] = [];
  for (const d of docs) {
    if (d.kind === "client") {
      const c = d.data as ClientRec;
      if (c.archived || !c.email) continue;
      out.push({ name: c.contactName || c.name, company: c.name, emails: [c.email, ...(c.matchAddrs || []).filter((a) => a.includes("@"))], tz: c.timezone || null });
    } else if (d.kind === "ithread") {
      const t = d.data as IThread;
      if (t.lead) out.push({ name: t.leadName || t.lead.split("@")[0], company: null, emails: [t.lead], tz: null });
    } else if ((d.kind as string) === "fup") {
      // The follow-up system's leads (Follow-up Radar feed, every 2 min): lead address plus CCs.
      type F = { name?: string; fullName?: string; email?: string; cc?: string[]; timezone?: string | null; siteUrl?: string | null };
      for (const l of ((d.data as { leads?: F[] }).leads || [])) {
        if (!l?.email) continue;
        let company: string | null = null;
        try { company = l.siteUrl ? new URL(l.siteUrl).hostname.replace(/^www\./, "") : null; } catch { /* not a link */ }
        out.push({ name: String(l.fullName || l.name || l.email.split("@")[0]), company, emails: [l.email, ...(Array.isArray(l.cc) ? l.cc : [])].map(String), tz: l.timezone || null });
      }
    }
  }
  return out;
}

/** Messages from leads: Instantly replies, Gmail replies, and the follow-up replies feed. */
function msgsOf(docs: Doc<unknown>[]): LeadMsg[] {
  const out: LeadMsg[] = [];
  const since = Date.now() - 2 * 864e5;
  for (const d of docs) {
    if (d.kind === "ithread") {
      const t = d.data as IThread;
      for (const m of t.messages || []) {
        if (m.type !== "received" || !m.at || Date.parse(m.at) < since) continue;
        out.push({ id: `i:${m.iid}`, from: m.from, fromName: m.fromName, at: m.at, channel: "instantly", subject: m.subject, text: m.text,
          url: "https://app.instantly.ai/app/unibox" });
      }
    } else if (d.kind === "reply") {
      const r = d.data as Reply;
      if (!r.date || Date.parse(r.date) < since) continue;
      out.push({ id: `g:${r.threadId}:${r.msgIds[r.msgIds.length - 1] || r.date}`, from: r.from, fromName: r.fromName, at: r.date, channel: "gmail",
        subject: r.subject, text: r.opening || r.snippet, url: gmailThreadLink(r.account, r.threadId) });
    } else if ((d.kind as string) === "irep") {
      // Instantly replies (instantly-replies feed, about every minute).
      type R = { id?: string; from?: string; lead?: string; fromName?: string | null; at?: string; subject?: string | null; opening?: string | null; url?: string | null };
      for (const m of ((d.data as { replies?: R[] }).replies || [])) {
        if (!m?.id || !m.at || Date.parse(m.at) < since) continue;
        out.push({ id: `i:${m.id}`, from: m.from || m.lead || "", fromName: m.fromName, at: m.at, channel: "instantly", subject: m.subject, text: m.opening || "",
          url: m.url || "https://app.instantly.ai/app/unibox" });
      }
    }
  }
  // Gmail from people who are not clients (memory only in this window, last 7 days): leads replying in Gmail.
  for (const g of unmatchedMail()) {
    if (!g.date || Date.parse(g.date) < since || !g.from) continue;
    const { name, email } = parseAddress(g.from);
    if (email) out.push({ id: `u:${g.id}`, from: email, fromName: name, at: g.date, channel: "gmail", subject: g.subject, text: g.opening || g.snippet || "",
      url: gmailThreadLink(g.account, g.threadId) });
  }
  return out;
}

function loadSeen(): MeetSeen {
  try { const v = JSON.parse(localStorage.getItem(SEEN) || ""); if (v && typeof v === "object" && v.events) return v as MeetSeen; } catch { /* first run or storage off */ }
  return emptySeen(new Date());
}
function saveSeen(s: MeetSeen) { try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch { /* storage off */ } }

// Private mode (the developer, 29 Oct 2026): settings.privateMode, switched with the mask on the Tab list's
// Meetings panel. While it is on, every card arrives discreet ({type:"meetPrivacy"}). A meeting no
// longer does that by itself: when a real one starts, a card asks "Start private mode?" once.
const ASKED = "ps.privateAsked";
/** PS 1.68: the card's words while private mode ends with the meeting (waiting for the owner's approval). */
const PRIVATE_ASK_ENDS = "Notification cards become small pills with no sound, and the island hides names and messages, until the meeting ends or you turn it off with the mask on the Meetings panel.";
let askPost: Post = () => {};
let asking: string | null = null;
function loadAsked(): string[] {
  try { const v = JSON.parse(localStorage.getItem(ASKED) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-40) : []; } catch { return []; }
}
function saveAsked(v: string[]) { try { localStorage.setItem(ASKED, JSON.stringify(v.slice(-40))); } catch { /* not kept */ } }
function hideAsk() { if (asking) { asking = null; askPost({ type: "cardHide", id: "private-ask" }); } }
/** The card's buttons: Yes turns private mode on; No (or the x) leaves it off for this meeting. */
export function privateAskMessage(m: { type?: string; id?: string; action?: string }) {
  if (m.type !== "cardAction" || m.id !== "private-ask") return false;
  asking = null;
  if (m.action === "yes") void saveSettings(privatePatch(true, Date.now()));
  return true;
}

let started = false;
let privateSaving = false;
export function startMeetAlerts(post: Post) {
  if (started) return;
  started = true;
  askPost = post;
  let seen = loadSeen();
  let wasPrivate: boolean | null = null;
  let wasRealMeeting: boolean | null = null;
  let sentWindows: MeetWindow[] | null = null;
  let t = 0;
  const run = () => {
    const s = vaultStore.get();
    if (s.status !== "unlocked") return;
    const st = settingsData(s);
    setHomeTz(st.tmHomeTz);
    const docs = [...s.docs.values()];
    const cal = docs.filter((d) => d.kind === "calendar").sort((a, b) => ((b.data as CalendarSnap).at || "").localeCompare((a.data as CalendarSnap).at || ""))[0];
    // Meetings the developer took off the Meetings panel stay quiet here too (core/meethide.ts).
    // Only calendars set to Meetings count (core/calpick.ts): Show only and Off ones ring no alert, ask no private mode question.
    const calEvents = meetingEvents(visibleEvents(cal ? (cal.data as CalendarSnap).events : [], st.meetHidden), st.calChoices);
    const prefs = meetPrefs(st);
    const home = homeTz();
    const r = meetAlerts({
      now: new Date(), events: calEvents, leads: leadsOf(docs), msgs: msgsOf(docs), seen, prefs,
      homeTz: home, homeName: tzLabel(home).replace(/\s*\(.*\)$/, ""), privateMode: !!st.privateMode,
    });
    // Do Not Disturb holds meeting cards: what they are about is not marked as told, so the same cards
    // come up the moment DND ends (a restart in between loses nothing, and no names are kept anywhere).
    // A "10 minutes before" whose call is long over is not shown late (core/meetalerts.ts windows).
    const held = dndMutes(st.dnd, "meetings", Date.now(), DEVICE) && r.cards.length > 0;
    if (!held) { seen = r.seen; saveSeen(seen); }
    const priv = !!st.privateMode;
    if (priv !== wasPrivate) { wasPrivate = priv; post({ type: "meetPrivacy", on: priv }); }
    // PS 1.68 (core/privateends.ts): private mode ends with the meeting it was on for. One save at a time; the next run sees it.
    if (feature(PRIVATE_ENDS_FEATURE) && !privateSaving) {
      const nowMs = Date.now();
      const write = privateShouldEnd({ privateMode: st.privateMode, privateAt: st.privateAt, events: calEvents, now: nowMs })
        ? privatePatch(false, nowMs) : privateStamp(st.privateMode, st.privateAt, nowMs);
      if (write) { privateSaving = true; void saveSettings(write).catch(() => {}).finally(() => { privateSaving = false; }); }
    }
    // A real meeting just started (or was on when PS opened): ask once. The card goes when private
    // mode comes on another way, or when that meeting is over (or moved).
    const events = calEvents;
    const asked = loadAsked();
    const ask = privateAskFor(events, Date.now(), priv, prefs.privacy, asked);
    if (ask && !asking) {
      asking = ask;
      saveAsked([...asked, ask]);
      post({ type: "cardShow", card: {
        id: "private-ask", sticky: true, title: "Start private mode?",
        sub: "A meeting has started",
        body: feature(PRIVATE_ENDS_FEATURE)
          ? PRIVATE_ASK_ENDS
          : "Notification cards become small pills with no sound, and the island hides names and messages, until you turn it off with the mask on the Meetings panel.",
        actions: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      } });
    } else if (asking && (priv || !events.some((e) => e.id + e.start === asking && Date.parse(e.end || "") > Date.now()))) hideAsk();
    // Screen recording (PS 1.60, 12b): tells the Mac which meeting is on, and whether the private mode question is still to be answered, so
    // the Mac asks "Do you want to record this meeting?" right AFTER it, never together. Sent only while screen recording is switched on.
    askScreenRec();
    const rec = meetingMessage({ st: screenRecNow(), events, now: Date.now(), privateAskPending: !!asking });
    if (rec) post(rec);
    // "Are you sure" mode (Sources/AreYouSure.swift) is off while a real meeting (people or a video link) is on.
    const now = Date.now();
    const real = meetingEvents(cal ? (cal.data as CalendarSnap).events : [], st.calChoices).some((e) => isMeeting(e) && Date.parse(e.start!) <= now && Date.parse(e.end!) > now);
    if (real !== wasRealMeeting) { wasRealMeeting = real; post({ type: "aysMeeting", on: real }); }
    // The AFK timer stays off during meetings (core/afkmeet.ts): the Mac gets each meeting's time, a few minutes
    // either side, and checks it with its own clock (Sources/MeetingTime.swift). Hidden meetings are left out.
    const windows = afkMeetWindows(meetingEvents(cal ? (cal.data as CalendarSnap).events : [], st.calChoices), st.meetHidden, now);
    if (!sameWindows(sentWindows, windows)) { sentWindows = windows; post({ type: "afkMeetings", windows }); }
    const vol = st.tmMuted || dndMutes(st.dnd, "sounds", Date.now(), DEVICE) ? 0 : (st.tmSound ?? 40) / 100;
    // Settings, Notifications (core/notelook.ts, V1.36): meeting sounds off, or one sound for every meeting card;
    // left on "By kind" each meaning keeps its own sound, as before. The switches per meaning above still apply.
    const look = notePref(st, "meet");
    for (const c of held ? [] : r.cards.slice(-6)) {
      post({ type: "meetCard", card: c });
      const on = c.sound === "booked" ? prefs.sBooked : c.sound === "alert" ? prefs.sMsg : prefs.sSoon;
      const name = noteSoundName(look, c.sound === "booked" ? "meet-booked" : c.sound === "alert" ? "meet-alert" : "meet-soon");
      if (on && name && vol > 0) post({ type: "sfx", name, vol: Math.max(vol, c.sound === "alert" ? 0.5 : 0), card: true });   // card: silent in private mode (V1.57)
    }
  };
  vaultStore.subscribe(() => { clearTimeout(t); t = window.setTimeout(run, 1500); });
  lpInterval("alarms", run, 30_000);   // the meeting 10 minute alert: rings in Low power mode while Keep reminders ringing is on
  run();
}
