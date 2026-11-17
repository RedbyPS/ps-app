// Backgrounds per device (PS 1.65, feature "device-backgrounds"): what THIS device knows about itself and whether the
// feature is on. The rules are in core/devicebg.ts (tested); this only reads the device's own storage and the switch.
import { feature } from "./core/features";
import { deviceId, deviceKind, effective, hasPicks, type DevKind } from "./core/devicebg";

export const DEVICE_BG = "device-backgrounds";
export const deviceBgOn = (): boolean => { try { return feature("device-backgrounds"); } catch { return false; } };

/** Which kind of device this page runs on. */
export const thisKind = (): DevKind =>
  deviceKind(import.meta.env.MODE, (globalThis as { __psMobile?: unknown }).__psMobile === true);

let cached = "";
/** This device's own id (random, kept in its own storage). The Mac's page and Tab list share one storage, so one id. */
export function thisDevId(): string {
  if (cached) return cached;
  let store: Storage | null = null;
  try { store = typeof localStorage === "undefined" ? null : localStorage; } catch { store = null; }
  cached = deviceId(store);
  return cached;
}

/** This device's background: its own pick when the feature is on and the pick is still valid, else `fallback` (what it always showed). */
export function deviceShown(picks: unknown, valid: (bg: string) => boolean, fallback: string | null | undefined): string | null | undefined {
  if (!picks || !deviceBgOn()) return fallback;
  return effective(picks, thisDevId(), valid, fallback);
}

/** Tick mode: the feature is on and there is a second device or a pick already. */
export const tickMode = (deviceCount: number, picks: unknown, valid: (bg: string) => boolean): boolean =>
  deviceBgOn() && (deviceCount >= 2 || hasPicks(picks, valid));
