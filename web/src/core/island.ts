// PS Dynamic Island (the developer, 30 Oct 2026): a black island that grows out of the MacBook notch (or a pill
// just below it, or off) and always shows the task he is working on, with a tick. A mail icon counts
// client emails waiting and a reply icon counts Instantly replies; a new one pops the island open for
// a few seconds. The native side (ps-mac Island.swift) draws it; this works out what it shows.
// Pure: no vault, no clock, no storage. src/island.ts (the PS main window) feeds it and posts the
// result as {type:"island", state}. Read only: the island never sends anything anywhere (Rule Zero).
import type { Doc, Settings, Todo } from "./model";
import { tabLists } from "./groups.ts";
import { overdueZone } from "./overdue.ts";
import { dndMutes } from "./dnd.ts";
import { NOTCH_DEFAULT, PILL_DEFAULT, notchLook, notchTones, pillLook, pillTones, type NotchLook, type NotchTones, type PillLook, type PillTones } from "./islandlook.ts";

export type IslandMode = "notch" | "pill" | "off";
/** pill, notch: the look of each (core/islandlook.ts, the developer 4 Nov 2026); the defaults keep the pill as it was.
 *  hide: how long a click on the island's grey grab line hides it, in seconds (V1.40, the developer: "Make it 1 minute by
 *  default, and add a setting"). A new email, lead reply or finished chat brings it back sooner (Island.swift).
 *  cards: the Mac's notification cards come out of the island instead of the top right corner while it shows (V1.55,
 *  the developer 12 Nov 2026: "I want them to come out of the dynamic island instead with a nice animation"). On unless switched
 *  off in Settings; ps-mac Toast.swift and NoteDropCore.swift do the rest.
 *  top: the kinds of card sent to the top right instead (the developer: "decide which notifications actually pop out the dynamic
 *  island and which notifications go on the top"); none by default, so every kind comes out of the island.
 *  fsMove: over a full screen app the island glides to the top left, into the black band beside the notch, and back
 *  when full screen ends (the developer, 12 Nov 2026: "make it so the dynamic island does a fancy animation so it moves itself up
 *  to the top left of the screen instead"). On unless switched off; off, it stays where it is, dimmed. Only a screen with
 *  a notch has that band; ps-mac Island.swift and IslandPlace.swift do the rest.
 *  tickSide: which side of the island the tick circle sits on, the same at rest, open, and in the black band (the developer, 12
 *  Nov 2026: "Make it so it's always on the left. Make this adjustable in the dynamic island settings too"). Left
 *  unless set. Before, the resting row drew it on the right and the open row on the left, so it jumped on hover. */
export type TickSide = "left" | "right";
export interface IslandPrefs { mode: IslandMode; idle: "next" | "none"; pill: PillLook; notch: NotchLook; hide: number; cards: boolean; top: CardKind[]; fsMove: boolean; tickSide: TickSide; sounds: boolean }
/** The kinds of card, as ps-mac NoteDropCore.swift (NoteDrop.kinds, NoteDrop.kind) sorts them. red: only the developer's account
 *  ever gets them (his Gmail and Instantly feeds), so nobody else is shown the choice. */
export type CardKind = "mail" | "chats" | "leads" | "meetings" | "network" | "mac" | "reminders" | "update" | "helper" | "notes" | "sound";
/** pop: a pop up with a window of its own (ps-mac IslandColumn.swift, the developer: "Actually yes. But make it so you can change it
 *  all in settings"); its "Top right" is its usual place (the reminders and the update card at the top centre, the
 *  restart helper alert in the middle, the meeting notes card top left, the Soundboard card top right). */
