// Every setting in PS, in one list (V1.43, the developer 8 Nov 2026: "the settings button is very confusing... Add a search bar
// and a settings menu so you can search for settings. Simplify the whole design").
// This list is the one place that says what a setting is called, the one plain line on what it does, which group of the
// side menu it lives in, whether it sits under that group's small "More", who sees it (the developer only, a Mac, the website, the
// phone) and the other words people type for it. Settings (views/SettingsScreen.tsx) draws its side menu and every group
// page from it, and its search bar searches it, so the menu, the pages and the search can never disagree.
// Adding a setting: one entry here (in the order it should show in its group) and its control in views/SettingsGroups.tsx
// under the same id. An entry with `go` and no control there is a row with an Open button (Fitness settings, Security,
// the Do Not Disturb cog, the phone's own sheet). An entry with `parent` is found by the search but drawn inside its
// parent's control (Sleep mode's alarms are inside Sleep mode). Pure: no React, no DOM.

import { norm, stem, scoreOne, tokensOf } from "./searchscore.ts";
import { SLEEP_ENTRIES } from "./sleepsettings.ts";
import { NOTEBOOK_ON } from "./features.ts";
import { APPROVE_LINE } from "./autoapprove.ts";
import { secondAllowed } from "./mailflag.ts";
import { SECOND_HERE } from "./secondswitch.ts";
export { norm, stem };

/** Where PS is running: on a Mac (the Tab list), the website, or the phone (PS GOS and the iPhone web app). */
export type Where = "mac" | "web" | "phone";
export type GroupId = "friend" | "list" | "controls" | "looks" | "notify" | "remind" | "chkremind" | "telegram" | "api" | "time" | "shortcuts" | "keys" | "island" | "mac" | "screenrec" | "sync" | "privacy" | "fitness" | "pomodoro" | "standup" | "posture" | "sleep" | "sentry" | "gsquad" | "phone" | "about" | "assistant";
/** What a setting opens instead of a row in Settings: a screen of its own. */
export type Go = "fitness" | "security" | "dnd" | "gsquad" | "sleepSettings" | "phone" | "vault" | "macApp";

export interface SetGroup {
  id: GroupId;
  label: string;
  /** One line under the label in the phone's list of sections. */
  line: string;
  /** An SVG path (24 by 24, stroked) for the side menu. */
  icon: string;
  on?: Where[];
}
export interface SetEntry {
  id: string;
  name: string;
  line: string;
  group: GroupId;
  /** Under the group's small "More" (advanced or rarely changed). */
  more?: boolean;
  /** The developer only (Numerology, PS Rules, his Gmail and anything already gated; Second Computer is everyone's since 1.65). */
  red?: true;
  /** Everyone but the developer (meetings from this Mac's Calendar: the developer's come from his Google calendar feed). */
  notRed?: true;
  on?: Where[];
  /** Other words people type for it. */
  words?: string[];
  go?: Go;
  /** For go "vault": the heading id on the website's Settings page. */
  anchor?: string;
  /** Drawn inside this entry's control; a search hit opens and lights up the parent. */
  parent?: string;
  /** Only for people whose PS shows client email cards (Reply from PS, V1.44; since 1.60 the Client emails switch is on). */
  mail?: true;
  /** Only for people who can switch Client emails on (first owner of their own Supabase project, core/mailswitch.ts). */
  mailCan?: true;
  /** Only once Second Computer is switched on (core/secondswitch.ts, PS 1.65). */
  second?: true;
  /** Only where screen recording is on in this build (core/features.ts "screen-recording"). */
  sr?: true;
  /** Only where the Posture reminder feature is on in this build (core/features.ts "posture-reminder"). */
  pf?: true;
  /** Only where the Checklist reminder feature is on in this build (core/features.ts "checklist-reminder"). */
  ck?: true;
  /** Only where time estimates are on in this build (core/features.ts "time-estimates"). */
  te?: true;
  /** Only in this phone shell: the GrapheneOS app ("gos") or the iPhone web app ("mweb"). V1.47. */
  shell?: Shell;
}
/** Which phone shell: the GrapheneOS app (ps-gos, a WebView with the native bridge) or the iPhone web app. */
export type Shell = "gos" | "mweb";
export interface Ctx { red: boolean; where: Where; mail?: boolean; mailCan?: boolean; shell?: Shell; sr?: boolean; pf?: boolean; ck?: boolean; te?: boolean }

