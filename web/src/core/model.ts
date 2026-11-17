// Decrypted document shapes. Everything here only ever exists in memory or as
// AES-256-GCM ciphertext; nothing in this file is sent to a server in the clear.
import type { Dnd } from "./dnd";
import type { Repeat } from "./repeat";
import type { Subtask } from "./subtasks";
import type { NumPerson } from "./numerology";
import type { MeetHide } from "./meethide";
import type { TrailPrefs } from "./trail";
import type { GymPrefs } from "./gym";
import type { SleepModePrefs } from "./sleepmode";
import type { NotchLook, PillLook } from "./islandlook";
import type { BgCrop } from "./bgcrop";

export type Kind =
  | "client" | "pprivate" | "todo" | "meeting" | "draft" | "settings" | "reply" | "brief" | "calendar" | "iemail" | "ithread" | "agenda" | "journal" | "quote" | "note" | "daylog" | "screentime" | "stline" | "cstats" | "cpage" | "fup" | "irep" | "msender" | "fprog" | "fwork" | "fit" | "psnote" | "tzperson" | "tzzones" | "tablayout" | "remind" | "fsleep" | "squad" | "squadask" | "squadjoin" | "fact" | "phonelayout" | "phonedev" | "rout" | "wachat" | "srec" | "srkey" | "sqpast" | "bgdev"   // owner private (vault key); bgdev: a device that opened PS, for backgrounds per device (core/devicebg.ts, PS 1.65); sqpast: one G Squad Past boards month, the owner publishes it to the squad (core/squadpast.ts, PS 1.64); srkey: the key that seals uploaded screen recordings, kept in the vault so every device can open them (core/recordings.ts, PS 1.60); srec: one screen recording's small details, never the media (core/recordings.ts, PS 1.60);  f*: Fitness (core/fitness.ts, fsleep: core/sleep.ts, fact: core/activity.ts); psnote: the developer's private release notes (core/privatenotes.ts); tzperson: Time zones people (core/tzpeople.ts); tzzones: your list of clocks (core/tzzones.ts); tablayout: the Tab list's Edit mode places (core/tablayout.ts); remind: the Annoying 15 min reminders and their answers (core/remind.ts); squad: your G Squad keys (core/squadrec.ts); squadask: your request to join a listed squad (core/squaddir.ts, older PS); squadjoin: your automatic join into The G Squad (core/squadauto.ts); phonelayout: a phone kind's own layout (core/phonelayout.ts); phonedev: a phone that opened PS (core/phonedevices.ts); wachat: one WhatsApp conversation per number, owner private (core/whatsapp.ts, PS 1.60); rout: a reply typed in the email panel on its way to a Mac that sends it (core/inlinereply.ts, V1.59)
  | "rcpt"  // A receipt (PS 1.65): one per receipt, owner private (vault key), the photo is a separate sealed file (core/receipts.ts)
  | "ttime"   // Time spent (PS 1.65): the task clocks now and, one per month, what each finished task really took, owner private (vault key), never sent to the squad (core/timeest.ts)
  | "mhist"   // Month history (PS 1.65): your own earnings and the leaderboards as you saw them, one record per month, owner private (vault key), never sent to the squad (core/monthhist.ts)
  | "rwd"   // Rewind (PS 1.64): the private yearly recap history, one record per day and per year, owner private (vault key), never read back before 1 January (core/rewind.ts)
  | "sdev" | "spair" | "sjob" | "sjobst" | "smsg" | "sfile" | "sack" | "sstat" | "scmd" | "sidx" | "sget" | "sgot" | "sbudget" | "sojob" | "sores"   // Second Computer (core/second.ts), owner private (vault key)
  | "wsmeta" | "project" | "ctask" | "tick" | "update" | "approval"     // shared with one client (workspace key)
  | "doc";                                                               // a file attached to a project (same scope as the project)

export interface Doc<T = any> {
  id: string;
  ws: string | null;      // null = owner private
  kind: Kind;
  data: T;
  author: string | null;
  updatedAt: string | null;
  pending?: boolean;      // not yet synced
}

export type Pipeline = "lead" | "proposal_sent" | "signed" | "in_build" | "client_review" | "live" | "cro" | "finished";
export const PIPELINE: { key: Pipeline; label: string }[] = [
  { key: "lead", label: "Lead" },
  { key: "proposal_sent", label: "Proposal sent" },
  { key: "signed", label: "Signed" },
  { key: "in_build", label: "In build" },
  { key: "client_review", label: "Client review" },
  { key: "live", label: "Live" },
  { key: "cro", label: "CRO retainer" },
  { key: "finished", label: "Finished" },
];

export type ProjectType = "shopify_redesign" | "cro_retainer" | "amazon_a_plus" | "amazon_brand_store" | "video" | "custom";
export const PROJECT_TYPES: { key: ProjectType; label: string }[] = [
  { key: "shopify_redesign", label: "Shopify redesign" },
  { key: "cro_retainer", label: "CRO retainer" },
  { key: "amazon_a_plus", label: "Amazon A+ content" },
  { key: "amazon_brand_store", label: "Amazon Brand Store" },
  { key: "video", label: "Video" },
  { key: "custom", label: "Custom project" },
];
export const typeLabel = (t: ProjectType) => PROJECT_TYPES.find((x) => x.key === t)?.label ?? "Project";

export type Gate = "direction" | "design" | "launch" | "review" | null;
export const GATE_LABEL: Record<string, string> = {
  direction: "Direction chosen",
  design: "Design approved",
  launch: "Launch approved",
  review: "Approved",
};

export interface Preview {
  id: string;
  label: string;
  url: string;
  note?: string | null;
  addedAt: string;
  expiresAt?: string | null; // Shopify theme previews die after about 2 days
}

export interface Stage {
  key: string;
  name: string;
  info?: string | null;          // client facing description
  start?: string | null;
  due?: string | null;
  doneAt?: string | null;
  clientAction?: string | null;  // when set, this stage waits on the client (amber)
  gate?: Gate;                   // the client approves with a date stamp
  previews: Preview[];
}

export interface Payment {
  id: string;
  label: string;
  amount: number;
  currency: string;
  due?: string | null;
  status: "paid" | "owed" | "upcoming";
  paidAt?: string | null;
}

export interface Proposal {
  url?: string | null;
  sentAt?: string | null;
  signedAt?: string | null;
  price?: number | null;
  currency?: string | null;
  scope: string[];
  timelineText?: string | null;
  status?: "draft" | "sent" | "accepted" | "superseded" | "declined" | null;
  // Every document for this proposal: the live Google Doc, the designed PDF, older versions.
  links?: { label: string; url: string; kind?: "live" | "pdf" | "superseded" | "other"; date?: string | null }[];
  splitText?: string | null;     // eg "50% before ($1,250), 50% after ($1,250)"
  afterLaunch?: string | null;   // aftercare promised, eg "30 days free fixes, then CRO $1,500 a month"
  priceUnit?: "month" | "video" | null;  // price is per month or per video; empty = one fee
}

export interface DeliveryChange { from: string | null; to: string | null; reason?: string | null; at: string }

export interface Project {
  title: string;
  type: ProjectType;
  pipeline: Pipeline;
  stages: Stage[];
  current: number;               // index of the stage in progress; stages.length = all done
  nowLine?: string | null;       // the human line on the big "right now" card
  nowWindow?: string | null;     // expected time window, eg "Wed 21 to Fri 23 Oct"
  status?: "on_track" | "at_risk" | "action_needed" | null;
  startDate?: string | null;
  startsMonth?: string | null;   // "YYYY-MM": signed but the money starts later (eg CRO from go-live)
  promisedDelivery?: string | null;
  originalDelivery?: string | null;
  deliveryChanges: DeliveryChange[];
  proposal: Proposal;
  payments: Payment[];
  liveUrls: string[];
  croLadder?: { label: string; price: string }[];
  archived?: boolean;
  clientVisible?: boolean;       // false = hidden from the client
  // Hidden projects are stored in the owner's private scope (vault key), never under the
  // client's key, and point back to the client's workspace here.
  clientWs?: string | null;
}

