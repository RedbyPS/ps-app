// The AFK timer asks once (PS 1.66, the developer, 17 Nov 2026: the same as the posture reminder's question, core/posture.ts, and the
// first stand-up's, core/standup.ts). The first AFK card a person gets carries a small question under its buttons:
// "Do you want to turn the AFK timer off?" with Turn off and Keep it on. Everyone who had it before 1.66 is asked once too,
// because nobody has the mark yet. Turn off switches the AFK timer off on that Mac (its own setting, ps-mac Afk.swift) and
// Keep it on just carries on; either answer is kept in the person's synced settings (settings.afkAsk), so no other Mac asks
// again. A card that goes without an answer (Back in the game, the card closing, Esc) is no answer: the next card asks again.
// The Mac draws the question (Afk.swift); this page tells it the words while it is still due (island.ts) and saves the answer.
export const AFK_ASK_WORDS = {
  title: "Do you want to turn the AFK timer off?",
  off: "Turn off",
  keep: "Keep it on",
} as const;
export type AfkAnswer = "off" | "keep";
/** Ask with the next AFK card? Only while the person has never answered. */
export const afkAskDue = (st: { afkAsk?: boolean }): boolean => st.afkAsk !== true;
/** What the island state carries for the Mac: the words while the question is due, null once answered. */
export const afkAskIsland = (st: { afkAsk?: boolean }): typeof AFK_ASK_WORDS | null => (afkAskDue(st) ? AFK_ASK_WORDS : null);
/** What an answer from the Mac saves. Both mark it answered (Turn off is done by the Mac itself). null: not an answer. */
export function afkAskPatch(answer: unknown): { afkAsk: true } | null {
  return answer === "off" || answer === "keep" ? { afkAsk: true } : null;
}
