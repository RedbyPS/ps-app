// Screen recorder, the screens (PS 1.60, pull request 12a): the Record button below the email panel in the Tab overlay (with a
// gear, a right click menu, a red dot and a timer), the "What to record" picker, and the Screen recording group in Settings.
// All the rules are in core/screenrec.ts, the bridge in src/screenrec.ts, the recording itself in the Mac app (ScreenRec.swift).
//
// OFF until the person says yes: the button draws nothing, and these screens ask the Mac for nothing but its saved choices.
// Esc closes every screen and menu here (the newest first, core/escape.ts). Reduced motion turns the pulse off.
// Private mode (settings.privateMode) hides the red dot, the timer and the button's name for a screen reader; the recording itself keeps going.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PS } from "../ps";
import { sfx } from "../ui/sfx";
import { vaultStore } from "../core/vault";
import { settingsData } from "../core/select";
import { feature } from "../core/features";
import { appName } from "../core/appname";
import {
  AUDIO_LABEL, CODEC_LABEL, FPS_LIST, PRESET_LIST, QUALITY_LABEL, RES_LABEL, SR_FEATURE, SR_WORDS, buttonLabel, buttonShows, clickAction, isRecording,
  menuItems, missingPermission, settingsShows, signs, type SRChoices, type SRMenuId, type ScreenRecState,
} from "../core/screenrec";
import { askScreenRec, change, optIn, send, useScreenRec, usePickList } from "../screenrec";
import { openSettings } from "./SettingsScreen";
import { CloudSettings } from "./ScreenRecCloud";
import "./screenrec.css";

// ---------- who opens the picker (the button, its menu and Settings share it) ----------
type Section = "screen" | "mic" | "leave" | null;
let picker: { open: boolean; section: Section } = { open: false, section: null };
const subs = new Set<() => void>();
const setPicker = (open: boolean, section: Section = null) => { picker = { open, section }; subs.forEach((f) => f()); };
function usePicker() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return picker;
}

/** Esc closes the top layer (core/escape.ts: the newest listener is asked first). */
function useEsc(on: boolean, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); close(); };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [on, close]);
}
function useAway(on: boolean, ref: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const away = (e: MouseEvent) => { if (e.button === 0 && !ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  }, [on, ref, close]);
}

