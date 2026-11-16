// Who is signed in, for switching features on and off (multi-owner PS, 27 Oct 2026).
// * "red": the primary owner. The only account the sealed feeds (Gmail, Telegram, Fireflies,
//   Instantly, calendar, follow-up radar, Morning brief, Claude's packages) are sealed to.
// * "owner": anyone who joined through one of the developer's "Invite someone" links. Their own vault,
//   clients and workspaces; none of the developer's feeds or hardware conveniences.
// * "client": a member of one owner's client workspace.
// The database decides this (vault_role(), migration 025); a wrong answer here only shows or
// hides UI, it never opens data: every developer-only feed is sealed to the developer's key and developer-only by RLS.
import type { Snapshot } from "./vault";
import { onRedProject } from "./project.ts";

export type AccountKind = "red" | "owner" | "client";

export function accountKind(s: Pick<Snapshot, "status" | "role" | "red">): AccountKind | null {
  if (s.status !== "unlocked" || !s.role) return null;
  if (s.role === "client") return "client";
  // The first owner of ANY other Supabase project (someone who linked their own, 5 Nov 2026) is that
  // project's primary owner too, and vault_role() says "red" there. The developer's features stay on the developer's project.
  return s.red && onRedProject() ? "red" : "owner";
}

/** vault_role() -> the app's role. Anything unexpected is a client: the safe answer (fewest features). */
export function parseRole(v: unknown): { role: "owner" | "client"; red: boolean } {
  if (v === "red") return { role: "owner", red: true };
  if (v === "owner") return { role: "owner", red: false };
  return { role: "client", red: false };
}

/** True only for the developer's own account while unlocked. Default false everywhere else. */
export function isRedAccount(s: Pick<Snapshot, "status" | "role" | "red">): boolean {
  return accountKind(s) === "red";
}

/** Features that stay on the developer's account only. Everyone else never sees them. Meetings, their alerts, the Dynamic
 *  Island and Do Not Disturb are everyone's since 7 Nov 2026 (anyone else's meetings come from their Mac's Calendar,
 *  core/localcal.ts); Numerology and the PS rules stay the developer's because he asked (5 and 7 Nov 2026). */
export const RED_ONLY = [
  "gmail", "mailcards", "telegram", "fireflies", "radar", "followupCard",
  "instantly", "brief", "claude", "airpods", "backgroundVideos",
  "numerology", "rules",
] as const;
export type RedFeature = typeof RED_ONLY[number];

export function canUse(s: Pick<Snapshot, "status" | "role" | "red">, f: RedFeature): boolean {
  return (RED_ONLY as readonly string[]).includes(f) ? isRedAccount(s) : true;
}
