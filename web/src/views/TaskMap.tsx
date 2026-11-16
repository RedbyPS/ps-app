// Hold or tap Tab anywhere: the to-do list floats over the page like a game map, big and clear,
// with everything behind it blurred. Hold Tab to peek (it closes when you let go); tap Tab to
// pin it open (tap again, press Escape or click the background to close). Tick tasks off here,
// or click tasks to mark what you are working on (each glows white; several at once; click again to unmark). Drag tasks up and down to
// set their priority (the top one is P1). Size slider top left; hover and click sounds (volume in
// Settings). Tab still works normally inside text boxes, menus and the notes window.
import { createPortal } from "react-dom";
import { islandPrefs } from "../core/island";
import { IslandSettingsWindow } from "./IslandSettings";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { meetingTitleKey, workingIdsOf, type AwareItem, type AwayEntry, type DimxItem, type DimxZone, type CalEvent, type ClientRec, type Doc, type Goal, type MeetingNote, type Settings, type StandingNote, type TaskGroup, type TimelineItem, type Todo } from "../core/model";
import { calendarDocs, calendarSnap, campaignStats, clientViews, openReplies, replies, screenLines, screenTimeDays, settingsData, tabLayoutDoc, todos, allTodos } from "../core/select";
import { inboxTasks } from "../core/aiinbox";
import { HOUR, clipTimeline, joinLines } from "../core/stline";
import { askPhoneLine, usePhoneLine } from "../stlive";
import { ST_HERE, ScreenTimeBars, StDeviceSwitch, StSwap, fmtDur, totalSecs } from "./ScreenTime";
import { macStChip, macStEmptyText, macStOff, macStOffText } from "../core/screentime";
import type { ScreenTimeDevice } from "../core/model";
import { StTimeline } from "./StTimeline";
import { GoalsWindow } from "./Goals";
import type { Timeline } from "../ps";
import { buildMatcher, gmailThreadLink, replierName } from "../core/mail";
import { cleanReplyCardId, gmailCardId, leadMirror, leadRows, mailRows, replyButtonShows, type MailRow } from "../core/overlaymail";
import { cleanOut, panelStatus, repliedRows, replyInPanelOn, sinkReplied, startUndoSend, type ReplyOut, type UndoSend } from "../core/inlinereply";
import { ReplyBox, drafts as replyDrafts } from "./ReplyBox";
import { leadCards } from "../core/leadcards";
import { irepFeed, mailCardMessage } from "../mailcards";
import { DAY_ENDS_DEFAULT, workDayOf } from "../core/daylog";
import { dndMutes, type DndOp } from "../core/dnd";
import { addDraft, addGate, addShape, cleanTitle, enterAction, quickDefaults, revealBy, type AddOpts } from "../core/quickadd";
import { typedEdit, typedOrder } from "../core/typedprio";
import { PrioInput, useTypedPrio } from "./TypedPrio";
import { addTodo, approveSuggestion, awareDone, awareToList, awareUndone, suggestionToAware, suggestionToDimx, resetTodos, deleteTodo, dismissSuggestion, saveSettings, setReplyHandled, setTodoOrder, setWorkingOn, subtaskOp, toggleTodo, setTodoDone, setTodosDone, clearTodos, reviveTodos, buryTodos, restoreTodo, updateTodo, moveTasks, ungroupTasks, setDnd, setJournal } from "../core/actions";
import { accepts, cleanGroups, dropAbovePrioIsP1, groupKey, hitSection, mergeOrder, newGroupId, sectionOrder, tabLists, type TabLists, type TaskMove } from "../core/groups";
import { fmtDate, todayISO, useVault } from "../ui/kit";
import { GSquadButton, GSquadHost } from "./GSquad";
import { isPhoneBuild } from "../squad/phonehost";
import "./GSquadBoard";   // G Squad Leaderboard and Screen time (V1.40); last month's amount is added there (V1.43)
import { GSquadChatWeb } from "./GSquadChat";
import { SquadAddRow, type SquadAdd } from "./GSquadTask";
import { SquadP1Panel } from "./SquadP1Panel";
import { vaultStore } from "../core/vault";
import { calLinkNow, calRefreshNow } from "../calrefresh";
import { agoText, calLine, calStatus, type CalStatus } from "../core/calstatus";
import { onRedProject } from "../core/project";
import { CAL_WORDS, calMode, localLine } from "../core/localcal";
import { applyMeetHide, meetKey, visibleEvents, MEET_HIDE, type MeetHideOp } from "../core/meethide";
import { meetingEvents } from "../core/calpick";
import { ackGym } from "../core/gym";
import { isRedAccount } from "../core/account";
import { mailOnSnap } from "../core/mailsnap";
import { MAIL_EMPTY_WORDS, mailPanelShows } from "../core/mailempty";
import { useGmailKnown } from "./gmailknown";
import { mailPicked, seenAccounts } from "../core/gmailtruth";
import { CopyForAiButton } from "./CopyForAi";
import { waOnSnap } from "../core/wasnap";
import { WaMail } from "./WaMail";
import { PhoneTilesHost } from "../gos/PhonePages";
import { usePhoneBg } from "../gos/phonepage";
import { CopySlots, EditButton, EditLayer, EditScope, Inner, Slot, editingNow, setMacAccounts, setOverviewPages, useEditing, useInst, useTabLayout } from "./EditMode";
import { calendarFor, feedOfAccount, panelCal } from "../core/calfeeds";
import { cleanLayout, emptyLayout, onPage, pageOf } from "../core/tablayout";
import { mailPanelId, newestOf, onMailOpen, peekMailOpen, takeMailOpen } from "../core/mailopen";
import { PS, cleanLooks, useBgVideos as usePsBgVideos, useOverlayShown, firstSentences, askMic, askPresence, askTimeline, chooseMic, psIsOpen, psPost, useAppIcons, usePresence, usePsMic, usePsSettings, useTimeline } from "../ps";
import { primeSfx, setEditSoundCtx, setSfxVolume, setTickSound, sfx } from "../ui/sfx";
import { editSoundsOn, meetingNow } from "../core/editsounds";
import { glassPlace } from "../core/screenfit";
import { onRelayout, topBand, tucked } from "../ui/relayout";
import { NO_CLEAR, islandClear, near, topIsland, type Box } from "../core/islandclear";
import { islandBox, islandInstant, onIsland } from "../ui/islandspot";
import { EDGE_ZONE, edgeRamp } from "../core/overviewnav";
import { keepPopsOnScreen } from "../ui/popfit";
import { tickSoundOf } from "../core/ticksound";
import { BACKDROP_USUAL, backdropLook, backdropOf, bgFade, transparencyOf } from "../core/bgfade";
import { previewBackdrop, setLiveBackdrop, watchBackdrop } from "./ListTransparency";
import { ADD_ANIMS, addAnimOf, addColorOf, addInkOn, type AddAnim } from "../core/addbutton";
import { useDragOrder, type DragEnd } from "../ui/dragOrder";
import { ROW_CONTROLS, TICK_PEND_MS, TICK_STAY_MS, clickAlreadyHandled, pressMoved, pressStarts, tickMoved, tickPressStarts, tickSettled, tickShown, tickStays, tickWant, type TickPend } from "../core/press";
import { allCompletedList, completedList, completedOn, listPrefs, nextRollAt, openOnList, resurrectList } from "../core/completed";
import { resetMinOf } from "../core/resetday";
import { Completed } from "./Completed";
import { SleepHost, SleepRow } from "./SleepMode";
import { TaskMenuHost, openTaskMenu, openTaskMenuAt } from "./TaskMenu";
import { EmptyList, ListDots, ListMenuHost, ListPager, ListStrip, PlusPage, SecTitle, addGroupHere, deleteList, goToPage, jumpToPage, listDragHint, listDropAt, listName, moveToList, newPanelsPage, openSecMenu, pageBg, pageForNewGroup, pagePrefs, setListCtx, setPageOrder, useActivePage } from "./ListPager";
import { MAIN, allPages, isPlus, pageOfTask, pagerIds, secsByPage, shownName } from "../core/lists";
import { useSectionOrder } from "../ui/sectionDrag";
import { MiniList, MiniToggle, miniAllDone, useMiniOpen, useSubOpenList } from "./MiniTasks";
import type { SubOp, Subtask } from "../core/subtasks";
import { DwellButton } from "../ui/Dwell";
import { RepeatPicker, StreakBadge } from "../ui/RepeatPicker";
import { draftOf, isDueNow, isEveryDay, patchOf, repeatLabel, type Repeat, type RepeatDraft } from "../core/repeat";
import { TimeZones } from "./TimeZones";
import { Timelines } from "./Timelines";
import { SentryButton } from "./Sentry";
import { SeriesPill } from "./SeriesPill";
import { Numerology } from "./Numerology";
import { DEVICE_TZ, HOME_COMMON, allZones, homeTz, setHomeTz, tzLabel } from "../core/tz";
import { NewTasks } from "./NewTasks";
import { LocalLine } from "./LocalFirst";
import { clearDuePatch, isOverdue, nextOverdueAt, overdueZone, splitOverdue } from "../core/overdue";
import { overdueLookOf, type OverdueLook } from "../core/overduelook";
import { OverdueFxLayer, useOverdueCard, useOverdueLook } from "./OverdueLook";
import { BG_DESIGNS, P1_COLORS, P1_DESIGNS, bgDesign, colorHue, hueColor, isVideoBg, isP1, movedId, p1AfterMove, p1Color, p1Design, p1Tones, prioNumbers, sortPrio } from "../core/prio";
import { Storm, type StormKind } from "./Storm";
import { rainLayers } from "../core/looksample";
import { DimensionX, dimxIsOpen, morph } from "./DimensionX";
import { openSettings, useSettingsWanted, type Preview, type SettingsOwner } from "./SettingsScreen";
import { SettingsHost } from "./SettingsGroups";
import { BgBrightControls, BgDim, GosAddVideoTile } from "./BgBright";
import { BgClip, BgFitControls, PhoneBgChoice, bgPatch, shownBg, useBgKeeper, usePhoneCrop } from "./BgFit";
import { cropCss, type BgCrop } from "../core/bgcrop";
import { FitnessButton } from "../fitness/FitnessButton";
import { SoundboardButton } from "../soundboard/SoundboardButton";
import { PomodoroButton } from "./Pomodoro";
import "../fitness/fitness.css";
import { PsRuleButton, RuleBookHost } from "./RuleBook";
import { endDayGate, myRules, openRuleBook } from "../rulegate";
import { cleanRules, needsCheck, type Rule } from "../core/rules";
import { BriefButton } from "./BriefTab";
import { CampaignStats } from "./CampaignStats";
import { MacUpdateDot } from "./MacUpdate";
import { setCalendarOn } from "./CalSwitch";
import { CalGear } from "./CalPicker";
import { useMacUpdate } from "../macupdate";
import { macUpdateBadge } from "../core/macupdate";
import { NetButton } from "./NetMonitor";
import { NotesLeftovers } from "./NotesLeftovers";
import { NewBadge } from "./NewBadge";
import { MixerButton } from "./Mixer";
import { ScreenRecButton, ScreenRecHost } from "./ScreenRec";
import { AfkBadge, setAfkOn } from "./AfkBadge";
import { DndButton } from "./Dnd";
import { SecondButton } from "./Second";
import { SecurityButton, SecurityWindow } from "./Security";
import { MinecraftWindow } from "./Minecraft";
import { MINECRAFT_ENABLED } from "../core/mcmode";
import { CAMPAIGNS_ON, NOTEBOOK_ON } from "../core/features";
import "./taskmap.css";
import "./smallscreen.css";
import "./moresettings.css";
// The Notebook paper looks load their stylesheet (and so their fonts) only while NOTEBOOK_ON (core/features.ts).
if (NOTEBOOK_ON) void import("./notebook.css");
import { NB_DESIGNS, nbDesign } from "../core/notebook";
import { lookById, NOTEBOOK_IDS, OWN_WORK, resolveAppearance, workStyle as workStyleOf } from "../core/looks";
import { useAppearance, useWorkPreview } from "../looks/engine";
import { setPeekNote, usePeek } from "../looks/peek";
import { NO_STAGE, bgLayers, previewStage } from "../core/lookspreview";
import { looksOption } from "../core/looksoptions";
import { BG_COLOURS, colourBgCss, colourBgLabel, customColourBg, customOf, isColourBg, pickerColour, pickerOf, DEFAULT_CUSTOM_COLOUR } from "../core/bgcolour";
import { RAIN_KINDS, rainAmount, rainKind, type RainId } from "../core/rain";
import { notePlayhead, resumeAt, type Playhead } from "../core/bgplayhead";
import { Rain } from "./Rain";
import { TrailLayer, trailOnList } from "./Trail";
import { appName } from "../core/appname";
import { webCalLine, webShows } from "../core/webtodo";
import { TaskBell, openTaskRemind, reminderWords, useTaskReminder } from "./TaskRemind";
import { okTaskId } from "../core/remind";

// What a tick or a click does. The PS Mac app's floating window swaps these for messages to
// its main window, which holds the keys (see src/ps.ts).
export type TodoPatch = Partial<Pick<Todo, "title" | "notes" | "due" | "type" | "clientId" | "order" | "repeat" | "p1" | "unranked" | "group" | "aiInbox">>;

/** The order value that puts a task at priority p (1 = top) in a ranked list, between its new
 *  neighbours, so only that one task changes. */
export function orderForPriority(list: Doc<Todo>[], p: number) {
  const k = Math.max(0, Math.min(list.length, p - 1));
  const before = list[k - 1]?.data.order, after = list[k]?.data.order;
  if (before != null && after != null) return (before + after) / 2;
  if (after != null) return after - 1;
  if (before != null) return before + 1;
  return 0;
}

// − 3 + : where in the list a task goes (1 is the top). Priority 1 itself is a switch (core/prio.ts).
function PriorityPicker({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  const set = (n: number) => { const v = Math.max(1, Math.min(max, n)); if (v !== value) { onChange(v); sfx.hover(); } };
  return (
    <span className="tm-prio-pick" title="Place in the list: 1 is the top">
      <span className="tm-prio-pick-l">Place</span>
      <button type="button" onClick={() => set(value - 1)} disabled={value <= 1} aria-label="Higher up">−</button>
      <span className="tm-prio-pick-v num">#<input type="number" min={1} max={max} value={value} aria-label="Place in the list"
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 1) set(Math.round(n)); }} /></span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label="Lower down">+</button>
      <span className="tm-prio-pick-of">of {max}</span>
    </span>
  );
}
export const taskMapActions: {
  /** A tick: done true or false (V1.34, a repeat is harmless); with no done it toggles, as before. */
  tick: (id: string, done?: boolean) => Promise<unknown>; work: (id: string | null) => Promise<unknown>;
  /** The Completed section (core/completed.ts): Resurrect (done false) and its Undo; Clear (on) and its Undo. */
  tickMany: (ids: string[], done: boolean) => Promise<unknown>; clearDone: (ids: string[], on: boolean) => Promise<unknown>;
  /** Resurrect of tasks a reset or Clear took off (V1.47), and its Undo (done again; `cleared` cleared again). */
  revive: (ids: string[]) => Promise<unknown>; bury: (ids: string[], cleared: string[]) => Promise<unknown>;
  /** A task deleted from the right click menu, put back by Undo with its own id. */
  restore: (id: string, data: Todo) => Promise<unknown>;
  /** The list's new order; p1 also sets the moved task's Priority 1 flag (same write). */
  reorder: (ids: string[], p1?: { id: string; on: boolean }) => Promise<unknown>; scale: (percent: number) => Promise<unknown>;
  clockScale: (percent: number) => Promise<unknown>;
  update: (id: string, patch: TodoPatch) => Promise<unknown>; remove: (id: string) => Promise<unknown>;
  /** A mini task change (core/subtasks.ts); next is the list it makes, for PS's test copy. */
  sub: (id: string, op: SubOp, next: Subtask[]) => Promise<unknown>;
  /** A client email dealt with (the Done button in "Client emails"). */
  replyHandled: (id: string) => Promise<unknown>;
  /** Reply in the email panel (core/overlaymail.ts): opens the reply panel with that email loaded. Never sends. */
  replyOpen: (cardId: string) => Promise<unknown>;
  /** V1.59 Reply in the email panel (core/inlinereply.ts): the box's Send, once its Undo has run out. The reply goes
   *  from the account and in the thread the email came in on, through the Mac's queue. Only the developer's own click gets here. */
  replyInline: (cardId: string, text: string, id: string) => Promise<unknown>;
  /** Done on a lead reply in the email panel: dismissed on every device, like the card's Dismiss. */
  leadDone: (cardId: string) => Promise<unknown>;
  /** WhatsApp in the same panel (core/waactions.ts): Send after the Undo, a template, and Done. The server sends it, so any device can. */
  waSend: (chatId: string, text: string) => Promise<unknown>;
  waTemplate: (chatId: string, name: string, language: string) => Promise<unknown>;
  waDone: (chatId: string) => Promise<unknown>;
  aware: (list: AwareItem[]) => Promise<unknown>;
  /** Urgent: ticked (off Urgent, on the list as a finished task todoId), its Undo, and dragged onto the list. */
  awareDone: (id: string, todoId: string) => Promise<unknown>;
  awareUndone: (item: AwareItem, index: number, todoId: string) => Promise<unknown>;
  awareToList: (id: string, order: number, type: "once" | "daily", p1?: boolean) => Promise<unknown>;
  /** Dimension X's cards (the whole list, in order). */
  dimx: (list: DimxItem[]) => Promise<unknown>;
  editing: (on: boolean) => void; clearClipboard: () => Promise<unknown>;
  headline: (text: string) => Promise<unknown>;
  add: (t: { title: string; due: string | null; type: Todo["type"]; order?: number; repeat?: Repeat | null; p1?: boolean; clientId?: string | null; notes?: string | null; unranked?: boolean; sqOn?: boolean; sqAnon?: boolean; group?: string | null }) => Promise<unknown>;
  sound: (patch: { tmSound?: number; tmMuted?: boolean }) => Promise<unknown>;
  homeTz: (id: string | null) => Promise<unknown>;
  timelines: (list: TimelineItem[]) => Promise<unknown>;
  timelineOrder: (ids: string[]) => Promise<unknown>;
  timelineHidden: (ids: string[]) => Promise<unknown>;
  /** Call reminders: one save for both lists, so moving a reminder between them never loses one. */
  meetingNotes: (patch: { meetingNotes?: MeetingNote[]; standingNotes?: StandingNote[] }) => Promise<unknown>;
  /** New tasks (Telegram, Claude): add one to the list, put it on Urgent (aware), into a Dimension X band, or dismiss it. */
  suggest: (id: string, action: "add" | "dismiss" | "aware" | "dimx", place?: { type: "daily" | "once"; order: number; p1?: boolean }, zone?: DimxZone) => Promise<unknown>;
  /** The New tasks pop-up was minimized at this time (ISO): only newer tasks open it big again. */
  inboxMin: (at: string) => Promise<unknown>;
  workStyle: (style: string) => Promise<unknown>;
  /** The Priority 1 look (core/prio.ts P1_DESIGNS). */
  p1Style: (id: string) => Promise<unknown>;
  /** Outline, background, lightning and thunder settings (checked by cleanLooks in ps.ts). */
  looks: (patch: Partial<Settings>) => Promise<unknown>;
  /** The developer's rule book (views/RuleBook.tsx), the whole list in his order. */
  rules: (list: Rule[]) => Promise<unknown>;
  /** Tasks dragged into a section, or out into a new group (core/groups.ts). */
  moveTasks: (m: TaskMove, make?: { group: TaskGroup; order: string[]; page?: string; pageName?: string; pageOrder?: string[] }) => Promise<unknown>;
  /** A task group taken apart: its tasks go back to Priorities or Every day. */
  ungroup: (id: string) => Promise<unknown>;
  /** Do Not Disturb (core/dnd.ts): on, off, a toggle let through, or when it ends. */
  dnd: (o: DndOp) => Promise<unknown>;
  /** End the day: the same Reset as the To-do page. undoReset puts everything back. */
  reset: () => Promise<unknown>; undoReset: () => Promise<unknown>;
  notifyPref: (on: boolean) => Promise<unknown>;
  stHours: (v: number) => Promise<unknown>;
  /** The glass slider (live while dragging, saved when let go) and the Keep overlay tick (PS). */
  backdrop: (v: number, save: boolean) => Promise<unknown>;
  /** stay (V1.57, leaving Edit): Keep off, but the list stays up, pinned, until the next Tab or a click on empty space. */
  keep: (on: boolean, stay?: boolean) => Promise<unknown>;
  goals: (list: Goal[]) => Promise<unknown>;
  /** A series map note or month title (views/SeriesMap.tsx, opened from the Map pill). */
  journal: (key: string, patch: { title?: string | null; note?: string | null }) => Promise<unknown>;
  /** Why the developer was away (a break's reason) and his saved list of reasons. */
  away: (patch: { awayLog?: AwayEntry[]; awayReasons?: string[] }) => Promise<unknown>;
  /** A meeting taken off the Meetings panel, or put back (core/meethide.ts). PS only: the calendar is never touched. */
  meetHide: (op: MeetHideOp) => Promise<unknown>;
  /** The Meetings panel's refresh: read Google Calendar now (the server only stores it again when it changed). */
  calRefresh: () => Promise<unknown>;
  /** "Link Google": the calendar's secret iCal address, pasted once (calendar-inbox op "link"). */
  calLink: (url: string, feed?: string) => Promise<unknown>;
  /** The gym reminder acknowledged for that day (core/gym.ts): the phone stops ringing, the Mac card goes. */
  gymAck: (day: string) => Promise<unknown>;
} = {
  meetHide: (op) => saveSettings({ meetHidden: applyMeetHide(settingsData(vaultStore.get()).meetHidden, op) }),
  calRefresh: () => calRefreshNow(true),
  calLink: (url, feed) => calLinkNow(url, feed),
  gymAck: (day) => saveSettings({ gymAck: ackGym(settingsData(vaultStore.get()).gymAck, day, Date.now(), homeTz()) }),
  away: (patch) => saveSettings(patch),
  sub: (id, op) => subtaskOp(id, op),
  stHours: (v) => saveSettings({ tmStHours: v }),
  backdrop: async (v, save) => { if (save) await saveSettings({ tmBackdrop: v }); },
  keep: async () => {},
  goals: (list) => saveSettings({ goals: list }),
  journal: (key, patch) => setJournal(key, patch),
  reset: async () => { lastResetUndo = await resetTodos(); },
  rules: (list) => saveSettings({ rules: cleanRules(list) }),
  moveTasks: (m, make) => moveTasks(m, make),
  ungroup: (id) => ungroupTasks(id),
  dnd: (o) => setDnd(o),
  undoReset: async () => { const u = lastResetUndo; lastResetUndo = null; await u?.(); },
  notifyPref: (on) => saveSettings({ tmNotify: on }),
  workStyle: (style) => saveSettings({ tmWorkStyle: style }),
  p1Style: (id) => saveSettings({ tmP1Style: p1Design(id) }),
  looks: (patch) => saveSettings(cleanLooks(patch)),
  suggest: (id, action, place, zone) => action === "add" ? approveSuggestion(id, place) : action === "aware" ? suggestionToAware(id)
    : action === "dimx" ? suggestionToDimx(id, zone ?? "x") : dismissSuggestion(id),
  inboxMin: (at) => saveSettings({ tmInboxMinAt: at }),
  // Notes for calls more than two days gone are dropped on each save.
  meetingNotes: (patch) => saveSettings({
    ...(patch.standingNotes ? { standingNotes: patch.standingNotes } : {}),
    ...(patch.meetingNotes ? { meetingNotes: patch.meetingNotes.filter((n) => Date.parse(n.start) > Date.now() - 2 * 86400_000 && (n.items.length > 0 || (n.doneStanding?.length ?? 0) > 0)) } : {}),
  }),
  timelineHidden: (ids) => saveSettings({ timelineHidden: ids }),
  timelineOrder: (ids) => saveSettings({ timelineOrder: ids }),
  timelines: (list) => saveSettings({ timelines: list }),
  homeTz: (id) => saveSettings({ tmHomeTz: id }),
  headline: (text) => saveSettings({ tmHeadline: text }),
  add: (t) => addTodo({ ...t, order: t.order ?? undefined }),
  sound: (patch) => saveSettings(patch),
  tick: (id, done) => (typeof done === "boolean" ? setTodoDone(id, done) : toggleTodo(id)),
  tickMany: (ids, done) => setTodosDone(ids, done),
  clearDone: (ids, on) => clearTodos(ids, on),
  revive: (ids) => reviveTodos(ids),
  bury: (ids, cleared) => buryTodos(ids, cleared),
  restore: (id, data) => restoreTodo(id, data),
  replyHandled: (id) => setReplyHandled(id, true),
  replyOpen: (cardId) => import("../replyengine").then((m) => m.openReplyFor(cardId)),
  // The PS main window hands it to this Mac's queue; the phone and the website write it to the vault for a Mac to send.
  replyInline: (cardId, text, id) => import("../replyengine").then((m) => m.sendInlineOrSay(cardId, text, id, import.meta.env.MODE === "ps" ? "mac" : isPhoneBuild() ? "phone" : "web")),   // PS main window; the overlay posts it (PsApp.tsx)
  leadDone: async (cardId) => mailCardMessage({ type: "cardAction", id: cardId, action: "dismiss" }),
  waSend: (chatId, text) => import("../core/waactions").then((m) => m.sendWaReply(chatId, text)),
  waTemplate: (chatId, name, language) => import("../core/waactions").then((m) => m.sendWaTemplate(chatId, name, language)),
  waDone: (chatId) => import("../core/waactions").then((m) => m.setWaSeen(chatId)),
  work: (id) => setWorkingOn(id),
  reorder: (ids, p1) => setTodoOrder(ids, p1),
  scale: (percent) => saveSettings({ tmScale: percent }),
  clockScale: (percent) => saveSettings({ tmClockScale: percent }),
  update: (id, patch) => updateTodo(id, patch),
  remove: (id) => deleteTodo(id),
  aware: (list) => saveSettings({ aware: list }),
  awareDone: (id, todoId) => awareDone(id, todoId),
  awareUndone: (item, index, todoId) => awareUndone(item, index, todoId),
  awareToList: (id, order, type, p1) => awareToList(id, order, type, p1),
  dimx: (list) => saveSettings({ dimx: list }),
  editing: (on) => { webEditing = on; },
  clearClipboard: async () => { await navigator.clipboard.writeText(""); },
};
// While you type in the list (editing a task, the converter, Urgent), Tab moves between the
// boxes and letting go of Tab keeps the list open.
let webEditing = false;

export const TM_SCALE_DEFAULT = 85;
export const TM_SOUND_DEFAULT = 40;

const HOLD_MS = 300;

// ---------- keep overlay (PS): the list stays up over other apps until the tick is taken off ----------
export const BACKDROP_DEFAULT = BACKDROP_USUAL;
/** Below this the background is clear enough that every card gets a solid backing (.tm-clear). */
const CLEAR_BELOW = 45;
let keptOn = false, hoverOn = false;
const keptListeners = new Set<() => void>();
/** Hover mode: everything fades out and each part shows only while the mouse is over it. Keeps the list up too. */
function setHover(on: boolean) {
  hoverOn = on;
  if (on && !keptOn) setKept(true); else keptListeners.forEach((l) => l());
}
let rectTimer = 0, lastRects = "";
function setKept(on: boolean, stay?: boolean) {
  keptOn = on;
  if (!on) hoverOn = false;
  keptListeners.forEach((l) => l());
  void taskMapActions.keep(on, !on && stay ? true : undefined);
  // While kept, tell PS where the list's pieces are: clicks anywhere else go to the app behind.
  clearInterval(rectTimer);
  lastRects = "";
  if (on && PS) { rectTimer = window.setInterval(sendRects, 200); sendRects(); }
}
// Pop-ups (Timelines, time zones, New tasks, screen time, the gear...) open outside their pill, so
// their area is sent the moment anything opens, not on the next tick: moving the mouse into a
// fresh pop-up must never fall through to the app behind and close it.
if (PS && typeof window !== "undefined") {
  const soon = () => { if (!keptOn) return; requestAnimationFrame(sendRects); window.setTimeout(sendRects, 90); window.setTimeout(sendRects, 260); };
  window.addEventListener("mouseover", soon, true);
  window.addEventListener("click", soon, true);
}
/** Sleep mode's layers sit on the page's body, outside the list (views/SleepMode.tsx): the card after Wake up, its
 *  note and the settings sheet. V1.41: they were missing here, so while the list was kept (as it is after Wake up on
 *  a Mac) a click on Save or Don't log went through to the app behind. */
export const SLEEP_LAYERS = ".slp-card, .slp-note, .slp-layer, .slp-screen, .slp-cust";
function sendRects() {
  const root = document.querySelector(".tm-overlay:not(.tm-docked)");
  if (!root) return;
  // Edit mode: the whole screen belongs to the list (a drag may cross any part of it).
  if (editingNow()) {
    const rects = [[0, 0, Math.round(window.innerWidth), Math.round(window.innerHeight)]], json = JSON.stringify(rects);
    if (json !== lastRects) { lastRects = json; psPost({ type: "hitRects", rects }); }
    return;
  }
  const sel = ".tm-glass-wrap, .tm-keep:not(.isl-hide), .tm-tr, .tm-tr2, .dnd-btn, .dnd-cog, .sc-btn, .sec-btn, .gs-btn, .tm-side > *, .tm-side > .ed-slot > *, .ed-moved, .ed-corner, .tm-head, .tm-sec, .tm-empty, [role='dialog'], .tm-pop, .stl-tip, "
    + ".tm-tl-panel, .tm-clocks, .tm-cmp, .tm-cmp-sub, .tm-st-pop, .tm-hist, .tm-undo, .tm-aware, .tm-meet, .tm-mn, .nt-pop, .nt-slot.show, .dx-layer";
  // V1.44 #9: the list is clipped under the top bar (--tm-top-band), so what is scrolled up there is not the list's.
  const band = parseFloat((root as HTMLElement).style.getPropertyValue("--tm-top-band")) || 0;
  const rects = [...root.querySelectorAll<HTMLElement>(sel), ...document.querySelectorAll<HTMLElement>(".tm-ghost, .dx-ghost, .tm-ctx, .tm-ctx-ed, " + SLEEP_LAYERS)]
    .map((el) => {
      const r = el.getBoundingClientRect();
      if (!band || !el.closest(".tm-scroll") || r.top >= band) return r;
      return new DOMRect(r.left, band, r.width, Math.max(0, r.bottom - band));
    }).filter((r) => r.width > 0 && r.height > 0)
    .map((r) => [Math.round(r.left) - 10, Math.round(r.top) - 10, Math.round(r.width) + 20, Math.round(r.height) + 20]);
  const json = JSON.stringify(rects);
  if (json !== lastRects) { lastRects = json; psPost({ type: "hitRects", rects }); }
}
/** The list was put away by PS itself: no keep, no hover mode, nothing left polling. */
if (PS && typeof window !== "undefined") (window as { __psUnkeep?: () => void }).__psUnkeep = () => resetKeep();
export function resetKeep() {
  keptOn = false; hoverOn = false;
  clearInterval(rectTimer);
  keptListeners.forEach((l) => l());
}
function useKept() {
  return useSyncExternalStore((l) => { keptListeners.add(l); return () => { keptListeners.delete(l); }; }, () => keptOn);
}
function useHoverMode() {
  return useSyncExternalStore((l) => { keptListeners.add(l); return () => { keptListeners.delete(l); }; }, () => hoverOn);
}

// The liquid glass bar, top middle (PS): Keep overlay and Hover mode, then reset and the transparency slider.
// Left: your screen shows through and the background you chose fades away. Right end: the usual look.
// V1.43 moved the slider to Settings only; V1.44 puts it back here (a friend: "the slider for how visible the
// background is was quite useful... now it seems to be gone"). Settings, Looks, List transparency keeps its copy: both
// drive the same saved value (settings.tmBackdrop, 0 see through to 50 the usual look, core/bgfade.ts) and follow each
// other live (ListTransparency.tsx watchBackdrop).
/** Screen fit (V1.40): the glass bar stays in the middle of the screen as always, unless there it would cover the
 *  clock pill or the top right buttons (a smaller screen, a bigger text scaling, a longer row of buttons). Then it
 *  moves to the free room between them, or just under the buttons with the list moved down to make room
 *  (core/screenfit.ts glassPlace).
 *  V1.44 #9 (ui/relayout.ts): never measured in PS's hidden one pixel window (it used to decide there was no room and
 *  sit over the clock when the list came back), and measured again at once on every size, screen, font and show
 *  change and whenever the bar, the buttons or the clock change size, never on a later frame (a window that was hidden
 *  can hold frames back). It also sets the band at the top where the list fades out (--tm-top-band), so no task ever
 *  shows under Keep overlay, Hover mode or the top right buttons. */
