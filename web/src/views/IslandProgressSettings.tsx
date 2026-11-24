// PS 1.77 progress check-ins and task timers (core/islandprogress.ts): Settings, Dynamic Island, Progress check-ins, and the
// per task interval in Add task's Advanced and in a task's Edit (CheckEveryPicker, drawn by views/TimeEstimate.tsx).
//  - ProgressSwitch: On or Off, with a note about the first card while the default is in use.
//  - ProgressBody: how often (the quick picks or a typed time), the timer look (four small live previews), Show me (one sample
//    buzz on this Mac, never saved), and a note when Time spent is off (the check-ins count from its clock).
// Esc closes the typed box (and the screen around it, as everywhere). Nothing here takes the focus by itself.
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../core/model";
import { settingsData } from "../core/select";
import { feature } from "../core/features";
import { islandPrefs } from "../core/island";
import { cleanTe, estLabel } from "../core/timeest";
import * as P from "../core/islandprogress";
import { PS, psInOverlay } from "../ps";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Choice, taskMapActions } from "./TaskMap";
import "./timeest.css";
import "./islandprogress.css";

const save = (patch: Partial<Settings>) => void taskMapActions.looks(patch);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Every word on these screens (waiting for the developer's approval; no em or en dashes). */
export const PROGRESS_UI = {
  firstCard: "On by default. You can turn check-ins off from the first card.",
  every: "How often",
  everyOther: "Other",
  everyHint: "Type it, like 20 or 1h",
  set: "Set",
  look: "Timer look",
  lookLine: "Only on a task with an expected time that you set.",
  showMe: "Show me",
  showing: "Look at your island",
  needsTrack: "Check-ins count from Time spent, which is off. Turn it on in Settings, Your list, Time spent.",
  taskEvery: "Check in every",
  taskDefault: (m: number) => `As in Settings (${estLabel(m)})`,
  taskOff: "Off for this task",
  sample: "Your task",
} as const;

function useProgress() {
  const v = useVault();
  const st = v.status === "unlocked" ? settingsData(v) : null;
  const isl = islandPrefs(st?.island);
  const set = (patch: Partial<P.ProgressPrefs>) => { if (st) save({ island: { ...isl, progress: { ...isl.progress, ...patch } } } as Partial<Settings>); };
  return { ready: !!st, p: isl.progress, set, track: cleanTe(st?.timeEst).track, st };
}

/** The row's On and Off. */
export function ProgressSwitch({ label }: { label: string }) {
  const { ready, p, set } = useProgress();
  const on = P.progressOn(p);
  return (
    <span className={`tm-ed-seg${ready ? "" : " gs-notyet"}`} role="radiogroup" aria-label={label}>
      <Choice selected={ready && on} onPick={() => { if (ready) { sfx.hover(); set({ on: true }); } }}>On</Choice>
      <Choice selected={ready && !on} onPick={() => { if (ready) { sfx.hover(); set({ on: false }); } }}>Off</Choice>
    </span>
  );
}

/** Quick picks, or a typed time, for an interval. `value` null with `def`: the default chip is picked. */
function EveryChips({ value, onPick, def, off, label }: { value: number | null; onPick: (m: number | null) => void; def?: number; off?: boolean; label: string }) {
  const known = (P.EVERY_CHOICES as readonly number[]).includes(value ?? -1);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(value && !known ? estLabel(value) : "");
  const read = P.parseEvery(text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (typing) input.current?.focus({ preventScroll: true }); }, [typing]);
  const pick = (m: number | null) => { sfx.click(); setTyping(false); onPick(m); };
  return (
    <div className={`te-pick ip-every${reduced() ? " still" : ""}`} role="group" aria-label={label}>
      {def !== undefined && <button type="button" className={`te-chip${value === null ? " on" : ""}`} aria-pressed={value === null} onClick={() => pick(null)}>{PROGRESS_UI.taskDefault(def)}</button>}
      {P.EVERY_CHOICES.map((m) => (
        <button key={m} type="button" className={`te-chip${value === m ? " on" : ""}`} aria-pressed={value === m} onClick={() => pick(m)}>{estLabel(m)}</button>
      ))}
      {typing ? (
        <span className="te-type">
          <input ref={input} className={`te-in${text && read === null ? " bad" : ""}`} value={text} placeholder={PROGRESS_UI.everyHint} aria-label={PROGRESS_UI.everyHint}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (read !== null) pick(read); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTyping(false); }
            }} />
          <button type="button" className="te-chip te-set" disabled={read === null} onClick={() => read !== null && pick(read)}>{PROGRESS_UI.set}</button>
        </span>
      ) : (
        <button type="button" className={`te-chip te-other${value && !known ? " on" : ""}`} onClick={() => { sfx.hover(); setTyping(true); }}>
          {value && !known ? estLabel(value) : PROGRESS_UI.everyOther}
        </button>
      )}
      {off && <button type="button" className={`te-chip${value === 0 ? " on" : " te-none"}`} aria-pressed={value === 0} onClick={() => pick(0)}>{PROGRESS_UI.taskOff}</button>}
    </div>
  );
}