export const CARD_KINDS: { k: CardKind; label: string; red?: boolean; pop?: boolean }[] = [
  { k: "mail", label: "Client emails", red: true },
  { k: "chats", label: "AI chat finished" },
  { k: "leads", label: "Lead replies", red: true },
  { k: "meetings", label: "Meetings" },
  { k: "network", label: "Network and VPN" },
  { k: "mac", label: "Everything else (AirPods, files, PS notices)" },
  { k: "reminders", label: "Reminders (15 min and task reminders)", pop: true },
  { k: "update", label: "Update card", pop: true },
  { k: "helper", label: "Restart helper alert", pop: true },
  { k: "notes", label: "Meeting notes card", pop: true },
  { k: "sound", label: "Soundboard", pop: true },
];
const isCardKind = (v: unknown): v is CardKind => typeof v === "string" && CARD_KINDS.some((x) => x.k === v);
/** The kinds sent to the top right: known ones only, each once, in the list's order. */
export function cardsTop(v: unknown): CardKind[] {
  return Array.isArray(v) ? CARD_KINDS.map((x) => x.k).filter((k) => v.some((y) => y === k && isCardKind(y))) : [];
}
/** Where a kind of card comes out (the page's view of NoteDrop.route; the Mac also needs the island on screen). */
export function cardPlace(p: IslandPrefs, k: CardKind): "island" | "top" {
  return p.mode !== "off" && p.cards && !p.top.includes(k) ? "island" : "top";
}
/** One kind moved to the island or the top right; every other choice kept. */
export function withCardPlace(p: IslandPrefs, k: CardKind, place: "island" | "top"): IslandPrefs {
  const top = place === "top" ? [...p.top, k] : p.top.filter((x) => x !== k);
  return { ...p, top: cardsTop(top) };
}
export const HIDE_DEFAULT = 60, HIDE_MIN = 5, HIDE_MAX = 3600;
/** The ready made hide times in Settings; anything else from 5 s to 1 hour is a custom time. */
export const HIDE_CHOICES = [5, 30, 60, 300, 900];
export const ISLAND_DEFAULT: IslandPrefs = { mode: "notch", idle: "next", pill: PILL_DEFAULT, notch: NOTCH_DEFAULT, hide: HIDE_DEFAULT, cards: true, top: [], fsMove: true, tickSide: "left", sounds: true };