export interface ProjectPrivate {
  projectId: string;
  nextStep?: string | null;
  nextDue?: string | null;
  waitingOn?: "me" | "client" | null;
  waitingWhat?: string | null;
  waitingSince?: string | null;
  nextInvoiceDate?: string | null;
  notes?: string | null;
  history: { date: string; text: string }[];
}

export type ClientStatus = "client" | "pending" | "prospect" | "lead" | "past";
export const CLIENT_STATUSES: { key: ClientStatus; label: string; hint: string }[] = [
  { key: "client", label: "Clients", hint: "Paying clients you are working with now" },
  { key: "pending", label: "Pending", hint: "On hold, waiting for them to decide or come back" },
  { key: "prospect", label: "Prospects", hint: "Had a call or got a proposal, not signed yet" },
  { key: "lead", label: "Leads", hint: "Early conversations" },
  { key: "past", label: "Past", hint: "Finished, nothing running now" },
];

export type Service = "shopify" | "cro" | "amazon" | "other";
export const SERVICES: { key: Service; label: string }[] = [
  { key: "shopify", label: "Shopify redesign" },
  { key: "cro", label: "CRO" },
  { key: "amazon", label: "Amazon" },
  { key: "other", label: "Other" },
];
export function serviceOf(type: ProjectType): Service {
  if (type === "shopify_redesign") return "shopify";
  if (type === "cro_retainer") return "cro";
  if (type === "amazon_a_plus" || type === "amazon_brand_store") return "amazon";
  return "other";
}

export interface ClientRec {
  name: string;
  status?: ClientStatus | null;  // which tab they live in; derived from projects when unset
  order?: number | null;         // The developer's manual order (lower = higher up)
  ws: string;                    // the client's workspace id (its own encryption key)
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;         // WhatsApp: a message from this number shows on this client (core/whatsapp.ts matchClient)
  phones?: string[];             // more numbers of the same client
  greetingName?: string | null;
  timezone?: string | null;      // IANA zone, eg "America/New_York"
  matchAddrs?: string[];         // extra addresses or domains their Gmail replies come from (private)
  notes?: string | null;
  createdAt: string;
  archived?: boolean;
  invitedAt?: string | null;
  // Their login (door button): the link plus three set words. Kept here, in the developer's private records,
  // so he can always look them up again; the client never has to change them.
  portal?: { link: string; words: string; user: string; createdAt: string; expiresAt: string } | null;
}

export interface WsMeta { clientName: string; greetingName?: string | null; ownerName?: string | null } // ownerName: set only by owners other than the developer
export interface CTask { projectId: string; title: string; detail?: string | null; due?: string | null; order?: number }
export interface Tick { taskId: string; done: boolean; at: string; by?: string | null }
export interface Update {
  projectId: string;
  date: string;
  title: string;
  bullets: string[];
  body?: string | null;
  status?: "on_track" | "at_risk" | "action_needed" | null;
}
export interface Approval { projectId: string; stageKey: string; gate: string; at: string; by: string; note?: string | null }

/** A new task (Claude suggests it, or the developer texted it to his Telegram bot). Nothing joins the list until the developer accepts it in New tasks. */
export interface Suggestion {
  id: string;
  title: string;
  type: "daily" | "once";
  due?: string | null;
  clientId?: string | null;
  note?: string | null;          // what Claude did or why it suggests it
  claudeDone?: boolean;          // Claude already did it: it joins the list with a purple tick
  asap?: boolean;                // urgent: accepting it puts it on Urgent (settings.aware) instead of the list
  from?: "telegram" | null;      // where it came from (none = Claude)
  zone?: DimxZone | null;        // a Dimension X band the developer named ("AT Upside Down ..."): accepting puts it there
  createdAt: string;
}

/** A goal on the goals timeline (Macro: the big ones, Meso: month by month, Micro: week by week). */
export interface Goal {
  id: string; title: string; level: "macro" | "meso" | "micro";
  start: string; end: string;    // YYYY-MM-DD, both days included
  color: string; note?: string | null; done?: boolean; createdAt: string;
}

export interface AwayEntry { s: number; e: number; reason: string; back?: number }   // back: AFK timer, first input after it started (seconds); e is the "Back in the game" click

export interface Todo {
  title: string;
  createdAt?: string;
  type: "daily" | "once";        // daily = repeating: stays forever, reset only unticks it
  repeat?: Repeat | null;        // how often a repeating task comes back (none = every day), see core/repeat.ts
  streak?: number;               // repeating tasks: rounds in a row it was done (gold number from 2)
  streakTicked?: boolean;        // this round's tick is already in the streak
  bestStreak?: number;
  done: boolean;
  doneAt?: string | null;
  due?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  notes?: string | null;
  source?: "manual" | "fireflies" | "project" | null;
  order: number;
  clearedAt?: string | null;     // removed by a reset (kept for undo and history)
  claudeDoneAt?: string | null;  // Claude finished this in a chat: shown as a purple tick until the developer ticks it
  claudeNote?: string | null;    // what Claude did, eg "CLIENTSIX MOOD AI agents proposal created"
  pushes?: number;               // how many times the date was pushed back
  p1?: boolean;                  // in the Priority 1 group at the top of the Tab list (optional: none is fine), see core/prio.ts
  unranked?: boolean;            // no priority yet: shows no P number and sits below the numbered tasks until dragged among them (core/prio.ts)
  subtasks?: Subtask[];          // mini tasks under it, in order (the developer, 24 Oct 2026), see core/subtasks.ts
  example?: boolean;             // one of the made up example tasks a new account starts with (core/examples.ts): "Delete all example tasks" removes it
  group?: string | null;         // in one of the developer's task groups (settings.tmGroups) instead of Priorities or Every day (the developer, 29 Oct 2026), see core/groups.ts
  sqOff?: boolean;               // G Squad (V1.40): Not shared, the squad never gets a copy (core/squadshare.ts)
  sqOn?: boolean;                // G Squad (V1.43): Share with G Squad, the only way a task is shared (needs the Tasks switch on too)
  p1At?: string | null;          // G Squad Priority 1 (PS 1.63): when it became Priority 1 (ISO), the 24 hour clock starts here; set by core/squadp1.ts p1Stamps, cleared when it leaves P1
  sqAnon?: boolean | null;       // G Squad: true = the squad sees "Client task", false = the real title; unset = not asked yet (core/squadanon.ts)
  ai?: boolean;                  // Task API: an AI on this Mac added it (the small AI marker, kept wherever it goes), core/aiinbox.ts
  aiInbox?: boolean;             // Task API: still in the AI Inbox (Dimension X), on no list yet; moving it anywhere clears it
  est?: number | null;           // Time estimate (PS 1.65, core/timeest.ts): minutes, 1 to 1440; none = no estimate
  estBy?: "past" | null;         // the estimate came from the past times of tasks with this name ("Usually takes about"), not typed or picked
}

export interface Meeting {
  title: string;
  date: string;
  clientId?: string | null;
  url?: string | null;
  overview?: string | null;
  actionItems: string[];
  bullets?: string | null;
  participants?: string[];
  source: "fireflies" | "manual";
  addedToTodo?: string[];        // action items already copied to the to-do list
  ffId?: string | null;          // Fireflies transcript id, so a call is never added twice
}

