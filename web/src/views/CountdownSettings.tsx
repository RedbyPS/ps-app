// Settings, Countdown text (PS 1.70, core/settingsindex.ts group "countdown"): one control per row, keyed by the row's id in
// views/SettingsGroups.tsx. Saved like every other setting (settings.countdown, only what differs from the defaults, change only).
import { useState, type ReactNode } from "react";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { settingsData } from "../core/select";
import { isRedAccount } from "../core/account";
import { allZones, DEVICE_TZ, HOME_COMMON, tzLabel } from "../core/tz";
import { overdueZone } from "../core/overdue";
import { resetAtOf } from "../core/resetday";
import {
  ANIMS, COLORS, DAY_NAMES, EVERY_CHOICES, FONTS, SIZE_MAX, SIZE_MIN, WEIGHTS, WORDS, cdPatch, cdZone, cleanCd, clock, livelyStage, okHm, type CdPrefs,
} from "../core/daycount";
import { Choice, taskMapActions } from "./TaskMap";
import { SetRow, openSettings, type RowProps } from "./SettingsScreen";
import { Digits, cdClass, useDayView, useSecond } from "./DayCountdown";

export type CdKey = "on" | "mode" | "tz" | "font" | "color" | "weight" | "size" | "anim" | "lively" | "island" | "remind" | "p1";

function useCd() {
  const v = useVault();
  const st = settingsData(v);
  const red = isRedAccount(v);
  const p = cleanCd(st.countdown, red);
  const ready = v.status === "unlocked";
  const set = (change: Partial<CdPrefs>) => { if (ready) void taskMapActions.looks({ countdown: cdPatch(p, change) }); };
  // PS 1.72: Day ends can follow the reset time (Settings, Time and reset, Reset automatically at), in the reset's own zone.
  return { p, ready, set, red, resetAt: resetAtOf(st), resetTz: overdueZone(st.tmHomeTz) };
}
function Seg({ label, ready, children }: { label: string; ready: boolean; children: ReactNode }) {
  return <span className={`tm-ed-seg${ready ? "" : " gs-notyet"}`} role="radiogroup" aria-label={label}>{children}</span>;
}
function OnOff({ on, ready, set, label }: { on: boolean; ready: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <Seg label={label} ready={ready}>
      <Choice selected={ready && on} onPick={() => { sfx.hover(); set(true); }}>On</Choice>
      <Choice selected={ready && !on} onPick={() => { sfx.hover(); set(false); }}>Off</Choice>
    </Seg>
  );
}
function TimeBox({ value, set, ready, label, empty }: { value: string; set: (v: string) => void; ready: boolean; label: string; empty?: boolean }) {
  return (
    <input type="time" className="cds-time" value={value} disabled={!ready} aria-label={label} required={!empty}
      onChange={(e) => { const v = e.currentTarget.value; if (okHm(v) || (empty && v === "")) set(v); }} />
  );
}

/** A live sample of the countdown with the look picked, under the look rows. */
function Sample({ p }: { p: CdPrefs }) {
  const now = useSecond();
  const v = useDayView(now);
  const left = v.st.target && !v.st.asking ? Math.max(0, v.st.target - now) : 0;
  const color = p.color === "accent" ? "var(--k-acc, #EC4E86)" : p.color || "#FFFFFF";
  return (
    <div className="cds-sample" aria-hidden="true">
      <div className={cdClass(p, livelyStage(left, false), false)} style={{ ["--cd-c" as string]: color, ["--cd-w" as string]: String(p.weight), ["--cd-k" as string]: String(Math.min(1.3, p.size / 100)) }}>
        <span className="cd-glow" />
        <Digits text={clock(left || 4 * 3_600_000 + 12 * 60_000 + 9_000 - (now % 60_000))} />
      </div>
    </div>
  );
}

