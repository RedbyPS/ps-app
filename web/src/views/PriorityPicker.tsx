import { sfx } from "../ui/sfx";

// − P3 + : the priority LEVEL, the P number the list shows (PS 1.77, the developer 23 Nov 2026: two tasks on Priority 2 are one
// Priority 2 group). Picking a number another task has joins it (core/prio.ts levelPick, placeInLevel, levelMove); one past
// the last level makes a level of its own at the end. Priority 1 itself is a switch.
export function PriorityPicker({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  const set = (n: number) => { const v = Math.max(2, Math.min(max, n)); if (v !== value) { onChange(v); sfx.hover(); } };
  return (
    <span className="tm-prio-pick" title="Priority: the P number it shows. The same number as another task puts them together">
      <span className="tm-prio-pick-l">Priority</span>
      <button type="button" onClick={() => set(value - 1)} disabled={value <= 2} aria-label="Higher priority">−</button>
      <span className="tm-prio-pick-v num">P<input type="number" min={2} max={max} value={value} aria-label="Priority number"
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 2) set(Math.round(n)); }} /></span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label="Lower priority">+</button>
    </span>
  );
}
