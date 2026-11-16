// PS, the Mac app: the To-do page on its own (no other pages), plus the floating Tab window.
// Same code and same encrypted vault as the website; see src/ps.ts for the bridge.
import { useEffect, useState, type ReactNode } from "react";
import { TodoView } from "./Todo";
import { PsSettingsView } from "./PsSettings";
import { Overlay, TaskMap, closeAddTask, openMoreSettings, resetKeep, taskMapActions } from "./TaskMap";
import { onOverlayShown, psLock, psOverlayShown, psPost, psTouchUnlock, setPsOverlayShown, usePsOpen, usePsTab, usePsTouchLocked } from "../ps";
import { pinHeld, pinListHidden, pinListShown, restorePin, startPins } from "../ui/pin";
import { escProbing } from "../ui/escape";
import { endDayGate } from "../rulegate";
import { LockScreen } from "./Lock";
import { PsTouchUnlock } from "./PsTouchUnlock";
import { RuleBookHost } from "./RuleBook";
import { Icon, useVault } from "../ui/kit";
import { secondActions } from "./Second";
import { SecondWindow } from "./SecondWindow";
import { MacUpdateRow } from "./MacUpdate";
import { putDrop } from "../second/drops";
import { installDropZones } from "../second/dragzone";
import { runSecondOp, sendFile } from "../second/store";
import { WhatsNewHost } from "./WhatsNew";
import { FeatureIntroHost } from "./FeatureIntro";
import { TipsHost } from "./Tips";
import { NewPopupsHost } from "./NewPopups";
import { WalkthroughHost } from "./Walkthrough";
import { startSetupDoor, WelcomeHost } from "./Welcome";
import { UpdateFace } from "./UpdateFace";
import "./ps.css";
import { appName, macListHint } from "../core/appname";
import { secondOnSnap } from "../core/secondsnap";

export function PsLayout({ tools }: { tools: ReactNode }) {
  const [view, setView] = useState<"todo" | "settings">("todo");
  // Fitness left this page on 2 Nov 2026: it is a screen inside the Tab list now (fitness/FitnessButton.tsx).
  // V1.23: this page runs hidden as PS's engine. Reaching it means the sign in is finished (and any new
  // recovery key was shown first, App.tsx Vaulted), so PS can put the small Sign in window away.
  useEffect(() => { psPost({ type: "signin:done" }); }, []);
  useEffect(() => {   // Second Computer: the main window holds the vault, so its panel runs the ops itself
    secondActions.run = runSecondOp;
    secondActions.drop = async (f) => { void sendFile(f); return null; };
    secondActions.native = psPost;
  }, []);
  return (
    <>
      <header className="top">
        <div className="wrap">
          <span className="brand">{appName()} <small>{view === "settings" ? "SETTINGS" : "TO-DO"}</small></span>
          <span className="spacer" />
          {tools}
          <PsTabToggle />
          <button className="btn quiet icon" onClick={psLock} title={`Lock: Touch ID or your Mac password opens ${appName()} again`} aria-label={`Lock ${appName()}`}><Icon name="lock" /></button>
          <button className="btn quiet icon" onClick={() => setView(view === "settings" ? "todo" : "settings")}
            aria-pressed={view === "settings"} title={view === "settings" ? "Back to your to-do list" : `${appName()} settings`} aria-label={`${appName()} settings`}>
            <Icon name="settings" />
          </button>
        </div>
      </header>
      <main className="page wrap">
        <TabBanner />
        {view === "settings" ? <PsSettingsView onBack={() => setView("todo")} /> : <TodoView />}
      </main>
      <TaskMap />
      <RuleBookHost owner="docked" />
    </>
  );
}