const privateOn = () => settingsData(vaultStore.get()).privateMode === true;
/** Re-reads private mode, and (only while a recording is showing) the clock once a second. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return now;
}
function usePrivate(): boolean {
  const [p, setP] = useState(privateOn);
  useEffect(() => { setP(privateOn()); const off = vaultStore.subscribe(() => setP(privateOn())); return () => { off(); }; }, []);
  return p;
}

const REC_ICON = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="12.5" rx="2.6" /><circle cx="12" cy="10.75" r="2.6" fill="currentColor" stroke="none" /><path d="M8.5 20.5h7" />
  </svg>
);
const GEAR_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);

// ---------- the button ----------
export function ScreenRecButton() {
  const st = useScreenRec();
  const priv = usePrivate();
  useEffect(() => { askScreenRec(); }, []);
  const rec = isRecording(st);
  const now = useNow(rec && !priv);
  const wrap = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<null | "controls" | "remind" | "menu">(null);
  const close = () => setPop(null);
  useEsc(pop !== null, close);
  useAway(pop !== null, wrap, close);
  useEffect(() => { if (!rec && pop === "controls") setPop(null); }, [rec, pop]);
  if (!buttonShows({ ps: PS, docked: false, st })) return null;
  const sg = signs(st, now, priv);
  const act = () => {
    sfx.click();
    const c = clickAction(st!);
    if (c === "controls") setPop((x) => (x === "controls" ? null : "controls"));
    else if (c === "picker" || c === "explainScreen" || c === "explainMic") setPicker(true);
    else if (c === "start") { if (st!.settings.remind) setPop("remind"); else send("start"); }
  };
  const doMenu = (id: SRMenuId) => {
    sfx.click(); setPop(null);
    if (id === "start") { const c = clickAction(st!); if (c === "start") { if (st!.settings.remind) setPop("remind"); else send("start"); } else setPicker(true); }
    else if (id === "stop") send("stop");
    else if (id === "screen") setPicker(true, "screen");
    else if (id === "mic") setPicker(true, "mic");
    else if (id === "leaveOut") setPicker(true, "leave");
    else if (id === "folder") send("chooseFolder");
    else if (id === "settings") openSettings("screenrec");
  };
  return (
    <div className="sr-wrap tm-pop-wrap" ref={wrap} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`tm-pill-btn sr-btn${rec && !priv ? " live" : ""}${(st!.state === "starting" || st!.state === "stopping") && !priv ? " busy" : ""}`}
        aria-label={buttonLabel(st, priv)} aria-expanded={pop !== null} title={SR_WORDS.button}
        onClick={(e) => { if (e.button === 0) act(); }}
        onContextMenu={(e) => { e.preventDefault(); setPop("menu"); }}>
        {REC_ICON}
        <span className="sr-lab">{SR_WORDS.button}</span>
        {sg.dot && <i className={`sr-dot${sg.pulsing ? " pulse" : ""}`} aria-hidden="true" />}
        {sg.timer && <b className="sr-time num" role="timer" aria-live="off">{sg.timer}</b>}
        {sg.paused && <em className="sr-paused">{SR_WORDS.paused}</em>}
      </button>
      <button type="button" className="sr-gear" aria-label={SR_WORDS.gear} title={SR_WORDS.gear}
        onClick={(e) => { e.stopPropagation(); sfx.click(); openSettings("screenrec"); }}>{GEAR_ICON}</button>
      {pop === "menu" && (
        <div className="tm-pop sr-pop sr-menu" role="menu" aria-label={SR_WORDS.button}>
          {menuItems(st!).map((m) => <button key={m.id} type="button" role="menuitem" onClick={() => doMenu(m.id)}>{m.label}</button>)}
        </div>
      )}
      {pop === "remind" && (
        <div className="tm-pop sr-pop" role="dialog" aria-label={SR_WORDS.remind}>
          <span className="sr-remind">{SR_WORDS.remind}</span>
          {st!.folderNote && <span className="sr-warn">{st!.folderNote}</span>}
          <div className="sr-row">
            <button type="button" className="sr-b on" onClick={() => { sfx.click(); setPop(null); send("start"); }}>{SR_WORDS.start}</button>
            <button type="button" className="sr-b" onClick={() => { sfx.click(); setPop(null); }}>{SR_WORDS.cancel}</button>
          </div>
        </div>
      )}
      {pop === "controls" && rec && (
        <div className="tm-pop sr-pop" role="dialog" aria-label={SR_WORDS.button}>
          <div className="sr-row">
            {st!.state === "paused"
              ? <button type="button" className="sr-b on" onClick={() => { sfx.click(); send("resume"); }}>{SR_WORDS.resume}</button>
              : <button type="button" className="sr-b" onClick={() => { sfx.click(); send("pause"); }}>{SR_WORDS.pause}</button>}
            <button type="button" className="sr-b stop" onClick={() => { sfx.click(); setPop(null); send("stop"); }}>{SR_WORDS.stop}</button>
          </div>
          <label className="sr-field"><span>{SR_WORDS.switchMic}</span><MicSelect st={st!} live /></label>
        </div>
      )}
      {st!.error && !rec && <span className="sr-err" role="alert">{st!.error}</span>}
    </div>
  );
}

/** The picker, mounted once in the Tab list (the button, its menu and Settings all open it). */
export function ScreenRecHost() {
  const st = useScreenRec();
  return st ? <ScreenRecPicker st={st} /> : null;
}

