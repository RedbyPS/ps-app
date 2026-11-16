// The Second Computer switch (PS 1.65). Second Computer was the developer's alone (V1.42 to V1.64); since 1.65 it is in
// core for everyone, behind this one switch: Settings, Second Computer, On or Off. It is the feature "second-computer" in
// core's features.json, stored per person in settings.squadFeatures like Client emails, so it follows the person to every
// device (the Mac, the phone's Your Macs).
//
// Off until the person switches it on, because it pairs two Macs and lets one run work on the other. On for the developer
// as before, through his own layer's profile ("second-computer": true); his own Off still wins.
// It needs an owner (never a client member of someone's workspace): the pairing, jobs and files travel through the
// owner's own vault (migration 026_second.sql, in every project).
// Pure, so tests import it directly; the answer for a whole snapshot is core/secondsnap.ts.
import type { Snapshot } from "./vault.ts";
import { switchOn, type Account } from "./features.ts";
import { accountKind } from "./account.ts";

export const SECOND_FEATURE = "second-computer";
/** Second Computer is in this build (true here; false where this module is a placeholder, so its Settings row hides). */
export const SECOND_HERE = true;
export type SecondWho = Pick<Snapshot, "status" | "role" | "red">;

/** Can this account use Second Computer at all (is the switch offered)? An unlocked owner. */
export function secondCan(s: Pick<Snapshot, "status" | "role">): boolean {
  return s.status === "unlocked" && s.role === "owner";
}
/** The person's own switch against this build's registry (core/features.ts switchOn): their answer, else the build's
 *  answer for their account (off by default; on for the developer through his layer). Not in the registry: off. */
export function secondSwitch(squadFeatures: unknown, account: Account): boolean {
  return switchOn(SECOND_FEATURE, squadFeatures, account);
}
/** The account kind switchOn wants: the developer's own account, anyone else, or nobody signed in. */
export function secondAccount(s: SecondWho): Account {
  const k = accountKind(s);
  return k === null ? null : k === "red" ? "red" : "other";
}
/** Is Second Computer on for this account, given the person's settings.squadFeatures? */
export function secondOn(s: SecondWho, squadFeatures: unknown): boolean {
  return secondCan(s) && secondSwitch(squadFeatures, secondAccount(s));
}

/** The switch's words (Settings, Second Computer): the developer approves them. */
export const SECOND_WORDS = {
  line: "Pair your other Mac: lock it, restart it, send files.",   // the same line as its Settings search entry (core/settingsindex.ts)
};
