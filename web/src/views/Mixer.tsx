// Tab list, top right (PS only): the volume mixer (the developer, 24 Oct 2026, "like Windows 10's"). One row
// per app making sound: icon, name, a slider from 0 to 150%, Mute and "Keep out of recordings"; a
// master row for the Mac's own volume. The PS app does the audio (Sources/Mixer.swift) and keeps every
// level on this Mac. Click only, except slider drags.
// PS 1.65 (the developer's friend, 17 Nov 2026: "Just make one default and get rid of all the fluff"): one look, no gear
// (rows, icons, slider, colour, show, sort, meters and see through are gone, the Mac no longer reads them), no Speakers |
// Headphones switch and no auto switch. In their place, at the top: Audio priority, the ordered Speakers and
// Microphones lists (views/AudioPriority.tsx, feature "audio-priority").
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PS, psPost } from "../ps";
import { sfx } from "../ui/sfx";
import { AirPodsFix } from "./AirPodsFix";
import { AudioPriorityLists } from "./AudioPriority";
import { feature } from "../core/features";
import { AP_WORDS } from "../core/audiopriority";
import { isRedAccount } from "../core/account";
import { vaultStore } from "../core/vault";
import "./mixer.css";
import { appName, macListHint } from "../core/appname";
import { TopIcon } from "./topicons";

type Row = { key: string; name: string; icon?: string; instance?: string; playing: boolean; gain: number; muted: boolean; hide: boolean; cant: boolean; adjusted: boolean; meter: number };
type State = { rows: Row[]; permission: "ok" | "denied" | "unknown"; asked: boolean; hints: string[]; master?: { volume: number; muted: boolean; device: string } };

let state: State | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  (window as Window & { __psMixer?: unknown }).__psMixer = (m: unknown) => {
    const o = m as Partial<State> | null;
    if (!o || !Array.isArray(o.rows)) return;
    state = { rows: o.rows as Row[], permission: (o.permission as State["permission"]) || "unknown", asked: !!o.asked, hints: Array.isArray(o.hints) ? o.hints.filter((h) => typeof h === "string") : [], master: o.master };
    listeners.forEach((l) => l());
  };
}
const send = (m: Record<string, unknown>) => psPost({ type: "mixer", ...m });
function useMixer() { return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state); }
/** macOS's answer for the mixer's permission (the setup menu, views/Welcome.tsx): "ok", "denied", "unknown", or null before PS said. */
export function useMixerPermission() { const st = useMixer(); return st ? st.permission : null; }