/** A hide time: whole seconds from 5 s to 1 hour; anything that is not a number is the 1 minute default. */
export function hideTime(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(HIDE_MAX, Math.max(HIDE_MIN, Math.round(n))) : HIDE_DEFAULT;
}
/** "5 s", "1 min", "2 min 30 s", "1 h". */
export function hideLabel(sec: number): string {
  const t = hideTime(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", x ? `${x} s` : ""].filter(Boolean).join(" ");
}
/** How long a new email, reply or finished chat keeps the island open (the native side pops it for 10 s). */
export const ISLAND_EVENT_MS = 12_000;
/** A card counts as new for the island when it arrived (or came back from a remind) in the last 3 minutes. */
export const ISLAND_FRESH_MS = 180_000;
const TITLE_MAX = 120;

/** quiet: Do Not Disturb mutes the island's pop (core/dnd.ts), so it only lights up for a moment and never opens. */
export interface IslandEvent { id: string; kind: "mail" | "lead" | "chat"; title: string; sub: string; url: string; quiet?: boolean;
  /** V1.58: its own private mode line (a message from an AI), instead of the kind's. Never sent to the Mac. */
  privTitle?: string }
export interface IslandState {
  mode: IslandMode;
  private: boolean;
  task: { id: string; title: string; dim: boolean } | null;
  more: number;                              // other working tasks beyond the one shown
  tasks: { id: string; title: string }[];    // every working task (up to 6), for the hover view
  mail: number;                              // client email cards waiting
  leads: number;                             // Instantly reply cards waiting
  event: IslandEvent | null;
  /** Seconds a click on the grab line hides it (IslandPrefs.hide). */
  hide: number;
  /** The notification cards come out of the island while it shows (IslandPrefs.cards, V1.55). */
  cards: boolean;
  /** The kinds of card that go to the top right instead (IslandPrefs.top). */
  top: CardKind[];
  /** Over a full screen app it glides to the top left black band (IslandPrefs.fsMove). */
  fsMove: boolean;
  /** Which side the tick circle sits on in every island state (IslandPrefs.tickSide). */
  tickSide: TickSide;
  /** The chime of the island's big moments (database loaded, updated, What's new) is on (IslandPrefs.sounds, PS 1.60). */
  sounds: boolean;
  /** The colours and shape of each look, worked out here (readable text guaranteed) and only painted natively.
   *  Both go every time: a Mac without a notch shows "around the notch" as the pill. */
  pill: Omit<PillTones, "backs">;
  notch: Omit<NotchTones, "backs">;
}

/** Only well formed choices; anything else falls back to the default. */
export function islandPrefs(v: unknown): IslandPrefs {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return {
    mode: o.mode === "notch" || o.mode === "pill" || o.mode === "off" ? o.mode : ISLAND_DEFAULT.mode,
    idle: o.idle === "next" || o.idle === "none" ? o.idle : ISLAND_DEFAULT.idle,
    pill: pillLook(o.pill),
    notch: notchLook(o.notch),
    hide: hideTime(o.hide),
    cards: o.cards !== false,
    top: cardsTop(o.top),
    fsMove: o.fsMove !== false,
    tickSide: o.tickSide === "right" ? "right" : "left",
    sounds: o.sounds !== false,
  };
}

const PRIVATE_EVENT: Record<IslandEvent["kind"], string> = { mail: "New client email", lead: "New lead reply", chat: "A Claude chat finished" };
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
/** What a task in progress reads as in private mode. It used to be "Working", which read as a task of that name
 *  (V1.44 #10, the developer: "stuck in this task which I never even created"): the label says what is going on instead. */
export const PRIVATE_TITLE = "Hidden (private mode)";
/** A click on the island's private mode label (ps-mac Island.swift privateLabel) turns private mode off, but only while
 *  the island was last told it is private and private mode is still on: an old click never touches the setting.
 *  Turning it off shows the real names again; turning it on stays with the mask and the meeting card. */
export function canPrivateOff(shown: IslandState | null, privateMode: boolean | undefined): boolean {
  return !!shown && shown.private && privateMode === true;
}
/** How long after a tick on the island its Undo still counts (the island offers Undo for 5 s; this allows for lag). */
export const UNDO_MS = 15_000;
const open = (t: Todo) => !t.done;

export interface IslandInput {
  todos: Doc<Todo>[];
  settings: Partial<Settings>;
  today: string;          // YYYY-MM-DD, for which repeating tasks are due
  land?: string;          // Clients (PS 1.73): the person's day by their day end (core/clientwork.ts landDayAt), so the next up task is one that landed
  mail: number;
  leads: number;
  event: IslandEvent | null;
  now?: number;
}

/** The pill the Mac draws. PS 1.72 (Jan, 21 Nov 2026: the island stayed black after he picked white, and its colour could
 *  not be changed): with Around the notch chosen, the Mac still draws the pill wherever it cannot go round a notch (a
 *  screen with none, the island moved off the top centre with its grab line, ps-mac Island.swift `pill`), and it painted
 *  that pill in the Pill look's colours, so a Background or Accent picked for Around the notch never showed. Now that pill
 *  takes the colours picked for Around the notch (each one only when picked), and keeps the Pill look's own style, size
 *  and icon. With Pill below the notch chosen it is the Pill look, as always. */
export function pillShown(prefs: Pick<IslandPrefs, "mode" | "pill" | "notch">): PillLook {
  if (prefs.mode !== "notch") return prefs.pill;
  const { fill, color } = prefs.notch;
  return fill || color ? { ...prefs.pill, ...(fill ? { fill } : {}), ...(color ? { color } : {}) } : prefs.pill;
}

/** What the island shows now. Off still says so, so the native side hides it. */
export function islandState(inp: IslandInput): IslandState {
  const prefs = islandPrefs(inp.settings.island);
  const priv = !!inp.settings.privateMode;
  const { backs: _b, ...pill } = pillTones(pillShown(prefs));
  const { backs: _n, ...notch } = notchTones(prefs.notch);
  const none: IslandState = { mode: prefs.mode, private: priv, task: null, more: 0, tasks: [], mail: 0, leads: 0, event: null, hide: prefs.hide, cards: prefs.cards, top: prefs.top, fsMove: prefs.fsMove, tickSide: prefs.tickSide, sounds: prefs.sounds, pill, notch };
  if (prefs.mode === "off") return none;
  const byId = new Map(inp.todos.map((d) => [d.id, d]));
  const ids = inp.settings.workingIds ?? (inp.settings.workingOn ? [inp.settings.workingOn] : []);
  const working = ids.map((id) => byId.get(id)).filter((d): d is Doc<Todo> => !!d && open(d.data));
  const name = (d: Doc<Todo>) => (priv ? PRIVATE_TITLE : clip(d.data.title || "") || "Untitled task");
  let task: IslandState["task"] = null;
  if (working.length) task = { id: working[0].id, title: name(working[0]), dim: false };
  else if (prefs.idle === "next" && !priv) {
    // Nothing in progress: the next Priority 1 task, dimmed (the top priority when there is no Priority 1 group).
    // As the Tab list shows it: a task 48 hours overdue is on the Overdue card, not next up.
    // Not in private mode: a next up task whose name is hidden is one the developer never picked and cannot see, and a tick on
    // it ticked a real task blind (V1.44 #10). The tasks he marked as working still show, as PRIVATE_TITLE.
    const lists = tabLists(inp.todos, inp.settings.tmGroups || [], inp.today, { now: inp.now ?? Date.now(), tz: overdueZone(inp.settings.tmHomeTz) }, inp.land);
    const next = lists.p1[0] || lists.prio[0];
    if (next) task = { id: next.id, title: name(next), dim: true };
  }
  const { privTitle, ...e0 } = inp.event ?? ({} as IslandEvent);
  let ev = inp.event && (priv ? { ...e0, title: privTitle || PRIVATE_EVENT[e0.kind], sub: "" } : e0);
  if (ev && dndMutes(inp.settings.dnd, "island", inp.now ?? Date.now())) ev = { ...ev, quiet: true };
  return {
    ...none,
    task,
    more: Math.max(0, working.length - 1),
    tasks: working.slice(0, 6).map((d) => ({ id: d.id, title: name(d) })),
    mail: Math.max(0, inp.mail | 0),
    leads: Math.max(0, inp.leads | 0),
    event: ev,
  };
}

/** The tasks the island is showing now: the only ones a tick from it may reach. */
export function shownIds(s: IslandState | null): string[] {
  if (!s) return [];
  return [...new Set([...(s.task ? [s.task.id] : []), ...s.tasks.map((t) => t.id)])];
}
/** A tick from the island counts only for a task it shows that is still open and still in the list. An old state the
 *  native side still had (after a sleep, a reload or a sign in) never ticks a task that has left the island. */
export function canTick(shown: IslandState | null, id: string, todo: Todo | null | undefined): boolean {
  return !!todo && !todo.done && !todo.clearedAt && shownIds(shown).includes(id);
}
/** The island's last tick, so its Undo also puts the task back in progress. */
export interface IslandTick { id: string; at: number; working: string[] }
/** Undo takes back only the island's own last tick, soon after it, while the task is still ticked. */
export function canUndo(last: IslandTick | null, id: string, todo: Todo | null | undefined, now: number): boolean {
  return !!last && last.id === id && !!todo && !!todo.done && now - last.at <= UNDO_MS;
}

export interface IslandCard extends IslandEvent { at: number; fresh: boolean }

/** The newest card that is new to this page run and fresh; every card is marked seen either way, so a
 *  restart sending old cards again never pops the island, and each card pops it once. */
export function pickEvent(cards: IslandCard[], seen: Set<string>): IslandEvent | null {
  let best: IslandCard | null = null;
  for (const c of cards) {
    if (!seen.has(c.id) && c.fresh && (!best || c.at > best.at)) best = c;
    seen.add(c.id);
  }
  if (!best) return null;
  const { at: _a, fresh: _f, ...ev } = best;
  return ev;
}
