// "What is new" walkthrough (V1.58, the developer 13 Nov 2026). After a person closes What's new on the Mac: one short walkthrough,
// Next, Next, Done, in the same small card as the first use tips and the V1.56 pop-ups. It points at the real thing where
// it can (a ring on the Pomodoro button); the island lives in its own window above the Tab list, so its steps carry a
// little picture of it instead. The rules (order, once per person, the developer never gets the friends step, gate, blockers) are
// core/walkthrough.ts and tests/walkthrough.test.ts; the words are core/walkwords.ts.
//
// Gentle by design, like the tips and pop-ups: nothing here takes the keyboard focus, it is only drawn inside this page
// (never a window of its own or a notification, so never over another app), and it leaves the moment a meeting, Sleep mode,
// Sentry mode, Do Not Disturb, a screen or a menu starts, coming back at the same step another calm time. Skip or Esc
// ends it (Esc before anything behind it hears the key).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PS, psSettingsNow, useOverlayShown } from "../ps";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { appName } from "../core/appname";
import { vaultStore } from "../core/vault";
import { calendarSnap, remindRec, settingsData } from "../core/select";
import { isRedAccount } from "../core/account";
import { dndActive } from "../core/dnd";
import { afkMeetWindows } from "../core/afkmeet";
import { tipsOn } from "../core/offswitches";
import { GROUPS, type GroupId } from "../core/settingsindex";
import { blocker, cleanTipsSeen, hidesShowing, placeTip, type BlockFacts, type Placed } from "../core/tips";
import { tipsFinished } from "../core/newpopups";
import {
  WALK, WALK_TIMES, cleanWalkSeen, fillWalk, isLast, markWalkSeen, nextStep, skipAll, stepAfter, stepCount, walkReady,
  type WalkFacts, type WalkStep, type WalkStepId,
} from "../core/walkthrough";
import { WALK_BUTTONS, WALK_MENU_ITEMS, WALK_WORDS } from "../core/walkwords";
import { sleepState } from "../sleepmode/engine";
import { useFaceShowing, useWhatsNewShowing } from "../updateface";
import { useWelcomeShowing } from "./Welcome";
import { sentryUp } from "./Sentry";
import { taskMapActions } from "./TaskMap";
import { openSettings } from "./SettingsScreen";
import { frontIsProtected, screenNow, sinceLastKeyMs, typingNow } from "./Tips";
import { popupOn, setWalkOn, setWalkWaiting, tipOn } from "./popupstate";
import type { CalendarSnap } from "../core/model";
import { meetingEvents } from "../core/calpick";
import "./tips.css";
import "./newpopups.css";
import "./walkthrough.css";

// ---------- kept on this device ----------
/** "1": What's new (or the update card) was up and closed on this device while this build ran: the walkthrough may start. */
const GATE_KEY = "ps.walkGate.158";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

// Steps seen here before the save has come back (the save is the vault's, so a moment late).
const shownHere = new Set<WalkStepId>();

/** Mark steps seen: merged with what the vault holds right now, so another device's marks are never undone. */
function save(ids: readonly WalkStepId[]) {
  const s = vaultStore.get();
  if (s.status !== "unlocked" || !ids.length) return;
  for (const id of ids) shownHere.add(id);
  void taskMapActions.looks({ walkSeen: markWalkSeen(settingsData(s).walkSeen, ids, Date.now()) });
}

/** Is this Settings group in this build? ("Show me" only shows where it really opens something.) */
const hasGroup = (g: string | undefined): g is GroupId => !!g && GROUPS.some((x) => x.id === g);

/** A Pomodoro button on the screen (PS 1.70: added in Edit mode; a removed or opt in one is mounted but not drawn). */
const pomoShowing = () => typeof document !== "undefined" && [...document.querySelectorAll(".pm-tab-btn")].some((b) => b.getClientRects().length > 0);

/** The facts that do not change from tick to tick within a step: who, where, what is switched off, what was seen. */
function personFacts(): Pick<WalkFacts, "mac" | "red" | "overProtected" | "off" | "seen"> | null {
  const snap = vaultStore.get();
  if (snap.status !== "unlocked") return null;
  const st = settingsData(snap);
  let seen = cleanWalkSeen(st.walkSeen);
  seen = markWalkSeen(seen, [...shownHere], Date.now());
  const ps = psSettingsNow() as { shortcuts?: { overProtected?: unknown } } | null;
  const over = ps?.shortcuts?.overProtected;
  return {
    seen,
    mac: PS,
    red: isRedAccount(snap),
    overProtected: typeof over === "boolean" ? over : null,
    // The Pomodoro button switched off in Settings: they found it, and there is nothing to point at. PS 1.70: it is only on
    // the screen once added in Edit mode, so with none showing there is nothing to point at either.
    off: { "158-pomodoro": (st as { pomodoro?: { on?: unknown } }).pomodoro?.on === false || !pomoShowing() },
  };
}