/** The developer's Google Calendar, as one snapshot from the calendar-inbox function. Owner private. */
export interface CalAttendee { email: string; name?: string | null; rsvp?: string | null; self?: boolean; organizer?: boolean }
export interface CalEvent {
  id: string; title: string; start: string | null; end: string | null; allDay: boolean;
  link?: string | null; place?: string | null; open?: string | null; attendees: CalAttendee[];
  /** V1.55: the Mac Calendar account it comes from (ps-mac LocalCalendar.swift), so a Meetings panel can show one. */
  acct?: string | null;
  /** The calendar of the Mac's Calendar app it comes from (its identifier), so a calendar can be set to Meetings, Show only or Off (core/calpick.ts). None: a meeting. */
  cal?: string | null;
}
export interface CalendarSnap { account: string; at: string; from: string; to: string; events: CalEvent[]; /** The Mac's calendars: names and colours only (core/calpick.ts). */ cals?: import("./calpick").CalInfo[] }

/** One email from the Instantly Unibox, kept forever in the vault (owner private). */
export interface IEmail {
  iid: string;                   // Instantly email id (never stored twice)
  threadId?: string | null;
  at: string;                    // when the email was sent
  type: "received" | "sent" | "manual";
  from: string; fromName?: string | null;
  to?: string | null;
  account: string;               // the Instantly inbox it belongs to
  subject: string;
  text: string;                  // plain text body (HTML is never kept)
  unread?: boolean;
  campaignId?: string | null;
  lead?: string | null;
}

/** A quote pinned at the top of the To-do page. */
export interface Quote { text: string; author?: string | null; order?: number; createdAt: string }

/** A note in the notes window (Apple Notes style). The body is simple HTML from the editor,
 *  cleaned to a short list of safe tags before it is shown. Deleting moves it to Recently deleted. */
export interface Note { title: string; html: string; createdAt: string; updatedAt: string; pinned?: boolean; deletedAt?: string | null }

/** An agenda on the To-do page: what the developer is focused on right now. Several can run at once. */
export interface Agenda {
  title: string;
  note?: string | null;
  startedAt: string;             // YYYY-MM-DD
  endedAt?: string | null;       // set when it moves to "Past agendas"
  order?: number;
}

/** The series map: a title and a note per month ("m:2026-10"), week ("w:2026-10-12", the Monday)
 *  or day ("d:2026-10-15"). One record per key, owner private. */
export interface JournalEntry { key: string; title?: string | null; note?: string | null; updatedAt?: string }

/** One Instantly conversation (a thread the lead replied to), in full, from instantly-inbox. */
export interface IMsg {
  iid: string; at: string | null; type: "received" | "sent" | "manual";
  from: string; fromName?: string | null; to?: string | null; account: string;
  subject: string; text: string; unread?: boolean;
}
export interface IThread {
  threadId: string; subject: string; lead: string; leadName?: string | null; account: string;
  lastAt: string | null; unread: boolean; messages: IMsg[];
}

/** A client's reply in one Gmail thread (from the gmail-inbox function). Owner private. */
export interface Reply {
  clientId: string;
  account: string;               // the Gmail account it came to
  threadId: string;
  msgIds: string[];              // Gmail message ids already counted (latest 50)
  lastKey?: string;              // the newest email's identity, its Message-ID (core/maildedupe.ts messageKey): what a notification is keyed by
  from: string;                  // sender address of the latest message
  fromName?: string | null;
  subject: string;
  snippet: string;               // Gmail's short preview
  opening?: string | null;       // the first few sentences of the body (no quotes, no signature)
  replyFrom?: string | null;     // the send-as address of the account the latest email was addressed to (a reply goes From it)
  date: string;                  // latest message from them
  count: number;
  handled: boolean;
  handledAt?: string | null;
  handledHow?: "you" | "replied" | null;  // marked by hand, or the developer answered in Gmail
  seenAt?: string | null;        // the email (its date) whose pop-up card the developer dismissed; a newer one shows a card again
  remindAt?: string | null;      // "Remind me in": the card stays away until then (core/mailcards.ts)
  remindFor?: string | null;     // the email (its date) that remind was set on; a newer one shows the card at once
}

export interface Draft {
  clientId: string;
  projectId?: string | null;
  template: string;
  to?: string | null;
  subject: string;
  body: string;
  status: "draft" | "approved" | "sent";
  approvedAt?: string | null;
  approvedText?: string | null;  // the exact words that were approved
  sentAt?: string | null;
}

/** A Claude Code chat that finished a turn (core/chatdone.ts). Its name only, never what it did. */
/** Instantly reply cards (core/leadcards.ts): only replies after `since`; per thread, the reply dismissed and a remind. */
export interface LeadCardState { since: string; seen?: Record<string, string>; remind?: Record<string, { at: string; for: string }> }

export interface ChatDone {
  id: string; chat: string; at: string; seen?: boolean; remindAt?: string; tool?: AiTool;
  /** V1.57: the person's last real prompt in that chat (PS on the Mac reads it from a Claude Code transcript). The same
   *  chat ending another turn with the same prompt is the same finish: no new card (core/chatdone.ts sameFinish). */
  turn?: string;
  /** V1.57: the newest finish of this chat that was folded into this card (a repeat within CHAT_DONE.repeat). */
  last?: string;
}
/** Which AI tool a finished chat came from (core/chatdone.ts AI_TOOLS). None means Claude Code (every card before V1.53). */
export type AiTool = "claude" | "codex" | "gemini" | "cursor";

/** V1.58: a message an AI on this Mac sent to the island through the Task API (core/aimessage.ts). Plain text only. */
export interface AiMsg {
  id: string; from: string; text: string; detail?: string;
  /** The chat it came from, as the AI tool names it (Claude Code's session id): its plain finished card is then not shown. */
  chat?: string;
  at: string; seen?: boolean; remindAt?: string;
}
/** V1.58: what pops up when an AI chat ends (core/aimessage.ts AI_NOTES). None means "messages". */
export type AiNotes = "messages" | "plain" | "off";

/** A named group of tasks in the Tab list (the developer, 29 Oct 2026), see core/groups.ts. */
export interface TaskGroup { id: string; name: string }

