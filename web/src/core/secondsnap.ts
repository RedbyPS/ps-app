// The Second Computer answer for a whole snapshot (reads the person's settings, so it lives apart from the pure
// core/secondswitch.ts, as core/mailsnap.ts does for Client emails).
import type { Snapshot } from "./vault";
import { settingsData } from "./select";
import { secondOn } from "./secondswitch";

/** Is Second Computer on for the signed in account? An owner who switched it on (the developer: on unless he switched it off). */
export function secondOnSnap(s: Snapshot): boolean {
  return secondOn(s, (settingsData(s) as { squadFeatures?: unknown }).squadFeatures);
}
