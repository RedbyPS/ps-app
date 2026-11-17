// PS Fitness: one app on every device. The phone (PS GOS, the "Gym" button in the dock) opens it as a big pop up, the Mac
// as a screen inside the Tab list (FitnessButton.tsx) and the website at #/fitness.
// V1.43 (the developer: "The Fitness tab on mobile and desktop is just very complicated to look at. I never know how to navigate
// it."): one home with the big Start (or Continue) and a short summary; one round menu button (a donut ring) in the
// top left corner on every screen, opening every section with an icon and one line; on a wide Mac the same list as a
// slim bar down the left. Every screen has a title and a Back; Back, Esc and the phone's back gesture go one step.
// First launch on a device shows "Pick your look" once (Settings > Look opens it again). The look sits on the root.
import { feature } from "../core/features";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLookActive } from "../looks/engine";
import { useFitness } from "./store";
import { fitIslandPrefs, startFitIsland } from "./fitisland";
import { islandOn, islandSoundOn } from "../core/fitisland";
import { rest } from "./rest";
import { Gym } from "./Gym";
import { Programs } from "./Programs";
import { History } from "./History";
import { FitSettings } from "./FitSettings";
import { onFitAsk, takeFitTab } from "./fitask";
import { SleepScreen } from "./Sleep";
import { SquadScreen } from "./Squad";
import { Home } from "./Home";
import { Bests } from "./Bests";
import { Exercises } from "./Exercises";
import { Setup } from "./Setup";
import { autoOpen } from "./setup-logic";
import { isLater } from "./setup-store";
import { BackIcon, DonutButton, FitMenu, FitRail, LookPicker, lookSeen, markLookSeen, MinHint, minHintSeen, useFitSubTitle } from "./Nav";
import { back as stepBack, goTo, push, sectionInfo, startStack, type FitArg, type FitScreen, type FitSection } from "./nav-logic";
import { dayLabel, type FitStyle } from "../core/fitness";
import { setFitTheme, useFitTheme, type FitTheme } from "./theme";
import { useFitPulls, useFitSync } from "./sync";
import { savePrefs } from "./store";
import { haptic } from "../gos/bridge";
import "./fitness.css";
import "./nav.css";
import { appName } from "../core/appname";

/** The old tab names (the self test's ?tab=, Gym's "Build my program"): each is a section now. */
export type FitTab = "gym" | "plan" | "history" | "sleep" | "squad" | "settings";
const STYLE_KEY = "fit.style";

/** The pop up's own buttons (V1.29): Minimise to the floating timer, and Close. */
export interface FitChrome { onMin: () => void; onClose: () => void }

