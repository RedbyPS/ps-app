// The day countdown on screen (PS 1.70; the rules are core/daycount.ts, the engine src/daycount.ts):
//  - DayCountdown: under the headline, above the list's name. Each digit changes with the picked animation; near zero it comes alive
//    in stages (Lively near zero). Right click: a small menu with Settings, which grows Settings out of the countdown on Countdown text.
//  - P1Timer: the small timer on each Priority 1 task. Its right click wins over the task's own menu.
//  - DayCardHost: on the website and the phone, the "End day now?" card and the reminders drop out of a small island at the top (the
//    Mac's island draws its own, ps-mac DayCountdown.swift).
// One shared clock ticks once a second for all of them, and only while the list can be seen. Transforms and opacity only, so a tick
// never moves anything around it. Reduced motion: no digit motion and no rumble, the colours stay.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { PS, psInOverlay, psOverlayShown, onOverlayShown } from "../ps";
import { GOS, MWEB } from "../gos/bridge";
import { openSettings } from "./SettingsScreen";
import { dayAnswer, dayCardStore, dayRemAck, dayView, ensureDayEngine, type DayView } from "../daycount";
import { CD_FEATURE, WORDS, clock, cleanCd, leftWords, livelyStage, p1Deadline, type CdPrefs } from "../core/daycount";
import { feature } from "../core/features";
import { settingsData } from "../core/select";
import type { Todo } from "../core/model";
import "./daycount.css";

// ---------- one clock for every countdown ----------
const tickSubs = new Set<() => void>();
let tickNow = Math.floor(Date.now() / 1000) * 1000;
let tickTimer = 0;
const seen = () => document.visibilityState !== "hidden" && (!PS || !psInOverlay() || psOverlayShown());
function schedule() {
  window.clearTimeout(tickTimer);
  if (!tickSubs.size || !seen()) { tickTimer = 0; return; }
  const now = Date.now();
  tickTimer = window.setTimeout(() => { tickNow = Math.floor(Date.now() / 1000) * 1000; tickSubs.forEach((f) => f()); schedule(); }, 1000 - (now % 1000) + 4);
}
const wakeTick = () => { tickNow = Math.floor(Date.now() / 1000) * 1000; tickSubs.forEach((f) => f()); schedule(); };
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", wakeTick);
  if (PS) onOverlayShown(wakeTick);
}
/** Now, to the second, ticking once a second while anything uses it and the list can be seen. */
export function useSecond(): number {
  return useSyncExternalStore((f) => { tickSubs.add(f); if (!tickTimer) schedule(); return () => { tickSubs.delete(f); if (!tickSubs.size) { window.clearTimeout(tickTimer); tickTimer = 0; } }; }, () => tickNow);
}

/** The countdown's view, worked out again when the vault changes, every half minute, and when zero passes. */
export function useDayView(now: number): DayView {
  const s = useVault();
  const memo = useRef<{ s: unknown; at: number; v: DayView } | null>(null);
  const m = memo.current;
  if (!m || m.s !== s || now - m.at >= 30_000 || now < m.at || (m.v.st.target !== null && now >= m.v.st.target && m.at < m.v.st.target)) {
    memo.current = { s, at: now, v: dayView(s, Math.max(now, Date.now())) };
  }
  return memo.current!.v;
}
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the digits ----------
/** One place of the time. Keeps the old character for its way out, so each change animates in and out together. */
function Cell({ ch }: { ch: string }) {
  const r = useRef({ ch, prev: null as string | null, n: 0 });
  if (r.current.ch !== ch) r.current = { ch, prev: r.current.ch, n: r.current.n + 1 };
  const { prev, n } = r.current;
  const sep = ch === ":";
  return (
    <span className={`cd-cell${sep ? " cd-sep" : ""}`}>
      {prev !== null && !sep && <span key={`o${n}`} className="cd-ch cd-out" aria-hidden="true">{prev}</span>}
      <span key={`i${n}`} className={`cd-ch${n && !sep ? " cd-in" : ""}`}>{ch}</span>
    </span>
  );
}
/** The time, each place in its own cell, counted from the right so 10:00 after 9:59 keeps every place where it was. */
export function Digits({ text }: { text: string }) {
  const chars = [...text];
  return <span className="cd-digits" aria-hidden="true">{chars.map((c, i) => <Cell key={chars.length - i} ch={c} />)}</span>;
}

