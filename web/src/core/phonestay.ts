// PS 1.71: the iPhone web app's "Stay signed in" (cincee.com/todolist-mobile). The developer, 20 Nov 2026: the Home Screen app
// asked for the passphrase every single time. Typing it there kept only the website's short refresh session (the auto
// lock time, 15 minutes by default); only a phone signed in by scanning the Mac's code stayed signed in (V1.55).
//
// Now a passphrase sign in on that page keeps the same thing the Mac's scan gives it (the derived login password and
// the key that opens the vault key, never the passphrase) in src/core/phonekeys.ts, and adds this phone to the Mac's
// list (ps_devices, Remove). It ends with Lock, Remove on the Mac, a new passphrase, this switch off, or Change project.
// On by default, like Stay signed in on PS GOS. The switch is this phone's own (localStorage), never the account's.
//
// The pure parts live here (unit tested, tests/phonestay.test.ts); the vault work is in core/vault.ts (keepPhoneSignIn,
// phoneCheck, setPhoneStay).
export const STAY_KEY = "psm.stay";
/** How often a kept phone asks whether it was removed or the passphrase changed, when it comes back to the front. */
export const PHONE_CHECK_MS = 5 * 60_000;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function store(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Whether Stay signed in is on for this phone: on unless switched off here. */
export function stayOn(s: Store | null = store()): boolean {
  try { return s?.getItem(STAY_KEY) !== "0"; } catch { return true; }
}
export function setStay(on: boolean, s: Store | null = store()): void {
  try { s?.setItem(STAY_KEY, on ? "1" : "0"); } catch { /* storage off: nothing is kept either */ }
}

/** Keep the sign in after this unlock? Only the phone web app, with the switch on, a typed passphrase (an exportable key
 *  to keep), online (the phone's row on the Mac's list comes first), on an account with a project (never local). */
export function shouldKeep(o: { mobilePage: boolean; stay: boolean; online: boolean; local: boolean; kept: boolean; haveKeys: boolean }): boolean {
  return o.mobilePage && o.stay && o.online && !o.local && !o.kept && o.haveKeys;
}

/** What a kept phone's check says. `listed`: its row is still on the account's list (null: no answer). `opens`: the kept
 *  key still opens the account's current vault key or the one kept during a passphrase change (null: no answer).
 *  Only a clear answer ends it: offline or a failed request keeps the phone signed in. */
export type PhoneVerdict = "keep" | "removed" | "new-passphrase" | "no-answer";
export function phoneVerdict(o: { listed: boolean | null; opens: boolean | null }): PhoneVerdict {
  if (o.listed === false) return "removed";
  if (o.opens === false) return "new-passphrase";
  if (o.listed === null && o.opens === null) return "no-answer";
  return "keep";
}
/** Whether the check is due: when PS app opens (forced), else at most every PHONE_CHECK_MS. */
export function checkDue(last: number, now: number, force = false): boolean {
  return force || now - last >= PHONE_CHECK_MS;
}
