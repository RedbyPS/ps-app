// Feature intros (PS 1.60): the one piece that draws every "Did you know?" from the island. What it says and when it may show is in
// core/featureintro.ts (the list INTROS and the rules). The next intro is a new entry there (docs/feature-intros.md): no new animation
// code here. Only two small tables below know the pictures and guides by name (MARKS, GUIDES) and one more knows how to tell the person
// already did it (DONE_PROBES).
//
// Where it shows:
//  - The Mac: the island squeezes in a little and a chime plays (Sources/SetupIsland.swift intro), then this card hangs from the
//    island, same black, growing out of its width, the mark swooping in on a spring. "Show me" grows the card into the guide, still
//    attached. Esc closes it and the island is itself again. The Mac's shared queue decides the turn (never over a meeting, reminder,
//    stand up, What's new, Welcome back or any other card) and the Mac says no for Sentry mode, Sleep mode, screen sharing and full screen.
//  - The website and the phone: the same card, plain (no island to hang from), at the top of the page, with the page's own queue.
//    The phone's Back closes it (gos-back). Reduced motion turns the animation off.
import { CD_FEATURE } from "../core/daycount";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PS, onPsSettings, psPost, psSettingsNow, useOverlayShown } from "../ps";
import { askScreenRec, screenRecNow } from "../screenrec";
import { introAudience } from "../core/screenrecmeet";
import { useVault } from "../ui/kit";
import { assistPrefs } from "../core/assist";
import { settingsData } from "../core/select";
import { dndActive } from "../core/dnd";
import { CHK_FEATURE } from "../core/chkremind";
import { cleanSwitches, feature } from "../core/features";
import { chatStore } from "../squad/chatengine";
import { RCPT_FEATURE, receiptsOn } from "../core/receipts";
import { posturePrefs } from "../core/posture";
import { PROTON_FEATURE, protonMirror } from "../core/protonmail";
import { APPROVE_FEATURE, APPROVE_INTRO, approveAnswer, approveIntroProbe, approveOffAfter, approvePicksFor, approveSyncPosts, cleanApprove, type ApproveState } from "../core/autoapprove";
import { mailCan } from "../core/mailswitch";
import { attachedLayout, ISLAND_ASK_MS, ISLAND_QUEUED_MS, type IslandAnchor } from "../core/whatsnew";
import { addActive, answer, CARD_W, cleanDone, LOGO_MOMENT, logoChime, cleanState, INTROS, introReply, markShown, nextIntro, recheckMs, retire, retireFolded, updaterAnswer, type IntroDef, type IntroState } from "../core/featureintro";
import { AGAIN_KEY, buttonWord, resumeAt, stepAfter, TOUR_FEATURE, TOUR_ID, TOUR_WORDS, tourSteps, type TourStep } from "../core/tour";
import { tipsOn } from "../core/offswitches";
import { afkMeetWindows } from "../core/afkmeet";
import { meetingEvents } from "../core/calpick";
import { calendarSnap } from "../core/select";
import type { CalendarSnap } from "../core/model";
import { GOS } from "../gos/bridge";
import { accountOlderThan, LOCAL_KEY as WN_SEEN_KEY } from "../core/whatsnew";
import { TASK_ONLY_FEATURE, islandPrefs } from "../core/island";
import { saveSettings } from "../core/actions";
import { cleanShareOpts } from "../core/squadshare";
import { P1_FEATURE, p1Default } from "../core/squadp1";
import { squadStore } from "../squad/engine";
import { squadNow, squadOp } from "../squad/mirror";
import { isRedAccount } from "../core/account";
import { JOIN_ASK_ID, joinAskProbe } from "../core/gsquadjoin";
import type { Snapshot } from "../core/vault";
import logoPng from "../assets/cake-icon.png";
import { sleepState } from "../sleepmode/engine";
import { sentryUp } from "./Sentry";
import { popupOn, tipOn, walkOn } from "./popupstate";
import { useWelcomeShowing } from "./Welcome";
import { useFaceShowing, useIslandTurn, useWhatsNewShowing, islandCards } from "../updateface";
import { readWaStatus } from "./WhatsAppSettings";
import { WaGuide } from "./WaGuide";
import { WaMark } from "./WaMark";
import { sfx } from "../ui/sfx";
import "./featureintro.css";

const KEY = "ps.featureIntros";

// V1.62: the one button notices closed by this person, saved with their settings, so each shows once per person (not per device).
declare module "../core/model" {
  interface Settings {
    /** Feature intro ids with `ack` (core/featureintro.ts) this person closed with Ok, on any device (V1.62). */
    introsDone?: string[];
    /** PS 1.65: the Auto approve switches ("ai", "sleep") this person turned off from the 1.65 notice, so the answer applies on
     *  every one of their Macs (core/autoapprove.ts approveSyncPosts). */
    approveOff?: string[];
  }
}
/** The version this device had handled before this page started (What's new's own record), read once at load, before What's new
 *  records the version this page runs. Null on a new device or after cleared storage (then the account's data decides). */
