// The warning card for the other Mac's auto reboot (src/rebootwarn.ts shows it): pure, so tests/rebootwarn.test.ts
// can check every case without a vault or PS.
import { machineMs, timerOn } from "./second.ts";
import type { SecondView } from "../second/view";

export const WARN_BEFORE = 10 * 60_000;
export type WarnCard = { id: string; title: string; sub: string; body: string; sticky: true; actions: { id: string; label: string }[] };

/** The card for this moment, or null (pure, tests/rebootwarn.test.ts). */
export function rebootWarnCard(v: Pick<SecondView, "role" | "peer" | "machine" | "online">, now: number): WarnCard | null {
  if (v.role !== "primary" || !v.peer) return null;
  const t = v.machine?.timer;
  if (!t || t.safeMode || !timerOn(v.machine)) return null;
  const dl = machineMs(t.deadline);
  if (!dl) return null;
  const left = dl - now;
  if (left > WARN_BEFORE || left < -5 * 60_000) return null;
  const name = v.peer.name, mins = Math.max(1, Math.round(left / 60_000));
  const canPostpone = v.online && t.postpone === true;
  return {
    id: `rw:${Math.round(dl / 1000)}`, sticky: true,
    title: left > 0 ? `${name} restarts in ${mins} min` : `${name} is restarting`,
    sub: `Its auto reboot: locked for the ${t.hours} hours you chose${v.online ? "" : ". It is asleep and wakes itself to restart"}`,
    body: "After the restart it waits for your password at it: Second Computer jobs, files and messages stop until you log in there.",
    actions: canPostpone ? [{ id: "postpone", label: "Postpone 1 hour" }, { id: "ok", label: "OK" }] : [{ id: "ok", label: "OK" }],
  };
}