export interface Settings {
  squadShare?: import("./squadshare").ShareOpts;   // G Squad (V1.40): what you share, one switch per piece (missing = on, except Tasks: missing = off since V1.43)
  receipts?: boolean;   // Settings, "Receipts and Purchases": false = off (core/receipts.ts receiptsOn; missing = on, PS 1.65)
  receiptCur?: string;   // the currency a new receipt starts with (missing = GEL)
  rewind?: import("./rewind").RwPrefs;   // Settings, Privacy and sharing, "Rewind (yearly recap)": missing = on; since = nothing before it is collected (core/rewind.ts, src/rewind.ts, PS 1.64)
  squadMoney?: import("./squadboard").SquadMoney;   // G Squad Leaderboard (V1.40): your monthly money answers, their time zone and snooze (core/squadboard.ts)
  squadP1Show?: boolean;         // G Squad Priority 1 (PS 1.63): show the squad's Priority 1 tasks in the Tab list's side panel (missing = on)
  squadNotify?: boolean;         // G Squad message notifications (PS 1.60, core/squadnotify.ts): pop up card with Reply (missing = on)
  squadNotifySound?: boolean;    // the sound with that card (missing = on)
  squadNoteIsland?: boolean;     // PS 1.63: on the Mac the message comes out of the Dynamic Island (core/squadnotify.ts noteIsland, missing = on)
  squadNoteSeen?: string;        // dismissed or replied up to this message time (ISO): the other devices drop their cards too
  squadChatSound?: boolean;      // G Squad chat (V1.40): a short sound for new messages, Mac only (missing = off, the developer)
  radar?: { handled?: Record<string, string>; snoozed?: Record<string, string> };   // Follow-up Radar marks (core/radar.ts)
  ownerName: string;
  updateEvery?: number;            // minutes between looks for a new version: 5, 10, 15 or 30, 0 = Off (no automatic looks), missing = 5 (V1.54, core/updateevery.ts)
  squadAutoJoin?: boolean;         // Settings, G Squad, "Join The G Squad automatically": false = PS never joins by itself (open source build; missing = on)
  taskHistory?: boolean;           // Settings, Privacy and sharing, "Fuller task history": false = no new missed, added, deleted or Dimension X notes in the day log, and the Map hides them (core/taskhist.ts; missing = on, PS 1.65)
  psPresence?: boolean;            // Settings, Privacy and sharing, "Tell the website PS app is open": false = no ps-presence channel (src/ps.ts; missing = on)
  tipsShow?: boolean;              // Settings, About and updates, "Show first use tips": false = no tip cards (views/Tips.tsx; missing = on)
  replyInPanel?: boolean;          // Settings, Notifications, "Reply in the email panel" (V1.59, core/inlinereply.ts; missing = on)
  assistant?: { on?: boolean; pop?: boolean };   // Settings, Settings assistant (PS 1.65, core/assist.ts): the bot on (missing = on) and pop out when Settings opens (missing = on)
  timeEst?: Partial<import("./timeest").TePrefs>;   // Settings, Your list (PS 1.65, core/timeest.ts): Time estimates, Time spent, Too much planned (each missing = on) and the working hours (missing = 09:00 to 17:00)
  estWarnDay?: string | null;      // the day ("YYYY-MM-DD") the "You've planned 9 h with 5 h free" line was closed, used or went by itself, so it never comes twice that day
  chkRemind?: { on: boolean; every: number; sound: boolean };   // Settings, Checklist Reminder (PS 1.65, core/chkremind.ts): on (missing = on), minutes between pop-ups (30 to 720, missing = 120), a soft chime (missing = on)
  swipeInvert?: boolean;           // Settings, Controls, "Invert swipe" (V1.57): true flips every page swipe (core/lists.ts swipeSign; missing = off)
  autoLockMin: number;
  autoReset: "off" | "midnight";   // "midnight" = the automatic Reset is on, at autoResetAt (the name stays for older builds)
  autoResetAt?: string;            // "HH:MM" in your zone, missing = "00:00" (core/resetday.ts, 8 Nov 2026); your day starts then too
  lastResetAt?: string | null;
  lastResetDay?: string;           // the day (by autoResetAt) the last Reset belongs to, so it never runs twice for one day
  dayEndsHour?: number;          // a Reset before this hour counts for the day before (night shifts), default 15
  // eodAsk, eodAt, eodSnoozeMin, eodSnoozedUntil: the "Shall I end my day now?" prompt, removed 2 Nov 2026 (old copies may still carry them; nothing reads them)
  theme: "system" | "light" | "dark";
  birthday?: string | null;      // "YYYY-MM-DD", for the personal year, month and day on Today
  tmNumPeople?: NumPerson[];     // Tab list Numerology: the people the developer reads numbers for (core/numerology.ts), "me" first
  workingOn?: string | null;     // first of workingIds (kept for older builds)
  workingIds?: string[];         // the to-dos the developer is working on right now, several at once (each glows white)
  tmScale?: number;              // Tab list task size, percent (default 85)
  tmSound?: number;              // Tab list hover and click sounds, volume percent (0 = off, default 40)
  agentId?: string | null;        // Claude's account, trusted in client workspaces (Settings > Claude access)
  agentInvites?: string[];        // invites made for Claude that it has not used yet
  ownerInviteNotes?: Record<string, string>; // The developer only: who each "Invite someone" link was for (kept encrypted here, never on the server)
  agentSince?: string | null;
  tmHeadline?: string;           // Tab list headline (click it to change it), default "Mission agenda"
  tmMuted?: boolean;             // Tab list sounds muted (the speaker button top right)
  tmClockScale?: number;
  tmHomeTz?: string | null;      // "your" time zone for the Tab list clocks (empty = this device's zone)         // Tab list time zone clocks size, percent (default 100)
  aware?: AwareItem[];
  rules?: { id: string; text: string; createdAt: string }[];   // The developer's rule book (core/rules.ts): the end of day check, in his own order
  dimx?: DimxItem[];             // Dimension X planning screen (Tab list, purple X): array order is the order on screen
  suggestions?: Suggestion[];
  tgBot?: import("./tgbot").TgBotPrefs;   // Add Telegram Bot (V1.47, core/tgbot.ts): the start word and the linked chat, never the bot's key
  mailRules?: import("./mailrules").MailRules;   // Gmail: Always notify me and Muted, beside client emails (core/mailrules.ts)
  mailCardsSince?: string | null;  // client email cards that stay until dismissed: only mail newer than this (set once)
  wa?: import("./whatsapp").WaPrefs;   // WhatsApp settings: on, notify, sound, mark as read, muted and always lists (core/whatsapp.ts, PS 1.60)
  mailReply?: import("./mailreply").MailReplyPrefs;   // Reply from PS: signatures and saved responses (core/mailreply.ts, V1.44)
  leadCards?: LeadCardState;      // Instantly reply cards in PS: when they started, dismissed and reminded (core/leadcards.ts)
  chatFade?: number;               // V1.55: seconds an AI chat card stays before it goes by itself (core/chatdone.ts chatFade: 10 unless set, 0 = it stays)
  chatDone?: ChatDone[];           // Claude Code chats that just finished a turn (core/chatdone.ts): a card each until dismissed
  aiMsgs?: AiMsg[];                // V1.58: messages AIs sent to the island (core/aimessage.ts): a card each until dismissed
  aiNotes?: AiNotes;               // V1.58: AI messages (default), plain finished cards only, or neither (core/aimessage.ts)
  meetAlerts?: { booked: boolean; msg: boolean; soon: boolean; privacy: boolean; sBooked: boolean; sMsg: boolean; sSoon: boolean;
    notes?: boolean; notesAfter?: number; notesSnooze?: number[]; notesBlur?: boolean };  // PS meeting alert cards (gear menu)
  tmInboxMinAt?: string | null;  // when the developer last minimized the New tasks pop-up; newer suggestions open it big again
  tmWorkStyle?: string;          // the Working on look (core/looks.ts WORK_STYLES), default "white"
  gosLayout?: "compact" | "cards" | "focus" | "simple";   // PS GOS only: how the phone draws the list (src/gos/layout.ts), picked in the phone settings
  tmP1Style?: string;            // the look of the Priority 1 group's outline (core/prio.ts P1_DESIGNS), default red glisten
  p1Color?: string | null;       // one colour for every Priority 1 task, "#rrggbb" (core/prio.ts p1Tones, the developer 2 Nov 2026). Unset = the look as before
  tmBg?: string;                 // the screen wide background behind the Tab list (core/prio.ts BG_DESIGNS), default none
  tmBgIntensity?: number;        // lightning backgrounds: how bright and branchy (0 to 100, default 60)
  tmBgFrequency?: number;        // lightning backgrounds: how often (0 to 100, default 40)
  tmBgSound?: boolean;           // thunder and crackle with the lightning (default off)
  tmBgVolume?: number;           // their volume (0 to 100, default 40)
  tmBgVideoBright?: number;      // The developer's own background video: how bright (0 to 100, default 100), core/bgbright.ts
  tmBgPhone?: string | null;     // the phone's own background (PS GOS and the iPhone web app); unset or null = Same as my Mac (tmBg), core/bgcrop.ts
  tmBgDev?: Record<string, { b: string | null; t: number }>;   // a background for each device (device id -> pick; null = removed), PS 1.65, core/devicebg.ts. A device with no pick shows tmBg as before
  tmBgCrop?: Record<string, BgCrop>;   // how each background fits a phone (Fill or Fit, focus point, zoom, bars), core/bgcrop.ts
  tmRain?: string;               // rain over the Tab list (core/rain.ts RAIN_KINDS): off (default), drizzle, steady, windy, storm, glass (V1.40)
  tmRainAmount?: number;         // how much rain falls, 0 to 100 (default 50)
  tmTrail?: TrailPrefs;          // the Mouse trail over the tasks (core/trail.ts, V1.43): the effect, Burst on click, each effect's colour, size, intensity. Unset = Glow
  tmSubOpen?: string[];          // tasks whose mini tasks are shown expanded (PS and the website), see core/subtasks.ts
  tmDailyFirst?: boolean;        // the Tab list: "Every day" dragged above the main tasks (the developer, 23 Oct 2026). Default below
  island?: { mode: "notch" | "pill" | "off"; idle: "next" | "none"; pill?: PillLook; notch?: NotchLook; hide?: number; cards?: boolean; top?: string[] };   // hide: seconds a click on the grab line hides it (V1.40, 60 unless set); cards: the Mac's notification cards come out of the island (V1.55, on unless false)| "pill" | "off"; idle: "next" | "none"; pill?: PillLook; notch?: NotchLook };   // pill, notch: their looks (core/islandlook.ts)   // PS Dynamic Island (core/island.ts): around the notch, a pill below it, or off; what shows when nothing is in progress
  pomodoro?: Partial<import("./pomodoro").PomoPrefs>;   // Pomodoro (core/pomodoro.ts, V1.58): the button on or off, work and break lengths, sessions before a long break, auto start, sound, time left on the island
  pomoRun?: import("./pomodoro").PomoRun | null;         // the Pomodoro running now, by wall clock end times (survives a restart, sleep and a lock); null when stopped
  posture?: Partial<import("./posture").PosturePrefs>;   // Posture Reminder (core/posture.ts, PS 1.65): on, how often, from and to times (missing = on, every 45 minutes, 09:00 to 18:00)
  standup?: Partial<import("./standup").StandPrefs>;   // Stand-up reminders (core/standup.ts, V1.58): on, how often, how long, sound, active hours
  meetBubble?: Partial<import("./meetbubble").MeetBubblePrefs>;   // the next meeting bubble on the island (core/meetbubble.ts, V1.58): on, minutes before
  pomoIntro?: boolean;           // the first Pomodoro card (it recommends the Dynamic Island) was answered
  welcomeBack?: Partial<import("./welcomeback").WelcomePrefs>;   // Welcome back on the Mac island after being away (core/welcomeback.ts, PS 1.60): on, minutes
  workoutMac?: Partial<import("./workoutsummary").SummaryPrefs>;   // Workout summary on the Mac after a workout on the phone (core/workoutsummary.ts, PS 1.60): on
  postureAsk?: boolean;          // PS 1.65: the first posture pop-up's question ("Do you want to turn the posture reminder off?") was seen; asked once per person
  standAsk?: boolean;            // V1.59: the first stand-up's question ("Do you want to turn stand-up reminders off?") was seen; asked once per person
  dnd?: Dnd;                     // PS Do Not Disturb (core/dnd.ts, the developer 30 Oct 2026): the moon top right of the Tab list; muted cards are held, never lost
  calChoices?: import("./calpick").CalChoices;   // which of the Mac's calendars are Show only or Off (core/calpick.ts, 15 Nov 2026); unlisted = Meetings
  meetHidden?: MeetHide[];       // meetings the developer took off the Meetings panel (core/meethide.ts, the developer 2 Nov 2026): PS only, his calendar is never touched
  sentry?: import("./sentry").SentryPrefs;   // Sentry mode (core/sentry.ts, V1.48): screen dim or off, stop at low battery, lid closed, the warning seen
  sleepMode?: SleepModePrefs;    // Sleep mode (core/sleepmode.ts, V1.40): the button, alarms, counts only or full details, the panel, asking to log
  gym?: GymPrefs;                // the gym reminder (core/gym.ts): time, days, on/off, set in Fitness settings. Default every day at 08:00
  gymAck?: string[];             // gym days acknowledged on the Mac or the phone ("2026-11-03"): the ring stops, the card goes
  newBadges?: boolean;           // the NEW badge on fresh tasks (core/newbadge.ts, V1.33): false = off everywhere. Default on
  newBadgeMin?: number;          // how long a task shows NEW, minutes (5 to 240, default 30)
  newGone?: Record<string, number>;   // badges the developer clicked away: task id to its created time in seconds (pruned after 240 minutes)
  tmTickMode?: "completed" | "vanish";   // To do list behaviour (core/completed.ts, V1.34): a ticked one-off moves to Completed (default) or just leaves the list
  tmAudio?: import("./audiomode").AudioPrefs;   // Headphones mode (core/audiomode.ts, V1.40 to 1.64), no longer used: PS 1.65 Audio priority keeps its order on each Mac (Sources/AudioPriority.swift, moved over from that Mac's copy). Kept so an older PS still reads it
  tmShowDone?: boolean;          // the Completed section at the bottom of the Tab list: false hides it. Default shown
  tmTickSound?: "classic" | "pop" | "sparkle" | "marimba" | "rise" | "bell" | "off";   // the sound a tick makes (core/ticksound.ts, V1.34). Default classic
  tmAddColor?: string | null;    // the Add task button's colour, #rrggbb (core/addbutton.ts, V1.34). Unset = Mint
  tmAddAnim?: "spin" | "pop" | "bounce" | "pulse" | "none";   // its click animation. Default spin (a 360)
  tmOverdue?: import("./overduelook").OverdueLook | null;   // the Overdue card: background and text colour (#rrggbb or null) and an effect (core/overduelook.ts, V1.44). Unset = as before
  tmTypedPrio?: boolean;         // P1, P2 or P3 typed in a new task sets its priority (core/typedprio.ts, V1.40). false = off. Default on
  tmNlRemind?: boolean;          // PS 1.65 dates in plain words (core/nldates.ts): a typed time ("tomorrow 9am") also puts a reminder on the task. false = off. Default on
  noteLook?: import("./notelook").NoteLookPrefs | null;   // notification cards per kind: colour, sound on, which sound (core/notelook.ts, V1.36). Unset = as before
  tmDoneKeep?: "today" | "7d" | "30d";   // how long Completed keeps ticks: since the start of today in the developer's zone (default), 7 or 30 days
  privateMode?: boolean;         // PS (V1.57: every Mac pop up is a small pill with no sound, ps-mac PrivateCore.swift): notification cards hide names and words (the mask on the Meetings panel, or Yes to "Start private mode?"), until the developer turns it off (the developer, 29 Oct 2026)
  tmSecOrder?: string[];         // the Tab list's sections top to bottom: "p1", "prio", "daily" and "g:<group id>" (the developer, 29 Oct 2026), see core/groups.ts
  tmGroups?: TaskGroup[];        // The developer's own task groups in the Tab list, made by dragging Cmd-selected tasks out (the developer, 29 Oct 2026)
  tmPages?: import("./lists").ListPage[];   // V1.55: the developer's extra to-do lists, each a page of sections he swipes to (core/lists.ts). Unset = the main list only
  tmPageOrder?: string[];        // V1.55: the pages left to right, "main" among them (lists on both sides of home), core/lists.ts
  tmNames?: import("./lists").ListNames;    // V1.55: the main list's and the built-in sections' own names (Priorities and the rest). Unset = as before
  tmSwipeDir?: import("./lists").SwipeDir;  // V1.55: a two finger swipe to the right goes to the list on the right (push, default) or brings the left one (drag)
  looksSaved?: import("./looksprofiles").LooksStore;   // V1.56 Saved looks: the Edit overview's whole setup saved by name, per device kind (mac, gos, ios), core/looksprofiles.ts and core/maclook.ts
  secondCodeJobs?: boolean;      // PS 1.65 Second Computer, Outsource, "Code jobs" (core/secondcode.ts): true = code jobs may be sent and run. Missing = off
  editSounds?: boolean;          // V1.56 "Edit mode sounds" (core/editsounds.ts): false = the Edit overview makes no sounds. Missing = on
  tmTheme?: "dark" | "light";    // the Tab list's theme (More settings; light for bright sun). Default dark
  tmNotebook?: string;           // a paper Notebook look for the Tab list (core/notebook.ts NB_DESIGNS, More settings), "off" or unset = the normal look
  look?: string;                 // the PS look (core/looks.ts LOOKS, V1.31): the whole app, Mac and phone. Unset = from tmTheme / tmNotebook
  lookAccent?: Record<string, string>;   // The developer's accent per look, "#RRGGBB" (made readable automatically)
  lookDensity?: string;          // "dense" | "comfortable" | "focus"
  lookText?: number;             // text size in percent (80 to 150, default 100)
  lookFont?: string | null;      // a core/looks.ts FONTS id, null = the look's own
  netMonitor?: boolean;
  briefSeen?: string | null;     // the morning brief (its record id) the developer last opened, in PS or on the website: newer ones show NEW          // PS's network monitor on (default) or completely off: no polling, no leak watch
  whatsNewSeen?: string;         // the last PS version whose What's new was handled ("1.36"), any device (core/whatsnew.ts, V1.36)
  syncNudgeAt?: string | null;   // local first (V1.44): "Not now" on the week old Turn on sync card (src/views/LocalFirst.tsx)
  examples?: import("./examples").ExampleState;   // the example tasks a new account starts with, found again by id (core/examples.ts, G Squad)
  macCalendar?: boolean;         // meetings from this Mac's Calendar app (not the developer): true on, false off (never read, macOS never asked), unset = read only if macOS already allows, never ask (core/localcal.ts calMode)
  welcomeDone?: string;          // when the welcome tour was finished, skipped or put off (ISO), any device (core/welcome.ts, G Squad)
  tipsSeen?: import("./tips").TipsSeen;   // V1.55: the first use tips already shown or learned, per tip (ISO), any device; reset = "Show tips again" (core/tips.ts)
  popupsSeen?: import("./newpopups").PopupsSeen;   // V1.56: the "new in this version" pop-ups (AI task API, Auto approve, open source) already shown or found, per pop-up (ISO), any device (core/newpopups.ts)
  walkSeen?: import("./walkthrough").WalkSeen;   // V1.58: the "what is new" walkthrough steps already seen, per step (ISO), any device (core/walkthrough.ts)
  p1Migrated?: boolean;          // the top task became P1 once when P1 turned optional (18 Oct 2026)
  notifyLog?: { at: string; text: string }[];   // the last 24 hours of notification pop-ups (kept even when they are off)
  tmNotify?: boolean;
  tmStHours?: number;
  tmBackdrop?: number;           // the glass slider: 0 = see your screen clearly behind the list, 100 = solid, 50 = default
  goals?: Goal[];                // the goals timeline
  awayReasons?: string[];        // The developer's saved reasons for time away ("Coffee break", "Gym")
  awayLog?: AwayEntry[];         // why he was away, per break (start and end in seconds)            // how many hours the screen time timeline shows (1 to 24, default 24)            // notification pop-ups when Claude or the calendar changes the vault (default on)   // how the task you are working on looks in the Tab list    // tasks Claude suggests (from other chats); the developer adds or dismisses them
  suggestMigrated?: boolean;     // the tasks Claude had added straight to the list moved into suggestions once
  timelines?: TimelineItem[];
  timelineOrder?: string[];
  meetingNotes?: MeetingNote[];
  standingNotes?: StandingNote[]; // reminders shown on EVERY call with the same name (eg each Psychology lesson)  // reminders of what to say on a call, shown as a checklist while the call is on
  timelineHidden?: string[];     // built-in Timelines the developer removed or replaced by editing (month, birthday, year, h-halloween, h-thanksgiving)      // Timelines order the developer set by dragging (built-in ids: month, birthday, christmas, year)    // Tab list "Timelines" countdowns the developer adds himself (birthday, New Year and month end are built in)           // Tab list "Urgent" heads-ups (settings.aware; shown as "Be aware" before 17 Oct 2026), bottom right, in red
}
export interface AwareItem { id: string; text: string; createdAt: string }
/** Dimension X: act = Actionables, soon = The Upside Down (doing soon), x = Dimension X (brain dump). */
export type DimxZone = "act" | "soon" | "x";
export interface DimxItem { id: string; text: string; zone: DimxZone; createdAt: string; style?: DimxStyle }
/** How a Dimension X card's text looks (the card's style menu). Nothing set = plain white text. */
export const DIMX_FX = ["none", "glisten", "glow", "flicker", "pulse", "flip"] as const;
export const DIMX_COLORS = ["white", "red", "purple", "pink", "gold", "ice"] as const;
export const DIMX_SIZES = ["s", "m", "l", "xl"] as const;
export interface DimxStyle {
  fx?: (typeof DIMX_FX)[number]; color?: (typeof DIMX_COLORS)[number]; size?: (typeof DIMX_SIZES)[number];
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; caps?: boolean;
  highlight?: (typeof DIMX_COLORS)[number] | null;
}
export interface MeetingNote { key: string; title: string; start: string; items: { id: string; text: string; done: boolean }[]; doneStanding?: string[] }
export interface StandingNote { title: string /* lower case, trimmed */; items: { id: string; text: string }[] }
export const meetingTitleKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
/** The kinds of timeline you can add (V1.43). Old timelines have no kind and count as an Event. */
export type TimelineKind = "event" | "birthday" | "anniversary" | "wedding" | "trip" | "deadline" | "holiday" | "custom";
/** One Timelines countdown. title is the name you typed ("Mum" for a birthday). date is the day itself, or for a
 *  yearly one (birthday, anniversary) the first one, so the age or the years can be counted. time is "HH:MM" or none.
 *  repeat: comes back every year (none means the kind's own default, see core/timelines.ts). */
