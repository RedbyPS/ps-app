// The Dynamic Island's settings, built once (V1.58) and shown in three places, so they never drift:
//  - the island settings window: a wide landscape window, sections on the left (the developer, 13 Nov 2026: "make it pop up in a
//    bigger settings menu, like a landscape settings menu with everything much neater, instead of the long portrait
//    looking thing"). Opened by Settings in the island's own right click menu (ps-mac Island.swift, through
//    window.__psOpenIslandSettings) and by openIslandSettings();
//  - Settings, its own "Dynamic Island" tab (core/settingsindex.ts group "island"): the same sections one under the
//    other, right there (the developer: "this tab must hold the island settings THEMSELVES");
//  - the older Mac settings page (views/PsSettings.tsx IslandPlace).
// Every row saves the same way as before (settings.island, synced; the island's spot on this Mac through
// {type:"island:reset"}). While the island is away (right click > Disappear), the top row says until when and brings
// it back now ({type:"island:show"}).
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PS, psPost, usePsSettings } from "../ps";
import { sfx } from "../ui/sfx";
import type { IslandPrefs } from "../core/island";
import { feature } from "../core/features";
import { PROGRESS_FEATURE } from "../core/islandprogress";
import { ProgressBody, ProgressSwitch } from "./IslandProgressSettings";
import { islandPicVars } from "../core/looksample";
import { IslandHideRow } from "./IslandHide";
import { IslandCardsRows, IslandFullScreenRow, IslandSoundsRow, IslandTickSideRow } from "./IslandCards";
import { IslandLookEditor, LookEditButton, noNotch, type LookKind } from "./IslandLook";
import "./islandsettings.css";

/** Saves a change to the island's settings (the caller's own save: the Tab list's or Settings'). Silent: the rows make
 *  their own click sound (the look editor saves while sliding, so it makes none). */
export type IslandSave = (p: Partial<IslandPrefs>) => void;

export const ISLAND_MODES: { id: IslandPrefs["mode"]; label: string; hint: string }[] = [
  { id: "notch", label: "Around the notch", hint: "Grows out of the camera notch" },
  { id: "pill", label: "Pill below the notch", hint: "A floating pill just under it" },
  { id: "off", label: "Off", hint: "No island" },
];

export type IslSection = "look" | "position" | "fullscreen" | "notify" | "progress";
const PROGRESS_SECTION_LABEL = "Progress check-ins";
export const ISL_SECTIONS: { id: IslSection; name: string; line: string; mac: boolean }[] = [
  { id: "look", name: "Look", line: "Its shape, colours and tick circle", mac: false },
  { id: "position", name: "Position", line: "Where it sits and its hide line", mac: false },
  { id: "fullscreen", name: "Full screen", line: "The top bar over full screen apps", mac: true },
  { id: "notify", name: "Notifications", line: "Cards that come out of the island", mac: true },
  { id: "progress", name: PROGRESS_SECTION_LABEL, line: "Check-ins while you work", mac: true },
];
/** The main Settings tab already has a searchable progress row. Include it directly in the island's own window. */
export const islSections = (ps: boolean, showProgress = false) =>
  ISL_SECTIONS.filter((x) => (ps || !x.mac) && (x.id !== "progress" || showProgress));

// ---------- the island away (right click > Disappear) ----------
/** "3:40 PM" for an end time (ms). */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** What the away row says: until a time, or until the meeting ends (at its time). */
export function islandAwayText(a: { kind: string; until: number }): string {
  return a.kind === "meeting" ? `Hidden until this meeting ends, at ${clock(a.until)}` : `Hidden until ${clock(a.until)}`;
}
/** While the island is away: until when, and Show it now. Nothing otherwise. */
export function IslandAwayRow() {
  const a = usePsSettings()?.islandAway;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!a) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.max(1000, Math.min(60_000, a.until - Date.now() + 500)));
    return () => window.clearTimeout(t);
  });
  if (!PS || !a || a.until <= Date.now()) return null;
  return (
    <div className="isl-away" role="status">
      <span className="tm-isl-l">The island is hidden<em>{islandAwayText(a)}</em></span>
      <button type="button" className="isl-away-btn" onClick={() => { sfx.click(); psPost({ type: "island:show" }); }}>Show it now</button>
    </div>
  );
}

/** Where the island sits on this Mac (G Squad, Island.swift): moved by its grab line, put back here. */
export function IslandPosRow() {
  const ps = usePsSettings();
  useEffect(() => { psPost({ type: "psSettings:get" }); }, []);
  const moved = !!ps?.islandMoved;
  return (
    <div className="tm-isl-pos">
      <span className="tm-isl-l">Position<em>{moved ? "Moved. Drag its top line to move it again" : "Drag its top line to move it anywhere, even into the top bar or a corner"}</em></span>
      <button type="button" className="tm-isl-posbtn" disabled={!moved} onClick={() => { sfx.click(); psPost({ type: "island:reset" }); }}>Put back at the top</button>
    </div>
  );
}