// ---------- small pieces ----------
function Seg<T extends string | number>({ value, options, set, label }: { value: T; options: { id: T; label: string; title?: string }[]; set: (v: T) => void; label: string }) {
  return (
    <div className="tm-ed-seg sr-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={String(o.id)} type="button" role="radio" aria-checked={value === o.id} title={o.title} className={`dwell${value === o.id ? " on" : ""}`}
        onClick={() => { if (value !== o.id) { sfx.hover(); set(o.id); } }}>{o.label}</button>)}
    </div>
  );
}
function Switch({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return <Seg value={on ? "on" : "off"} label={label} set={(v) => set(v === "on")} options={[{ id: "on", label: "On" }, { id: "off", label: "Off" }]} />;
}
function MicSelect({ st, live }: { st: ScreenRecState; live?: boolean }) {
  const s = st.settings;
  const value = !s.micOn ? "__off" : s.micUID ?? "";
  return (
    <select className="gs-sel sr-sel" value={value} aria-label={SR_WORDS.micTitle} onChange={(e) => {
      const v = e.target.value;
      if (v === "__off") change("micOn", false);
      else { if (!s.micOn) change("micOn", true); if (live) send("switchMic", { uid: v }); else change("micUID", v === "" ? null : v); }
    }}>
      <option value="">{SR_WORDS.micDefault}</option>
      {st.mics.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}
      <option value="__off">{SR_WORDS.micOff}</option>
    </select>
  );
}

/** A macOS permission, explained BEFORE macOS asks (the person presses the button, never the page on its own). */
export function SrPerm({ kind, st }: { kind: "screen" | "mic"; st: ScreenRecState }) {
  const [pressed, setPressed] = useState(false);
  const p = st.perms[kind];
  const app = appName();
  const f = (t: string) => t.split("PS").join(app);
  const title = kind === "screen" ? SR_WORDS.permScreenTitle : SR_WORDS.permMicTitle;
  const why = kind === "screen" ? SR_WORDS.permScreenWhy : SR_WORDS.permMicWhy;
  const go = kind === "screen" ? SR_WORDS.permScreenGo : SR_WORDS.permMicGo;
  const state = p === "granted" ? "done" : p === "denied" ? "denied" : pressed ? "waiting" : "idle";
  return (
    <div className={`sr-perm ${state}`} role="group" aria-label={f(title)}>
      <b>{f(title)}</b>
      <span>{f(why)}</span>
      {state === "done" && <em role="status">{SR_WORDS.permDone}</em>}
      {state === "waiting" && kind === "screen" && <em role="status">{f(SR_WORDS.permScreenWait)}</em>}
      {state === "denied" && <em role="status">{f(SR_WORDS.permDenied)}</em>}
      {state !== "done" && (
        <div className="sr-row">
          <button type="button" className="sr-b on" onClick={() => { sfx.click(); setPressed(true); send(kind === "screen" ? "askScreen" : "askMic"); }}>{state === "denied" ? (kind === "screen" ? SR_WORDS.openScreen : SR_WORDS.openMic) : f(go)}</button>
        </div>
      )}
      {state === "denied" && <button type="button" className="sr-link" onClick={() => { sfx.click(); send("privacy", { pane: kind }); }}>{kind === "screen" ? SR_WORDS.openScreen : SR_WORDS.openMic}</button>}
    </div>
  );
}

/** Calls, Sharp, Tiny, Custom, and every value they set, with the space an hour takes from the real settings. */
function Quality({ st }: { st: ScreenRecState }) {
  const s = st.settings;
  const audioOnly = s.mode === "audioOnly";
  return (
    <div className="sr-quality">
      <div className="sr-presets" role="radiogroup" aria-label={SR_WORDS.presets}>
        {PRESET_LIST.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={s.preset === p.id} title={p.line} className={`sr-chip${s.preset === p.id ? " on" : ""}`}
            onClick={() => { sfx.click(); if (p.id !== "custom") send("preset", { id: p.id }); }}>{p.label}</button>
        ))}
      </div>
      <span className="sr-hint">{PRESET_LIST.find((p) => p.id === s.preset)?.line}</span>
      {!audioOnly && (
        <>
          <label className="sr-field"><span>{SR_WORDS.resolution}</span>
            <Seg value={s.resolution} label={SR_WORDS.resolution} set={(v) => change("resolution", v)} options={st.resolutions.map((r) => ({ id: r, label: RES_LABEL[r] }))} /></label>
          <label className="sr-field"><span>{SR_WORDS.frameRate}</span>
            <Seg value={s.fps} label={SR_WORDS.frameRate} set={(v) => change("fps", v)} options={FPS_LIST.map((n) => ({ id: n, label: String(n) }))} /></label>
          <label className="sr-field"><span>{SR_WORDS.quality}</span>
            <Seg value={s.quality} label={SR_WORDS.quality} set={(v) => change("quality", v)} options={(Object.keys(QUALITY_LABEL) as SRChoices["quality"][]).map((q) => ({ id: q, label: QUALITY_LABEL[q] }))} /></label>
          <label className="sr-field"><span>{SR_WORDS.format}</span>
            <Seg value={s.codec} label={SR_WORDS.format} set={(v) => change("codec", v)} options={(Object.keys(CODEC_LABEL) as SRChoices["codec"][]).map((c) => ({ id: c, label: CODEC_LABEL[c] }))} /></label>
        </>
      )}
      <label className="sr-field"><span>{SR_WORDS.audioQuality}</span>
        <Seg value={s.audioQuality} label={SR_WORDS.audioQuality} set={(v) => change("audioQuality", v)} options={(Object.keys(AUDIO_LABEL) as SRChoices["audioQuality"][]).map((q) => ({ id: q, label: AUDIO_LABEL[q] }))} /></label>
      <span className="sr-space" role="status">{SR_WORDS.space} {st.space}.</span>
    </div>
  );
}