export interface TimelineItem { id: string; title: string; date: string /* YYYY-MM-DD */; createdAt: string; kind?: TimelineKind; time?: string; repeat?: boolean }
export const DEFAULT_SETTINGS: Settings = { ownerName: "Owner", autoLockMin: 15, autoReset: "off", theme: "system" };

// ---------- stage templates ----------
type T = Omit<Stage, "previews">;
const S = (key: string, name: string, info: string, extra: Partial<T> = {}): T => ({ key, name, info, ...extra });

export const STAGE_TEMPLATES: Record<ProjectType, T[]> = {
  shopify_redesign: [
    S("kickoff", "Kickoff", "Call done. Goals, scope and launch date agreed."),
    S("research", "Research", "Studying your store, your reviews and your competitors. This is what the designs are built on."),
    S("directions", "Design directions", "5 to 10 different homepage directions, each with a live preview link."),
    S("pick", "Your pick", "You choose a direction, or mix parts of two.", { clientAction: "Pick a design direction", gate: "direction" }),
    S("refine", "Refine", "We polish the chosen direction together using preview links.", { clientAction: "Approve the final design", gate: "design" }),
    S("build", "Build", "Built on a copy of your live theme, so your store is never touched while we work."),
    S("test", "Test", "Phone and desktop, homepage to checkout, apps and filters all checked.", { clientAction: "Approve going live", gate: "launch" }),
    S("live", "Live", "Switched live with your old theme kept for one-click rollback. CRO starts straight after."),
  ],
  cro_retainer: [
    S("onboard", "Onboarding", "Access, analytics and goals set up."),
    S("baseline", "Baseline", "Measuring where conversion, revenue per visitor and order value are today."),
    S("research", "Research", "Finding where visitors drop off and why."),
    S("testing", "Testing", "Running changes and measuring each one against the baseline."),
    S("report", "Monthly report", "What won, what lost, what we ship next.", { clientAction: "Review the monthly report", gate: "review" }),
  ],
  amazon_a_plus: [
    S("brief", "Brief", "Products, claims and brand assets gathered."),
    S("research", "Research", "Studying your listings, reviews and competitors."),
    S("design", "Design", "A+ modules designed for each product."),
    S("review", "Your review", "You check every module before it goes to Amazon.", { clientAction: "Approve the A+ designs", gate: "design" }),
    S("upload", "Upload", "Modules uploaded in Seller Central."),
    S("amazon", "Amazon approval", "Amazon reviews the content, usually 1 to 7 days."),
    S("live", "Live", "Live on your listings."),
  ],
  amazon_brand_store: [
    S("brief", "Brief", "Products, categories and brand assets gathered."),
    S("structure", "Structure", "Page map for the store."),
    S("design", "Design", "Store pages designed."),
    S("review", "Your review", "You check the store before it goes to Amazon.", { clientAction: "Approve the store design", gate: "design" }),
    S("build", "Build", "Built in the Amazon store builder."),
    S("amazon", "Amazon approval", "Amazon reviews the store."),
    S("live", "Live", "Your Brand Store is live."),
  ],
  video: [
    S("brief", "Brief", "Footage and brief received."),
    S("edit", "Editing", "The edit is in progress."),
    S("review", "Your review", "You watch the draft and leave notes.", { clientAction: "Review the draft", gate: "review" }),
    S("final", "Final", "Changes made and final delivered."),
  ],
  custom: [
    S("kickoff", "Kickoff", "Scope agreed."),
    S("work", "Work", "The work is in progress."),
    S("review", "Your review", "You review the result.", { clientAction: "Approve the work", gate: "review" }),
    S("done", "Delivered", "Delivered."),
  ],
};