function useGlassPlace(wrap: { current: HTMLDivElement | null }) {
  useLayoutEffect(() => {
    const el = wrap.current, root = el?.closest<HTMLElement>(".tm-overlay");
    if (!el || !root) return;
    const band = (moved: boolean) => {
      const inner = root.querySelector<HTMLElement>(".tm-inner");
      if (!inner) return;
      const ir = inner.getBoundingClientRect(), pieces: DOMRect[] = [];
      if (!moved) pieces.push(el.getBoundingClientRect());   // moved by hand it can be anywhere: not part of the top bar
      root.querySelectorAll<HTMLElement>(".tm-tr, .tm-tr2").forEach((n) => { if (getComputedStyle(n).display !== "contents") pieces.push(n.getBoundingClientRect()); });
      const y = topBand(pieces, { left: ir.left, right: ir.right });
      if (y) { root.style.setProperty("--tm-top-band", `${y}px`); root.dataset.band = ""; }
      else { root.style.removeProperty("--tm-top-band"); delete root.dataset.band; }
    };
    const place = () => {
      if (tucked()) return;   // PS's hidden one pixel window: the bar keeps its last good place (ui/relayout.ts)
      const tr = root.querySelector<HTMLElement>(".tm-tr"), scroll = root.querySelector<HTMLElement>(".tm-scroll");
      const ck = root.querySelector<HTMLElement>(".tm-left .tm-ckdock") || root.querySelector<HTMLElement>(".tm-left > *");
      // Measured at its usual place: the overrides come off first (no paint happens in between).
      el.style.removeProperty("--tm-gx"); el.style.removeProperty("--tm-gy"); root.style.removeProperty("--tm-glass-low");
      if (!tr || el.parentElement?.closest("[data-slot][style]")) { delete root.dataset.glass; band(true); return; }   // moved by hand (Edit mode, V1.40): left where it was put
      const g = el.getBoundingClientRect(), t = tr.getBoundingClientRect(), vw = root.clientWidth;
      const cs = scroll ? getComputedStyle(scroll) : null;
      const spot = glassPlace({
        vw, gw: g.width, gh: g.height, trLeft: t.left, trBottom: t.bottom, leftRight: ck ? ck.getBoundingClientRect().right : 0,
        listL: cs ? parseFloat(cs.paddingLeft) || 0 : 0, listR: vw - (cs ? parseFloat(cs.paddingRight) || 0 : 0), top: g.top,
      });
      root.dataset.glass = spot.spot;
      if (spot.spot !== "middle") {
        el.style.setProperty("--tm-gx", `${spot.cx}px`);
        el.style.setProperty("--tm-gy", `${spot.top}px`);
        if (spot.spot === "below") root.style.setProperty("--tm-glass-low", `${Math.round(spot.top + g.height + 18)}px`);
      }
      band(false);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(root);
    ro.observe(el);
    root.querySelectorAll(".tm-tr, .tm-tr2, .tm-left .tm-ckdock").forEach((n) => ro.observe(n));
    const off = onRelayout(place);
    return () => { ro.disconnect(); off(); };
  }, [wrap]);
}

/** Island clearance (V1.53, the developer 12 Nov 2026: "the dynamic island is STILL over the top two buttons ... nothing is over
 *  anything"). The Mac app says where the Dynamic Island is (ui/islandspot.ts); core/islandclear.ts works out where
 *  Keep overlay and Hover mode go so neither touches it (left and right of it, or both to the side with room), and
 *  whether the slider is under the island's open view. They glide there with the island's own spring and glide back
 *  when it goes. Only `translate` and `opacity` change: nothing else on the list moves or lays out again. Measured
 *  from the layout (offsets), never from where a button is mid glide. */
const CLEAR_BLOCKS = ".tm-tr, .tm-tr2, .ed-corner, .ed-moved, .tm-side > :not(.ed-slot), .tm-side > .ed-slot > *";
/** The top row's own buttons, one by one (each sits in an Edit mode slot that is display: contents). */
const UNDER_ISLAND = ".tm-tr > .ed-slot > *, .tm-tr > :not(.ed-slot):not(.tm-tr2), .tm-tr2 > .ed-slot > *, .tm-tr2 > :not(.ed-slot), .ed-corner";
function useIslandClear(wrap: { current: HTMLDivElement | null }) {
  useLayoutEffect(() => {
    const el = wrap.current, root = el?.closest<HTMLElement>(".tm-overlay");
    if (!el || !root || !PS) return;
    let last = NO_CLEAR;
    // Where a piece sits in the layout, ignoring any glide: the bar's box plus the piece's offset in it (scaled like the bar).
    const laid = (n: HTMLElement): Box => {
      const w = el.getBoundingClientRect(), k = el.offsetWidth ? w.width / el.offsetWidth : 1;
      let x = 0, y = 0;
      for (let p: HTMLElement | null = n; p && p !== el; p = p.offsetParent as HTMLElement | null) { x += p.offsetLeft; y += p.offsetTop; }
      return { left: w.left + x * k, top: w.top + y * k, right: w.left + (x + n.offsetWidth) * k, bottom: w.top + (y + n.offsetHeight) * k };
    };
    const put = (n: HTMLElement | null, dx: number, was: number, hide: boolean) => {
      if (!n) return;
      // Going back towards its place it waits a breath, so the island has started to shrink before the button arrives.
      n.style.setProperty("--isl-wait", Math.abs(dx) < Math.abs(was) ? "60ms" : "0ms");
      n.style.setProperty("--isl-dx", `${dx}px`);
      n.classList.toggle("isl-hide", hide);
    };
    const apply = () => {
      if (tucked()) return;   // PS's hidden one pixel window: measured again when the list comes back (ui/relayout.ts)
      const [keep, hover] = el.querySelectorAll<HTMLElement>(".tm-keep");
      const slider = el.querySelector<HTMLElement>(".tm-glass");
      if (!keep || !hover) return;
      const island = islandBox();
      const o = !island ? NO_CLEAR : islandClear({
        island, keep: laid(keep), hover: laid(hover), slider: slider ? laid(slider) : null, vw: root.clientWidth,
        blocks: [...root.querySelectorAll<HTMLElement>(CLEAR_BLOCKS)].filter((b) => !el.contains(b) && !b.contains(el))
          .map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
      });
      el.classList.toggle("isl-now", islandInstant());   // the list is opening: everything already in place, no glide
      put(keep, o.keepDx, last.keepDx, o.keepHide);
      put(hover, o.hoverDx, last.hoverDx, o.hoverHide);
      slider?.classList.toggle("isl-hide", o.sliderHide);
      // The island's open view is wider than the bar: a top right button it reaches over fades while it is open
      // (a 13 to 15 inch screen: the first one, screen time), and fades back when it closes.
      root.querySelectorAll<HTMLElement>(UNDER_ISLAND).forEach((n) => {
        const r = n.getBoundingClientRect(), under = !!island && r.width > 0 && near({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, island, 4, 0);
        if (under === n.classList.contains("isl-under")) return;
        n.classList.toggle("isl-under", under);
        if (!under) { n.classList.add("isl-back"); window.setTimeout(() => n.classList.remove("isl-back"), 360); }
      });
      if (o.layout === "none") delete el.dataset.isl; else el.dataset.isl = o.layout;
      // The pop-ups in the middle of the list (New tasks, Add task) keep below the island too (taskmap.css --isl-bottom).
      // V1.55 small screens: only while the island is up top (core/islandclear.ts topIsland); moved down to a corner it
      // used to push the Add task window off the bottom of the screen.
      const up = topIsland(island, root.clientHeight);
      if (up) root.style.setProperty("--isl-bottom", `${Math.round(up.bottom)}px`); else root.style.removeProperty("--isl-bottom");
      last = o;
    };
    apply();
    const offIsl = onIsland(apply), offRe = onRelayout(apply);
    const ro = new ResizeObserver(apply);
    ro.observe(root); ro.observe(el);
    return () => { offIsl(); offRe(); ro.disconnect(); };
  }, [wrap]);
}

function GlassBar({ saved, kept, hover, onKeep, onHover }: { saved: number; kept: boolean; hover: boolean; onKeep: (on: boolean) => void; onHover: (on: boolean) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  useGlassPlace(wrap);
  useIslandClear(wrap);
  const [value, setValue] = useState(saved);
  useEffect(() => { setValue(saved); }, [saved]);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  // The Settings copy moving: this one follows it; null puts the saved value back.
  useEffect(() => watchBackdrop((pv) => setValue(pv ?? savedRef.current)), []);
  // One update per frame while dragging, however fast the slider moves. Shown straight on the page (the list never
  // redraws, so it stays smooth) and on the Mac's own glass; saved when you let go.
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const input = (v: number) => {
    setValue(v);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => { previewBackdrop(v); void taskMapActions.backdrop(v, false); });
  };
  const commit = (v: number) => {
    cancelAnimationFrame(raf.current);
    if (v === savedRef.current) { previewBackdrop(null); void taskMapActions.backdrop(v, false); }
    else { previewBackdrop(v); void taskMapActions.backdrop(v, true); }   // shown now, kept once PS has saved it
  };
  if (!PS) return null;   // the website and the phone: the list does not float over your screen there (as in Settings)
  const pct = transparencyOf(value);
  return (
    <div ref={wrap} className="tm-glass-wrap" onMouseDown={(e) => e.stopPropagation()}>
      {(
        <div className="tm-glass-row">
        <button type="button" className={`tm-keep${kept ? " on" : ""}`} aria-pressed={kept} onClick={() => { sfx.click(); onKeep(!kept); }}
          title={kept ? "Untick to put the list away" : "Keep the list up while you use other apps"}>
          <span className="tm-keep-box" aria-hidden="true">{kept && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}</span>
          Keep overlay
        </button>
        <button type="button" className={`tm-keep${hover ? " on" : ""}`} aria-pressed={hover} onClick={() => { sfx.click(); onHover(!hover); }}
          title={hover ? "Show the whole list again" : "See your screen; parts of the list appear only where your mouse is"}>
          <span className="tm-keep-box" aria-hidden="true">{hover && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}</span>
          Hover mode
        </button>
        </div>
      )}
      <div className="tm-glass">
        <button type="button" className="tm-glass-reset" onClick={() => { sfx.click(); setValue(BACKDROP_USUAL); commit(BACKDROP_USUAL); }}
          aria-label="Back to the usual look" title="Back to the usual look">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        </button>
        <svg className="tm-glass-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8" strokeDasharray="2 3" /></svg>
        <input type="range" min={0} max={BACKDROP_USUAL} step={1} value={value} className="tm-glass-range" aria-label="List transparency"
          aria-valuetext={pct === 0 ? "The usual look" : `${pct}% see through`}
          title={pct === 0 ? "List transparency: the usual look. Slide left to see your screen" : `List transparency: ${pct}%`}
          style={{ ["--p" as string]: `${(value / BACKDROP_USUAL) * 100}%` }}
          onChange={(e) => input(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))} />
        <svg className="tm-glass-ic" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
      </div>
    </div>
  );
}

// ---------- undo: tasks you ticked off by mistake come straight back ----------
// Kept outside the list so it survives the list closing and opening again (last 10, for 15 minutes).
type UndoEntry = { id: string; title: string; at: number; reset?: boolean; aware?: { item: AwareItem; index: number; todoId: string }; run?: () => void };
let lastResetUndo: (() => Promise<void>) | null = null;
let undoStack: UndoEntry[] = [];
const undoListeners = new Set<() => void>();
const undoEmit = () => undoListeners.forEach((l) => l());
function pushUndo(e: Omit<UndoEntry, "at">) { undoStack = [...undoStack.filter((x) => x.id !== e.id), { ...e, at: Date.now() }].slice(-10); undoEmit(); }
/** Anything else Undo (and Cmd+Z) can take back, eg a mini task ticked or deleted. */
export function pushUndoAction(id: string, title: string, run: () => void) { pushUndo({ id, title, run }); }
function useUndo() {
  return useSyncExternalStore((l) => { undoListeners.add(l); return () => { undoListeners.delete(l); }; }, () => undoStack);
}
function undoLast() {
  const fresh = undoStack.filter((x) => Date.now() - x.at < 15 * 60_000);
  const last = fresh[fresh.length - 1];
  undoStack = fresh.slice(0, -1);
  undoEmit();
  if (!last) return;
  sfx.click();
  if (last.reset) void taskMapActions.undoReset();               // puts the whole list back as it was
  else if (last.aware) void taskMapActions.awareUndone(last.aware.item, last.aware.index, last.aware.todoId);   // an Urgent tick
  else if (last.run) last.run();                                // a mini task ticked or deleted
  else sendTick(last.id, false);                                // back on the list (not done), at once
}

function typing(el: Element | null) {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(h.tagName)
    || !!h.closest(".nt-win, [role='dialog']:not(.tm-overlay), .scrim, .sm-overlay");
}

// The developer's own background videos never show on anyone else's account (the native shell also keeps them off).
function useBgVideos() {
  const v = usePsBgVideos();
  return isRedAccount(useVault()) ? v : [];
}

export function TaskMap() {
  const [open, setOpen] = useState(false);
  const downAt = useRef(0);
  const pinned = useRef(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Holding Tab and pressing 1: the Add task window (the 1 is never typed anywhere).
      if (e.key === "1" && downAt.current && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        if (e.repeat) return;
        pinned.current = true;
        if (!open) setOpen(true);
        openAddTask("tab");
        return;
      }
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!open && typing(document.activeElement)) return;
      if (!open && psIsOpen()) return; // PS, the Mac app, is open: its own overlay handles Tab
      if (open && webEditing) return;  // typing in the list: Tab moves to the next box
      e.preventDefault();
      if (e.repeat) return;
      primeSfx();
      if (open && pinned.current) { pinned.current = false; setOpen(false); return; }
      downAt.current = Date.now();
      setOpen(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !downAt.current) return;
      const held = Date.now() - downAt.current;
      downAt.current = 0;
      if (addOpen) { pinned.current = true; return; }                     // Tab+1 opened Add task: stay
      if (held >= HOLD_MS && webEditing) pinned.current = true;          // started typing: stay open
      else if (held >= HOLD_MS) { pinned.current = false; setOpen(false); }   // held: peek only
      else pinned.current = true;                                         // tapped: stays open
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && open) { e.preventDefault(); pinned.current = false; webEditing = false; setOpen(false); } };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("keydown", esc); };
  }, [open]);

  if (!open) return null;
  return <Overlay onClose={() => { pinned.current = false; webEditing = false; setOpen(false); }} />;
}

const isField = (el: EventTarget | null) => el instanceof HTMLElement
  && (el.matches("textarea, select, [contenteditable='true']") || (el.matches("input") && (el as HTMLInputElement).type !== "range"));

// A click on a task shows "Working on" at once. In PS the floating list waits for the main window
// to save and send the list back, which can take a moment; without this the click looked missed and
// a second click undid it. Each entry: what the row shows, toggles not yet seen in the saved list,
// the saved value last seen. It goes when every toggle has come back, or after 6 s.
const workPend = new Map<string, { on: boolean; n: number; last: boolean; at: number }>();
const workSubs = new Set<() => void>();
let workVer = 0;
const workChanged = () => { workVer++; workSubs.forEach((f) => f()); };
function clickWork(id: string, shown: boolean, saved: boolean) {
  if (clickAlreadyHandled(lastPress, id, Date.now())) return;   // the press already did it (pressRow)
  const p = workPend.get(id);
  workPend.set(id, { on: !shown, n: (p?.n ?? 0) + 1, last: p?.last ?? saved, at: Date.now() });
  workChanged();
  void taskMapActions.work(id);
}
// A press anywhere on a task card (core/press.ts): white on the mouse down, the action on the mouse
// up, never lost to a redraw between the two. A press that turns into a drag does nothing.
let lastPress: { id: string; at: number } | null = null;
function pressRow(e: React.PointerEvent<HTMLLIElement>, id: string, shown: boolean) {
  if (!pressStarts({ button: e.button, pointerType: e.pointerType, meta: e.metaKey, onControl: !!(e.target as HTMLElement).closest(ROW_CONTROLS) })) return;
  const li = e.currentTarget, sx = e.clientX, sy = e.clientY, pid = e.pointerId;
  const lit = !shown && !li.classList.contains("working");
  li.classList.add("pressing");
  if (lit) li.classList.add("working");
  const off = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    li.classList.remove("pressing");
  };
  const cancel = () => { off(); if (lit) li.classList.remove("working"); };
  const move = (m: PointerEvent) => { if (m.pointerId === pid && pressMoved(m.clientX - sx, m.clientY - sy)) cancel(); };
  const up = (u: PointerEvent) => {
    if (u.pointerId !== pid) return;
    if (pressMoved(u.clientX - sx, u.clientY - sy)) { cancel(); return; }
    off();
    lastPress = null;
    clickWork(id, shown, workingIdsOf(settingsData(vaultStore.get())).includes(id));
    lastPress = { id, at: Date.now() };
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
}

