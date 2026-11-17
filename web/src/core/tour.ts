// "Where things live" tour (PS 1.65, the developer's friend, 17 Nov 2026: "In the What's new, don't bombard the user immediately with a
// bunch of What's new stuff and tutorials everywhere. After about a minute of someone on the app, explain where each thing lives:
// where the Proton Bridge stuff is, where each new thing is.").
//
// After an update nothing new shows at once. After about a minute of real use (the clock and the quiet rules are the ones every
// island intro uses, core/featureintro.ts) ONE short tour starts on the island: one step per new 1.65 thing, each saying where it lives.
// Next and Done, Esc ends it, no button takes focus. The four 1.65 intros that already existed (receipts, posture, checklist, stacked
// notifications) are folded into it, so nobody sees five cards.
//
// Pure: no React, no DOM, no clock. tests/tour.test.ts checks it; views/FeatureIntro.tsx draws it.
// ADD A STEP = one entry in TOUR_STEPS, keyed by its feature id (core/features.ts). A step whose feature id this build does not know
// is skipped, so a feature that lands on another branch later only needs its entry here to start showing up.
import type { Where } from "./settingsindex.ts";

export const TOUR_ID = "tour-165";
/** The tour's own switch (features.json). */
export const TOUR_FEATURE = "whats-new-tour";
/** The intros the tour replaces (core/featureintro.ts INTROS ids): marked done when the tour runs. */
export const TOUR_FOLDS: readonly string[] = ["receipts", "posture-165", "checklist-165", "notif-stack-165", "gsquad-v3-165", "gsquad-pieces-165", "gsquad-dm", "proton-bridge-165", "settings-assistant-165"];

export interface TourStep {
  /** Which feature ids show this step: ANY one on is enough (a feature can have a few, for example G Squad's look and its messages). */
  ids: string[];
  title: string;
  /** One short sentence. */
  line: string;
  /** Where it lives, in plain words (Settings group and row names are the ones in core/settingsindex.ts). */
  where: string;
  /** Only on these (a feature the Mac does not have is not shown there). */
  on?: Where[];
  /** Only to the owner of the vault (their own project). */
  owner?: true;
  /** Only to people who can switch Client emails on (core/mailswitch.ts). */
  mail?: true;
}

/** The steps, in the order they come. Words wait for the developer's approval. */
export const TOUR_STEPS: TourStep[] = [
  { ids: ["posture-reminder"], title: "Posture reminder", line: "A stick figure reminds you to sit up straight.", where: "Settings, Posture Reminder", on: ["mac", "web"] },
  { ids: ["checklist-reminder"], title: "Checklist reminder", line: "A nudge when you have not ticked a task for a while.", where: "Settings, Checklist Reminder", on: ["mac", "web"] },
  { ids: ["device-backgrounds"], title: "Backgrounds per device", line: "Pick which of your devices show each background.", where: "Settings, Appearance, Background, Background for each device" },
  { ids: ["receipts"], title: "Receipts and Purchases", line: "Scan receipts with your phone and see what you spend.", where: "The Purchases button (Tab list on a Mac, menu on a phone). Switch: Settings, Your list, Receipts and Purchases", owner: true },
  { ids: ["notif-stack"], title: "Stacked notifications", line: "With many waiting you see the newest and a +number. Point at the +number to open the rest.", where: "On the island. Switch: Settings, G Squad, From the squad", on: ["mac"] },
  { ids: ["proton-bridge"], title: "Proton Mail", line: "Read your clients' Proton Mail in the email panel.", where: "Settings, Client emails, Link Proton Mail", on: ["mac"], mail: true },
  { ids: ["settings-assistant"], title: "Settings assistant", line: "Tell a little bot what you want and it finds the setting and takes you there.", where: "The bot at the top of Settings. Switch: Settings, Settings assistant" },
  { ids: ["time-estimates"], title: "Time estimates", line: "Give tasks an estimate, see how long they really took, and get a quiet line when the day is too full.", where: "A task's Edit (on a Mac also its right click menu), Estimate and Start. Switches: Settings, Your list" },
  { ids: ["fuller-history"], title: "Fuller history", line: "A private record of tasks you missed, added or deleted.", where: "Settings, Privacy and sharing, Fuller task history" },
  { ids: ["gsquad-v3", "gsquad-dm"], title: "G Squad, new look", line: "A new look with direct messages and group chats.", where: "Open G Squad. Your picture: Squad settings, Your name and picture" },
  { ids: ["gsquad-pieces"], title: "G Squad on your pages", line: "Put the squad chat, the leaderboard or who is working on any page.", where: "Edit mode, Add, the G Squad pieces" },
  { ids: ["nl-dates"], title: "Dates in plain words", line: "Type tomorrow 9am or every Friday in a new task and PS sets it. Click the chip to keep the words.", where: "Any Add a task box. Switch: Settings, Your list, Dates in plain words" },
  { ids: ["tz-focus"], title: "Time zones, opened tall", line: "Click a time zone to open it where the list is. Hover works as before.", where: "Time zones in the Tab list. Switch: Settings, Time and reset, Click a time zone to open it", on: ["mac", "web"] },
  { ids: ["audio-priority"], title: "Speakers and microphones in order", line: "Drag your speakers and microphones into order. PS uses the top one that is connected.", where: "The volume mixer button in the Tab list. Switch: Settings, Mac, Audio priority", on: ["mac"] },
  { ids: ["second-computer"], title: "Second Computer", line: "Pair your other Mac and send it files, research and, once you switch them on, code jobs.", where: "Settings, Second Computer. Code jobs: the Second Computer window, Outsource", on: ["mac"], owner: true },
  { ids: ["whats-new-tour"], title: "Edit mode on your phone", line: "Zoom out to move your pages and panels around.", where: "The Edit button at the top left of your list", on: ["phone"] },
];

export const TOUR_WORDS = {
  head: "Where things live",
  next: "Next",
  done: "Done",
  count: (i: number, n: number) => `${i + 1} of ${n}`,
  /** Settings, About and updates. */
  again: { name: "Show the tour again", line: "A short tour of where the new things live.", done: "Done", doneLine: "The tour comes back in a moment" },
};

export interface TourFacts {
  where: Where;
  /** The feature switch answer for an id (core/features.ts feature): an id this build does not know is off. */
  on: (id: string) => boolean;
  owner: boolean;
  mail: boolean;
}

/** The steps this person gets on this device: only features that are on in this build and fit this device. Order kept. */
export function tourSteps(f: TourFacts, steps: readonly TourStep[] = TOUR_STEPS): TourStep[] {
  return steps.filter((s) => s.ids.some((id) => f.on(id)) && (!s.on || s.on.includes(f.where)) && (!s.owner || f.owner) && (!s.mail || f.mail));
}

/** After Next on step `i` of `n`: the next step, or null when that was the last (Done). */
export function stepAfter(i: number, n: number): number | null {
  return i + 1 < n ? i + 1 : null;
}
/** Where a tour that was cut short (a meeting began, Sleep mode, a full screen app) starts again: the step it was on, so nobody
 *  clicks through the same steps twice. Anything odd (the steps got fewer, a bad number) starts at the first step. */
export function resumeAt(saved: number, n: number): number {
  return Number.isInteger(saved) && saved > 0 && saved < n ? saved : 0;
}
/** The main button's word on step `i` of `n`. */
export const buttonWord = (i: number, n: number): string => (i + 1 < n ? TOUR_WORDS.next : TOUR_WORDS.done);

/** The saved "show it again" request (this device, set by Settings, About, "Show the tour again"). */
export const AGAIN_KEY = "ps.tourAgain";