/** One look, drawn small on a black island with a sample task, running on a loop (still under Reduce motion). */
export function LookPreview({ look, title = PROGRESS_UI.sample }: { look: P.ProgressLook; title?: string }) {
  return (
    <span className={`ip-isle ip-is-${look}`} aria-hidden="true">
      <span className="ip-name">{title}{look === "line" && <i className="ip-line" />}</span>
      {look === "ring" && (
        <svg className="ip-ring" viewBox="0 0 20 20" width="15" height="15"><circle cx="10" cy="10" r="7.5" className="ip-ring-bg" /><circle cx="10" cy="10" r="7.5" className="ip-ring-fg" /></svg>
      )}
      {look === "sand" && (
        <svg className="ip-sand" viewBox="0 0 20 20" width="15" height="15">
          <path className="ip-sand-glass" d="M5 3h10M5 17h10M6 3c0 4 4 5 4 7s-4 3-4 7M14 3c0 4-4 5-4 7s4 3 4 7" />
          <path className="ip-sand-top" d="M7 5h6c-.6 2-3 3.2-3 4.2C10 8.2 7.6 7 7 5z" />
          <path className="ip-sand-bot" d="M7 15.6h6c-.5-1.4-2-2.4-3-3.2-1 .8-2.5 1.8-3 3.2z" />
        </svg>
      )}
      {look === "text" && <span className="ip-left num">16m</span>}
    </span>
  );
}

/** Under the row: how often, the look, Show me, and the note about Time spent. */
export function ProgressBody() {
  const { ready, p, set, track, st } = useProgress();
  const [shown, setShown] = useState(false);
  const show = () => {
    sfx.click(); setShown(true); window.setTimeout(() => setShown(false), 6_000);
    // The main window holds the island's line to the Mac; from the Tab list it goes there with the other Tab list asks (src/ps.ts).
    if (psInOverlay()) save({ progressTest: { look: p.look } } as Partial<Settings>);
    else void import("../island").then((m) => m.islandProgressTest(p.look, null));
  };
  if (!feature(P.PROGRESS_FEATURE)) return null;
  return (
    <div className="ip-body">
      {p.on === null && <p className="gs-set-note">{PROGRESS_UI.firstCard}</p>}
      {ready && st && !track && <p className="gs-set-note ip-warn">{PROGRESS_UI.needsTrack}</p>}
      <div className="ip-part">
        <span className="te-label">{PROGRESS_UI.every}</span>
        <EveryChips value={p.every} onPick={(m) => m && set({ every: m })} label={PROGRESS_UI.every} />
      </div>
      <div className="ip-part">
        <span className="te-label">{PROGRESS_UI.look}</span>
        <div className="ip-looks" role="radiogroup" aria-label={PROGRESS_UI.look}>
          {P.LOOKS.map((l) => (
            <button key={l.k} type="button" role="radio" aria-checked={p.look === l.k} className={`ip-look${p.look === l.k ? " on" : ""}${reduced() ? " still" : ""}`}
              onClick={() => { if (ready) { sfx.hover(); set({ look: l.k }); } }}>
              <LookPreview look={l.k} />
              <b>{l.label}</b>
              <span>{l.line}</span>
            </button>
          ))}
        </div>
        <span className="ip-hint">{PROGRESS_UI.lookLine}</span>
      </div>
      {PS && (
        <div className="ip-part ip-try">
          <button type="button" className="te-chip" disabled={!ready || shown} onClick={show}>{shown ? PROGRESS_UI.showing : PROGRESS_UI.showMe}</button>
        </div>
      )}
    </div>
  );
}

/** Per task, in Add task's Advanced and in Edit (views/TimeEstimate.tsx): As in Settings, a quick pick, typed, or Off for this
 *  task. Only while check-ins are on or still to be asked about (switched off: nothing to set). */
export function CheckEveryPicker({ value, onPick, label, rowCls }: { value: number | null; onPick: (m: number | null) => void; label: string; rowCls: string }) {
  const { p } = useProgress();
  if (!feature(P.PROGRESS_FEATURE) || p.on === false) return null;
  return (
    <>
      <span className={label}>{PROGRESS_UI.taskEvery}</span>
      <div className={rowCls}><EveryChips value={value} onPick={onPick} def={p.every} off label={PROGRESS_UI.taskEvery} /></div>
    </>
  );
}