/** The look the settings give: font, colour, weight, size, animation. */
function lookVars(p: CdPrefs): CSSProperties {
  const color = p.color === "accent" ? "var(--k-acc, #EC4E86)" : p.color || "var(--k-fg, #FFFFFF)";
  return { ["--cd-c" as string]: color, ["--cd-w" as string]: String(p.weight), ["--cd-k" as string]: String(p.size / 100) };
}
export function cdClass(p: CdPrefs, stage: number, zero: boolean): string {
  return `cd cd-f-${p.font} cd-a-${p.anim}${p.lively ? ` cd-l${stage}` : ""}${zero ? " cd-zero" : ""}`;
}

// ---------- the right click menu (the countdown and the Priority 1 timers) ----------
type MenuAt = { x: number; y: number; from: HTMLElement } | null;
let setMenuAt: ((m: MenuAt) => void) | null = null;
export function openCdMenu(e: React.MouseEvent, from: HTMLElement) {
  e.preventDefault();
  e.stopPropagation();
  sfx.hover();
  setMenuAt?.({ x: e.clientX, y: e.clientY, from });
}
/** Mounted once in the Tab list. Esc, a click outside or scrolling closes it. */
export function CdMenuHost() {
  const [at, setAt] = useState<MenuAt>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setMenuAt = setAt; return () => { if (setMenuAt === setAt) setMenuAt = null; }; }, []);
  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setAt(null); } };
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setAt(null); };
    const gone = () => setAt(null);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", gone);
    window.addEventListener("wheel", gone, { passive: true });
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("pointerdown", down, true); window.removeEventListener("blur", gone); window.removeEventListener("wheel", gone); };
  }, [at]);
  // Kept inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !at) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
  }, [at]);
  if (!at) return null;
  const go = () => {
    const from = at.from;
    setAt(null);
    sfx.click();
    // The fancy part: the countdown sends out a ring of light, then Settings grows out of it and lands on Countdown text.
    from.classList.remove("cd-burst");
    void from.offsetWidth;
    from.classList.add("cd-burst");
    window.setTimeout(() => from.classList.remove("cd-burst"), 900);
    window.setTimeout(() => openSettings("countdown", { from }), reduced() ? 0 : 140);
  };
  return createPortal(
    <div ref={box} className="cd-menu no-drag" role="menu" aria-label="Countdown" style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" className="cd-menu-item" onClick={go} autoFocus={false}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
        {WORDS.settings}
      </button>
    </div>, document.body);
}

// ---------- the countdown under the headline ----------
export function DayCountdown() {
  const now = useSecond();
  const v = useDayView(now);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { ensureDayEngine(); }, []);
  if (!v.on || v.st.target === null) return null;
  const left = v.st.asking ? 0 : Math.max(0, v.st.target - now);
  const stage = livelyStage(left, v.st.asking);
  const text = clock(left);
  return (
    <div className="cd-wrap">
      <div ref={el} className={cdClass(v.prefs, stage, v.st.asking)} style={lookVars(v.prefs)} role="timer" aria-live="off"
        aria-label={`${leftWords(left)} left`} title={WORDS.tip(v.endHm)}
        onContextMenu={(e) => el.current && openCdMenu(e, el.current)} onMouseDown={(e) => { if (e.button === 2) e.stopPropagation(); }}>
        <span className="cd-glow" aria-hidden="true" />
        <Digits text={text} />
      </div>
    </div>
  );
}