export const GROUPS: SetGroup[] = [
  // V1.51 (the developer, 12 Nov 2026): About and updates is the top item of the Settings menu, above everything else, so the
  // update check is the first thing people find. (Settings still opens on Your list.)
  { id: "about", label: "About and updates", line: "Version, updates, what's new", icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" },
  // V1.44 Add friend (the developer: "in Settings, an Add friend tab; click it and a QR comes up"); first until V1.51, now right under About and updates.
  { id: "friend", label: "Add friend", line: "A QR code: they scan it and join your G Squad", icon: "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21a7 7 0 0 1 12.5-4.3M19 14v6M16 17h6" },
  { id: "list", label: "Your list", line: "Ticking, Completed, task size and sounds", icon: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" },
  // V1.57 (the developer, 13 Nov 2026: "make an option in settings, in another tab in the settings menu, to make it inverted").
  { id: "controls", label: "Controls", line: "How swipes move your pages", icon: "M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18" },
  // PS 1.65 Settings assistant (request of the developer's AI, 17 Nov 2026): the bot's own switches. Words wait for the owner's approval.
  { id: "assistant", label: "Settings assistant", line: "A bot that finds and changes settings for you", icon: "M12 3v3M8 6h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM9 12h.01M15 12h.01M9.5 15.5h5" },
  { id: "looks", label: "Appearance", line: "Look, colours, background and rain", icon: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1-.9-1.4-.9-2.4 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3zM7.5 10.5h.01M12 7.5h.01M16.5 10.5h.01" },
  { id: "notify", label: "Notifications and Do Not Disturb", line: "Pop-ups, meetings, focus modes, reminders", icon: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" },
  // The developer, 10 Nov 2026: "Add a dedicated settings menu to this ... in it's own settings tab called 'Annoying 15 min reminder'".
  { id: "remind", label: "Annoying 15 min reminder", line: "Pop-ups that keep coming back until you answer", icon: "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 1.5M5 3L2 6M19 3l3 3" },
  // PS 1.65 (request of the developer's AI, 17 Nov 2026): "A new Settings tab 'Checklist Reminder': on or off, and how often."
  { id: "chkremind", label: "Checklist Reminder", line: "A nudge when you have not ticked a task for a while", icon: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9", on: ["mac", "web"] },
  // V1.47, the developer 10 Nov 2026: "Make it so other people can add a Telegram bot as well. Add that in the Settings menu as a tab called Add Telegram Bot."
  { id: "telegram", label: "Add Telegram Bot", line: "Text tasks to your own bot and they land on your list", icon: "M21.5 4.5L2.8 11.7c-.9.4-.9 1.6.1 1.9l4.6 1.4 1.8 5.6c.3.8 1.3 1 1.9.4l2.6-2.5 4.8 3.5c.8.6 1.9.1 2.1-.8L23.9 6c.3-1.1-.9-2-2.4-1.5zM9.4 15l9.1-7.6" },
  // Task API (the developer, 12 Nov 2026: "make the API have a dedicated tab in settings and set up the scope with everything changeable via API").
  { id: "api", label: "AI task API", line: "Let Claude Code, Codex and other AI tools manage your tasks", on: ["mac"], icon: "M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12" },
  { id: "time", label: "Time and reset", line: "Time zone, daily reset, screen time", icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" },
  // V1.47 (the developer, 10 Nov 2026: "In the Settings menu, a tab called Tab overlay shortcuts").
  { id: "shortcuts", label: "Tab overlay shortcuts", line: "The keys that open your list: hold, combos, chords", on: ["mac"], icon: "M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9" },
  { id: "keys", label: "Keyboard and Tab", line: "Keep the list open, middle click, apps", on: ["mac"], icon: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8" },
  // V1.58 (the developer, 13 Nov 2026): the Dynamic Island's own tab, holding its settings themselves (views/IslandSettings.tsx).
  { id: "island", label: "Dynamic Island", line: "Look, position, full screen, notifications", on: ["mac"], icon: "M3 8h18v8H3zM16.5 12h.01" },
  { id: "mac", label: "Mac", line: "AFK timer, AirPods, audio priority, microphone, app name", on: ["mac"], icon: "M4 5h16v11H4zM2 20h20M9 16v4M15 16v4" },
  // PS 1.60 (pull request 12a): record sales calls and client calls. Off until the person says yes (core/screenrec.ts).
  { id: "screenrec", label: "Screen recording", line: "Record sales calls and client calls. Off until you switch it on", on: ["mac"], icon: "M4 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM18 10l4-2v8l-4-2M10 12h.01" },
  { id: "sync", label: "Sync and account", line: "Your project, your vault, other devices", icon: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" },
  { id: "privacy", label: "Privacy and sharing", line: "Security, passphrase, who can see what", icon: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9.5 12l2 2 3.5-3.5" },
  { id: "fitness", label: "Fitness", line: "Rest times, sets, week goal, gym reminder", icon: "M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11" },
  { id: "pomodoro", label: "Pomodoro timer", line: "Work and break times, sounds and the island", on: ["mac", "web"], icon: "M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM12 6V3.5M9 4.5l3 1.5 3-1.5M12 13.5V10.5M12 13.5l2.2 1.6" },
  { id: "standup", label: "Stand-up reminders", line: "How often to stand, for how long, and when", on: ["mac"], icon: "M12 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM12 7.5v7M8 10l4-2 4 2M12 14.5l-3 6.5M12 14.5l3 6.5" },
  { id: "posture", label: "Posture Reminder", line: "A pop-up now and then to sit up straight", on: ["mac", "web"], icon: "M12 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM10 8.5v6.5M10 15h6.5v6M7 21V9" },
  { id: "sleep", label: "Sleep mode", line: "Sleep mode has its own settings", icon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" },
  // V1.48 Sentry mode (core/sentry.ts): the gear on the AI button opens this group. Every Mac, public and private.
  { id: "sentry", label: "Sentry mode", line: "Lock your Mac and keep AI jobs running", on: ["mac"], icon: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM8.5 12s1.3-2.5 3.5-2.5 3.5 2.5 3.5 2.5-1.3 2.5-3.5 2.5-3.5-2.5-3.5-2.5z" },
  { id: "gsquad", label: "G Squad", line: "What your squad can see", icon: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4.5-6.5" },
  { id: "phone", label: "This phone", line: "How the list opens, haptics, your Macs", on: ["phone"], icon: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2" },
];

const MAC: Where[] = ["mac"], WEB: Where[] = ["web"], PHONE: Where[] = ["phone"], NOT_PHONE: Where[] = ["mac", "web"];
// V1.47 (the developer, 10 Nov 2026: "Redesign the settings menu on the GOS app. I don't like how cluttered it is. Do the same kind of
// redesign we did with the macOS app"): the phone's own long sheet (gos/GosSettings.tsx) is gone. Each of its settings is a
// row here, in the group it belongs to, so the phone gets the same search and the same list of groups as the Mac.
const GOS_ONLY = { on: PHONE, shell: "gos" as const }, MWEB_ONLY = { on: PHONE, shell: "mweb" as const };

export const SETTINGS: SetEntry[] = [
  // ---------- Settings assistant (PS 1.65) ----------
  { id: "assist-on", group: "assistant", name: "Settings assistant", line: "A small bot that finds a setting, shows where it lives and can change it for you.", words: ["assistant", "bot", "help", "ai", "ask", "find a setting", "settings help", "chat"] },
  { id: "assist-pop", group: "assistant", name: "Pop out when Settings opens", line: "The bot comes out of the island when you open Settings.", on: MAC, words: ["assistant", "bot", "island", "pop out", "pop up", "open settings"] },
  { id: "assist-ai", group: "assistant", name: "Settings assistant AI", line: "Who thinks about your request: Apple, Claude or ChatGPT. Each shows if it is ready.", on: MAC, words: ["assistant", "bot", "ai", "apple", "claude", "chatgpt", "openai", "anthropic", "codex", "key", "keychain", "model"] },

  // ---------- Add friend ----------
  { id: "add-friend", group: "friend", name: "Add friend", line: "Show this QR code. Any phone camera opens PS app and joins your G Squad.", words: ["qr", "qr code", "scan", "invite", "friend", "add", "add friend", "join", "share", "camera", "squad", "g squad", "meet", "business card", "link"] },

  // ---------- Your list ----------
  // ---------- Controls (V1.57) ----------
  { id: "invert-swipe", group: "controls", name: "Invert swipe", line: "Swipe the other way to reach the page on the left or right.", words: ["swipe", "invert", "inverted", "reverse", "direction", "flip", "pages", "left", "right", "natural", "gesture", "controls", "two fingers"] },
  { id: "tick-mode", group: "list", name: "When I tick a task", line: "Slide it into Completed, or let it leave the list.", words: ["done", "complete", "finish", "check", "tick", "disappear"] },
  // PS 1.65 Receipts: on unless switched off, on every device (views/Purchases.tsx, views/ReceiptScan.tsx, core/receipts.ts).
  { id: "receipts", group: "list", name: "Receipts and Purchases", line: "Scan paper receipts on your phone and see what you spend. Nothing leaves your devices.", words: ["receipt", "receipts", "purchases", "spending", "money", "finance", "scan", "shop", "shopping", "expenses", "budget", "currency", "lari", "gel"] },
  // ---------- Time estimates (PS 1.65, core/timeest.ts) ----------
  { id: "te-est", group: "list", name: "Time estimates", line: "Give a task an estimate. A new task with a name you used before gets its usual time.", te: true, words: ["estimate", "estimates", "how long", "duration", "minutes", "time", "learn", "usually"] },
  { id: "te-track", group: "list", name: "Time spent", line: "How long a task really takes, Working on or Start to the tick, less breaks. Only in your own vault.", te: true, words: ["time spent", "tracking", "timer", "track", "how long", "start", "stop", "clock", "actual"] },
  { id: "te-warn", group: "list", name: "Too much planned", line: "A quiet line at the top of your list when today's estimates are more than your free time.", te: true, words: ["overload", "warning", "too much", "planned", "free time", "busy", "rethink", "capacity"] },
  { id: "te-hours", group: "list", name: "Working hours", line: "Free time is these hours minus your meetings. An end before the start runs past midnight.", te: true, words: ["working hours", "work hours", "hours", "from", "to", "free time", "schedule", "midnight"] },
  { id: "completed-show", group: "list", name: "Completed section", line: "The grey Completed area at the bottom, with Resurrect.", words: ["done", "finished", "resurrect", "history", "ticked"] },
  { id: "completed-keep", group: "list", name: "Completed keeps ticks for", line: "Today, the last 7 days or the last 30 days.", words: ["done", "keep", "days", "history"] },
  { id: "task-size", group: "list", name: "Task size", line: "How big the tasks are on this list.", words: ["size", "big", "small", "zoom", "scale", "bigger", "smaller"] },
  { id: "sounds", group: "list", name: "Sounds", line: "The small hover and click sounds, with Test and Mute.", words: ["sound", "volume", "mute", "audio", "quiet", "silent", "noise", "click", "loud"] },
  { id: "tick-sound", group: "list", name: "Tick sound", line: "The sound a task makes when you tick it.", words: ["sound", "ding", "chime", "audio", "noise", "done"] },
  { id: "edit-sounds", group: "list", name: "Edit mode sounds", line: "Soft sounds in Edit: zooming out and in, sliding between pages, dropping panels, saved looks.", words: ["sound", "edit", "whoosh", "audio", "noise", "pages", "quiet"] },
  { id: "add-button", group: "list", name: "Add task button", line: "Its colour, and what it does when you click it.", more: true, words: ["new task", "plus", "add", "colour", "color", "spin"] },
  { id: "typed-prio", group: "list", name: "Typed priority", line: "Type P1, P2 or P3 in a new task to set its priority.", more: true, words: ["p1", "p2", "p3", "priority", "type", "urgent"] },
  { id: "nl-dates", group: "list", name: "Dates in plain words", line: "Type tomorrow 9am or every weekday in a new task to set its date. Click the chip to keep the words.", words: ["date", "dates", "natural language", "plain words", "tomorrow", "next week", "repeat", "every", "due", "parse", "smart", "chip"] },
  { id: "nl-remind", group: "list", parent: "nl-dates", name: "A typed time adds a reminder", line: "Tomorrow 9am also reminds you once, at 8:45 that day.", more: true, words: ["reminder", "time", "remind", "9am", "alarm"] },
  { id: "new-badge", group: "list", name: "NEW badges", line: "A NEW badge on tasks added in the last few minutes.", more: true, words: ["new", "badge", "label", "tag", "fresh"] },

  // ---------- Appearance ----------
  { id: "look", group: "looks", name: "Look", line: NOTEBOOK_ON ? "The whole look of PS app: Dark, Light, Notebook and more." : "The whole look of PS app: Dark, Light and more.", words: ["theme", "dark", "light", "mode", ...(NOTEBOOK_ON ? ["notebook"] : []), "skin", "style", "night", "colour", "color", "design"] },
  { id: "phone-layout", group: "looks", name: "Layout", line: "Compact, Cards, Focus or Simple: how the tasks sit on this phone.", on: PHONE, words: ["layout", "compact", "cards", "focus", "simple", "density", "rows", "list style"] },
  { id: "accent", group: "looks", name: "Accent colour", line: "The colour of buttons, ticks and highlights.", words: ["accent", "colour", "color", "tint", "highlight", "pink"] },
  { id: "layout-text", group: "looks", name: "Layout and text", line: "Density, text size and font for every look.", words: ["font", "density", "spacing", "compact", "text size", "typeface", "bigger text", "readable"] },
  { id: "working-on", group: "looks", name: "Working on", line: "How the task you are working on stands out.", words: ["working", "current task", "focus", "glow", "highlight"] },
  { id: "mouse-trail", group: "looks", name: "Mouse trail", line: "What follows your mouse over your tasks: the soft Glow, sparks, lightning, a blade and more.", on: NOT_PHONE, words: ["mouse", "cursor", "pointer", "trail", "hover", "follow", "effect", "effects", "sparks", "lightning", "sparkler", "fire", "blade", "sword", "katana", "comet", "neon", "laser", "orb", "embers", "stardust", "bubbles", "snow", "rainbow", "pixels", "particles", "shadow", "spotlight", "glow"] },
  { id: "transparency", group: "looks", name: "List transparency", line: "How much of your screen shows through the list.", on: MAC, words: ["transparent", "transparency", "glass", "see through", "opacity", "opaque", "blur", "backdrop", "clear"] },
  { id: "overdue-tab", group: "looks", name: "Overdue card", line: "The Overdue card at the bottom right: its colour, its text colour and an effect like lightning.", words: ["overdue", "late", "missed", "due", "past due", "bottom right", "tab", "card", "colour", "color", "text colour", "text color", "red", "effect", "lightning", "glow", "pulse", "shimmer", "fire", "embers", "alarm", "flash"] },
  { id: "outline", group: "looks", name: "Outline", line: "The frame drawn round the Priority 1 group.", words: ["p1", "priority", "border", "frame", "box"] },
  { id: "background", group: "looks", name: "Background", line: "What fills the screen behind the list: a scene, lightning or a video.", words: ["wallpaper", "video", "scene", "lightning", "storm", "image", "picture", "backdrop"] },
  { id: "bg-colour", group: "looks", name: "Colour background", line: "A plain colour behind the list.", words: ["colour", "color", "solid", "plain"] },
  { id: "rain", group: "looks", name: "Rain", line: "Rain falling over the screen. Off by default.", words: ["weather", "drops", "drizzle", "storm", "falling"] },
  { id: "phone-videos", group: "looks", name: "Your own videos", line: "Add a video from this phone as the background. It is encrypted before it leaves.", ...GOS_ONLY, red: true, words: ["video", "videos", "background", "wallpaper", "add video", "upload", "own video"] },
  { id: "own-colour", group: "looks", name: "Your own colour", line: "Any colour you like behind the list.", more: true, words: ["custom", "colour", "color", "hex", "picker"] },
  // V1.47: the phone's own background and how a video fits it (core/bgcrop.ts), drawn inside Background on a phone.
  { id: "phone-bg", group: "looks", name: "This phone's background", line: "Same as your Mac, or a background of its own.", on: PHONE, parent: "background", words: ["phone", "mobile", "own", "same as mac", "wallpaper", "background", "iphone", "grapheneos"] },
  { id: "device-bg", group: "looks", name: "Background for each device", line: "Tick which of your devices show a background. Each keeps its own.", parent: "background", words: ["device", "devices", "mac", "phone", "each", "own", "background", "wallpaper", "per device", "tick"] },
  { id: "phone-fit", group: "looks", name: "Fit on this phone", line: "Fill or Fit, zoom, the bars and the part of the video to show. Shown with a video background.", on: PHONE, parent: "background", words: ["crop", "fit", "fill", "zoom", "portrait", "bars", "letterbox", "focus", "part", "video", "phone"] },
  { id: "video-bright", group: "looks", name: "Video brightness", line: "How bright a background video plays. Shown with a video background.", more: true, parent: "background", words: ["dim", "dark", "brightness", "video"] },
  { id: "lightning", group: "looks", name: "Lightning and thunder", line: "Brightness, how often, and the thunder. Shown with a lightning background.", more: true, parent: "background", words: ["thunder", "storm", "flash", "strike"] },
  { id: "rain-amount", group: "looks", name: "How much rain", line: "From a few drops to a downpour. Shown while rain is on.", more: true, parent: "rain", words: ["rain", "amount", "heavy", "light"] },

  // ---------- Notifications and Do Not Disturb ----------
  { id: "dnd", group: "notify", name: "Do Not Disturb and focus modes", line: "Focus modes, their schedules and who gets through.", go: "dnd", words: ["dnd", "focus", "quiet", "silence", "silent", "mute", "schedule", "deep work", "calls", "do not disturb", "moon", "focus mode", "modes", "sleep focus", "who gets through", "senders", "allow"] },
  { id: "popups", group: "notify", name: "Notification pop-ups", line: "A small pop-up when Claude updates your vault or the calendar refreshes.", words: ["notifications", "alerts", "toast", "popup", "history"] },
  // V1.53: every PS user, and other AI tools too (views/AiDone.tsx, ps-mac Sources/AiDone.swift).
  { id: "ai-done", group: "notify", name: "AI chat finished cards", line: "The AI's own message or a plain card when a Claude Code, Codex, Gemini or Cursor chat ends.", on: MAC, words: ["claude", "claude code", "codex", "openai", "chatgpt", "gemini", "cursor", "ai", "chat", "finished", "done", "hook", "notification", "disappear", "by themselves", "timer", "seconds", "stays", "auto hide", "message", "messages", "ai messages", "plain"] },
  { id: "card-looks", group: "notify", name: "Card colours and sounds", line: "Each kind of card: its colour, and its sound or none.", on: MAC, more: true, words: ["notification sound", "alert sound", "colour", "color", "cards", "chime"] },
  { id: "meetings", group: "notify", name: "Meetings", line: "Alerts before a meeting, private mode and your notes during a call.", on: MAC, words: ["meeting", "call", "zoom", "calendar", "reminder", "notes", "private", "alert"] },
  { id: "calendar", group: "notify", name: "Meetings from this Mac's Calendar", line: "Show the meetings in the Calendar app on this Mac.", on: MAC, notRed: true, words: ["calendar", "ical", "events", "meetings"] },
  // 15 Nov 2026 (the developer's friend): each of the Mac's calendars is Meetings, Show only or Off (views/CalPicker.tsx, core/calpick.ts).
  { id: "calendars", group: "notify", name: "Calendars", line: "Choose which calendars PS works with: meetings, show only, or off.", on: NOT_PHONE, notRed: true, words: ["calendar", "calendars", "meetings", "routine", "routines", "events", "ical", "google", "icloud", "off", "hide", "show only", "private mode", "choose", "pick", "select", "which calendar"] },
  { id: "phone-checks", group: "notify", name: "Background checks", line: "How this phone hears about client emails and calls, with no Google services.", ...GOS_ONLY, words: ["background", "battery", "notifications", "sync", "push", "google", "check", "emails", "calls"] },
  { id: "phone-live", group: "notify", name: "Instant notifications", line: "Client emails, AI messages and finished chats within seconds, through one quiet connection.", ...GOS_ONLY, words: ["instant", "live", "fast", "laggy", "late", "slow", "push", "notifications", "realtime", "seconds", "battery"] },
  { id: "phone-perms", group: "notify", name: "Phone permissions", line: "Notifications, calls on the minute, the gym alarm and running while the phone sleeps.", ...GOS_ONLY, words: ["permission", "permissions", "allow", "notifications", "exact alarm", "calls on the minute", "gym alarm", "lock screen", "battery", "sleep", "full screen"] },
  { id: "mweb-alerts", group: "notify", name: "Alerts", line: "Meetings and new tasks show while the app is open.", ...MWEB_ONLY, words: ["notifications", "alerts", "push", "closed"] },
  // V1.46: the daily reminder is reminder one of the Annoying 15 min reminder tab; this row points there.
  { id: "daily-reminder", group: "notify", name: "Daily reminder", line: "Now in its own tab, Annoying 15 min reminder, with as many as you like.", on: MAC, words: ["daily", "follow up", "fup", "nudge"] },
  // V1.59 (the developer, 14 Nov 2026: "make it so you can click to reply IN the email panel, same thing on the desktop too").
  { id: "client-emails", group: "notify", name: "Client emails", line: "Client emails and Instantly replies as cards and in the email panel. Needs your own Supabase project.", mailCan: true,
    words: ["client", "emails", "email", "gmail", "instantly", "replies", "inbox", "cards", "mail", "oauth", "google cloud", "connect"] },
  // PS 1.65 Proton Mail through Proton Mail Bridge (views/ProtonBridgeSettings.tsx, core/protonmail.ts): Mac only.
  { id: "proton-bridge", group: "notify", name: "Link Proton Mail (Proton Bridge)", line: "Read your clients' Proton Mail in the email panel, through Proton Mail Bridge on this Mac.", on: MAC,
    words: ["proton", "proton mail", "bridge", "protonmail", "email", "mail", "imap", "link", "client emails", "keychain", "password"] },
  // PS 1.60 WhatsApp replies: the "WhatsApp settings" tab (status, Link WhatsApp, switches, quick replies, who messages me).
  { id: "whatsapp", group: "notify", name: "WhatsApp settings", line: "Reply to WhatsApp messages from PS. Link your number, then messages show as cards and in the email panel.", mailCan: true,
    words: ["whatsapp", "wa", "messages", "message", "chat", "link", "number", "meta", "cloud api", "reply", "quick replies", "mute"] },
  { id: "reply-in-panel", group: "notify", name: "Reply in the email panel", line: "A Reply button on each email in the email panel: type and send right there, with a short Undo.",
    words: ["reply", "inline", "email panel", "inbox", "emails", "send", "answer", "respond", "quick reply", "gmail", "instantly", "undo"] },
  { id: "reply-from-ps", group: "notify", name: "Reply from PS app", line: "Quick replies, your signature, when Send sends, and the accounts that can send.", on: MAC, mail: true,
    words: ["reply", "send", "email", "gmail", "instantly", "signature", "responses", "templates", "canned", "schedule", "scheduled", "send later", "outbox", "api key", "quick replies", "random", "delay", "robot"] },
  { id: "gmail-replies", group: "notify", name: "Who emails me", line: "Whose Gmail replies show as cards.", on: MAC, mail: true, more: true, words: ["gmail", "email", "mail", "client", "replies", "inbox"] },

  // ---------- Annoying 15 min reminder ----------
  { id: "reminders", group: "remind", name: "Your reminders", line: "Add as many as you like, each with its own words, times, colour and sound. The ones on your tasks too.", words: ["reminder", "reminders", "remind", "annoying", "15 min", "nag", "nudge", "pop up", "popup", "notification", "notifications", "alert", "daily", "question", "follow up", "fup", "add reminder", "multiple", "list", "task reminder", "reminder on a task", "bell", "on your tasks"] },
  { id: "rem-times", group: "remind", parent: "reminders", name: "When a reminder pops up", line: "The time it starts, the time it stops, the days and the time zone.", words: ["time", "times", "start", "stop", "from", "until", "window", "schedule", "days", "weekdays", "weekend", "time zone", "hours", "when"] },
  { id: "rem-snooze", group: "remind", parent: "reminders", name: "Remind me in", line: "How long a snooze lasts, 15 minutes by default, and that button's words.", words: ["snooze", "later", "remind me in", "15 minutes", "minutes", "delay", "again"] },
  { id: "rem-buttons", group: "remind", parent: "reminders", name: "Confirm button", line: "Yes, or your own words, and what has to be typed to clear it.", words: ["yes", "button", "confirm", "type", "typed", "word", "text", "words", "one click", "clear", "dismiss", "done"] },
  { id: "rem-colour", group: "remind", parent: "reminders", name: "Reminder colour", line: "The pop-up's background and accent, presets or the colour wheel.", words: ["colour", "color", "background", "accent", "theme", "wheel", "pink", "look"] },
  { id: "rem-sound", group: "remind", parent: "reminders", name: "Reminder sound", line: "None, a soft chime, an alarm tone or your own sound file.", words: ["sound", "audio", "file", "mp3", "chime", "alarm", "ring", "own sound", "loudness", "volume", "music"] },
  // V1.57: alarms at any time (the phone rings like the gym ring, the Mac shows a card).
  { id: "alarms", group: "remind", parent: "reminders", name: "Phone alarms", line: "Your phone rings like an alarm at the times you pick, and your Mac shows a card.", words: ["ring", "wake", "wake up", "alarm clock", "phone rings", "ring screen", "acknowledge", "time"] },
  { id: "rem-test", group: "remind", parent: "reminders", name: "Test a reminder", line: "Shows it right now with its sound. Esc ends it.", words: ["test", "try", "preview", "see it", "demo"] },

  // ---------- Posture Reminder (PS 1.65, core/posture.ts; the controls are views/PostureSettings.tsx) ----------
  { id: "posture-on", group: "posture", name: "Posture reminder", line: "A pop-up with a stick figure that slouches and sits up straight, and one button, Sitting straight.", on: NOT_PHONE, pf: true, words: ["posture", "sit", "sitting", "straight", "slouch", "back", "spine", "desk", "ergonomic", "health", "reminder", "stick figure", "pop up", "popup"] },
  { id: "posture-every", group: "posture", name: "How often", line: "Every 30, 45, 60 or 90 minutes.", on: NOT_PHONE, pf: true, words: ["posture", "interval", "how often", "every", "minutes", "frequency", "30", "45", "60", "90"] },
  { id: "posture-hours", group: "posture", name: "Between these times", line: "It only comes inside these hours. An end time before the start time runs past midnight.", on: NOT_PHONE, pf: true, words: ["posture", "hours", "from", "to", "start", "end", "work hours", "schedule", "time", "midnight"] },
  { id: "posture-test", group: "posture", name: "Try it now", line: "Shows the pop-up right now. Esc closes it.", on: NOT_PHONE, pf: true, words: ["posture", "test", "try", "preview", "demo", "see it"] },
  // ---------- Checklist Reminder (PS 1.65, core/chkremind.ts) ----------
  { id: "chk-on", group: "chkremind", name: "Checklist reminder", line: "Says DO YOUR CHECKLIST when you have not ticked a task for a while. Never in meetings.", on: ["mac", "web"], ck: true, words: ["checklist", "reminder", "nag", "nudge", "to do", "todo", "tick", "tasks", "pop up", "popup", "focus"] },
  { id: "chk-every", group: "chkremind", name: "How often", line: "How long without a ticked task before it comes: 30 minutes to 12 hours, 2 hours to start.", on: ["mac", "web"], ck: true, words: ["how often", "interval", "minutes", "hours", "every", "frequency", "checklist"] },
  { id: "chk-sound", group: "chkremind", name: "Soft chime", line: "A soft chime when the pop-up comes.", on: ["mac"], ck: true, words: ["sound", "chime", "ring", "checklist"] },
  { id: "chk-test", group: "chkremind", name: "Show it now", line: "See the pop-up right away. Nothing is saved.", on: ["mac", "web"], ck: true, words: ["test", "preview", "try", "checklist"] },

  // ---------- Add Telegram Bot (views/TelegramBot.tsx, core/tgbot.ts) ----------
  { id: "telegram-bot", group: "telegram", name: "Your Telegram bot", line: "Make a bot with BotFather, give PS app its key, link your Telegram, test it.", words: ["telegram", "bot", "botfather", "text", "message", "sms", "chat", "add task", "send task", "token", "key", "at", "tasks from phone", "remote"] },
  { id: "tg-key", group: "telegram", parent: "telegram-bot", name: "Bot key", line: "Kept in this Mac's Keychain or this phone's Keystore, never synced.", words: ["token", "key", "api", "paste", "keychain", "keystore"] },
  { id: "tg-link", group: "telegram", parent: "telegram-bot", name: "Link my Telegram", line: "Send PS app's code to your bot so only your own messages count.", words: ["link", "connect", "start", "chat", "code", "unlink"] },
  { id: "tg-rules", group: "telegram", parent: "telegram-bot", name: "Telegram message rules", line: "The start word, P1 to P3, today or tomorrow, two commas for several tasks, ASAP, DX, UD and Act.", words: ["rules", "prefix", "start word", "at", "p1", "p2", "p3", "priority", "asap", "urgent", "dimension x", "upside down", "actionables", "cheat sheet", "commas"] },
  { id: "tg-remove", group: "telegram", parent: "telegram-bot", name: "Remove bot", line: "Takes the key off this device and unlinks your Telegram.", words: ["remove", "delete", "disconnect", "forget", "unlink"] },
  { id: "task-api", group: "api", name: "AI task API", line: "Lets an AI like Claude Code or Codex on this Mac add and manage your tasks.", on: ["mac"], words: ["api", "ai", "claude", "claude code", "codex", "gpt", "cursor", "gemini", "agent", "automation", "local", "localhost", "key", "token", "scope", "permissions", "inbox", "ai inbox", "integration", "curl", "http"] },
  { id: "api-key", group: "api", parent: "task-api", name: "API key", line: "The key an AI sends with every request. Show, copy or make a new one.", on: ["mac"], words: ["key", "token", "secret", "regenerate", "new key", "copy key", "show key"] },
  { id: "api-scopes", group: "api", parent: "task-api", name: "What an AI may do", line: "One switch each: the AI Inbox, all lists, renaming, read, add, edit, tick, delete, reminders, gym, messages.", on: ["mac"], words: ["message", "messages", "scopes", "permissions", "allow", "read", "add", "edit", "delete", "tick", "done", "reminders", "rename", "lists", "switches", "sentry", "sentry mode", "lock", "gym"] },
  { id: "api-connect", group: "api", parent: "task-api", name: "Connect your AI", line: "Your AI messages you on the Dynamic Island when it finishes. Copy a rule it saves to its memory.", on: ["mac"], words: ["message", "messages", "island", "dynamic island", "notify", "summary", "end of chat", "finished", "claude.md", "agents.md", "memory", "rules", "connect", "chatgpt"] },
  { id: "api-copy", group: "api", parent: "task-api", name: "Copy for AI", line: "Copies everything an AI needs to use the API: paste it into Claude Code or Codex.", on: ["mac"], words: ["copy", "prompt", "instructions", "docs", "documentation", "paste", "guide", "setup"] },

  // ---------- Time and reset ----------
  { id: "home-tz", group: "time", name: "Your time zone", line: "The clocks compare every zone with this one.", words: ["timezone", "time zone", "tz", "zone", "clock", "gmt", "utc", "city", "home"] },
  { id: "tz-names", group: "time", name: "Clock names", line: "Double click a clock's name on Time zones to rename it. Empty brings its own name back.", words: ["rename", "rename clock", "clock name", "zone name", "label", "nickname", "time zones", "clocks"] },
  { id: "tz-focus", group: "time", name: "Click a time zone to open it", line: "A click opens a zone tall, where the list is. Tiny arrows move a typed time 30 minutes.", words: ["time zones", "click", "open", "tall", "client", "focus", "convert", "30 minutes", "half hour", "arrows", "step"] },
  { id: "auto-reset", group: "time", name: "Reset automatically", line: "Ticked tasks are filed away each day at your reset time.", words: ["reset", "midnight", "end of day", "new day", "daily", "clear", "eod", "reset time", "reset at", "time of reset", "4am", "morning"] },
  { id: "day-ends", group: "time", name: "Your work day ends at", line: "A Reset you press before this time counts for the day before.", more: true, words: ["night shift", "reset", "work day", "end of day", "eod"] },
  { id: "st-hours", group: "time", name: "Screen time timeline", line: "How many hours the timeline under the clocks shows.", words: ["screen time", "screentime", "hours", "timeline"] },
  // Open source build: the phone's own screen time switch (gos/bridge.ts, ps-gos ScreenTime.today; the Mac's is screen-time).
  { id: "phone-screen-time", group: "time", name: "Track my screen time", line: "Counts how long each app is in front on this phone. App names only. Off: nothing is read.", ...GOS_ONLY, words: ["screen time", "screentime", "usage", "apps", "tracking", "track", "off"] },
  { id: "phone-usage", group: "time", name: "Screen time on this phone", line: "Usage access lets PS app count each app. Signal and 1Password are never read.", ...GOS_ONLY, words: ["screen time", "screentime", "usage", "usage access", "apps", "track"] },
  { id: "screen-time", group: "time", name: "Track my screen time", line: "Counts how long each app is in front. App names only.", on: MAC, words: ["screen time", "screentime", "usage", "apps", "tracking", "track"] },

  // ---------- Tab overlay shortcuts (V1.47) ----------
  { id: "trigger-key", group: "shortcuts", name: "Your shortcuts", line: "Hold a key, tap a combo, or hold one key then press another. Pick any keys, on any keyboard.", on: MAC,
    words: ["tab", "key", "keys", "shortcut", "shortcuts", "hotkey", "option", "right option", "hold", "trigger", "keyboard", "combo", "chord", "record", "open", "language", "layout", "rhythm", "change key", "reset", "reset to tab"] },
  { id: "slash", group: "shortcuts", parent: "trigger-key", name: "Hold / and press .", line: "Another way to show the list at once, one of the shortcuts.", on: MAC, words: ["slash", "dot", "chord", "shortcut", "keyboard"] },

  // ---------- Keyboard and Tab ----------
  { id: "tab-stays", group: "keys", name: "Tab keeps the list open", line: "Hold Tab and let go: the list stays until you hold Tab again.", on: MAC, words: ["keep open", "pin", "sticky", "stay", "tab"] },
  { id: "middle-click", group: "keys", name: "Force Touch middle click", line: "A firm press on the trackpad acts as a middle click.", on: MAC, words: ["trackpad", "mouse", "middle click", "press", "force touch", "click"] },
  { id: "ignored-apps", group: "keys", name: "Leave the key alone in these apps", line: "Games that use hold Tab for their scoreboard keep it.", on: MAC, more: true, words: ["games", "ignore", "exclude", "scoreboard", "apps", "except"] },

  // ---------- Mac ----------
  { id: "island", group: "island", name: "Dynamic Island", line: "Its shape or Off, where it sits, how long its line hides it, notifications and full screen.", on: MAC, words: ["island", "notch", "pill", "position", "move", "hide", "dynamic", "notifications", "cards", "pop-ups", "popups", "top right", "corner", "come from", "animation", "full screen", "fullscreen", "top left", "top bar", "black bar", "menu bar", "tick", "circle", "side", "left", "right", "off", "turn off", "disable"] },
  // PS 1.60 (pull request 12a, views/ScreenRec.tsx): one block with every choice; the rows below are only found by the search.
  { id: "screenrec", group: "screenrec", name: "Screen recording", line: "Record calls. Off until you switch it on: PS asks macOS for nothing while it is off.", on: MAC, sr: true,
    words: ["record", "recording", "screen", "recorder", "meeting", "call", "video", "zoom", "capture", "privacy", "permission", "microphone"] },
  { id: "screenrec-quality", group: "screenrec", parent: "screenrec", name: "Resolution, frame rate and quality", line: "Calls, Sharp or Tiny, or your own mix, with the space an hour takes.", on: MAC, sr: true, words: ["resolution", "1080p", "720p", "4k", "fps", "frame rate", "hevc", "h264", "bitrate", "size", "preset", "tiny", "sharp", "calls"] },
  { id: "screenrec-audio", group: "screenrec", parent: "screenrec", name: "Microphone and computer sound", line: "Pick the mic, keep the computer sound, or record audio only.", on: MAC, sr: true, words: ["mic", "microphone", "airpods", "audio only", "m4a", "sound", "tracks"] },
  { id: "screenrec-leave", group: "screenrec", parent: "screenrec", name: "Leave out apps", line: "Apps whose sound and windows are never recorded.", on: MAC, sr: true, words: ["spotify", "exclude", "leave out", "hide app"] },
  { id: "screenrec-folder", group: "screenrec", parent: "screenrec", name: "Save folder", line: "Where recordings go. A missing or full folder falls back to the default one.", on: MAC, sr: true, words: ["folder", "external drive", "location", "save", "files", "names"] },
  { id: "screenrec-cloud", group: "screenrec", parent: "screenrec", name: "Cloud upload", line: "Send recordings to your cloud, then free this Mac once PS checks the copy.", on: MAC, sr: true, words: ["cloud", "upload", "google drive", "icloud", "dropbox", "onedrive", "remove from this mac", "keep days", "encrypt", "sign in", "free space"] },
  { id: "screenrec-ask", group: "screenrec", parent: "screenrec", name: "Ask to record meetings", line: "When a meeting starts, the island asks if you want to record it.", on: MAC, sr: true, words: ["meeting", "ask", "island", "question", "start"] },
  { id: "screenrec-perf", group: "screenrec", parent: "screenrec", name: "Performance watch", line: "While recording, PS makes the recording lighter before the Mac struggles.", on: MAC, sr: true, words: ["performance", "cpu", "heat", "thermal", "memory", "disk", "slow", "lag"] },
  { id: "screenrec-off", group: "screenrec", parent: "screenrec", name: "Switch screen recording off", line: "Stops any recording and shows how to remove PS from macOS Privacy settings.", on: MAC, sr: true, words: ["off", "remove", "privacy", "revoke", "permission"] },
  { id: "afk", group: "mac", name: "AFK timer", line: "Counts how long you are away from the keyboard and mouse.", on: MAC, words: ["afk", "away", "idle", "break", "stopwatch", "inactive"] },
  { id: "airpods", group: "mac", name: "AirPods card", line: "Gives the AirPods play button back to Spotify when a tab takes it.", on: MAC, words: ["airpods", "headphones", "spotify", "play", "pause", "media", "button"] },
  // PS 1.65 Audio priority (core/audiopriority.ts, views/AudioPriority.tsx): the switch; the lists live in the volume mixer.
  { id: "audio-priority", group: "mac", name: "Audio priority", line: "Uses the top connected speaker and microphone from your order in the volume mixer.", on: MAC, words: ["audio", "sound", "output", "input", "speakers", "speaker", "microphone", "mic", "airpods", "headphones", "bluetooth", "jbl", "order", "priority", "default", "switch", "auto switch", "device", "devices"] },
  { id: "mic", group: "mac", name: "Microphone", line: "The default microphone for every app.", on: MAC, words: ["mic", "microphone", "input", "audio", "voice"] },
  { id: "network", group: "mac", name: "Network monitor", line: "The Network button and the VPN leak alarm.", on: MAC, words: ["vpn", "network", "leak", "internet", "wifi", "connection", "traffic"] },
  { id: "app-name", group: "mac", name: "App name", line: "What PS app is called in Applications, Finder and Spotlight.", on: MAC, more: true, words: ["rename", "name", "title", "folder"] },

  // ---------- Sync and account ----------
  // Local first (V1.44): shown only while the data lives on this device, or a copy of it is kept after the move.
  { id: "local-data", group: "sync", name: "Data on this device", line: "Where your data is, and Turn on sync.", words: ["sync", "turn on sync", "local", "device", "offline", "account", "supabase", "backup", "copy"] },
  { id: "local-backup", group: "sync", name: "Export my data", line: "An encrypted backup file, and bringing one back in.", words: ["export", "import", "backup", "file", "download", "restore", "save", "copy"] },
  { id: "mweb-project", group: "sync", name: "Your project", line: "The Supabase project your list lives in. Changing it signs you out here.", ...MWEB_ONLY, words: ["supabase", "project", "change project", "sign out", "server", "database"] },
  { id: "project", group: "sync", name: "Supabase project", line: "The project this Mac keeps your encrypted vault in.", on: MAC, words: ["supabase", "database", "server", "project", "own", "sync"] },
  // Link your iPhone by scan (a friend's own project only; views/LinkIphone.tsx, src/mobile/linkcode.ts).
  { id: "link-iphone", group: "sync", name: "Link your iPhone", line: "Show a code on this Mac. Scan it with your iPhone and it is linked to your project.", on: MAC, notRed: true, words: ["iphone", "phone", "link", "scan", "qr", "qr code", "camera", "connect", "mobile", "pair", "project", "supabase", "key"] },
  // V1.55: on the developer's project the same code signs his phone in (PS GOS and the phone web app both run on his project), no
  // project link needed. views/LinkIphone.tsx, core/phonepair.ts. The passphrase sign in there is unchanged.
  { id: "mac-phone-signin", group: "sync", name: "Sign in your phone", line: "Show a code on this Mac. Scan it in PS on your phone and it signs in, no typing.", on: MAC, red: true, words: ["phone", "pixel", "android", "iphone", "sign in", "log in", "scan", "qr", "qr code", "camera", "pair", "link"] },
  { id: "second", group: "sync", name: "Second Computer", line: "Pair your other Mac: lock it, restart it, send files.", on: MAC, words: ["second", "other mac", "m1", "m4", "pair", "pairing", "computer", "outsource", "code jobs", "code job", "git bundle"] },
  { id: "invite", group: "sync", name: "Invite people", line: "Invite someone to PS app from the website, Settings, Invite owners.", on: MAC, red: true, more: true, words: ["invite", "friend", "share", "owner", "collaborators"] },
  { id: "vault", group: "sync", name: "Your vault", line: "Auto lock, your name, import, export and this device.", on: WEB, go: "vault", anchor: "pref-h", words: ["account", "vault", "profile"] },
  { id: "auto-lock", group: "sync", name: "Auto lock after", line: "Locks the vault after this long with nothing done.", on: WEB, go: "vault", anchor: "pref-h", parent: "vault", words: ["lock", "timeout", "idle", "auto lock"] },
  { id: "display-name", group: "sync", name: "Your display name", line: "Used in greetings around the app.", on: WEB, go: "vault", anchor: "pref-h", parent: "vault", words: ["name", "greeting", "profile"] },
  { id: "birthday", group: "sync", name: "Your birthday", line: "Kept encrypted in your vault.", on: WEB, go: "vault", anchor: "pref-h", parent: "vault", words: ["birthday", "birth", "date"] },
  { id: "web-theme", group: "sync", name: "Website theme", line: "System, Light or Dark for the website's pages.", on: WEB, go: "vault", anchor: "pref-h", parent: "vault", words: ["theme", "dark", "light", "system"] },
  { id: "import", group: "sync", name: "Import clients from a file", line: "Bring in clients from a spreadsheet.", on: WEB, go: "vault", anchor: "imp-h", parent: "vault", more: true, words: ["import", "csv", "spreadsheet", "upload"] },
  { id: "export", group: "sync", name: "Export everything", line: "Download a copy of your whole vault.", on: WEB, go: "vault", anchor: "exp-h", parent: "vault", more: true, words: ["export", "backup", "download", "copy"] },
  { id: "install", group: "sync", name: "Install as an app", line: "Open the website like an app of its own.", on: WEB, go: "vault", anchor: "ins-h", parent: "vault", more: true, words: ["install", "app", "pwa", "home screen"] },
  { id: "device", group: "sync", name: "This device", line: "What this browser is and how it is signed in.", on: WEB, go: "vault", anchor: "dev-h", parent: "vault", more: true, words: ["device", "browser"] },

  // ---------- Privacy and sharing ----------
  { id: "security", group: "privacy", name: "Security", line: "Auto reboot, Are you sure and signing out, behind the padlock.", on: MAC, go: "security", words: ["security", "padlock", "lock", "filevault", "password", "touch id"] },
  { id: "auto-reboot", group: "privacy", name: "Auto reboot", line: "Restarts this Mac after it has been locked for a while.", on: MAC, go: "security", parent: "security", words: ["reboot", "restart", "afu", "bfu", "locked", "graphene"] },
  { id: "helper-remind", group: "privacy", name: "Remind me to set up the restart helper", line: "A pop up when auto reboot or Sentry mode needs the restart helper and it is off.", on: MAC, go: "security", parent: "security", words: ["restart helper", "helper", "pop up", "popup", "remind", "reminder", "reboot", "nag"] },
  { id: "are-you-sure", group: "privacy", name: "Are you sure", line: "Opening a time wasting app or site asks you first.", on: MAC, go: "security", parent: "security", words: ["are you sure", "youtube", "netflix", "distraction", "block", "ays"] },
  { id: "sign-out", group: "privacy", name: "Sign out of this Mac", line: "In Security, behind the padlock.", on: MAC, go: "security", parent: "security", words: ["sign out", "log out", "logout", "signout"] },
  { id: "phone-ays", group: "privacy", name: "Are you sure", line: "Opening YouTube or Netflix asks you first: wait 10 seconds or type the sentence.", ...GOS_ONLY, words: ["are you sure", "youtube", "netflix", "distraction", "block", "ays"] },
  { id: "phone-signin", group: "privacy", name: "Fingerprint sign in", line: "Your keys sit in this phone's Titan chip, behind your fingerprint.", ...GOS_ONLY, words: ["fingerprint", "biometric", "sign in", "unlock", "keystore", "titan", "forget"] },
  { id: "phone-stay", group: "privacy", name: "Stay signed in", line: "PS app opens straight away with no fingerprint, and never locks by itself.", ...GOS_ONLY, words: ["stay signed in", "remember", "fingerprint", "lock", "auto lock"] },
  { id: "phone-lock", group: "privacy", name: "Lock now", line: "Clears your keys from this phone's memory until you open it again.", on: PHONE, words: ["lock", "lock now", "sign out", "keys"] },
  // Open source build: the private ps-presence channel (src/ps.ts startPsPresence) can be switched off.
  { id: "ps-presence", group: "privacy", name: "Tell the website PS app is open", line: "Lets the website know PS app is open on this Mac, so the website leaves Tab to it. Nothing else is sent.", on: NOT_PHONE, words: ["presence", "online", "open", "website", "realtime", "channel", "privacy", "tab"] },
  // Fuller task history (PS 1.65, core/taskhist.ts): on unless switched off, on every device.
  { id: "fuller-history", group: "privacy", name: "Fuller task history", line: "Keeps a private, encrypted record of tasks you missed, added or deleted. Yours alone.", words: ["task", "history", "missed", "failed", "added", "deleted", "dimension x", "earnings", "money", "monthly", "privacy", "tracking", "collect", "log"] },
  // Rewind (PS 1.64, src/rewind.ts, core/rewind.ts): public, on unless switched off, on every device.
  { id: "rewind", group: "privacy", name: "Rewind (yearly recap)", line: "Keeps a private, encrypted history of your year on your account, for a recap on 1 January.", words: ["rewind", "recap", "wrapped", "year", "yearly", "history", "stats", "new year", "summary", "privacy", "tracking", "collect"] },
  { id: "rewind-delete", group: "privacy", name: "Delete my Rewind data", line: "Deletes your whole Rewind history from every device.", parent: "rewind", words: ["rewind", "delete", "erase", "remove", "recap", "history", "wipe"] },
  { id: "vault-safety", group: "privacy", name: "How your vault is protected", line: "Your passphrase, the sign-in log and Claude's access.", on: WEB, go: "vault", anchor: "sec-h", words: ["encryption", "privacy", "security", "protected"] },
  { id: "passphrase", group: "privacy", name: "Change passphrase", line: "The passphrase that opens your vault.", on: WEB, go: "vault", anchor: "pp-h", parent: "vault-safety", words: ["password", "passphrase", "change password"] },
  { id: "signin-log", group: "privacy", name: "Sign-in log", line: "Every device that signed in, and when.", on: WEB, go: "vault", anchor: "log-h", parent: "vault-safety", words: ["login", "log in", "sign in", "devices", "history"] },
  { id: "claude-access", group: "privacy", name: "Claude access", line: "Claude's own account in client workspaces.", on: WEB, red: true, go: "vault", anchor: "ai-h", parent: "vault-safety", words: ["claude", "ai", "agent", "access"] },

  // ---------- Pomodoro (V1.58, core/pomodoro.ts; the controls are views/SettingsGroups.tsx) ----------
  { id: "pomo-on", group: "pomodoro", name: "Pomodoro", line: "The Pomodoro button in your Tab list. Off hides it and stops a running timer.", on: NOT_PHONE, words: ["pomodoro", "tomato", "timer", "focus", "work timer", "break timer", "button"] },
  { id: "pomo-work", group: "pomodoro", name: "Work session", line: "How long you work for in each session.", on: NOT_PHONE, words: ["pomodoro", "work", "session", "length", "minutes", "focus", "timer"] },
  { id: "pomo-short", group: "pomodoro", name: "Short break", line: "The break after each work session.", on: NOT_PHONE, words: ["pomodoro", "break", "short break", "rest", "minutes"] },
  { id: "pomo-long", group: "pomodoro", name: "Long break", line: "The longer break after a few work sessions.", on: NOT_PHONE, words: ["pomodoro", "break", "long break", "rest", "minutes"] },
  { id: "pomo-rounds", group: "pomodoro", name: "Sessions before a long break", line: "How many work sessions come before the long break.", on: NOT_PHONE, words: ["pomodoro", "rounds", "sessions", "cycle", "long break", "how many"] },
  { id: "pomo-auto", group: "pomodoro", name: "Start the next one by itself", line: "When a session or a break ends, the next one starts on its own. Off, it waits for Start.", on: NOT_PHONE, words: ["pomodoro", "auto start", "automatic", "next session", "continue", "wait"] },
  { id: "pomo-sound", group: "pomodoro", name: "Pomodoro sound", line: "A soft chime when a break starts and when it ends.", on: NOT_PHONE, words: ["pomodoro", "sound", "chime", "ding", "audio", "quiet", "mute"] },
  { id: "pomo-clock", group: "pomodoro", name: "Time left on the island while you work", line: "The minutes left beside your task while you work. Breaks always show their countdown.", on: MAC, words: ["pomodoro", "island", "dynamic island", "countdown", "time left", "clock", "notch"] },

  // ---------- Stand-up reminders (V1.58, core/standup.ts; the controls are views/IslandTimersSettings.tsx) ----------
  { id: "stand-on", group: "standup", name: "Stand-up reminders", line: "The island tells you to stand up now and then, with a 15 second countdown first.", on: MAC, words: ["stand", "stand up", "standing", "sitting", "sit", "posture", "health", "move", "break", "reminder", "desk"] },
  { id: "stand-every", group: "standup", name: "How often", line: "Minutes between stand-ups. 30 minutes is what the research suggests.", on: MAC, words: ["stand", "interval", "how often", "every", "minutes", "frequency"] },
  { id: "stand-len", group: "standup", name: "How long to stand", line: "The countdown on the island while you stand. 2 minutes by default.", on: MAC, words: ["stand", "length", "how long", "duration", "minutes"] },
  { id: "stand-sound", group: "standup", name: "Stand-up sound", line: "A soft chime when it is time to stand and when you are done.", on: MAC, words: ["stand", "sound", "chime", "audio", "quiet", "mute"] },
  { id: "stand-hours", group: "standup", name: "Only between these times", line: "Stand-ups only come inside these hours. Off, they come whenever PS app is open.", on: MAC, words: ["stand", "hours", "active hours", "work hours", "schedule", "time", "from", "to"] },
  { id: "stand-test", group: "standup", name: "Try it now", line: "See a stand-up on the island in 15 seconds.", on: MAC, words: ["stand", "test", "try", "preview", "demo", "island"] },
  { id: "meet-bubble", group: "notify", name: "Next meeting on the island", line: "A bubble beside the island counts down to your next meeting, then shows Join and the time left.", on: MAC, words: ["meeting", "next meeting", "countdown", "island", "dynamic island", "join", "bubble", "calendar", "call"] },
  { id: "meet-bubble-lead", group: "notify", name: "Show it this long before", line: "How many minutes before a meeting the bubble shows.", on: MAC, parent: "meet-bubble", words: ["meeting", "minutes", "before", "lead", "countdown", "island"] },
  { id: "meet-bubble-style", group: "notify", name: "Look of the meeting countdown", line: "A small blob on the end of the island, or the older long pill.", on: MAC, parent: "meet-bubble", words: ["meeting", "blob", "pill", "bubble", "look", "style", "countdown", "island"] },
  { id: "welcome-back", group: "notify", name: "Welcome back on the island", line: "After you were away, the island lists the tasks you were working on so you can tick the ones you finished.", on: MAC, words: ["welcome back", "away", "unlock", "wake", "tasks", "tick", "island"] },
  { id: "welcome-back-min", group: "notify", name: "Show it after being away this long", line: "Minutes away from the Mac before Welcome back shows.", on: MAC, parent: "welcome-back", words: ["welcome back", "minutes", "away", "how long", "island"] },
  { id: "workout-mac", group: "notify", name: "Workout summary on the Mac", line: "After a workout you finished on your phone, the island congratulates you and shows what you did, once.", on: MAC, words: ["workout", "gym", "summary", "complete", "island", "fitness", "phone", "congratulations"] },

  // ---------- Fitness (in Fitness, its Settings tab) ----------
  { id: "fitness", group: "fitness", name: "Fitness settings", line: "Rest times, sets, week goal, gym reminder and the Fitness look.", go: "fitness", words: ["gym", "workout", "exercise", "training", "fitness", "nag", "ring time", "gym reminder"] },
  { id: "fit-look", group: "fitness", name: "Fitness look", line: "Volt, Chalk or Pulse.", go: "fitness", parent: "fitness", words: ["gym", "theme", "colour", "color", "chalk", "volt", "pulse", "pick your look", "light and dark"] },
  { id: "fit-rest", group: "fitness", name: "Rest between sets", line: "The long and the short rest times.", go: "fitness", parent: "fitness", words: ["rest", "timer", "seconds", "break", "gym"] },
  { id: "fit-sets", group: "fitness", name: "Sets", line: "How many sets new exercises start with.", go: "fitness", parent: "fitness", words: ["sets", "reps", "gym"] },
  { id: "fit-goal", group: "fitness", name: "Week goal", line: "How many days a week you train.", go: "fitness", parent: "fitness", words: ["goal", "target", "days", "streak", "gym"] },
  { id: "fit-day", group: "fitness", name: "Which day", line: "Which program day is next, and staying on it.", go: "fitness", parent: "fitness", words: ["program", "day", "next", "lock", "gym"] },
  { id: "gym-reminder", group: "fitness", name: "Gym reminder", line: "Reminders and an alarm before gym time.", go: "fitness", parent: "fitness", words: ["gym", "alarm", "ring", "reminder", "gym time"] },
  { id: "fit-sound", group: "fitness", name: "Rest sound", line: "A sound and a card on the Mac when a rest ends.", on: MAC, go: "fitness", parent: "fitness", words: ["sound", "rest", "timer", "gym"] },

  // ---------- Sleep mode (V1.47: its own full screen settings, core/sleepsettings.ts, like Security) ----------
  { id: "sleep-settings", group: "sleep", name: "Sleep mode settings", line: "Alarms, wake styles, the clock and more, on a screen of their own.", go: "sleepSettings", words: ["sleep", "sleep mode", "night", "bed", "bedtime", "clock", "wake", "nightstand", "sleep settings"] },
  // Every Sleep setting, so the search here finds it and opens it in Sleep mode's own settings, lit up.
  ...SLEEP_ENTRIES.map((e): SetEntry => ({ id: `sleep.${e.id}`, group: "sleep", name: e.name, line: e.line, parent: "sleep-settings", go: "sleepSettings", ...(e.on ? { on: e.on } : {}), words: e.words })),

  // ---------- Sentry mode (V1.48, views/Sentry.tsx; the gear on the AI button opens it) ----------
  { id: "sentry-battery", group: "sentry", name: "Stop when battery is low", line: "At this level Sentry mode ends and your Mac locks.", on: MAC,
    words: ["sentry", "sentry mode", "ai", "battery", "low", "percent", "stop", "power", "charge", "unplugged", "lock"] },
  { id: "sentry-restart", group: "sentry", name: "Restart if not unlocked", line: "A Mac left locked in Sentry mode this long restarts by itself.", on: MAC,
    words: ["sentry", "sentry mode", "ai", "restart", "reboot", "bfu", "stolen", "theft", "thief", "timer", "hours", "auto restart", "unlock"] },
  // V1.52 (the developer): its own time when Sentry mode is turned on from Sleep mode's AI Sentry mode button (default 18 h).
  { id: "sentry-restart-sleep", group: "sentry", name: "Restart if not unlocked during Sleep mode", line: "The same restart when Sentry mode runs under Sleep mode. 18 h by default.", on: MAC,
    words: ["sentry", "sleep", "sleep mode", "night", "restart", "reboot", "bfu", "stolen", "timer", "hours", "auto restart", "unlock"] },
  { id: "sentry-lid", group: "sentry", name: "Keep awake with the lid closed", line: "On by default. Keeps AI jobs running with the lid shut.", on: MAC,
    words: ["sentry", "sentry mode", "ai", "lid", "closed", "clamshell", "shut", "bag", "awake", "sleep", "heat", "hot"] },
  // Auto approve (the developer's friend, 12 Nov 2026; views/AutoApprove.tsx, ps-mac AutoApprove.swift): in AI mode, Sleep mode or always.
  { id: "auto-approve", group: "sentry", name: "Auto approve", line: APPROVE_LINE, on: MAC,
    words: ["auto approve", "approve", "permission", "permissions", "prompt", "yes", "allow", "accept", "claude", "claude code", "codex", "terminal", "skip permissions", "dangerously", "ai mode", "sleep mode", "always", "hook", "keep going"] },

  // ---------- G Squad ----------
  { id: "gs-share", group: "gsquad", name: "What you share", line: "Choose what your squad can see. Anything off is never sent. Task sharing starts off.", words: ["squad", "friends", "share", "sharing", "leaderboard", "privacy", "group", "g squad", "task sharing", "share tasks", "money", "screen time", "working"] },
  // Open source build: PS joins The G Squad by itself unless this is Off (core/offswitches.ts, squad/autoengine.ts).
  { id: "gs-auto-join", group: "gsquad", name: "Join The G Squad automatically", line: "PS app joins The G Squad by itself after you sign in. Off: it never joins unless you press Join.", words: ["squad", "g squad", "join", "auto join", "automatically", "friends", "group", "off"] },
  // V1.58 multiple developers (views/FromTheSquad.tsx, core/features.ts): other people's shared features, each with a switch.
  { id: "squad-features", group: "gsquad", name: "From the squad", line: "Features your friends made and shared. Switch each one on or off.", words: ["squad", "g squad", "friends", "features", "shared", "from the squad", "switch", "extras", "add ons", "made by", "developers", "turn on", "turn off"] },
  { id: "gs-money", group: "gsquad", name: "Money you made", line: "Add last month's amount at the top of the Leaderboard. No pop-up asks for it.", go: "gsquad", words: ["money", "income", "earnings", "made", "amount", "last month", "revenue", "leaderboard"] },
  { id: "assist-requests", group: "gsquad", name: "Feature requests", line: "What you asked the assistant for that PS cannot do yet. Only your words go.", words: ["feature", "request", "idea", "suggest", "wish", "assistant", "bot", "squad"] },
  { id: "gs-open", group: "gsquad", name: "Open G Squad", line: "Your squad, the board and the chat.", go: "gsquad", words: ["squad", "friends", "leaderboard", "chat", "board", "rename", "squad name", "my name", "members"] },

  // ---------- This phone (V1.47: real rows, no more sheet) ----------
  { id: "phone-open", group: "phone", name: "Open your list from", line: "Quick Settings tile, quiet notification, home screen widget or bubble.", ...GOS_ONLY, words: ["widget", "tile", "bubble", "notification", "home screen", "shortcut", "open"] },
  { id: "phone-haptics", group: "phone", name: "Haptics", line: "A light tap when you tick, lift or drop a task.", on: PHONE, words: ["vibration", "vibrate", "buzz", "haptic", "feel"] },
  { id: "mweb-install", group: "phone", name: "Add to your Home Screen", line: "Opens full screen like an app and works offline.", ...MWEB_ONLY, words: ["install", "home screen", "app", "pwa", "add to home screen"] },
  { id: "phone-island", group: "phone", name: "Dynamic island", line: "A live island around the camera, over every app: meetings, Pomodoro, stand-ups, reminders, AI messages.", ...GOS_ONLY, words: ["island", "dynamic island", "pill", "camera", "overlay", "over other apps", "countdown", "pomodoro", "meeting", "stand up", "reminder", "ai message"] },
  { id: "phone-macs", group: "phone", name: "Your Macs", line: "Restart, shut down or lock your Macs from this phone.", ...GOS_ONLY, second: true, words: ["mac", "macs", "restart", "shut down", "lock", "remote", "second computer"] },
  { id: "phone-not-here", group: "phone", name: "Left on the Mac", line: "The keyboard tap, middle click, the mixer and AirPods switching stay on the Mac.", ...GOS_ONLY, more: true, words: ["keyboard", "mixer", "airpods", "middle click", "vpn", "network", "missing"] },

  // ---------- About and updates ----------
  { id: "phone-updates", group: "about", name: "Updates", line: "Check for a new version of PS app on this phone and install it.", ...GOS_ONLY, words: ["update", "upgrade", "install", "apk", "version", "new version", "download"] },
  { id: "updates", group: "about", name: "Updates", line: "Check for a new version and install it.", on: MAC, words: ["update", "upgrade", "version", "download", "install", "new version"] },
  // V1.54 (the developer, 12 Nov 2026): how often PS looks for a new version; one choice for every device (core/updateevery.ts).
  { id: "update-every", group: "about", name: "Check for updates every", line: "Minutes between looks for a new version. Off: no automatic looks, Check now still works.", words: ["update", "check", "how often", "minutes", "frequency", "interval", "delay", "new version", "every", "off", "automatic", "never"] },
  { id: "whats-new", group: "about", name: "What's new", line: "The changes in this version.", on: NOT_PHONE, words: ["changelog", "release notes", "changes", "news", "new"] },
  { id: "setup", group: "about", name: "Setup menu", line: "The few settings that matter, in plain words, one at a time.", on: MAC, words: ["welcome", "tour", "onboarding", "setup", "start"] },
  // V1.55 (the developer, 12 Nov 2026): the first use tips come once per account; this brings them back.
  { id: "tips", group: "about", name: "Tips", line: "Short tips about swiping between pages, the dots, Edit and reminders. They show once each.", words: ["tips", "show tips again", "hints", "tutorial", "help", "tour", "swipe", "learn"] },
  // Open source build: the tips can be switched off for good (views/Tips.tsx, core/offswitches.ts).
  // PS 1.65 (the developer's friend, 17 Nov 2026): the "where things live" tour (core/tour.ts) can be run again from here.
  { id: "tour-again", group: "about", name: "Show the tour again", line: "A short tour of where the new things live.", words: ["tour", "walkthrough", "where", "new", "whats new", "help", "tutorial", "show again", "intro"] },
  { id: "tips-show", group: "about", name: "Show first use tips", line: "Short tip cards the first few times you use PS app, and pop-ups about what is new. Off: none of them.", words: ["tips", "hints", "tutorial", "help", "first use", "off", "hide tips"] },
  { id: "examples", group: "about", name: "Example tasks", line: "Delete the example tasks PS app started your list with.", on: MAC, more: true, words: ["examples", "sample", "demo", "delete"] },
  // V1.44: the website's To-do page is the Tab list without what needs a Mac; this says where that lives.
  { id: "mac-app", group: "about", name: "Get the Mac app", line: "Hold Tab over any app for your list, plus the Dynamic Island, screen time and the AFK timer.", on: WEB, go: "macApp", words: ["mac", "download", "app", "install", "desktop", "tab", "island", "screen time", "afk", "mixer"] },
  { id: "version", group: "about", name: "Version", line: "Which version of PS app this is.", words: ["about", "version", "build", "number"] },
];

const BY_ID = new Map(SETTINGS.map((e) => [e.id, e]));
export const settingById = (id: string): SetEntry | undefined => BY_ID.get(id);
export const groupById = (id: GroupId): SetGroup => GROUPS.find((g) => g.id === id) ?? GROUPS[0];

/** Whether this person, here, sees this setting (its group too). */
export function visibleTo(e: SetEntry, ctx: Ctx): boolean {
  if (e.second && !secondAllowed()) return false;   // PS 1.65: Second Computer's switch (core/mailflag.ts, set by the vault)
  if (e.id === "second" && !SECOND_HERE) return false;   // a build without Second Computer's code has no row for it
  if (e.red && !ctx.red) return false;
  if (e.notRed && ctx.red) return false;
  if (e.mail && !ctx.mail) return false;
  if (e.mailCan && !ctx.mailCan) return false;
  if (e.sr && !ctx.sr) return false;
  if (e.pf && !ctx.pf) return false;
  if (e.ck && !ctx.ck) return false;
  if (e.te && !ctx.te) return false;
  if (e.shell && e.shell !== ctx.shell) return false;
  if (e.on && !e.on.includes(ctx.where)) return false;
  const g = groupById(e.group);
  return !g.on || g.on.includes(ctx.where);
}
/** The groups that have something for this person here, in menu order. */
export function groupsFor(ctx: Ctx, list = SETTINGS): SetGroup[] {
  return GROUPS.filter((g) => (!g.on || g.on.includes(ctx.where)) && list.some((e) => e.group === g.id && visibleTo(e, ctx)));
}
/** The rows of one group page: its settings this person sees, the ones drawn inside another left out. */
export function rowsOf(group: GroupId, ctx: Ctx, list = SETTINGS): { main: SetEntry[]; more: SetEntry[] } {
  const rows = list.filter((e) => e.group === group && !e.parent && visibleTo(e, ctx));
  return { main: rows.filter((e) => !e.more), more: rows.filter((e) => e.more) };
}
/** Where a search hit lands: the row that draws it (its parent, if it is drawn inside one). */
export function landingOf(e: SetEntry, list = SETTINGS): SetEntry {
  let cur = e;
  for (let i = 0; i < 4 && cur.parent; i++) {
    const p = list.find((x) => x.id === cur.parent);
    if (!p) break;
    cur = p;
  }
  return cur;
}

// ---------- search ----------
export interface Hit { e: SetEntry; score: number }
/** Every setting this person sees here that matches every typed word, best first. Searches the name, the one line,
 *  the other words for it and its group's name. */
export function searchSettings(q: string, ctx: Ctx, list = SETTINGS): Hit[] {
  const toks = tokensOf(q);
  if (!toks.length) return [];
  const whole = norm(q);
  const out: Hit[] = [];
  for (const e of list) {
    if (!visibleTo(e, ctx)) continue;
    const name = norm(e.name), line = norm(e.line), words = (e.words ?? []).map(norm), group = norm(groupById(e.group).label);
    let score = scoreOne(toks, whole, { name, line, words, group });
    if (score <= 0) continue;
    if (e.parent) score -= 0.3;   // the row itself before a piece inside it, when both match as well
    out.push({ e, score });
  }
  const order = (e: SetEntry) => GROUPS.findIndex((g) => g.id === e.group) * 1000 + list.indexOf(e);
  return out.sort((a, b) => b.score - a.score || order(a.e) - order(b.e));
}