function LeaveOut({ st }: { st: ScreenRecState }) {
  const list = usePickList();
  useEffect(() => { if (st.enabled && st.perms.screen === "granted") send("list"); }, [st.enabled, st.perms.screen]);
  const chosen = new Set(st.settings.leftOut);
  const rows = list?.apps ?? [];
  const extra = st.settings.leftOut.filter((id) => !rows.some((r) => r.id === id));
  return (
    <div className="sr-leave" role="group" aria-label={SR_WORDS.leaveTitle}>
      {rows.map((a) => (
        <label key={a.id} className={`sr-app${chosen.has(a.id) ? " on" : ""}`}>
          <input type="checkbox" checked={chosen.has(a.id)} onChange={() => { sfx.click(); send("leaveOut", { id: a.id }); }} />
          {a.icon ? <img src={a.icon} alt="" width={20} height={20} /> : <span className="sr-noic" aria-hidden="true">{a.name.slice(0, 1)}</span>}
          <span>{a.name}</span>
        </label>
      ))}
      {extra.map((id) => (
        <label key={id} className="sr-app on"><input type="checkbox" checked onChange={() => { sfx.click(); send("leaveOut", { id }); }} /><span className="sr-noic" aria-hidden="true">{id.slice(0, 1)}</span><span>{id}</span></label>
      ))}
      {!rows.length && !extra.length && <span className="sr-hint">{st.perms.screen === "granted" ? SR_WORDS.noList : SR_WORDS.allowFirst}</span>}
    </div>
  );
}

function Folder({ st }: { st: ScreenRecState }) {
  return (
    <div className="sr-folder">
      <span className="sr-fname">{st.folder.isDefault ? SR_WORDS.folderDefault : st.folder.name}</span>
      {st.folder.missing && <span className="sr-warn">{SR_WORDS.folderMissing}</span>}
      <div className="sr-row">
        <button type="button" className="sr-b" onClick={() => { sfx.click(); send("chooseFolder"); }}>{SR_WORDS.choose}</button>
        {!st.folder.isDefault && <button type="button" className="sr-b" onClick={() => { sfx.click(); send("resetFolder"); }}>{SR_WORDS.useDefault}</button>}
        <button type="button" className="sr-b" onClick={() => { sfx.click(); send("showFolder"); }}>{SR_WORDS.show}</button>
      </div>
      <span className="sr-hint">{SR_WORDS.namesLine}</span>
    </div>
  );
}