function Slider({ value, max, onLive, onDone, label, disabled }: { value: number; max: number; onLive: (v: number) => void; onDone: (v: number) => void; label: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const held = useRef(false);
  useEffect(() => { if (!held.current) setV(value); }, [value]);
  return (
    <input type="range" className="mix-range" min={0} max={max} step={1} value={v} aria-label={label} disabled={disabled}
      style={{ ["--pct" as string]: `${(v / max) * 100}%` }}
      onPointerDown={() => { held.current = true; }}
      onChange={(e) => { const n = Number(e.target.value); setV(n); onLive(n); }}
      onPointerUp={(e) => { held.current = false; onDone(Number((e.target as HTMLInputElement).value)); }} />
  );
}

function MixRow({ r }: { r: Row }) {
  const pct = Math.round(r.gain * 100);
  const last = useRef(0);
  const live = (n: number) => { const t = Date.now(); if (t - last.current > 40) { last.current = t; send({ op: "gain", key: r.key, value: n / 100 }); } };
  return (
    <div className={`mix-row${r.playing ? " playing" : ""}${r.muted ? " muted" : ""}`} data-key={r.key}>
      {r.icon ? <img className="mix-ic" src={r.icon} alt="" /> : <span className="mix-ic none" aria-hidden="true">{r.name.slice(0, 1)}</span>}
      <div className="mix-mid">
        <div className="mix-name"><span className="mix-dot" aria-hidden="true" />{r.name}{r.adjusted && <em>adjusted</em>}</div>
        {r.cant ? (
          <div className="mix-cant">Can't adjust (protected audio). It plays untouched. <button type="button" onClick={() => { sfx.click(); send({ op: "retry", key: r.key }); }}>Try again</button></div>
        ) : (
          <div className="mix-ctl">
            <Slider value={pct} max={150} label={`${r.name} volume`} onLive={live} onDone={(n) => send({ op: "gain", key: r.key, value: n / 100 })} />
            <b className="num mix-v">{pct}%</b>
          </div>
        )}
        {r.adjusted && <div className="mix-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(r.meter * 100))}%` }} /></div>}
      </div>
      <div className="mix-btns">
        <button type="button" className={`mix-b${r.muted ? " on" : ""}`} aria-pressed={r.muted} onClick={() => { sfx.click(); send({ op: "mute", key: r.key, muted: !r.muted }); }}>{r.muted ? "Unmute" : "Mute"}</button>
        <button type="button" className={`mix-b hide${r.hide ? " on" : ""}`} aria-pressed={r.hide} title="You hear it, a recording through a loopback device does not"
          onClick={() => { sfx.click(); send({ op: "hide", key: r.key, hide: !r.hide }); }}>Keep out of recordings</button>
      </div>
    </div>
  );
}

export function MixerButton() {
  const st = useMixer();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    send({ op: "open" });
    const away = (e: MouseEvent) => { if (e.button === 0 && !ref.current?.contains(e.target as Node)) setOpen(false); };
    // V1.41 Esc always closes it (core/escape.ts), also in the middle of a drag in the device lists.
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away, true); window.removeEventListener("keydown", key, true); send({ op: "close" }); };
  }, [open]);
  if (!PS) return null;
  // One look: the apps playing now and any with a level of their own, by name.
  const rows = (st?.rows || []).filter((r) => r.playing || r.gain !== 1 || r.muted || r.hide).sort((a, b) => a.name.localeCompare(b.name));
  const prio = feature("audio-priority");
  const needAsk = !!st && st.permission !== "ok" && !st.asked && (st.rows || []).some((r) => r.gain !== 1 || r.muted || r.hide);
  const m = st?.master;
  return (
    <div className={`tm-pop-wrap mix-wrap${open ? " open" : ""}`} ref={ref}>
      <button type="button" className={`tm-pill-btn icon mix-btn${open ? " on" : ""}`} aria-expanded={open} aria-label="Volume mixer" title="Volume mixer"
        onClick={(e) => { if (e.button !== 0) return; sfx.click(); setOpen((x) => !x); }}>
        <TopIcon id="mixer" size={16} stroke={2} />   {/* a speaker with sound waves (PS 1.70), the menu's own */}
      </button>
      {open && (
        <div className="tm-pop mix-pop" role="dialog" aria-label="Volume mixer">
          <div className="mix-head"><b>Volume mixer</b></div>
          {prio && <AudioPriorityLists />}
          {prio && <span className="mix-sub">{AP_WORDS.apps}</span>}
          {needAsk && (
            <div className="mix-ask" role="alert">
              <b>One question from macOS first</b>
              <span>To turn one app up or down, {appName()} needs macOS's "System Audio Recording" permission. The sound goes straight to your speakers or AirPods: nothing is recorded, saved or sent anywhere.</span>
              <div><button type="button" className="mix-b on" onClick={() => { sfx.click(); send({ op: "allow" }); }}>Continue</button></div>
            </div>
          )}
          {st?.permission === "denied" && st.asked && (
            <div className="mix-ask"><span>macOS said no, so {appName()} can't change app volumes. You can allow {appName()}{macListHint()} in System Settings, Privacy and Security, Screen and System Audio Recording, under System Audio Recording Only.</span></div>
          )}
          {m && (
            <div className="mix-row master">
              <span className="mix-ic none" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg></span>
              <div className="mix-mid">
                <div className="mix-name">Mac volume{m.device && <em>{m.device}</em>}</div>
                <div className="mix-ctl">
                  <Slider value={Math.round(m.volume * 100)} max={100} label="Mac volume" onLive={(n) => send({ op: "master", value: n / 100 })} onDone={(n) => send({ op: "master", value: n / 100 })} />
                  <b className="num mix-v">{Math.round(m.volume * 100)}%</b>
                </div>
              </div>
              <div className="mix-btns"><button type="button" className={`mix-b${m.muted ? " on" : ""}`} onClick={() => { sfx.click(); send({ op: "master", muted: !m.muted }); }}>{m.muted ? "Unmute" : "Mute"}</button></div>
            </div>
          )}
          <div className="mix-list">
            {rows.length ? rows.map((r) => <MixRow key={r.key} r={r} />) : <span className="tm-pop-note">{st ? "No app is playing sound right now." : "Loading…"}</span>}
          </div>
          {(st?.hints || []).map((h, i) => <span key={i} className="mix-hint">{h}</span>)}
          <AirPodsFix red={isRedAccount(vaultStore.get())} />
          <span className="tm-pop-note">1Password and Signal are never touched. Nothing is recorded or saved.</span>
        </div>
      )}
    </div>
  );
}