/** The Second Computer window (views/SecondWindow.tsx): no keys here either; actions go to the main window. */
export function PsSecondWindow() {
  const s = useVault();
  useEffect(() => {
    secondActions.run = (o) => psPost({ type: "looks", patch: { secondOp: o } });
    secondActions.drop = (f) => putDrop(f).catch(() => null);
    secondActions.native = psPost;   // PS's Open panel and drag out (v1.2)
    installDropZones();              // PS asks this page what is under a drag (second/dragzone.ts)
    document.documentElement.style.background = "#141016";
  }, []);
  const tab = location.hash.replace(/^#/, "") || undefined;
  if (s.status !== "unlocked") return <div className="sw-locked">{appName()} is locked. Unlock it to use Second Computer.</div>;
  if (!secondOnSnap(s)) return null;   // PS 1.65: everyone's, once switched on (core/secondswitch.ts); the developer's alone V1.42 to V1.64
  return <SecondWindow s={s} initial={tab} />;
}

// The see-through window that floats over every app while Tab is held. It holds no keys:
// the main PS window hands it the list and saves the ticks.
export function PsOverlay() {
  const s = useVault();
  // The window stays alive (invisible) between shows. When it hides, start fresh next time:
  // no half-open menus, editors or time zone panels left over.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    (window as Window & { __psOverlayHidden?: () => void }).__psOverlayHidden = () => {
      // A screen is pinned (double click on its top bar, ui/pin.ts): leave the list exactly as it
      // is, so the next hold of Tab or / shows the screen at once with its scroll and state.
      if (pinHeld()) {
        pinListHidden();
        resetKeep();
        setPsOverlayShown(false);
        return;
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
      resetKeep();   // PS put the list away (eg the Mac locked): Keep and Hover mode start off next time
      closeAddTask();   // and the Add task window with it
      openMoreSettings(false);   // and More settings
      setPsOverlayShown(false);   // backgrounds and thunder stop while the list is hidden
      setGen((g) => g + 1);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.background = "transparent";
    document.body.style.background = "transparent";
    taskMapActions.tick = async (id, done) => psPost({ type: "tick", id, ...(typeof done === "boolean" ? { done } : {}) });   // says which way (V1.34)
    // The Completed section and the right click menu (core/completed.ts): the main window runs them on the newest copy.
    taskMapActions.tickMany = async (ids, done) => psPost({ type: "looks", patch: { todoOp: { op: "done", ids, done } } });
    taskMapActions.clearDone = async (ids, on) => psPost({ type: "looks", patch: { todoOp: { op: on ? "clear" : "unclear", ids } } });
    taskMapActions.revive = async (ids) => psPost({ type: "looks", patch: { todoOp: { op: "revive", ids } } });
    taskMapActions.bury = async (ids, cleared) => psPost({ type: "looks", patch: { todoOp: { op: "bury", ids, cleared } } });
    taskMapActions.restore = async (id, data) => psPost({ type: "looks", patch: { todoOp: { op: "restore", id, data } } });
    taskMapActions.work = async (id) => psPost({ type: "work", id });
    taskMapActions.reorder = async (ids, p1) => psPost({ type: "reorder", ids, p1 });
    taskMapActions.p1Style = async (id) => psPost({ type: "p1Style", id });
    taskMapActions.looks = async (patch) => psPost({ type: "looks", patch });
    taskMapActions.scale = async (v) => psPost({ type: "tmScale", v });
    taskMapActions.clockScale = async (v) => psPost({ type: "tmClockScale", v });
    taskMapActions.update = async (id, patch) => psPost({ type: "update", id, patch });
    // Mini tasks: the main window applies the op to the newest copy (the list rides along for the test copy).
    taskMapActions.sub = async (id, op, next) => psPost({ type: "update", id, patch: { subOp: op, subtasks: next } });
    taskMapActions.remove = async (id) => psPost({ type: "remove", id });
    taskMapActions.aware = async (list) => psPost({ type: "aware", list });
    taskMapActions.dimx = async (list) => psPost({ type: "dimxList", list });
    taskMapActions.rules = async (list) => psPost({ type: "looks", patch: { rules: list } });   // the rule book: the main window saves it
    taskMapActions.moveTasks = async (m, make) => psPost({ type: "looks", patch: { taskMove: { ...m, ...(make ? { make } : {}) } } });   // Tab list groups (core/groups.ts)
    taskMapActions.ungroup = async (id) => psPost({ type: "looks", patch: { ungroup: id } });
    taskMapActions.dnd = async (o) => psPost({ type: "looks", patch: { dndOp: o } });
    secondActions.run = (o) => psPost({ type: "looks", patch: { secondOp: o } });   // Second Computer: the main window runs it
    secondActions.drop = (f) => putDrop(f).catch(() => null);                          // a dropped file goes over through IndexedDB
    secondActions.native = psPost; installDropZones();                                  // v1.2: PS takes drops on the Second panel itself   // Do Not Disturb: the main window applies it (core/dnd.ts)
    taskMapActions.awareDone = async (id, todoId) => psPost({ type: "awareDone", id, todoId });
    taskMapActions.awareUndone = async (item, index, todoId) => psPost({ type: "awareUndone", item, index, todoId });
    taskMapActions.awareToList = async (id, order, type, p1) => psPost({ type: "awareToList", id, order, kind: type, p1: !!p1 });
    taskMapActions.suggest = async (id, action, place, zone) => psPost({ type: "suggest", id, action, place, zone });
    taskMapActions.inboxMin = async (at) => psPost({ type: "inboxMin", at });
    taskMapActions.replyHandled = async (id) => psPost({ type: "replyHandled", id });
    // The email panel's Reply and a lead's Done: the main window has the vault and opens the reply panel (src/replyengine.ts).
    taskMapActions.replyOpen = async (cardId) => psPost({ type: "looks", patch: { replyOpen: cardId } });
    // V1.59 Reply in the email panel: the box's Send after its Undo; the main window builds it and sends it on its way.
    taskMapActions.replyInline = async (cardId, text, id) => psPost({ type: "looks", patch: { replyInline: { cardId, text, id } } });
    taskMapActions.leadDone = async (cardId) => psPost({ type: "looks", patch: { leadDone: cardId } });
    // WhatsApp in the same panel: the main window holds the vault and the session, and runs it (src/ps.ts).
    taskMapActions.waSend = async (chatId, text) => psPost({ type: "looks", patch: { waOp: { op: "send", chatId, text } } });
    taskMapActions.waTemplate = async (chatId, name, language) => psPost({ type: "looks", patch: { waOp: { op: "template", chatId, name, language } } });
    taskMapActions.waDone = async (chatId) => psPost({ type: "looks", patch: { waOp: { op: "done", chatId } } });
    taskMapActions.workStyle = async (style) => psPost({ type: "workStyle", style });
    taskMapActions.reset = async () => psPost({ type: "reset" });
    taskMapActions.undoReset = async () => psPost({ type: "resetUndo" });
    taskMapActions.notifyPref = async (on) => psPost({ type: "notifyPref", on });
    taskMapActions.stHours = async (v) => psPost({ type: "stHours", v });
    taskMapActions.backdrop = async (v, save) => psPost({ type: "backdrop", v, save });
    taskMapActions.keep = async (on, stay) => psPost(stay ? { type: "keep", on, stay: true } : { type: "keep", on });   // stay: leaving Edit (V1.57)
    taskMapActions.goals = async (list) => psPost({ type: "goals", list });
    // Series map notes and month titles (the Map pill): the main window saves them.
    taskMapActions.journal = async (key, patch) => psPost({ type: "looks", patch: { journalOp: { key, ...patch } } });
    taskMapActions.away = async (patch) => psPost({ type: "awayPatch", ...patch });
    // The Meetings panel's X, Undo and refresh, and the gym card's Acknowledge: the main window saves them.
    taskMapActions.meetHide = async (o) => psPost({ type: "looks", patch: { meetHideOp: o } });
    taskMapActions.calRefresh = async () => psPost({ type: "looks", patch: { calRefresh: true } });
    taskMapActions.calLink = async (url, feed) => psPost({ type: "looks", patch: { calLink: url, ...(feed ? { calFeed: feed } : {}) } });   // answered through the state's cal
    taskMapActions.gymAck = async (day) => psPost({ type: "looks", patch: { gymAck: day } });
    // Typing in the floating list: PS keeps it open and sends the keys to it.
    taskMapActions.editing = (on) => psPost({ type: "edit", on });
    taskMapActions.clearClipboard = async () => psPost({ type: "clipboard:clear" });
    taskMapActions.headline = async (text) => psPost({ type: "headline", text });
    taskMapActions.add = async (t) => psPost({ type: "add", title: t.title, due: t.due, kind: t.type, order: t.order, repeat: t.repeat ?? null, p1: t.p1 ?? false, clientId: t.clientId ?? null, notes: t.notes ?? null, unranked: t.unranked === true,
      ...(t.sqOn === true ? { sqOn: true } : {}), ...(typeof t.sqAnon === "boolean" ? { sqAnon: t.sqAnon } : {}), ...(t.group ? { group: t.group } : {}), ...(t.remind ? { remind: t.remind } : {}) });
    taskMapActions.sound = async (patch) => psPost({ type: "sound", ...patch });
    taskMapActions.homeTz = async (id) => psPost({ type: "homeTz", id });
    taskMapActions.timelines = async (list) => psPost({ type: "timelines", list });
    taskMapActions.timelineOrder = async (ids) => psPost({ type: "timelineOrder", ids });
    taskMapActions.timelineHidden = async (ids) => psPost({ type: "timelineHidden", ids });
    taskMapActions.meetingNotes = async (patch) => psPost({ type: "meetingNotes", list: patch.meetingNotes, standing: patch.standingNotes });
    root.classList.add("ps-overlay");
    startPins();
    const unShown = onOverlayShown(() => { if (psOverlayShown()) pinListShown(); });
    // A real Esc only reaches this page when PS's key monitor missed it: nothing used it, so the list goes.
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !escProbing() && !e.defaultPrevented) psPost({ type: "close" }); };
    window.addEventListener("keydown", esc);
    psPost({ type: "overlayReady" });
    const unDoor = startSetupDoor();   // V1.40: PS may offer the setup menu after an update, and its button opens it
    return () => { window.removeEventListener("keydown", esc); unShown(); unDoor(); };
  }, []);
  // The list is (back) up after a restart or an unlock: open the pinned screen again while hidden.
  useEffect(() => { if (s.status === "unlocked") void restorePin(); }, [s.status]);
  const close = () => psPost({ type: "close" });
  if (s.status !== "unlocked") return <OverlayLocked onClose={close} />;
  return (
    <>
      <Overlay key={gen} onClose={close} hint="Let go of Tab to close. Click a task to work on it, tick it off, or drag it to set its priority." controls={<OverlayControls inline />} />
      <WhatsNewHost />
      <FeatureIntroHost />{/* "Did you know?" intros from the island, one at a time (views/FeatureIntro.tsx, PS 1.60) */}
      <WelcomeHost />{/* the welcome tour, once on every account (views/Welcome.tsx, G Squad) */}
      <UpdateFace />{/* the update card on the list itself (V1.40, the developer: "I want it to be in your face") */}
      <TipsHost />{/* the first use tips (V1.55): gentle, one at a time, once per account (views/Tips.tsx) */}
      <NewPopupsHost />{/* the "new in this version" pop-ups (V1.56): AI task API, Auto approve, open source, after What's new (views/NewPopups.tsx) */}
      <WalkthroughHost />{/* the "what is new" walkthrough (V1.58): the island's grey bar menu, its settings, Pomodoro, Stand-up and more, after What's new (views/Walkthrough.tsx) */}
    </>
  );
}