// ---------- the picker ----------
export function ScreenRecPicker({ st }: { st: ScreenRecState }) {
  const { open, section } = usePicker();
  const ref = useRef<HTMLDivElement>(null);
  const list = usePickList();
  const close = () => setPicker(false);
  useEsc(open, close);
  useEffect(() => { if (open && st.enabled && st.perms.screen === "granted") send("list"); }, [open, st.enabled, st.perms.screen]);
  useEffect(() => {
    if (!open || !section) return;
    window.setTimeout(() => ref.current?.querySelector(`[data-sec="${section}"]`)?.scrollIntoView({ block: "start" }), 30);
  }, [open, section]);
  if (!open || !buttonShows({ ps: PS, docked: false, st })) return null;
  const s = st.settings;
  const need = missingPermission(st);
  const audioOnly = s.mode === "audioOnly";
  const src = s.source;
  const go = () => {
    sfx.click(); change("picked", true); setPicker(false);
    if (st.settings.remind) { /* the reminder is the line in this dialog */ }
    send("start");
  };
  const content: ReactNode = (
    <div className="sr-layer" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="sr-dim" aria-hidden="true" onClick={close} />
      <section className="sr-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={SR_WORDS.pickerTitle}>
        <header><b>{SR_WORDS.pickerTitle}</b><button type="button" className="sr-x" aria-label={SR_WORDS.close} onClick={() => { sfx.click(); close(); }}>x</button></header>
        <div className="sr-scroll">
          <Seg value={s.mode} label={SR_WORDS.pickerTitle} set={(v) => change("mode", v)} options={[{ id: "screenAndAudio", label: SR_WORDS.modeScreen }, { id: "audioOnly", label: SR_WORDS.modeAudio }]} />
          {audioOnly && <span className="sr-hint">{SR_WORDS.audioOnlyLine}</span>}
          {need === "screen" && <SrPerm kind="screen" st={st} />}
          {need === "mic" && <SrPerm kind="mic" st={st} />}
          {!audioOnly && (
            <div data-sec="screen" className="sr-sec">
              <h4>{SR_WORDS.whole}</h4>
              <div className="sr-thumbs">
                {(list?.displays ?? []).map((d) => (
                  <button key={d.id} type="button" className={`sr-thumb${src.kind === "display" && src.id === d.id ? " on" : ""}`} onClick={() => { sfx.click(); change("source", { kind: "display", id: d.id }); }}>
                    {d.thumb ? <img src={d.thumb} alt="" /> : <span className="sr-nothumb" aria-hidden="true" />}<span>{d.name}</span>
                  </button>
                ))}
                <button type="button" className={`sr-thumb${src.kind === "main" ? " on" : ""}`} onClick={() => { sfx.click(); change("source", { kind: "main", id: 0 }); }}><span className="sr-nothumb" aria-hidden="true" /><span>{SR_WORDS.mainScreen}</span></button>
              </div>
              <h4>{SR_WORDS.window}</h4>
              <div className="sr-wins">
                {(list?.windows ?? []).map((w) => (
                  <button key={w.id} type="button" className={`sr-win${src.kind === "window" && src.id === w.id ? " on" : ""}`} onClick={() => { sfx.click(); change("source", { kind: "window", id: w.id }); }}>
                    {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : <span className="sr-noic" aria-hidden="true">{w.app.slice(0, 1)}</span>}
                    <span className="sr-wt"><b>{w.title}</b><em>{w.app}</em></span>{w.suggested && <i className="sr-sug">{SR_WORDS.suggested}</i>}
                  </button>
                ))}
                {!list && <span className="sr-hint">{need === "screen" ? SR_WORDS.allowFirst : SR_WORDS.noList}</span>}
              </div>
            </div>
          )}
          <div data-sec="mic" className="sr-sec">
            <h4>{SR_WORDS.micTitle}</h4>
            <MicSelect st={st} />
            <div className="sr-field inline"><span>{SR_WORDS.computerSound}</span><Switch on={s.computerSound} set={(v) => change("computerSound", v)} label={SR_WORDS.computerSound} /></div>
            <span className="sr-hint">{SR_WORDS.computerSoundLine} {SR_WORDS.tracksLine}</span>
          </div>
          <div data-sec="leave" className="sr-sec"><h4>{SR_WORDS.leaveTitle}</h4><span className="sr-hint">{SR_WORDS.leaveLine}</span><LeaveOut st={st} /></div>
          <div className="sr-sec"><h4>{SR_WORDS.presets}</h4><Quality st={st} /></div>
          {st.problem && <span className="sr-warn" role="alert">{st.problem}</span>}
          {s.remind && <p className="sr-remind">{SR_WORDS.remind}</p>}
        </div>
        <footer>
          <button type="button" className="sr-b on" disabled={!!need || !!st.problem} onClick={go}>{SR_WORDS.start}</button>
          <button type="button" className="sr-b" onClick={() => { sfx.click(); close(); }}>{SR_WORDS.cancel}</button>
        </footer>
      </section>
    </div>
  );
  return createPortal(content, document.body);
}