export function CdSetting({ e, k }: RowProps & { k: CdKey }) {
  const { p, ready, set, red, resetAt, resetTz } = useCd();
  const [size, setSize] = useState<number | null>(null);
  switch (k) {
    case "on": return <SetRow e={e} right={<OnOff label={e.name} on={p.on} ready={ready} set={(on) => set({ on })} />} />;
    case "lively": return <SetRow e={e} right={<OnOff label={e.name} on={p.lively} ready={ready} set={(lively) => set({ lively })} />} />;
    case "island": return <SetRow e={e} right={<OnOff label={e.name} on={p.island} ready={ready} set={(island) => set({ island })} />} />;
    case "p1": return <SetRow e={e} right={<OnOff label={e.name} on={p.p1} ready={ready} set={(v) => set({ p1: v })} />} />;
    case "remind": return (
      <SetRow e={e} right={<OnOff label={e.name} on={p.remind} ready={ready} set={(remind) => set({ remind })} />} open
        body={p.remind ? (
          <div className="cds-line">
            <span className="cds-l">Every</span>
            <Seg label="How often" ready={ready}>
              {EVERY_CHOICES.map((h) => <Choice key={h} selected={p.every === h} onPick={() => { sfx.hover(); set({ every: h }); }}>{`${h}h`}</Choice>)}
            </Seg>
          </div>
        ) : undefined} />
    );
    case "mode": return (
      <SetRow e={e} open body={
        <div className="cds-mode">
          <Seg label={e.name} ready={ready}>
            <Choice selected={p.mode === "reset"} onPick={() => { sfx.hover(); set({ mode: "reset" }); }}>{WORDS.sameAsReset(resetAt)}</Choice>
            <Choice selected={p.mode === "daily"} onPick={() => { sfx.hover(); set({ mode: "daily" }); }}>Every day at</Choice>
            <Choice selected={p.mode === "week"} onPick={() => { sfx.hover(); set({ mode: "week" }); }}>A time for each day</Choice>
          </Seg>
          {p.mode === "reset" ? (
            <div className="cds-line">
              <button type="button" className="cds-link" onClick={() => { sfx.click(); openSettings("time", { jump: "auto-reset" }); }}>Reset automatically at</button>
            </div>
          ) : p.mode === "daily" ? (
            <div className="cds-line"><TimeBox value={p.at} ready={ready} label="Every day at" set={(at) => set({ at })} />
              <button type="button" className="cds-link" onClick={() => { sfx.click(); openSettings("time", { jump: "auto-reset" }); }}>Reset automatically at</button></div>
          ) : (
            <div className="cds-week">
              {DAY_NAMES.map((d, i) => (
                <label key={d} className="cds-day">
                  <span>{d}</span>
                  <TimeBox value={p.days[i]} ready={ready} label={d} empty set={(v) => { const days = [...p.days]; days[i] = v; set({ days }); }} />
                </label>
              ))}
              <span className="cds-hint">Clear a day's time and that day has no end.</span>
            </div>
          )}
        </div>} />
    );
    case "tz": {
      const def = cdZone({ tz: "", mode: p.mode }, red, DEVICE_TZ, resetTz);
      const list = [...new Set([...(p.tz ? [p.tz] : []), ...HOME_COMMON, ...allZones()])];
      return (
        <SetRow e={e} right={
          <select className="cds-select" value={p.tz} disabled={!ready} aria-label={e.name} onChange={(ev) => { sfx.hover(); set({ tz: ev.currentTarget.value }); }}>
            <option value="">{`Default: ${tzLabel(def)}`}</option>
            {list.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
          </select>} />
      );
    }
    case "font": return (
      <SetRow e={e} right={
        <Seg label={e.name} ready={ready}>
          {FONTS.map((f) => <Choice key={f.id} selected={p.font === f.id} onPick={() => { sfx.hover(); set({ font: f.id }); }}><span className={`cd-f-${f.id}`}>{f.label}</span></Choice>)}
        </Seg>} />
    );
    case "weight": return (
      <SetRow e={e} right={
        <Seg label={e.name} ready={ready}>
          {WEIGHTS.map((w) => <Choice key={w.id} selected={p.weight === w.id} onPick={() => { sfx.hover(); set({ weight: w.id }); }}><span style={{ fontWeight: w.id }}>{w.label}</span></Choice>)}
        </Seg>} />
    );
    case "color": return (
      <SetRow e={e} right={
        <span className="cds-sw" role="radiogroup" aria-label={e.name}>
          {COLORS.map((c) => (
            <button key={c.id || "def"} type="button" role="radio" aria-checked={p.color === c.id} title={c.label} aria-label={c.label} disabled={!ready}
              className={`${p.color === c.id ? "sel" : ""}${c.id === "" ? " def" : c.id === "accent" ? " acc" : ""}`}
              style={c.id.startsWith("#") ? { ["--sw" as string]: c.id } : undefined}
              onClick={() => { sfx.hover(); set({ color: c.id }); }} />
          ))}
        </span>} />
    );
    case "size": {
      const n = size ?? p.size;
      const commit = (v: number) => { setSize(null); if (v !== p.size) set({ size: v }); };
      return (
        <SetRow e={e} right={
          <label className="tm-size cds-size">
            <input type="range" min={SIZE_MIN} max={SIZE_MAX} step={5} value={n} disabled={!ready} aria-label={e.name}
              onChange={(ev) => setSize(Number(ev.currentTarget.value))}
              onPointerUp={(ev) => commit(Number((ev.target as HTMLInputElement).value))}
              onKeyUp={(ev) => commit(Number((ev.target as HTMLInputElement).value))} />
            <span className="tm-size-v num">{n}%</span>
          </label>} />
      );
    }
    case "anim": return (
      <SetRow e={e} open right={
        <Seg label={e.name} ready={ready}>
          {ANIMS.map((a) => <Choice key={a.id} selected={p.anim === a.id} onPick={() => { sfx.hover(); set({ anim: a.id }); }}>{a.label}</Choice>)}
        </Seg>} body={<Sample p={p} />} />
    );
  }
}