// Locked or signed out (V1.23: no main window to sign in from). Locked: Touch ID right here.
// Signed out: the sign in window (ps-mac shows the engine page's own sign in, so the passphrase never
// passes through this page or PS itself).
function OverlayLocked({ onClose }: { onClose: () => void }) {
  const locked = usePsTouchLocked();
  return (
    <div className="tm-overlay" onMouseDown={onClose}>
      <div className="tm-inner">
        <div className="ps-locked" onMouseDown={(e) => e.stopPropagation()}>
          <span className="tm-eyebrow">{appName()}</span>
          <h2 className="ps-locked-t">{locked ? `${appName()} is locked` : `${appName()} is signed out`}</h2>
          <span className="tm-hint">{locked ? "Touch ID or your Mac password opens your list again." : "Sign in once and your list, cards and island come back."}</span>
          <span className="ps-locked-acts">
            {locked && <button type="button" className="ps-ovl-btn primary" onClick={psTouchUnlock}>Unlock with Touch ID</button>}
            <button type="button" className={locked ? "ps-ovl-btn" : "ps-ovl-btn primary"} onClick={() => psPost({ type: "signin:show" })}>
              {locked ? "Use my passphrase" : "Sign in"}
            </button>
          </span>
          {/* Updates reach a signed out PS too (6 Nov 2026: someone with no account yet must still get the version
              that lets them connect their own Supabase). The gear menu is not here, so its update row is. */}
          {!locked && <div className="ps-locked-upd"><MacUpdateRow menuOpen /></div>}
        </div>
      </div>
      <OverlayControls />
    </div>
  );
}

