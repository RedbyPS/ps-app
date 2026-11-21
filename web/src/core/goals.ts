// The goals timeline's rules, shared by the Timeline (views/Goals.tsx) and the AI task API (core/taskapi.ts, /v1/goals).
// Jan, 21 Nov 2026 (PS 1.72): "make sure that you can edit this with API as well, add and delete", and "right now when
// you just click once it already creates a task". So a click only shows a ghost of where the goal would go (spanAt), and
// a goal closed with nothing typed in it is not kept (blankGoal).
// Goals live in the encrypted settings record (settings.goals), like everything else in the vault.
// Pure: no React, no DOM.
import type { Goal } from "./model";

export const GOAL_COLORS = ["#EC4E86", "#A855F7", "#38BDF8", "#34D399", "#FBBF24", "#F97316", "#F472B6", "#818CF8"];
export const GOAL_LEVELS: { level: Goal["level"]; title: string; sub: string }[] = [
  { level: "macro", title: "Macro", sub: "the big goals" },
  { level: "meso", title: "Meso", sub: "month by month" },
  { level: "micro", title: "Micro", sub: "week by week" },
];
export const GOAL_TITLE_MAX = 120, GOAL_NOTE_MAX = 1000, GOALS_MAX = 500;
export const levelName = (l: Goal["level"]) => GOAL_LEVELS.find((x) => x.level === l)?.title ?? "Macro";
/** "Macro", "meso", "MICRO": the level, or null. */
export function goalLevel(v: unknown): Goal["level"] | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "macro" || s === "meso" || s === "micro" ? s : null;
}
/** The colour the next new goal gets (the palette in turn). */
export const nextGoalColor = (goals: Goal[]) => GOAL_COLORS[goals.length % GOAL_COLORS.length];
/** Nothing typed: no name and no notes. Such a goal is not kept when it is closed. */
export const blankGoal = (title: string | null | undefined, note: string | null | undefined) => !(title ?? "").trim() && !(note ?? "").trim();

const DAY = 86400000;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Where a goal clicked at time t (local) in a lane goes: Micro the week (Monday to Sunday), Meso the month, Macro three
 *  months from the start of the month. */
export function spanAt(level: Goal["level"], t: number): { start: string; end: string } {
  const d = new Date(t);
  if (level === "micro") {
    const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return { start: iso(m), end: iso(new Date(m.getFullYear(), m.getMonth(), m.getDate() + 6)) };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + (level === "meso" ? 1 : 3), 0);
  return { start: iso(start), end: iso(end) };
}
/** The To a goal gets when only its From is given (the API): a week for Micro, to the end of that month for Meso, to the
 *  end of the month two after it for Macro. Days are YYYY-MM-DD, counted in UTC so a clock change never moves them. */
export function endFor(level: Goal["level"], start: string): string {
  const [y, m, d] = start.split("-").map(Number);
  const t = level === "micro" ? Date.UTC(y, m - 1, d) + 6 * DAY : Date.UTC(y, m - 1 + (level === "meso" ? 1 : 3), 0);
  return new Date(t).toISOString().slice(0, 10);
}