// ---------- ticks (V1.34, core/press.ts says why) ----------
// A press on a tick shows at once: the row turns ticked, stays in its place for a moment, then slides down to
// Completed (or leaves the list, if the developer chose Disappear). The saved list catches up behind it; until it does the
// pending tick is what the row shows. Kept outside the list so a pending tick survives the list closing.
const tickPend = new Map<string, TickPend & { moved?: boolean }>();
/** Tasks Clear took out of Completed, hidden at once until the saved list agrees (or 6 s pass). */
const clearPend = new Map<string, number>();
const tickSubs = new Set<() => void>();
let tickVer = 0;
const tickChanged = () => { tickVer++; tickSubs.forEach((f) => f()); };
export function useTickVer() {
  return useSyncExternalStore((l) => { tickSubs.add(l); return () => { tickSubs.delete(l); }; }, () => tickVer);
}
const savedTodo = (id: string) => vaultStore.get().docs.get(id)?.data as Todo | undefined;
// Where a row was just before it moves to another section: the row in its new place slides in from there.
const flipFrom = new Map<string, { x: number; y: number; at: number }>();
function noteFlip(id: string) {
  const el = document.querySelector<HTMLElement>(`.tm-overlay:not(.tm-docked) .tm-list > .tm-row[data-id="${CSS.escape(id)}"]`)
    || document.querySelector<HTMLElement>(`.tm-list > .tm-row[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  flipFrom.set(id, { x: r.left, y: r.top, at: Date.now() });
}
/** On a row's first paint: if it just left another section, it glides from there to here. */
export function useFlipIn(id: string) {
  const el = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const f = flipFrom.get(id), n = el.current;
    flipFrom.delete(id);
    if (!f || !n || Date.now() - f.at > 1500 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = n.getBoundingClientRect(), dx = f.x - r.left, dy = f.y - r.top;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    n.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 6 }, { transform: "none", zIndex: 6 }],
      { duration: Math.min(620, 300 + Math.abs(dy) / 4), easing: "cubic-bezier(.22,1,.36,1)" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return el;
}
// A row that just slid away leaves room the next row jumps into: a press there in the next moment was aimed at the
// row that left, so it is not taken as a tick of the row that came up.
let slidAt = 0, slidId = "";
let sweepT = 0;
function sweepTicks() {
  window.clearTimeout(sweepT); sweepT = 0;
  const now = Date.now();
  let changed = false, next = Infinity;
  for (const [id, p] of tickPend) {
    const saved = !!savedTodo(id)?.done;
    if (!p.moved && !tickStays(p, now)) {
      // Its moment in place is over: it moves now (to Completed, or off the list). Note where it was first.
      p.moved = true; changed = true;
      if (p.done) { noteFlip(id); slidAt = now; slidId = id; }
    }
    if (tickSettled(saved, p, now)) { tickPend.delete(id); changed = true; continue; }
    next = Math.min(next, tickStays(p, now) ? p.at + TICK_STAY_MS : p.at + TICK_PEND_MS + 1);
  }
  for (const [id, at] of clearPend) {
    const d = savedTodo(id);
    if (!d || d.clearedAt || now - at > TICK_PEND_MS) { clearPend.delete(id); changed = true; }
    else next = Math.min(next, at + TICK_PEND_MS + 1);
  }
  if (changed) tickChanged();
  if (next < Infinity) sweepT = window.setTimeout(sweepTicks, Math.max(16, next - now + 5));
}
/** Send one tick that says which way, and show it straight away. */
export function sendTick(id: string, done: boolean) {
  const t = savedTodo(id);
  // Unticked out of Completed: it glides back up to its old place. (A tick glides down after its moment in place.)
  if (!done && t && t.type !== "daily") noteFlip(id);
  tickPend.set(id, { done, at: Date.now(), moved: !done });
  tickChanged();
  sweepTicks();
  void taskMapActions.tick(id, done);
}
/** The same for several tasks at once (Resurrect and its Undo). */
export function sendTicks(ids: string[], done: boolean) {
  const at = Date.now();
  for (const id of ids) tickPend.set(id, { done, at: done ? at - TICK_STAY_MS : at, moved: true });
  tickChanged();
  sweepTicks();
  void taskMapActions.tickMany(ids, done);
}
/** Complete all (V1.47): every open task on the list ticked at once. Each row crosses out in turn from the top, holds
 *  a moment, then slides down to Completed in the same order (a short cascade, under a second however long the list). */
export function sendCompleteAll(ids: string[]) {
  if (!ids.length) return;
  const at = Date.now(), reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = reduce ? 0 : Math.min(70, Math.floor(900 / ids.length));
  const rows: HTMLElement[] = [];
  ids.forEach((id, i) => {
    tickPend.set(id, { done: true, at: at + i * step });
    document.querySelectorAll<HTMLElement>(`.tm-list > .tm-row[data-id="${CSS.escape(id)}"]`).forEach((el) => { el.style.setProperty("--tm-cas", `${i * step}ms`); rows.push(el); });
  });
  window.setTimeout(() => rows.forEach((el) => el.style.removeProperty("--tm-cas")), ids.length * step + TICK_STAY_MS + 400);
  tickChanged();
  sweepTicks();
  void taskMapActions.tickMany(ids, true);
}
/** Resurrect (V1.47): the tasks come back open, the cleared ones too. `cleared` are the ones a reset or Clear took
 *  off (they show once the saved list has them again). */
export function sendRevive(ids: string[], cleared: string[]) {
  const at = Date.now();
  for (const id of ids) { tickPend.set(id, { done: false, at, moved: true }); clearPend.delete(id); }
  tickChanged();
  sweepTicks();
  void (cleared.length ? taskMapActions.revive(ids) : taskMapActions.tickMany(ids, false));
}
/** Resurrect's Undo: back to done, and the cleared ones off the list again. */
export function sendBury(ids: string[], cleared: string[]) {
  const at = Date.now();
  for (const id of ids) tickPend.set(id, { done: true, at: at - TICK_STAY_MS, moved: true });
  for (const id of cleared) clearPend.set(id, at);
  tickChanged();
  sweepTicks();
  void (cleared.length ? taskMapActions.bury(ids, cleared) : taskMapActions.tickMany(ids, true));
}
/** Clear (and its Undo): those tasks leave Completed at once. */
export function sendClear(ids: string[], on: boolean) {
  const at = Date.now();
  for (const id of ids) { if (on) clearPend.set(id, at); else clearPend.delete(id); }
  tickChanged();
  sweepTicks();
  void taskMapActions.clearDone(ids, on);
}
/** Delete from the right click menu or the editor: gone at once, and Undo (bottom right, Cmd+Z) puts it back with
 *  its own id and everything it had. Never a delete without Undo. */
export function deleteTask(id: string) {
  const t = savedTodo(id);
  if (!t) return;
  const data: Todo = { ...t };
  sfx.drop();
  clearPend.set(id, Date.now());   // hidden at once while the delete goes round
  tickChanged();
  sweepTicks();
  pushUndoAction(`del:${id}`, `Delete ${t.title}`, () => {
    clearPend.delete(id);
    tickChanged();
    void taskMapActions.restore(id, data);
  });
  void taskMapActions.remove(id);
}
/** What the row shows: done or not, and whether it is still in its moment in place. */
export function tickView(id: string, saved: boolean) {
  const p = tickPend.get(id);
  return { done: tickShown(saved, p), stays: tickStays(p, Date.now()) };
}
/** One tick of a task (the tick button, the right click menu, the Overdue card): the opposite of what it shows. */
export function tickTask(id: string, opts: { quiet?: boolean } = {}) {
  const t = savedTodo(id);
  if (!t) return;
  const want = tickWant(!!t.done, tickPend.get(id));
  if (!opts.quiet) { if (want) { sfx.done(); pushUndo({ id, title: t.title }); } else sfx.click(); }
  sendTick(id, want);
}
/** The whole list as the rows should show it: pending ticks applied, a task still in its moment in place kept
 *  where it was (open), and the ones Clear just took out left out. */
function withTicks(all: Doc<Todo>[]): { docs: Doc<Todo>[]; stay: Set<string> } {
  if (!tickPend.size && !clearPend.size) return { docs: all, stay: new Set() };
  const now = Date.now(), stay = new Set<string>();
  const docs = all.filter((d) => !clearPend.has(d.id)).map((d) => {
    const p = tickPend.get(d.id);
    if (!p || (p.done === !!d.data.done && !tickStays(p, now))) return d;
    const daily = d.data.type === "daily";
    const holds = !daily && tickStays(p, now);
    if (holds) stay.add(d.id);
    const done = holds ? false : p.done;
    return { ...d, data: { ...d.data, done, doneAt: done ? d.data.doneAt || new Date(p.at).toISOString() : null } };
  });
  return { docs, stay };
}
// The press on a tick (core/press.ts): it counts on its own mouse up, wherever the pointer is by then, once.
let tickPressed: { id: string; at: number } | null = null;
export function pressTick(e: React.PointerEvent, id: string, act: () => void) {
  if (!tickPressStarts({ button: e.button, pointerType: e.pointerType, meta: e.metaKey })) return;
  const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
  const off = () => { window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", off, true); };
  const up = (u: PointerEvent) => {
    if (u.pointerId !== pid) return;
    off();
    if (tickMoved(u.clientX - sx, u.clientY - sy)) return;
    if (Date.now() - slidAt < 220 && slidId !== id) return;   // the row under the pointer just jumped up into this spot
    tickPressed = { id, at: Date.now() };
    act();
    // The click WebKit may still send for this press (on the tick, or on whatever is under the pointer now) is not a second one.
    const stop = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 300);
  };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", off, true);
}
/** The tick's click: the keyboard (Enter, Space), a touch, or an assistive tool. A mouse press already counted. */
export function clickTick(id: string, act: () => void) {
  if (clickAlreadyHandled(tickPressed, id, Date.now())) return;
  if (Date.now() - slidAt < 220 && slidId !== id) return;
  act();
}
function useWorking(saved: Set<string>) {
  const [ver, setVer] = useState(workVer);
  useEffect(() => { const f = () => setVer(workVer); workSubs.add(f); return () => void workSubs.delete(f); }, []);
  useEffect(() => {
    let gone = false;
    for (const [id, p] of workPend) {
      const now = saved.has(id);
      if (now !== p.last) { p.last = now; p.n--; }
      if (p.n <= 0 || Date.now() - p.at > 6000) { workPend.delete(id); gone = true; }
    }
    if (gone) workChanged();
    if (!workPend.size) return;
    const t = window.setTimeout(() => {
      for (const [id, p] of workPend) if (Date.now() - p.at > 6000) workPend.delete(id);
      workChanged();
    }, 6100);
    return () => window.clearTimeout(t);
  }, [saved, ver]);
  return useMemo(() => {
    const out = new Set(saved);
    for (const [id, p] of workPend) { if (p.on) out.add(id); else out.delete(id); }
    return out;
  }, [saved, ver]);
}

// Counts up the moment the next task turns overdue, and when the page comes back (a timer can sleep
// through a Mac's sleep), so the Overdue card moves tasks across live without polling.
// Completed keeps today's ticks (or the last 7 or 30 days): at the reset time in the developer's zone (midnight unless he changed
// it, core/resetday.ts) the oldest day leaves.
function useRollTick(tz: string, atMin: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setN((x) => x + 1), Math.max(1000, Math.min(nextRollAt(Date.now(), tz, atMin) - Date.now() + 500, 3600_000)));
    const back = () => { if (document.visibilityState === "visible") setN((x) => x + 1); };
    document.addEventListener("visibilitychange", back);
    return () => { clearTimeout(id); document.removeEventListener("visibilitychange", back); };
  }, [tz, atMin, n]);
  return n;
}
function useOverdueTick(s: ReturnType<typeof useVault>, tz: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    const at = nextOverdueAt(todos(s), Date.now(), tz);
    const id = at == null ? 0 : window.setTimeout(bump, Math.max(1000, Math.min(at - Date.now() + 250, 3600_000)));
    const back = () => { if (document.visibilityState === "visible") bump(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => { clearTimeout(id); document.removeEventListener("visibilitychange", back); window.removeEventListener("focus", back); };
  }, [s, tz, n]);
  return n;
}

// hint: the old line of help under the headline (V1.34: gone, the developer "let's simplify that"; every caller only passed fixed
// help text, no live message, so nothing moved elsewhere). Still accepted so the callers need no change.
// web (V1.44, the developer: "the same design as the Tab overlay but in web app form"): the website's To-do page draws the whole
// Tab list as the page itself (views/WebTodo.tsx). It stays `docked` for who owns the windows (they open over the page),
// but looks like the floating list: looks, backgrounds, rain, the G Squad window. What needs the Mac (holding Tab,
// the island, the mixer, screen time, AFK, Edit mode, Second Computer, the padlock) is left out (core/webtodo.ts).
export function Overlay({ onClose, controls, docked, web, footer }: { onClose: () => void; hint?: string; controls?: ReactNode; docked?: boolean; web?: boolean; footer?: ReactNode }) {
  // `floating`: drawn like the floating Tab list (PS on a Mac, or the website's To-do page in web form).
  const floating = !docked || !!web;
  const shows = (slot: string) => !web || webShows(slot);
  const s = useVault();
  const st = settingsData(s);
  const saved = useMemo(() => new Set(workingIdsOf(st)), [st]);
  const working = useWorking(saved);
  setHomeTz(st.tmHomeTz);
  const volume = st.tmSound ?? TM_SOUND_DEFAULT, muted = !!st.tmMuted;
  setSfxVolume(muted ? 0 : volume);
  setTickSound(tickSoundOf(st));   // the tick sound the developer picked (Settings, To do list, V1.34)
  const t = todayISO();
  // Every section's tasks (core/groups.ts). Repeating tasks: the longer ones (every week, month...)
  // wait out of sight until they are due. prio: one ranked list, the Priority 1 group (optional)
  // first, then the rest in order (the tasks in the developer's own groups are not in it). Dates show as tags.
  const groups = useMemo(() => cleanGroups(st.tmGroups), [st.tmGroups]);
  // Tasks 48 hours past their due leave the list for the Overdue card (core/overdue.ts); odTick
  // redraws both the moment the next one turns overdue.
  const odZone = overdueZone(st.tmHomeTz);
  const odTick = useOverdueTick(s, odZone);
  // Ticks show at once (V1.34): the pending ones are applied before the sections are made, and the saved list,
  // when it comes back, settles them. The Completed section (core/completed.ts) sits under everything.
  const tv = useTickVer();
  // V1.55 (the developer: "you can remove the current swipe thing ... No one actually uses it anyway."): the V1.34 row swipe is
  // gone on every device; a sideways swipe anywhere on the list moves between lists (views/ListPager.tsx). Tick, Delete
  // and Resurrect stay in the right click menu, the circle and Completed.
  useEffect(() => { if (tickPend.size || clearPend.size) sweepTicks(); }, [s]);
  const lp = listPrefs(st);
  const dayAt = resetMinOf(st);   // today starts at the reset time (core/resetday.ts)
  const roll = useRollTick(odZone, dayAt);
  // The AI Inbox (core/aiinbox.ts): tasks an AI added, on no list yet; Dimension X shows them.
  const aiInbox = useMemo(() => inboxTasks(todos(s)).filter((d) => !d.data.done), [s]);
  const { lists, overdue, stay, done } = useMemo(() => {
    const { docs: all, stay } = withTicks(todos(s));
    const now = Date.now();
    return { lists: tabLists(all, groups, t, { now, tz: odZone }), overdue: splitOverdue(all.filter((d) => d.data.aiInbox !== true), now, odZone).overdue, stay,
      done: completedOn(lp) ? completedList(all, lp.keep, now, odZone, dayAt) : [] };
  }, [s, t, groups, odZone, odTick, tv, roll, lp.mode, lp.show, lp.keep, dayAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // The end of the list (V1.47): Complete all ticks every open task shown; Resurrect brings back Completed, or when
  // that is empty (after a reset, End day, Clear, Disappear or Completed hidden) the one-offs ticked since yesterday.
  const openIds = useMemo(() => openOnList(lists), [lists]);
  const back = useMemo(() => {
    if (done.length) return done;
    const now = Date.now();
    return resurrectList(allTodos(s).filter((d) => tickPend.get(d.id)?.done !== false && !clearPend.has(d.id)), lp, now, odZone, dayAt);
  }, [s, done, tv, roll, lp.mode, lp.show, lp.keep, odZone, dayAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // V1.57: every completed task there is (the "Show all completed" row at the end of Completed), only while Completed is on.
  // Clear takes tasks out of Completed but they stay in the history, so the ones Clear just hid (clearPend) are put back in.
  const history = useMemo(() => {
    if (!completedOn(lp)) return [];
    const base = allTodos(s);
    const cut = base.filter((d) => clearPend.has(d.id) && d.data.done && tickPend.get(d.id)?.done !== false);
    return allCompletedList([...withTicks(base).docs, ...cut]);
  }, [s, tv, lp.mode, lp.show]); // eslint-disable-line react-hooks/exhaustive-deps
  const { daily, ranked: prio } = lists;
  // developer-only panels (radar, campaign stats, brief, client emails, Telegram and Claude's New tasks). The Meetings
  // panel is everyone's (7 Nov 2026): the developer's from his Google calendar, anyone else's from their Mac's Calendar.
  const red = isRedAccount(s);
  const meet = useMemo(() => upcoming(s), [s]);
  const meetReal = useMemo(() => upcoming(s, meetingEvents(calendarSnap(s)?.data.events ?? [], settingsData(s).calChoices)), [s]);   // only calendars set to Meetings (core/calpick.ts)
  // V1.56 Edit overview sounds (core/editsounds.ts): on unless switched off, quiet under Do Not Disturb and in a meeting.
  setEditSoundCtx({ on: editSoundsOn(st), dndMutesSounds: dndMutes(st.dnd, "sounds", Date.now(), PS ? "mac" : "web"), meetingNow: meetingNow(meetReal) });
  // V1.55: the Mac Calendar's accounts, for a Meetings panel that shows only one (views/EditMode.tsx CalMenu).
  useEffect(() => { if (!red) setMacAccounts(calendarSnap(s)?.data); }, [s, red]);
  // Edit mode (views/EditMode.tsx, G Squad): only the floating list, never the website's To-do page or the phone.
  const editable = !docked && !GOS;
  const layoutDoc = tabLayoutDoc(s);
  const savedLayout = useMemo(() => (layoutDoc ? cleanLayout(layoutDoc.data) : emptyLayout()), [layoutDoc]);
  const layout = useTabLayout(savedLayout);
  // Priority 1, Priorities, Every day and the developer's own task groups go in any order by dragging a
  // section's header (saved in his settings, so PS and the website match). An empty section hides
  // and keeps its place; an empty group still shows, to drop tasks into.
  const fullOrder = sectionOrder(st.tmSecOrder, !!st.tmDailyFirst, groups);
  // Several lists as pages, like the iPhone home screen (V1.55, core/lists.ts, views/ListPager.tsx): each section is on
  // one list; the main list (home) keeps every section no other list claims; lists sit on both sides of it, with an
  // empty + page past each end. Only the page showing is drawn (its neighbours join while a swipe moves).
  const pg = useMemo(() => pagePrefs(st), [st.tmPages, st.tmPageOrder, st.tmNames, st.tmSwipeDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageIds = useMemo(() => pagerIds(pg.order, pg.pages), [pg.order, pg.pages]);
  const curPage = useActivePage(pageIds);
  // The background (Settings > Background): its own layer behind everything, independent of the outline. A page can
  // have its own (V1.55); only the page showing draws it, so only its video plays.
  const bgPrev = useBgPreview();
  const phoneBg = usePhoneBg();   // V1.56: the phone layout's background for the page the phone shows (gos/phonepage.ts)
  const bgLook = bgPrev ?? bgDesign(phoneBg ?? pageBg(pg.pages, curPage.id) ?? shownBg(st));   // a phone can have its own (V1.47, views/BgFit.tsx)
  const bgCrop = usePhoneCrop(st, bgLook);           // and fits a video to its screen (null on the Mac)
  const hover = useHoverMode();
  // The glass slider: the saved look here; while dragging the bar sets it straight on the page
  // (no redraw of the list, so it stays smooth).
  const savedBackdrop = backdropOf(st.tmBackdrop);   // above 50 (the old slider's right half) counts as the usual look
  // The chosen background fades with the slider and is gone at the bottom (core/bgfade.ts, V1.34). Fully gone it is
  // not drawn at all (the video pauses, the storm stops), except while the slider is being dragged, so it can come back.
  const fade = bgFade(hover ? 0 : savedBackdrop);
  // A Looks preview (V1.40, core/lookspreview.ts): the part being previewed must be on screen, so the preview stages
  // what is missing (an example Priority 1 group, the first task as working on, the background at full strength).
  const peekNow = usePeek();
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const firstTask = lists.p1[0]?.id ?? prio[0]?.id ?? daily[0]?.id ?? null;
  const hasWorking = [lists.p1, prio, daily, ...lists.groups.values()].some((l) => l.some((d) => working.has(d.id)));
  const stage = !floating ? NO_STAGE : previewStage(peekNow.part, peekNow.part === "bg" ? bgLook : null, {
    hasP1: lists.p1.length > 0, hasWorking, hasTasks: !!firstTask, bgFade: fade, notebook: NOTEBOOK_IDS.has(resolveAppearance(st).look), reduced: reducedMotion, hasOverdue: overdue.length > 0 });
  useEffect(() => { setPeekNote(stage.note); }, [stage.note]);
  const p1List = stage.sampleP1 ? SAMPLE_P1 : lists.p1;
  const workingShown = useMemo(() => (stage.sampleWorking && firstTask ? new Set([...working, firstTask]) : working), [stage.sampleWorking, firstTask, working]);
  const byPage = secsByPage(fullOrder, pg.pages);
  const knownGroups = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  // An empty section hides on the main list, as before; on the developer's own lists Priorities and Every day stay to drop into.
  const secShown = (k: string, main: boolean) => (k === "p1" ? p1List.length > 0 : k === "prio" ? lists.prio.length > 0 || !main : k === "daily" ? daily.length > 0 || !main : true);
  const secKeys = (byPage.get(curPage.id) ?? []).filter((k) => secShown(k, curPage.id === MAIN));
  const secs = useSectionOrder(secKeys, (next) => {
    const order = mergeOrder(fullOrder, next);
    void taskMapActions.looks({ tmSecOrder: order, tmDailyFirst: order.indexOf("daily") < order.indexOf("prio") });
  }, { onDrop: () => sfx.drop(), onMove: () => window.dispatchEvent(new Event("tm-relayout")) });
  tabNow.full = fullOrder; tabNow.shown = secs.order;
  setListCtx({ lists, full: fullOrder, pages: pg.pages, order: pg.order, names: pg.names, groups, dir: pg.dir, todos: allTodos(s), st });
  // V1.55 Edit mode overview (views/EditMode.tsx): the pages, their names and sections for the cards beside the middle.
  const secTitle = (k: string) => k === "p1" || k === "prio" ? shownName(pg.names, k) : k === "daily" ? shownName(pg.names, "daily", daily.every((d) => isEveryDay(d.data)))
    : groups.find((g) => groupKey(g.id) === k)?.name ?? "";
  if (editable) setOverviewPages({
    ids: pg.order, cur: isPlus(curPage.id) ? MAIN : curPage.id,
    name: (id) => allPages(pg.pages, pg.names, pg.order).find((p) => p.id === id)?.name ?? "",
    secs: (id) => (byPage.get(id) ?? []).filter((k) => secShown(k, id === MAIN)).map(secTitle),
    go: goToPage, jump: jumpToPage, add: newPanelsPage, order: setPageOrder, remove: (id) => deleteList(id, false),
  });
  const ovOn = useEditing();
  useEffect(() => { if (ovOn && isPlus(curPage.id)) goToPage(MAIN); }, [ovOn]); // eslint-disable-line react-hooks/exhaustive-deps
  // PS 1.61: the island's envelope or reply arrow asked for the email panel (core/mailopen.ts): go to the page it sits
  // on; ClientMail then opens the newest email. A panel taken off the Tab list means the island showed no count.
  useEffect(() => {
    const go = () => {
      if (!peekMailOpen()) return;
      const id = mailPanelId(layout);
      if (!id) return;
      const p = pageOf(layout, id, new Set(pageIds));
      if (p !== curPage.id) goToPage(p);
    };
    go();
    return onMailOpen(go);
  }, [layout, pageIds, curPage.id]);
  // Cmd-click picks tasks; Esc, hiding the list or a click on the background lets them go.
  const shownNow = useOverlayShown();
  useEffect(() => { if (!shownNow) clearSel(); }, [shownNow]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && selIds.size) { e.preventDefault(); e.stopImmediatePropagation(); clearSel(); } };
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("keydown", esc, true); clearSel(); };
  }, []);
  // The Priority 1 look (Settings): the saved one, or the one the settings slider is previewing.
  const preview = useP1Preview();
  const design = preview ?? p1Design(st.tmP1Style);
  const hasP1 = lists.p1.length > 0;
  // The Priority 1 colour (the picker in the Priority 1 header): the saved one, or the one being tried.
  const savedP1c = p1Color(st.p1Color);
  const p1c = useP1Colour(savedP1c);
  const p1Fade = useP1ColourFade(p1c);
  const tones = useMemo(() => (p1c ? p1Tones(p1c) : null), [p1c]);
  const shown = useOverlayShown();
  // The developer's own video (PS only, the file stays on his Mac): cover, muted, looping, only while shown.
  const bgVideos = useBgVideos();
  // The look (V1.31, src/looks/engine.ts): App puts it on the whole page; the list only needs to know which it is.
  const workPrev = useWorkPreview();
  const app = useAppearance(st);
  // The V1.30 Light theme inverted the dark list with a filter. Light is a token look now, like the rest: the
  // overlay keeps its tm-light class (the self test looks for it) and looks.css turns the old filter off.
  const lightTheme = floating && app.look === "light";
  // V1.43 List transparency: a solid look (Light, Midnight, the productivity looks) covers your screen with its own
  // backing (looks.css html[data-solid], 96 to 97%). That cover now thins with List transparency too (it used to ignore
  // the glass slider, the main reason it did nothing on most looks). A plain percentage, worked out here: a calc() inside
  // color-mix() is not safe in every browser. PS's floating list only.
  const opaque = !docked && PS ? lookById(app.look).opaque ?? 0 : 0;
  const coverAt = (v: number) => opaque ? `${Math.round(opaque * 100 * backdropOf(v) / BACKDROP_USUAL)}%` : null;
  const workStyle = workStyleOf(workPrev ?? st.tmWorkStyle);
  const nb = !floating || !NOTEBOOK_IDS.has(app.look) ? "off" : app.look;
  // The network monitor's on/off switch lives in the vault settings; PS's native side follows it.
  const netOn = st.netMonitor !== false;
  useEffect(() => { if (PS && !docked) psPost({ type: "net", op: "enable", on: netOn }); }, [netOn, docked]);
  useEffect(() => { if (preview && preview === p1Design(st.tmP1Style)) setP1Preview(null); }, [preview, st.tmP1Style]);
  useEffect(() => { if (bgPrev && bgPrev === bgDesign(shownBg(st))) setBgPreview(null); }, [bgPrev, st.tmBg, st.tmBgPhone]); // eslint-disable-line react-hooks/exhaustive-deps
  const cstats = campaignStats(s)?.data ?? null;
  const clients = useMemo(() => clientViews(s).filter((c) => c.client).map((c) => ({ id: c.client!.id, name: c.name })), [s]);

  // Mouse near the bottom (or top) edge scrolls the list smoothly; the closer, the faster.
  // The frame loop only runs while the mouse is in an edge zone.
  const scroller = useRef<HTMLDivElement>(null);
  const speed = useRef(0);
  const raf = useRef(0);
  const loop = () => {
    if (!speed.current || !scroller.current) { raf.current = 0; return; }
    scroller.current.scrollTop += speed.current;
    raf.current = requestAnimationFrame(loop);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // V1.44 #9: the list box never stays scrolled sideways; on every show, size or screen change it is put straight.
  useEffect(() => onRelayout(() => { const el = scroller.current; if (el?.scrollLeft) el.scrollLeft = 0; }), []);
  // The zone and the curve are shared with the Edit overview's left and right edges (core/overviewnav.ts edgeRamp).
  const EDGE = EDGE_ZONE;
  const onMove = (e: React.MouseEvent) => {
    if (docked || editingNow()) return;   // on the To-do page the page itself scrolls; Edit mode never scrolls the list
    const fromBottom = window.innerHeight - e.clientY, fromTop = e.clientY;
    const ramp = (d: number) => edgeRamp(d);
    // Over the side panels the wheel scrolls them, so the edge scroll stays out of it.
    if ((e.target as Element).closest?.(".tm-side, .tm-tr, .dx-layer")) speed.current = 0;
    else speed.current = fromBottom < EDGE ? ramp(fromBottom) : fromTop < EDGE ? -ramp(fromTop) : 0;
    if (speed.current && !raf.current) raf.current = requestAnimationFrame(loop);
  };

  // Sizes: the sliders preview live and save when you let go.
  // The clock size slider was removed (the developer, 16 Oct): the clocks always use their original size.
  const savedTask = st.tmScale ?? TM_SCALE_DEFAULT;
  const [scale, setScale] = useState(savedTask);
  useEffect(() => { setScale(savedTask); }, [savedTask]);
  // Everything the gear's General page (and the phone's gear sheet) shows.
  const gen: GenProps = {
    volume, muted, soundOff: muted || volume === 0, homeTz: st.tmHomeTz || "", notifyOn: st.tmNotify !== false, notifyLog: st.notifyLog || [], stHours: st.tmStHours ?? 24,
    onMute: () => void taskMapActions.sound(volume === 0 ? { tmSound: TM_SOUND_DEFAULT, tmMuted: false } : { tmMuted: !muted }),
    size: <SizeControl label="Task size" value={scale} min={50} max={130} onInput={setScale} onCommit={(v) => { if (v !== savedTask) void taskMapActions.scale(v); }} />,
  };

  const [editing, setEditingId] = useState<string | null>(null);
  const kept = useKept();
  const [goalsOpen, setGoalsOpen] = useState(false);
  // The phone's menu opens Goals (V1.47, gos/menu.ts): the Plan pane no longer shows Timelines, where its button lives.
  useEffect(() => { const f = () => setGoalsOpen(true); window.addEventListener("ps-open-goals", f); return () => window.removeEventListener("ps-open-goals", f); }, []);
  // V1.55: Open task on a reminder's pop-up (ps-mac Reminders.swift) or notification (ps-gos Remind.kt, gos/GosLayer.tsx):
  // the task scrolls into view and glows for a moment.
  useEffect(() => {
    const w = window as Window & { __psOpenTask?: (id: unknown) => void };
    const f = (id: unknown) => {
      if (!okTaskId(id)) return;
      let tries = 0;
      const find = () => {
        const el = document.querySelector<HTMLElement>(`.tm-row[data-id="${id}"]`);
        if (!el) { if (++tries < 12) window.setTimeout(find, 120); return; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.remove("tm-found"); void el.offsetWidth; el.classList.add("tm-found");
        window.setTimeout(() => el.classList.remove("tm-found"), 2400);
      };
      find();
    };
    w.__psOpenTask = f;
    const ev = (e: Event) => f((e as CustomEvent).detail);
    window.addEventListener("ps-open-task", ev);
    return () => { if (w.__psOpenTask === f) delete w.__psOpenTask; window.removeEventListener("ps-open-task", ev); };
  }, []);
  // Hover mode shows your screen clearly behind (no blur, no tint) and puts it back after.
  useEffect(() => { void taskMapActions.backdrop(hover ? 0 : backdropOf(st.tmBackdrop), false); }, [hover]); // eslint-disable-line react-hooks/exhaustive-deps
  const bg = (e: React.MouseEvent) => { if (e.target !== e.currentTarget) return; clearSel(); if (!kept) onClose(); };
  const look = backdropLook(hover ? 0 : savedBackdrop);
  const [sliding, setSliding] = useState(false);
  // What is drawn behind the list (core/lookspreview.ts bgLayers): a scene round Priority 1, lightning, a video, a
  // colour, and rain in front of them. Something moving or filling the screen gives rows and panels solid backings, so
  // the list itself stays still and readable. (Outlines keep everything inside their own frame.)
  const rainPv = useRainPreview();
  const rainNow = !floating ? "off" : rainKind(rainPv?.kind ?? st.tmRain);
  const rainAmt = rainAmount(rainPv?.amount ?? st.tmRainAmount);
  // The Mouse trail (core/trail.ts, V1.43): Glow is the rows' own CSS light; another effect is one canvas layer.
  const trail = trailOnList(st.tmTrail);
  const layers = bgLayers({ bg: bgLook, docked: !floating, hasP1, fade, sliding, rain: rainNow !== "off", stage });
  const sceneOn = layers.scene, stormOn = layers.storm, colourCss = layers.colour ? colourBgCss(bgLook) : null;
  const videoBg = layers.video ? bgVideos.find((v) => `video:${v.id}` === bgLook) ?? null : null;
  const calm = floating && (sceneOn || stormOn || !!videoBg || !!colourCss || rainNow !== "off");
  const bgOn = fade > 0 || sliding || stage.forceBg;
  // Let go: it stays drawn until the saved value comes back (PS saves through its main window), never blinking.
  useEffect(() => { if (!sliding) return; const t = window.setTimeout(() => setSliding(false), 4000); return () => window.clearTimeout(t); }, [sliding]);
  const slidFrom = useRef(savedBackdrop);
  useEffect(() => { if (slidFrom.current !== savedBackdrop) { slidFrom.current = savedBackdrop; setSliding(false); } }, [savedBackdrop]);
  const root = useRef<HTMLDivElement>(null);
  // List transparency's live preview, from the top bar's slider and from Settings, Looks (both V1.44). Set straight on
  // the page while a slider moves, so the list never redraws; null puts the saved value back.
  useEffect(() => {
    if (!floating) return;
    return setLiveBackdrop((pv) => {
      const v = pv ?? savedBackdrop, l = backdropLook(v), f = bgFade(v);
      if (pv != null && !sliding) setSliding(true);
      root.current?.style.setProperty("--tm-tint", l.tint);
      root.current?.style.setProperty("--tm-blur", l.blur);
      root.current?.style.setProperty("--tm-bgfade", String(f));
      const cv = coverAt(v); if (cv) root.current?.style.setProperty("--tm-cover", cv);
      // The video pauses while it cannot be seen and plays again as it comes back (no redraw of the list).
      const vid = root.current?.querySelector<HTMLVideoElement>("video.tm-bgvideo");
      if (vid && f === 0 && !vid.paused) vid.pause();
      else if (vid && f > 0 && vid.paused && vid.getAttribute("src") && shown) void vid.play().catch(() => {});
      root.current?.classList.toggle("tm-clear", hover || v < CLEAR_BELOW || calm);
    });
  }, [floating, savedBackdrop, sliding, shown, hover, calm, opaque]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Screen fit (V1.40): a pop-up from the top right buttons never runs off the screen (ui/popfit.ts).
  useEffect(() => {
    const tr = !floating ? null : root.current?.querySelector<HTMLElement>(".tm-tr");
    return tr ? keepPopsOnScreen(tr) : undefined;
  }, [floating]);
  // Hover mode: the part of the list under the mouse lights up (tracked here, because PS passes
  // the mouse as plain moves when the list is not the front window, and CSS :hover misses those).
  // A data attribute, not a class: React rewrites a panel's class when it redraws (a clock tick,
  // the New tasks bubble...) and the lit panel went dark under the mouse (18 Oct 2026).
  const lit = useRef<Element | null>(null);
  const light = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.(".tm-side > *, .tm-tr, .tm-head, .tm-sec, .tm-empty, .tm-glass-wrap, .ed-corner") || null;
    if (el === lit.current && (!el || el.hasAttribute("data-hm"))) return;
    if (lit.current !== el) lit.current?.removeAttribute("data-hm");
    el?.setAttribute("data-hm", "");
    lit.current = el;
  };

  return (
    <div ref={root} className={`tm-overlay${docked ? " tm-docked" : ""}${web ? " tm-web" : ""}${hover && !docked ? " tm-hovermode" : ""}${floating && (hover || savedBackdrop < CLEAR_BELOW || calm) ? " tm-clear" : ""}${meet.length ? " has-meet" : ""}${shown ? "" : " tm-paused"}${calm ? " tm-calm" : ""}${editable ? " ed-able" : ""}${lightTheme ? " tm-light" : ""}${opaque ? " tm-see" : ""}${tones ? " p1c" : ""}${p1Fade ? " p1c-fade" : ""} ws-${workStyle}${OWN_WORK.has(workStyle) ? " ws-own" : ""}`}
      role={docked ? "region" : "dialog"} aria-modal={docked ? undefined : true} aria-label="Your to-do map" data-trail={trail.attr}
      style={{ ...trail.glow, ["--tm-z" as string]: scale / 100, ["--ck" as string]: 1, ["--tm-tint" as string]: look.tint, ["--tm-blur" as string]: look.blur, ["--tm-bgfade" as string]: layers.fade,
        ...(coverAt(hover ? 0 : savedBackdrop) ? { ["--tm-cover" as string]: coverAt(hover ? 0 : savedBackdrop) } : {}),
        ...(tones ? { ["--p1col" as string]: tones.c, ["--p1acc" as string]: tones.accent, ["--p1txt" as string]: tones.text, ["--p1fg" as string]: tones.on, ["--p1glow" as string]: tones.rgb } : {}) }}
      onMouseMove={(e) => {
        onMove(e);
        if (hover) light(e.target);
      }} onMouseLeave={() => { speed.current = 0; }} onMouseDown={bg}
      onMouseOver={(e) => { if (hover) light(e.target); }}
      onFocus={(e) => { if (isField(e.target)) taskMapActions.editing(true); }}
      onBlur={(e) => { if (isField(e.target) && !isField(e.relatedTarget) && !dimxIsOpen()) taskMapActions.editing(false); }}>
      <EditScope layout={editable ? layout : null} red={red} page={curPage.id} pages={pg.order}>
      {/* The whole screen points at the group, but only the group's own band moves: the rest of
          the pattern stands still, so nothing outside the outline ever flickers (18 Oct 2026). */}
      {colourCss && bgOn && <div key={bgLook} className="tm-bgcolour" style={{ ["--bgc" as string]: colourCss }} aria-hidden="true" data-bg={bgLook} />}
      {sceneOn && bgOn && <div className={`tm-p1-scene p1s-${bgLook}`} aria-hidden="true"><i /><i className="band" /></div>}
      {videoBg && bgOn && <BgVideoLayer id={videoBg.id} file={videoBg.file} shown={shown} crop={bgCrop} />}
      {videoBg && bgOn && <BgDim saved={st.tmBgVideoBright} />}
      {stormOn && bgOn && <Storm kind={bgLook as StormKind} intensity={st.tmBgIntensity ?? 60} frequency={st.tmBgFrequency ?? 40}
        sound={st.tmBgSound === true} volume={st.tmBgVolume ?? 40} soon={!!bgPrev} />}
      {rainNow !== "off" && <Rain kind={rainNow} amount={rainAmt} />}
      {trail.attr === "fx" && <TrailLayer host={root} kind={trail.kind} prefs={trail.prefs} active={!!docked || shown} />}
      {/* Every panel and button sits in a Slot (views/EditMode.tsx): Edit mode moves or removes it. */}
      <div className="tm-side tm-left">
        <Slot id="clocks"><TimeZones scale={100} slider={null} /></Slot>
        {/* Pomodoro (V1.58, views/Pomodoro.tsx): between Time zones and Sentry mode by default (the developer, 13 Nov 2026); on a
            list where Time zones was moved it follows it (core/tablayout.ts followStyle). */}
        <Slot id="pomodoro"><PomodoroButton docked={docked} /></Slot>
        {/* Sentry mode (V1.48, views/Sentry.tsx): the big AI button between Time zones and Timelines, PS on a Mac only. */}
        {PS && !docked && <Slot id="sentry"><SentryButton docked={docked} /></Slot>}
        <div className="nu-tlrow">
          <Slot id="timelines"><Timelines birthday={st.birthday} items={st.timelines || []} order={st.timelineOrder} hidden={st.timelineHidden}
            onSave={(list) => void taskMapActions.timelines(list)} onOrder={(ids) => void taskMapActions.timelineOrder(ids)}
            onHide={(ids) => void taskMapActions.timelineHidden(ids)} onMap={() => setGoalsOpen(true)} undo={pushUndoAction} /></Slot>
          <Slot id="series"><SeriesPill docked={docked} saves={{ journal: (k, p) => taskMapActions.journal(k, p), goals: (list) => taskMapActions.goals(list) }} /></Slot>
          {/* Numerology is the developer's own: other accounts (the public PS) never see it (the developer, 5 Nov 2026). */}
          {red && <Slot id="numerology"><Numerology saved={st.tmNumPeople} birthday={st.birthday} docked={docked} onSave={(people) => void taskMapActions.looks({ tmNumPeople: people })} /></Slot>}
        </div>
        {/* Meetings: every account (the developer, 7 Nov 2026: "where's a meeting panel"). V1.58: the island's settings button left it;
            they open from the island's own right click menu and from Settings, Dynamic Island. */}
        <Slot id="meetings"><MeetingsPeek list={meet} notes={st.meetingNotes || []} standing={st.standingNotes || []} privateOn={!!st.privateMode} calAt={calendarSnap(s)?.data.at ?? null} local={!red} web={web} /></Slot>
        {/* V1.58 the island's settings window (views/IslandSettings.tsx): Settings in the island's right click menu opens it. */}
        {PS && !docked && <IslandSettingsWindow prefs={islandPrefs(st.island)} save={(p) => void taskMapActions.looks({ island: { ...islandPrefs(st.island), ...p } })} />}
        <div className="tm-xrow">
          {red && CAMPAIGNS_ON && <Slot id="campaigns"><CampaignStats stats={cstats} docked={docked} /></Slot>}
          <Slot id="dimx"><DimensionX prio={prio} aware={st.aware || []} dimx={st.dimx || []} docked={docked} inbox={aiInbox} /></Slot>
          {red && <Slot id="rules"><PsRuleButton docked={docked} /></Slot>}
          <Slot id="fitness"><FitnessButton docked={docked} /></Slot>
          {/* The Soundboard (V1.47, src/soundboard/): audio and video, the player, the queue, timed plays. */}
          <Slot id="soundboard"><SoundboardButton docked={docked} /></Slot>
        </div>
      </div>
      {/* The gear's full screen Settings (views/SettingsScreen.tsx, V1.32): General, Looks and Mac settings. */}
      <SettingsHost st={st} gen={gen} owner={docked ? "docked" : "tab"} />
      {!docked && PS && <SecurityWindow s={s} />}
      {/* Minecraft mode is switched off for now (core/mcmode.ts MINECRAFT_ENABLED): no pop up, no bubble, no hook. */}
      {MINECRAFT_ENABLED && !docked && PS && <MinecraftWindow dnd={st.dnd} events={meetingEvents(calendarSnap(s)?.data.events ?? [], st.calChoices)} />}
      {!docked && <RuleBookHost owner="tab" />}
      {goalsOpen && <GoalsWindow goals={st.goals || []} onSave={(list) => void taskMapActions.goals(list)} onClose={() => setGoalsOpen(false)} />}
      {!docked && (<Slot id="glass">
        <GlassBar saved={savedBackdrop} kept={kept} hover={hover} onHover={setHover} onKeep={(on) => setKept(on)} />
      </Slot>)}
      <div className="tm-tr" onMouseDown={(e) => e.stopPropagation()}>
        {shows("afk") && <Slot id="afk"><AfkBadge /></Slot>}
        {shows("screentime") && <Slot id="screentime"><ScreenTimePop /></Slot>}
        {red && <Slot id="brief"><BriefButton docked={docked} /></Slot>}
        <Slot id="endday"><EndDay dayEnds={st.dayEndsHour ?? DAY_ENDS_DEFAULT} docked={docked} /></Slot>
        {PS && st.netMonitor !== false && <Slot id="net"><NetButton /></Slot>}
        {shows("mixer") && <Slot id="mixer"><MixerButton /></Slot>}
        <Slot id="clipboard"><ClearClipboard /></Slot>
        {/* The gear: on the floating list a click opens the full screen Settings (V1.32); the phone keeps its sheet
            and the website's To-do page its small menu. */}
        <Slot id="gear"><SettingsGear owner={docked ? "docked" : "tab"} /></Slot>
        {controls && <Slot id="pskeys">{controls}</Slot>}
        {/* Do Not Disturb, the far top right (views/Dnd.tsx). The phone has it in its thumb row (gos/GosLayer.tsx). */}
        {/* Minecraft mode has no button here any more (the developer, 4 Nov 2026: "I don't want the pickaxe to be anywhere on my
            main screen"). It is switched off for now (core/mcmode.ts); switched on it opens from the gear, Settings,
            General (views/Minecraft.tsx MinecraftEntry). */}
        {/* G Squad chat on the website (views/GSquadChat.tsx): only for someone in a squad; PS has it in the G Squad pop-up. */}
        {!PS && !web && !isPhoneBuild() && <GSquadChatWeb />}
        {/* V1.47: the phone (GOS, the iPhone web app) has no G Squad button: its hamburger menu calls openGSquad() and
            this host draws the same G Squad screen, laid out for the phone (views/GSquad.tsx GSquadHost). */}
        {isPhoneBuild() && <GSquadHost />}
        {/* The row under the top bar (V1.42): on the floating list these sit in one flex row just under the bar's right
            end, right to left the moon, G Squad, Second Computer, the padlock. Before V1.42 each was placed by hand with
            its own right offset, and G Squad (right 44px) landed on Second Computer (right 42px): on the developer's Mac, where
            Second Computer shows, the two drew as one icon and G Squad could not be seen. A flex row never overlaps,
            and a removed one (Edit mode) closes the gap. Everywhere else (the website, a narrow window) the row is
            display: contents, so the buttons stay in the bar as before. */}
        <div className="tm-tr2">
          {/* Security, the padlock just left of Second Computer (views/Security.tsx, the developer 1 Nov 2026): PS on a Mac only. */}
          {!docked && PS && <Slot id="security"><SecurityButton s={s} /></Slot>}
          {/* Second Computer (views/Second.tsx): it shows only in PS on a Mac, where PS holds the device keys. */}
          {red && <Slot id="second"><SecondButton s={s} /></Slot>}
          {/* G Squad (V1.40, views/GSquad.tsx): just left of the moon, in PS on a Mac, every account. */}
          {((PS && !docked) || web) && <Slot id="gsquad"><GSquadButton /></Slot>}
          {import.meta.env.MODE !== "gos" && <Slot id="dnd"><DndButton st={st} s={s} act={(o: DndOp) => taskMapActions.dnd(o)} homeTz={st.tmHomeTz || undefined} /></Slot>}
        </div>
      </div>
      <div className="tm-side tm-right">
        {(mailOnSnap(s) || waOnSnap(s)) && <Slot id="mail">{mailOnSnap(s) && <ClientMail s={s} mail />}{waOnSnap(s) && <WaMail s={s} />}</Slot>}   {/* WhatsApp rides in the same place as client emails (PS 1.60) */}
        {/* The screen record button (PS 1.60, views/ScreenRec.tsx): right below the email panel, PS on the Mac only, and only once the person switched screen recording on. */}
        {PS && !docked && <Slot id="screenrec"><ScreenRecButton /></Slot>}
        {PS && !docked && <ScreenRecHost />}
        {/* G Squad Priority 1 (PS 1.63, views/SquadP1Panel.tsx): the squad's P1 tasks with their 24 hour clocks, under the email panel, above Sleep. */}
        <Slot id="squadp1"><SquadP1Panel /></Slot>
        <Slot id="meetnotes"><LiveMeetingNotes meet={meet} notes={st.meetingNotes || []} standing={st.standingNotes || []} /></Slot>
        <Slot id="leftovers"><NotesLeftovers /></Slot>
        <Slot id="undo"><UndoButton docked={docked} /></Slot>
        {red && <Slot id="newtasks"><NewTasks list={st.suggestions || []} clients={clients} minAt={st.tmInboxMinAt} docked={docked} prio={prio} daily={daily} /></Slot>}
        <Slot id="overdue"><Overdue list={stage.sampleOverdue ? SAMPLE_OVERDUE : overdue} prio={prio} daily={daily} today={t} look={overdueLookOf(st)} /></Slot>
        {/* Sleep mode (V1.40, V1.47 moved here from the end of the list): the bottom right, level with Dimension X, never
            scrolled away. The phone has it in its thumb row instead (gos/GosLayer.tsx); this column is hidden there. */}
        {!GOS && <Slot id="sleep"><SleepRow where="side" /></Slot>}
      </div>
      {/* Copies from the Edit mode gallery (V1.55): each drawn in its original's column, or at its own place. */}
      <CopySlots />
      {/* V1.56: a page of panels from the phone layout, on the phone only (gos/PhonePages.tsx). */}
      {isPhoneBuild() && <PhoneTilesHost />}
      {/* The right click menu on any task (V1.34, views/TaskMenu.tsx): Edit, Mark done, Priority 1, New date, Copy, Delete. */}
      <TaskMenuHost lists={lists} clients={clients} onEdit={setEditingId} />
      {/* V1.55 lists (views/ListPager.tsx): the page dots at the bottom middle, and the list and section menus. */}
      <ListDots ids={pageIds} index={curPage.index} names={pg.names} />
      <ListMenuHost names={pg.names} dir={pg.dir} />
      {/* Sleep mode: the web sleep screen, the sleep to confirm after Wake up, and its notes (views/SleepMode.tsx). */}
      <SleepHost />
      {/* The list scrolls in its own layer, so the side panels stay put. */}
      <ScrollRail scroller={scroller} />
      <div ref={scroller} className="tm-scroll" onMouseDown={bg} onScroll={noSideways}>
      <div className="tm-inner" onMouseDown={bg}>
        <header className="tm-head">
          <Headline text={st.tmHeadline || "Mission agenda"} />
          <AddTask prio={prio} clients={clients} docked={docked} />
        </header>
        {/* Local first (V1.44, views/LocalFirst.tsx): one line while the data is only on this device, the week old card. */}
        <LocalLine s={s} st={st} />
        {/* Several lists (V1.55): the list's name under the headline (views/ListPager.tsx). */}
        <ListStrip names={pg.names} id={curPage.id} />
        <ListPager ids={pageIds} index={curPage.index} docked={docked} render={(id, here) => {
          if (isPlus(id)) return <PlusPage id={id} here={here} docked={docked} />;   // the empty + page past each end
          // A page of panels (V1.55, made with a + in the Edit mode overview): no tasks, its panels around it. The phone and
          // the website's To-do page have no panels around the list, so they say where they are.
          if (pg.pages.find((p) => p.id === id)?.kind === "panels" && !(byPage.get(id) ?? []).length) {
            const none = editable && !onPage(layout, id, red, new Set(pg.order)).length;
            return editable ? (none ? <p className="tm-empty ov-empty-page">An empty page. Press Edit, top left, then Add panel.</p> : null)
              : <p className="tm-empty">This page holds panels. They show on your Mac and in the Tab list on the website.</p>;
          }
          const main = id === MAIN;
          const keys = here ? secs.order : (byPage.get(id) ?? []).filter((k) => secShown(k, main));
          const mine = <T extends { id: string; data: Todo }>(l: T[]) => (pg.pages.length ? l.filter((d) => pageOfTask(d.data, knownGroups, pg.pages) === id) : l);
          const openHere = pg.pages.length ? openIds.filter((x) => { const d = s.docs.get(x); return d?.kind === "todo" && pageOfTask(d.data as Todo, knownGroups, pg.pages) === id; }) : openIds;
          return (<>
            {keys.map((k) => {
              const common = { skey: k, working: workingShown, today: t, editing, onEdit: setEditingId, clients, move: here ? secs : undefined, lists, stay };
              if (k === "p1") return <Section key={k} {...common} kind="p1" title={shownName(pg.names, "p1")} list={p1List} design={design} color={savedP1c} />;
              if (k === "prio") return <Section key={k} {...common} kind="prio" title={shownName(pg.names, "prio")} list={lists.prio} numbered />;
              if (k === "daily") return <Section key={k} {...common} kind="daily" title={shownName(pg.names, "daily", daily.every((d) => isEveryDay(d.data)))} list={daily} />;
              const g = groups.find((x) => groupKey(x.id) === k);
              return g ? <Section key={k} {...common} kind="group" title={g.name} group={g} groups={groups} list={lists.groups.get(g.id) || []} /> : null;
            })}
            {main && prio.length + daily.length === 0 && !groups.length && <p className="tm-empty">Nothing on your list.</p>}
            {prio.length === 0 && (byPage.get(id) ?? []).includes("prio") && <ul className="tm-list tm-drop-empty" data-sec="prio" aria-hidden="true" />}
            {!main && keys.length === 0 && <EmptyList id={id} />}
            {/* The end of the list: Resurrect (whenever something can come back), Clear and Complete all in one row, then
                Completed (V1.34): ticked one-offs, crossed out in a grey area. Sleep sits here only while the side column is
                hidden (a narrow website window, sleepmode.css); otherwise bottom right. Each list has its own (V1.55). */}
            <Completed list={mine(done)} back={mine(back)} history={mine(history)} open={openHere} keep={lp.keep} editing={editing} onEdit={setEditingId} clients={clients}
              extra={GOS ? null : <SleepRow where="end" />} title={<SecTitle skey="done" title={shownName(pg.names, "done")} />} />
          </>);
        }} />
        {footer}
      </div>
      </div>
      {editable && <EditLayer saved={savedLayout} />}
      {editable && <EditButton kept={kept} onKeep={setKept} shown={shown} red={red} saved={savedLayout} st={st} onSettings={(patch) => void taskMapActions.looks(patch)} />}
      </EditScope>
    </div>
  );
}

/** V1.44 #9: the list box scrolls up and down only. Something with room to the side (a swiped row, a focus that
 *  scrolls itself into view) once let a sideways trackpad move slide the whole list under Coming up, where it stayed
 *  until the list was hidden. taskmap.css hides the sideways overflow; this puts back any scroll that still happens. */
function noSideways(e: React.UIEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  if (el.scrollLeft) el.scrollLeft = 0;
}

// The list's scroll bar: the browser's white one is hidden and this slim pink line takes its place.
// The thumb springs to where you are (a small overshoot, like a bloop) and stretches while it moves.
function ScrollRail({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const thumb = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0, idle = 0;
    const draw = () => {
      raf = 0;
      const t = thumb.current;
      const over = el.scrollHeight - el.clientHeight;
      setShow(over > 4);
      if (!t || over <= 4) return;
      const rail = t.parentElement!.clientHeight;
      const h = Math.max(36, rail * (el.clientHeight / el.scrollHeight));
      t.style.height = `${h}px`;
      t.style.transform = `translateY(${(rail - h) * (el.scrollTop / over)}px)`;
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const scrolled = () => {
      queue();
      thumb.current?.classList.add("moving");
      clearTimeout(idle);
      idle = window.setTimeout(() => thumb.current?.classList.remove("moving"), 160);
    };
    el.addEventListener("scroll", scrolled, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const off = onRelayout(draw);   // shown again or a new size: drawn at once, not on a frame a hidden window holds back
    queue();
    return () => { el.removeEventListener("scroll", scrolled); ro.disconnect(); off(); cancelAnimationFrame(raf); clearTimeout(idle); };
  }, [scroller]);
  return <div className={`tm-rail${show ? " on" : ""}`} aria-hidden="true"><span ref={thumb} className="tm-rail-thumb" /></div>;
}

// The big headline: click it and type. Enter or clicking away saves it, Esc puts it back.
function Headline({ text }: { text: string }) {
  const el = useRef<HTMLHeadingElement>(null);
  // React never renders the text itself (it would fight your typing); it is set here instead.
  useLayoutEffect(() => { if (el.current && document.activeElement !== el.current) el.current.textContent = text; }, [text]);
  const save = () => {
    const v = (el.current?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!v) { if (el.current) el.current.textContent = text; return; }
    if (v !== text) void taskMapActions.headline(v);
  };
  return (
    <h2 ref={el} className="tm-title tm-title-edit" contentEditable suppressContentEditableWarning spellCheck={false}
      role="textbox" aria-label="Headline (click to change)" title="Click to change"
      onBlur={save} onMouseDown={(e) => e.stopPropagation()}
      onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (el.current) el.current.textContent = text; (e.target as HTMLElement).blur(); }
      }} />
  );
}

function SizeControl({ label, value, min, max, onInput, onCommit }: { label: string; value: number; min: number; max: number; onInput: (v: number) => void; onCommit: (v: number) => void }) {
  return (
    <label className="tm-size" title={label}>
      <span className="tm-size-l">{label}</span>
      <input type="range" min={min} max={max} step={5} value={value} aria-label={label}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))} />
      <span className="tm-size-v num">{value}%</span>
    </label>
  );
}

// ---------- top right buttons ----------
const ICON = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** A small panel under a top right button. Closes on a click outside or Esc. */
function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", out, true);
    return () => window.removeEventListener("mousedown", out, true);
  }, [open]);
  return { open, setOpen, ref };
}

// Screen time, counted by PS on the Mac and PS GOS on the phone: a small screen button top right
// (this device's total today); hover it for today's apps, the change since yesterday and the last
// 7 days. Mac | Phone switches between the two devices' own records; it opens on this device.
function ScreenTimePop() {
  const s = useVault();
  const [dev, setDev] = useState<ScreenTimeDevice>(ST_HERE);
  const [dir, setDir] = useState<"left" | "right">("right");
  const pickDev = (d: ScreenTimeDevice) => { sfx.click(); setDir(d === "gos" ? "right" : "left"); setDev(d); };
  const mine = useMemo(() => screenTimeDays(s, ST_HERE), [s]);
  const days = useMemo(() => screenTimeDays(s, dev), [s, dev]);
  const other = useMemo(() => screenTimeDays(s, ST_HERE === "mac" ? "gos" : "mac"), [s]);
  const [open, setOpen] = useState(false);
  const t = useRef(0);
  const today = todayISO();
  const apps = days.get(today)?.data.apps || [];
  const isMac = dev === "mac";
  // The timeline: this device's own line live (PS's native side on the Mac, the shell's usage events
  // on the phone), and the OTHER device's line from the hours it saved in the vault (core/stline.ts,
  // V1.31). The website draws both from the vault.
  const macLive = useTimeline() ?? (import.meta.env.DEV ? (window as { __devTimeline?: Timeline }).__devTimeline ?? null : null);
  const phoneLive = usePhoneLine();
  const hours = settingsData(s).tmStHours ?? 24;
  const lines = useMemo(() => screenLines(s), [s]);
  const live = dev !== ST_HERE ? null : ST_HERE === "mac" ? macLive : phoneLive;
  const synced = useMemo(() => {
    if (!open || live) return null;
    const now = Date.now();
    return joinLines(lines, dev, now - hours * HOUR, now);
  }, [open, live, lines, dev, hours]);
  const tlFull = live ?? synced;
  const tl = useMemo(() => tlFull ? clipTimeline(tlFull, hours) : null, [tlFull, hours]);
  // Icons come from the Mac only (bundle ids); the phone's apps show their first letter.
  const icons = useAppIcons(isMac ? [...apps.slice(0, 12).map((a) => a.id), ...(tl?.apps.map((a) => a.id) || [])] : []);
  const presence = usePresence();
  const away = isMac ? presence : {} as typeof presence;
  // Is PS counting on this Mac? (ps-mac ScreenTime.swift: never chosen, it is on for everyone but the developer.) A friend whose
  // screen time is off is told so here, with a Turn on button, instead of an empty week (public PS, 7 Nov 2026).
  const psSet = usePsSettings();
  useEffect(() => { if (PS && ST_HERE === "mac") psPost({ type: "psSettings:get" }); }, []);
  const stOff = macStOff(PS && ST_HERE === "mac", psSet?.screenTime);
  const off = stOff && isMac;
  const turnOn = () => { sfx.click(); psPost({ type: "psSettings:screenTime", on: true }); };
  const st = settingsData(s);
  const reasons = st.awayReasons || [];
  const log = st.awayLog || [];
  // The break being tagged: the last one by default, or one picked on the timeline.
  const [pick, setPick] = useState<[number, number] | null>(null);
  const last: [number, number] | null = away.lastOn && away.back ? [Date.parse(away.lastOn), Date.parse(away.back)] : null;
  const gap = isMac ? pick ?? last : null;
  const reasonOf = (startMs: number) => log.find((x) => Math.abs(x.s - startMs / 1000) < 90)?.reason;
  const setReason = (g: [number, number], reason: string) => {
    const s0 = Math.round(g[0] / 1000), e0 = Math.round(g[1] / 1000);
    const back = log.find((x) => Math.abs(x.s - s0) < 90)?.back;        // the AFK timer's first input time stays with the break
    const next = [...log.filter((x) => Math.abs(x.s - s0) >= 90), ...(reason ? [{ s: s0, e: e0, reason, ...(back ? { back } : {}) }] : [])].slice(-500);
    void taskMapActions.away({ awayLog: next });
  };
  const saveReason = (r: string) => { if (!reasons.some((x) => x.toLowerCase() === r.toLowerCase())) void taskMapActions.away({ awayReasons: [...reasons, r].slice(-30) }); };
  const dropReason = (r: string) => void taskMapActions.away({ awayReasons: reasons.filter((x) => x !== r) });
  // Today's breaks by reason (from midnight).
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const byReason = new Map<string, number>();
  for (const x of log) if (x.s * 1000 >= midnight.getTime()) byReason.set(x.reason, (byReason.get(x.reason) || 0) + (x.e - x.s));
  // A new range from the gear: fetch it straight away if the pop-up is open.
  useEffect(() => { if (open) askTimeline(hours); }, [hours, open]);
  const shownAt = useRef(0);
  // The phone (PS GOS): a tap fires the hover first, so that same tap must not close it again, and back closes it.
  const GOS_UI = import.meta.env.MODE === "gos";
  useEffect(() => {
    if (!GOS_UI || !open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, GOS_UI]);
  const weekOf = (m: typeof days) => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    const k = d.toLocaleDateString("en-CA");
    return { k, label: d.toLocaleDateString(undefined, { weekday: "narrow" }), secs: totalSecs(m.get(k)?.data.apps || []) };
  });
  const week = weekOf(days);
  // PS and PS GOS always show it (they are the ones counting); the website once there is something to show.
  if (!PS && !GOS_UI && !weekOf(mine).some((w) => w.secs > 0) && !weekOf(other).some((w) => w.secs > 0)) return null;
  const mineToday = totalSecs(mine.get(today)?.data.apps || []);
  const total = totalSecs(apps), yest = week[5].secs;
  const max = Math.max(...week.map((w) => w.secs), 1);
  const avg = Math.round(week.slice(0, 6).filter((w) => w.secs > 0).reduce((n, w, _, a) => n + w.secs / a.length, 0));
  const show = () => { clearTimeout(t.current); if (!open) { shownAt.current = Date.now(); sfx.hover(); askPresence(); askTimeline(hours); askPhoneLine(); if (PS) psPost({ type: "psSettings:get" }); setOpen(true); } };
  const hide = () => { clearTimeout(t.current); t.current = window.setTimeout(() => setOpen(false), 220); };
  const when = (iso: string) => {
    const d = new Date(iso), today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === today ? time : d.toDateString() === yest ? `yesterday ${time}` : `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
  };
  return (
    <div className={`tm-pop-wrap tm-st${open ? " open" : ""}`} onMouseEnter={show} onMouseLeave={hide} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`tm-pill-btn tm-st-btn${open ? " on" : ""}`} onClick={() => { if (GOS_UI && Date.now() - shownAt.current < 600) return; setOpen((v) => !v); }} aria-expanded={open} aria-label={stOff && !mineToday ? "Screen time is off on this Mac" : `Screen time today on this ${ST_HERE === "gos" ? "phone" : "Mac"}: ${fmtDur(mineToday)}`} title={stOff ? "Screen time is off" : "Screen time"}>
        <svg {...ICON}>{ST_HERE === "gos" ? <><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></> : <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>}</svg>
        <span className="tm-st-v num">{macStChip(mineToday, stOff, fmtDur)}</span>
      </button>
      {open && (
        <div className="tm-pop tm-st-pop" role="dialog" aria-label="Screen time">
          <StDeviceSwitch value={dev} onPick={pickDev} />
          <StSwap k={dev} dir={dir}>
          <div className="tm-st-head">
            <span className="tm-panel-h">{isMac ? "Mac" : "Phone"} screen time today</span>
            <b className="tm-st-total num">{fmtDur(total)}</b>
            {yest > 0 && total > 0 && <span className="tm-pop-note num">{fmtDur(Math.abs(total - yest))} {total >= yest ? "more" : "less"} than yesterday{avg ? ` · ${fmtDur(avg)} a day this week` : ""}</span>}
          </div>
          {gap && (
            <div className="tm-st-away">
              <div className="tm-st-away-top">
                <span className="tm-st-away-i" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>
                </span>
                <span>
                  <b>{pick ? `Away from ${when(new Date(gap[0]).toISOString())}` : `Last on ${when(new Date(gap[0]).toISOString())}`}</b>
                  <span className="tm-pop-note num"> · away {fmtDur(Math.round((gap[1] - gap[0]) / 1000))}, back at {when(new Date(gap[1]).toISOString())}</span>
                </span>
                {pick && <button type="button" className="tm-ed-chip" onClick={() => setPick(null)}>Last break</button>}
              </div>
              <AwayReason key={gap[0]} current={reasonOf(gap[0])} reasons={reasons}
                onPick={(r) => setReason(gap, r)} onSave={saveReason} onDrop={dropReason} />
            </div>
          )}
          {isMac && byReason.size > 0 && (
            <div className="tm-st-why">
              <span className="tm-pop-note">Away today:</span>
              {[...byReason].sort((a, b) => b[1] - a[1]).map(([r, secs]) => <span key={r} className="tm-st-why-i"><b>{r}</b> {fmtDur(secs)}</span>)}
            </div>
          )}
          {tl ? <StTimeline tl={tl} icons={icons} device={dev} reasonOf={isMac ? reasonOf : () => undefined} onPickAway={isMac ? (g) => setPick(g) : undefined} /> : (
          <div className="tm-st-week" aria-label="Last 7 days">
            {week.map((w, i) => (
              <div key={w.k} className={`tm-st-day${i === 6 ? " today" : ""}`} title={`${w.k}: ${fmtDur(w.secs)}`}>
                <span className="tm-st-bar"><i style={{ height: `${Math.max(3, (w.secs / max) * 100)}%`, animationDelay: `${i * 30}ms` }} /></span>
                <span className="tm-st-dl">{w.label}</span>
              </div>
            ))}
          </div>
          )}
          {off && (
            <div className="st-none st-off">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              <span>{macStOffText(appName())}</span>
              <button type="button" className="tm-ed-chip st-off-on" onClick={turnOn}>Turn on</button>
            </div>
          )}
          {tl && !live && tl.upTo ? <span className="tm-pop-note num">{dev === ST_HERE ? "Last counted at" : `Sent from your ${isMac ? "Mac" : "phone"} at`} {when(new Date(tl.upTo).toISOString())}</span> : null}
          {!tl && !off && (PS ? !isMac : true) && (
            <div className="st-none">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              <span>{dev === ST_HERE && !isMac
                ? "No timeline yet. PS app GOS draws it from GrapheneOS's usage events once it may see app usage (Phone settings, Usage access)."
                : isMac
                  ? `No timeline from your Mac yet. It shows once ${appName()} on the Mac is V1.31 or newer, screen time is on, and it has sent its first count (every 10 minutes).`
                  : "No timeline from your phone yet. It shows once PS app GOS V1.31 or newer is on the phone, may see app usage, and has been opened once."}</span>
            </div>
          )}
          {apps.length > 0 ? <ScreenTimeBars apps={apps} limit={10} icons={isMac ? icons : {}} /> : off ? null : (
            <span className="tm-pop-note">{isMac
              ? macStEmptyText(PS && ST_HERE === "mac" ? psSet?.screenTime : undefined, appName())
              : "Nothing counted on the phone yet today. PS app GOS adds your apps every few minutes once it may see app usage (phone settings)."}</span>
          )}
          <span className="tm-pop-note">Counted by {isMac ? `${appName()} on your Mac` : "PS GOS on your phone, from GrapheneOS's usage events"}. App names and times only, encrypted in your vault.</span>
          </StSwap>
        </div>
      )}
    </div>
  );
}