export function WalkthroughHost() {
  const s = useVault();
  const listShown = useOverlayShown();
  const tour = useWelcomeShowing();
  const whatsNew = useWhatsNewShowing();
  const face = useFaceShowing();
  const [show, setShow] = useState<WalkStepId | null>(null);

  const live = useRef({ s, listShown, tour, setup: whatsNew || face });
  live.current = { s, listShown, tour, setup: whatsNew || face };
  const showRef = useRef<WalkStepId | null>(null);
  showRef.current = show;
  const gate = useRef(lsGet(GATE_KEY) === "1");
  const timer = useRef(0);
  const counted = useRef(false);   // the step showing has been up long enough to count as seen
  const quietFrom = useRef(0);     // the last moment a screen was open or a key typed: the list must then be calm again

  const startStep = (id: WalkStepId) => {
    window.clearTimeout(timer.current);
    counted.current = false;
    shownHere.delete(id);
    setWalkOn(true);
    setShow(id);
    timer.current = window.setTimeout(() => { counted.current = true; save([id]); }, WALK_TIMES.seenAfterMs);
  };
  const hide = (mark: readonly WalkStepId[] | null) => {
    window.clearTimeout(timer.current); timer.current = 0;
    if (mark) save(mark);
    counted.current = false;
    setWalkOn(false);
    setShow(null);
  };

  // The one clock: look at the facts every second.
  useEffect(() => {
    let sinceShown = 0, wasSetup = false;
    const tick = () => {
      const { s: snap, listShown: shown, tour: touring, setup } = live.current;
      const now = Date.now();
      // What's new (or the update card) was up and is gone: the walkthrough may start.
      if (setup) wasSetup = true;
      else if (wasSetup) { wasSetup = false; if (!gate.current) { gate.current = true; lsSet(GATE_KEY, "1"); } }

      if (!shown) sinceShown = 0; else if (!sinceShown) sinceShown = now;
      const unlocked = snap.status === "unlocked";
      const st = unlocked ? settingsData(snap) : null;
      const cal = unlocked ? calendarSnap(snap) : null;
      const screen = screenNow(), typing = typingNow();
      if (screen || typing || setup || touring) quietFrom.current = now;
      const bf: BlockFacts = {
        listShown: shown,
        pageVisible: document.visibilityState !== "hidden",
        shownForMs: sinceShown ? now - Math.max(sinceShown, quietFrom.current) : 0,
        sinceKeyMs: sinceLastKeyMs(),
        typing,
        screenOpen: screen,
        setupOpen: setup || touring,
        inMeeting: !!st && afkMeetWindows(meetingEvents(cal ? (cal.data as CalendarSnap).events : [], st.calChoices), st.meetHidden, now).some(([a, b]) => now >= a && now < b),
        sleepMode: sleepState().here,
        sentry: sentryUp(),
        dnd: !!st && dndActive(st.dnd, now),
        protectedFront: frontIsProtected(),
      };
      if (import.meta.env.DEV) Object.assign(bf, (window as unknown as { __walkOverride?: Partial<BlockFacts> }).__walkOverride);
      const block = blocker(bf);
      const person = personFacts();
      if (!unlocked || !st || !person) { setWalkWaiting(false); return; }
      const f: WalkFacts = {
        ...person,
        synced: !!snap.lastSync || !!snap.local || snap.role === "owner",
        owner: snap.role === "owner",
        enabled: tipsOn(st.tipsShow),
        gateOpen: gate.current || tipsFinished(cleanTipsSeen(st.tipsSeen), { hasReminder: !!remindRec(snap)?.list?.some((r) => r.task), phone: false }),
        otherShowing: tipOn() || popupOn(),
        block,
      };
      if (import.meta.env.DEV) { Object.assign(f, (window as unknown as { __walkFacts?: Partial<WalkFacts> }).__walkFacts); (window as unknown as { __walkSeenFacts?: unknown }).__walkSeenFacts = f; }
      setWalkWaiting(walkReady(f));
      const cur = showRef.current;
      if (cur) { if (hidesShowing(block) || !f.enabled) hide(counted.current ? [cur] : null); return; }
      const step = nextStep(f);
      if (step) startStep(step.id);
    };
    const t = window.setInterval(tick, 1000);
    return () => { window.clearInterval(t); window.clearTimeout(timer.current); setWalkOn(false); setWalkWaiting(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The dev server only, for pictures: window.__walkShow("158-menu") puts that step up at once (nothing is saved).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __walkShow?: (id: WalkStepId | null) => void }).__walkShow = (id) => { window.clearTimeout(timer.current); counted.current = true; setWalkOn(!!id); setShow(id); };
  }, []);

  // ---------- what the buttons do ----------
  const act = {
    /** Next: this step is seen, the next one comes at once (no calm wait between steps). */
    next: (id: WalkStepId) => {
      save([id]);
      const p = personFacts();
      const nxt = p ? stepAfter(p, id) : null;
      if (nxt) startStep(nxt.id); else hide(null);
    },
    /** Done (the last step): seen, gone. */
    done: (id: WalkStepId) => { sfx.done(); hide([id]); },
    /** Skip, or Esc: every step this person has counts as seen. */
    skip: () => { const p = personFacts(); hide(p ? skipAll(p) : (showRef.current ? [showRef.current] : [])); },
    /** Show me: this step is seen and Settings opens on its tab; the walkthrough carries on at the next step once
     *  Settings is closed and the list is calm again. */
    show: (step: WalkStep) => {
      hide([step.id]);
      if (hasGroup(step.settings)) openSettings(step.settings, step.jump ? { jump: step.jump } : {});
    },
  };

  // Esc ends it, before anything else hears the key.
  useEffect(() => {
    if (!show) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopImmediatePropagation();
      act.skip();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null;
  const step = WALK.find((x) => x.id === show);
  if (!step) return null;
  return createPortal(<WalkCard key={show} step={step} act={act} />, document.body);
}

// ---------- the card ----------
type Act = { next: (id: WalkStepId) => void; done: (id: WalkStepId) => void; skip: () => void; show: (s: WalkStep) => void };

function targetEl(sel: string | undefined): HTMLElement | null {
  if (!sel) return null;
  const el = document.querySelector(sel);
  if (!(el instanceof HTMLElement)) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
  return el;
}

function WalkCard({ step, act }: { step: WalkStep; act: Act }) {
  const app = useMemo(() => appName(), []);
  const person = useMemo(personFacts, [step.id]);
  const words = WALK_WORDS[step.id];
  const count = person ? stepCount(person, step.id) : { n: 1, total: 1 };
  const last = person ? isLast(person, step.id) : true;
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placed | null>(null);
  const [ring, setRing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const measure = () => {
    const c = box.current;
    if (!c) return;
    const r = targetEl(step.target)?.getBoundingClientRect();
    const rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    setRing(rect);
    setPlace(placeTip(rect, { w: c.offsetWidth, h: c.offsetHeight }, { w: innerWidth, h: innerHeight }, rect ? ["above", "below", "right", "left"] : ["bottom"]));
  };
  useLayoutEffect(() => { measure(); }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = window.setInterval(measure, 400);
    addEventListener("resize", measure);
    return () => { window.clearInterval(t); removeEventListener("resize", measure); };
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const click = (f: () => void) => () => { sfx.click(); f(); };
  const side = place?.side ?? "bottom";
  return (
    <>
      {ring && <i className="tp-ring" aria-hidden="true" style={{ left: ring.x - 5, top: ring.y - 5, width: ring.w + 10, height: ring.h + 10 }} />}
      <div ref={box} className={`tp-card np-card wk-card no-drag wk-p-${step.picture} side-${side}${place ? " in" : ""}`} role="status" aria-live="polite"
        style={{ left: place?.x ?? 0, top: place?.y ?? 0, ["--arrow" as string]: `${place?.arrow ?? 0}px` }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        {place?.arrow != null && <i className="tp-arrow" aria-hidden="true" />}
        <div className="tp-stage wk-stage" aria-hidden="true"><Picture kind={step.picture} /></div>
        <div className="wk-count">{fillWalk(WALK_BUTTONS.count, count)}</div>
        <div className="tp-title">{fillWalk(words.title, { app })}</div>
        {words.lines.map((l, i) => <div key={i} className="tp-line">{fillWalk(l, { app })}</div>)}
        <div className="np-row">
          <button type="button" tabIndex={-1} className="np-main" onClick={click(() => (last ? act.done(step.id) : act.next(step.id)))}>{last ? WALK_BUTTONS.done : WALK_BUTTONS.next}</button>
          {hasGroup(step.settings) && <button type="button" tabIndex={-1} className="np-sec" onClick={click(() => act.show(step))}>{WALK_BUTTONS.show}</button>}
          {!last && <button type="button" tabIndex={-1} className="np-later" onClick={click(act.skip)}>{WALK_BUTTONS.skip}</button>}
        </div>
      </div>
    </>
  );
}

// ---------- the little pictures (SVG and CSS, looping, still when motion is reduced) ----------
/** The island as a dark pill with its thin grey bar on top. */
const Pill = ({ x, y, w = 96, h = 26, children }: { x: number; y: number; w?: number; h?: number; children?: React.ReactNode }) => (
  <g>
    <rect className="wk-pill" x={x} y={y} width={w} height={h} rx={h / 2} />
    <rect className="wk-bar" x={x + w / 2 - 16} y={y - 6} width={32} height={3} rx={1.5} />
    {children}
  </g>
);

function Picture({ kind }: { kind: WalkStep["picture"] }) {
  const W = 300, H = 84;
  const svg = (body: React.ReactNode) => <svg className="wk-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">{body}</svg>;
  switch (kind) {
    case "menu": return svg(<>
      <Pill x={34} y={22} />
      <path className="wk-cursor wk-cursor-menu" d="M0 0l0 13 3.5-3.2 2.4 5.4 2.2-1-2.4-5.3 4.8-.3z" />
      <g className="wk-menu">
        <rect className="wk-menu-bg" x={140} y={8} width={152} height={68} rx={9} />
        {WALK_MENU_ITEMS.map((t, i) => (
          <g key={t}>
            <rect className={`wk-menu-hi${i === 0 ? " on" : ""}`} x={144} y={12 + i * 21} width={144} height={18} rx={5} />
            <text className="wk-menu-t" x={151} y={24.5 + i * 21}>{t}</text>
          </g>
        ))}
      </g>
    </>);
    case "settings": return svg(<>
      <rect className="wk-win" x={40} y={8} width={220} height={68} rx={9} />
      <rect className="wk-side" x={40} y={8} width={64} height={68} rx={9} />
      {[0, 1, 2, 3].map((i) => <rect key={i} className={`wk-side-row${i === 0 ? " on" : ""}`} x={47} y={16 + i * 14} width={50} height={9} rx={3} />)}
      {[0, 1].map((r) => [0, 1].map((c) => <rect key={`${r}${c}`} className="wk-cardlet" x={112 + c * 73} y={16 + r * 29} width={66} height={23} rx={6} />))}
    </>);
    case "topbar": return svg(<>
      <rect className="wk-screen" x={40} y={4} width={220} height={78} rx={8} />
      <rect className="wk-strip" x={40} y={4} width={220} height={13} rx={4} />
      <rect className="wk-notch" x={134} y={4} width={32} height={11} rx={4} />
      <g className="wk-glide"><rect className="wk-pill" x={0} y={0} width={44} height={10} rx={5} /></g>
      <path className="wk-corner" d="M46 76v-8M46 76h8" />
    </>);
    case "pomodoro": return svg(<>
      <circle className="wk-track" cx={110} cy={42} r={27} />
      <circle className="wk-arc" cx={110} cy={42} r={27} transform="rotate(-90 110 42)" />
      <text className="wk-big" x={110} y={47} textAnchor="middle">25:00</text>
      <Pill x={170} y={30} w={92}>
        <text className="wk-pill-t" x={216} y={47} textAnchor="middle">Break 4:59</text>
      </Pill>
    </>);
    case "standup": return svg(<>
      <Pill x={58} y={30} w={110}>
        <rect className="wk-bubble" x={138} y={34} width={26} height={18} rx={9} />
        <text className="wk-pill-t wk-count15" x={151} y={47} textAnchor="middle">15</text>
      </Pill>
      <g className="wk-man" transform="translate(206 18)">
        <circle cx={10} cy={6} r={5} /><path d="M10 12v22M10 18l-8 8M10 18l8 8M10 34l-6 14M10 34l6 14" />
      </g>
    </>);
    case "meeting": return svg(<>
      <Pill x={70} y={30} w={160}>
        <rect className="wk-bubble" x={150} y={34} width={76} height={18} rx={9} />
        <text className="wk-pill-t" x={188} y={47} textAnchor="middle">Call in 12m</text>
      </Pill>
    </>);
    case "ai": return svg(<>
      <rect className="wk-win" x={34} y={14} width={92} height={56} rx={8} />
      <text className="wk-term" x={44} y={34}>{">_"}</text>
      <rect className="wk-side-row" x={44} y={42} width={60} height={6} rx={3} />
      <rect className="wk-side-row" x={44} y={54} width={44} height={6} rx={3} />
      <path className="wk-fly" d="M132 42h22" />
      <Pill x={162} y={30} w={110}>
        <text className="wk-pill-t" x={217} y={47} textAnchor="middle">AI: All done</text>
      </Pill>
    </>);
    case "protected": return svg(<>
      <rect className="wk-key" x={70} y={26} width={56} height={34} rx={8} />
      <text className="wk-key-t" x={98} y={48} textAnchor="middle">tab</text>
      <path className="wk-lock" d="M186 40v-7a12 12 0 0 1 24 0v7" />
      <rect className="wk-lock-b" x={180} y={40} width={36} height={26} rx={6} />
      <path className="wk-ok" d="M190 53l5 5 10-10" />
    </>);
  }
}

/** For the tests and the dev page: is the walkthrough up right now. */
export { walkOn as walkIsUp } from "./popupstate";