/** The rows of one section, the same wherever they show. Look: the three shapes (or a look's editor), the tick
 *  circle side and the next Priority 1 switch. */
export function IslandSectionRows({ id, prefs, save, edit, setEdit }: { id: IslSection; prefs: IslandPrefs; save: IslandSave; edit: LookKind | null; setEdit: (k: LookKind | null) => void }): ReactNode {
  const on = prefs.mode !== "off";
  const full = (p: IslandPrefs) => { sfx.click(); save(p); };
  if (id === "look") return edit ? (
    <IslandLookEditor key={edit} kind={edit} pill={prefs.pill} notch={prefs.notch} onBack={() => setEdit(null)}
      onSave={(k, look) => save({ mode: k, [k]: look })} />
  ) : (<>
    <div className="isw-shapes" role="radiogroup" aria-label="Shape">
      {ISLAND_MODES.map((m) => (
        <div key={m.id} className="tm-isl-row">
          <button type="button" role="radio" aria-checked={prefs.mode === m.id} className={`tm-isl-opt${prefs.mode === m.id ? " sel" : ""}`}
            onClick={() => { if (prefs.mode !== m.id) { sfx.click(); save({ mode: m.id }); } }}>
            <i className={`tm-isl-pic ${m.id}`} style={m.id === "off" ? undefined : islandPicVars(m.id, m.id === "pill" ? prefs.pill : prefs.notch) as CSSProperties} aria-hidden="true"><b /><s /></i>
            <span className="tm-isl-l">{m.label}<em>{m.id === "notch" && noNotch() ? "No notch on this Mac: shows as the pill" : m.hint}</em></span>
          </button>
          {m.id !== "off" && <LookEditButton kind={m.id} onEdit={setEdit} />}
        </div>
      ))}
    </div>
    {/* Which side of the island the tick circle sits on. */}
    {PS && <IslandTickSideRow prefs={prefs} save={full} />}
    <button type="button" role="switch" aria-checked={prefs.idle === "next"} disabled={!on}
      className={`tm-isl-sw${prefs.idle === "next" ? " sel" : ""}`} onClick={() => { sfx.click(); save({ idle: prefs.idle === "next" ? "none" : "next" }); }}>
      <span className="tm-isl-l">When nothing is in progress, show the next Priority 1 task<em>Dimmed, until you start a task</em></span>
      <i className="tm-isl-tog" aria-hidden="true"><b /></i>
    </button>
  </>);
  if (id === "position") return (<>
    {/* G Squad: drag the island's grab line to move it anywhere (Island.swift); this puts it back. */}
    {PS && <IslandPosRow />}
    {/* V1.40: how long a click on the grab line hides it (1 minute unless set). */}
    <IslandHideRow value={prefs.hide} disabled={!on} onPick={(hide) => { sfx.click(); save({ hide }); }} />
  </>);
  if (id === "fullscreen") return (<>
    {/* Over a full screen app: sit in the top bar, the black band beside the notch (V1.58 words). */}
    {PS && <IslandFullScreenRow prefs={prefs} save={full} />}
  </>);
  if (id === "progress") return (
    <>
      <div className="tm-isl-pos">
        <span className="tm-isl-l">{PROGRESS_SECTION_LABEL}</span>
        <ProgressSwitch label={PROGRESS_SECTION_LABEL} />
      </div>
      <ProgressBody />
    </>
  );
  return (<>
    {/* V1.55: the Mac's notification cards come out of the island, and which kinds go to the top right instead. */}
    {PS && <IslandCardsRows prefs={prefs} save={full} />}
    {/* PS 1.60: the chime of the island's big moments. */}
    {PS && <IslandSoundsRow prefs={prefs} save={full} />}
  </>);
}

/** Every section one under the other, each with its heading (Settings, Dynamic Island tab; the older Mac settings). */
export function IslandSettingsPage({ prefs, save }: { prefs: IslandPrefs; save: IslandSave }) {
  const [edit, setEdit] = useState<LookKind | null>(null);
  return (
    <div className="isp">
      <IslandAwayRow />
      {islSections(PS).map((x) => (
        <section key={x.id} className="isp-sec" aria-label={x.name}>
          <h3 className="isp-h">{x.name}<em>{x.line}</em></h3>
          <div className="isl-rows"><IslandSectionRows id={x.id} prefs={prefs} save={save} edit={x.id === "look" ? edit : null} setEdit={setEdit} /></div>
        </section>
      ))}
    </div>
  );
}