const SEEN_AT_START: string | null = (() => { try { const v = localStorage.getItem(WN_SEEN_KEY); return v && /^\d+\.\d+$/.test(v) ? v : null; } catch { return null; } })();
const RUNNING = /^V(\d+\.\d+)$/.exec(__PS_VERSION__.name)?.[1] ?? "";
const BUILT = typeof __PS_WHATSNEW__ === "object" ? __PS_WHATSNEW__.built : "";
/** Did this person run PS before this build (an update), and did they close this notice anywhere already? */
function updaterProbe(id: string, s: Snapshot): "done" | "open" | "unknown" {
  const unlocked = s.status === "unlocked";
  return updaterAnswer({
    id, unlocked, docs: unlocked ? s.docs.size : 0, done: unlocked ? cleanDone(settingsData(s).introsDone) : [],
    accountOlder: unlocked && accountOlderThan(BUILT, [...s.docs.values()].map((d) => d.updatedAt)), seenAtStart: SEEN_AT_START, version: RUNNING,
  });
}
const load = (): IntroState => { try { return cleanState(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return cleanState(null); } };
const save = (s: IntroState) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window: it asks again next time */ } };

/** The pictures that swoop in, by the name in the list. */
const MARKS: Record<IntroDef["mark"], (size: number) => ReactNode> = {
  whatsapp: (n) => <WaMark size={n} />,
  record: recordMark,
  logo: (n) => <img src={logoPng} width={n} height={n} alt="" style={{ borderRadius: Math.round(n * 0.22) }} />,
  // PS 1.65: the Sentry shield (blue to violet, the same drawing as the Sentry screen) for the Auto approve notice.
  shield: (n) => (
    <svg width={n} height={n} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs><linearGradient id="fi-shield-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5AC8FA" /><stop offset="1" stopColor="#AF52DE" /></linearGradient></defs>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" fill="url(#fi-shield-g)" opacity=".22" />
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="url(#fi-shield-g)" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9.5 12l2 2 3.5-3.5" stroke="#f5f5f7" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  spark: (n) => (
    <svg width={n} height={n} viewBox="0 0 24 24" fill="none" stroke="#FFD60A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
    </svg>
  ),
};
/** The Record mark: a screen with a red dot. */
function recordMark(n: number) {
  return (
  <svg width={n} height={n} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="12" cy="12" r="3" fill="#FF453A" stroke="#FF453A" />
  </svg>
  );
}
/** The guides "Show me" opens, by the name in the list. */
const GUIDES: Record<NonNullable<IntroDef["guide"]>, (p: { onClose: () => void; anchor: IslandAnchor | null }) => ReactNode> = {
  "wa-link": (p) => <WaGuide onClose={p.onClose} anchor={p.anchor} />,
};
/** Has the person already done what the intro is about? "done" retires it for good. "open" keeps it. "unknown" waits (never shows on a guess). */
/** PS 1.65: the tour's steps for this person on this device (only features on in this build; core/tour.ts). */
function tourListFor(s: Snapshot): TourStep[] {
  const unlocked = s.status === "unlocked";
  return tourSteps({ where: PS ? "mac" : GOS ? "phone" : "web", on: (id) => feature(id), owner: unlocked && s.role === "owner", mail: mailCan(s) });
}
const tourAgainAsked = (): boolean => { try { return localStorage.getItem(AGAIN_KEY) === "1"; } catch { return false; } };
/** The intros the tour replaces show on their own only while the tour is switched off (then nothing is folded). */
const foldedUnlessTour = (read: (can: boolean, s: Snapshot) => Promise<"done" | "open" | "unknown">) =>
  async (can: boolean, s: Snapshot): Promise<"done" | "open" | "unknown"> => (feature(TOUR_FEATURE) && feature("feature-intros") ? "done" : read(can, s));
const DONE_PROBES: Record<string, (can: boolean, s: Snapshot) => Promise<"done" | "open" | "unknown">> = {
  // PS 1.65 the tour: updaters only (a first install has nothing "new" to be shown), once per person (Done on any device ends it everywhere),
  // never with "Show first use tips" off, and only when at least one step applies. "Show the tour again" (Settings, About) asks for it.
  [TOUR_ID]: async (_can, s) => {
    if (!feature("whats-new-tour") || s.status !== "unlocked" || !tipsOn(settingsData(s).tipsShow)) return "unknown";
    const who = tourAgainAsked() ? "open" : updaterProbe(TOUR_ID, s);
    if (who !== "open") return who;
    return tourListFor(s).length ? "open" : "unknown";
  },
  // PS 1.66 Join The G Squad ask: once after updating, only for people not in it and not waiting to be let in; never the developer's account.
  [JOIN_ASK_ID]: async (_can, s) => {
    const v = squadNow();
    const unlocked = s.status === "unlocked";
    return joinAskProbe({ red: isRedAccount(s), owner: unlocked && s.role === "owner", loaded: v.loaded, inSquad: v.in, stage: v.auto?.stage ?? null,
      updater: updaterProbe(JOIN_ASK_ID, s) });
  },
  // V1.62 the new app logo: only people updating from an earlier version, once per person (Ok on any device ends it everywhere).
  "new-logo-162": async (_can, s) => updaterProbe("new-logo-162", s),
  // Screen recording (12b): shown only to people who said No or have not answered. Yes retires it. Asks the Mac for its saved choice only (nothing from macOS).
  // PS 1.63 Priority 1 with the squad: shared by default (opt out). A person who already answered is done. Everyone else (new or existing)
  // sees the same one notice once they are in a squad. This probe NEVER saves anything: only a click on the card saves (CHOICES below).
  "squad-p1": async (_can, s) => {
    if (!feature(P1_FEATURE)) return "unknown";
    const todo = p1Default(squadStore.get().in, cleanShareOpts(settingsData(s).squadShare));
    return todo === "keep" ? "done" : todo === "tell" ? "open" : "unknown";
  },
  // PS 1.64 G Squad replies and members list: only for people in a squad; Ok ends it for good (a choice with one button).
  "gsquad-reply-164": async () => (squadStore.get().in ? "open" : "unknown"),
  "squad-p1-board-168": async () => (!feature("squad-p1") || !feature("squad-p1-board") ? "unknown" : squadStore.get().in ? "open" : "unknown"),
  "gsquad-pieces-165": foldedUnlessTour(async () => (feature("gsquad-pieces") && squadStore.get().in ? "open" : "unknown")),
  "gsquad-v3-165": foldedUnlessTour(async () => (feature("gsquad-v3") && squadStore.get().in ? "open" : "unknown")),
  // PS 1.65 Receipts: only while the feature is on for an owner; Ok ends it for good.
  receipts: foldedUnlessTour(async (_can, s) => (s.status === "unlocked" && s.role === "owner" && receiptsOn(feature("receipts"), settingsData(s).receipts) ? "open" : "unknown")),
  // PS 1.65 Posture reminder: only while the feature is on and the person has not switched it off; Ok ends it for good.
  "posture-165": foldedUnlessTour(async (_can, s) => (feature("posture-reminder") && posturePrefs(settingsData(s).posture).on ? "open" : "unknown")),
  // PS 1.65 Checklist reminder: shown only while the feature is on; Ok ends it for good.
  "checklist-165": foldedUnlessTour(async () => (feature(CHK_FEATURE) ? "open" : "unknown")),
  // PS 1.65 stacked notifications: only on the Mac, and only while its switch is on.
  "notif-stack-165": foldedUnlessTour(async () => (PS && feature("notif-stack") ? "open" : "unknown")),
  // PS 1.65 Activity monitor: only on a Mac with the feature on and the person's own switch on; Ok ends it for good.
  "activity-monitor-165": foldedUnlessTour(async (_can, s) => (PS && feature("activity-monitor") && settingsData(s).activityMonitor !== false ? "open" : "unknown")),
  // PS 1.65 G Squad DMs, groups and pictures: only once the hub answers for them (until the developer deploys it, it just waits), for people in a squad.
  "gsquad-dm": foldedUnlessTour(async () => (feature("gsquad-dm") && squadStore.get().in && chatStore.get().dm === true ? "open" : "unknown")),
  // PS 1.65 Proton Mail through Bridge: only on a Mac with the feature on, and only until Bridge is linked (a link retires it for good).
  "proton-bridge-165": foldedUnlessTour(async () => (!PS || !feature(PROTON_FEATURE) ? "unknown" : protonMirror.get().status.linked ? "done" : "open")),
  // PS 1.65 Auto approve defaults: only on a Mac with the feature on, and while one of its switches still has no choice on THIS Mac
  // (each Mac shows it once; a Turn off given on another Mac reaches this one through approveOff and retires it). Saves nothing.
  [APPROVE_INTRO.id]: async (_can, s) => (!PS || !feature(APPROVE_FEATURE) ? "unknown" : approveIntroProbe(macApprove(), settingsData(s).approveOff)),
  // PS 1.65 Settings assistant: while the feature and its switch are on; Ok ends it for good.
  "settings-assistant-165": foldedUnlessTour(async (_can, s) => (feature("settings-assistant") && s.status === "unlocked" && assistPrefs(settingsData(s).assistant).on ? "open" : "unknown")),
  // PS 1.70 the day countdown: while the feature is on for an owner; Ok ends it for good.
  "day-countdown-170": async (_can, s) => (feature(CD_FEATURE) && s.status === "unlocked" && s.role === "owner" ? "open" : "unknown"),
  // PS 1.68 streaks on repeating tasks: only while the feature is on, for an owner; Ok ends it for good.
  "task-streaks-168": async (_can, s) => (feature("task-streaks") && s.status === "unlocked" && s.role === "owner" ? "open" : "unknown"),
  // PS 1.74 only the task on the closed island: only on a Mac (the island is the Mac's), while the feature is on for an owner; Ok ends it for good.
  // PS 1.75 scheduled tasks: while the feature is on for an owner; Ok ends it for good.
  // Off by default, so it is an offer: shown while it is off for an owner, done once they switched it on themselves.
  "scheduled-tasks-175": async (_can, s) => (s.status !== "unlocked" || s.role !== "owner" ? "unknown" : feature("scheduled-tasks") ? "done" : "open"),
  "island-task-only-174": async (_can, s) => (PS && feature(TASK_ONLY_FEATURE) && s.status === "unlocked" && s.role === "owner" ? "open" : "unknown"),
  screenrec: async () => { askScreenRec(); return introAudience({ mac: PS, st: screenRecNow() }); },
  whatsapp: async (can) => {
    if (!can) return "unknown";   // no own Supabase project to link (yet): wait and look again, never retire for good on what may be a still loading vault
    const st = await readWaStatus();
    return !st ? "unknown" : st.linked ? "done" : "open";
  },
};

/** The Mac's Auto approve state (psSettings.autoApprove), cleaned. Undefined until the Mac sent it. */
const macApprove = (): ApproveState | undefined => cleanApprove((psSettingsNow() as { autoApprove?: unknown } | null)?.autoApprove);
/** A choice card's switches as they stand on this device (only the ones still open here), instead of the card's own list. */
const PICKS_NOW: Record<string, () => IntroDef["picks"]> = {
  [APPROVE_INTRO.id]: () => approvePicksFor(macApprove()),
};

/** What a choice intro's answer does (core/featureintro.ts `choice`). Yes and No are both saved as the person's own answer. */
const CHOICES: Record<string, (yes: boolean, s: Snapshot, keep: string[]) => void> = {
  // Each switch still open on this Mac is sent as the person's own choice, quietly (the Mac saves it and asks macOS nothing). Keep it
  // on: the ticked ones stay on. What was turned off is saved with the person's settings, so every one of their Macs turns it off too.
  [APPROVE_INTRO.id]: (yes, s, keep) => {
    const sent = approveAnswer(!yes, keep, macApprove()?.unset ?? []);
    for (const a of sent) psPost({ type: "autoApprove:set", key: a.key, on: a.on, quiet: a.quiet });
    if (sent.some((a) => !a.on)) {
      const before = settingsData(s).approveOff;
      void saveSettings({ approveOff: approveOffAfter(before, sent) }).catch(() => { /* this Mac has it; the others ask themselves */ });
    }
  },
  // PS 1.66 Join The G Squad ask: Join sends the normal Ask to join (the same as Join on the G Squad screen; the admin still lets them in).
  // Both answers end it on every device of the person (introsDone), so Not now never asks again.
  [JOIN_ASK_ID]: (yes, s) => {
    if (yes) squadOp({ op: "rejoin" });
    const done = cleanDone(settingsData(s).introsDone);
    if (!done.includes(JOIN_ASK_ID)) void saveSettings({ introsDone: [...done, JOIN_ASK_ID] }).catch(() => { /* this device still never shows it again */ });
  },
  // PS 1.75 scheduled tasks: Turn on saves the same switch as Settings, Your list (squadFeatures, synced to the person's devices).
  "scheduled-tasks-175": (yes, s) => { if (yes) void saveSettings({ squadFeatures: { ...cleanSwitches(settingsData(s).squadFeatures), "scheduled-tasks": true } }).catch(() => { /* Settings still has the switch */ }); },
  "squad-p1": (yes, s) => { void saveSettings({ squadShare: { ...cleanShareOpts(settingsData(s).squadShare), p1: yes } }).catch(() => { /* asks again later */ }); },
};

/** Mounted once, next to the What's new panel (views/PsApp.tsx for the Mac, App.tsx for the website and the phone). */
export function FeatureIntroHost() {
  const s = useVault();
  const listShown = useOverlayShown();
  const welcome = useWelcomeShowing(), face = useFaceShowing(), wn = useWhatsNewShowing();
  const [state, setState] = useState<IntroState>(load);
  const stateRef = useRef(state);
  const [open, setOpen] = useState<IntroDef | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const probe = useRef<Record<string, "done" | "open" | "unknown">>({});
  const tourRef = useRef<TourStep[]>([]);
  const tourAt = useRef(0);   // the step a running tour is on, so one that was cut short goes on from there (this page only)
  const holdUntil = useRef(0);
  const probeAt = useRef<Record<string, number>>({});
  const lastInput = useRef(Date.now());
  const can = mailCan(s);
  const live = useRef({ s, listShown, welcome, face, wn, can });
  live.current = { s, listShown, welcome, face, wn, can };
  const commit = useCallback((f: (x: IntroState) => IntroState) => { const n = f(stateRef.current); stateRef.current = n; save(n); setState(n); }, []);

  // "Show the tour again" (Settings, About): forget the tour's answer so it is looked at again now (views/TourAgain.tsx).
  useEffect(() => {
    const again = () => {
      delete probe.current[TOUR_ID]; probeAt.current[TOUR_ID] = 0; holdUntil.current = 0; tourAt.current = 0;
      commit((x) => { const { [TOUR_ID]: _gone, ...recs } = x.recs; return { ...x, recs }; });
    };
    window.addEventListener("ps:tour-again", again);
    return () => window.removeEventListener("ps:tour-again", again);
  }, [commit]);

  // PS 1.65: a Turn off given on the notice on another of this person's Macs applies here too (only to a switch still on its default
  // here; a choice saved on this Mac stands). Sent once per switch while this page runs, quietly (the Mac asks macOS nothing).
  const synced = useRef(new Set<string>());
  useEffect(() => {
    if (!PS) return;
    const apply = () => {
      const L = live.current.s;
      if (L.status !== "unlocked" || !feature(APPROVE_FEATURE)) return;
      for (const a of approveSyncPosts(macApprove(), settingsData(L).approveOff)) {
        if (synced.current.has(a.key)) continue;
        synced.current.add(a.key);
        psPost({ type: "autoApprove:set", key: a.key, on: a.on, quiet: a.quiet });
      }
    };
    apply();
    return onPsSettings(apply);
  }, [s]);

  // 12b: the Mac's saved screen recording choice is read once, early, so the screen recording intro knows who said No (nothing from macOS).
  useEffect(() => { if (PS) askScreenRec(); }, []);

  // Any key, click, scroll or move is use. Nothing is read from what is typed (only that something happened).
  useEffect(() => {
    const t = () => { lastInput.current = Date.now(); };
    const ev = ["keydown", "pointerdown", "wheel", "pointermove", "touchstart"] as const;
    ev.forEach((e) => window.addEventListener(e, t, { passive: true, capture: true }));
    return () => ev.forEach((e) => window.removeEventListener(e, t, { capture: true }));
  }, []);

  // The one clock: count active use, and look every few seconds at whether an intro may show. Nothing here waits or loops on the main thread.
  useEffect(() => {
    let last = Date.now(), checking = false;
    const tick = () => {
      const now = Date.now(), L = live.current;
      const visible = document.visibilityState !== "hidden";
      commit((x) => addActive(x, { version: __PS_VERSION__.name, deltaMs: now - last, idleMs: now - lastInput.current, listShown: L.listShown && visible }));
      last = now;
      if (L.s.status !== "unlocked") return;
      const st = settingsData(L.s);
      const fullScreen = !!document.fullscreenElement;
      const cal = calendarSnap(L.s);
      const meeting = afkMeetWindows(meetingEvents(cal ? (cal.data as CalendarSnap).events : [], st.calChoices), st.meetHidden, now).some(([a, b]) => now >= a && now < b);
      // A tour that is running stops quietly when a meeting, Sleep mode, Sentry mode, Do Not Disturb or a full screen app begins. It comes back later.
      if (openRef.current?.tour && (meeting || sleepState().here || sentryUp() || dndActive(st.dnd, now) || fullScreen)) { setOpen(null); holdUntil.current = now + 60_000; return; }
      if (openRef.current || checking || now < holdUntil.current) return;
      const facts = {
        now,
        notForThem: INTROS.filter((d) => probe.current[d.id] === "done" || probe.current[d.id] === "unknown").map((d) => d.id),
        islandBusy: L.welcome || L.face || L.wn || popupOn() || tipOn() || walkOn() || !!islandCards.queue.active || islandCards.queue.waiting.length > 0,
        sleep: sleepState().here, sentry: sentryUp(), dnd: dndActive(st.dnd, now), sharing: false, fullScreen, meeting,
        off: !feature("feature-intros"),
      };
      // "Did they already do it?" is read for the intro that is next in line, only once the clock says it could show (one small read,
      // again after 5 minutes). Unknown (the read failed) never shows on a guess.
      // 12b: the first intro whose read is due (an intro that is waiting for its next read never blocks the ones behind it).
      const pending = INTROS.find((d) => !stateRef.current.recs[d.id]?.closed && probe.current[d.id] !== "done" && !!DONE_PROBES[d.id]
        && (probe.current[d.id] === undefined || now >= (probeAt.current[d.id] ?? 0)));
      const read = pending ? DONE_PROBES[pending.id] : undefined;
      if (pending && read && stateRef.current.activeMs >= 55_000) {
        checking = true; probeAt.current[pending.id] = now + 5 * 60_000;
        void read(live.current.can, live.current.s).then((r) => {
          probe.current[pending.id] = r;
          if (r === "done") commit((x) => retire(x, pending.id, Date.now()));
        }).catch(() => { probe.current[pending.id] = "unknown"; }).finally(() => { checking = false; });
        return;
      }
      const pick = nextIntro(stateRef.current, facts);
      if (!pick) return;
      if ("wait" in pick) { if (pick.wait !== "notActive") holdUntil.current = now + Math.min(recheckMs(pick.wait), 60_000); return; }
      if (pick.show.tour) {
        tourRef.current = tourListFor(L.s);
        if (!tourRef.current.length) { probe.current[pick.show.id] = "unknown"; return; }
      }
      const picks = PICKS_NOW[pick.show.id]?.();
      if (picks && !picks.length) { probe.current[pick.show.id] = "unknown"; return; }   // nothing left to ask on this device
      setOpen(picks ? { ...pick.show, picks } : pick.show);
    };
    const t = window.setInterval(tick, 5000);
    return () => window.clearInterval(t);
  }, [commit]);

  // The tour running marks the intros it replaces done, so no separate card ever follows it.
  const onShown = useCallback((id: string) => {
    // PS 1.65: the Auto approve defaults count on this Mac only from the moment its notice was shown here.
    if (id === APPROVE_INTRO.id) psPost({ type: "autoApprove:noticed" });
    commit((x) => { const n = markShown(x, id, Date.now()); return id === TOUR_ID ? retireFolded(n, Date.now()) : n; });
  }, [commit]);
  const onAnswer = useCallback((id: string, a: "show" | "later") => {
    commit((x) => answer(x, id, a));
    // A one button notice: Ok is the end of it on every device of this person (saved with their settings).
    if (INTROS.find((d) => d.id === id)?.ack) {
      const done = cleanDone(settingsData(live.current.s).introsDone);
      if (!done.includes(id)) void saveSettings({ introsDone: [...done, id] }).catch(() => { /* this device still never shows it again */ });
    }
    // PS 1.65 the tour: Done or Esc ends it for good on every device of this person, and a "show it again" request is used up.
    if (id === TOUR_ID) {
      tourAt.current = 0;
      try { localStorage.removeItem(AGAIN_KEY); } catch { /* fine */ }
      const done = cleanDone(settingsData(live.current.s).introsDone);
      if (!done.includes(id)) void saveSettings({ introsDone: [...done, id] }).catch(() => { /* this device still never shows it again */ });
    }
  }, [commit]);
  const onChoose = useCallback((id: string, yes: boolean, keep: string[]) => { CHOICES[id]?.(yes, live.current.s, keep); }, []);
  const onGone = useCallback((why?: string) => {
    setOpen(null);
    holdUntil.current = Date.now() + (why ? recheckMs("busy") : 15_000);
  }, []);
  if (!open) return null;
  return <IntroStage key={open.id} def={open} tour={tourRef.current} tourAt={tourAt.current} onTourStep={(i) => { tourAt.current = i; }} onShown={onShown} onAnswer={onAnswer} onChoose={onChoose} onGone={onGone} />;
}

type Phase = "ask" | "card" | "guide" | "out";
/** The logo moment's card width and logo size (points). */
const ACK_W = 260, LOGO_PX = 92;

function IntroStage({ def, tour, tourAt = 0, onTourStep, onShown, onAnswer, onChoose, onGone }: { def: IntroDef; tour: TourStep[]; tourAt?: number; onTourStep?: (i: number) => void; onShown: (id: string) => void; onAnswer: (id: string, a: "show" | "later") => void; onChoose: (id: string, yes: boolean, keep: string[]) => void; onGone: (why?: string) => void }) {
  const viaIsland = PS && feature("island-moments");
  const [kept, setKept] = useState<string[]>(() => (def.picks ?? []).map((p) => p.id));   // PS 1.65: the switches the card keeps on
  // The page's own queue first (a web card of this page goes before it), then on the Mac the island's queue.
  const turn = useIslandTurn(`intro:${def.id}`, true, "low");
  const [phase, setPhase] = useState<Phase>("ask");
  const [anchor, setAnchor] = useState<IslandAnchor | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const asked = useRef(false);
  const [guide, setGuide] = useState(false);
  const [ti, setTi] = useState(() => resumeAt(tourAt, tour.length));   // a tour cut short goes on where it was
  const vault = useVault();

  useEffect(() => {
    if (!turn || asked.current) return;
    asked.current = true;
    // Its turn may come long after the clock said yes (another card held the page queue): the quiet places are looked at once more now.
    if (dndActive(settingsData(vault).dnd, Date.now()) || sleepState().here || sentryUp() || !!document.fullscreenElement) { onGone("busy"); return; }
    if (!PS) { setPhase("card"); return; }
    const g = window as Window & { __psIntroIsland?: (m: unknown) => void };
    let timer = window.setTimeout(() => onGone("noanswer"), ISLAND_ASK_MS);
    g.__psIntroIsland = (m) => {
      const r = introReply(m);
      if (!r) return;
      window.clearTimeout(timer);
      if (r.phase === "queued") timer = window.setTimeout(() => onGone("queued"), ISLAND_QUEUED_MS);
      else if (r.phase === "blocked") onGone(r.why);
      else { setAnchor(viaIsland ? r.anchor : null); setPhase("card"); }
    };
    psPost({ type: "island:intro", start: true, id: def.id });
    return () => { window.clearTimeout(timer); };
  }, [turn]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving always frees the Mac's island (its queue moves on).
  useEffect(() => () => { const g = window as Window & { __psIntroIsland?: unknown }; delete g.__psIntroIsland; if (PS) psPost({ type: "island:intro", start: false, id: def.id }); }, [def.id]);

  const shownOnce = useRef(false);
  useEffect(() => {
    if (phase !== "card" || shownOnce.current) return;
    shownOnce.current = true;
    onShown(def.id);
    if (def.ack) return;   // V1.62 the logo moment chimes as the logo lands (below)
    if (!PS) sfx.island("done");   // on the Mac the island plays the chime itself (its Island sounds switch)
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // V1.62 the logo moment: a soft chime as the logo lands out of the island (the Island sounds switch, never in Do Not Disturb).
  // On the Mac PS plays it (sfx goes to the app by name); its own chime already marked the island's bounce.
  useEffect(() => {
    if (phase !== "card" || !def.ack) return;
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => {
      const st = settingsData(vault);
      if (logoChime({ islandSounds: islandPrefs(st.island).sounds, dnd: dndActive(st.dnd, Date.now()) })) sfx.island("done");
    }, calm ? 0 : LOGO_MOMENT.land);
    return () => window.clearTimeout(t);
  }, [phase === "card"]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (a: "show" | "later", yes = true) => {
    if (phaseRef.current === "out") return;
    if (def.tour) a = "show";   // PS 1.65: Next moves on in the card, Done and Esc end the tour for good
    if (def.choice && a === "show") onChoose(def.id, yes, kept);   // PS 1.63: Yes or No is the end of it, no guide
    if (def.ack) a = "show";   // V1.62: a one button notice has no Later: Ok, Esc and Back all close it for good
    onAnswer(def.id, a);
    if (a === "show" && !def.ack && !def.choice) { setGuide(true); setPhase("guide"); return; }
    setPhase("out");
    const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The logo moment: the logo goes back into the island first, then the card folds back up (then the island shrinks back).
    window.setTimeout(() => onGone(), quick ? (def.ack ? 220 : 0) : def.ack ? LOGO_MOMENT.backCard : 340);
  };
  const closeGuide = useCallback(() => { setGuide(false); onGone(); }, [onGone]);

  // Esc (Mac, website) and Back (phone) close the card. The guide has its own (it is the one on top then).
  useLayoutEffect(() => {
    if (phase !== "card") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish("later"); } };
    const back = (e: Event) => { e.preventDefault(); finish("later"); };
    const g = window as Window & { __psDimxClose?: () => boolean };
    const before = g.__psDimxClose;
    const esc = () => { finish("later"); return true; };
    window.addEventListener("keydown", key, true); window.addEventListener("gos-back", back);
    g.__psDimxClose = esc;
    return () => {
      window.removeEventListener("keydown", key, true); window.removeEventListener("gos-back", back);
      if (g.__psDimxClose === esc) { if (before) g.__psDimxClose = before; else delete g.__psDimxClose; }
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Mac keeps the list up and gives it the keyboard while the card or guide is open (never over 1Password or Signal, PS checks).
  // PS 1.65: a choice card never takes the keyboard (quiet): it has only buttons, and Esc reaches it through PS's own Esc.
  useLayoutEffect(() => {
    if (phase !== "card" && phase !== "guide") return;
    psPost({ type: "dimx", open: true, ...(def.choice && phase === "card" ? { quiet: true } : {}) });
    return () => { psPost({ type: "dimx", open: false }); };
  }, [phase === "card" || phase === "guide"]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === "guide" && guide) {
    return createPortal(def.guide ? GUIDES[def.guide]({ onClose: closeGuide, anchor }) : <StepsGuide def={def} onClose={closeGuide} anchor={anchor} />, document.body);
  }
  if (phase !== "card" && phase !== "out") return null;
  const at = anchor ? attachedLayout(anchor, window.innerWidth, def.ack ? ACK_W : CARD_W) : null;
  const hung = at ? ({ "--fi-left": `${at.left}px`, "--fi-top": `${at.top}px`, "--fi-ox": `${at.originX}px`, "--fi-from": at.from } as CSSProperties) : undefined;
  return createPortal(
    <div className={`fi-layer${at ? " isl" : " plain"}${def.ack ? " fi-ack" : ""}${phase === "out" ? " out" : ""}`} style={hung} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <section className={`fi-card${def.picks ? " calm" : ""}`} role="dialog" aria-modal="true" aria-labelledby="fi-title" style={{ "--fi-w": `${Math.min(def.ack ? ACK_W : CARD_W, window.innerWidth - 16)}px` } as CSSProperties}>
        {def.ack ? (
          // V1.62 the logo moment: the logo comes out of the island, big, with a shine; the words under it.
          <>
            <span className="fi-logo" aria-hidden="true"><span className="fi-logo-glow" />{MARKS[def.mark](LOGO_PX)}<span className="fi-logo-shine" /></span>
            <b id="fi-title" className="fi-head">{def.headline}</b>
          </>
        ) : (
          <div className="fi-row">
            <span className="fi-mark" aria-hidden="true">{MARKS[def.mark](30)}</span>
            <b id="fi-title" className="fi-head">{def.headline}</b>
          </div>
        )}
        {def.tour && tour[ti] && (
          <div className="fi-tour" key={ti} aria-live="polite">
            <p className="fi-count">{TOUR_WORDS.count(ti, tour.length)}</p>
            <b className="fi-step">{tour[ti].title}</b>
            <p className="fi-ask">{tour[ti].line}</p>
            <p className="fi-where">{tour[ti].where}</p>
          </div>
        )}
        {def.ask && <p className="fi-ask">{def.ask}</p>}
        {def.picks && (
          // PS 1.65: one quiet row per switch, a thin switch on the right (no focus taken, a click flips it).
          <div className="fi-picks" role="group" aria-label={def.headline}>
            {def.picks.map((p) => {
              const on = kept.includes(p.id);
              return (
                <button key={p.id} type="button" role="switch" aria-checked={on} className={`fi-pick${on ? " on" : ""}`}
                  onClick={() => { sfx.hover(); setKept((k) => (k.includes(p.id) ? k.filter((x) => x !== p.id) : [...k, p.id])); }}>
                  <span>{p.label}</span><i className="fi-sw" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {def.tour && (
          <div className="fi-btns">
            {/* The tour takes no focus (a choice card, no autofocus). Next moves on, Done and Esc end it for good. */}
            <button type="button" className="fi-btn go" onClick={() => { sfx.click(); const n = stepAfter(ti, tour.length); if (n === null) finish("show"); else { setTi(n); onTourStep?.(n); } }}>{buttonWord(ti, tour.length)}</button>
          </div>
        )}
        <div className="fi-btns" hidden={!!def.tour}>
          <button type="button" className="fi-btn go" autoFocus={!def.choice} onClick={() => { sfx.click(); finish("show"); }}>{def.show}</button>
          {!def.ack && def.later && <button type="button" className="fi-btn" onClick={() => { sfx.click(); if (def.choice) finish("show", false); else finish("later"); }}>{def.later}</button>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** The guide for an intro that has no guide of its own: its short steps, a demo link, and where it stays in Settings. */
function StepsGuide({ def, onClose, anchor }: { def: IntroDef; onClose: () => void; anchor: IslandAnchor | null }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const back = (e: Event) => { e.preventDefault(); onClose(); };
    window.addEventListener("keydown", key, true); window.addEventListener("gos-back", back);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("gos-back", back); };
  }, [onClose]);
  const at = anchor ? attachedLayout(anchor, window.innerWidth, CARD_W) : null;
  const hung = at ? ({ "--fi-left": `${at.left}px`, "--fi-top": `${at.top}px`, "--fi-ox": `${at.originX}px`, "--fi-from": at.from } as CSSProperties) : undefined;
  return (
    <div className={`fi-layer${at ? " isl" : " plain"}`} style={hung} onMouseDown={(e) => e.stopPropagation()}>
      <section className="fi-card" role="dialog" aria-modal="true" aria-label={def.headline} style={{ "--fi-w": `${Math.min(CARD_W, window.innerWidth - 16)}px` } as CSSProperties}>
        <div className="fi-row"><span className="fi-mark" aria-hidden="true">{MARKS[def.mark](30)}</span><b className="fi-head">{def.headline}</b></div>
        <ol className="fi-steps">{(def.steps ?? []).map((t, i) => <li key={i}>{t}</li>)}</ol>
        <p className="fi-ask">You can open this again any time: {def.settings}.</p>
        <div className="fi-btns">
          {def.demo && <a className="fi-btn go" href={def.demo} target="_blank" rel="noreferrer noopener">See the demo</a>}
          <button type="button" className="fi-btn" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