export function FitnessApp({ desk = false, onBack, backLabel = `Back to ${appName()}`, chrome }: { desk?: boolean; onBack?: () => void; backLabel?: string; chrome?: FitChrome }) {
  const v = useFitness();
  const test = location.pathname.endsWith("/fitview");
  // The self test (FitnessTestView) opens a screen with ?tab=; Settings' search asks for one (fitask.ts, V1.43);
  // a workout in progress opens on Today; else home.
  const asked = useRef<string | null>(null);
  const [stack, setStack] = useState<FitScreen[]>(() => {
    asked.current = takeFitTab() ?? new URLSearchParams(location.search).get("tab");
    return startStack(asked.current, !!v.open);
  });
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const [menu, setMenu] = useState(false);
  const [look, setLook] = useState<null | "first" | "again">(null);
  // While Fitness is open: Settings' search switches straight to the asked section (one step above home).
  useEffect(() => onFitAsk((t) => { takeFitTab(); asked.current = t; setMenu(false); setStack((st) => goTo(st, t)); }), []);
  // The look this device used last, until the vault says otherwise (so it never flashes the default).
  const forced = test ? new URLSearchParams(location.search).get("style") : null;   // self test pictures
  const [tryStyle, setTryStyle] = useState<FitStyle | null>(null);
  const style = forced || tryStyle || v.prefs.style || (() => { try { return localStorage.getItem(STYLE_KEY) || "volt"; } catch { return "volt"; } })();
  useEffect(() => { if (tryStyle && v.prefs.style === tryStyle) setTryStyle(null); }, [tryStyle, v.prefs.style]);
  useEffect(() => { try { localStorage.setItem(STYLE_KEY, style); } catch { /* storage off */ } }, [style]);
  useEffect(() => { rest.setSound(v.prefs.sound !== false); }, [v.prefs.sound]);
  // V1.60 the phone's island in workouts (fitisland.ts): the two switches, and start listening to the scan and the rest.
  useEffect(() => { fitIslandPrefs({ on: feature("fitness-island") && islandOn(v.prefs), sound: islandSoundOn(v.prefs) }); startFitIsland(); }, [v.prefs.island, v.prefs.islandSound]); // eslint-disable-line react-hooks/exhaustive-deps
  // A PS look other than the default (Settings > Appearance) dresses Fitness too: its own looks wait under the default.
  const lookOn = useLookActive();
  const ownTheme = useFitTheme(style);
  const theme = lookOn ? "dark" : ownTheme;
  useFitPulls(v.ready, !!v.open);   // the latest from the other device: on open, on focus, every 15 s in a workout
  const sync = useFitSync();

  // The vault was still opening on the first frame: a workout in progress then opens on Today, once.
  const landed = useRef(v.ready);
  useEffect(() => {
    if (landed.current || !v.ready) return;
    landed.current = true;
    if (v.open && !asked.current) setStack((st) => (st.length === 1 ? startStack(null, true) : st));
  }, [v.ready, v.open]);
  // V1.47: someone brand new (no program, no workout, setup never finished or put away) lands in "Set up your training",
  // once per open; a saved setup resumes on the step it was left on. Never on the self test page or when a screen was asked for.
  const autoed = useRef(false);
  useEffect(() => {
    if (autoed.current || !v.ready) return;
    autoed.current = true;
    if (autoOpen({ ready: v.ready, test, asked: !!asked.current, later: isLater(), done: v.prefs.setupDone ?? null, programs: v.programs.length, workouts: v.workouts.length })) {
      setStack((st) => (st.length === 1 ? [...st, { s: "setup" }] : st));
    }
  }, [v.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  // First launch on this device: Pick your look, once (never on the self test page, never under a PS look).
  useEffect(() => { if (v.ready && !test && !lookOn && !lookSeen()) setLook("first"); }, [v.ready, test, lookOn]);

  const top = stack[stack.length - 1];
  const cur = top.s;
  const go = (s: FitSection, arg?: FitArg) => { setMenu(false); setStack((st) => (arg ? push(st, s, arg) : goTo(st, s))); };
  const pick = (s: FitSection) => setStack((st) => goTo(st, s));
  const backOne = () => { const b = stepBack(stackRef.current); if (b) { haptic("press"); setStack(b); return true; } return false; };

  /** The Back at the top: the same event as the phone's back gesture, so a screen with its own steps (History) goes first. */
  const backTap = () => { const ev = new Event("gos-back", { cancelable: true }); window.dispatchEvent(ev); };
  // Back one step: the phone's back gesture, and Esc (the Tab list and the pop up turn Esc into this same event).
  // Every panel, card and sheet inside Fitness closes on this event with its own listener, but listeners on window
  // run in the order they were added, so this one may run first: it steps back only when none of them is open
  // (ownsBack), and leaves the event to them otherwise. Found headless 8 Nov: Back closed Today, not its day sheet.
  useEffect(() => {
    const f = (e: Event) => { if (e.defaultPrevented || ownsBack()) return; if (backOne()) e.preventDefault(); };
    window.addEventListener("gos-back", f);
    return () => window.removeEventListener("gos-back", f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The website (no pop up around it): Esc goes back one step too, and from home leaves Fitness when there is a way out.
  useEffect(() => {
    if (chrome) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const ev = new Event("gos-back", { cancelable: true });
      window.dispatchEvent(ev);
      if (!ev.defaultPrevented && onBack) onBack();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [chrome, onBack]);

  const chooseLook = (k: FitStyle, t: FitTheme) => {
    setTryStyle(k);
    setFitTheme(t);
    savePrefs({ style: k }).catch(() => { setTryStyle(null); haptic("reject"); });
  };

  const day = v.program && v.next ? v.program.data.days[v.next.dayIndex] : null;
  const label = v.open ? dayLabel(v.open.data.week, v.open.data.dayName) : day && v.next ? dayLabel(v.next.week, day.name) : null;
  const info = sectionInfo(cur);
  // A screen a section opened on top of itself (a program's exercise, a workout in History) names the top bar.
  const inner = useFitSubTitle();
  const title = inner ?? (cur === "gym" && v.open ? "Workout" : info.title);
  const tools = (
    <>
      <SyncButton />
      {!lookOn && <ThemeButton theme={theme} />}
    </>
  );
  // The menu's foot in the pop up also holds Minimise and Close, in words (V1.43).
  const menuFoot = (
    <>
      <div className="fit-menu-f-row">{tools}</div>
      {chrome && (
        <div className="fit-menu-f-row">
          {v.open && <button type="button" className="fit-menu-act" onClick={() => { setMenu(false); chrome.onMin(); }}><MinIcon /><span>Minimise to a timer</span></button>}
          <button type="button" className="fit-menu-act" onClick={() => { setMenu(false); chrome.onClose(); }}><CloseIcon /><span>Close Fitness</span></button>
        </div>
      )}
    </>
  );
  // Minimise explained once, the first time a workout is open in the pop up.
  const [minHint, setMinHint] = useState(() => !minHintSeen());
  // The top bar's height, so a section's own full screen panel can sit under it (nav.css --fit-head-h).
  const rootRef = useRef<HTMLDivElement>(null), headRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const h = headRef.current, r = rootRef.current;
    if (!h || !r || typeof ResizeObserver === "undefined") return;
    // Only when it changed (V1.47): setting it again to the same value still restyled all of Fitness (about 460
    // elements) once the observer first answered, right in the middle of the opening animation.
    let last = "";
    const set = () => { const v = `${Math.round(h.getBoundingClientRect().height)}px`; if (v !== last) { last = v; r.style.setProperty("--fit-head-h", v); } };
    set();
    const ro = new ResizeObserver(set); ro.observe(h);
    return () => ro.disconnect();
  }, []);

  let body: ReactNode;
  switch (cur) {
    case "home": body = <Home v={v} go={go} />; break;
    case "gym": body = <Gym v={v} desk={desk} onOpen={(t) => go(t)} pick={top.arg?.k === "pick"} />; break;
    case "plan": body = <Programs v={v} desk={desk} />; break;
    case "history": body = <History v={v} desk={desk} start={top.arg && top.arg.k !== "pick" ? top.arg : null} onSquad={() => go("squad")} />; break;
    case "bests": body = <Bests v={v} onOpen={(key) => go("history", { k: "x", key })} />; break;
    case "exercises": body = <Exercises desk={desk} />; break;
    case "sleep": body = <SleepScreen v={v} desk={desk} />; break;
    case "squad": body = <SquadScreen v={v} desk={desk} />; break;
    case "settings": body = <FitSettings v={v} desk={desk} onLooks={() => setLook("again")} onSetup={() => go("setup")} />; break;
    case "setup": body = <Setup v={v} desk={desk} go={go} onExit={() => setStack([{ s: "home" }])} />; break;
  }
  const depth = stack.length - 1;
  return (
    <div ref={rootRef} className={`fit fit-app ${desk ? "fit-desk" : "fit-phone"}${chrome ? " fit-in-pop" : ""}`} data-fit-style={lookOn ? "volt" : style} data-fit-theme={theme} data-fit-section={cur}>
      {desk && <FitRail cur={cur} onPick={pick} onMenu={() => setMenu((m) => !m)} menuOpen={menu} warn={sync.tone === "warn"} foot={tools} />}
      <div className="fit-main">
        <header ref={headRef} className="fit-head">
          <DonutButton open={menu} onClick={() => setMenu((m) => !m)} warn={sync.tone === "warn"} className="fit-head-donut" />
          {(depth > 0 || inner) && <button type="button" className="fit-back" onClick={backTap} data-tip="Back" data-tip-line="One step back. Or press Esc"
            aria-label={inner ? `Back to ${info.title}` : `Back to ${sectionInfo(stack[depth - 1].s).title === "Fitness" ? "Home" : sectionInfo(stack[depth - 1].s).title}`}><BackIcon /></button>}
          <div className="fit-head-t">
            <h1>{title}</h1>
          </div>
          <div className="fit-head-end">
            {desk && <span className="fit-head-tools">{tools}</span>}
            {chrome ? <ChromeButtons chrome={chrome} compact={!desk} live={!!v.open} /> : onBack && <button type="button" className="fit-desk-back" onClick={onBack}>{backLabel}</button>}
          </div>
        </header>
        {chrome && v.open && minHint && <MinHint onDone={() => setMinHint(false)} />}
        <div className={`fit-view fit-view-${cur}`} key={`${cur}:${depth}:${top.arg ? JSON.stringify(top.arg) : ""}`}>{body}</div>
      </div>
      {menu && <FitMenu cur={cur} onPick={pick} onClose={() => setMenu(false)} foot={menuFoot} />}
      {look && (
        <LookPicker style={lookOn ? "volt" : style} theme={theme} first={look === "first"} onPick={chooseLook}
          onDone={() => { markLookSeen(); setLook(null); }} />
      )}
    </div>
  );
}

/** A layer inside Fitness that closes on back by itself is open: a gym sheet, a squad sheet, an exercise card, a
 *  program panel or its question, the menu, the look picker, or a screen that marks itself (History's own steps). */
const OWN_BACK = ".fit-app .fg-ov:not(.out), .xp-card:not(.out), .fi-card, .fsu-sheet:not(.out), .fq-ov:not(.out), .fp-layer.in, .fp-ask-layer, .fit-menu-layer:not(.out), .fit-look-layer:not(.out), [data-fit-owns-back]";
export const ownsBack = () => typeof document !== "undefined" && !!document.querySelector(OWN_BACK);

/** "Synced 2 min ago". A tap sends and pulls now, with a short spin. Amber when a change is still waiting. */
export function SyncButton() {
  const s = useFitSync();
  return (
    <button type="button" className={`fit-sync ${s.tone}${s.spinning ? " spin" : ""}`} onClick={() => { haptic("press"); s.force(); }}
      aria-label={`${s.text}. Tap to sync now`} data-tip="Sync now" data-tip-line={s.text}>
      <SyncIcon />
      <span className="fit-sync-t" aria-live="polite">{s.text}</span>
    </button>
  );
}
/** The sun / moon: light for a bright gym, dark for the night. Remembered on this device only. */
export function ThemeButton({ theme }: { theme: FitTheme }) {
  const light = theme === "light";
  return (
    <button type="button" className="fit-theme-b" role="switch" aria-checked={light} onClick={() => { haptic("press"); setFitTheme(light ? "dark" : "light"); }}
      aria-label={light ? "Light look on. Switch to dark" : "Dark look on. Switch to light"} data-tip={light ? "Dark look" : "Light look"} data-tip-line={light ? "For the night, on this device" : "For a bright gym, on this device"}>
      <span className={`fit-theme-i${light ? " light" : ""}`} aria-hidden="true"><SunIcon /><MoonIcon /></span>
    </button>
  );
}
/** The pop up's own buttons. Phone (V1.43, the developer found the unlabelled Minimise confusing): during a workout ONE button
 *  that says "Minimise" (to the timer bubble, so the rest timer stays in sight), otherwise ONE Close. Both are also
 *  in the menu, in words. The Mac keeps both, labelled. */
function ChromeButtons({ chrome, compact, live }: { chrome: FitChrome; compact?: boolean; live?: boolean }) {
  if (compact) {
    return live
      ? <button type="button" className="fit-min-pill" onClick={chrome.onMin} data-tip="Minimise" data-tip-line="Shrinks Fitness to a small timer bubble"><MinIcon /><span>Minimise</span></button>
      : <button type="button" className="fit-bar-b" onClick={chrome.onClose} aria-label="Close Fitness" data-tip="Close Fitness" data-tip-line="Back to where you were"><CloseIcon /></button>;
  }
  return (
    <>
      <button type="button" className="fit-chrome-b" onClick={chrome.onMin} data-tip="Minimise" data-tip-line="Shrinks Fitness to a small timer"><MinIcon /><span>Minimise</span></button>
      <button type="button" className="fit-chrome-b close" onClick={chrome.onClose} data-tip="Close Fitness" data-tip-line="Back to where you were"><CloseIcon /><span>Close</span></button>
    </>
  );
}
const I = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const MinIcon = () => <I><path d="M5 18h14" /><path d="M8 10l4 4 4-4" /></I>;
export const CloseIcon = () => <I><path d="M6 6l12 12M18 6L6 18" /></I>;
const SyncIcon = () => <I size={17}><path d="M20 12a8 8 0 0 1-14.3 4.9" /><path d="M4 12A8 8 0 0 1 18.3 7.1" /><path d="M18.5 3v4.3h-4.3" /><path d="M5.5 21v-4.3h4.3" /></I>;
const SunIcon = () => <I><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></I>;
const MoonIcon = () => <I><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></I>;

export function DumbbellIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11" />
    </svg>
  );
}