export function stagesFor(type: ProjectType): Stage[] {
  return STAGE_TEMPLATES[type].map((s) => ({ ...s, previews: [] }));
}

export function newProject(type: ProjectType, title?: string): Project {
  return {
    title: title || typeLabel(type),
    type,
    pipeline: "lead",
    stages: stagesFor(type),
    current: 0,
    deliveryChanges: [],
    proposal: { scope: [], status: null },
    payments: [],
    liveUrls: [],
    clientVisible: true,
    status: "on_track",
  };
}

export type StageState = "done" | "now" | "waiting" | "upcoming";
export function stageState(p: Project, i: number): StageState {
  if (i < p.current) return "done";
  if (i === p.current) return p.stages[i]?.clientAction ? "waiting" : "now";
  return "upcoming";
}
export function progressPct(p: Project): number {
  if (!p.stages.length) return 0;
  if (p.current >= p.stages.length) return 100;
  return Math.round(((p.current + 0.5) / p.stages.length) * 100);
}
export function currentStage(p: Project): Stage | null {
  return p.stages[p.current] ?? null;
}

export const uid = () => crypto.randomUUID();

// ---------- planned dates ----------
// When stages have no dates yet, spread them between the start (start date, else signed,
// else sent) and the promised delivery, weighted by how long each stage usually takes.
// These are shown as estimates ("about") until the developer sets real dates.
const STAGE_WEIGHT: Record<string, number> = {
  kickoff: 1, research: 3, directions: 3, pick: 2, refine: 4, build: 6, test: 2, live: 1,
  onboard: 2, baseline: 5, testing: 14, report: 2, brief: 1, design: 5, review: 2, upload: 1,
  amazon: 4, structure: 2, edit: 5, final: 2, work: 7, done: 1,
};
export interface PlannedDate { start: string | null; due: string | null; estimated: boolean }
function isoAddDays(iso: string, n: number) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function isoDiffDays(a: string, b: string) {
  const p = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 864e5);
}
export function plannedDates(p: Project): PlannedDate[] {
  const start = p.startDate || p.proposal?.signedAt || p.proposal?.sentAt || null;
  const end = p.promisedDelivery || null;
  const span = start && end ? isoDiffDays(start, end) : 0;
  const weights = p.stages.map((s) => STAGE_WEIGHT[s.key] ?? 3);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return p.stages.map((s, i) => {
    const from = acc;
    acc += weights[i];
    if (s.start || s.due || s.doneAt) return { start: s.start ?? null, due: s.due ?? s.doneAt ?? null, estimated: false };
    if (!start || !end || span <= 0) return { start: null, due: null, estimated: true };
    const a = Math.round((from / total) * span);
    const b = Math.max(a, Math.round((acc / total) * span) - (i === p.stages.length - 1 ? 0 : 1));
    return { start: isoAddDays(start, a), due: isoAddDays(start, b), estimated: true };
  });
}