// Top right of the floating window: Tab on/off and Lock.
function OverlayControls({ inline }: { inline?: boolean }) {
  const s = useVault();
  return (
    <div className={inline ? "ps-ovl-ctl inline" : "ps-ovl-ctl"} onMouseDown={(e) => e.stopPropagation()}>
      <PsTabToggle dark />
      {s.status === "unlocked" && (
        <button className="ps-ovl-btn" onClick={psLock} title={`Lock: Touch ID or your Mac password opens ${appName()} again`} aria-label={`Lock ${appName()}`}>
          <Icon name="lock" /> Lock
        </button>
      )}
    </div>
  );
}

// The Tab switch: on = hold Tab over any app shows your list; off = Tab is left alone everywhere.
export function PsTabToggle({ dark }: { dark?: boolean }) {
  const tab = usePsTab();
  const on = tab?.enabled ?? true;
  return (
    <button className={dark ? `ps-ovl-btn ps-tab${on ? " on" : ""}` : `btn quiet sm ps-tab${on ? " on" : ""}`}
      onClick={() => psPost({ type: "tab:set", enabled: !on })} aria-pressed={on}
      title={on ? "Tab overlay is on: hold Tab over any app. Click to turn it off." : "Tab overlay is off. Click to turn it on."}>
      <span className="ps-tab-key">Tab</span> {on ? "On" : "Off"}
    </button>
  );
}