// ---------- the window ----------
let want: IslSection | null = null;
const subs = new Set<() => void>();
/** The section last looked at, kept while PS runs, so the window opens where it was left. */
let lastSection: IslSection = "look";
/** Opens the island settings window (on a section, or where it was left); null closes it. */
export function openIslandSettings(section?: IslSection | null) {
  want = section === null ? null : section ?? lastSection;
  subs.forEach((f) => f());
}
const useWant = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => want);

const OUT_MS = 170;
function IslandSectionIcon({ id }: { id: IslSection }) {
  const p = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (id === "look") return <svg {...p}><rect x="3" y="8" width="18" height="8" rx="4" /><circle cx="16.5" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>;
  if (id === "position") return <svg {...p}><path d="M12 3v18M3 12h18" /><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></svg>;
  if (id === "fullscreen") return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 8.5h18" /><rect x="6" y="5.4" width="6" height="1.8" rx=".9" fill="currentColor" stroke="none" /></svg>;
  if (id === "progress") return <svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>;
  return <svg {...p}><rect x="4" y="5" width="16" height="6" rx="3" /><path d="M7 15h10M9 19h6" /></svg>;
}

/** The landscape window. Mounted once by the Tab list (views/TaskMap.tsx); shows while openIslandSettings() wants it.
 *  Esc steps back out of a look's editor first, then closes it; a click outside or the X closes it too. */
export function IslandSettingsWindow({ prefs, save }: { prefs: IslandPrefs; save: IslandSave }) {
  const wanted = useWant();
  const [out, setOut] = useState(false);
  const [edit, setEdit] = useState<LookKind | null>(null);
  const editing = useRef(edit);
  editing.current = edit;
  const win = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const outTimer = useRef<number | undefined>(undefined);
  const open = wanted !== null;
  const on = prefs.mode !== "off";
  const sections = islSections(PS, feature(PROGRESS_FEATURE));
  const shown = sections.some((x) => x.id === wanted) ? wanted! : "look";
  const pick = (id: IslSection) => { if (id === shown && !edit) return; sfx.click(); lastSection = id; setEdit(null); openIslandSettings(id); };
  // Closes with a short fade and shrink (none with reduce motion), then leaves the page.
  const close = () => {
    if (outTimer.current !== undefined || want === null) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setOut(true);
    outTimer.current = window.setTimeout(() => {
      outTimer.current = undefined; setOut(false); setEdit(null); openIslandSettings(null);
      back.current?.focus?.(); back.current = null;
    }, calm ? 0 : OUT_MS);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  // ps-mac Island.swift: Settings in the island's right click menu shows the Tab list and calls this.
  useEffect(() => {
    if (!PS) return;
    const g = window as Window & { __psOpenIslandSettings?: () => boolean };
    g.__psOpenIslandSettings = () => { openIslandSettings(); return true; };
    return () => { if (g.__psOpenIslandSettings) delete g.__psOpenIslandSettings; };
  }, []);
  useEffect(() => () => { if (outTimer.current !== undefined) window.clearTimeout(outTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    win.current?.focus({ preventScroll: true });
    // Esc steps back out of a look's editor first, then closes the window.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); if (editing.current) setEdit(null); else closeRef.current(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  if (!open) return null;
  const here = sections.find((x) => x.id === shown)!;
  return createPortal(
    <div className={`isw-back${out ? " out" : ""}`} onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div ref={win} className={`isw${out ? " out" : ""}`} role="dialog" aria-modal="true" aria-label="Dynamic Island settings" tabIndex={-1}>
        <nav className="isw-side" aria-label="Dynamic Island settings sections">
          <div className="isw-title">
            <span className="tm-isl-h">Dynamic Island</span>
            <span className={`isw-state${on ? " on" : ""}`}>{on ? "On" : "Off"}</span>
          </div>
          {sections.map((x) => (
            <button key={x.id} type="button" className={`isw-tab${x.id === shown ? " sel" : ""}`} aria-current={x.id === shown ? "page" : undefined} onClick={() => pick(x.id)}>
              <i className="isw-ico"><IslandSectionIcon id={x.id} /></i>
              <span className="isw-tab-l">{x.name}<em>{x.line}</em></span>
            </button>
          ))}
        </nav>
        <section className="isw-main">
          <header className="isw-head">
            <h3>{here.name}</h3>
            <button type="button" className="isw-x" aria-label="Close the island settings" title="Close (Esc)" onClick={() => { sfx.click(); close(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          <div className="isw-pane isl-rows" key={`${shown}-${edit ?? ""}`}>
            <IslandAwayRow />
            <IslandSectionRows id={shown} prefs={prefs} save={save} edit={edit} setEdit={setEdit} />
          </div>
        </section>
      </div>
    </div>, document.body);
}
