// Join The G Squad ask (PS 1.66, the developer, 17 Nov 2026). Once after updating to 1.66, anyone who is not in The G Squad and is not
// waiting to be let in gets one card from the island (a `choice` feature intro, core/featureintro.ts INTROS "gsquad-join-166"):
// "Join The G Squad?" with Join and Not now. Join sends the normal Ask to join (squad/autoengine.ts autoAgain: the same as the
// G Squad screen's Join, the admin still lets them in). Not now ends it for good, on every device of the person (introsDone).
// Never for the developer's own account (he is the admin). Pure rules, no vault and no screen (tests/gsquadjoin.test.ts).
import type { AutoStage } from "./squadauto.ts";

export const JOIN_ASK_ID = "gsquad-join-166";
export const JOIN_ASK_WORDS = {
  headline: "Join The G Squad?",
  ask: "Share your progress with friends on PS. The admin lets you in.",
  join: "Join",
  notNow: "Not now",
} as const;

export interface JoinAskIn {
  /** The developer's own account: never. */
  red: boolean;
  /** The vault is open and this person owns it. */
  owner: boolean;
  /** The G Squad view has loaded (its first answer came). */
  loaded: boolean;
  inSquad: boolean;
  /** The join step G Squad shows (core/squadauto.ts autoStage), null when not known yet. */
  stage: AutoStage | null | undefined;
  /** updaterAnswer for this intro: open (ran PS before 1.66 and never answered), done (answered or a first install), unknown. */
  updater: "done" | "open" | "unknown";
}

/** Show the card now (open), never again (done), or wait and look later (unknown). It never saves anything itself. */
export function joinAskProbe(i: JoinAskIn): "done" | "open" | "unknown" {
  if (i.red) return "done";
  if (!i.owner || !i.loaded) return "unknown";
  if (i.inSquad) return "done";
  if (i.updater !== "open") return i.updater;
  // Waiting to be let in (joining or asked), a problem reaching the hub, or the admin took them out: no card (look again later).
  // Only people who switched joining off or left on purpose are asked.
  return i.stage === "off" || i.stage === "left" ? "open" : "unknown";
}