// Why was the developer away? Hover a saved reason to pick it (no click needed), or type one: Enter uses it
// for this break, "Save" also keeps it in the list for next time. The × takes a reason off the list.
function AwayReason({ current, reasons, onPick, onSave, onDrop }: {
  current?: string; reasons: string[]; onPick: (r: string) => void; onSave: (r: string) => void; onDrop: (r: string) => void;
}) {
  const [text, setText] = useState("");
  const use = (r: string, save?: boolean) => { const v = r.trim().slice(0, 40); if (!v) return; onPick(v); if (save) onSave(v); setText(""); sfx.drop(); };
  return (
    <div className="tm-why">
      <span className="tm-pop-note">{current ? <>Reason: <b className="tm-why-cur">{current}</b></> : "Why were you away?"}</span>
      {reasons.length > 0 && (
        <div className="tm-why-list">
          {reasons.map((r) => (
            <span key={r} className="tm-why-chip">
              <DwellButton selected={current === r} onPick={() => { if (current !== r) use(r); }}>{r}</DwellButton>
              <button type="button" className="tm-why-x" onClick={() => onDrop(r)} aria-label={`Take ${r} off the list`} title="Take off the list">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="tm-pop-row">
        <input className="tm-pop-in tm-why-in" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reason, eg Coffee break"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); use(text); } if (e.key === "Escape") { e.stopPropagation(); setText(""); } }} />
        <DwellButton selected={false} onPick={() => use(text, true)}>Save to list</DwellButton>
      </div>
    </div>
  );
}

// End of day: the Reset button, left of mute. Asks first; Undo (bottom right) puts it all back.
/** End the day from the Tab list (the sunset button, by hand only: PS never asks): Reset, with Undo. */
function endDayNow(dayEnds: number) {
  const day = new Date(workDayOf(Date.now(), dayEnds) + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  sfx.done();
  pushUndo({ id: `reset:${Date.now()}`, title: `Ended ${day}`, reset: true });
  void taskMapActions.reset();
}

function EndDay({ dayEnds, docked }: { dayEnds: number; docked?: boolean }) {
  const { open, setOpen, ref } = usePop();
  const day = new Date(workDayOf(Date.now(), dayEnds) + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const owner = docked ? "docked" as const : "tab" as const;
  const go = () => {
    setOpen(false);
    endDayGate(owner, () => endDayNow(dayEnds));
  };
  // With rules written, the rule check is the question: it opens straight away.
  const click = () => {
    sfx.click();
    if (needsCheck(myRules())) { setOpen(false); openRuleBook(owner, "check", () => endDayNow(dayEnds)); return; }
    setOpen((v) => !v);
  };
  return (
    <div className="tm-pop-wrap" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`tm-pill-btn icon${open ? " on" : ""}`} onClick={click} aria-expanded={open} aria-label="End your day (reset the list)" title="End your day">
        {/* A sun going down behind the horizon (the developer, 4 Nov 2026: the old moon looked like Do Not Disturb's). */}
        <svg {...ICON}><path d="M2.5 18h19" /><path d="M6.5 18a5.5 5.5 0 0 1 11 0" /><path d="M8 21.5h8" /><path d="M3.9 13.3l1.7 1" /><path d="M20.1 13.3l-1.7 1" /><path d="M12 2.5v6" /><path d="M9.4 6.3L12 8.9l2.6-2.6" /></svg>
      </button>
      {open && (
        <div className="tm-pop tm-endday" role="alertdialog" aria-label="End your day?">
          <b className="tm-endday-h">Are you sure you want to end your day?</b>
          <span className="tm-pop-note">Everything you ticked is saved to {day}. Every day tasks untick, finished one-offs clear. Undo, bottom right, puts it all back.</span>
          <div className="tm-pop-row">
            <button type="button" className="tm-ed-save" onClick={go} autoFocus>Yes, end my day</button>
            <button type="button" className="tm-ed-chip" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Add a task: a window in the middle of the screen (a sheet from the bottom on the phone) ----------
// Opened by the + next to the headline, or by holding Tab and pressing 1 (PS swallows the 1, the
// window stays after Tab is let go and has the keyboard). Quick add since V1.33: just the name; Enter
// (the phone keyboard's Go, or Add) adds it with no priority, clears and keeps it open for the next
// one; Advanced holds the other settings. Esc, the phone's back or a tap beside it closes it (the list
// stays). One window per page: the Tab list if it is up, else the docked To-do board.
type AddOwner = "tab" | "docked";
let addOpen: AddOwner | null = null;
const addListeners = new Set<() => void>();
export function openAddTask(owner: AddOwner = "tab") { addOpen = owner; addListeners.forEach((l) => l()); }
export function closeAddTask() { if (addOpen) { addOpen = null; addListeners.forEach((l) => l()); } }
function useAddOpen() {
  return useSyncExternalStore((l) => { addListeners.add(l); return () => { addListeners.delete(l); }; }, () => addOpen);
}
if (PS && typeof window !== "undefined") (window as { __psAddTask?: () => void }).__psAddTask = () => openAddTask("tab");

function AddTask({ prio, clients, docked }: { prio: Doc<Todo>[]; clients: ClientOpt[]; docked?: boolean }) {
  const owner: AddOwner = docked ? "docked" : "tab";
  // Its colour and click animation (Settings, To do list; core/addbutton.ts, V1.34).
  const st = settingsData(useVault());
  const color = addColorOf(st), anim = addAnimOf(st);
  const open = useAddOpen() === owner;
  const btn = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(docked ? document.body : btn.current?.closest<HTMLElement>(".tm-overlay") ?? null); }, [docked]);
  return (
    <>
      <span className="tm-add" style={{ ["--tm-addc" as string]: color, ["--tm-addink" as string]: addInkOn(color) }}>
        <button ref={btn} type="button" className={`tm-pill-btn icon${open ? " on" : ""}`} onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { sfx.click(); playAddAnim(e.currentTarget.parentElement, anim); if (open) closeAddTask(); else openAddTask(owner); }} aria-expanded={open} aria-label="Add a task" title="Add a task (or hold Tab and press 1)">
          <svg {...ICON}><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </span>
      {open && host && createPortal(<AddTaskWindow prio={prio} clients={clients} docked={docked} onClose={closeAddTask} />, host)}
    </>
  );
}

/** The Add task button's click animation: a CSS class for one run on its wrapper (React rewrites the button's own
 *  class as the window opens), nothing with reduced motion (taskmap.css). */
export function playAddAnim(el: HTMLElement | null, anim: AddAnim) {
  if (!el || anim === "none") return;
  for (const a of ADD_ANIMS) el.classList.remove(`add-${a.id}`);
  void el.offsetWidth;   // start again if it is still running
  el.classList.add(`add-${anim}`);
  const done = () => { el.classList.remove(`add-${anim}`); el.removeEventListener("animationend", done); };
  el.addEventListener("animationend", done);
  window.setTimeout(done, 900);
}

function AddTaskWindow({ prio, clients, docked, onClose }: { prio: Doc<Todo>[]; clients: ClientOpt[]; docked?: boolean; onClose: () => void }) {
  // Quick add (V1.33, core/quickadd.ts): only the name; Advanced (closed every time it opens) holds the rest for
  // the one task being typed. Everything added from the quick form has no date and no priority.
  const [title, setTitle] = useState(() => addDraft.get());
  const typed = useRef(title);   // what is in the field now, kept as the draft if it closes before Add
  const [adv, setAdv] = useState(false);
  const [o, setO] = useState<AddOpts>(() => quickDefaults(todayISO()));
  const set = (p: Partial<AddOpts>) => setO((x) => ({ ...x, ...p }));
  // P1, P2 or P3 typed in the name sets the priority (core/typedprio.ts, V1.40). A priority clicked in Advanced after
  // typing wins over it.
  const tp = useTypedPrio(title, o.kind === "once");
  const pick = (p: Partial<AddOpts>) => { tp.picked(); set(p); };
  const freshRule = (): RepeatDraft => ({ kind: "repeat", every: 1, unit: "week", from: todayISO() });
  const [rule, setRule] = useState<RepeatDraft>(freshRule);
  const ranked = prio.filter((d) => !d.data.unranked);
  const max = ranked.length + 1;
  const [added, setAdded] = useState<{ n: number; last: string } | null>(null);
  const [sq, setSq] = useState<SquadAdd>({ sqOn: false });   // G Squad: Share with G Squad (off to start, V1.43), Anonymise this task? (views/GSquadTask.tsx)
  const [gate] = useState(() => addGate());
  const titleRef = useRef<HTMLInputElement>(null);
  const win = useRef<HTMLDivElement>(null);
  // While it is open the list stays up and has the keyboard (PS pins it), and Esc closes only this.
  useEffect(() => {
    if (PS) psPost({ type: "dimx", open: true }); else taskMapActions.editing(true);
    const w = window as Window & { __psDimxClose?: () => boolean };
    const esc = () => { onClose(); return true; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    w.__psDimxClose = esc;
    // Focus inside the tap that opened it, so a phone's keyboard opens together with the window and
    // nothing scrolls. PS on the Mac first hands the keyboard to the list, so it waits a moment.
    const focus = () => { const el = titleRef.current; if (!el) return; el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); };
    if (PS) window.setTimeout(focus, 30); else focus();
    return () => {
      addDraft.set(typed.current.trim() ? typed.current : "");
      window.removeEventListener("keydown", key, true);
      if (w.__psDimxClose === esc) delete w.__psDimxClose;
      if (PS) psPost({ type: "dimx", open: false }); else taskMapActions.editing(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const iso = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
  const type = (v: string) => { typed.current = v; setTitle(v); };
  // The new row: scrolled into the part of the list still showing above the window, with a short glow.
  const showRow = (id: string) => {
    let tries = 0;
    const look = () => {
      const w = win.current;
      if (!w) return;
      const row = (docked ? document : w.closest(".tm-overlay") ?? document).querySelector<HTMLElement>(`.tm-row[data-id="${CSS.escape(id)}"]`);
      if (!row) { if (++tries < 30) requestAnimationFrame(look); return; }
      const box = row.closest<HTMLElement>(".tm-scroll");
      if (box) {
        const b = box.getBoundingClientRect(), wr = w.getBoundingClientRect();
        const by = revealBy(row.getBoundingClientRect(), { top: b.top, bottom: Math.min(b.bottom, wr.top) });
        if (by) box.scrollBy({ top: by, behavior: "smooth" });
      }
      const acc = getComputedStyle(row).getPropertyValue("--k-acc").trim() || "#EC4E86";
      row.animate?.([{ boxShadow: `0 0 0 2px ${acc}` }, { boxShadow: `0 0 0 2px ${acc}`, offset: 0.6 }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1600, easing: "ease-out" });
    };
    requestAnimationFrame(look);
  };
  const add = () => {
    const el = titleRef.current;
    const raw = el?.value ?? typed.current;
    const typedP = tp.take(raw);   // null for Every day and repeating tasks: they have no priority
    const v = cleanTitle(typedP ? typedP.title : raw);
    if (!v) { el?.focus({ preventScroll: true }); win.current?.animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(0)" }], { duration: 240 }); return; }
    if (!gate(v, Date.now())) return;   // the same task twice in a blink: one press, one task
    const sh = addShape(o);
    const r = sh.repeat ? patchOf(rule, todayISO()) : null;
    const due = sh.repeat ? r?.due ?? null : sh.due === "today" ? iso(0) : sh.due === "tomorrow" ? iso(1) : sh.due === "date" ? o.date || null : null;
    const groupSize = prio.filter((d) => d.data.p1).length;
    const at = typedP ? typedOrder(prio.map((d) => d.data), typedP.prio) : null;
    const id = taskMapActions.add({
      title: v, type: sh.type, due, repeat: r?.repeat ?? null,
      order: sh.type === "daily" ? undefined : at ? at.order : sh.unranked ? orderForPriority(prio, prio.length + 1) : orderForPriority(ranked, sh.p1 ? groupSize + 1 : Math.min(o.place ?? max, max)),
      p1: at ? at.p1 : sh.p1, clientId: o.clientId || null, notes: o.notes.trim() || null, ...(sh.unranked && !at ? { unranked: true } : {}),
      ...(sq.sqOn ? { sqOn: true } : {}), ...(typeof sq.sqAnon === "boolean" ? { sqAnon: sq.sqAnon } : {}),
      // V1.55: typed while one of the developer's own lists shows: it joins that list's group, at its end (views/ListPager.tsx).
      ...(addGroupHere(sh.type) ? { group: addGroupHere(sh.type), order: undefined } : {}),
    });
    sfx.drop();
    // Clear at once and keep the keyboard: the next one can be typed straight away. Advanced was for this task only.
    type("");
    if (el) { el.value = ""; if (document.activeElement !== el) el.focus({ preventScroll: true }); el.setSelectionRange(0, 0); }
    setO(quickDefaults(todayISO())); setRule(freshRule()); setAdv(false); tp.reset(); setSq({ sqOn: false });
    setAdded((a) => ({ n: (a?.n ?? 0) + 1, last: v }));
    void Promise.resolve(id).then((x) => { if (typeof x === "string") showRow(x); }).catch(() => {});
  };
  const keys = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const where = t === titleRef.current ? "title" : t.tagName === "TEXTAREA" ? "notes" : "other";
    const a = enterAction({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing }, where);
    if (!a) { if (e.key === "Enter" && where === "title") e.preventDefault(); return; }
    e.preventDefault();
    if (a === "defer") window.setTimeout(add, 0); else add();
  };
  // Add and Advanced never take the focus from the name, so a phone's keyboard stays up (it used to drop and rise
  // again on every Add, and the sheet jumped with it).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const toggleAdv = () => {
    sfx.click();
    const open = !adv;
    setAdv(open);
    // On the phone the keyboard steps aside while the settings are open, and comes back when they close.
    if (GOS) { if (open) titleRef.current?.blur(); else titleRef.current?.focus({ preventScroll: true }); }
  };
  const chip = (on: boolean, label: string, pick: () => void) => (
    <button type="button" role="radio" aria-checked={on} className={`tm-add-chip${on ? " on" : ""}`} onClick={() => { if (!on) { sfx.hover(); pick(); } }}>{label}</button>
  );
  return (
    <div className={`tm-add-layer${docked ? " docked" : ""}${adv ? " adv" : " quick"}`} onMouseDown={(e) => e.stopPropagation()}>
      {/* A tap beside the window closes it (what was typed waits for next time). On the click, not the press, so
          the rest of the tap can never land on the list underneath. */}
      <div className="tm-add-dim" onMouseDown={keep} onClick={onClose} aria-hidden="true" />
      <div ref={win} className="tm-add-win" role="dialog" aria-modal="true" aria-label="Add a task" onKeyDown={keys}>
        <div className="tm-add-top">
          <h2 className="tm-add-h">Add a task</h2>
          {added && (
            <span className="tm-add-done" key={added.n} role="status" aria-live="polite">
              <svg {...ICON} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              Added{added.n > 1 && <b className="num">{added.n}</b>}<i>{added.last}</i>
            </span>
          )}
          <button type="button" className="tm-add-x" onMouseDown={keep} onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <PrioInput ref={titleRef} prio={tp} className="tm-add-title" value={title} onChange={(e) => type(e.target.value)} placeholder="What needs doing?" aria-label="Task" maxLength={500}
          enterKeyHint="go" autoComplete="off" autoCapitalize="sentences" spellCheck />
        <SquadAddRow title={title} clientId={o.clientId} value={sq} onChange={setSq} />
        {adv && (
          <div className="tm-add-adv">
            <textarea className="tm-add-notes" value={o.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Notes (optional)" rows={2} aria-label="Notes" />
            <div className="tm-add-grid">
              <span className="tm-add-l">How often</span>
              <div className="tm-add-row" role="radiogroup">
                {chip(o.kind === "once", "One-off", () => set({ kind: "once" }))}{chip(o.kind === "daily", "Every day", () => set({ kind: "daily" }))}{chip(o.kind === "repeat", "Repeat", () => set({ kind: "repeat" }))}
              </div>
              {o.kind === "once" && <>
                <span className="tm-add-l">When</span>
                <div className="tm-add-row" role="radiogroup">
                  {chip(o.when === "today", "Today", () => set({ when: "today" }))}{chip(o.when === "tomorrow", "Tomorrow", () => set({ when: "tomorrow" }))}
                  {chip(o.when === "none", "No date", () => set({ when: "none" }))}{chip(o.when === "date", "Pick a date", () => set({ when: "date" }))}
                  {o.when === "date" && <input type="date" className="tm-ed-date" value={o.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date" />}
                </div>
                <span className="tm-add-l">Priority</span>
                <div className="tm-add-row">
                  <button type="button" role="switch" aria-checked={o.p1} className={`tm-p1-switch${o.p1 ? " on" : ""}`} onClick={() => { pick({ p1: !o.p1 }); sfx.click(); }}>
                    <span className="tm-p1-knob" aria-hidden="true" />Priority 1
                  </button>
                  {!o.p1 && (o.place === null
                    ? <button type="button" className="tm-add-chip tm-add-place" onClick={() => { sfx.hover(); pick({ place: max }); }} title="Give it a place in the numbered list">Give it a place</button>
                    : <><PriorityPicker value={Math.min(o.place, max)} max={max} onChange={(n) => pick({ place: n })} />
                      <button type="button" className="tm-add-chip" onClick={() => { sfx.hover(); pick({ place: null }); }} title="No priority: it waits below the numbered tasks">No priority</button></>)}
                </div>
              </>}
              {o.kind === "repeat" && <>
                <span className="tm-add-l">Repeats</span>
                <div className="tm-add-row"><RepeatPicker value={rule} onChange={setRule} cls={TM_REPEAT} /></div>
              </>}
              {clients.length > 0 && <>
                <span className="tm-add-l">Client</span>
                <div className="tm-add-row">
                  <select className="tm-ed-client" value={o.clientId} onChange={(e) => set({ clientId: e.target.value })} aria-label="Client">
                    <option value="">No client</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </>}
            </div>
          </div>
        )}
        <div className="tm-add-foot">
          <span className="tm-pop-note">{adv ? "These settings are for this task only." : "Enter adds it, and it stays open for the next one. Esc closes."}</span>
          <button type="button" className={`tm-ed-chip tm-add-advbtn${adv ? " on" : ""}`} onMouseDown={keep} onClick={toggleAdv} aria-expanded={adv}
            title="Notes, how often, date, priority and client for this task">
            Advanced<svg {...ICON} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button type="button" className="tm-ed-save tm-add-go" onMouseDown={keep} onClick={add}>Add task</button>
        </div>
      </div>
    </div>
  );
}

const GOS = import.meta.env.MODE === "gos";

// Every other zone, built once (about 400 of them).
let zoneOptionsCache: ReactNode = null;
const zoneOptions = () => (zoneOptionsCache ??= allZones().filter((z) => !HOME_COMMON.includes(z)).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>));

// ---------- the gear (Settings) ----------
// The controls are shared by the full screen Settings' General page (the floating list, V1.32) and the small
// gear menu the phone (its bottom sheet) and the website's To-do page still use. Click only everywhere (the developer,
// 18 Oct 2026: "I have to left click a setting option for it to apply").
export type GenProps = { volume: number; muted: boolean; soundOff: boolean; onMute: () => void; size: ReactNode; homeTz: string; notifyOn: boolean; notifyLog: { at: string; text: string }[]; stHours: number };
const GEAR_ICON = <svg {...ICON}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;

/** Sound volume with Test and Mute. */
export function SoundControls({ volume, muted, soundOff, onMute }: Pick<GenProps, "volume" | "muted" | "soundOff" | "onMute">) {
  const [v, setV] = useState(volume);
  useEffect(() => { setV(volume); }, [volume]);
  const commit = (n: number) => { if (n !== volume) void taskMapActions.sound({ tmSound: n, tmMuted: n === 0 ? muted : false }); };
  return (<>
    <div className="tm-pop-row">
      <input type="range" min={0} max={100} step={5} value={v} aria-label="Sound volume" className="tm-pop-range"
        onChange={(e) => { const n = Number(e.target.value); setV(n); setSfxVolume(n); }}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))} />
      <b className="num tm-pop-v">{v === 0 ? "Off" : `${v}%`}</b>
      <button type="button" className="tm-ed-chip" onClick={() => { setSfxVolume(v); sfx.test(); }} disabled={v === 0}>Test</button>
      <button type="button" className={`tm-ed-chip tm-mute-btn${soundOff ? " on" : ""}`} aria-pressed={soundOff} onClick={() => { onMute(); if (soundOff) window.setTimeout(() => sfx.click(), 60); }}>{soundOff ? "Unmute" : "Mute"}</button>
    </div>
    {muted && <span className="tm-pop-note">Muted: the Unmute button turns {appName()}'s sounds back on.</span>}
  </>);
}
/** How many hours the screen time timeline shows: a slider and three quick picks. */
export function StHoursControls({ stHours }: { stHours: number }) {
  const [hrs, setHrs] = useState(stHours);
  useEffect(() => { setHrs(stHours); }, [stHours]);
  return (<>
    <div className="tm-pop-row">
      <input type="range" min={1} max={24} step={1} value={hrs} aria-label="Hours the screen time timeline shows" className="tm-pop-range"
        onChange={(e) => setHrs(Number(e.target.value))}
        onPointerUp={() => { if (hrs !== stHours) void taskMapActions.stHours(hrs); }} onKeyUp={() => { if (hrs !== stHours) void taskMapActions.stHours(hrs); }} />
      <b className="num tm-pop-v">{hrs}h</b>
    </div>
    <div className="tm-ed-seg">
      {[6, 12, 24].map((h) => <Choice key={h} selected={stHours === h} onPick={() => { if (stHours !== h) { sfx.hover(); setHrs(h); void taskMapActions.stHours(h); } }}>{h} hours</Choice>)}
    </div>
  </>);
}
/** This Mac's AFK timer (views/AfkBadge.tsx; PS keeps it per Mac, off by default on a Second Computer secondary). */
export function AfkControls({ afkOn }: { afkOn: boolean }) {
  return (
    <div className="tm-ed-seg" role="radiogroup" aria-label="AFK timer">
      <Choice selected={afkOn} onPick={() => { if (!afkOn) { sfx.hover(); setAfkOn(true); } }}>On</Choice>
      <Choice selected={!afkOn} onPick={() => { if (afkOn) { sfx.hover(); setAfkOn(false); } }}>Off</Choice>
    </div>
  );
}
/** Notification pop-ups on or off, and the last 24 hours of them. */
export function NotifyControls({ notifyOn, notifyLog }: Pick<GenProps, "notifyOn" | "notifyLog">) {
  const [history, setHistory] = useState(false);
  const recent = notifyLog.filter((n) => Date.parse(n.at) > Date.now() - 86400_000).reverse();
  return (<>
    <div className="tm-pop-row tm-notify-row">
      <div className="tm-ed-seg" role="radiogroup" aria-label="Notification pop-ups">
        <Choice selected={notifyOn} onPick={() => { if (!notifyOn) { sfx.hover(); void taskMapActions.notifyPref(true); } }}>On</Choice>
        <Choice selected={!notifyOn} onPick={() => { if (notifyOn) { sfx.hover(); void taskMapActions.notifyPref(false); } }}>Off</Choice>
      </div>
      <button type="button" className={`tm-pill-btn icon tm-hist-btn${history ? " on" : ""}`} onClick={() => { sfx.click(); setHistory((v) => !v); }}
        aria-expanded={history} aria-label="Notification history, last 24 hours" title="History (last 24 hours)">
        <svg {...ICON}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>
        {recent.length > 0 && <span className="tm-hist-n num">{recent.length}</span>}
      </button>
    </div>
    {history && (
      <div className="tm-hist" role="list" aria-label="Notifications in the last 24 hours">
        {recent.length === 0 ? <span className="tm-pop-note">Nothing in the last 24 hours.</span> : recent.map((n, i) => (
          <div key={i} className="tm-hist-i" role="listitem">
            <span className="tm-hist-t num">{new Date(n.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            <span className="tm-hist-x">{n.text}</span>
          </div>
        ))}
      </div>
    )}
  </>);
}
/** Your time zone: the clocks compare every zone with this one. */
export function TzSelect({ homeTz }: { homeTz: string }) {
  return (
    <select className="tm-pop-sel" value={homeTz} aria-label="Your time zone"
      onChange={(e) => { void taskMapActions.homeTz(e.target.value || null); (e.target as HTMLSelectElement).blur(); }}>
      <option value="">Automatic ({tzLabel(DEVICE_TZ)})</option>
      <optgroup label="Common">
        {HOME_COMMON.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
      </optgroup>
      <optgroup label="All time zones">
        {zoneOptions()}
      </optgroup>
    </select>
  );
}

/** The gear (V1.32 on the floating list; V1.43 also the website's To-do page and the phone): a left click opens the full
 *  screen Settings (views/SettingsScreen.tsx), a second click closes it. */
function SettingsGear({ owner }: { owner: SettingsOwner }) {
  const w = useSettingsWanted();
  const upd = useMacUpdate();
  const toggle = (e: React.MouseEvent) => { if (e.button !== 0) return; sfx.click(); if (!w) askMic(); openSettings(w ? null : "general", { owner }); };
  return (
    <button type="button" className={`tm-pill-btn icon gs-gear${w ? " on" : ""}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={!!w} aria-label="Settings" title="Settings">
      {GEAR_ICON}
      {PS && <MacUpdateDot kind={macUpdateBadge(upd)} />}
    </button>
  );
}

/** A click-only choice (the gear menu never switches on hover: the developer, 18 Oct 2026). */
export function Choice({ selected, onPick, children, title }: { selected: boolean; onPick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} title={title} className={`dwell${selected ? " on" : ""}`}
      onClick={() => { if (!selected) onPick(); }}>{children}</button>
  );
}

/** Priority 1 look: tiles to click (each a small live sample), and a slider that runs through them
 *  with a live preview on the list behind; letting go saves. */
/** The developer's own background video: covers the screen behind the list, muted, looping. It plays only
 *  while the list is showing; hidden, it lets go of the file and the decoder (nothing runs then).
 *  Its strength follows the glass slider.
 *  It never restarts (V1.40, core/bgplayhead.ts): the list is rebuilt on every show (PsApp's Overlay key) and the file
 *  was let go on every hide, so each show used to start the video at 0:00. Now a playhead per video lives outside the
 *  list: on hide it notes the time and the clock, on show the video seeks to where it would be had it played on, and
 *  stays invisible until that frame is ready, so it looks like it never stopped. */
const bgPlayheads = new Map<string, Playhead>();
function BgVideoLayer({ id, file, shown, crop }: { id: string; file?: string; shown: boolean; crop?: BgCrop | null }) {
  const v = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  // `file`: a stand in while a newer copy of this video downloads (core/bgvault.ts); `restart` reloads it (phone keeper).
  const src = `/client/bg/${file ?? id}.mp4`;
  const [restart, setRestart] = useState(0);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    // Only a video that got going has a time worth keeping; otherwise the last note stands (its clock keeps counting).
    const keep = () => { if (el.getAttribute("src") && el.readyState >= 1 && el.currentTime > 0) bgPlayheads.set(id, notePlayhead(el.currentTime, Date.now(), el.duration)); };
    if (!shown) {
      keep();
      el.pause();
      el.removeAttribute("src");
      el.load();
      setReady(false);
      return;
    }
    let done = false;
    const show = () => { if (done) return; done = true; setReady(true); void el.play().catch(() => {}); };
    const start = () => {
      const t = resumeAt(bgPlayheads.get(id), Date.now(), el.duration);
      if (Math.abs(el.currentTime - t) < 0.05) { show(); return; }
      el.addEventListener("seeked", show, { once: true });
      el.currentTime = t;
    };
    setReady(false);
    if (el.getAttribute("src") !== src) {
      el.addEventListener("loadedmetadata", start, { once: true });
      el.src = src; el.load();
    } else if (el.readyState >= 1) start();
    else el.addEventListener("loadedmetadata", start, { once: true });
    const failsafe = window.setTimeout(show, 1500);   // a slow seek never keeps the video hidden for long
    return () => { done = true; window.clearTimeout(failsafe); el.removeEventListener("loadedmetadata", start); el.removeEventListener("seeked", show); keep(); };
  }, [shown, src, id, restart]);
  useEffect(() => () => { const el = v.current; if (el) { el.pause(); el.removeAttribute("src"); el.load(); } }, []);
  // The phone (V1.47, core/bgwatch.ts): a video that errored, paused on its own or froze is played or reloaded, with a
  // log line each time and one when it plays again. Only while shown: hidden, nothing runs.
  useBgKeeper(v, { on: !!crop && shown, ready, id, reload: () => { const el = v.current; if (!el) return; if (el.currentTime > 0) bgPlayheads.set(id, notePlayhead(el.currentTime, Date.now(), el.duration)); el.pause(); el.removeAttribute("src"); el.load(); setRestart((n) => n + 1); } });
  const video = <video ref={v} className={`tm-bgvideo${ready ? "" : " wait"}`} style={crop ? cropCss(crop) : undefined} muted loop playsInline preload="auto" aria-hidden="true" data-id={id} />;
  return crop ? <BgClip crop={crop} video={v} on={shown && ready}>{video}</BgClip> : video;
}

// ---------- More settings, now the Looks tab of the full screen Settings (V1.32) ----------
// Every design choice in one place (the developer, 18 Oct 2026). Each choice is a tile (click only) with a Preview
// button under it: the screen steps aside, the list shows that look for five seconds, then the screen comes
// back. A click anywhere ends the preview early. Tile samples exist only while the tab is open, so nothing
// animates otherwise. The shell, the tabs and the preview timing live in views/SettingsScreen.tsx.
/** Old name, kept for callers: true opens Settings on Looks, false closes Settings. */
export function openMoreSettings(v = true) { openSettings(v ? "looks" : null); }
let themePreview: "dark" | "light" | null = null;
function setThemePreview(v: typeof themePreview) { themePreview = v; p1Listeners.forEach((l) => l()); }
function useThemePreview() {
  return useSyncExternalStore((l) => { p1Listeners.add(l); return () => { p1Listeners.delete(l); }; }, () => themePreview);
}
let nbPreview: string | null = null;
function setNbPreview(v: string | null) { nbPreview = v; p1Listeners.forEach((l) => l()); }
function useNbPreview() {
  return useSyncExternalStore((l) => { p1Listeners.add(l); return () => { p1Listeners.delete(l); }; }, () => nbPreview);
}
const STORM_SAMPLE = (id: string) => id.startsWith("storm");

// V1.43: the Looks page is cut into its pieces, each the control of one row in Settings, Appearance
// (views/SettingsGroups.tsx, core/settingsindex.ts). The Look, Accent, Working on and Layout and text rows are in
// looks/AppearanceSettings.tsx.
type LookProps = { st: Settings; preview: Preview };
const setLooks = (patch: Partial<Settings>) => void taskMapActions.looks(patch);
export function LookOutline({ st, preview }: LookProps) {
  const p1 = p1Design(st.tmP1Style);
  const lk = resolveAppearance(st).look, nb = NOTEBOOK_IDS.has(lk) ? lk : "off";
  return (
    <MsSection title="Outline (Priority 1 group)" changes={looksOption("outline").changes}
      note={nb !== "off" ? "In a Notebook look the Priority 1 group is a box drawn round it in its colour (the dot by its name). These outlines come back with Notebook off."
        : p1Color(st.p1Color) ? "Shown in your Priority 1 colour. Change it with the colour dot on the Priority 1 group." : undefined}>
      {P1_DESIGNS.map((d) => (
        <MsTile key={d.id} kind="outline" id={d.id} label={d.label} on={p1 === d.id} onPick={() => setLooks({ tmP1Style: d.id })}
          onPreview={() => preview(d.label, () => setP1Preview(d.id), () => setP1Preview(null), "outline")}>
          <span className={`tm-p1-frame mini p1d-${d.id}`}>{d.id !== "none" && <P1Art design={d.id} />}<i className="tm-p1-bar" /><i className="tm-p1-bar" /></span>
        </MsTile>
      ))}
    </MsSection>
  );
}
export function LookBackground({ st, preview }: LookProps) {
  const videos = useBgVideos();
  const red = isRedAccount(useVault());
  const set = setLooks;
  const p1 = p1Design(st.tmP1Style), bg = bgDesign(shownBg(st));
  const bgPeek = (id: string, label: string) => preview(label, () => setBgPreview(id), () => setBgPreview(null), "bg");
  return (
    <>
      <PhoneBgChoice st={st} set={set} />
      <MsSection title="Background (whole screen)" changes={looksOption("background").changes}>
        {[...BG_DESIGNS, ...videos.map((v) => ({ id: `video:${v.id}`, label: v.name }))].map((d) => (
          <MsTile key={d.id} kind="bg" id={d.id} label={d.label} on={bg === d.id} onPick={() => set(bgPatch(st, d.id))}
            onPreview={() => bgPeek(d.id, d.label)}>
            {d.id.startsWith("video:") && <video className="tm-bgvideo-sample" src={`/client/bg/${d.id.slice(6)}.mp4`} muted loop playsInline autoPlay aria-hidden="true" />}
            {d.id.startsWith("video:") && bg === d.id && <BgDim saved={st.tmBgVideoBright} sample />}
            {d.id !== "none" && !STORM_SAMPLE(d.id) && !d.id.startsWith("video:") && <span className={`tm-p1-scene p1s-${d.id}`}><i /></span>}
            {STORM_SAMPLE(d.id) && <span className={`tm-storm-sample ${d.id}`}><i /></span>}
            {/* V1.43: your own outline (and Priority 1 colour), not always red, so the tile shows your list with that background. */}
            <span className={`tm-p1-frame mini p1d-${p1}`}>{p1 !== "none" && <P1Art design={p1} />}<i className="tm-p1-bar" /><i className="tm-p1-bar" /></span>
          </MsTile>
        ))}
        {/* The developer's own video (4 Nov 2026): PS's Open panel, a silent copy, then his vault and every device (ps-mac Backgrounds.swift). */}
        {PS && red && (
          <div className="ms-tile-wrap bg">
            <button type="button" className="tm-p1-tile ms-tile ms-add" onClick={() => { sfx.click(); psPost({ type: "bg:choose" }); }}
              title={`Pick an mp4, mov or m4v. ${appName()} makes a silent copy and sends it to your phone and other Mac.`}>
              <span className="tm-p1-sample ms-add-plus" aria-hidden="true">+</span>
              <span className="tm-p1-name">Add video</span>
            </button>
          </div>
        )}
        {GOS && red && <GosAddVideoTile />}
      </MsSection>
      {STORM_SAMPLE(bg) && <div data-set="lightning"><StormControls st={st} set={set} /></div>}
      {isVideoBg(bg) && <div data-set="video-bright"><BgBrightControls st={st} set={set} /></div>}
      <BgFitControls st={st} set={set} />
    </>
  );
}
export function LookBgColour({ st, preview }: LookProps) {
  const bg = bgDesign(shownBg(st));
  const bgPeek = (id: string, label: string) => preview(label, () => setBgPreview(id), () => setBgPreview(null), "bg");
  return (
    <MsSection title="Colour background" changes={looksOption("bgColour").changes}>
      {BG_COLOURS.map((c) => (
        <MsTile key={c.id} kind="bgc" id={c.id} label={c.label} on={bg === `color:${c.id}`} onPick={() => setLooks(bgPatch(st, `color:${c.id}`))}
          onPreview={() => bgPeek(`color:${c.id}`, c.label)}>
          <span className="ms-colour-sample" style={{ background: c.css }} />
          <span className="tm-p1-frame mini p1d-none"><i className="tm-p1-bar" /><i className="tm-p1-bar" /></span>
        </MsTile>
      ))}
    </MsSection>
  );
}
export function LookOwnColour({ st, preview }: LookProps) {
  const bg = bgDesign(shownBg(st));
  return <ColourPicker saved={bg} onSave={(hex) => setLooks(bgPatch(st, customColourBg(hex)))} onPreview={(hex) => preview("Your colour", () => setBgPreview(customColourBg(hex)), () => setBgPreview(null), "bg")} />;
}
export function LookRain({ st, preview }: LookProps) {
  return <RainSection st={st} set={setLooks} preview={preview} />;
}
/** Network monitor on or off (PS on a Mac only): the Network button and the VPN leak alarm. */
export function NetworkSetting({ st }: { st: Settings }) {
  return (
    <div className="tm-ed-seg" role="radiogroup" aria-label="Network monitor">
      <Choice selected={st.netMonitor !== false} onPick={() => setLooks({ netMonitor: true })}>On</Choice>
      <Choice selected={st.netMonitor === false} onPick={() => setLooks({ netMonitor: false })}>Off</Choice>
    </div>
  );
}
export const networkNote = (st: Settings) => st.netMonitor === false
  ? `Off: ${appName()} does not look at the network at all (no live view, no leak alarm). The Network button is hidden.`
  : "On: the Network button (between End your day and the volume mixer), and the VPN leak alarm. Nothing it sees leaves this Mac.";
/** Your own colour behind the list: a hue and a shade slider, saved when you let go (synced like every look). */
function ColourPicker({ saved, onSave, onPreview }: { saved: string; onSave: (hex: string) => void; onPreview: (hex: string) => void }) {
  const own = customOf(saved);
  const start = pickerOf(own ?? DEFAULT_CUSTOM_COLOUR);
  const [hue, setHue] = useState(start.hue), [shade, setShade] = useState(start.shade);
  useEffect(() => { const p = pickerOf(own ?? DEFAULT_CUSTOM_COLOUR); setHue(p.hue); setShade(p.shade); }, [own]);
  const hex = pickerColour(hue, shade);
  const on = !!own;
  const commit = () => { if (hex !== own) onSave(hex); };
  return (
    <section className="ms-sec ms-storm ms-colour-own">
      <h3 className="ms-h">Your own colour</h3>
      <p className="ms-changes">Any colour you like behind the list. Move the sliders, then let go to use it.</p>
      <div className="ms-colour-row">
        <span className={`ms-colour-dot${on ? " on" : ""}`} style={{ background: hex }} aria-hidden="true" />
        <b className="num ms-colour-hex">{hex.toUpperCase()}</b>
        <button type="button" className="ms-peek-btn ms-colour-peek" data-kind="bgc" data-id="custom" onClick={() => onPreview(hex)} aria-label="Preview your colour for 5 seconds">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          Preview
        </button>
        {!on && <button type="button" className="ms-colour-use" onClick={() => { sfx.click(); onSave(hex); }}>Use this colour</button>}
      </div>
      <div className="tm-pop-row ms-slider"><span className="tm-pop-note tm-look-l">Colour</span>
        <input type="range" min={0} max={359} value={hue} className="tm-pop-range ms-hue" aria-label="Background colour hue"
          onChange={(e) => setHue(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} /></div>
      <div className="tm-pop-row ms-slider"><span className="tm-pop-note tm-look-l">Shade</span>
        <input type="range" min={0} max={100} value={shade} className="tm-pop-range ms-shade" aria-label="Background colour shade, deep to pale"
          style={{ ["--hue" as string]: hue }}
          onChange={(e) => setShade(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} /></div>
    </section>
  );
}
/** Rain (core/rain.ts, views/Rain.tsx): the kind, with a Preview each, and how much falls. */
function RainSection({ st, set, preview }: { st: Settings; set: (p: Partial<Settings>) => void; preview: Preview }) {
  const kind = rainKind(st.tmRain), saved = rainAmount(st.tmRainAmount);
  const [amt, setAmt] = useState(saved);
  useEffect(() => { setAmt(saved); }, [saved]);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <>
      <MsSection title="Rain" changes={looksOption("rain").changes}
        note={reduced ? "Reduce motion is on in this device's settings, so rain stays off until you turn it off there." : "Off by default. It stops completely while the list is hidden, so it costs nothing then."}>
        {RAIN_KINDS.map((k) => (
          <MsTile key={k.id} kind="rain" id={k.id} label={k.label} on={kind === k.id} onPick={() => set({ tmRain: k.id })} title={k.note}
            onPreview={() => preview(k.label, () => setRainPreview({ kind: k.id }), () => setRainPreview(null), k.id === "off" ? "none" : "rain")}>
            <span className={`ms-rain-sample rs-${k.id}`} aria-hidden="true"><i /></span>
          </MsTile>
        ))}
      </MsSection>
      {kind !== "off" && (
        <section className="ms-sec ms-storm ms-rain-amt" data-set="rain-amount">
          <h3 className="ms-h">How much rain</h3>
          <p className="ms-changes">{looksOption("rainAmount").changes}</p>
          {/* V1.43: the picture follows the slider as it moves, before you let go. */}
          <span className={`ms-rain-sample rs-${kind} ms-rain-live`} style={{ ["--ra" as string]: rainLayers(amt).a, ["--rb" as string]: rainLayers(amt).b }} aria-hidden="true"><i /><i className="b" /></span>
          <div className="tm-pop-row ms-slider"><span className="tm-pop-note tm-look-l">Amount</span>
            <input type="range" min={0} max={100} step={5} value={amt} className="tm-pop-range" aria-label="How much rain"
              onChange={(e) => setAmt(Number(e.target.value))}
              onPointerUp={() => { if (amt !== saved) set({ tmRainAmount: amt }); }} onKeyUp={() => { if (amt !== saved) set({ tmRainAmount: amt }); }} />
            <b className="num tm-pop-v">{amt}%</b></div>
          <p className="ms-note">{RAIN_KINDS.find((k) => k.id === kind)?.note}</p>
        </section>
      )}
    </>
  );
}
/** A small drawing of each Notebook look for its tile (the look's paper, header and two written lines). */
function NbSample({ id }: { id: string }) {
  if (id === "off") return <span className="ms-theme-sample dark"><i /><i /><i /></span>;
  return (
    <span className={`nb-sample nbs-${id}`} aria-hidden="true">
      <b className="nbs-top" />
      <span className="nbs-line"><i className="nbs-box on" /><em>Call Jo back</em></span>
      <span className="nbs-line"><i className="nbs-box" /><em>Pay the invoice</em></span>
    </span>
  );
}
function MsSection({ title, changes, note, children }: { title: string; changes?: string; note?: string; children: ReactNode }) {
  return (
    <section className="ms-sec">
      <h3 className="ms-h">{title}</h3>
      {changes && <p className="ms-changes">{changes}</p>}
      {note && <p className="ms-note">{note}</p>}
      <div className="ms-grid">{children}</div>
    </section>
  );
}
function MsTile({ kind, id, label, on, onPick, onPreview, children, title }: {
  kind: string; id: string; label: string; on: boolean; onPick: () => void; onPreview: () => void; children: ReactNode; title?: string;
}) {
  return (
    <div className={`ms-tile-wrap ${kind}`}>
      <button type="button" data-kind={kind} data-id={id} role="radio" aria-checked={on} className={`tm-p1-tile ms-tile${on ? " on" : ""}`}
        onClick={() => { if (!on) { sfx.click(); onPick(); } }} title={title ?? label}>
        <span className="tm-p1-sample" style={{ ["--p1x" as string]: "50%", ["--p1y" as string]: "50%", ["--p1w" as string]: "90px", ["--p1h" as string]: "34px" }}>{children}</span>
        <span className="tm-p1-name">{label}</span>
      </button>
      <button type="button" className="ms-peek-btn" data-kind={kind} data-id={id} onClick={onPreview} aria-label={`Preview ${label} for 5 seconds`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
        Preview
      </button>
    </div>
  );
}
/** Lightning brightness and frequency, and the thunder switch and volume (a lightning background is chosen). */
function StormControls({ st, set }: { st: Settings; set: (p: Partial<Settings>) => void }) {
  const intensity = st.tmBgIntensity ?? 60, frequency = st.tmBgFrequency ?? 40, volume = st.tmBgVolume ?? 40, sound = st.tmBgSound === true;
  const [inten, setInten] = useState(intensity), [freq, setFreq] = useState(frequency), [vol, setVol] = useState(volume);
  useEffect(() => { setInten(intensity); setFreq(frequency); setVol(volume); }, [intensity, frequency, volume]);
  const slider = (label: string, aria: string, v: number, setV: (n: number) => void, save: (n: number) => void) => (
    <div className="tm-pop-row ms-slider"><span className="tm-pop-note tm-look-l">{label}</span>
      <input type="range" min={0} max={100} step={5} value={v} className="tm-pop-range" aria-label={aria}
        onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => save(v)} onKeyUp={() => save(v)} />
      <b className="num tm-pop-v">{v}%</b></div>
  );
  return (
    <section className="ms-sec ms-storm">
      <h3 className="ms-h">Lightning</h3>
      <p className="ms-changes">{looksOption("lightning").changes}</p>
      {slider("Brightness", "Lightning brightness", inten, setInten, (n) => set({ tmBgIntensity: n }))}
      {slider("How often", "How often it strikes", freq, setFreq, (n) => set({ tmBgFrequency: n }))}
      <h3 className="ms-h">Thunder</h3>
      <p className="ms-changes">{looksOption("thunder").changes}</p>
      <div className="tm-ed-seg ms-seg" role="radiogroup" aria-label="Thunder sounds">
        <Choice selected={sound} onPick={() => set({ tmBgSound: true })}>On</Choice>
        <Choice selected={!sound} onPick={() => set({ tmBgSound: false })}>Off</Choice>
      </div>
      {sound && slider("Volume", "Thunder volume", vol, setVol, (n) => set({ tmBgVolume: n }))}
      <p className="ms-note">Thunder plays only while the list is showing, one at a time, never louder than this.</p>
    </section>
  );
}

// PS only: the Mac's default microphone, the one every app uses. Switches the moment you pick.
export function MicPicker() {
  const mic = usePsMic();
  if (!mic) return null;
  return (
    <>
      <span className="tm-panel-h">Microphone (all apps) <em className="tm-hover-hint">click one to switch</em></span>
      {mic.devices.length ? (
        <div className="tm-mics" role="radiogroup" aria-label="Default microphone">
          {mic.devices.map((d) => (
            <Choice key={d.uid} selected={mic.current === d.uid} onPick={() => { sfx.click(); chooseMic(d.uid); }} title="Click to switch">
              <span className="dot" aria-hidden="true" />{d.name}
            </Choice>
          ))}
        </div>
      ) : <span className="tm-pop-note">No microphones found.</span>}
    </>
  );
}

// Top right: empties the clipboard (copies nothing), so nothing private gets pasted by mistake.
function ClearClipboard() {
  const [done, setDone] = useState<"" | "ok" | "fail">("");
  useEffect(() => { if (!done) return; const t = window.setTimeout(() => setDone(""), 1600); return () => window.clearTimeout(t); }, [done]);
  return (
    <button type="button" className={`tm-pill-btn icon${done === "ok" ? " ok" : done === "fail" ? " off" : ""}`} title={done === "ok" ? "Clipboard cleared" : done === "fail" ? "Could not clear the clipboard" : "Clear the clipboard (copies nothing)"} aria-label="Clear the clipboard"
      onClick={() => { sfx.click(); taskMapActions.clearClipboard().then(() => setDone("ok"), () => setDone("fail")); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {done === "ok" ? <path d="M5 12l5 5L20 7" /> : <><rect x="8" y="3" width="8" height="4" rx="1.2" /><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /></>}
      </svg>
    </button>
  );
}

// Bottom right, above Overdue: brings back the last task you ticked off. Also Cmd+Z / Ctrl+Z.
function UndoButton({ docked }: { docked?: boolean }) {
  const stack = useUndo();
  const fresh = stack.filter((x) => Date.now() - x.at < 15 * 60_000);
  const last = fresh[fresh.length - 1];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // With the Tab list open over the To-do page, only the open one answers Cmd+Z.
      if (docked && document.querySelector(".tm-overlay:not(.tm-docked)")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !(e.target as HTMLElement).matches?.("input, textarea, [contenteditable='true']")) {
        e.preventDefault(); undoLast();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [docked]);
  if (!last) return null;
  return (
    <button type="button" className="tm-undo" onMouseDown={(e) => e.stopPropagation()} onClick={undoLast}
      title="Bring back the last task you ticked off (Cmd+Z)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
      <span className="tm-undo-l">Undo</span>
      <span className="tm-undo-t">{last.title}</span>
      {fresh.length > 1 && <span className="tm-undo-n num">{fresh.length}</span>}
    </button>
  );
}

// ---------- the Priority 1 outline as a drop zone (the developer, 19 Oct 2026) ----------
// Let go anywhere inside the P1 group's outline (its whole box, padding and edge included) and the
// task becomes Priority 1, placed in the group at that spot, whatever it was before. While a drag is
// over the outline it brightens and shows "Priority 1". Only a class changes, so nothing moves.
// While a drop opens room inside the group, the outline grows by that room (--p1-grow) so it still
// wraps every P1 row; the "is it inside" test always uses its size without that growth, so the
// highlight can never flicker on and off as the outline grows.
function p1Box(): { frame: HTMLElement; r: DOMRect } | null {
  const frame = document.querySelector<HTMLElement>('.tm-overlay .tm-list[data-sec="p1"] > .tm-p1-frame:not(.mini)');
  if (!frame) return null;
  const b = frame.getBoundingClientRect();
  const grow = parseFloat(frame.style.getPropertyValue("--p1-grow")) || 0;
  const r = new DOMRect(b.left, b.top, b.width, Math.max(0, b.height - grow));
  return r.height > 0 ? { frame, r } : null;
}
function overP1(x: number, y: number) {
  const b = p1Box();
  return !!b && x >= b.r.left - 4 && x <= b.r.right + 4 && y >= b.r.top - 4 && y <= b.r.bottom + 4;
}
function hintP1(on: boolean, grow = 0) {
  const b = p1Box();
  if (b && b.frame.classList.contains("drop-p1") !== on) { b.frame.classList.toggle("drop-p1", on); if (on) sfx.hover(); }
  if (b) b.frame.style.setProperty("--p1-grow", `${on ? Math.round(grow) : 0}px`);
  if (!on) document.querySelectorAll<HTMLElement>(".tm-p1-frame.drop-p1").forEach((f) => { f.classList.remove("drop-p1"); f.style.setProperty("--p1-grow", "0px"); });
}
/** Where a task let go at (x, y) lands in Priorities, and whether it is Priority 1 there.
 *  Inside the outline: P1, kept within the group. Below it: not P1. Above it, or no group yet: the
 *  old rule (the top of the list, or among the P1 rows, is P1). */
export function p1Drop(next: string[], moved: string, p1: Set<string>, x: number, y: number): { next: string[]; on: boolean } {
  const b = p1Box();
  let on: boolean;
  if (overP1(x, y)) on = true;
  else if (b && y > b.r.bottom + 4) on = false;
  else on = p1AfterMove(next, moved, p1);
  if (on) {
    const group = next.filter((id) => id !== moved && p1.has(id)).length;
    const at = next.indexOf(moved);
    if (at > group) { const out = next.filter((id) => id !== moved); out.splice(group, 0, moved); return { next: out, on }; }
  }
  return { next, on };
}

// ---------- dragging a suggestion onto the list ----------
// Runs outside React for smoothness: a ghost card follows the mouse on the GPU, the list under it
// slides apart to make room, and on release the ghost glides into the gap with a plop. The new
// task then takes the gap's place (it "plops in", see .plop-in).
export function startSuggestDrag(e: React.PointerEvent, title: string, onDrop: (sec: "prio" | "daily", index: number, p1: boolean) => void, onStart: () => void) {
  if (e.button !== 0 || (e.target as Element).closest("button")) return;
  const root = document.querySelector<HTMLElement>(".tm-overlay");
  const src = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (!root) return;
  const sx = e.clientX, sy = e.clientY;
  let x = sx, y = sy, lastX = sx, tilt = 0, raf = 0;
  let ghost: HTMLDivElement | null = null;
  // index: the place in the whole ranked list (Priority 1 first), what onDrop wants; at: the row in this list.
  let target: { list: HTMLElement; sec: "prio" | "daily"; index: number; at: number; p1?: boolean } | null = null;
  const W = 380;
  const offX = Math.min(W - 40, Math.max(40, sx - src.left)), offY = 26;

  const clearRoom = () => clearDropRoom(root);
  // Priority 1, Priorities and Every day take it (not the developer's own groups: a new task starts on his list).
  const p1Rows = () => root.querySelectorAll(':scope .tm-list[data-sec="p1"] > .tm-row').length;
  const find = () => {
    let best: typeof target = null;
    for (const list of root.querySelectorAll<HTMLElement>('.tm-list[data-sec="p1"], .tm-list[data-sec="prio"], .tm-list[data-sec="daily"]')) {
      const r = list.getBoundingClientRect();
      if (x < r.left - 60 || x > r.right + 60 || y < r.top - 50 || y > r.bottom + 50) continue;
      const at = rowIndex(list, y), sec = list.dataset.sec;
      best = sec === "daily" ? { list, sec: "daily", index: at, at } : sec === "p1" ? { list, sec: "prio", index: at, at, p1: true } : { list, sec: "prio", index: p1Rows() + at, at };
    }
    // Over the empty middle of the screen with no list near: the end of Priorities.
    if (!best && root.querySelector(".tm-inner")?.contains(document.elementFromPoint(x, y))) {
      const list = root.querySelector<HTMLElement>('.tm-list[data-sec="prio"]');
      if (list) { const at = list.querySelectorAll(":scope > .tm-row").length; best = { list, sec: "prio", index: p1Rows() + at, at }; }
    }
    return best;
  };
  const frame = () => {
    raf = 0;
    if (!ghost) return;
    tilt += ((Math.max(-8, Math.min(8, (x - lastX) * 0.6))) - tilt) * 0.25;
    lastX = x;
    ghost.style.transform = `translate3d(${x - offX}px, ${y - offY}px, 0) rotate(${tilt.toFixed(2)}deg) scale(1.04)`;
    const t = find();
    hintP1(!!t?.p1, ghost.offsetHeight + 10);   // the room the list opens for the card
    if (t?.list !== target?.list || t?.at !== target?.at) {
      clearRoom();
      target = t;
      if (t) {
        showDropRoom({ key: "", list: t.list, index: t.at }, ghost.offsetHeight + 10);
        sfx.hover();
      }
      ghost.classList.toggle("lost", !t);
    }
    if (Math.abs(tilt) > 0.05) raf = requestAnimationFrame(frame);
  };
  const move = (ev: PointerEvent) => {
    x = ev.clientX; y = ev.clientY;
    if (!ghost) {
      if (Math.hypot(x - sx, y - sy) < 5) return;
      ghost = document.createElement("div");
      ghost.className = "tm-ghost";
      ghost.style.width = `${W}px`;
      ghost.textContent = title;
      document.body.appendChild(ghost);
      onStart();
      sfx.click();
      document.documentElement.classList.add("tm-dragging");
    }
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const end = (ev: PointerEvent | KeyboardEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("keydown", esc, true);
    cancelAnimationFrame(raf);
    document.documentElement.classList.remove("tm-dragging");
    hintP1(false);
    const g = ghost;
    if (!g) return;
    const t = ev.type === "pointerup" ? find() : null;
    g.classList.add("landing");
    if (!t) {
      clearRoom();
      g.style.transform = `translate3d(${src.left}px, ${src.top}px, 0) scale(.9)`;
      g.style.opacity = "0";
      window.setTimeout(() => g.remove(), 260);
      return;
    }
    // Glide into the gap, plop, then hand over to the real row the moment it arrives.
    const r = t.list.getBoundingClientRect();
    const rows = [...t.list.querySelectorAll<HTMLElement>(":scope > .tm-row")];
    const top = t.at < rows.length ? r.top + rows[t.at].offsetTop
      : rows.length ? r.top + rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight + 10 : r.top;
    g.style.width = `${r.width}px`;
    g.style.transform = `translate3d(${r.left}px, ${top}px, 0) scale(1)`;
    window.setTimeout(() => sfx.plop(), 150);
    onDrop(t.sec, t.index, !!t.p1);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearRoom();
      g.classList.add("gone");
      window.setTimeout(() => g.remove(), 160);
    };
    const obs = new MutationObserver(() => finish());
    obs.observe(t.list, { childList: true });
    obs.observe(root.querySelector(".tm-inner") || root, { childList: true });
    window.setTimeout(finish, 1500);
  };
  const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end(ev); } };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("keydown", esc, true);
}

// Bottom right: Overdue (the developer, 4 Nov 2026; it replaced Urgent and keeps its red look). A task 48
// hours past its due leaves the list and shows here by itself (core/overdue.ts has the rule); it is
// worked out from the task, so nothing extra is saved and every device agrees. Tick it off like on
// the list (Undo brings it back), give it a new date (the pencil or a double click) or drag it onto
// the list (it gets today's date) to move it back, or × to take its date off (a repeat skips to its
// next round). Hidden while nothing is overdue.
// Its colours and effect come from Settings, Appearance, Overdue card (core/overduelook.ts, V1.44); unset, it looks
// exactly as before. A colour being tried in Settings shows here at once.
function Overdue({ list, prio, daily, today, look: savedLook }: { list: Doc<Todo>[]; prio: Doc<Todo>[]; daily: Doc<Todo>[]; today: string; look: OverdueLook }) {
  const card = useOverdueCard(useOverdueLook(savedLook));
  const [editId, setEditId] = useState<string | null>(null);
  const [editDue, setEditDue] = useState("");
  const startEdit = (d: Doc<Todo>) => { sfx.click(); setEditId(d.id); setEditDue(d.data.due && /^\d{4}-\d{2}-\d{2}/.test(d.data.due) ? d.data.due.slice(0, 10) : today); };
  // Ticked, dragged away or given a date: hidden at once while the save goes round (PS saves through its main window).
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (gone.size && [...gone].some((id) => !list.some((d) => d.id === id))) setGone((cur) => new Set([...cur].filter((id) => list.some((d) => d.id === id))));
  }, [list, gone]);
  const hide = (id: string) => {
    setGone((cur) => new Set(cur).add(id));
    window.setTimeout(() => setGone((cur) => { const n = new Set(cur); n.delete(id); return n; }), 5000);   // the save never landed: show it again
  };
  const saveDue = (d: Doc<Todo>) => {
    const v = editDue;
    setEditId(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v === d.data.due) return;
    sfx.drop();
    if (isOverdue({ ...d.data, due: v }, Date.now(), homeTz())) { void taskMapActions.update(d.id, { due: v }); return; }   // still 48 hours late: it stays
    hide(d.id);
    const old = d.data.due ?? null;
    pushUndoAction(`due:${d.id}`, d.data.title, () => void taskMapActions.update(d.id, { due: old }));
    void taskMapActions.update(d.id, { due: v });
  };
  const lists = useRef({ prio, daily });
  lists.current = { prio, daily };
  // The same as ticking it on the list: done, counts toward the day, Undo (bottom right) brings it back.
  const tick = (d: Doc<Todo>, li: HTMLLIElement | null) => {
    sfx.done();
    pushUndo({ id: d.id, title: d.data.title });
    const go = () => { hide(d.id); sendTick(d.id, true); };
    if (!li || matchMedia("(prefers-reduced-motion: reduce)").matches) { go(); return; }
    li.classList.add("ticked");
    li.style.overflow = "hidden";
    li.animate([{ height: `${li.offsetHeight}px`, opacity: 1, transform: "none" }, { height: `${li.offsetHeight}px`, opacity: 1, transform: "none", offset: 0.45 },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "-8px", opacity: 0, transform: "translateX(40px) scale(.96)" }],
      { duration: 620, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }).finished.then(go, go);
  };
  const undate = (d: Doc<Todo>) => {
    sfx.click();
    hide(d.id);
    const old = d.data.due ?? null;
    pushUndoAction(`due:${d.id}`, d.data.title, () => void taskMapActions.update(d.id, { due: old }));
    void taskMapActions.update(d.id, clearDuePatch(d.data, today));
  };
  const shown = list.filter((d) => !gone.has(d.id));
  if (!shown.length) return null;
  return (
    <aside className={`tm-aware tm-overdue${card.className}`} style={card.style} aria-label="Overdue" onMouseDown={(e) => e.stopPropagation()}>
      <OverdueFxLayer fx={card.fx} />
      <span className="tm-aware-h">Overdue</span>
      <ul>
        {shown.map((d) => {
          const t = d.data, rep = t.type === "daily";
          return (
            <li key={d.id} data-id={d.id} className={editId === d.id ? "editing" : ""} onMouseEnter={() => sfx.hover()}
              onContextMenu={(e) => openTaskMenu(e, d.id, "overdue")}
              onKeyDown={(e) => { if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); openTaskMenuAt(e.currentTarget, d.id, "overdue"); } }}
              title={editId === d.id ? undefined : `Due ${t.due ? fmtDate(t.due.slice(0, 10)) : ""}. Tick it off, drag it onto your list, or double click for a new date`}
              onDoubleClick={(e) => { if (editId !== d.id && !(e.target as Element).closest("button")) startEdit(d); }}
              onPointerDown={(e) => editId !== d.id && startSuggestDrag(e, t.title, (sec, i, p1) => {
                // Onto the list: due today, at the spot it was dropped (when that section takes its kind).
                hide(d.id);
                const fits = (sec === "daily") === rep;
                const target = sec === "daily" ? lists.current.daily : lists.current.prio;
                pushUndoAction(`due:${d.id}`, t.title, () => void taskMapActions.update(d.id, { due: t.due ?? null }));
                void taskMapActions.update(d.id, { due: today, ...(fits ? { order: orderForPriority(target, i + 1) } : {}), ...(fits && !rep ? { p1: sec === "prio" && p1 } : {}) });
              }, () => {})}>
              <button type="button" className="tm-aware-tick" aria-label={`Tick off: ${t.title}`} title="Done"
                onPointerDown={(e) => { const li = (e.currentTarget as HTMLElement).closest("li"); pressTick(e, d.id, () => tick(d, li)); }}
                onClick={(e) => { const li = (e.currentTarget as HTMLElement).closest("li"); clickTick(d.id, () => tick(d, li)); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              </button>
              {editId === d.id ? (
                <input type="date" className="tm-aware-edit" autoFocus value={editDue} aria-label={`New date: ${t.title}`}
                  onChange={(e) => setEditDue(e.target.value)} onBlur={() => saveDue(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); saveDue(d); }
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditId(null); }
                  }} />
              ) : <span className="tm-aware-t">{t.title}</span>}
              {editId !== d.id && (
                <button type="button" className="tm-aware-ed" aria-label={`New date: ${t.title}`} title="New date" onClick={() => startEdit(d)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
                </button>
              )}
              <button type="button" className="tm-aware-x" aria-label={rep ? `Skip to the next time: ${t.title}` : `Take the date off: ${t.title}`}
                title={rep ? "Skip to its next date (not done)" : "Take the date off, back on your list (not done)"} onClick={() => undate(d)}>×</button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

type ClientOpt = { id: string; name: string };
const freshUntil = new Map<string, number>();
const TM_REPEAT = { wrap: "tm-repeat", select: "tm-ed-client", input: "tm-ed-num", date: "tm-ed-date" };

function Section({ skey, kind, title, list, working, today, numbered, editing, onEdit, clients, design, color, move, lists, group, groups, stay }: {
  skey: string; kind: "p1" | "prio" | "daily" | "group"; title: string; list: Doc<Todo>[]; working: Set<string>; today: string; numbered?: boolean; stay?: Set<string>;
  editing: string | null; onEdit: (id: string | null) => void; clients: ClientOpt[]; design?: string; color?: string | null;
  move?: ReturnType<typeof useSectionOrder>; lists: TabLists; group?: TaskGroup; groups?: TaskGroup[];
}) {
  const ids = list.map((d) => d.id);
  const byId = new Map(list.map((d) => [d.id, d]));
  const sel = useSelection();
  const el = useRef<HTMLElement | null>(null);
  // A row dragged within its section reorders it. Let go over another section and it moves there
  // (into Priority 1 makes it P1, out of a group takes it out); that section opens room for it.
  // Priority 1 and Priorities share one order (core/groups.ts).
  const { order, row, dragging } = useDragOrder(ids, () => {}, {
    alone: true,
    onDrop: () => sfx.drop(),
    onMove: (x, y, id) => {
      const r = el.current?.querySelector<HTMLElement>(":scope > .tm-list > .tm-row[data-dragging]");
      const t = crossHint(el.current, x, y, skey, [byId.get(id)?.data.type ?? "once"], r ? r.offsetHeight + 10 : 60);
      const root = el.current?.closest(".tm-overlay");
      if (!t && kind === "prio" && root && aboveIsP1(root, lists.p1.length, x, y)) hintP1(true, r ? r.offsetHeight + 10 : 60);
      listDragHint(x, y);   // V1.55: a dot or an edge takes it to another list (views/ListPager.tsx)
    },
    onEnd: (e: DragEnd) => {
      listDragHint(null);
      const to = listDropAt(e.x, e.y);
      if (to) { crossHint(el.current, e.x, e.y, skey, [], 0, true); moveToList([e.id], to.page); return; }
      const t = crossHint(el.current, e.x, e.y, skey, [byId.get(e.id)?.data.type ?? "once"], 0, true);
      if (t) { void taskMapActions.moveTasks({ ids: [e.id], to: t.key, index: t.index }); return; }
      const root = el.current?.closest(".tm-overlay");
      if (kind === "prio" && root && aboveIsP1(root, lists.p1.length, e.x, e.y)) { hintP1(false); void taskMapActions.moveTasks({ ids: [e.id], to: "p1", index: lists.p1.length }); return; }
      if (!e.moved) return;
      if (kind === "p1") void taskMapActions.reorder([...e.next, ...lists.prio.map((d) => d.id)]);
      else if (kind === "prio") {
        // No Priority 1 group yet: the very top of Priorities starts one (as before).
        if (!lists.p1.length && e.next[0] === e.id) void taskMapActions.reorder(e.next, { id: e.id, on: true });
        else void taskMapActions.reorder([...lists.p1.map((d) => d.id), ...e.next]);
      } else void taskMapActions.reorder(e.next);
    },
  });
  const nums = numbered ? prioNumbers(order.map((id) => ({ id, p1: false, unranked: !!byId.get(id)?.data.unranked }))) : null;
  const ranked = kind === "p1" || kind === "prio" ? lists.ranked : undefined;
  // Tasks that join while the list is open (eg a dropped suggestion) plop in.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current) for (const id of ids) if (!seen.current.has(id)) freshUntil.set(id, Date.now() + 700);
  useEffect(() => { seen.current = new Set(ids); });
  const secRef = move?.section(skey).ref;
  return (
    <section ref={(n) => { el.current = n; secRef?.(n); }} className={`tm-sec tm-sec-${kind}${dragging ? " is-sorting" : ""}${move?.movable ? " movable" : ""}`} data-key={skey}>
      <h3 className={`tm-sec-h${group ? " tm-grp-h" : ""}${kind === "p1" ? " tm-p1-h" : ""}`} {...(move?.movable ? move.head(skey) : {})}
        onContextMenu={(e) => openSecMenu(e, skey)}>
        {group && groups ? <GroupHead g={group} groups={groups} count={list.length} /> : kind === "group" ? title : <SecTitle skey={kind} title={title} />}
        {kind === "p1" && <P1ColourPick saved={color ?? null} />}
        {numbered && <span className="tm-sec-note">drag to reorder</span>}
      </h3>
      <ul className="tm-list" data-sec={skey}>
        {kind === "p1" && order.length > 0 && <P1Frame count={order.length} design={design || "red-glisten"} />}
        {order.map((id) => {
          const d = byId.get(id);
          if (!d) return null;
          return editing === id
            ? <Editor key={id} d={d} clients={clients} onDone={() => onEdit(null)} ranked={ranked} />
            : <Row key={id} d={d} n={kind === "p1" ? 1 : nums ? nums.get(id) ?? null : null} working={working.has(id)} today={today} drag={row(id)} onEdit={() => onEdit(id)}
                fresh={(freshUntil.get(id) ?? 0) > Date.now()} sel={sel.has(id)} ticked={stay?.has(id)} />;
        })}
        {group && order.length === 0 && <li className="tm-grp-empty">Cmd-click tasks, then drag them here</li>}
      </ul>
    </section>
  );
}

// A task group's header: its name (double click or the pencil to rename; a new group opens ready
// to type), how many tasks, and Ungroup (asks once more; the tasks go back, nothing is deleted).
function GroupHead({ g, groups, count }: { g: TaskGroup; groups: TaskGroup[]; count: number }) {
  const [edit, setEdit] = useState(() => renameNext === g.id);
  useEffect(() => { if (renameNext === g.id) renameNext = null; }, [g.id]);
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return; const t = window.setTimeout(() => setSure(false), 3000); return () => window.clearTimeout(t); }, [sure]);
  const saved = useRef(false);
  const save = (v: string) => {
    if (saved.current) return;
    saved.current = true;
    setEdit(false);
    taskMapActions.editing(false);
    const name = v.replace(/\s+/g, " ").trim().slice(0, 60);
    if (name && name !== g.name) void taskMapActions.looks({ tmGroups: groups.map((x) => (x.id === g.id ? { ...x, name } : x)) });
  };
  return (
    <>
      {edit
        ? <input className="tm-grp-name no-drag" autoFocus defaultValue={g.name} maxLength={60} aria-label="Group name" spellCheck={false}
            onFocus={(e) => { saved.current = false; e.currentTarget.select(); taskMapActions.editing(true); }}
            onBlur={(e) => save(e.currentTarget.value)}
            onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(e.currentTarget.value); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); save(g.name); }
            }} />
        : <span className="tm-grp-t" title="Double click to rename" onDoubleClick={() => { sfx.click(); setEdit(true); }}>{g.name}</span>}
      <span className="tm-sec-note num">{count}</span>
      <span className="tm-grp-tools">
        {!edit && <button type="button" className="tm-grp-btn no-drag" title="Rename" aria-label={`Rename ${g.name}`} onClick={() => { sfx.click(); setEdit(true); }}>
          <svg {...ICON} width="13" height="13"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
        </button>}
        <button type="button" className={`tm-grp-btn no-drag${sure ? " sure" : ""}`} aria-label={sure ? `Click again to ungroup ${g.name}` : `Ungroup ${g.name}`}
          title={sure ? "Click again: the tasks go back to Priorities and Every day" : "Ungroup"}
          onClick={() => { if (!sure) { sfx.click(); setSure(true); } else { sfx.drop(); void taskMapActions.ungroup(g.id); } }}>
          {sure ? "Ungroup?" : <svg {...ICON} width="13" height="13"><path d="M6 6l12 12M18 6L6 18" /></svg>}
        </button>
      </span>
    </>
  );
}

// ---------- Cmd-click selection, and dragging tasks between sections or into a new group ----------
// The developer, 29 Oct 2026: Cmd-click several tasks, drag them out of the list and they form a new group
// (named straight away); drag them onto a group (or any section that takes them) and they join it.
let selIds = new Set<string>();
const selSubs = new Set<() => void>();
function setSel(next: Set<string>) { selIds = next; selSubs.forEach((f) => f()); }
function clearSel() { if (selIds.size) setSel(new Set()); }
function toggleSel(id: string) { const n = new Set(selIds); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); }
export { toggleSel, clearSel };
export function useSelection() { return useSyncExternalStore((l) => { selSubs.add(l); return () => { selSubs.delete(l); }; }, () => selIds); }
/** The section order right now (the Overlay keeps it here), for a new group's place. */
const tabNow: { full: string[]; shown: string[] } = { full: [], shown: [] };
/** A group just made: its header opens ready to type the name. */
let renameNext: string | null = null;

type DropAt = { key: string; list: HTMLElement; index: number };
const sectionEls = (root: Element) => [...root.querySelectorAll<HTMLElement>(".tm-inner .tm-sec[data-key]")].filter((el) => sectionOnShownPage(el));
/** Only the page on show counts: the pages beside it are drawn too (inert, tl-near), and a section is not a direct child of the list box. */
const sectionOnShownPage = (el: Element) => !el.closest(".tl-near");
const boxOf = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { key: el.dataset.key!, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
/** The section under the pointer (with a little room either side), if any. */
function sectionAt(root: Element, x: number, y: number) {
  const els = sectionEls(root);
  const key = hitSection(els.map(boxOf), x, y);
  return els.find((el) => el.dataset.key === key) ?? null;
}
/** Priorities let go above its own section, Priority 1 being there: the drop is Priority 1 (core/groups.ts). */
function aboveIsP1(root: Element, p1Count: number, x: number, y: number) {
  const find = (k: string) => sectionEls(root).find((el) => el.dataset.key === k);
  const a = find("prio"), b = find("p1");
  return dropAbovePrioIsP1(p1Count, a ? boxOf(a) : null, b ? boxOf(b) : null, x, y);
}
/** Where among a list's rows y falls (layout positions, so rows already moving aside don't count). */
function rowIndex(list: HTMLElement, y: number) {
  const top = list.getBoundingClientRect().top;
  let i = 0;
  for (const row of list.querySelectorAll<HTMLElement>(":scope > .tm-row")) if (top + row.offsetTop + row.offsetHeight / 2 < y) i++;
  return i;
}
function clearDropRoom(root: Element) {
  root.querySelectorAll(".tm-room").forEach((el) => el.classList.remove("tm-room"));
  root.querySelectorAll(".tm-list.room").forEach((el) => el.classList.remove("room"));
  root.querySelectorAll(".tm-sec.drop-target, .tm-drop-empty.drop-target").forEach((el) => el.classList.remove("drop-target"));
}
/** The list opens room at the drop place (as for a dragged new task). */
function showDropRoom(t: DropAt, room: number) {
  t.list.style.setProperty("--room", `${room}px`);
  t.list.classList.add("room");
  (t.list.closest(".tm-sec") || t.list).classList.add("drop-target");
  [...t.list.querySelectorAll<HTMLElement>(":scope > .tm-row")].forEach((row, i) => { if (i >= t.index) row.classList.add("tm-room"); });
}
/** Another section that takes these tasks, under the pointer. */
function dropTarget(root: Element, x: number, y: number, from: string | null, types: Todo["type"][]): DropAt | null {
  const sec = sectionAt(root, x, y);
  const key = sec?.dataset.key;
  if (!sec || !key || key === from || !accepts(key, types)) return null;
  const list = sec.querySelector<HTMLElement>(":scope > .tm-list");
  return list ? { key, list, index: rowIndex(list, y) } : null;
}
let crossLast = "";
/** A single row dragged out of its own section: shows (or, at the end, clears and returns) where it would go. */
function crossHint(sec: HTMLElement | null, x: number, y: number, from: string, types: Todo["type"][], room: number, end = false): DropAt | null {
  const root = sec?.closest(".tm-overlay");
  if (!root) return null;
  const t = dropTarget(root, x, y, from, types);
  if (end) { crossLast = ""; clearDropRoom(root); hintP1(false); return t; }
  const sig = t ? `${t.key}:${t.index}` : "";
  if (sig !== crossLast) {
    crossLast = sig;
    clearDropRoom(root);
    if (t) { showDropRoom(t, room); sfx.hover(); }
  }
  hintP1(t?.key === "p1", room);
  return t;
}

/** Mouse down on a task: with Cmd held, or on a task already picked, this drag moves every picked
 *  task. A plain click is left alone (the row's click capture picks or lets go). */
function startBundle(e: React.PointerEvent, id: string): boolean {
  if (e.button !== 0 || e.pointerType !== "mouse" || (!e.metaKey && !selIds.has(id))) return false;
  if ((e.target as HTMLElement).closest("input, textarea, select, a, [contenteditable='true']")) return false;
  const root = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tm-overlay");
  if (!root) return false;
  const sx = e.clientX, sy = e.clientY;
  let x = sx, y = sy, raf = 0, sig = "";
  let ghost: HTMLDivElement | null = null, line: HTMLElement | null = null, label: HTMLElement | null = null;
  let ids: string[] = [], types: Todo["type"][] = [], names = new Map<string, string>();
  type NewAt = { key: "new"; at: number; y: number; left: number; width: number };
  type Target = DropAt | NewAt;
  const isNew = (t: Target | null): t is NewAt => !!t && "at" in t;
  const find = (): Target | null => {
    const sec = sectionAt(root, x, y);
    if (sec) {
      const key = sec.dataset.key!, list = sec.querySelector<HTMLElement>(":scope > .tm-list");
      return list && accepts(key, types) ? { key, list, index: rowIndex(list, y) } : null;
    }
    // Anywhere else (beside the list, or between two sections): a new group in the nearest gap.
    const secs = sectionEls(root);
    const rs = secs.map((el) => el.getBoundingClientRect());
    let at = 0;
    rs.forEach((r) => { if (r.top + r.height / 2 < y) at++; });
    const inner = root.querySelector(".tm-inner")?.getBoundingClientRect();
    const gy = !rs.length ? y : at === 0 ? rs[0].top - 13 : at >= rs.length ? rs[rs.length - 1].bottom + 13 : (rs[at - 1].bottom + rs[at].top) / 2;
    const left = rs[0]?.left ?? (inner ? inner.left + 24 : x - 200), width = rs[0]?.width ?? 400;
    return { key: "new", at, y: gy, left, width };
  };
  const paint = () => {
    raf = 0;
    if (!ghost) return;
    ghost.style.transform = `translate3d(${x - 30}px, ${y - 26}px, 0) rotate(-1.5deg) scale(1.03)`;
    // V1.55: onto a list's dot or the list's left or right edge: to that list (views/ListPager.tsx).
    listDragHint(x, y);
    const tl = listDropAt(x, y);
    if (tl) {
      if (sig === `list:${tl.page}`) return;
      sig = `list:${tl.page}`;
      clearDropRoom(root); hintP1(false); line?.remove(); line = null;
      ghost.classList.remove("lost");
      if (label) label.textContent = listName(tl.page);
      sfx.hover();
      return;
    }
    const t = find();
    const now = !t ? "" : isNew(t) ? `new:${t.at}` : `${t.key}:${t.index}`;
    hintP1(t?.key === "p1", 60);
    if (now === sig) return;
    sig = now;
    clearDropRoom(root);
    ghost.classList.toggle("lost", !t);
    if (isNew(t)) {
      const n = t;
      // On the page itself: the list's blurred backdrop would shift a fixed element inside it.
      if (!line) { line = document.createElement("div"); line.className = "tm-newgroup"; line.textContent = "New group"; document.body.appendChild(line); }
      line.style.left = `${n.left}px`; line.style.width = `${n.width}px`; line.style.top = `${n.y}px`;
      if (label) label.textContent = "New group";
    } else {
      line?.remove(); line = null;
      if (t) showDropRoom(t, 60);
      if (label) label.textContent = !t ? "Can't go there" : t.key === "p1" ? "Priority 1" : t.key === "prio" ? "Priorities" : t.key === "daily" ? "Every day"
        : root.querySelector<HTMLElement>(`.tm-sec[data-key="${t.key}"] .tm-grp-t`)?.textContent || "Group";
    }
    if (t) sfx.hover();
  };
  const move = (ev: PointerEvent) => {
    x = ev.clientX; y = ev.clientY;
    if (!ghost) {
      if (Math.hypot(x - sx, y - sy) < 6) return;
      // Start: this task joins the picked ones; all of them travel together, top to bottom.
      if (!selIds.has(id)) setSel(new Set([...selIds, id]));
      const rows = [...root.querySelectorAll<HTMLElement>(".tm-inner .tm-row[data-id]")].filter((r) => selIds.has(r.dataset.id!));
      ids = rows.map((r) => r.dataset.id!);
      types = rows.map((r) => (r.dataset.type === "daily" ? "daily" : "once"));
      names = new Map(rows.map((r) => [r.dataset.id!, r.querySelector(".tm-t")?.textContent || ""]));
      if (!ids.length) { end(ev); return; }
      rows.forEach((r) => r.classList.add("sel-lift"));
      ghost = document.createElement("div");
      ghost.className = "tm-ghost tm-bundle";
      ghost.style.width = `${Math.min(420, Math.max(300, rows[0].offsetWidth * 0.6))}px`;
      if (ids.length > 1) ghost.classList.add("stack");
      const t = document.createElement("span"); t.className = "tm-bundle-t"; t.textContent = names.get(ids[0]) || "";
      ghost.appendChild(t);
      if (ids.length > 1) { const b = document.createElement("b"); b.className = "tm-bundle-n num"; b.textContent = String(ids.length); ghost.appendChild(b); }
      label = document.createElement("span"); label.className = "tm-bundle-to"; ghost.appendChild(label);
      document.body.appendChild(ghost);
      document.documentElement.classList.add("tm-dragging");
      document.body.classList.add("is-dragging");
      sfx.click();
    }
    ev.preventDefault();
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const end = (ev: PointerEvent | KeyboardEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", esc, true);
    cancelAnimationFrame(raf);
    const g = ghost;
    if (!g) return;
    document.documentElement.classList.remove("tm-dragging");
    document.body.classList.remove("is-dragging");
    // The drag ends with a click on a row; swallow it.
    const stop = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 50);
    listDragHint(null);
    const tl = ev.type === "pointerup" ? listDropAt(x, y) : null;
    const t = ev.type === "pointerup" && !tl ? find() : null;
    line?.remove();
    hintP1(false);
    root.querySelectorAll(".sel-lift").forEach((r) => r.classList.remove("sel-lift"));
    g.classList.add("landing");
    if (tl) {
      clearDropRoom(root);
      moveToList(ids, tl.page);
      clearSel();
      g.classList.add("gone");
      window.setTimeout(() => g.remove(), 180);
      return;
    }
    if (!t) {
      clearDropRoom(root);
      g.style.transform = `translate3d(${sx - 30}px, ${sy - 26}px, 0) scale(.9)`;
      g.style.opacity = "0";
      window.setTimeout(() => g.remove(), 260);
      return;
    }
    if (isNew(t)) {
      const gid = newGroupId();
      const at = t.at;
      const order = tabNow.full.filter((k) => k !== groupKey(gid));
      const before = tabNow.shown[at];
      order.splice(before ? order.indexOf(before) : order.length, 0, groupKey(gid));
      renameNext = gid;
      void taskMapActions.moveTasks({ ids, to: "new", index: 0 }, { group: { id: gid, name: "New group" }, order, page: pageForNewGroup() });
    } else void taskMapActions.moveTasks({ ids, to: t.key, index: t.index });
    window.setTimeout(() => sfx.plop(), 120);
    clearSel();
    g.classList.add("gone");
    window.setTimeout(() => { clearDropRoom(root); g.remove(); }, 180);
  };
  const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape" && ghost) { ev.preventDefault(); ev.stopPropagation(); end(ev); } };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("keydown", esc, true);
  return true;
}

// ---------- Priority 1: one outline around the whole group, in the look the developer picked ----------
// The slider in Settings previews looks live (this page only) before one is saved.
let p1Preview: string | null = null;
const p1Listeners = new Set<() => void>();
export function setP1Preview(v: string | null) { p1Preview = v; p1Listeners.forEach((l) => l()); }
function useP1Preview() {
  return useSyncExternalStore((l) => { p1Listeners.add(l); return () => { p1Listeners.delete(l); }; }, () => p1Preview);
}
// A Looks preview with no task in Priority 1 shows this example group (core/lookspreview.ts). Never saved: the
// preview's click catcher covers it, so it cannot be ticked, dragged or edited.
const sampleTodo = (id: string, title: string, order: number): Doc<Todo> => ({ id, ws: null, kind: "todo", author: null, updatedAt: null,
  data: { title, type: "once", done: false, order, p1: true } });
const SAMPLE_P1: Doc<Todo>[] = [sampleTodo("pv-sample-1", "Example Priority 1 task", -2), sampleTodo("pv-sample-2", "Another one, to show the group", -1)];
// A Looks preview of the Overdue card with nothing overdue shows these (V1.44). Never saved, like SAMPLE_P1.
const sampleLate = (id: string, title: string, order: number): Doc<Todo> => ({ id, ws: null, kind: "todo", author: null, updatedAt: null,
  data: { title, type: "once", done: false, order, due: "2026-01-02" } });
const SAMPLE_OVERDUE: Doc<Todo>[] = [sampleLate("pv-late-1", "Example overdue task", -2), sampleLate("pv-late-2", "Another one, to show the card", -1)];
// Rain being tried in Settings (the kind for a Preview, the amount while its slider moves), else null.
let rainPreview: { kind?: RainId; amount?: number } | null = null;
// The dev server only: ?rain=storm&rainAmt=70&bg=color:g-dusk shows rain and a background (for pictures), like ?look=.
const devQ = import.meta.env.DEV && typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
if (devQ?.get("rain")) rainPreview = { kind: rainKind(devQ.get("rain")), amount: devQ.get("rainAmt") ? rainAmount(devQ.get("rainAmt")) : undefined };
function setRainPreview(v: typeof rainPreview) { rainPreview = v; p1Listeners.forEach((l) => l()); }
function useRainPreview() {
  return useSyncExternalStore((l) => { p1Listeners.add(l); return () => { p1Listeners.delete(l); }; }, () => rainPreview);
}
let bgPreview: string | null = devQ?.get("bg") ? bgDesign(devQ.get("bg")) : null;
export function setBgPreview(v: string | null) { bgPreview = v; p1Listeners.forEach((l) => l()); }
function useBgPreview() {
  return useSyncExternalStore((l) => { p1Listeners.add(l); return () => { p1Listeners.delete(l); }; }, () => bgPreview);
}
/**
 * Sits behind the P1 rows (first `count` rows of the list) and is sized to cover them all. It also
 * tells the list's root where the group is (--p1x, --p1y, --p1w, --p1h) for the looks where the
 * whole screen points at it. Measured on render, resize and scroll: never waits for a frame
 * (PS's hidden window would stall it).
 */
function P1Frame({ count, design }: { count: number; design: string }) {
  const el = useRef<HTMLLIElement>(null);
  const place = useRef((_scroll?: boolean) => {});
  const rootLater = useRef(0);
  place.current = (scroll?: boolean) => {
    const f = el.current, ul = f?.parentElement;
    if (!f || !ul) return;
    const rows = ul.querySelectorAll<HTMLElement>(":scope > .tm-row");
    if (rows.length < count) return;
    const top = rows[0].offsetTop, last = rows[count - 1];
    const ft = `${top - 10}px`, fh = `${last.offsetTop + last.offsetHeight - top + 20}px`;
    if (f.style.top !== ft) f.style.top = ft;
    if (f.style.getPropertyValue("--p1fh") !== fh) f.style.setProperty("--p1fh", fh);   // height (plus --p1-grow while a drop opens room in it)
    const root = ul.closest<HTMLElement>(".tm-overlay");
    if (!root) return;
    const r = root.getBoundingClientRect(), b = rows[0].getBoundingClientRect(), e = last.getBoundingClientRect();
    const v: [string, string][] = [
      ["--p1x", `${Math.round((b.left + b.right) / 2 - r.left)}px`],
      ["--p1y", `${Math.round((b.top + e.bottom) / 2 - r.top)}px`],
      ["--p1w", `${Math.round(b.width + 40)}px`],
      ["--p1h", `${Math.round(e.bottom - b.top + 40)}px`],
      ["--p1t", `${Math.round(b.top - r.top - 10)}px`],       // the group's band, top and bottom
      ["--p1b", `${Math.round(e.bottom - r.top + 10)}px`],
    ];
    const put = (el: HTMLElement) => { for (const [k, x] of v) if (el.style.getPropertyValue(k) !== x) el.style.setProperty(k, x); };
    // V1.47 (the developer: the phone "a bit laggy"): while the list scrolls these follow the group every frame. On the list's
    // root that restyled the whole list on each frame of a scroll, so they go to the look behind the group only, and
    // to the root (the storm reads them there) once the scroll has rested.
    root.querySelectorAll<HTMLElement>(":scope > .tm-p1-scene").forEach(put);
    window.clearTimeout(rootLater.current);
    if (scroll) rootLater.current = window.setTimeout(() => put(root), 160);
    else put(root);
  };
  useLayoutEffect(() => place.current());
  useEffect(() => () => window.clearTimeout(rootLater.current), []);
  useEffect(() => {
    const f = el.current, ul = f?.parentElement;
    if (!ul) return;
    const go = () => place.current();
    const ro = new ResizeObserver(go);
    ro.observe(ul);
    const sc = ul.closest(".tm-scroll");
    const scrolled = () => place.current(true);
    sc?.addEventListener("scroll", scrolled, { passive: true });
    window.addEventListener("resize", go);
    window.addEventListener("tm-relayout", go);   // its section is being dragged or gliding (ui/sectionDrag.ts)
    return () => { ro.disconnect(); sc?.removeEventListener("scroll", scrolled); window.removeEventListener("resize", go); window.removeEventListener("tm-relayout", go); };
  }, []);
  // Glisten: one quick sweep, then nothing at all moves for a few seconds (a CSS loop kept the
  // window redrawing every frame, which the developer saw as faint static on the white outline). Only while
  // the list is showing.
  const shown = useOverlayShown();
  useEffect(() => {
    if (!shown || (design !== "red-glisten" && design !== "white-glisten")) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let t = 0;
    const sweep = () => {
      el.current?.querySelector<HTMLElement>(".p1-ring b")?.animate(
        [{ transform: "translateX(-120%) skewX(-18deg)" }, { transform: "translateX(380%) skewX(-18deg)" }],
        { duration: 1500, easing: "cubic-bezier(.45,0,.2,1)" });
      t = window.setTimeout(sweep, 5000);
    };
    t = window.setTimeout(sweep, 400);
    return () => clearTimeout(t);
  }, [shown, design]);
  return (
    <li ref={el} className={`tm-p1-frame p1d-${design}`} aria-hidden="true">
      <P1Art design={design} />
      <i className="tm-p1-hint">Priority 1</i>
    </li>
  );
}
/** The extra pieces some looks draw (a sweep, bolts, a target, a crown...). */
function P1Art({ design }: { design: string }) {
  switch (design) {
    case "red-glisten": case "white-glisten": case "rainbow": return <i className="p1-ring"><b /></i>;
    case "lightning": return (
      <svg className="p1-bolts" viewBox="0 0 100 40" preserveAspectRatio="none">
        <path d="M8 0 L14 12 L10 13 L18 28 L13 29 L20 40" /><path d="M52 0 L46 10 L51 11 L44 24 L49 25 L42 40" /><path d="M90 0 L85 14 L90 15 L83 40" />
      </svg>
    );
    case "target": return <><i className="p1-corner tl" /><i className="p1-corner tr" /><i className="p1-corner bl" /><i className="p1-corner br" /><i className="p1-bull"><b /><b /><b /></i><i className="p1-cross h" /><i className="p1-cross v" /></>;
    case "radar": return <i className="p1-radar"><b /></i>;
    case "neon": return <span className="p1-neon-l">PRIORITY 1</span>;
    case "glitch": return <><i className="p1-gl a" /><i className="p1-gl b" /></>;
    case "crown": return (
      <svg className="p1-crown" viewBox="0 0 64 44"><path d="M4 40 L8 12 L22 26 L32 4 L42 26 L56 12 L60 40 Z" /><circle cx="8" cy="10" r="4" /><circle cx="32" cy="4" r="4" /><circle cx="56" cy="10" r="4" /></svg>
    );
    default: return null;
  }
}

// ---------- Priority 1 colour (the developer, 2 Nov 2026: "one colour for all P1 tasks") ----------
// A dot in the Priority 1 header opens a small picker on a real click (never hover): strong presets,
// a custom colour (hue slider and a hex box) and "As before". Every P1 task takes the colour (text,
// tick ring, P1 badge, the outline look's accent and glow; taskmap.css ".p1c"). Saved once per real
// change in settings.p1Color, so the website and the phone follow; trying colours on the slider
// stays on this screen until the knob is let go.
let p1cTry: string | null | undefined;      // undefined: nothing being tried; null: trying "As before"
let p1cSaving: string | null | undefined;   // the colour just saved, until the saved settings catch up
const p1cSubs = new Set<() => void>();
function setP1cTry(v: string | null | undefined) { if (v === p1cTry) return; p1cTry = v; p1cSubs.forEach((l) => l()); }
function useP1cTry() { return useSyncExternalStore((l) => { p1cSubs.add(l); return () => { p1cSubs.delete(l); }; }, () => p1cTry); }
/** The colour to paint with: the one being tried, else the saved one. */
function useP1Colour(saved: string | null): string | null {
  const tried = useP1cTry();
  useEffect(() => {
    if (p1cSaving !== undefined && p1cSaving === saved) { p1cSaving = undefined; if (p1cTry === saved) setP1cTry(undefined); }
  }, [saved, tried]);
  return tried !== undefined ? tried : saved;
}
/** True for a moment after the colour changes, so everything it paints fades across (taskmap.css .p1c-fade).
 *  Set in the very render that changes the colour: a class added one render later came too late to fade. */
function useP1ColourFade(c: string | null): boolean {
  const [st, setSt] = useState({ c, fade: false });
  if (st.c !== c) setSt({ c, fade: true });
  useEffect(() => {
    if (!st.fade) return;
    const t = window.setTimeout(() => setSt((x) => (x === st ? { ...x, fade: false } : x)), 700);
    return () => window.clearTimeout(t);
  }, [st]);
  return st.c !== c || st.fade;
}
/** Save a colour, only when it differs from the saved one (null = As before). */
function saveP1Colour(c: string | null, saved: string | null) {
  setP1cTry(c);
  if (c === saved) { p1cSaving = undefined; setP1cTry(undefined); return; }
  p1cSaving = c;
  void taskMapActions.looks({ p1Color: c });
  // If the save never comes back (offline), the list goes back to the saved colour after a while.
  window.setTimeout(() => { if (p1cSaving === c) { p1cSaving = undefined; if (p1cTry === c) setP1cTry(undefined); } }, 6000);
}

function P1ColourPick({ saved }: { saved: string | null }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const tried = useP1cTry();
  const shown = tried !== undefined ? tried : saved;
  return (
    <>
      <button ref={btn} type="button" className={`p1c-dot no-drag${shown ? " set" : ""}${open ? " open" : ""}`}
        style={shown ? { ["--sw" as string]: shown } : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-label="Priority 1 colour" title="Priority 1 colour"
        onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); sfx.click(); setOpen((v) => !v); }} />
      {open && <P1ColourMenu anchor={btn} saved={saved} onClose={() => setOpen(false)} />}
    </>
  );
}

function P1ColourMenu({ anchor, saved, onClose }: { anchor: React.RefObject<HTMLButtonElement | null>; saved: string | null; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const tried = useP1cTry();
  const cur = tried !== undefined ? tried : saved;
  const [hue, setHue] = useState(() => colorHue(cur ?? "#ff2e3e"));
  const [hex, setHex] = useState(cur ?? "");
  const sliding = useRef(false);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 10, left: Math.max(12, Math.min(r.left - 14, window.innerWidth - 300 - 12)) });
  }, [anchor]);
  // Esc or a click outside closes it; a colour tried but never let go of goes back.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !anchor.current?.contains(t)) close.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); } };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true);
      if (p1cSaving === undefined) setP1cTry(undefined);
    };
  }, [anchor]);
  const pick = (c: string | null) => { sfx.click(); setHex(c ?? ""); if (c) setHue(colorHue(c)); saveP1Colour(c, saved); };
  const slide = (v: number) => { const c = hueColor(v); setHue(v); setHex(c); setP1cTry(c); };
  // Saved on let go only if the knob really moved: a click or a Tab through the slider changes nothing.
  const letGo = () => { if (!sliding.current) return; sliding.current = false; saveP1Colour(hueColor(hue), saved); };
  const typed = (v: string) => { setHex(v); const c = p1Color(v); if (c) { setHue(colorHue(c)); setP1cTry(c); } };
  const enter = () => { const c = p1Color(hex); if (c) { sfx.click(); saveP1Colour(c, saved); } else setHex(cur ?? ""); };
  if (!at) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div ref={menu} className="p1c-menu no-drag" role="dialog" aria-label="Priority 1 colour" style={{ top: at.top, left: at.left }}
      onPointerDown={stop} onMouseDown={stop} onClick={stop}>
      <div className="p1c-h">Priority 1 colour<em>{cur ? "Every P1 task takes it" : "As before: each look's own colours"}</em></div>
      <div className="p1c-sw" role="radiogroup" aria-label="Colours">
        <button type="button" role="radio" aria-checked={cur === null} className={`p1c-none${cur === null ? " sel" : ""}`} title="As before" aria-label="As before" onClick={() => pick(null)} />
        {P1_COLORS.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={cur === c.id} className={cur === c.id ? "sel" : ""} title={c.label} aria-label={c.label}
            style={{ ["--sw" as string]: c.id }} onClick={() => pick(c.id)} />
        ))}
      </div>
      <div className="p1c-custom">
        <span className="p1c-l">Custom</span>
        <input type="range" className="p1c-hue" min={0} max={359} step={1} value={hue} aria-label="Custom colour"
          style={{ ["--sw" as string]: hueColor(hue) }}
          onChange={(e) => { sliding.current = true; slide(Number(e.currentTarget.value)); }}
          onPointerUp={letGo} onKeyUp={letGo} onBlur={letGo} />
        <input type="text" className="p1c-hex" value={hex} maxLength={7} spellCheck={false} placeholder="#hex" aria-label="Colour code"
          onChange={(e) => typed(e.currentTarget.value)} onBlur={enter}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); enter(); } }} />
      </div>
    </div>, document.body);
}

function Row({ d, n, working, today, drag, onEdit, fresh, sel, ticked }: { d: Doc<Todo>; n: number | null; working: boolean; today: string; drag: ReturnType<ReturnType<typeof useDragOrder>["row"]>; onEdit: () => void; fresh?: boolean; sel?: boolean; ticked?: boolean }) {
  const t = d.data;
  // Ticked a moment ago: crossed out in its place before it slides down to Completed (V1.34).
  const isDone = t.done || !!ticked;
  const flip = useFlipIn(d.id);
  const every = isEveryDay(t);
  const late = !every && !t.done && !!t.due && t.due < today;
  const when = every || !t.due ? null : late ? "Overdue" : t.due === today ? "Today" : fmtDate(t.due);
  const rep = t.type === "daily" && !every ? repeatLabel(t.repeat) : null;
  const mini = useMiniOpen(d, useSubOpenList());
  const allDone = miniAllDone(d);
  // Game-menu feel: a spotlight follows the mouse, a ripple where you press, small sounds.
  const glow = (e: React.MouseEvent<HTMLLIElement>) => {
    const el = e.currentTarget, x = e.clientX, y = e.clientY;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${x - r.left}px`);
    el.style.setProperty("--my", `${y - r.top}px`);
  };
  const ripple = (e: React.PointerEvent<HTMLLIElement>) => {
    const fx = e.currentTarget.querySelector<HTMLElement>(".tm-fx");
    if (!fx) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "tm-ripple";
    dot.style.left = `${e.clientX - r.left}px`;
    dot.style.top = `${e.clientY - r.top}px`;
    fx.appendChild(dot);
    dot.addEventListener("animationend", () => dot.remove());
    sfx.click();
  };
  return (
    <li className={`tm-row${isDone ? " done" : ""}${ticked ? " ticking" : ""}${working ? " working" : ""}${late ? " late" : ""}${fresh ? " plop-in" : ""}${n === 1 ? " p1" : ""}${mini.open ? " mini-open" : ""}${allDone ? " mini-all" : ""}${sel ? " sel" : ""}`}
      ref={(el) => { drag.ref(el); flip.current = el; }} style={drag.style} data-dragging={drag["data-dragging"]} data-id={d.id} data-type={t.type}
      onPointerDown={(e) => { ripple(e); pressRow(e, d.id, working); if (!startBundle(e, d.id)) drag.onPointerDown(e); }}
      onContextMenu={(e) => openTaskMenu(e, d.id, "list")}
      onKeyDown={(e) => { if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); openTaskMenuAt(e.currentTarget, d.id, "list"); } }}
      // Cmd-click picks the task (or lets it go) instead of what the click would do; a plain click lets every picked task go.
      onClickCapture={(e) => {
        if (e.metaKey) { e.preventDefault(); e.stopPropagation(); toggleSel(d.id); }
        else if (selIds.size) clearSel();
      }}
      onMouseEnter={() => sfx.hover()} onMouseMove={glow}>
      <span className="tm-fx" aria-hidden="true" />
      <NewBadge d={d} />
      {working && <span className="tm-bolts" aria-hidden="true"><i /><i /><i /><i /></span>}
      {sel && <span className="tm-sel-mark" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg></span>}
      <button type="button" className="tm-tick no-drag" onPointerDown={(e) => pressTick(e, d.id, () => tickTask(d.id))} onClick={() => clickTick(d.id, () => tickTask(d.id))}
        aria-pressed={isDone} aria-label={`${isDone ? "Untick" : "Tick off"}: ${t.title}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
      </button>
      <button type="button" className="tm-text" onClick={() => clickWork(d.id, working, workingIdsOf(settingsData(vaultStore.get())).includes(d.id))} aria-pressed={working}>
        {working && <span className="tm-working">Working on</span>}
        <span className="tm-t">{t.title}</span>
        {t.ai && <span className="tm-ai" title="Added by an AI (AI task API)">AI</span>}
        {rep && <span className="tm-due tm-rep">{rep}</span>}
        {when && <span className={`tm-due num${late ? " late" : ""}`}>{when}</span>}
      </button>
      <TaskBell task={d.id} done={isDone} />
      <MiniToggle d={d} open={mini.open} onToggle={mini.toggle} />
      {n != null && <span className="tm-prio num" data-p={Math.min(n, 4)} title={`Priority ${n}`}>P{n}</span>}
      <StreakBadge n={t.type === "daily" ? t.streak : 0} className="tm-streak" />
      <button type="button" className="tm-edit no-drag" onClick={onEdit} aria-label={`Edit: ${t.title}`} title="Edit">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
      </button>
      <MiniList d={d} open={mini.open} />
    </li>
  );
}

// Edit a task right in the list: name, notes, one-off or every day, date, client. Delete too.
export function Editor({ d, clients, onDone, ranked }: { d: Doc<Todo>; clients: ClientOpt[]; onDone: () => void; ranked?: Doc<Todo>[] }) {
  const t = d.data;
  const startP = ranked ? ranked.findIndex((x) => x.id === d.id) + 1 : 0;
  const [p, setP] = useState(startP);
  const [p1, setP1] = useState(!!t.p1);
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes || "");
  const [rule, setRule] = useState<RepeatDraft>(() => draftOf(t, todayISO()));
  const kind = rule.kind;
  const type: Todo["type"] = kind === "once" ? "once" : "daily";
  const [due, setDue] = useState(t.due || "");
  const [clientId, setClientId] = useState(t.clientId || "");
  const [sure, setSure] = useState(false);
  const reminder = useTaskReminder(d.id);
  const pick = (k: RepeatDraft["kind"]) => { setRule((r) => ({ ...r, kind: k, from: k === "repeat" && r.kind !== "repeat" ? due || todayISO() : r.from })); sfx.hover(); };
  const plus = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
  // V1.57: P1, P2 or P3 typed in the name works when editing too (the same parser as Add task, core/typedprio.ts).
  // One-offs on the main list only (they are the ones with a priority); a word already in the name is left alone.
  const tp = useTypedPrio(title, !!ranked && type === "once", t.title);
  const save = () => {
    const typedP = tp.take(title);
    const name = (typedP ? typedP.title : title).trim();
    if (!name) return;
    const r = patchOf(rule, todayISO(), t);
    const patch: TodoPatch = { title: name, notes: notes.trim() || null, type: r.type, repeat: r.repeat, due: r.type === "once" ? due || null : r.due ?? null, clientId: clientId || null };
    // A new priority number moves just this task between its new neighbours.
    if (typedP && ranked && type === "once") {
      const e = typedEdit(ranked.map((x) => ({ id: x.id, ...x.data })), d.id, typedP.prio);
      if (e) { patch.p1 = e.p1; patch.order = e.order; }
      if (t.unranked) patch.unranked = false;
    } else if (ranked && type === "once" && p1 !== !!t.p1) {
      // Priority 1 on: to the end of the P1 group. Off: just below it. (A one-off only.)
      const rest = ranked.filter((x) => x.id !== d.id);
      patch.p1 = p1;
      patch.order = orderForPriority(rest, rest.filter((x) => x.data.p1).length + 1);
    } else if (ranked && type === "once" && p !== startP) patch.order = orderForPriority(ranked.filter((x) => x.id !== d.id), p);
    if (type !== "once" && t.p1) patch.p1 = false;
    void taskMapActions.update(d.id, patch);
    sfx.drop();
    onDone();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onDone(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };
  return (
    <li className="tm-row tm-editor" onKeyDown={keys} onMouseDown={(e) => e.stopPropagation()}>
      <div className="tm-ed">
        <PrioInput prio={tp} className="tm-ed-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} aria-label="Task name"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }} />
        <textarea className="tm-ed-notes" value={notes} rows={2} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" aria-label="Notes" />
        <div className="tm-ed-row">
          <div className="tm-ed-seg" role="radiogroup" aria-label="Task type">
            <DwellButton selected={kind === "once"} onPick={() => pick("once")}>One-off</DwellButton>
            <DwellButton selected={kind === "daily"} onPick={() => pick("daily")}>Every day</DwellButton>
            <DwellButton selected={kind === "repeat"} onPick={() => pick("repeat")}>Repeat</DwellButton>
          </div>
          {type === "once" && (
            <>
              <input type="date" className="tm-ed-date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
              <button type="button" className="tm-ed-chip" onClick={() => setDue(plus(0))}>Today</button>
              <button type="button" className="tm-ed-chip" onClick={() => setDue(plus(1))}>Tomorrow</button>
              {due && <button type="button" className="tm-ed-chip" onClick={() => setDue("")}>No date</button>}
            </>
          )}
          {clients.length > 0 && (
            <select className="tm-ed-client" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        {kind === "repeat" && <RepeatPicker value={rule} onChange={setRule} cls={TM_REPEAT} />}
        {ranked && type === "once" && (
          <div className="tm-ed-row">
            <button type="button" role="switch" aria-checked={p1} className={`tm-p1-switch${p1 ? " on" : ""}`} onClick={() => { tp.picked(); setP1((v) => !v); sfx.click(); }}
              title={p1 ? "In the Priority 1 group at the top. Click to take it out" : "Put it in the Priority 1 group at the top"}>
              <span className="tm-p1-knob" aria-hidden="true" />Priority 1
            </button>
            {!p1 && <PriorityPicker value={p} max={ranked.length} onChange={(v) => { tp.picked(); setP(v); }} />}
          </div>
        )}
        <div className="tm-ed-row">
          <button type="button" className="tm-ed-save" onClick={save}>Save</button>
          <button type="button" className="tm-ed-chip" onClick={onDone}>Cancel</button>
          {/* V1.55: the task's Annoying 15 min reminder (views/TaskRemind.tsx); the edit stays open under it. */}
          <button type="button" className={`tm-ed-chip tm-ed-rem${reminder ? " on" : ""}`} onClick={(e) => openTaskRemind(d.id, e.currentTarget)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            {reminderWords(!!reminder)}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className={`tm-ed-del${sure ? " sure" : ""}`}
            onClick={() => { if (!sure) { setSure(true); return; } deleteTask(d.id); onDone(); }}>
            {sure ? "Click again to delete" : "Delete"}
          </button>
        </div>
      </div>
    </li>
  );
}

// ---------- client emails, top right: every client email not dealt with yet, newest first ----------
// Only what the vault already keeps: who, subject and Gmail's short preview, never the body.
// Open goes to the thread in Gmail; Done marks it handled (answering in Gmail does that too).
// Reply (PS on the Mac, 10 Nov 2026, core/overlaymail.ts): opens the reply panel with that email loaded; the developer writes
// and sends it himself. V1.59 (core/inlinereply.ts, Settings "Reply in the email panel", on unless switched off): Reply
// opens a small box right in the panel instead, on the phone and the website too (views/ReplyBox.tsx). Open lead replies from Instantly sit here too (Done dismisses them everywhere, like the card).
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
function ClientMail({ s, mail }: { s: ReturnType<typeof useVault>; mail: boolean }) {
  // The Tab overlay has no Instantly feed (the main page sends the rows); the website and the main window read it here.
  const mirrored = useSyncExternalStore(leadMirror.subscribe, leadMirror.get);
  const { list, total } = useMemo(() => {
    const open = openReplies(s);
    const gmail = open.map((r): MailRow => {
      const c = s.docs.get(r.data.clientId) as Doc<ClientRec> | undefined;
      const who = replierName(c?.data, r.data);
      return { cardId: gmailCardId(r.id), via: "gmail", replyId: r.id, who, company: c && c.data.name.toLowerCase() !== who.toLowerCase() ? c.data.name : null,
        subject: r.data.subject, preview: r.data.opening || r.data.snippet || "", at: r.data.date, url: gmailThreadLink(r.data.account, r.data.threadId), count: r.data.count };
    });
    const feed = irepFeed(s);
    const leads = feed ? leadRows(leadCards(feed, settingsData(s).leadCards)) : mirrored;
    return { list: mailRows(gmail, leads), total: gmail.length + leads.length };
  }, [s, mirrored]);
  // V1.59 Reply in the email panel (core/inlinereply.ts): the box, its Undo, and how each reply went (from the vault).
  const inline = replyInPanelOn(settingsData(s));
  const outs = useMemo(() => [...s.docs.values()].filter((d) => d.kind === "rout").map((d) => cleanOut(d.data)).filter((o): o is ReplyOut => !!o), [s]);
  const status = useMemo(() => panelStatus(outs), [outs]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [undo, setUndo] = useState<Map<string, UndoSend>>(() => new Map());
  // PS 1.61: the island's envelope or reply arrow (core/mailopen.ts): the newest email of that kind opens here, its whole
  // opening shown and lit up, scrolled into view. The light goes after a while; nothing is sent or marked.
  const [focusId, setFocusId] = useState<string | null>(null);
  const listEl = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const take = () => {
      const via = peekMailOpen();
      if (!via) return;
      const id = newestOf(list, via) ?? list[0]?.cardId ?? null;
      if (!id) return;
      takeMailOpen();
      setFocusId(id);
    };
    take();
    return onMailOpen(take);
  }, [list]);
  useEffect(() => {
    if (!focusId) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const el = [...(listEl.current?.querySelectorAll<HTMLElement>("li[data-card]") ?? [])].find((x) => x.dataset.card === focusId);
    el?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
    const t = window.setTimeout(() => setFocusId(null), 20_000);
    return () => clearTimeout(t);
  }, [focusId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!undo.size) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [undo.size]);
  // A reply that has really gone: its words are let go on this device.
  useEffect(() => { for (const [id, st] of status) if (st.kind === "replied" && replyDrafts.has(id) && !undo.has(id)) replyDrafts.clear(id); }, [status, undo]);
  const openIds = useMemo(() => new Set(list.map((r) => r.cardId)), [list]);
  const replied = useMemo(() => inline ? repliedRows(outs, openIds, Date.now()) : [], [inline, outs, openIds]);
  // V1.62: the panel shows with nothing in it too (Client emails is on for everyone now). Empty and no Gmail connected yet:
  // a short prompt and Connect Gmail, which opens Settings, Client emails (the 1.60 connect guide). Gmail is only asked
  // about while the panel is empty and nothing in this vault already proves a connection (core/mailempty.ts).
  const seen = useMemo(() => replies(s).length > 0 || !!irepFeed(s) || mirrored.length > 0, [s, mirrored]);
  const empty = !list.length && !replied.length;
  // V1.63: Gmail mail already in this vault proves a connection, whatever the status check says (core/gmailtruth.ts).
  const gmailMail = useMemo(() => seenAccounts(s.docs.values()).length > 0, [s]);
  const gmail = useGmailKnown(empty && !seen && !gmailMail, gmailMail);
  const picked = useMemo(() => mailPicked([...s.docs.values()].filter((d): d is Doc<ClientRec> => d.kind === "client"), settingsData(s).mailRules), [s]);
  const shows = mailPanelShows({ rows: list.length, replied: replied.length, gmail, seen, picked });
  if (shows === "wait") return null;
  if (shows !== "list") return (
    <aside className="tm-meet tm-mail" aria-label="Client emails" onMouseDown={(e) => e.stopPropagation()}>
      <span className="tm-meet-h">Client emails</span>
      {shows === "connect" ? (
        <div className="tm-mail-empty">
          <span className="tm-mail-p">{MAIL_EMPTY_WORDS.connect}</span>
          <span className="tm-mail-a">
            <button type="button" className="tm-meet-j tm-mail-reply" onClick={() => { sfx.click(); openSettings("notify", { jump: "client-emails" }); }}>{MAIL_EMPTY_WORDS.button}</button>
            <CopyForAiButton className="tm-meet-j tm-mail-copy" mode="guide" />
            <CopyForAiButton className="tm-meet-j tm-mail-copy" mode="clicks" />
          </span>
        </div>
      ) : shows === "pick" ? (
        <div className="tm-mail-empty">
          <span className="tm-mail-p">{MAIL_EMPTY_WORDS.pick}</span>
          <span className="tm-mail-a">
            <button type="button" className="tm-meet-j tm-mail-reply" onClick={() => { sfx.click(); openSettings("notify", { jump: "gmail-replies" }); }}>{MAIL_EMPTY_WORDS.pickButton}</button>
          </span>
        </div>
      ) : <span className="tm-mail-p tm-mail-none">{MAIL_EMPTY_WORDS.none}</span>}
    </aside>
  );
  const leadsIn = list.some((r) => r.via === "instantly");
  const dropUndo = (id: string) => setUndo((m) => { const n = new Map(m); n.delete(id); return n; });
  const sendFrom = (r: MailRow, text: string) => {
    setOpenId(null);
    const id = crypto.randomUUID();
    const u = startUndoSend(() => {
      dropUndo(r.cardId);
      void taskMapActions.replyInline(r.cardId, text, id).catch(() => {});   // a problem comes back as a "Not sent" record
    });
    setUndo((m) => new Map(m).set(r.cardId, u));
  };
  const undoIt = (cardId: string) => { if (undo.get(cardId)?.undo()) { dropUndo(cardId); setOpenId(cardId); } };
  const rows = inline ? sinkReplied(list, status) : list;
  return (
    <aside className="tm-meet tm-mail" aria-label={leadsIn ? "Emails" : "Client emails"} onMouseDown={(e) => e.stopPropagation()}>
      <span className="tm-meet-h">{leadsIn ? "Emails" : "Client emails"}<em> · {total} new</em></span>
      <ul className="tm-mail-list" ref={listEl}>
        {rows.map((r) => {
          const fresh = Date.now() - Date.parse(r.at) < 3600_000;
          const canInline = inline && !!cleanReplyCardId(r.cardId);
          const canReply = !canInline && replyButtonShows({ mode: import.meta.env.MODE, mail, cardId: r.cardId });
          const u = undo.get(r.cardId), st = status.get(r.cardId), boxOpen = canInline && openId === r.cardId;
          const busy = !!u || st?.kind === "sending";
          return (
            <li key={r.cardId} data-card={r.cardId} className={`${fresh ? "fresh" : ""}${st?.kind === "replied" && !u ? " replied" : ""}${focusId === r.cardId ? " focus" : ""}`}>
              <span className="tm-mail-who">{r.who}{r.company && <em> · {r.company}</em>}{r.via === "instantly" && <em className="tm-mail-via"> · Instantly</em>}</span>
              <span className="tm-mail-t num" title={new Date(r.at).toLocaleString()}>{ago(r.at)}{r.count > 1 ? ` · ${r.count} emails` : ""}</span>
              <span className="tm-mail-s">{r.subject || "(no subject)"}</span>
              {r.preview && !boxOpen && <span className="tm-mail-p">{focusId === r.cardId ? r.preview : firstSentences(r.preview, 4)}</span>}
              {u ? (
                <span className="tm-mail-st" role="status">Sending in {u.left()} s
                  <button type="button" className="tm-mail-undo" onClick={() => { sfx.click(); undoIt(r.cardId); }}>Undo</button></span>
              ) : st && canInline ? (
                <span className={`tm-mail-st ${st.kind}`} role="status" title={st.error || undefined}>{st.kind === "failed" && st.error ? `Not sent: ${st.error}` : st.text}</span>
              ) : null}
              {boxOpen && <ReplyBox cardId={r.cardId} who={r.who} last={r.preview} onClose={() => setOpenId(null)} onSent={(text) => sendFrom(r, text)} />}
              {!boxOpen && (
                <span className="tm-mail-a">
                  {canInline && !busy && <button type="button" className="tm-meet-j tm-mail-reply" title="Reply right here. Nothing is sent until you press Send, and Undo shows for a few seconds after."
                    onClick={() => { sfx.click(); setOpenId(r.cardId); }}>{replyDrafts.has(r.cardId) ? "Reply (draft)" : "Reply"}</button>}
                  {canReply && <button type="button" className="tm-meet-j tm-mail-reply" title="Opens the reply panel with this email in it. Nothing is sent until you press Send."
                    onClick={() => { sfx.click(); void taskMapActions.replyOpen(r.cardId); }}>Reply</button>}
                  <a className={canReply || canInline ? "tm-mail-done" : "tm-meet-j"} href={r.url} target="_blank" rel="noopener noreferrer">Open</a>
                  <button type="button" className="tm-mail-done" onClick={() => { sfx.click(); void (r.replyId ? taskMapActions.replyHandled(r.replyId) : taskMapActions.leadDone(r.cardId)); }}>Done</button>
                </span>
              )}
            </li>
          );
        })}
        {replied.map((r) => (
          <li key={`replied-${r.cardId}`} className="replied">
            <span className="tm-mail-who">{r.who || "Email"}</span>
            <span className="tm-mail-t num" title={new Date(r.at).toLocaleString()}>{ago(r.at)}</span>
            {r.subject && <span className="tm-mail-s">{r.subject}</span>}
            <span className="tm-mail-st replied" role="status">Replied</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---------- upcoming meetings, bottom left: the next 24 hours first, scroll for the days after ----------
type Upcoming = { key: string; title: string; start: Date; end: Date; endIso: string | null; link: string | null; client: string | null; clientTz: string | null };
function upcoming(s: ReturnType<typeof useVault>, events?: CalEvent[]): Upcoming[] {
  const snap = calendarSnap(s);
  if (!snap && !events) return [];
  const now = Date.now();
  const clients = clientViews(s).filter((c) => c.client);
  const match = buildMatcher(clients.map((c) => c.client!));
  const nameOf = new Map(clients.map((c) => [c.client!.id, c.name]));
  const tzOf = new Map(clients.map((c) => [c.client!.id, c.client!.data.timezone || null]));
  // Meetings the developer took off the panel stay off it (core/meethide.ts); his calendar keeps them.
  return visibleEvents(events ?? snap!.data.events, settingsData(s).meetHidden)
    .filter((e) => !e.allDay && e.start)
    .map((e) => ({ e, start: new Date(e.start!), end: new Date(e.end || e.start!) }))
    .filter(({ end }) => end.getTime() > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 40)
    .map(({ e, start, end }) => {
      const other = e.attendees.find((a) => !a.self && match(a.email));
      const cid = other ? match(other.email) : null;
      return { key: meetKey(e), title: e.title, start, end, endIso: e.end, link: e.link || null, client: cid ? nameOf.get(cid) || null : null, clientTz: cid ? tzOf.get(cid) || null : null };
    });
}

const noteFor = (notes: MeetingNote[], key: string) => notes.find((n) => n.key === key);
const standingFor = (standing: StandingNote[], title: string) => standing.find((n) => n.title === meetingTitleKey(title));
/** One call's own reminders (and which of its every-call ones are ticked on this call). */
function withNote(notes: MeetingNote[], m: Upcoming, items: MeetingNote["items"], doneStanding?: string[]) {
  const cur = noteFor(notes, m.key);
  const rest = notes.filter((n) => n.key !== m.key);
  const ds = doneStanding ?? cur?.doneStanding ?? [];
  return items.length || ds.length ? [...rest, { key: m.key, title: m.title, start: m.start.toISOString(), items, doneStanding: ds }] : rest;
}
/** The every-call reminders for meetings with this name. */
function withStanding(standing: StandingNote[], title: string, items: StandingNote["items"]) {
  const t = meetingTitleKey(title);
  const rest = standing.filter((n) => n.title !== t);
  return items.length ? [...rest, { title: t, items }] : rest;
}
const saveNote = (notes: MeetingNote[], m: Upcoming, items: MeetingNote["items"], doneStanding?: string[]) =>
  void taskMapActions.meetingNotes({ meetingNotes: withNote(notes, m, items, doneStanding) });
const saveStanding = (standing: StandingNote[], title: string, items: StandingNote["items"]) =>
  void taskMapActions.meetingNotes({ standingNotes: withStanding(standing, title, items) });

// web (V1.44): the website's To-do page. No Dynamic Island switch (it is the Mac's), and for anyone but the developer no refresh:
// their meetings come from the Calendar app on their Mac, through the vault, when PS runs there.
function MeetingsPeek({ list: usual, notes, standing, privateOn, calAt, local, web }: { list: Upcoming[]; notes: MeetingNote[]; standing: StandingNote[]; privateOn: boolean; calAt: string | null; local: boolean; web?: boolean }) {
  // V1.55: each Meetings panel can show its own calendar (core/calfeeds.ts, set in the Edit mode overview). The usual
  // one is the list handed in; another Google calendar (the developer's own server only) or one Mac account is worked out here.
  const inst = useInst();
  const cal = panelCal(inst?.cfg.cal);
  const vs = useVault();
  const own = useMemo(() => {
    if (cal.kind === "usual" || vs.status !== "unlocked") return null;
    if (cal.kind === "google" && !(isRedAccount(vs) && onRedProject())) return { list: [] as Upcoming[], at: null as string | null };   // The developer only feeds stay the developer only
    const c = calendarFor(calendarDocs(vs), cal);
    return { list: upcoming(vs, c.events), at: c.doc?.data.at ?? null };
  }, [vs, cal.kind, cal.kind === "google" ? cal.feed : cal.kind === "mac" ? cal.account : ""]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = own?.list ?? usual;
  const now = Date.now();
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Delete (the developer, 2 Nov 2026): the X takes a meeting off this panel on every device (settings.meetHidden),
  // never off his calendar. It slides out at once (the saved list arrives a moment later), with Undo for a few seconds.
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ key: string; title: string } | null>(null);
  const undoTimer = useRef(0);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const list = all.filter((m) => !gone.has(m.key));
  const hide = (m: Upcoming) => {
    sfx.drop();
    if (openKey === m.key) setOpenKey(null);
    setLeaving((v) => new Set(v).add(m.key));
    window.setTimeout(() => setGone((v) => new Set(v).add(m.key)), 240);
    void taskMapActions.meetHide({ op: "hide", key: m.key, end: m.endIso });
    setUndo({ key: m.key, title: m.title });
    clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), MEET_HIDE.undoMs);
  };
  const putBack = () => {
    if (!undo) return;
    sfx.click();
    const k = undo.key;
    void taskMapActions.meetHide({ op: "unhide", key: k });
    const drop = (v: Set<string>) => { const n = new Set(v); n.delete(k); return n; };
    setGone(drop); setLeaving(drop);
    setUndo(null);
    clearTimeout(undoTimer.current);
  };
  const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString();
  const tomorrow = new Date(Date.now() + 86400_000).toDateString();
  const dayName = (d: Date) => d.toDateString() === today ? "Today" : d.toDateString() === tomorrow ? "Tomorrow"
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const soon = list.filter((m) => m.start.getTime() < now + 24 * 3600_000).length;
  const opened = openKey ? list.find((m) => m.key === openKey) : undefined;
  let lastDay = "";
  return (
    <>
      <aside className="tm-meet" aria-label="Upcoming meetings" onMouseDown={(e) => e.stopPropagation()}>
        <span className={`tm-meet-h${local ? " has-pick" : ""}`}>Coming up{soon > 0 && <em> · {soon} in the next 24 hours</em>}</span>
        {/* The three buttons top right can be dragged out to be buttons of their own (Edit mode overview, V1.55). */}
        {!(web && local) && <Inner kind="calrefresh"><CalRefresh local={local} /></Inner>}
        {local && <CalGear solo={!!web} />}   {/* choose which calendars PS works with: lands on Settings, Calendars (core/calpick.ts) */}
        <Inner kind="privacy"><PrivateMask on={privateOn} /></Inner>
        {cal.kind === "google" ? <FeedUpdated feed={cal.feed} copyAt={own?.at ?? null} />
          : local ? <LocalCalUpdated copyAt={calAt} web={web} only={cal.kind === "mac" ? cal.account : undefined} /> : <CalUpdated copyAt={calAt} />}
        {list.length === 0 && <p className="tm-meet-none">No calls coming up</p>}
        <ul className="tm-meet-list">
          {list.map((m) => {
            const live = m.start.getTime() <= now && m.end.getTime() > now;
            const mins = Math.round((m.start.getTime() - now) / 60_000);
            const d = dayName(m.start);
            const head = d !== lastDay ? d : null;
            lastDay = d;
            const n = (noteFor(notes, m.key)?.items.length || 0) + (standingFor(standing, m.title)?.items.length || 0);
            return (
              <li key={m.key} className={`${live ? "live" : ""}${openKey === m.key ? " open" : ""}${leaving.has(m.key) ? " leaving" : ""}`}
                onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) return; sfx.click(); setOpenKey(openKey === m.key ? null : m.key); }}
                title="Click to add reminders for this call">
                {head && <span className="tm-meet-d">{head}</span>}
                <span className="tm-meet-t num">
                  {live ? "Now" : mins <= 60 ? `In ${Math.max(1, mins)} min` : hm(m.start)}
                  {m.clientTz && m.clientTz !== homeTz() && <><i className="tm-meet-bar" aria-hidden="true" /><TheirTime at={m.start} tz={m.clientTz} /></>}
                </span>
                <span className="tm-meet-n">
                  {n > 0 && <span className="tm-meet-pad" title={`${n} reminder${n === 1 ? "" : "s"}`} aria-label={`${n} reminders`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>{n}
                  </span>}
                  {m.title}{m.client && <em> · {m.client}</em>}
                </span>
                {m.link && <a className="tm-meet-j" href={m.link} target="_blank" rel="noopener noreferrer">Join</a>}
                <button type="button" className="tm-meet-x" onClick={() => hide(m)} aria-label={`Remove ${m.title} from this panel`}
                  title={`Remove from ${appName()} (your calendar keeps it)`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </li>
            );
          })}
        </ul>
        {undo && (
          <div className="tm-meet-undo" role="status">
            <span>Removed from {appName()}</span>
            <button type="button" onClick={putBack}>Undo</button>
          </div>
        )}
      </aside>
      {opened && <MeetingNotesEditor key={opened.key} m={opened} notes={notes} standing={standing} onClose={() => setOpenKey(null)} />}
    </>
  );
}

const useCalStatus = (): CalStatus => useSyncExternalStore(calStatus.subscribe, calStatus.get);

/** Refresh (the developer, 2 Nov 2026; 4 Nov 2026 it really reads Google), left of the island switch. A press always asks
 *  the server to read Google Calendar now; the icon spins until that read and the sync after it are done (the
 *  main page says so through calStatus.doneAt), or 20 s. The server also reads it every minute by itself. */
function CalRefresh({ local }: { local: boolean }) {
  const st = useCalStatus();
  const [pressedAt, setPressedAt] = useState(0);
  const waiting = pressedAt > 0 && st.doneAt < pressedAt;
  useEffect(() => {
    if (!waiting) return;
    const t = window.setTimeout(() => setPressedAt(0), 20_000);
    return () => clearTimeout(t);
  }, [waiting]);
  // At least one full turn, so even an instant answer reads as "it did something".
  const [minSpin, setMinSpin] = useState(false);
  useEffect(() => { if (!minSpin) return; const t = window.setTimeout(() => setMinSpin(false), 700); return () => clearTimeout(t); }, [minSpin]);
  const busy = waiting || minSpin || st.busy;
  const go = () => {
    if (busy) return;
    sfx.click();
    setPressedAt(Date.now()); setMinSpin(true);
    void taskMapActions.calRefresh();
  };
  return (
    <button type="button" className={`tm-cal-ref${busy ? " busy" : ""}`} onClick={go} aria-label={`Refresh meetings from ${local ? "Calendar" : "Google Calendar"}`}
      title={`Refresh meetings from ${local ? "Calendar" : "Google Calendar"}`} aria-busy={busy}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3.5V8h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20.5V16h-4.5" />
      </svg>
    </button>
  );
}

/** Under the Meetings heading: "Updated 1 min ago" (when Google was last read), or what is wrong. While Google is
 *  not linked, "Link Google" opens a box for the calendar's secret iCal address (pasted once, kept in Supabase
 *  Vault, never shown again). */
function CalUpdated({ copyAt }: { copyAt: string | null }) {
  const st = useCalStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t); }, []);
  const [open, setOpen] = useState(false);
  const line = calLine(st, copyAt, now);
  return (
    <div className="tm-cal-upd-wrap">
      <span className={`tm-cal-upd ${line.tone}`} role="status" aria-live="polite">
        {line.text}
        {st.connected === false && !open && <button type="button" className="tm-cal-link-btn" onClick={() => { sfx.click(); setOpen(true); }}>Link Google</button>}
      </span>
      {open && st.connected !== true && <CalLinkBox onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The same line for anyone but the developer: the meetings come from this Mac's Calendar app (ps-mac LocalCalendar.swift).
 *  Refused: plain words and a button that opens the Calendars page of Privacy & Security. */
function LocalCalUpdated({ copyAt, web, only }: { copyAt: string | null; web?: boolean; only?: string }) {
  const st = useCalStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t); }, []);
  const vs = useVault();
  const line0 = web ? webCalLine(copyAt, now) : localLine(st, copyAt, now, calMode(vs.status === "unlocked" ? settingsData(vs).macCalendar : undefined));
  const line = only ? { ...line0, text: `${line0.text} · only ${only}` } : line0;   // V1.55: this panel shows one account
  return (
    <div className="tm-cal-upd-wrap">
      <span className={`tm-cal-upd ${line.tone}`} role="status" aria-live="polite">
        {line.text}
        {line.turnOn && PS && <button type="button" className="tm-cal-link-btn" onClick={() => { sfx.click(); setCalendarOn(true); }}>{CAL_WORDS.turnOn}</button>}
        {line.settings && PS && <button type="button" className="tm-cal-link-btn" title="System Settings, Privacy & Security, Calendars: switch it on for this app"
          onClick={() => { sfx.click(); psPost({ type: "localCal", op: "settings" }); }}>Open settings</button>}
      </span>
    </div>
  );
}

/** V1.55: the status line of a Meetings panel that shows its own Google calendar (the developer's own server, core/calfeeds.ts).
 *  Until the first copy has arrived it offers Link Google for this panel only. */
function FeedUpdated({ feed, copyAt }: { feed: string; copyAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t); }, []);
  const [open, setOpen] = useState(false);
  const linked = !!copyAt;
  return (
    <div className="tm-cal-upd-wrap">
      <span className={`tm-cal-upd ${linked ? "ok" : "bad"}`} role="status" aria-live="polite">
        {linked ? `This panel's own calendar · updated ${agoText(copyAt!, now)}` : "This panel's own Google calendar is not linked yet"}
        {!open && <button type="button" className="tm-cal-link-btn" onClick={() => { sfx.click(); setOpen(true); }}>{linked ? "Change" : "Link Google"}</button>}
      </span>
      {open && <CalLinkBox feed={feed} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CalLinkBox({ onClose, feed }: { onClose: () => void; feed?: string }) {
  const st = useCalStatus();
  const [url, setUrl] = useState("");
  const [sentAt, setSentAt] = useState(0);
  // A panel's own calendar (feed): linked once its first copy arrives (it never changes the usual one's status).
  const vs = useVault();
  const feedHere = !!feed && vs.status === "unlocked" && calendarDocs(vs).some((d) => feedOfAccount(d.data.account) === feed && Date.parse(d.data.at || "") >= sentAt - 60_000);
  const [feedErr, setFeedErr] = useState<string | null>(null);
  useEffect(() => { if (feed && sentAt && feedHere) onClose(); }, [feed, sentAt, feedHere]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!feed || !sentAt) return; const t = window.setTimeout(() => setFeedErr("Google did not open that address. Copy it again and paste the new one."), 30_000); return () => window.clearTimeout(t); }, [feed, sentAt]);
  const waiting = feed ? sentAt > 0 && !feedHere && !feedErr : sentAt > 0 && st.doneAt < sentAt;
  const failed = feed ? feedErr : sentAt > 0 && !waiting && st.connected !== true ? st.error || "Could not link" : null;
  const ok = /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s]+\/private-[a-z0-9]+\/basic\.ics$/i.test(url.trim());
  const save = () => {
    if (!ok || waiting) return;
    sfx.click();
    setSentAt(Date.now()); setFeedErr(null);
    void taskMapActions.calLink(url.trim(), feed);
  };
  return (
    <form className="tm-cal-link" onSubmit={(e) => { e.preventDefault(); save(); }} onMouseDown={(e) => e.stopPropagation()}>
      <p>In Google Calendar: Settings, your calendar, Integrate calendar, then copy <b>Secret address in iCal format</b> and paste it here. {appName()} keeps it in your server's vault and reads your calendar every minute.</p>
      <input type="password" autoComplete="off" spellCheck={false} value={url} placeholder="https://calendar.google.com/calendar/ical/..."
        onChange={(e) => { setUrl(e.target.value); setSentAt(0); }} aria-label="Secret address in iCal format" />
      {failed && <p className="tm-cal-link-err" role="alert">{failed}</p>}
      <div className="tm-cal-link-row">
        <button type="button" onClick={() => { sfx.click(); onClose(); }}>Cancel</button>
        <button type="submit" className="go" disabled={!ok || waiting}>{waiting ? "Linking..." : "Link"}</button>
      </div>
    </form>
  );
}

/** Private mode (the developer, 29 Oct 2026), top right of the Meetings panel: an anonymous mask that glows
 *  white while it is on. On, PS's notification cards hide names and words until clicked. */
function PrivateMask({ on }: { on: boolean }) {
  return (
    <button type="button" className={`tm-mask${on ? " on" : ""}`} role="switch" aria-checked={on}
      aria-label={on ? "Private mode is on. Click to turn it off" : "Private mode is off. Click to turn it on"}
      title={on ? "Private mode is on: cards are small pills with no sound" : "Private mode: cards become small pills with no sound, the island hides names"}
      onClick={() => { sfx.click(); void taskMapActions.looks({ privateMode: !on }); }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2.6c-4.3 0-7.4 2.9-7.4 7.5 0 5.4 3.3 11.3 7.4 11.3s7.4-5.9 7.4-11.3c0-4.6-3.1-7.5-7.4-7.5z" />
        <path d="M6.9 8.6c1-.9 2.6-1 3.7-.1" /><path d="M13.4 8.5c1.1-.9 2.7-.8 3.7.1" />
        <path d="M7.7 10.6c.8.6 1.9.6 2.6 0" /><path d="M13.7 10.6c.7.6 1.8.6 2.6 0" />
        <path d="M7.4 13.2c.6 1 1.6 1.4 2.4 1.1" /><path d="M16.6 13.2c-.6 1-1.6 1.4-2.4 1.1" />
        <path d="M8.2 15.6c1.4.9 2.6.5 3.8-.5 1.2 1 2.4 1.4 3.8.5" /><path d="M12 17.4v2.4" />
      </svg>
    </button>
  );
}

// The Dynamic Island switch (the developer, 30 Oct 2026), next to the private mode mask: a small island that
// glows white while the island is on. A click opens its menu: around the notch, a pill below it, or
// off, and whether the next Priority 1 task shows (dimmed) when nothing is in progress. The menu lives
// on document.body (the overlay's blur would shift a fixed menu inside it) and never takes the keyboard.
// Each look has an Edit button that opens its editor in the menu (views/IslandLook.tsx, the developer 4 Nov 2026).
/** Their side of a call, next to yours: "1:00 PM PT" (plus their day when it differs from yours). */
function TheirTime({ at, tz }: { at: Date; tz: string }) {
  let zone = "";
  try { zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value || ""; } catch { return null; }
  const theirs = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
  const dayThem = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at), dayYou = new Intl.DateTimeFormat("en-CA", { timeZone: homeTz() }).format(at);
  const day = dayThem !== dayYou ? new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short" }).format(at) + " " : "";
  // US zones without the summer/winter letter: PDT and PST are both "PT", EDT and EST "ET".
  const short = ({ EST: "ET", EDT: "ET", CST: "CT", CDT: "CT", MST: "MT", MDT: "MT", PST: "PT", PDT: "PT", AKST: "AKT", AKDT: "AKT", HST: "HT", HDT: "HT" } as Record<string, string>)[zone] || zone;
  return <span className="tm-meet-tz num" title={`Their time zone: ${tz.replace(/_/g, " ")} (${zone})`}>{day}{theirs} {short}</span>;
}

// Click a meeting: a small card to the right where you jot what you must say on that call.
// Each reminder has an "Every call" switch: on, it shows on every meeting with this name
// (each Psychology lesson, say), and its tick resets for each new call. Click a reminder to edit it.
function MeetingNotesEditor({ m, notes, standing, onClose }: { m: Upcoming; notes: MeetingNote[]; standing: StandingNote[]; onClose: () => void }) {
  const items = noteFor(notes, m.key)?.items || [];
  const always = standingFor(standing, m.title)?.items || [];
  const [text, setText] = useState("");
  const [every, setEvery] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const add = () => {
    const v = text.trim().slice(0, 300);
    if (!v) return;
    const id = crypto.randomUUID();
    if (every) saveStanding(standing, m.title, [...always, { id, text: v }]);
    else saveNote(notes, m, [...items, { id, text: v, done: false }]);
    setText("");
    sfx.drop();
  };
  const startEdit = (id: string, t: string) => { setEditId(id); setEditText(t); };
  const commitEdit = (id: string, standingItem: boolean) => {
    const v = editText.trim().slice(0, 300);
    setEditId(null);
    if (!v) return;
    if (standingItem) saveStanding(standing, m.title, always.map((x) => (x.id === id ? { ...x, text: v } : x)));
    else saveNote(notes, m, items.map((x) => (x.id === id ? { ...x, text: v } : x)));
  };
  // Move a reminder between "just this call" and "every call like this".
  const flip = (id: string, toEvery: boolean) => {
    sfx.click();
    if (toEvery) {
      const it = items.find((x) => x.id === id);
      if (!it) return;
      void taskMapActions.meetingNotes({ standingNotes: withStanding(standing, m.title, [...always, { id: it.id, text: it.text }]), meetingNotes: withNote(notes, m, items.filter((x) => x.id !== id)) });
    } else {
      const it = always.find((x) => x.id === id);
      if (!it) return;
      void taskMapActions.meetingNotes({ meetingNotes: withNote(notes, m, [...items, { id: it.id, text: it.text, done: false }]), standingNotes: withStanding(standing, m.title, always.filter((x) => x.id !== id)) });
    }
  };
  const row = (id: string, t: string, standingItem: boolean) => (
    <li key={id} className={standingItem ? "every" : ""}>
      <span className="dot" aria-hidden="true" />
      {editId === id ? (
        <input className="tm-mn-edit-in" autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={() => commitEdit(id, standingItem)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(id, standingItem); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditId(null); } }} />
      ) : (
        <button type="button" className="txt" title="Click to edit" onClick={() => startEdit(id, t)}>{t}</button>
      )}
      <button type="button" className={`tm-mn-every${standingItem ? " on" : ""}`} onClick={() => flip(id, !standingItem)}
        title={standingItem ? `Shows on every "${m.title}" call. Click to keep it to this call only` : `Show this on every "${m.title}" call`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></svg>
        Every call
      </button>
      <button type="button" className="tm-tl-btn" aria-label={`Remove ${t}`}
        onClick={() => { sfx.click(); if (standingItem) saveStanding(standing, m.title, always.filter((x) => x.id !== id)); else saveNote(notes, m, items.filter((x) => x.id !== id)); }}>×</button>
    </li>
  );
  return (
    <div className="tm-mn-edit" onMouseDown={(e) => e.stopPropagation()}>
      <div className="tm-mn-edit-h">
        <span className="tm-panel-h">Reminders for this call</span>
        <button type="button" className="tm-tl-btn" onClick={onClose} aria-label="Close">×</button>
      </div>
      <b className="tm-mn-edit-t">{m.title}</b>
      <span className="tm-mn-edit-when num">{m.start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
      {always.length + items.length > 0 && (
        <ul>
          {always.map((x) => row(x.id, x.text, true))}
          {items.map((x) => row(x.id, x.text, false))}
        </ul>
      )}
      <input className="tm-aware-in tm-mn-in" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Something to say or ask on the call"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} />
      <label className="tm-mn-every-new">
        <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} />
        Add to every &ldquo;{m.title}&rdquo; call
      </label>
      <span className="tm-pop-note">Shows as a checklist next to your tasks once the call starts. Click a reminder to edit it.</span>
    </div>
  );
}

// While a call with reminders is on, they appear to the right of your tasks as a checklist.
function LiveMeetingNotes({ meet, notes, standing }: { meet: Upcoming[]; notes: MeetingNote[]; standing: StandingNote[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => window.clearInterval(t); }, []);
  const live = meet.filter((m) => m.start.getTime() <= now && m.end.getTime() > now).map((m) => {
    const own = noteFor(notes, m.key);
    const ds = new Set(own?.doneStanding || []);
    const rows = [
      ...(standingFor(standing, m.title)?.items || []).map((x) => ({ id: x.id, text: x.text, done: ds.has(x.id), every: true })),
      ...(own?.items || []).map((x) => ({ ...x, every: false })),
    ];
    return { m, own, rows };
  }).filter((x) => x.rows.length);
  if (!live.length) return null;
  return (
    <>
      {live.map(({ m, own, rows }) => {
        const left = rows.filter((i) => !i.done).length;
        const tick = (r: (typeof rows)[number]) => {
          if (!r.done) sfx.done(); else sfx.click();
          if (r.every) {
            const ds = new Set(own?.doneStanding || []);
            if (ds.has(r.id)) ds.delete(r.id); else ds.add(r.id);
            saveNote(notes, m, own?.items || [], [...ds]);
          } else saveNote(notes, m, (own?.items || []).map((x) => (x.id === r.id ? { ...x, done: !x.done } : x)));
        };
        return (
          <section key={m.key} className="tm-mn" aria-label="Meeting notes" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="tm-mn-h">Meeting notes</h3>
            <span className="tm-mn-sub">{m.title} · {left === 0 ? "all covered" : `${left} to go`}</span>
            <ul>
              {rows.map((r) => (
                <li key={r.id} className={r.done ? "done" : ""} onMouseEnter={() => sfx.hover()} onClick={() => tick(r)}>
                  <span className="tick" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                  </span>
                  <span className="txt">{r.text}</span>
                  {r.every && <span className="tm-mn-rep" title="On every call like this">every call</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