// ---------- the Priority 1 timer on a task ----------
/** inline: the copy under the task's name, shown instead of the right hand one on narrow screens (the phone). */
export function P1Timer({ t, inline }: { t: Pick<Todo, "p1" | "p1At" | "p1Since" | "done" | "type">; inline?: boolean }) {
  const s = useVault();
  const on = feature(CD_FEATURE) && cleanCd(settingsData(s).countdown).p1;
  const deadline = on ? p1Deadline(t, Date.now()) : null;
  if (deadline === null) return null;
  return <P1Clock deadline={deadline} inline={inline} />;
}
function P1Clock({ deadline, inline }: { deadline: number; inline?: boolean }) {
  const now = useSecond();
  const el = useRef<HTMLSpanElement>(null);
  const left = deadline - now;
  const late = left <= 0;
  return (
    <span ref={el} className={`cd-p1 num no-drag${inline ? " inline" : ""}${late ? " late" : left < 2 * 3_600_000 ? " soon" : ""}`} title={`Priority 1: 24 hours from when it became Priority 1. Right click for ${WORDS.settings}.`}
      onContextMenu={(e) => el.current && openCdMenu(e, el.current)}
      onPointerDown={(e) => { if (e.button === 2) e.stopPropagation(); }}
      onMouseDown={(e) => { if (e.button === 2) e.stopPropagation(); }}>
      {late ? WORDS.missed : <Digits text={clock(left)} />}
    </span>
  );
}

// ---------- the card inside the page (website, phone) ----------
export function DayCardHost() {
  const card = useSyncExternalStore(dayCardStore.subscribe, dayCardStore.get);
  const [shown, setShown] = useState<typeof card>(null);
  const [phase, setPhase] = useState<"in" | "out">("in");
  const now = useSecond();
  useEffect(() => { ensureDayEngine(); }, []);
  // A new card: in. Gone (answered here or on another device): back up into the island, then away.
  useEffect(() => {
    if (card && (!shown || shown.key !== card.key || shown.kind !== card.kind)) { setShown(card); setPhase("in"); if (!reduced()) sfx.hover(); return; }
    if (!card && shown) { setPhase("out"); const t = window.setTimeout(() => setShown(null), reduced() ? 120 : 620); return () => window.clearTimeout(t); }
  }, [card]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useMemo(() => ({
    yes: () => { if (shown?.kind === "end") { sfx.click(); dayAnswer("yes", shown.key); } },
    snooze: () => { if (shown?.kind === "end") { sfx.click(); dayAnswer("snooze", shown.key); } },
    ack: () => { if (shown?.kind === "rem") { sfx.click(); dayRemAck(shown.key); } },
  }), [shown]);
  // Esc: "15 more mins" on End day now?, Acknowledged on a reminder.
  useEffect(() => {
    if (!shown || phase !== "in") return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (shown.kind === "end") act.snooze(); else act.ack();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [shown, phase, act]);
  if (PS || !shown) return null;
  const phone = GOS || MWEB;
  const title = shown.kind === "rem" ? WORDS.remind(Math.max(0, shown.end - now)) : shown.title;
  return createPortal(
    <div className={`cd-drop ${phase}${phone ? " phone" : ""}`} role="alertdialog" aria-label={title}>
      {!phone && <div className="cd-isl" aria-hidden="true"><span className="cd-isl-dot" /></div>}
      <div className="cd-card">
        <div className="cd-card-t">{title}</div>
        <div className="cd-card-b">
          {shown.kind === "end" ? (<>
            <button type="button" className="cd-btn main" onClick={act.yes}>{shown.yes}</button>
            <button type="button" className="cd-btn" onClick={act.snooze}>{shown.snooze}</button>
          </>) : <button type="button" className="cd-btn main" onClick={act.ack}>{shown.ack}</button>}
        </div>
      </div>
    </div>, document.body);
}

// ---------- the phone's island inside PS (gos/PhoneIsland.tsx): beside the task, its Priority 1 timer, then the day countdown ----------
export type DayPart = { end: number | null; zero: boolean; p1: number | null; lively: boolean; color: string };
export function IslandDayClocks({ d }: { d: DayPart }) {
  const now = useSecond();
  const left = d.end === null ? 0 : d.zero ? 0 : Math.max(0, d.end - now);
  const stage = d.lively && d.end !== null ? livelyStage(left, d.zero) : 0;
  const p1Left = d.p1 === null ? null : d.p1 - now;
  return (
    <span className="cd-isl-day" aria-hidden="true">
      {p1Left !== null && <span className={`cd-isl-p1${p1Left <= 0 ? " late" : ""}`}>{p1Left > 0 ? clock(p1Left) : WORDS.missed}</span>}
      {d.end !== null && <span className={`cd-isl-cd s${stage}${d.zero ? " zero" : ""}`} style={d.color ? { color: d.color } : undefined}>{clock(left)}</span>}
    </span>
  );
}