// A file attached to a project (proposal PDF, agreement). The bytes live encrypted in the
// blobs table; this record holds the metadata, encrypted like any other record.
export interface ProjectDoc {
  projectId: string;
  blobId: string;
  name: string;
  mime: string;
  size: number;
  label: string;                  // eg "Signed agreement"
  docKind: "proposal" | "agreement" | "other";
  addedAt: string;
}

// The morning brief: the developer's daily report, delivered sealed into the vault (owner only).
export interface BriefWeather { city: string; today: string; tomorrow: string }   // eg "18 C, sunny"
export interface BriefStat { label: string; value: string; sub?: string | null; tone?: "good" | "warn" | "bad" | null }
export interface BriefItem { text: string; url?: string | null }                    // url = the story's source, shown as "Read more"
export interface BriefSection { title: string; items: (string | BriefItem)[]; tone?: "alert" | "good" | "muted" | null }
export interface Brief {
  date: string;                   // YYYY-MM-DD the report is for
  headline?: string | null;       // one line, eg "2 things need you today"
  weather: BriefWeather[];
  stats: BriefStat[];             // key numbers at the top
  sections: BriefSection[];       // the rest of the report, short items
  source?: string | null;         // eg "Daily Report email 15th October"
  createdAt: string;
}

/** Signed work whose money only starts in a later month ("Up next" in the Pipeline). */
export function startsLater(p: Project, month = new Date().toISOString().slice(0, 7)): boolean {
  return !!p.startsMonth && p.startsMonth > month;
}

/** "per month" / "per video" for a proposal price, or "" for a one off fee. */
export function priceUnitOf(p: Project): "month" | "video" | null {
  return p.proposal?.priceUnit ?? (p.type === "cro_retainer" ? "month" : null);
}

/** The tasks marked "working on" (several allowed; older data had just one). */
export function workingIdsOf(st: Partial<Settings>): string[] {
  return st.workingIds ?? (st.workingOn ? [st.workingOn] : []);
}

