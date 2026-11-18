// One squad (V1.47), the developer 10 Nov 2026: "make it so there's only one squad and it's already created, called The G Squad.
// Get rid of any features to add new squads, because it doesn't really work."
// V1.49, the developer 11 Nov 2026: "I want to make it there's automatically one squad already and we're all automatically in
// it." No list of squads, no Create a squad, no Ask to join, no claim code, no approval: every PS joins by itself
// (squad/autoengine.ts). The rules of the screen you see before you are in, with no DOM.
// V1.57 invite only (the developer, 13 Nov 2026): joining by itself is an Ask to join; the admin lets you in, or a friend's Add
// friend code lets you straight in.
import type { SquadView } from "./view.ts";
import { THE_SQUAD as NAME, type AutoStage } from "../core/squadauto.ts";

/** The one squad's name everywhere in PS. */
export const THE_SQUAD = NAME;

/** What the G Squad screen shows before you are in, one at a time:
 *  - "joining": on the way in (PS joined by itself and is getting the squad key)
 *  - "asked":   V1.57, waiting for the admin to let you in (with the check code)
 *  (PS 1.68 one squad for everyone: no "left" and no "off" any more, nobody leaves and nobody has to join)
 *  - "removed": the admin took you out, or said no
 *  - "full":    200 people (V1.55, was 30)
 *  - "error":   the hub could not be reached (with the reason and Try again) */
export function notInStage(v: Pick<SquadView, "in" | "auto">): AutoStage | null {
  if (v.in) return null;
  return v.auto?.stage ?? "joining";
}

// ---------- Squad settings (V1.47: simpler, one page per thing) ----------
export const SETTINGS_PAGES = [
  { id: "share", title: "What you share", line: "Choose what the squad can see" },
  { id: "name", title: "Your name and picture", line: "How the squad sees you" },
  { id: "notify", title: "Notifications", line: "Message cards, sound, Do Not Disturb" },
  { id: "looks", title: "Appearance", line: "Light or dark, colour, bubbles, text size, background" },
  { id: "ai", title: "Link my AI", line: "Let your AI talk to your friends' AIs" },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];
export const isSettingsPage = (v: unknown): v is SettingsPage => SETTINGS_PAGES.some((p) => p.id === v);
