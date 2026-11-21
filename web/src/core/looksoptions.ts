// Every setting on Settings > Looks, in the order it appears, with one plain line saying exactly what it changes on
// screen (V1.40, the developer 7 Nov 2026: "it's also a bit vague what actually changes. So spell it out better").
// One list, exported, so the setup menu (gsquad-welcome) shows the very same ids and words as the Looks tab.
// `part` names what a Preview shows and highlights (core/lookspreview.ts, views/SettingsScreen.tsx).
// `settings` are the vault settings keys it writes (synced to every device). `everyone`: in the public build too.
// No em or en dashes in any of these words.

export type LooksPart = "look" | "accent" | "work" | "type" | "outline" | "overdue" | "bg" | "rain" | "none";

export type LooksOption = {
  id: string;
  title: string;
  /** One line: exactly what changes on screen, and what does not. */
  changes: string;
  part: LooksPart;
  settings: string[];
  everyone: boolean;
  /** Only shown while another choice makes it matter (for example lightning sliders with a lightning background). */
  when?: string;
};

export const LOOKS_OPTIONS: LooksOption[] = [
  { id: "look", title: "Look", part: "look", settings: ["look"], everyone: true,
    changes: "Changes the colours and font of all of PS app at once: the list, every screen inside it, menus and pop ups." },
  { id: "accent", title: "Accent", part: "accent", settings: ["lookAccent"], everyone: true,
    changes: "Changes the one highlight colour of the chosen look: buttons, switches, ticks and whatever is selected." },
  { id: "working", title: "Working on", part: "work", settings: ["tmWorkStyle"], everyone: true,
    changes: "Changes only how the task you are working on stands out in the list. Every other task stays as it is." },
  { id: "density", title: "Density", part: "type", settings: ["lookDensity"], everyone: true,
    changes: "Changes the space inside and between rows, so more or fewer tasks fit on the screen." },
  { id: "textSize", title: "Text size", part: "type", settings: ["lookText"], everyone: true,
    changes: "Changes the size of all the words in PS app. The layout grows or shrinks with them." },
  { id: "font", title: "Font", part: "type", settings: ["lookFont"], everyone: true,
    changes: "Changes the typeface of all the words in PS app. Sizes and colours stay the same." },
  { id: "outline", title: "Outline (Priority 1 group)", part: "outline", settings: ["tmP1Style"], everyone: true,
    changes: "Changes only the frame drawn round your Priority 1 group. It shows once a task is in Priority 1." },
  { id: "prioGroups", title: "Priority groups", part: "none", settings: ["tmLvLook"], everyone: true,
    changes: "Changes only the box round two or more tasks on the same priority (Priority 2, 3 and so on). Plain by default: no glow, nothing moves." },
  { id: "overdue", title: "Overdue card", part: "overdue", settings: ["tmOverdue"], everyone: true,
    changes: "Changes only the Overdue card at the bottom right: its colour, its words and its effect." },
  { id: "background", title: "Background", part: "bg", settings: ["tmBg"], everyone: true,
    changes: "Changes what fills the screen behind the list, not the tasks themselves. It fades with the glass slider." },
  { id: "bgColour", title: "Colour background", part: "bg", settings: ["tmBg"], everyone: true,
    changes: "Fills the screen behind the list with a calm colour or soft gradient. Your tasks keep their own cards." },
  { id: "lightning", title: "Lightning", part: "bg", settings: ["tmBgIntensity", "tmBgFrequency"], everyone: true, when: "a lightning background",
    changes: "Changes how bright each lightning strike is and how often one comes. Only for the lightning backgrounds." },
  { id: "thunder", title: "Thunder", part: "none", settings: ["tmBgSound", "tmBgVolume"], everyone: true, when: "a lightning background",
    changes: "Plays a soft rumble after each lightning strike, at the volume you set. Off by default." },
  { id: "transparency", title: "List transparency", part: "bg", settings: ["tmBackdrop"], everyone: true,
    changes: "Changes how much of your screen shows through behind the Tab list. Your background fades with it; your tasks stay readable." },
  { id: "videoBright", title: "Video brightness", part: "bg", settings: ["tmBgVideoBright"], everyone: true, when: "a video background",
    changes: "Changes how bright your background video is behind the list. The video itself is never changed." },
  { id: "trail", title: "Mouse trail", part: "none", settings: ["tmTrail"], everyone: true,
    changes: "Changes what follows your mouse over your tasks: the soft Glow, sparks, lightning, a blade and more." },
  { id: "rain", title: "Rain", part: "rain", settings: ["tmRain"], everyone: true,
    changes: "Adds falling rain in front of the background and behind your tasks. It works with any background." },
  { id: "rainAmount", title: "How much rain", part: "rain", settings: ["tmRainAmount"], everyone: true, when: "rain is on",
    changes: "Changes how many drops fall, from a few to a downpour. The kind of rain stays the same." },
  { id: "network", title: "Network monitor", part: "none", settings: ["netMonitor"], everyone: true,
    changes: "Shows or hides the Network button and the VPN leak alarm. Off, PS app does not look at the network at all." },
];

const BY_ID = new Map(LOOKS_OPTIONS.map((o) => [o.id, o]));
/** One option by id (throws on a typo, so a renamed id is caught by tsc and the tests, not on screen). */
export function looksOption(id: string): LooksOption {
  const o = BY_ID.get(id);
  if (!o) throw new Error(`unknown Looks option ${id}`);
  return o;
}

/** What the preview chip says after the choice's name ("Ledger changes the whole of PS."), per part. */
export const PART_SHOWN: Record<LooksPart, string> = {
  look: "changes the whole of PS app",
  accent: "changes the highlight colour",
  work: "changes only the task you are working on",
  type: "changes all the words and spacing",
  outline: "changes only the Priority 1 group",
  overdue: "changes only the Overdue card",
  bg: "changes the screen behind the list",
  rain: "falls behind your tasks",
  none: "",
};