// ---------- Settings, Screen recording ----------
export function ScreenRecSettings() {
  const st = useScreenRec();
  useEffect(() => { askScreenRec(); }, []);
  if (!PS) return null;
  if (!st) return <div className="sr-set"><span className="sr-hint">{SR_WORDS.noList}</span></div>;
  if (!settingsShows({ ps: PS, st }) && !feature(SR_FEATURE)) return null;
  const s = st.settings;
  const on = st.enabled;
  return (
    <div className="sr-set">
      <div className="sr-field inline"><span><b>{SR_WORDS.on}</b><em>{SR_WORDS.onLine}</em></span><Seg value={on ? "on" : "off"} label={SR_WORDS.on} set={(v) => optIn(v === "on")} options={[{ id: "on", label: SR_WORDS.yes }, { id: "off", label: SR_WORDS.no }]} /></div>
      {on && (
        <>
          {st.needsScreen && st.perms.screen !== "granted" && <SrPerm kind="screen" st={st} />}
          {s.micOn && st.perms.mic !== "granted" && <SrPerm kind="mic" st={st} />}
          <div data-set="screenrec-audio" className="sr-sec">
            <h4>{SR_WORDS.defaultsTitle}</h4>
            <Seg value={s.mode} label={SR_WORDS.defaultsTitle} set={(v) => change("mode", v)} options={[{ id: "screenAndAudio", label: SR_WORDS.modeScreen }, { id: "audioOnly", label: SR_WORDS.modeAudio }]} />
            <label className="sr-field"><span>{SR_WORDS.micTitle}</span><MicSelect st={st} /></label>
            <div className="sr-field inline"><span>{SR_WORDS.computerSound}</span><Switch on={s.computerSound} set={(v) => change("computerSound", v)} label={SR_WORDS.computerSound} /></div>
            <span className="sr-hint">{SR_WORDS.tracksLine}</span>
            <button type="button" className="sr-b" onClick={() => { sfx.click(); setPicker(true, "screen"); }}>{SR_WORDS.pickerTitle}</button>
          </div>
          <div data-set="screenrec-quality" className="sr-sec"><h4>{SR_WORDS.presets}</h4><Quality st={st} /></div>
          <div data-set="screenrec-leave" className="sr-sec"><h4>{SR_WORDS.leaveTitle}</h4><span className="sr-hint">{SR_WORDS.leaveLine}</span><LeaveOut st={st} /></div>
          <div data-set="screenrec-folder" className="sr-sec"><h4>{SR_WORDS.folderTitle}</h4><Folder st={st} /></div>
          <div data-set="screenrec-cloud" className="sr-sec"><CloudSettings /></div>
          <div className="sr-sec">
            <div className="sr-field inline"><span><b>{SR_WORDS.remindSwitch}</b><em>{SR_WORDS.remind}</em></span><Switch on={s.remind} set={(v) => change("remind", v)} label={SR_WORDS.remindSwitch} /></div>
            <div className="sr-field inline"><span><b>{SR_WORDS.soundsLabel}</b><em>{SR_WORDS.soundsLine}</em></span><Switch on={s.sounds} set={(v) => change("sounds", v)} label={SR_WORDS.soundsLabel} /></div>
            <div data-set="screenrec-ask" className="sr-field inline"><span><b>{SR_WORDS.askMeetingsLabel}</b><em>{SR_WORDS.askMeetingsLine}</em></span><Switch on={s.askMeetings} set={(v) => change("askMeetings", v)} label={SR_WORDS.askMeetingsLabel} /></div>
            <div data-set="screenrec-perf" className="sr-field inline"><span><b>{SR_WORDS.perfLabel}</b><em>{SR_WORDS.perfLine}</em></span><Switch on={s.perfWatch} set={(v) => change("perfWatch", v)} label={SR_WORDS.perfLabel} /></div>
            <div className="sr-field inline"><span><b>{SR_WORDS.test}</b><em>{SR_WORDS.testLine}</em></span>
              <button type="button" className="sr-b" disabled={isRecording(st) || !!missingPermission(st)} onClick={() => { sfx.click(); send("test"); }}>{SR_WORDS.test}</button></div>
          </div>
        </>
      )}
      <div data-set="screenrec-off" className="sr-sec">
        <h4>{SR_WORDS.offTitle}</h4>
        <span className="sr-hint">{SR_WORDS.offLine}</span>
        <div className="sr-row">
          <button type="button" className="sr-b" onClick={() => { sfx.click(); send("privacy", { pane: "screen" }); }}>{SR_WORDS.openScreen}</button>
          <button type="button" className="sr-b" onClick={() => { sfx.click(); send("privacy", { pane: "mic" }); }}>{SR_WORDS.openMic}</button>
        </div>
        <span className="sr-hint">{SR_WORDS.menuBarNote}</span>
        <span className="sr-hint">{SR_WORDS.privateNote}</span>
      </div>
    </div>
  );
}