// Main window: shown when the Tab overlay is on but macOS has not allowed it yet.
function TabBanner() {
  const tab = usePsTab();
  if (!tab || !tab.enabled || tab.trusted) return null;
  return (
    <div className="banner ps-banner">
      <Icon name="lock" />
      <span>Tab over other apps is off. Turn on {appName()}{macListHint()} in Device Control and Data Access (Privacy &amp; Security).</span>
      <span className="row" style={{ gap: 8 }}>
        <button className="btn sm primary" onClick={() => psPost({ type: "tab:fix" })}
          title={`Clears ${appName()}'s old permission entry and asks macOS for a fresh one. Then switch ${appName()} on in the list.`}>Fix permission</button>
        <button className="btn sm" onClick={() => psPost({ type: "tab:permission" })}>Open Settings</button>
      </span>
    </div>
  );
}

// PS when signed out: the normal sign-in (with the "Remember me" box).
export function PsLocked() {
  const touch = usePsTouchLocked();
  const [passphrase, setPassphrase] = useState(false);
  return touch && !passphrase ? <PsTouchUnlock onPassphrase={() => setPassphrase(true)} /> : <LockScreen />;
}

// Website top bar: says when PS is open on the Mac, which is why Tab shows PS's list instead.
export function PsOpenPill() {
  const open = usePsOpen();
  if (!open) return null;
  return <span className="pill cv-psopen" title="PS, the Mac app, is open. Hold Tab anywhere to see your list there.">PS app open</span>;
}