/** Screen time for one local day on one device: PS on the Mac (bundle ids) or PS GOS on the phone
 *  ("gos:" + Android package names). App names, ids and seconds only. One record per day per device;
 *  records from before the phone have no device and are the Mac's. */
export type ScreenTimeDevice = "mac" | "gos";
export interface ScreenTimeApp { id: string; name: string; secs: number }
export interface ScreenTimeDay { day: string /* YYYY-MM-DD */; device?: ScreenTimeDevice; apps: ScreenTimeApp[]; updatedAt: string;
  /** Counted from the phone's usage events (PS GOS V1.31), cut exactly at midnight. Replaces an older count of the day once. */
  exact?: boolean }
/** One hour of one device's screen time line: which app was in front and when, and the breaks, so the
 *  other device (and the website) can draw the same "last hours" timeline. 24 slots per device
 *  (slot = the hour's number, mod 24), each overwritten a day later, so at most 48 records ever.
 *  Times are seconds from `hour`; `upTo` is how far this hour was counted (ms). Core: core/stline.ts. */
export interface StLine { device: ScreenTimeDevice; hour: number; slot: number; upTo: number; apps: { id: string; name: string }[];
  segs: [number, number, number][]; away: [number, number][]; updatedAt: string }

// The developer's cold outreach statistics (Cincee Campaigns, formerly Daily report Campaigns), for the Tab list's Cincee Campaigns
// panel. One owner-only record, replaced by each export (stats skill: export_for_ps.py, op
// putCampaignStats). Counts, rates, campaign names, subject lines and Cincee's own templates only:
// never a prospect's address or what a prospect wrote. Instantly and Gmail are kept apart, never added.
export interface CsVariant { label: string; subject: string; body: number | null; sent?: number | null; replies?: number | null; auto?: number | null; rate: number | null; opportunities?: number | null; disabled?: boolean }
export interface CsStep { step: number; delay?: number | null; delayUnit?: string; type?: string; sent?: number | null; replies?: number | null; auto?: number | null; rate: number | null; variants: CsVariant[] }
export interface CsDetail {
  leads: Record<string, number>; replyRate: number | null; bounceRate: number | null;
  schedule: { name?: string | null; days: string[]; from?: string | null; to?: string | null; timezone?: string | null } | null;
  senders?: number | null; senderTags: string[]; variables: string[]; settings: Record<string, string | number | boolean>; sequence: CsStep[];
}
export interface CsCampaign { detail?: CsDetail | null; id?: string; name: string; provider: string; status: string; sent: number; newLeads: number; repliers: number; replyRate: number | null; interested: number; bounced: number; bounceRate: number | null; opportunities?: number; deltaSent?: number; deltaRepliers?: number }
export interface CsSplit { newLeads: number; repliers: number; replyRate: number | null; sent: number; bounced: number; interested: number }
export interface CsCopy { text?: string; name?: string; subject?: string; body?: string; channel: string; contacted: number; replies: number; interested: number; replyRate: number | null; headline?: number | null; inUse?: string | null; measurable: boolean }
export interface CsDay { date: string; sent?: number; bounced?: number; replies?: number; [k: string]: string | number | undefined }
export interface CsWarmup {
  source?: "live" | "sweep"; readAt?: string | null; status?: string | null; statusCode?: number | null; startedAt?: string | null; score?: number | null;
  week: { sent?: number | null; received?: number | null; landedInbox?: number | null; landedSpam?: number | null };
  daily: { date: string; sent: number; received: number; spam: number }[];
  settings: Record<string, string | number | boolean>;
}
export interface CsSender {
  provider?: string | null; managed?: boolean | null; statusCode?: number | null; statusWord?: string | null; statusReason?: string | null; tags?: string[];
  healthPct?: number | null; sendingGap?: number | null; slowRamp?: boolean | null; setupPending?: boolean | null;
  tracking?: { name?: string | null; status?: string | null; ssl?: boolean | null; cname?: boolean | null }; dns?: Record<string, string | number | boolean> | null;
  signature?: string | null; createdAt?: string | null; lastSent?: string | null; lastReply?: string | null; sent7d?: number | null; sent30d?: number | null;
  replies30d?: number | null; replyRate30d?: number | null; bounces30d?: number | null; bounceRate30d?: number | null;
  campaignCounts?: Record<string, number> | null; activeCampaigns?: string[]; warmup?: CsWarmup;
  name: string; email?: string; domain?: string; status?: string | number | null; warmupScore?: number | null; dailyLimit?: number | null; sentYesterday?: number | null; bouncedYesterday?: number | null; health?: number | string | null; campaigns?: string[]; daily?: CsDay[]; extra?: Record<string, string | number | boolean> }
export interface CampaignStats {
  v: 1;
  updatedAt: string | null;       // when the sweep read the data (the "Last updated" time)
  dataThrough: string;            // YYYY-MM-DD, the newest closed day
  exportedAt: string;
  day: {
    date: string; weekday: string; status?: string | null;
    instantly: { sent: number | null; ceiling: number; newLeads: number | null; replies: number | null; manual: number | null;
      campaigns: { name: string; provider: string; sent: number; status: string; replyRate: number | null; newLeads: number | null }[];
      human: { company: string; campaign: string; sentiment: string; at?: string | null }[] };
    gmail: { sent: number; firstTouches: number; followUps: number; accounts: { account: string; sent: number }[];
      campaigns: { id: string; label: string; sent: number }[]; replies: { human: number; interested: number; notInterested: number } };
  };
  days: { date: string; instantly: number | null; newLeads: number | null; gmail: number | null }[];
  instantly: {
    totals: { sent: number; newLeads: number; repliers: number; replyRate: number | null; bounced: number; bounceRate: number | null; interested: number; opportunities: number; opportunityValue: number; meetings: number; closed: number };
    campaigns: CsCampaign[];
    split: { google: CsSplit; other: CsSplit; gap: number | null };
    inventory: { draft: number; active: number; paused: number; completed: number; total: number };
    blocklist: { total: number; emails: number; domains: number; newest?: string | null };
    unanswered: { name?: string | null; company?: string | null; campaign?: string | null; hoursWaiting: number | null; sentiment: string; since?: string | null }[];
  };
  gmail: {
    totals: { sends: number; prospects: number; repliers: number; replyRate: number | null; interested: number; notInterested: number };
    campaigns: { id: string; label: string; prospects: number; sends: number; replies: number; replyRate: number | null; interested: number; notInterested: number }[];
  };
  texts?: string[];   // email bodies, stored once; CsVariant.body points here
  closedFromCold: number;
  cashFromCold: number;
  senders: { total: number; healthy: number; limitEach: number; capacity: number; warmupAll: number | null; warmupOn: number; paused: number; flagged: number; setupPending: number; trackingOk: boolean; usedYesterday: number | null; bounced: number; bounceRate: number | null;
    detailed?: boolean;   // true when the sweep gave per account numbers (sender_accounts[])
    domains: { domain: string; daily?: CsDay[]; extra?: Record<string, string | number | boolean>; accounts: CsSender[] }[] };
  gmailAccounts: { account: string; sentYesterday: number; last7: { date: string; n: number }[]; drafts: number; draftsCold: number; draftsFollowup: number; newBounces: number; bouncesAllTime: number; lastBounce: string | null; spam: number | null; alerts: number; clean: boolean }[];
  copy: { offers: { key: string; title: string; subjects: CsCopy[]; bodies: CsCopy[] }[]; builtAt?: string | null; gmailFirstTouches?: number | null; instantlyNewLeads?: number | null; overlapDays?: number | null };
}
