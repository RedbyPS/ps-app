// The repeat options under "Repeat" in a task editor: a preset (every other day, week, month,
// year), or a custom "every N days, weeks, months or years", plus the date it starts.
import { useState } from "react";
import { REPEAT_PRESETS, STREAK_FEATURE, streakWords, type Repeat, type RepeatDraft, type RepeatUnit } from "../core/repeat";
import { feature } from "../core/features";

export function RepeatPicker({ value, onChange, cls }: { value: RepeatDraft; onChange: (d: RepeatDraft) => void; cls: { select: string; input: string; date: string; wrap: string } }) {
  const preset = REPEAT_PRESETS.find((p) => p.every === value.every && p.unit === value.unit);
  const [custom, setCustom] = useState(!preset);
  const key = custom || !preset ? "custom" : preset.key;
  return (
    <div className={cls.wrap}>
      <select className={cls.select} value={key} aria-label="How often"
        onChange={(e) => {
          const p = REPEAT_PRESETS.find((x) => x.key === e.target.value);
          if (p) { setCustom(false); onChange({ ...value, every: p.every, unit: p.unit }); } else setCustom(true);
        }}>
        {REPEAT_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom</option>
      </select>
      {key === "custom" && (
        <>
          <span>every</span>
          <input type="number" className={cls.input} min={1} max={365} value={value.every} aria-label="Every how many"
            onChange={(e) => onChange({ ...value, every: Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))) })} />
          <select className={cls.select} value={value.unit} aria-label="Days, weeks, months or years"
            onChange={(e) => onChange({ ...value, unit: e.target.value as RepeatUnit })}>
            {(["day", "week", "month", "year"] as const).map((u) => <option key={u} value={u}>{u}{value.every === 1 ? "" : "s"}</option>)}
          </select>
        </>
      )}
      <span>starting</span>
      <input type="date" className={cls.date} value={value.from} aria-label="Starting"
        onChange={(e) => { if (e.target.value) onChange({ ...value, from: e.target.value }); }} />
    </div>
  );
}

/** The small gold streak number next to the edit button (from 2 in a row). PS 1.68 (feature "task-streaks"): its hover
 *  says what it is ("7 days in a row"), and the same flame sits on each mini task of a repeating task (`mini`). The
 *  switch (Settings, Your list) off: the task's badge is exactly as before and mini tasks show none (they keep counting,
 *  so switching back on shows the real numbers). */
export function StreakBadge({ n, className, rule, best, mini }: { n?: number; className: string; rule?: Repeat | null; best?: number; mini?: boolean }) {
  const on = feature(STREAK_FEATURE);
  if (!n || n < 2 || (mini && !on)) return null;
  const words = on ? streakWords(n, rule, best) : `${n} in a row`;
  return (
    <span className={`${className} num`} title={words} aria-label={words}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2s.9 3.1-1.2 6.1C10.6 10.6 9 11.4 9 14a3 3 0 0 0 6 0c0-1.2-.5-2-.5-2s2.5 1.2 2.5 4.6A5 5 0 0 1 12 21.5a6.5 6.5 0 0 1-6.5-6.6c0-4.6 4.2-6.6 5.6-9.6.6-1.3.4-3.3.4-3.3s1 .1 2 0z" /></svg>
      {n}
    </span>
  );
}
