// PS, the Mac app. It runs this same code (built with `--mode ps`) inside a small native shell
// (~/Projects/ps/mac) and shows only the To-do page. The shell also has a see-through window
// that floats over every app while Tab is held; it shows the same task map, fed from here.
//
// Bridge, all in memory inside the app (nothing is stored or sent anywhere):
//   page  -> shell: window.webkit.messageHandlers.ps.postMessage(json)
//   shell -> page:  window.__ps.apply(msg)  (main window)  /  window.__psOverlay.load(state)  (overlay)
import { cleanCurrency } from "./core/receiptparse";
import { addTimeReminder, cleanTimeRemind } from "./core/nlremind";
import { RCPT_KIND, cleanReceipt } from "./core/receipts";
import { removeReceipt } from "./receipts";
import { useSyncExternalStore } from "react";
import { localKeyMessage } from "./core/localholders";
import { localMirrorOut, localOp, localSubscribe, setLocalMirror } from "./localfirst";
import { __mirrorLoad, lock, nudge, put, reconnect, refreshGmail, remove, saveLocalCalendar, sb, setMirrorWriter, setPkgLog, setPsKeepOpen, setPsRememberHook, unlockRemembered, vaultStore, sync } from "./core/vault";
import { calendarSnap, campaignStats, latestBrief, openReplies, settingsData } from "./core/select";
import { DIMX_COLORS, DIMX_FX, DIMX_SIZES, type ClientRec, type DimxItem, type DimxStyle, type Doc, type Goal, type Reply, type Settings, type TimelineItem, type Todo } from "./core/model";
import { addTodo, approveSuggestion, awareDone, awareToList, awareUndone, suggestionToAware, suggestionToDimx, resetTodos, saveScreenTime, saveScreenLine, deleteTodo, dismissSuggestion, saveSettings, setReplyHandled, setTodoOrder, setWorkingOn, subtaskOp, toggleTodo, setTodoDone, setTodosDone, clearTodos, reviveTodos, buryTodos, restoreTodo, updateTodo, addMatchAddr, setMailRule, saveDraft, moveTasks, ungroupTasks, setDnd, setJournal, saveTabLayout, saveRemind, savePhoneLayout } from "./core/actions";
import { cleanMailRuleOp } from "./core/mailrules";
import { cleanGroups, cleanSecOrder, type TaskMove } from "./core/groups";
import { LIST_NAME_MAX, cleanPagesLooks, tidyName } from "./core/lists";
import { gmailThreadLink, replierName } from "./core/mail";
import { privateAskMessage, startMeetAlerts } from "./meetwatch";
import { notify } from "./core/notify";
import { primeSfx } from "./ui/sfx";
import { validTz } from "./core/tz";
import { cleanRepeat } from "./core/repeat";
import { cleanSubOp } from "./core/subtasks";
import { isProtectedApp } from "./core/protected";
import { cleanTimeline, LINE_HOURS, type Timeline } from "./core/stline";
import { cleanTimelines } from "./core/timelines";
import { todayISO } from "./ui/kit";
import { applyScreen } from "./core/screenfit";
import { relayoutNow } from "./ui/relayout";
import { bgDesign, p1Color, p1Design } from "./core/prio";
import { bgBright } from "./core/bgbright";
import { cleanPicks, cleanName as cleanDevName } from "./core/devicebg";
import { setDeviceNameHint } from "./devicebeat";
import { cleanCrops } from "./core/bgcrop";
import { rainAmount, rainKind } from "./core/rain";
import { nbDesign } from "./core/notebook";
import { CAMPAIGNS_ON } from "./core/features";
import { cleanSwitches } from "./core/features";   // V1.58 "From the squad" switches (cleanLooks)
import { startFeatureSync } from "./featuresync";
import { liveForMirror, liveStore, refreshCampaignsLive, setLiveAsker, setLiveMirror } from "./core/campaignsLive";
import { cleanTgPrefs } from "./core/tgbot";
import { cleanSentry } from "./core/sentry";
import { startTgBot, tgShellMessage } from "./tgbot";
import { protonShellMessage } from "./core/protonmail";
import { aiDoneMessage } from "./aidone";
import { apiMessage, apiOverlayMessage } from "./taskapi";
import { cleanPairOp } from "./core/pairengine";
import { mainPair, pairForMirror, runPairOp, setPairMirror } from "./core/pairmac";

/** Outline and background settings from the Tab list window: only known looks, numbers 0 to 100. */
export function cleanLooks(p: Record<string, unknown>): Partial<Settings> {
  const o: Partial<Settings> = {};
  const pct = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v))));
  if (typeof p.tmP1Style === "string") o.tmP1Style = p1Design(p.tmP1Style);
  if (p.p1Color === null) o.p1Color = null;                                         // the Priority 1 colour picker: back to the look's own colours
  else if (p1Color(p.p1Color)) o.p1Color = p1Color(p.p1Color);
  if (typeof p.tmBg === "string") o.tmBg = bgDesign(p.tmBg);
  if (Number.isFinite(Number(p.tmBgIntensity)) && p.tmBgIntensity !== null) o.tmBgIntensity = pct(p.tmBgIntensity);
  if (Number.isFinite(Number(p.tmBgFrequency)) && p.tmBgFrequency !== null) o.tmBgFrequency = pct(p.tmBgFrequency);
  if (typeof p.tmBgSound === "boolean") o.tmBgSound = p.tmBgSound;
  if (typeof p.secondCodeJobs === "boolean") o.secondCodeJobs = p.secondCodeJobs;   // Second Computer, Outsource, Code jobs (core/secondcode.ts)
  if (Number.isFinite(Number(p.tmBgVolume)) && p.tmBgVolume !== null) o.tmBgVolume = pct(p.tmBgVolume);
  if (Number.isFinite(Number(p.tmBgVideoBright)) && p.tmBgVideoBright !== null && p.tmBgVideoBright !== "") o.tmBgVideoBright = bgBright(p.tmBgVideoBright);   // core/bgbright.ts
  if (p.tmBgPhone === null) o.tmBgPhone = null;                                       // the phone back to Same as my Mac (core/bgcrop.ts, V1.47)
  else if (typeof p.tmBgPhone === "string" && bgDesign(p.tmBgPhone) === p.tmBgPhone) o.tmBgPhone = p.tmBgPhone;
  if (p.tmBgDev && typeof p.tmBgDev === "object") o.tmBgDev = cleanPicks(p.tmBgDev);   // a background for each device (core/devicebg.ts, PS 1.65)
  if (p.tmBgCrop && typeof p.tmBgCrop === "object") o.tmBgCrop = cleanCrops(p.tmBgCrop);   // how each background fits the phone
  if (typeof p.tmRain === "string") o.tmRain = rainKind(p.tmRain);                       // rain over the list (core/rain.ts, V1.40)
  if (p.tmRainAmount !== undefined && p.tmRainAmount !== null && Number.isFinite(Number(p.tmRainAmount))) o.tmRainAmount = rainAmount(p.tmRainAmount);
  if (p.tmTrail && typeof p.tmTrail === "object") o.tmTrail = trailPrefs(p.tmTrail);   // the Mouse trail (core/trail.ts, V1.43)
  if (typeof p.tmWorkStyle === "string") o.tmWorkStyle = workStyle(p.tmWorkStyle);   // the Working on looks (core/looks.ts WORK_STYLES)
  if (p.theme === "light" || p.theme === "dark" || p.theme === "system") o.theme = p.theme;
  if (p.tmTheme === "light" || p.tmTheme === "dark") o.tmTheme = p.tmTheme;
  if (typeof p.tmNotebook === "string") o.tmNotebook = nbDesign(p.tmNotebook);           // the Notebook looks (core/notebook.ts)
  Object.assign(o, cleanAppearance(p));                                                  // the PS look, accent, density, text, font (core/looks.ts)
  if (typeof p.tmDailyFirst === "boolean") o.tmDailyFirst = p.tmDailyFirst;
  if (Array.isArray(p.tmSecOrder)) o.tmSecOrder = cleanSecOrder(p.tmSecOrder);
  if (typeof p.privateMode === "boolean") o.privateMode = p.privateMode;
  if (p.island && typeof p.island === "object") o.island = islandPrefs(p.island);
  // Pomodoro (core/pomodoro.ts, V1.58): its Settings section; switched off, a timer that is running stops too.
  if (p.pomodoro && typeof p.pomodoro === "object") { o.pomodoro = pomoPrefs(p.pomodoro); if (!o.pomodoro.on) o.pomoRun = null; }
  if (p.pomoIntro === true) o.pomoIntro = true;                                    // the first Pomodoro card was answered
  if (p.standAsk === true) o.standAsk = true;                                      // the first stand-up's question was seen (core/standup.ts, V1.59)
  if (p.standup && typeof p.standup === "object") o.standup = standPrefs(p.standup);   // Stand-up reminders (core/standup.ts, V1.58)
  if (p.calChoices && typeof p.calChoices === "object") o.calChoices = cleanChoices(p.calChoices);   // which calendars are Show only or Off (core/calpick.ts, 15 Nov 2026)
  if (p.meetBubble && typeof p.meetBubble === "object") o.meetBubble = meetBubblePrefs(p.meetBubble);   // the next meeting bubble (core/meetbubble.ts, V1.58)
  if (Array.isArray(p.tmGroups)) o.tmGroups = cleanGroups(p.tmGroups);
  Object.assign(o, cleanPagesLooks(p));                                              // V1.55: the developer's lists, their names, the swipe direction (core/lists.ts)
  if (Array.isArray(p.tmSubOpen)) o.tmSubOpen = p.tmSubOpen.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(-200);
  if (typeof p.netMonitor === "boolean") o.netMonitor = p.netMonitor;
  // Mac settings in the Tab list (V1.23, the main window is gone): the midnight reset. (The "Shall I end my day
  // now?" prompt and its settings were removed on 2 Nov 2026, the developer: "Remove it completely".)
  if (p.autoReset === "midnight" || p.autoReset === "off") o.autoReset = p.autoReset;
  if (okResetAt(p.autoResetAt)) o.autoResetAt = p.autoResetAt;                       // the time it runs, your day starts then (core/resetday.ts)
  if (typeof p.briefSeen === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.briefSeen)) o.briefSeen = p.briefSeen;
  { const v = cleanSeen(p.whatsNewSeen); if (v) o.whatsNewSeen = v; }               // What's new handled up to this version (core/whatsnew.ts, V1.36)
  { const v = cleanWelcomeDone(p.welcomeDone); if (v) o.welcomeDone = v; }        // the welcome tour was finished or put off (core/welcome.ts, G Squad)
  if (p.tipsSeen && typeof p.tipsSeen === "object") o.tipsSeen = mergeTipsSeen(settingsData(vaultStore.get()).tipsSeen, p.tipsSeen);   // the first use tips seen, merged with this vault's newest (core/tips.ts, V1.55)
  if (p.popupsSeen && typeof p.popupsSeen === "object") o.popupsSeen = mergePopupsSeen(settingsData(vaultStore.get()).popupsSeen, p.popupsSeen);   // the "new in this version" pop-ups seen, merged with this vault's newest (core/newpopups.ts, V1.56)
  if (p.walkSeen && typeof p.walkSeen === "object") o.walkSeen = mergeWalkSeen(settingsData(vaultStore.get()).walkSeen, p.walkSeen);   // the "what is new" walkthrough steps seen, merged with this vault's newest (core/walkthrough.ts, V1.58)
  if (Array.isArray(p.tmNumPeople)) o.tmNumPeople = cleanPeople(p.tmNumPeople);   // Numerology (views/Numerology.tsx)
  if (p.gym && typeof p.gym === "object") o.gym = gymPrefs(p.gym);                  // the gym reminder (core/gym.ts, Fitness settings)
  if (p.sleepMode && typeof p.sleepMode === "object") o.sleepMode = cleanSleepMode(p.sleepMode);   // Sleep mode (core/sleepmode.ts, V1.40)
  if (p.sentry && typeof p.sentry === "object") o.sentry = cleanSentry(p.sentry);                  // Sentry mode (core/sentry.ts, V1.48)
  Object.assign(o, newLooks(p));                                                     // the NEW badge: on, minutes, one clicked away (core/newbadge.ts, V1.33)
  Object.assign(o, cleanTickSoundLooks(p));                                          // the tick sound (core/ticksound.ts, V1.34)
  Object.assign(o, cleanAddLooks(p));                                                // the Add task button: colour and click animation (core/addbutton.ts, V1.34)
  Object.assign(o, cleanOverdueLook(p));                                             // the Overdue card: colours and effect (core/overduelook.ts, V1.44)
  if (typeof p.tmTypedPrio === "boolean") o.tmTypedPrio = p.tmTypedPrio;
  if (p.tgBot && typeof p.tgBot === "object") o.tgBot = cleanTgPrefs(p.tgBot);          // Add Telegram Bot: start word and linked chat (core/tgbot.ts, V1.47)             // typed P1, P2, P3 in a new task (core/typedprio.ts, V1.40)
  Object.assign(o, cleanNoteLook(p));                                                // notification cards: colour and sound per kind (core/notelook.ts, V1.36)
  Object.assign(o, cleanListLooks(p));                                               // To do list behaviour: Completed or Disappear, shown, how long (core/completed.ts, V1.34)
  if (p.tmAudio && typeof p.tmAudio === "object") o.tmAudio = cleanAudio(p.tmAudio);   // Headphones mode's old lists (core/audiomode.ts, V1.40 to 1.64): still cleaned when an older PS saves them; 1.65 uses Audio priority on the Mac
  if (p.updateEvery !== undefined && p.updateEvery !== null) o.updateEvery = cleanUpdateEvery(p.updateEvery);   // Check for updates every: 5, 10, 15, 30 or 0 = Off (core/updateevery.ts)
  // Open source off switches (missing = on): G Squad auto join, the "PS app is open" presence, the first use tips.
  if (typeof p.squadAutoJoin === "boolean") o.squadAutoJoin = p.squadAutoJoin;
  if (typeof p.psPresence === "boolean") o.psPresence = p.psPresence;
  if (typeof p.tipsShow === "boolean") o.tipsShow = p.tipsShow;
  if (typeof p.receipts === "boolean") o.receipts = p.receipts;   // Settings, Receipts and Purchases (PS 1.65)
  if (typeof p.receiptCur === "string") o.receiptCur = cleanCurrency(p.receiptCur);   // the currency a new receipt starts with
  if (typeof p.replyInPanel === "boolean") o.replyInPanel = p.replyInPanel;   // Settings, Reply in the email panel (V1.59)
  if (p.chkRemind && typeof p.chkRemind === "object") o.chkRemind = cleanChk(p.chkRemind);   // Settings, Checklist Reminder (PS 1.65, core/chkremind.ts)
  if (p.timeEst && typeof p.timeEst === "object") o.timeEst = cleanTe(p.timeEst);   // Settings, Your list, time estimates (PS 1.65, core/timeest.ts)
  if (p.estWarnDay === null || (typeof p.estWarnDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.estWarnDay))) o.estWarnDay = p.estWarnDay as string | null;   // the overload line, once a day
  if (typeof p.swipeInvert === "boolean") o.swipeInvert = p.swipeInvert;   // Settings, Controls, Invert swipe (V1.57)
  if (p.squadFeatures && typeof p.squadFeatures === "object") o.squadFeatures = cleanSwitches(p.squadFeatures);   // Settings, From the squad (V1.58, core/features.ts)
  // V1.56 Saved looks: only the device kinds this change names, merged into the vault's newest (core/looksprofiles.ts).
  if (p.looksSaved && typeof p.looksSaved === "object") o.looksSaved = mergeLooksKinds(settingsData(vaultStore.get()).looksSaved, cleanLooksStore(p.looksSaved, cleanLookData));
  if (typeof p.editSounds === "boolean") o.editSounds = p.editSounds;   // V1.56 Edit mode sounds (core/editsounds.ts)
  return o;
}
import { cleanChk } from "./core/chkremind";
import { islandMessage, islandNow, islandStandTest, startIsland } from "./island";
import { runPomoOp, startPomodoro } from "./pomodoro";
import { cleanOp, pomoPrefs } from "./core/pomodoro";
import { standPrefs } from "./core/standup";
import { meetBubblePrefs } from "./core/meetbubble";
import { cleanChoices, sameChoices, tidyChoices } from "./core/calpick";
import { cleanAppearance, workStyle } from "./core/looks";
import { trailPrefs } from "./core/trail";
import { cleanLooksStore, mergeLooksKinds } from "./core/looksprofiles";
import { cleanLookData } from "./core/maclook";
import { okResetAt } from "./core/resetday";
import { startDnd } from "./dnd";
import { cleanAudio } from "./core/audiomode";
import { startPsStatus } from "./psstatus";
import { cleanDndOp } from "./core/dnd";
import { islandPrefs } from "./core/island";
import { cleanRules } from "./core/rules";
import { mailOnSnap } from "./core/mailsnap";
import { irepFeed, mailCardMessage, startMailCards } from "./mailcards";
import { cleanReplyCardId, leadRows, setLeadMirror } from "./core/overlaymail";
import { leadCards } from "./core/leadcards";
import { requestWaReply } from "./core/wareplyopen";
import { requestMailOpen } from "./core/mailopen";
import { cleanReplyPatch, openReplyFor, openReplySetup, replyMessage, runMailReplyOp, sendInlineOrSay, startReplyEngine } from "./replyengine";
import { cleanInlineSend } from "./core/inlinereply";
import { cleanWaOp, runWaOp } from "./core/waops";
import { notesCardMessage, startNotesCard } from "./notescard";
import { rebootWarnMessage, startRebootWarn } from "./rebootwarn";
import { ackGymDay, gymCardMessage, gymWake, startGymWatch } from "./gymwatch";
import { rewindActive, rewindAys } from "./rewind";
import { okFeedId } from "./core/calfeeds";
import { calLinkNow, calRefreshIfStale, calRefreshNow, setLocalCalReader, startCalRefresh } from "./calrefresh";
import { CAL_OFF_SNAP, localSnap, localStatusPatch } from "./core/localcal";
import { calStatus, cleanCalStatus } from "./core/calstatus";
import { applyMeetHide, cleanMeetHideOp } from "./core/meethide";
import { gymPrefs } from "./core/gym";
import { newLooks } from "./newbadge";
import { radarDraft } from "./core/radarLive";
import { tidyRadarState, type RadarState } from "./core/radar";
import { bgAllowed, startBgVault } from "./core/bgvault";
import { cleanSecondOp, runSecondOp, secondLocal, secondMessage, secondStore, setSecondMirror, startSecond, stopSecond } from "./second/store";
import { secondOnSnap } from "./core/secondsnap";
import { cleanPeople } from "./core/numerology";
import { cleanListLooks, cleanTodoOp, type TodoOp } from "./core/completed";
import { cleanTickSoundLooks } from "./core/ticksound";
import { cleanAddLooks } from "./core/addbutton";
import { cleanOverdueLook } from "./core/overduelook";
import { cleanNoteLook } from "./core/notelook";
import { startNoteLook } from "./notelook";
import { startSentryPrefs } from "./sentryprefs";
import { cleanSeen } from "./core/whatsnew";
import { cleanWelcomeDone } from "./core/welcome";
import { mergeTipsSeen } from "./core/tips";
import { mergePopupsSeen } from "./core/newpopups";
import { mergeWalkSeen } from "./core/walkthrough";
import { cleanUpdateEvery } from "./core/updateevery";
import { presenceOn } from "./core/offswitches";   // "Tell the website PS app is open": off = no ps-presence channel, the website no longer leaves Tab to PS app
import { startExamples } from "./examples";
import { deleteExamples, undoExamples, renameDevice } from "./core/actions";
import { recentPrivate } from "./core/privatenotes";
import { cleanTzOp } from "./core/tzpeople";
import { cleanTzZonesOp } from "./core/tzzones";
import { cleanLayoutOp } from "./core/tablayout";
import { cleanPhoneLayoutOp } from "./core/phonelayout";
import { cleanRemindOp, mergeRemind } from "./core/remind";
import { remShellMessage, remWake, startRemWatch } from "./remwatch";
import { postureShellMessage, startPostureWatch } from "./posturewatch";
import { startChkWatch } from "./chkwatch";
import { cleanTimeOp, runTimeOp } from "./core/timesave";
import { cleanEst, cleanTe } from "./core/timeest";
import { cleanSleepMode } from "./core/sleepmode";
import { dirCardMessage, runSquadOp, squadStore, squadView, startSquad } from "./squad/engine";
import { boardWake, runBoardOp, startSquadBoard } from "./squad/board";
import { setGymScreen } from "./squad/presence";
import { cleanSquadOp } from "./squad/view";
import { setSquadMirror } from "./squad/mirror";
import { chatCardMessage, chatStore, chatView, runChatOp, startChat } from "./squad/chatengine";
import { cleanChatOp } from "./squad/chatview";
import { setChatMirror } from "./squad/chatmirror";
import { gymStore, gymView, runGymOp, startGymSquad } from "./squad/gym";
import { cleanSbOp, runSbOp, sbShareStore, sbShareView, setSbMirror } from "./squad/sbshare";
import { cleanGymOp, setGymMirror } from "./squad/gymview";

export const PS = import.meta.env.MODE === "ps";
const SECOND_KINDS = new Set<string>(["sdev", "spair", "sjob", "sjobst", "smsg", "sfile", "sack", "sstat", "scmd", "sidx", "sget"]);
// Fitness (programs, workouts, its settings): a screen inside the Tab list since 2 Nov 2026 (the pop-out window is
// gone), so the list gets a copy and its writes come back here (vault.ts setMirrorWriter). Nothing else is written from there.
const FIT_KINDS = new Set<string>(["fprog", "fwork", "fit", "fsleep", "fact"]);
// The Tab list also writes receipts (PS 1.65, Purchases: Add by typing, a fixed receipt, a deleted one); they go the same way and are cleaned again here.
const TAB_KINDS = new Set<string>([...FIT_KINDS, RCPT_KIND]);
const okId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
/** One Fitness write from the Tab list, checked: only Fitness kinds, only Fitness records removed. */
async function runFitOp(o: unknown) {
  const w = (o && typeof o === "object" ? o : {}) as { op?: unknown; kind?: unknown; id?: unknown; data?: unknown };
  if (!okId(w.id)) return;
  const have = vaultStore.get().docs.get(w.id);
  if (w.op === "put" && typeof w.kind === "string" && TAB_KINDS.has(w.kind) && w.data && typeof w.data === "object" && (!have || have.kind === w.kind)) {
    const data = w.kind === RCPT_KIND ? cleanReceipt(w.data) : w.data;
    if (data) await put(w.kind as Doc["kind"], data, { id: w.id, ws: null });
  } else if (w.op === "remove" && have && TAB_KINDS.has(have.kind)) { if (have.kind === RCPT_KIND) await removeReceipt(w.id); else await remove(w.id); }   // a receipt takes its sealed photo with it
}
/** People on the Time zones screen (core/tzpeople.ts), added, renamed, moved or taken off in the Tab list: checked
 *  again here, and only ever a tzperson record is written or removed. */
async function runTzOp(v: unknown) {
  const o = cleanTzOp(v);
  if (!o) return;
  const have = vaultStore.get().docs.get(o.id);
  if (have && have.kind !== "tzperson") return;
  if (o.op === "put") await put("tzperson", o.data, { id: o.id, ws: null });
  else if (have) await remove(o.id);
}
/** Your list of clocks (core/tzzones.ts), changed in the Tab list: checked again here, only ever a tzzones record. */
async function runTzZonesOp(v: unknown) {
  const o = cleanTzZonesOp(v);
  if (!o) return;
  const have = vaultStore.get().docs.get(o.id);
  if (have && have.kind !== "tzzones") return;
  if (o.op === "put") await put("tzzones", o.data, { id: o.id, ws: null });
  else if (have) await remove(o.id);
}
/** The Tab list's Edit mode (core/tablayout.ts): its one small layout record, checked again here. A save from the
 *  list becomes a save of the newest copy (only when a place changed); only ever a tablayout record is removed. */
async function runLayoutOp(v: unknown) {
  const o = cleanLayoutOp(v);
  if (!o) return;
  const have = vaultStore.get().docs.get(o.id);
  if (have && have.kind !== "tablayout") return;
  if (o.op === "put") await saveTabLayout(o.data, o.id);
  else if (have) await remove(o.id);
}
/** V1.56 the phone layout editor in the Tab list's Edit overview (core/phonelayout.ts): one phone kind's record,
 *  checked again here, saved only when it changed. The Tab list never removes one. */
async function runPhoneLayoutOp(v: unknown) {
  const o = cleanPhoneLayoutOp(v, vaultStore.get().red);
  if (!o) return;
  const have = vaultStore.get().docs.get(o.id);
  if (have && have.kind !== "phonelayout") return;
  await savePhoneLayout(o.data, o.id);
}
/** The Annoying 15 min reminders (core/remind.ts) edited in Settings in the Tab list: checked again here, merged into
 *  the newest copy (an answer from the phone that came meanwhile is kept), only ever the remind record. */
async function runRemindOp(v: unknown) {
  const o = cleanRemindOp(v);
  if (!o) return;
  const have = vaultStore.get().docs.get(o.id);
  if (have && have.kind !== "remind") return;
  await saveRemind((cur) => (cur ? mergeRemind(cur, o.data) : o.data), o.id);
}
/** One list change from the Tab list (core/completed.ts cleanTodoOp has checked it): run it on the newest copy. */
export function runTodoOp(o: TodoOp): Promise<void> {
  if (o.op === "done") return setTodosDone(o.ids, o.done);
  if (o.op === "clear" || o.op === "unclear") return clearTodos(o.ids, o.op === "clear");
  if (o.op === "revive") return reviveTodos(o.ids);
  if (o.op === "bury") return buryTodos(o.ids, o.cleared);
  return restoreTodo(o.id, o.data);
}
/** The rest timer's "Rest over" card, asked for by Fitness in the Tab list (only this page may show cards). */
function fitCard(o: unknown) {
  const c = (o && typeof o === "object" ? o : {}) as { hide?: unknown; title?: unknown; sub?: unknown };
  if (c.hide === true) { psPost({ type: "cardHide", id: "f-rest" }); return; }
  if (typeof c.title === "string") psPost({ type: "cardShow", card: { id: "f-rest", title: c.title.slice(0, 120), sub: typeof c.sub === "string" ? c.sub.slice(0, 160) : "" } });
}
let overlayPage = false;
/** This page is the Tab list (it holds no keys; the main page does the saving). */
export const psInOverlay = () => overlayPage;

type W = Window & {
  webkit?: { messageHandlers?: { ps?: { postMessage(m: string): void } } };
  __ps?: { apply(m: ShellMsg): void };
  __psUpdateReady?: boolean;
};
type ShellMsg = { type: "tick"; id: string; done?: boolean } | { type: "work"; id: string | null }
  | { type: "reorder"; ids: string[]; p1?: unknown } | { type: "p1Style"; id: string } | { type: "looks"; patch: unknown } | { type: "tmScale"; v: number } | { type: "tmClockScale"; v: number }
  | { type: "update"; id: string; patch: Record<string, unknown> } | { type: "remove"; id: string }
  | { type: "aware"; list: { id: string; text: string; createdAt: string }[] }
  | { type: "homeTz"; id: string | null }
  | { type: "mic"; current: string; devices: { uid: string; name: string }[] }
  | { type: "meetingNotes"; list?: { key: string; title: string; start: string; items: { id: string; text: string; done: boolean }[]; doneStanding?: string[] }[];
      standing?: { title: string; items: { id: string; text: string }[] }[] }
  | { type: "timelineOrder"; ids: string[] } | { type: "timelineHidden"; ids: string[] }
  | { type: "timelines"; list: TimelineItem[] } | { type: "headline"; text: string } | { type: "sound"; tmSound?: number; tmMuted?: boolean }
  | { type: "add"; title: string; due: string | null; kind: "once" | "daily"; order?: number; repeat?: unknown; p1?: unknown; clientId?: unknown; notes?: unknown; unranked?: unknown; sqOn?: unknown; sqAnon?: unknown; group?: unknown; remind?: unknown } | { type: "sync" } | { type: "tap"; on: boolean }
  | { type: "psSettings"; data: PsSettings }
  | { type: "tab"; enabled: boolean; trusted: boolean; on: boolean }
  | { type: "waReply"; id: string } | { type: "mailOpen"; via: string }
  | { type: "remember"; username: string; auth: string; kek: string }
  | { type: "rememberStatus"; exists: boolean; locked?: boolean } | { type: "touchid"; ok: boolean }
  | { type: "lock" } | { type: "suggest"; id: string; action: "add" | "dismiss" | "aware" | "dimx"; place?: { type?: string; order?: number; p1?: boolean }; zone?: unknown } | { type: "workStyle"; style: string }
  | { type: "reset" } | { type: "resetUndo" } | { type: "notifyPref"; on: boolean } | { type: "replyHandled"; id: string }
  | { type: "screentime"; day: string; apps: { id: string; name: string; secs: number }[] }
  | { type: "appIcons"; icons: Record<string, string> }
  | { type: "presence"; lastOn?: string; back?: string }
  | ({ type: "timeline" } & Timeline)
  | { type: "stHours"; v: number }
  | { type: "backdrop"; v: number }
  | { type: "goals"; list: unknown }
  | { type: "awayPatch"; awayLog?: unknown; awayReasons?: unknown }
  | { type: "meetPrefs"; prefs: Record<string, unknown> }
  | { type: "afkDone"; list: unknown }
  | { type: "inboxMin"; at: string }
  | { type: "dimxList"; list: unknown }
  | { type: "pull" } | { type: "wake" } | { type: "squadOpen" }
  | { type: "awareDone"; id: string; todoId: string } | { type: "awareUndone"; item: unknown; index: number; todoId: string }
  | { type: "awareToList"; id: string; order: number; kind?: string; p1?: boolean }
  | { type: "localCal"; status?: unknown; at?: unknown; from?: unknown; to?: unknown; events?: unknown };   // this Mac's Calendar (ps-mac LocalCalendar.swift)

export function psPost(msg: object) {
  try { (window as W).webkit?.messageHandlers?.ps?.postMessage(JSON.stringify(msg)); } catch { /* not inside PS */ }
}

/** True once the shell has installed a newer build on disk (the refresh button then reloads). */
export function psUpdateReady() { return !!(window as W).__psUpdateReady; }

/** Goals from the Tab list window, checked field by field. */
function cleanGoals(list: unknown[]): Goal[] {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return list.filter((g): g is Record<string, unknown> => !!g && typeof g === "object").map((g) => ({
    id: String(g.id || crypto.randomUUID()).slice(0, 64), title: String(g.title || "").slice(0, 120),
    level: (g.level === "meso" || g.level === "micro" ? g.level : "macro") as Goal["level"],
    start: day.test(String(g.start)) ? String(g.start) : todayISO(), end: day.test(String(g.end)) ? String(g.end) : todayISO(),
    color: /^#[0-9A-Fa-f]{6}$/.test(String(g.color)) ? String(g.color) : "#EC4E86",
    note: typeof g.note === "string" ? g.note.slice(0, 1000) : null, done: g.done === true,
    createdAt: typeof g.createdAt === "string" ? g.createdAt : new Date().toISOString(),
  })).slice(0, 500);
}

/** A card's text style: only the known values, anything else is dropped. */
function cleanStyle(v: unknown): DimxStyle | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>, o: DimxStyle = {};
  const pick = <T extends string>(list: readonly T[], x: unknown) => (list as readonly unknown[]).includes(x) ? x as T : undefined;
  const fx = pick(DIMX_FX, s.fx), color = pick(DIMX_COLORS, s.color), size = pick(DIMX_SIZES, s.size), hl = pick(DIMX_COLORS, s.highlight);
  if (fx && fx !== "none") o.fx = fx;
  if (color && color !== "white") o.color = color;
  if (size && size !== "m") o.size = size;
  if (hl) o.highlight = hl;
  for (const k of ["bold", "italic", "underline", "strike", "caps"] as const) if (s[k] === true) o[k] = true;
  return Object.keys(o).length ? o : undefined;
}

/** Dimension X's cards from the Tab list window, checked field by field. */
function cleanDimx(list: unknown[]): DimxItem[] {
  const zones = new Set(["act", "soon", "x"]);
  const seen = new Set<string>();
  return list.filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .filter((d) => typeof d.text === "string" && !!d.text.trim() && zones.has(String(d.zone)))
    .map((d) => {
      const item: DimxItem = { id: String(d.id || crypto.randomUUID()).slice(0, 64), text: (d.text as string).trim().slice(0, 500), zone: d.zone as DimxItem["zone"],
        createdAt: typeof d.createdAt === "string" && Number.isFinite(Date.parse(d.createdAt)) ? d.createdAt : new Date().toISOString() };
      const style = cleanStyle(d.style);
      if (style) item.style = style;
      return item;
    })
    .filter((d) => !seen.has(d.id) && !!seen.add(d.id))
    .slice(0, 400);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last Reset made from the Tab list, so its Undo can put the list back. */
let psResetUndo: (() => Promise<void>) | null = null;

/** Only the fields the floating list can edit, with the right types. */
/** A series map note or month title from the Tab list window (views/SeriesMap.tsx): a day, week or
 *  month key and short text only, checked before it touches the vault. */
export function cleanJournalOp(o: unknown): { key: string; patch: { title?: string | null; note?: string | null } } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const key = typeof r.key === "string" && /^(d:\d{4}-\d{2}-\d{2}|w:\d{4}-\d{2}-\d{2}|m:\d{4}-\d{2})$/.test(r.key) ? r.key : null;
  if (!key) return null;
  const text = (v: unknown, max: number) => (v === null ? null : typeof v === "string" ? v.trim().slice(0, max) || null : undefined);
  const patch: { title?: string | null; note?: string | null } = {};
  const title = text(r.title, 120), note = text(r.note, 8000);
  if (title !== undefined) patch.title = title;
  if (note !== undefined) patch.note = note;
  return Object.keys(patch).length ? { key, patch } : null;
}

function cleanTaskMove(t: Record<string, unknown>): TaskMove | null {
  const ids = Array.isArray(t.ids) ? t.ids.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 200) : [];
  const to = typeof t.to === "string" ? t.to : "";
  const index = Number(t.index);
  if (!ids.length || !(to === "new" || cleanSecOrder([to]).length) || !Number.isFinite(index)) return null;
  return { ids, to, index: Math.max(0, Math.round(index)) };
}
function cleanPatch(p: Record<string, unknown>) {
  const o: Partial<Todo> = {};
  if (typeof p?.title === "string" && p.title.trim()) o.title = p.title.trim().slice(0, 500);
  if (p?.notes === null || typeof p?.notes === "string") o.notes = (p.notes as string | null) || null;
  if (p?.type === "once" || p?.type === "daily") o.type = p.type;
  if (p?.due === null || (typeof p?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.due))) o.due = (p.due as string | null) || null;
  if (p?.clientId === null || typeof p?.clientId === "string") o.clientId = (p.clientId as string | null) || null;
  if (typeof p?.order === "number" && Number.isFinite(p.order)) o.order = p.order;
  if (typeof p?.p1 === "boolean") o.p1 = p.p1;
  if (typeof p?.unranked === "boolean") o.unranked = p.unranked;
  // The AI Inbox (core/aiinbox.ts): moved out of it (Dimension X), into a task group or back to the sections.
  if (typeof p?.aiInbox === "boolean") o.aiInbox = p.aiInbox;
  if (p?.group === null || (typeof p?.group === "string" && /^[a-z0-9]{4,24}$/.test(p.group))) o.group = (p.group as string | null) || null;
  if ("repeat" in (p || {})) o.repeat = cleanRepeat(p.repeat, o.due || todayISO());
  // Time estimates (PS 1.65, core/timeest.ts): minutes or none, and whether it was learned from past times.
  if ("est" in (p || {})) o.est = cleanEst(p.est);
  if (p?.estBy === null || p?.estBy === "past") o.estBy = p.estBy as "past" | null;
  return o;
}

// Is the list actually on screen? PS keeps its floating window alive (invisible) between shows,
// so backgrounds and thunder ask this before anything moves or sounds. The website's list only
// exists while it is open, so there it is always true.
let overlayShown = !PS;
const shownListeners = new Set<() => void>();
export function setPsOverlayShown(v: boolean) { if (v !== overlayShown) { overlayShown = v; shownListeners.forEach((l) => l()); } }
export function psOverlayShown() { return overlayShown; }
export function onOverlayShown(l: () => void) { shownListeners.add(l); return () => void shownListeners.delete(l); }
export function useOverlayShown() {
  return useSyncExternalStore((l) => { shownListeners.add(l); return () => { shownListeners.delete(l); }; }, () => overlayShown);
}

// ---------- The developer's own background videos (PS only; the files never leave his Mac) ----------
/** `file`: the phone plays an older copy under this id while the newest one downloads (core/bgvault.ts, V1.47). */
export type BgVideo = { id: string; name: string; file?: string };
let bgVideos: BgVideo[] = [];
const bgListeners = new Set<() => void>();
export function useBgVideos() {
  return useSyncExternalStore((l) => { bgListeners.add(l); return () => { bgListeners.delete(l); }; }, () => bgVideos);
}
/** PS GOS: the videos on the phone (they come from the vault there, see src/gos/bgvault.ts). */
export function setBgVideos(list: BgVideo[]) { bgVideos = list; bgListeners.forEach((l) => l()); }

/** Second Computer window only (views/SecondWindow.tsx): like the overlay it holds no keys; PS feeds it the main
 *  page's state and its actions go back as `secondOp` through the same "looks" path. */
// Once per page. App calls this while it renders, and App redraws on every vault change: the Second
// Computer window used to say "ready, settings please" again on every redraw, PS answered with the whole
// state and the settings, which redrew it again, about 40 times a second with the developer's vault, until PS's main
// thread choked (1 Nov 2026, the M4 froze).
let secondWinStarted = false;
export function startPsSecondWindow() {
  if (!PS || secondWinStarted) return;
  secondWinStarted = true;
  (window as Window & { __psSecondWin?: unknown }).__psSecondWin = {
    load(st: { unlocked: boolean; docs: Doc[]; lastSync: string | null; red?: boolean; primary?: boolean; second?: unknown }) {
      __mirrorLoad(st.unlocked, st.docs || [], st.lastSync, st.red === true, null, st.primary === true);
      setSecondMirror(st.second);
    },
    tab(t: string) { window.dispatchEvent(new CustomEvent("ps-second-tab", { detail: String(t) })); },
  };
  // This Mac's PS settings (the reboot timer card on the Machine pane reads settings.reboot).
  (window as W).__ps = {
    apply(m) { if (m.type === "psSettings") { psSettings = m.data; settingsListeners.forEach((l) => l()); } },
  };
  psPost({ type: "psSettings:get" });
  psPost({ type: "second:winReady" });
}

/** Overlay window only: receive the list from the main window. */
export function startPsOverlay() {
  if (!PS) return;
  overlayPage = true;
  startLineShare();
  // Fitness writes go to the main page (runFitOp checks them again there).
  setMirrorWriter((w) => {
    // People on the Time zones screen (core/tzpeople.ts): their own op, run by runTzOp on the main page.
    const tz = w.op === "put" ? w.kind === "tzperson" : vaultStore.get().docs.get(w.id)?.kind === "tzperson";
    if (tz) { psPost({ type: "looks", patch: { tzOp: w } }); return true; }
    // Your list of clocks (core/tzzones.ts): run by runTzZonesOp on the main page.
    const zones = w.op === "put" ? w.kind === "tzzones" : vaultStore.get().docs.get(w.id)?.kind === "tzzones";
    if (zones) { psPost({ type: "looks", patch: { tzZonesOp: w } }); return true; }
    // Edit mode's places (core/tablayout.ts): their own op, run by runLayoutOp on the main page.
    const lay = w.op === "put" ? w.kind === "tablayout" : vaultStore.get().docs.get(w.id)?.kind === "tablayout";
    if (lay) { psPost({ type: "looks", patch: { layoutOp: w } }); return true; }
    // V1.56 the phone layout editor (core/phonelayout.ts): run by runPhoneLayoutOp on the main page.
    if (w.op === "put" && w.kind === "phonelayout") { psPost({ type: "looks", patch: { phoneLayoutOp: w } }); return true; }
    // The Annoying 15 min reminders (core/remind.ts): run by runRemindOp on the main page.
    if (w.op === "put" && w.kind === "remind") { psPost({ type: "looks", patch: { remindOp: w } }); return true; }
    if (w.op === "put" && !TAB_KINDS.has(w.kind)) return false;
    if (w.op === "remove" && !TAB_KINDS.has(vaultStore.get().docs.get(w.id)?.kind ?? "")) return false;
    psPost({ type: "looks", patch: { fitOp: w } });
    return true;
  });
  (window as Window & { __psBg?: unknown }).__psBg = (list: unknown) => {
    if (!Array.isArray(list)) return;
    bgVideos = list.filter((v): v is BgVideo => !!v && typeof v.id === "string" && /^[a-z0-9-]{1,48}$/.test(v.id) && typeof v.name === "string")
      .map((v) => ({ id: v.id, name: v.name.slice(0, 60) }));
    bgListeners.forEach((l) => l());
  };
  psPost({ type: "bg:get" });
  psPost({ type: "proton:get" });   // PS 1.65 Proton Mail through Bridge: the unread rows and the link's status (core/protonmail.ts)
  // Cincee Campaigns live: the panel's refresh asks the main page, which has the keys.
  if (CAMPAIGNS_ON) setLiveAsker(() => psPost({ type: "looks", patch: { campLive: true } }));   // off (core/features.ts): nothing asks
  // Screen fit (V1.40): PS describes the screen the list opens on and the zoom it set (core/screenfit.ts).
  (window as Window & { __psScreen?: (v: unknown) => unknown }).__psScreen = (v: unknown) => applyScreen(v) !== null;
  (window as Window & { __psOverlay?: unknown }).__psOverlay = {
    // Called with new data, and every time the floating list is shown (opening; an older PS app
    // leaves it out, which counts as showing). Only a show wakes the sounds and plays the pop-in,
    // so new data arriving while the list is up never makes it blink.
    load(st: { unlocked: boolean; docs: Doc[]; lastSync: string | null; red?: boolean; primary?: boolean; second?: unknown; clive?: unknown; cal?: unknown; squad?: unknown; sqchat?: unknown; gym?: unknown; sbsq?: unknown; local?: { since: string } | null; lf?: unknown; leads?: unknown; pair?: unknown }, opening?: boolean) {
      __mirrorLoad(st.unlocked, st.docs || [], st.lastSync, st.red === true, st.local ?? null, st.primary === true);
      setLocalMirror(st.unlocked ? st.lf : null);   // local first: the last export or import, the copy kept after a move
      setSquadMirror(st.unlocked ? st.squad : null);   // G Squad: the plain view the main page made (src/squad/engine.ts)
      setChatMirror(st.unlocked ? st.sqchat : null);   // G Squad chat: plain lines, unread count, history votes (src/squad/chatengine.ts)
      setGymMirror(st.unlocked ? st.gym : null);       // G Squad Fitness: boards, compare, posts, already opened (src/squad/gym.ts)
      setSbMirror(st.unlocked ? st.sbsq : null);        // the Soundboard's shared sounds (src/squad/sbshare.ts)
      calStatus.set(cleanCalStatus(st.cal));   // the Meetings panel's "Updated X ago" and spin (src/core/calstatus.ts)
      setSecondMirror(st.second);   // Second Computer: this Mac, who it trusts, transfers in flight (src/second/store.ts)
      setLiveMirror(st.clive);      // Cincee Campaigns live numbers, read by the main page (core/campaignsLive.ts)
      setLeadMirror(st.unlocked ? st.leads : null);   // open lead replies for the email panel (core/overlaymail.ts)
      setPairMirror(st.unlocked ? st.pair : null);    // V1.57: Link your phone, the main window's pairing (core/pairmac.ts)
      if (opening === false) return;
      primeSfx();
      setPsOverlayShown(true);
      relayoutNow();   // shown again: everything that measures itself measures now, and again when the new size lands (ui/relayout.ts)
      // The page never sleeps between shows, so just replay the little pop-in.
      document.querySelector(".tm-inner")?.animate(
        [{ opacity: 0, transform: "scale(.985)" }, { opacity: 1, transform: "none" }],
        { duration: 120, easing: "cubic-bezier(.2,.9,.3,1)" });
    },
  };
  // The overlay also needs the Tab switch and "remembered" for its top right buttons.
  (window as W).__ps = {
    apply(m) {
      if (protonShellMessage(m as { type?: string })) return;   // PS 1.65 Proton Mail through Bridge: the unread rows, a reply's answer (core/protonmail.ts)
      if (apiOverlayMessage(m as { type?: string })) return;   // Settings, AI task API: the key, shown when asked (src/taskapi.ts)
      if (m.type === "tab") { tabState = { enabled: m.enabled, trusted: m.trusted }; settingsListeners.forEach((l) => l()); }
      else if (m.type === "mailOpen") requestMailOpen((m as { via?: unknown }).via);   // PS 1.61: the island's envelope or reply arrow: the email panel opens its newest email (core/mailopen.ts)
      else if (m.type === "waReply") requestWaReply((m as { id?: unknown }).id);   // a WhatsApp card's Reply: the reply box opens on that chat (core/wareplyopen.ts)
      else if (m.type === "rememberStatus") { remembered = m.exists; touchLocked = m.locked === true; settingsListeners.forEach((l) => l()); }
      else if (m.type === "mic") setMic(m);
      else if (m.type === "psSettings") { psSettings = m.data; settingsListeners.forEach((l) => l()); }   // Mac settings in the Tab list (V1.23)
      else if (m.type === "appIcons") gotIcons(m.icons);
      else if (m.type === "timeline") { timeline = m; iconListeners.forEach((l) => l()); shareTimeline(m); }
      else if (m.type === "presence") { presence = { lastOn: m.lastOn || null, back: m.back || null }; iconListeners.forEach((l) => l()); }
      else if (m.type === "squadOpen") void import("./squad/chatopen").then((c) => c.openSquadChat({}));   // a G Squad message card's Open (core/squadnotify.ts): the chat comes up
    },
  };
}

// App icons for the screen time pop-up, straight from PS (kept in memory only, never in the vault).
let appIcons: Record<string, string> = {};
const iconAsked = new Set<string>();
const iconListeners = new Set<() => void>();
function gotIcons(icons: unknown) {
  if (!icons || typeof icons !== "object") return;
  const next = { ...appIcons };
  for (const [id, url] of Object.entries(icons as Record<string, unknown>)) {
    if (!isProtectedApp(id) && typeof url === "string" && url.startsWith("data:image/png;base64,")) next[id] = url;
  }
  appIcons = next;
  iconListeners.forEach((l) => l());
}
// When the developer last left the Mac and came back (eg after a nap), from PS. Asked for each time the
// screen time pop-up opens.
let presence: { lastOn: string | null; back: string | null } = { lastOn: null, back: null };
/** Which app was in front and when, plus the times away (PS, this Mac only, never in the vault). */
export type { Timeline } from "./core/stline";
let timeline: Timeline | null = null;
export function askTimeline(hours: number) { if (PS) psPost({ type: "timeline:get", hours }); }
// The Mac's line for the phone and the website (V1.31): only the Tab list may ask PS for it, and only
// the main page holds the keys, so the Tab list asks every 10 minutes and hands the line over (the
// "looks" path, like Fitness); the main page saves only the hours that changed (core/stline.ts).
let lineShared = 0;
function shareTimeline(tl: Timeline) {
  if (!overlayPage || Date.now() - lineShared < 9 * 60_000) return;
  lineShared = Date.now();
  psPost({ type: "looks", patch: { stLine: tl } });
}
function startLineShare() {
  const ask = () => { if (Date.now() - lineShared >= 9 * 60_000) psPost({ type: "timeline:get", hours: LINE_HOURS }); };
  window.setTimeout(ask, 20_000);
  window.setInterval(ask, 10 * 60_000);
}
export function useTimeline() {
  return useSyncExternalStore((l) => { iconListeners.add(l); return () => { iconListeners.delete(l); }; }, () => timeline);
}
export function askPresence() { if (PS) psPost({ type: "presence:get" }); }
export function usePresence() {
  return useSyncExternalStore((l) => { iconListeners.add(l); return () => { iconListeners.delete(l); }; }, () => presence);
}
export function useAppIcons(ids: string[]) {
  const want = ids.filter((id) => !isProtectedApp(id) && !appIcons[id] && !iconAsked.has(id));
  if (PS && want.length) { want.forEach((id) => iconAsked.add(id)); psPost({ type: "screentime:icons", ids: want }); }
  return useSyncExternalStore((l) => { iconListeners.add(l); return () => { iconListeners.delete(l); }; }, () => appIcons);
}

/** Screen time from PS: one day's totals per app on this Mac. Only names, bundle ids and seconds are kept. */
function saveScreenTimeMsg(m: { day: unknown; apps: unknown }) {
  const v = vaultStore.get();
  if (v.status !== "unlocked" || v.role !== "owner" || typeof m.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.day) || !Array.isArray(m.apps)) return;
  const apps = m.apps
    .filter((a) => a && typeof a.id === "string" && a.id && !isProtectedApp(a.id) && Number.isFinite(a.secs) && a.secs > 0)
    .slice(0, 300)
    .map((a) => ({ id: String(a.id).slice(0, 200), name: String(a.name || a.id).slice(0, 100), secs: Math.min(86400, Math.round(a.secs)) }));
  if (apps.length) void saveScreenTime(m.day, apps, "mac");
}
/** Ask PS for its latest totals now (the To-do card asks when it shows). */
export function askScreenTime() { if (PS) psPost({ type: "screentime:send" }); }

let bridged = false;
/** Main window only: mirror the to-do list to the overlay and take its ticks back. */
const bgShell = new Set<(m: Record<string, unknown>) => void>();
export function startPsBridge() {
  if (!PS || bridged) return;
  bridged = true;
  psPost({ type: "proton:get" });   // PS 1.65: the main window needs the status too (Settings)
  (window as W).__ps = {
    apply(m) {
      if (localKeyMessage(m as { type?: string })) return;   // local first: the Keychain's answer for the local vault key (src/core/localholders.ts)
      if (protonShellMessage(m as { type?: string })) return;   // PS 1.65 Proton Mail through Bridge (core/protonmail.ts)
      if (tgShellMessage(m as { type?: string })) return;   // Add Telegram Bot: Telegram's answers through PS, the Tab list's buttons (src/tgbot.ts)
      const bgType = (m as { type?: string }).type;   // The developer's vault videos (src/core/bgvault.ts)
      if (bgType === "bg:have" || bgType === "bg:piece") { bgShell.forEach((f) => f(m as unknown as Record<string, unknown>)); return; }
      if (replyMessage(m as { type?: string })) return;   // Reply from PS: the card's Reply, a send done (src/replyengine.ts)
      if (mailCardMessage(m as { type?: string })) return;   // client email cards (src/mailcards.ts)
      if (aiDoneMessage(m as { type?: string })) return;   // an AI chat on this Mac finished: its card (src/aidone.ts, V1.53)
      if (apiMessage(m as { type?: string })) return;   // the Task API: a checked request from PS on the Mac (src/taskapi.ts)
      if (notesCardMessage(m as { type?: string })) return;  // meeting notes card (src/notescard.ts)
      if (rebootWarnMessage(m as { type?: string })) return;   // the other Mac's auto reboot is close (src/rebootwarn.ts)
      if (privateAskMessage(m as { type?: string })) return;   // "Start private mode?" (src/meetwatch.ts)
      if (gymCardMessage(m as { type?: string })) return;   // the gym reminder card (src/gymwatch.ts)
      if (remShellMessage(m as { type?: string })) return;   // an Annoying 15 min reminder card answered (src/remwatch.ts)
      if (postureShellMessage(m as { type?: string })) return;   // the Posture reminder card: idle time, answered (src/posturewatch.ts)
      if (dirCardMessage(m as { type?: string })) return;  // G Squad: "X asked to join" card, Approve and Decline (src/squad/direngine.ts)
      if (chatCardMessage(m as { type?: string; id?: string; action?: string; text?: string })) return;  // G Squad chat: the history vote card's Yes and No (src/squad/chatengine.ts)
      if (islandMessage(m as { type?: string })) return;   // a tick on the Dynamic Island (src/island.ts)
      if (secondOn && secondMessage(m as unknown as { type?: string })) return;   // Second Computer (src/second/store.ts), only while switched on, see sayOwner
      if (m.type === "sync") rewindActive();   // Tab held: active on this Mac now (Rewind, src/rewind.ts)
      if (m.type === "mic") setMic(m);
      // A tick from the Tab list says which way since V1.34 (a repeat is harmless); the Dynamic Island still toggles.
      else if (m.type === "tick") void (typeof m.done === "boolean" ? setTodoDone(m.id, m.done) : toggleTodo(m.id));
      else if (m.type === "work") void setWorkingOn(m.id);
      else if (m.type === "reorder" && Array.isArray(m.ids)) {
        const p1 = m.p1 && typeof m.p1 === "object" && typeof (m.p1 as { id?: unknown }).id === "string" ? { id: (m.p1 as { id: string }).id, on: (m.p1 as { on?: unknown }).on === true } : undefined;
        void setTodoOrder(m.ids.filter((x) => typeof x === "string"), p1);
      }
      else if (m.type === "p1Style" && typeof m.id === "string") void saveSettings({ tmP1Style: p1Design(m.id) });
      else if (m.type === "looks" && m.patch && typeof m.patch === "object") {
        const patch = m.patch as Record<string, unknown>;
        // Follow-up Radar (Tab list): the developer's handled / snoozed marks, and a draft request (Rule Zero: a draft only).
        if (patch.radar && typeof patch.radar === "object") void saveSettings({ radar: tidyRadarState(patch.radar as RadarState) });
        if (patch.radarDraft && typeof patch.radarDraft === "object") {
          const d = patch.radarDraft as Record<string, unknown>;
          void saveDraft(radarDraft({ clientId: typeof d.clientId === "string" ? d.clientId : null, email: typeof d.to === "string" ? d.to.slice(0, 200) : null,
            subject: typeof d.subject === "string" ? d.subject.slice(0, 200) : null }));
        }
        // Tab list sections and task groups (core/groups.ts): tasks moved, or a group taken apart.
        if (patch.taskMove && typeof patch.taskMove === "object") {
          const t = patch.taskMove as Record<string, unknown>;
          const m = cleanTaskMove(t);
          const g = t.make && typeof t.make === "object" ? t.make as { group?: unknown; order?: unknown; page?: unknown; pageName?: unknown; pageOrder?: unknown } : null;
          const group = g ? cleanGroups([g.group])[0] : undefined;
          const id = (v: unknown) => (typeof v === "string" && /^[a-z0-9]{4,24}$/.test(v) ? v : undefined);
          // V1.55: the list it was made on, or a new list made with it (core/lists.ts).
          const page = id(g?.page), pageName = tidyName(g?.pageName, LIST_NAME_MAX) || undefined;
          const pageOrder = cleanPagesLooks({ tmPageOrder: g?.pageOrder }).tmPageOrder;
          if (m) void moveTasks(m, group ? { group, order: cleanSecOrder(g!.order), page, pageName, pageOrder } : undefined);
        }
        if (typeof patch.ungroup === "string") void ungroupTasks(patch.ungroup);
        // The Completed section and the right click menu (core/completed.ts): Resurrect, Clear, their Undo, a deleted task put back.
        { const o = cleanTodoOp(patch.todoOp); if (o) void runTodoOp(o); }
        // Mac settings > Gmail replies: Always notify me, Mute, take off a list, or link a sender to a client.
        if (patch.replySetup === true) openReplySetup();   // Settings, Reply from PS: the panel with no email in it
        // The Tab list's email panel (core/overlaymail.ts, 10 Nov 2026): Reply opens the panel with that email loaded
        // (never sends), and a lead reply's Done dismisses it on every device, as the card's Dismiss does.
        { const id = cleanReplyCardId(patch.replyOpen); if (id) openReplyFor(id); }
        // V1.59 Reply in the email panel (core/inlinereply.ts): the Tab list's reply box, after its Undo ran out. Built
        // and sent on its way here; the Tab list sees how it went through the vault ("Replied" or "Not sent").
        { const r = cleanInlineSend(patch.replyInline); if (r) void sendInlineOrSay(r.cardId, r.text, r.id, "mac").catch(() => psPost({ type: "log", text: "reply: a reply from the email panel was not sent" })); }
        { const id = cleanReplyCardId(patch.leadDone); if (id && id.startsWith("n:")) mailCardMessage({ type: "cardAction", id, action: "dismiss" }); }
        { const o = cleanWaOp(patch.waOp); if (o) void runWaOp(o).catch(() => psPost({ type: "log", text: "whatsapp: a reply from the panel was not sent" })); }   // WhatsApp (core/waops.ts): Send after its Undo, a template, Done
        { const o = cleanReplyPatch(patch.mailReplyOp); if (o) void runMailReplyOp(o).catch(() => psPost({ type: "log", text: "reply: a signature or response change failed to save" })); }   // Reply from PS (src/replyengine.ts)
        { const o = cleanMailRuleOp(patch.mailRuleOp); if (o) void (o.clientId ? addMatchAddr(o.clientId, o.entry) : setMailRule(o.entry, o.list)).catch(() => {}); }
        // Do Not Disturb (core/dnd.ts): the moon top right of the Tab list.
        { const o = cleanDndOp(patch.dndOp); if (o) void setDnd(o); }
        if (patch.examplesOp === "delete") void deleteExamples(); else if (patch.examplesOp === "undo") void undoExamples();   // example tasks (core/examples.ts)
        // Second Computer (src/second/store.ts): the panel's buttons in the Tab list.
        { const o = cleanSecondOp(patch.secondOp); if (o) runSecondOp(o); }
        // Local first (src/localops.ts): Turn on sync, the reminder's Not now, Export and Import from the Tab list.
        if (patch.localOp && typeof patch.localOp === "object") void localOp(patch.localOp as Record<string, unknown>);
        // The series map (views/SeriesMap.tsx, the Map pill): a note or a month title.
        { const o = cleanJournalOp(patch.journalOp); if (o) void setJournal(o.key, o.patch); }
        // The rule book (views/RuleBook.tsx): the developer's whole list, in his order.
        if (Array.isArray(patch.rules)) void saveSettings({ rules: cleanRules(patch.rules) });
        // The Meetings panel: a meeting taken off it or put back (applied to the newest copy), and its refresh button.
        { const o = cleanMeetHideOp(patch.meetHideOp); if (o) void saveSettings({ meetHidden: applyMeetHide(settingsData(vaultStore.get()).meetHidden, o) }); }
        if (patch.calRefresh === true) void calRefreshNow(true);   // pressed: straight to Google
        // The Calendar switch (core/localcal.ts): on saves the choice, then reads and may ask macOS once; off never reads
        // again, stops PS watching the Calendar app, and keeps no old meeting on screen.
        if (patch.calendarOn === true) void saveSettings({ macCalendar: true }).then(() => calRefreshNow(true, true));
        else if (patch.calendarOn === false) {
          void saveSettings({ macCalendar: false });
          psPost({ type: "localCal", op: "off" });
          if (!vaultStore.get().red) void saveLocalCalendar(CAL_OFF_SNAP(new Date().toISOString()));
          calStatus.set({ connected: null, checkedAt: null, error: null, busy: false, doneAt: Date.now() });
        }
        if (typeof patch.calLink === "string" && patch.calLink.length <= 600) void calLinkNow(patch.calLink, okFeedId(patch.calFeed) ? patch.calFeed : undefined);   // the answer goes back in the state's cal (a panel's own calendar: it arrives as its copy)
        // Cincee Campaigns in the Tab list: read the live numbers now (they go back with the overlay's state).
        if (CAMPAIGNS_ON && patch.campLive === true) void refreshCampaignsLive(true);
        // The gym reminder acknowledged from the Tab list (Fitness).
        if (typeof patch.gymAck === "string") ackGymDay(patch.gymAck);
        // Fitness in the Tab list: a program, workout or Fitness setting saved, and the rest timer's card.
        if (patch.fitOp) void runFitOp(patch.fitOp).catch(() => psPost({ type: "log", text: "fitness: a save from the Tab list failed" }));
        if (patch.fitCard) fitCard(patch.fitCard);
        // Pomodoro in the Tab list (V1.58, src/pomodoro.ts): Start, Pause, Resume, Skip, Stop, on the newest run and the time now.
        { const op = cleanOp(patch.pomoOp); if (op) void runPomoOp(op).catch(() => psPost({ type: "log", text: "pomodoro: a button from the Tab list failed to save" })); }
        // Time spent (PS 1.65, core/timesave.ts): Start and Stop on a task, from its menu or Edit in the Tab list.
        { const o = cleanTimeOp(patch.timeOp); if (o) void runTimeOp(o); }
        if (patch.standTest === true) islandStandTest();   // Settings, Stand-up reminders, Try it now (src/island.ts)
        // The Time zones screen in the Tab list: a person added, renamed, moved or taken off.
        if (patch.tzZonesOp) void runTzZonesOp(patch.tzZonesOp).catch(() => psPost({ type: "log", text: "time zones: a list change from the Tab list failed" }));
        // Edit mode in the Tab list: panels moved, removed or brought back (one small record).
        if (patch.layoutOp) void runLayoutOp(patch.layoutOp).catch(() => psPost({ type: "log", text: "edit mode: a save from the Tab list failed" }));
        // V1.56 Edit mode's phone layout editor: one phone kind's layout (one small record).
        if (patch.phoneLayoutOp) void runPhoneLayoutOp(patch.phoneLayoutOp).catch(() => psPost({ type: "log", text: "phone layout: a save from the Tab list failed" }));
        // Settings > Annoying 15 min reminder in the Tab list: the list changed (one small record).
        if (patch.remindOp) void runRemindOp(patch.remindOp).catch(() => psPost({ type: "log", text: "reminders: a save from the Tab list failed" }));
        // Backgrounds per device (core/devicebg.ts, PS 1.65): a device renamed in Settings, Looks in the Tab list.
        if (patch.bgDevRename && typeof patch.bgDevRename === "object") { const r = patch.bgDevRename as { dev?: unknown; name?: unknown }; if (typeof r.dev === "string") void renameDevice(r.dev, cleanDevName(r.name)).catch(() => {}); }
        if (patch.tzOp) void runTzOp(patch.tzOp).catch(() => psPost({ type: "log", text: "time zones: a save from the Tab list failed" }));
        // The screen time line from the Tab list (shareTimeline): checked again, then saved by the hour.
        if (patch.stLine) { const tl = cleanTimeline(patch.stLine); if (tl && vaultStore.get().status === "unlocked" && vaultStore.get().role === "owner") void saveScreenLine("mac", tl); }
        // G Squad (V1.40, src/squad/engine.ts): the button, the pop-up and the task menu in the Tab list.
        { const o = cleanSquadOp(patch.squadOp); if (o) void runSquadOp(o); }
        // G Squad Leaderboard: what you made in a month, your time zone (src/squad/board.ts checks it again).
        if (patch.boardOp) void runBoardOp(patch.boardOp).catch(() => psPost({ type: "log", text: "gsquad: a money answer from the Tab list failed to save" }));
        // G Squad chat (V1.40, src/squad/chatengine.ts): send, edit, delete, vote, open, sound.
        { const c = cleanChatOp(patch.sqChatOp); if (c) void runChatOp(c); }
        // G Squad members list (PS 1.64, src/squad/presence.ts): the Tab list's Fitness screen opened or closed ("At the gym").
        if (typeof patch.sqGym === "boolean") setGymScreen(patch.sqGym);
        // G Squad Fitness (V1.40, src/squad/gym.ts): the Squad screen in Fitness, compare, reactions, challenges.
        { const o = cleanGymOp(patch.gymOp); if (o) void runGymOp(o); }
        // The Soundboard's G Squad sharing (V1.47, src/squad/sbshare.ts): list, share, save, take off.
        { const o = cleanSbOp(patch.sbOp); if (o) void runSbOp(o); }
        // V1.57 Link your phone in the Tab list (core/pairmac.ts): this window has the keys, so it runs the pairing.
        { const o = cleanPairOp(patch.pairOp); if (o) runPairOp(o); }
        // Fitness's Sync button in the Tab list (V1.29): send what is waiting and pull now.
        if (patch.fitSync === true) void sync();
        const looks = cleanLooks(patch);
        if (Object.keys(looks).length) void saveSettings(looks);
      }
      else if (m.type === "tmScale" && Number.isFinite(m.v)) void saveSettings({ tmScale: Math.max(50, Math.min(130, Math.round(m.v))) });
      else if (m.type === "tmClockScale" && Number.isFinite(m.v)) void saveSettings({ tmClockScale: Math.max(60, Math.min(160, Math.round(m.v))) });
      else if (m.type === "update" && typeof m.id === "string" && m.patch && typeof m.patch === "object" && "subOp" in m.patch) {
        // a mini task change (add, tick, rename, remove, restore, order), applied to the newest copy
        const op = cleanSubOp((m.patch as { subOp?: unknown }).subOp);
        if (op) void subtaskOp(m.id, op);
      }
      else if (m.type === "update" && typeof m.id === "string") void updateTodo(m.id, cleanPatch(m.patch));
      else if (m.type === "remove" && typeof m.id === "string") void deleteTodo(m.id);
      else if (m.type === "meetingNotes") {
        const cutoff = Date.now() - 2 * 86400_000;
        const patch: { meetingNotes?: unknown; standingNotes?: unknown } = {};
        if (Array.isArray(m.list)) patch.meetingNotes = m.list
          .filter((n) => n && typeof n.key === "string" && typeof n.start === "string" && Date.parse(n.start) > cutoff && Array.isArray(n.items))
          .slice(0, 100)
          .map((n) => ({ key: n.key.slice(0, 300), title: String(n.title || "").slice(0, 200), start: n.start,
            items: n.items.filter((i) => i && typeof i.text === "string").slice(0, 50).map((i) => ({ id: String(i.id), text: i.text.slice(0, 300), done: !!i.done })),
            doneStanding: Array.isArray(n.doneStanding) ? n.doneStanding.filter((x) => typeof x === "string").slice(0, 50) : [] }))
          .filter((n) => n.items.length > 0 || n.doneStanding.length > 0);
        if (Array.isArray(m.standing)) patch.standingNotes = m.standing
          .filter((n) => n && typeof n.title === "string" && Array.isArray(n.items))
          .slice(0, 100)
          .map((n) => ({ title: n.title.trim().toLowerCase().slice(0, 200), items: n.items.filter((i) => i && typeof i.text === "string").slice(0, 50).map((i) => ({ id: String(i.id), text: i.text.slice(0, 300) })) }))
          .filter((n) => n.items.length > 0);
        if (patch.meetingNotes || patch.standingNotes) void saveSettings(patch as Partial<Settings>);
      }
      else if (m.type === "timelineHidden" && Array.isArray(m.ids)) void saveSettings({ timelineHidden: m.ids.filter((x) => typeof x === "string").slice(0, 50) });
      else if (m.type === "timelineOrder" && Array.isArray(m.ids)) void saveSettings({ timelineOrder: m.ids.filter((x) => typeof x === "string").slice(0, 100) });
      else if (m.type === "timelines" && Array.isArray(m.list)) {
        // V1.43: the kind, the time and the yearly repeat come through too (core/timelines.ts checks every field).
        void saveSettings({ timelines: cleanTimelines(m.list) });
      }
      else if (m.type === "homeTz") void saveSettings({ tmHomeTz: typeof m.id === "string" && validTz(m.id) ? m.id : null });
      else if (m.type === "headline" && typeof m.text === "string" && m.text.trim()) void saveSettings({ tmHeadline: m.text.trim().slice(0, 120) });
      else if (m.type === "sound") {
        const p: { tmSound?: number; tmMuted?: boolean } = {};
        if (Number.isFinite(m.tmSound)) p.tmSound = Math.max(0, Math.min(100, Math.round(m.tmSound as number)));
        if (typeof m.tmMuted === "boolean") p.tmMuted = m.tmMuted;
        void saveSettings(p);
      }
      else if (m.type === "add" && typeof m.title === "string" && m.title.trim()) {
        const due = typeof m.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.due) ? m.due : null;
        const repeat = m.kind === "daily" ? cleanRepeat(m.repeat, due || todayISO()) : null;
        void addTodo({ title: m.title.trim().slice(0, 500), type: m.kind === "daily" ? "daily" : "once", due: m.kind === "daily" && !repeat ? null : due, repeat,
          ...(m.p1 === true && m.kind !== "daily" ? { p1: true } : {}),
          ...(m.unranked === true && m.kind !== "daily" && m.p1 !== true ? { unranked: true } : {}),
          ...(typeof m.clientId === "string" && m.clientId ? { clientId: m.clientId.slice(0, 64) } : {}),
          ...(typeof m.notes === "string" && m.notes.trim() ? { notes: m.notes.trim().slice(0, 2000) } : {}),
          ...(typeof m.order === "number" && Number.isFinite(m.order) ? { order: m.order } : {}),
          // G Squad: Share with G Squad (V1.43: off unless picked), and the answer to "Anonymise this task?"
          // (core/squadanon.ts), from the Add task box.
          ...(m.sqOn === true ? { sqOn: true } : {}), ...(typeof m.sqAnon === "boolean" ? { sqAnon: m.sqAnon } : {}),
          // V1.55: typed while one of the developer's own lists showed: into that list's task group (core/lists.ts addGroupFor).
          ...(typeof m.group === "string" && /^[a-z0-9]{4,24}$/.test(m.group) ? { group: m.group } : {}) })
          // PS 1.65: a time typed in plain words becomes a reminder on the new task (core/nlremind.ts).
          .then((id) => { const r = cleanTimeRemind(m.remind); if (r && typeof id === "string") void addTimeReminder(id, r); }).catch(() => {});
      }
      else if (m.type === "aware" && Array.isArray(m.list)) {
        void saveSettings({ aware: m.list.filter((a) => a && typeof a.id === "string" && typeof a.text === "string")
          .slice(0, 50).map((a) => ({ id: a.id, text: a.text.slice(0, 300), createdAt: String(a.createdAt || new Date().toISOString()) })) });
      }
      else if (m.type === "suggest" && typeof m.id === "string") {
        const pl = m.place && Number.isFinite(m.place.order) ? { type: m.place.type === "daily" ? "daily" as const : "once" as const, order: m.place.order as number, p1: m.place.p1 === true } : undefined;
        if (m.action === "dimx") { if (m.zone === "act" || m.zone === "soon" || m.zone === "x") void suggestionToDimx(m.id, m.zone); }
        else void (m.action === "add" ? approveSuggestion(m.id, pl) : m.action === "aware" ? suggestionToAware(m.id) : m.action === "dismiss" ? dismissSuggestion(m.id) : undefined);
      }
      else if (m.type === "inboxMin" && typeof m.at === "string") {
        // New tasks pop-up minimized: a real date, never later than now.
        const at = Date.parse(m.at);
        if (Number.isFinite(at)) void saveSettings({ tmInboxMinAt: new Date(Math.min(at, Date.now() + 60_000)).toISOString() });
      }
      else if (m.type === "dimxList" && Array.isArray(m.list)) void saveSettings({ dimx: cleanDimx(m.list) });
      // Urgent: ticked (its finished task gets the id the list picked, so Undo can find it), Undo, dragged onto the list.
      else if (m.type === "awareDone" && typeof m.id === "string" && UUID.test(String(m.todoId))) void awareDone(m.id, m.todoId);
      else if (m.type === "awareUndone" && UUID.test(String(m.todoId)) && m.item && typeof m.item === "object") {
        const it = m.item as Record<string, unknown>;
        if (typeof it.id === "string" && typeof it.text === "string" && it.text.trim())
          void awareUndone({ id: it.id.slice(0, 64), text: it.text.slice(0, 300), createdAt: typeof it.createdAt === "string" ? it.createdAt : new Date().toISOString() },
            Math.max(0, Math.min(50, Math.round(Number(m.index) || 0))), m.todoId);
      }
      else if (m.type === "awareToList" && typeof m.id === "string" && Number.isFinite(m.order)) void awareToList(m.id, m.order, m.kind === "daily" ? "daily" : "once", m.p1 === true);
      else if (m.type === "afkDone" && Array.isArray(m.list)) {
        // AFK timer (Sources/Afk.swift): each break joins the screen time timeline as a named break, "AFK".
        // s: last input before it, e: the "Back in the game" click, r: the first input after it started (the developer back at the Mac).
        const add = (m.list as { s?: unknown; e?: unknown; r?: unknown }[]).filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && (x.e as number) >= (x.s as number))
          .slice(0, 50).map((x) => ({ s: Math.round(x.s as number), e: Math.round(x.e as number), reason: "AFK",
            ...(Number.isFinite(x.r) && (x.r as number) >= (x.s as number) ? { back: Math.round(x.r as number) } : {}) }));
        const log = settingsData(vaultStore.get()).awayLog || [];
        if (add.length) void saveSettings({ awayLog: [...log, ...add.filter((a) => !log.some((l) => l.s === a.s && l.e === a.e))].slice(-500) });
      }
      else if (m.type === "awayPatch") {
        const p: Partial<Settings> = {};
        if (Array.isArray(m.awayReasons)) p.awayReasons = m.awayReasons.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 40)).slice(0, 30);
        if (Array.isArray(m.awayLog)) p.awayLog = (m.awayLog as { s?: unknown; e?: unknown; reason?: unknown; back?: unknown }[])
          .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && typeof x.reason === "string")
          .map((x) => ({ s: Math.round(x.s as number), e: Math.round(x.e as number), reason: (x.reason as string).trim().slice(0, 40),
            ...(Number.isFinite(x.back) ? { back: Math.round(x.back as number) } : {}) })).slice(-500);
        void saveSettings(p);
      }
      else if (m.type === "goals" && Array.isArray(m.list)) void saveSettings({ goals: cleanGoals(m.list) });
      else if (m.type === "meetPrefs" && m.prefs && typeof m.prefs === "object") {
        const b = (k: string, d: boolean) => (typeof m.prefs[k] === "boolean" ? (m.prefs[k] as boolean) : d);
        void saveSettings({ meetAlerts: { booked: b("booked", true), msg: b("msg", true), soon: b("soon", true), privacy: b("privacy", true), sBooked: b("sBooked", true), sMsg: b("sMsg", true), sSoon: b("sSoon", true),
          notes: b("notes", true), notesBlur: b("notesBlur", true),
          notesAfter: [1, 2, 3, 5, 10, 15].includes(m.prefs.notesAfter as number) ? (m.prefs.notesAfter as number) : 5,
          notesSnooze: Array.isArray(m.prefs.notesSnooze) ? [...new Set((m.prefs.notesSnooze as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) >= 5 && (x as number) <= 60))].sort((a, b) => a - b).slice(0, 12) : [5, 10, 15, 20, 25, 30, 40, 45, 50, 60] } });
      }
      else if (m.type === "backdrop" && Number.isFinite(m.v)) void saveSettings({ tmBackdrop: Math.max(0, Math.min(100, Math.round(m.v))) });
      else if (m.type === "stHours" && Number.isFinite(m.v)) void saveSettings({ tmStHours: Math.max(1, Math.min(24, Math.round(m.v))) });
      else if (m.type === "workStyle") void saveSettings({ tmWorkStyle: workStyle(m.style) });
      else if (m.type === "reset") void resetTodos().then((u) => { psResetUndo = u; });
      else if (m.type === "resetUndo") { const u = psResetUndo; psResetUndo = null; void u?.(); }
      else if (m.type === "notifyPref") void saveSettings({ tmNotify: m.on !== false });
      else if (m.type === "screentime") saveScreenTimeMsg(m);
      else if (m.type === "sync") { void sync(); void refreshGmail(); calRefreshIfStale(); }   // Tab held: the latest, Gmail included, the calendar when over a minute old (never asks macOS: only the Calendar switch does)
      else if (m.type === "localCal") {
        // This Mac's Calendar (ps-mac LocalCalendar.swift), any account but the developer's: into that person's own vault
        // (written only when an event changed) and the Meetings panel's status line.
        const st = vaultStore.get();
        if (st.status === "unlocked" && !st.red && settingsData(st).macCalendar !== false) {   // the Calendar switch is off: nothing read is kept
          const cal = localSnap(m);
          if (cal) {
            void saveLocalCalendar(cal);
            // A choice for a calendar that has been gone for a long time is dropped, and one still here is marked seen (core/calpick.ts).
            const cur = settingsData(st).calChoices, tidy = tidyChoices(cur, cal.cals ?? []);
            if (!sameChoices(cur, tidy)) void saveSettings({ calChoices: tidy });
          }
          calStatus.set(localStatusPatch(m, Date.now()));
        }
      }
      else if (m.type === "pull") nudge();                                  // PS's own 20 s nudge (the page may be throttled); paced in vault.ts
      else if (m.type === "wake") { reconnect(); gymWake(); remWake(); boardWake(); calRefreshIfStale(); }   // the Mac woke: a fresh Realtime socket and a sync; the gym card looks again; the calendar when over a minute old
      else if (m.type === "replyHandled" && typeof m.id === "string") void setReplyHandled(m.id, true);
      else if (m.type === "tap") { tapOn = !!m.on; retrack(); }
      else if (m.type === "psSettings") { const hadRem = !!psSettings; psSettings = m.data; { const hn = cleanDevName((m.data as { hostName?: unknown })?.hostName); if (hn) setDeviceNameHint(hn); } settingsListeners.forEach((l) => l()); remWake(!hadRem); rewindAys((m.data as { ays?: { today?: unknown } })?.ays?.today); }   // Rewind: today's Are you sure count (src/rewind.ts)
      else if (m.type === "tab") { tabState = { enabled: m.enabled, trusted: m.trusted }; tapOn = !!m.on; retrack(); settingsListeners.forEach((l) => l()); }
      else if (m.type === "rememberStatus") { remembered = m.exists; touchLocked = m.locked === true; setPsKeepOpen(m.exists); settingsListeners.forEach((l) => l()); }
      else if (m.type === "touchid") { touchMissed = Date.now(); settingsListeners.forEach((l) => l()); }
      else if (m.type === "lock") lock();
      else if (m.type === "remember") {
        // Keys from the macOS Keychain, in memory only. Wrong ones (passphrase changed on the
        // website) make PS forget them so the normal sign-in shows.
        void unlockRemembered(m.username, m.auth, m.kek).then(() => psPost({ type: "log", text: "remembered sign in: ok" })).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : "";
          psPost({ type: "log", text: `remembered sign in failed: ${msg.slice(0, 120)}` });
          if (/wrong username or passphrase|no vault keys/i.test(msg)) psPost({ type: "remember:forget" });
        });
      }
    },
  };
  let t: number | undefined;
  let last = "";
  const send = () => {
    const s = vaultStore.get();
    // What the Tab overlay shows: tasks, settings (working on), clients and the latest calendar
    // snapshot (for the "Next 24 hours" meetings panel).
    const cal = s.status === "unlocked" ? calendarSnap(s) : null;
    // Plus the last week of screen time for the Tab list's screen time button.
    const week = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
    // And client emails not dealt with yet (headers and Gmail's snippet only) for "Client emails".
    const docs = s.status === "unlocked" ? [...s.docs.values()].filter((d) => d.kind === "todo" || d.kind === "settings" || d.kind === "client"
      || (d.kind === "reply" && !(d.data as Reply).handled)
      || (d.kind === "screentime" && String((d.data as { day?: string }).day || "") >= week)
      || d.kind === "msender"   // Mac settings > Gmail replies, "Who emails me" (sender, account, time, subject; never a body)
      || d.kind === "tzperson"  // the Time zones screen's people (a name and a zone each)
      || d.kind === "tzzones"   // the Time zones screen's list of clocks (zone ids and names)
      || d.kind === "rcpt"      // Purchases (PS 1.65): the receipts, with the id of a photo but never the photo (a separate sealed file the Tab list cannot open)
      || d.kind === "tablayout" // Edit mode: where the Tab list's panels sit and which are removed
      || d.kind === "phonelayout" || d.kind === "phonedev" || d.kind === "bgdev"   // V1.56 the phone layout editor: each phone's layout, and which phones you have
      || d.kind === "remind"    // Settings > Annoying 15 min reminder: the reminders and their answers (a few KB)
      || d.kind === "ttime"     // Time spent (PS 1.65, core/timeest.ts): the clocks and each month's finished times, for Edit's past times and the overload line (a few KB)
      || (d.kind === "stline" && Number((d.data as { hour?: number }).hour) > Date.now() - 25 * 3600_000)) : [];
    if (cal) docs.push(cal);
    // V1.59 Reply in the email panel (core/inlinereply.ts): how each reply went ("Replied", "Not sent"), never its words.
    if (s.status === "unlocked") for (const d of s.docs.values()) if (d.kind === "rout") { const { job: _j, ...rest } = d.data as { job?: unknown }; docs.push({ ...d, data: rest }); }
    // And the newest morning brief, for the Tab list's brief window (the sun button).
    const brief = s.status === "unlocked" ? latestBrief(s) : null;
    if (brief) docs.push(brief);
    // And the newest campaign statistics (the Tab list's Campaign stats panel).
    const cst = CAMPAIGNS_ON && s.status === "unlocked" ? campaignStats(s) : null;
    if (cst) docs.push(cst);
    // The developer's private release notes, newest few versions (the What's new panel and the update card's "For you").
    if (s.status === "unlocked" && s.red) docs.push(...recentPrivate(s.docs.values()));
    // Second Computer records (small: notes, file and job records, statuses; never file contents).
    if (s.status === "unlocked") for (const d of s.docs.values()) if (SECOND_KINDS.has(d.kind) || FIT_KINDS.has(d.kind)) docs.push(d);
    // (The Follow-up Radar's FUP button left the Tab list on 30 Oct 2026, the developer: "easier just using Claude".)
    const unlocked = s.status === "unlocked";
    // And the Cincee Campaigns live numbers (in memory only, asked for by the panel), while unlocked as the developer.
    const clive = CAMPAIGNS_ON && unlocked && s.red ? liveForMirror() : null;
    // And the G Squad view (names, working, shared tasks, already opened here; never a key) for the button and pop-up.
    const squad = unlocked ? squadView() : null;
    // And the G Squad chat's plain view (lines only while the chat is open, so the state stays small otherwise).
    const sqchat = unlocked ? chatView() : null;
    const gym = unlocked ? gymView() : null;   // G Squad Fitness: the cards others share, opened here (never a key)
    const sbsq = unlocked ? sbShareView() : null;   // the Soundboard's shared sounds (names and sizes, never a key)
    // Local first (V1.44): the Tab list's one line warning, its reminder card and the last export or import result.
    const local = unlocked ? s.local : null, lf = unlocked && !s.red ? localMirrorOut() : null;
    // And the open lead replies (a few rows, no feed) for the email panel's Reply (core/overlaymail.ts), the developer only.
    const leads = unlocked && mailOnSnap(s) ? leadRows(leadCards(irepFeed(s), settingsData(s).leadCards)) : null;
    // And Link your phone's pairing (core/pairmac.ts): its phase, the six digit code and the QR's public offer part.
    const pair = unlocked ? pairForMirror() : null;
    const json = JSON.stringify({ type: "state", unlocked, red: unlocked && s.red, primary: unlocked && s.primary, lastSync: s.lastSync, docs, second: secondLocal(), clive, cal: calStatus.get(), squad, sqchat, gym, sbsq, local, lf, leads, pair });
    if (json !== last) { last = json; psPost({ type: "state", unlocked, payload: json }); }
  };
  // At most 120 ms after the first change (not after the last one), so a busy vault (sync, screen
  // time) can never keep pushing the overlay's copy back.
  const later = () => { if (t === undefined) t = window.setTimeout(() => { t = undefined; send(); }, 120); };
  vaultStore.subscribe(later);
  secondStore.subscribe(later);
  liveStore.subscribe(later);
  calStatus.subscribe(later);   // the calendar read's status for the Meetings panel (a few dozen bytes more)
  squadStore.subscribe(later);  // G Squad: working count, members, shared tasks (src/squad/engine.ts)
  chatStore.subscribe(later);   // G Squad chat: unread count, votes, and the lines while open (src/squad/chatengine.ts)
  gymStore.subscribe(later);    // G Squad Fitness (src/squad/gym.ts)
  sbShareStore.subscribe(later);   // the Soundboard's shared sounds (src/squad/sbshare.ts)
  localSubscribe(later);        // local first: the last export or import note (src/localfirst.ts)
  mainPair().subscribe(later);  // Link your phone's pairing, run here for the Tab list (core/pairmac.ts)
  send();
  // One line in PS's log per inbox package handled: where from and how long it waited, never what it says.
  setPkgLog((source, at) => {
    const waited = at ? Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)) : -1;
    psPost({ type: "log", text: `inbox: ${source.replace(/[^a-z0-9-]/gi, "").slice(0, 20)} package handled, waited ${waited}s` });
  });
  // Who unlocked, for the shell's own developer-only parts (ps-mac Sources/Owner.swift): said after every
  // unlock and whenever it changes; nothing while locked (Sign out of this Mac clears it there).
  let ownerSaid: boolean | null = null, secondOn = false;
  const sayOwner = () => {
    const s = vaultStore.get();
    if (s.status !== "unlocked") { ownerSaid = null; return; }
    const red = bgAllowed(s);
    if (red !== ownerSaid) { ownerSaid = red; psPost({ type: "owner", red }); }
    // Second Computer (PS 1.65: everyone's, behind its switch, core/secondswitch.ts; the developer's alone V1.42 to V1.64): it
    // starts once the account is unlocked and the switch is on, after the feature answers, so PS has started its own half
    // first (Second.setOn); switched off, both halves stop.
    const second = secondOnSnap(s);
    if (second && !secondOn) { secondOn = true; startSecond(psPost); }
    else if (!second && secondOn) { secondOn = false; stopSecond(); }
  };
  vaultStore.subscribe(sayOwner);
  sayOwner();
  // The developer's own background videos come from his vault onto this Mac (src/core/bgvault.ts).
  startBgVault({ post: psPost, listen: (f) => { bgShell.add(f); } });
  startMailCards(psPost);   // client email cards that stay until dismissed (src/mailcards.ts)
  startReplyEngine(psPost, () => psSettingsNow()?.mailSend ?? null);   // Reply from PS: the compose window's email, signatures and responses (src/replyengine.ts)
  startNotesCard(psPost);   // meeting notes pop-up, top left (src/notescard.ts)
  startMeetAlerts(psPost);   // meeting alert cards (src/meetwatch.ts)
  startGymWatch(psPost);   // the gym reminder card (src/gymwatch.ts, core/gym.ts)
  // The Annoying 15 min reminders (src/remwatch.ts, core/remind.ts): the plan for the Mac's cards.
  startRemWatch(psPost);
  startPostureWatch(psPost);   // the Posture reminder (src/posturewatch.ts, core/posture.ts, PS 1.65)
  startChkWatch(psPost);   // the Checklist reminder's clock: DO YOUR CHECKLIST on the Mac's card (src/chkwatch.ts, core/chkremind.ts, PS 1.65)
  setLocalCalReader((ask) => psPost({ type: "localCal", op: "read", ask }));   // not the developer: this Mac's Calendar (src/calrefresh.ts)
  startCalRefresh();   // asks for the calendar every 2 minutes and on wake; the server reads Google every minute (src/calrefresh.ts)
  startIsland(psPost);   // the Dynamic Island under the notch (src/island.ts)
  startPomodoro(() => islandNow());   // Pomodoro (src/pomodoro.ts): each phase saved as it ends, the island told at once
  // Second Computer (src/second/store.ts): started and stopped by sayOwner above, by its switch.
  startRebootWarn(psPost);   // a card 10 min before the other Mac's auto reboot, with Postpone (src/rebootwarn.ts)
  startNoteLook(psPost);   // notification card colours and the Other alerts sound to the Mac (src/notelook.ts, core/notelook.ts)
  startSentryPrefs(psPost);   // Sentry mode's restart if not unlocked to the Mac, for the restart helper pop up (src/sentryprefs.ts, V1.49)
  startDnd(psPost, "mac");   // Do Not Disturb: what the native side mutes (src/dnd.ts, core/dnd.ts)
  startExamples(true);   // a brand new account starts with example tasks (src/examples.ts, core/examples.ts)
  startPsStatus(psPost);   // the "PS is active" pop-up: synced, next meeting (src/psstatus.ts, ps-mac Popup.swift)
  startSquad(psPost);   // G Squad (V1.40): working heartbeat, shared tasks, the pop-up's data, all with the hub (src/squad/engine.ts)
  startSquadBoard();   // G Squad Leaderboard and Screen time; last month's amount is added in the Leaderboard, nothing pops up (src/squad/board.ts)
  startChat(psPost);   // G Squad chat (V1.40): tick every 2 min, pulls while open, the history vote card (src/squad/chatengine.ts)
  startGymSquad();   // G Squad Fitness (V1.40): your Fitness and Sleep cards, the boards, compare (src/squad/gym.ts)
  startFeatureSync(psPost);   // V1.58: who is signed in and the From the squad switches for feature(), and the answers to the Mac (src/featuresync.ts)
  startTgBot();   // Add Telegram Bot (V1.47): reads this person's own bot while PS runs, only with a key in this Mac's Keychain (src/tgbot.ts)
  // Sign in once per Mac: the derived keys (never the passphrase) go to the macOS Keychain.
  setPsRememberHook((username, auth, kek) => {
    if (keepSignedIn) psPost({ type: "remember:save", username, auth, kek });
    else psPost({ type: "remember:forget" });
  });
  psPost({ type: "ready" });
}

// ---------- client emails: cards that stay until the developer dismisses them (src/mailcards.ts) ----------
export { firstSentences } from "./core/mail";   // moved to core (also used by the mail cards)

// ---------- "PS is open" (owner only) ----------
// While PS runs, is unlocked and its Tab watcher is on, it shows itself on a PRIVATE Realtime
// channel only the vault owner can join (migration 015). The website sees that and leaves Tab
// alone, so the two task overlays never show at once. No task data travels on this channel.
let chan: ReturnType<typeof sb.channel> | null = null;
let tapOn = false;
let psOpen = false;
const openListeners = new Set<() => void>();
function setPsOpen(v: boolean) { if (v !== psOpen) { psOpen = v; openListeners.forEach((l) => l()); } }

/** Website: true while PS is open on a Mac and handles Tab itself. */
export function psIsOpen() { return psOpen; }
export function usePsOpen() {
  return useSyncExternalStore((l) => { openListeners.add(l); return () => { openListeners.delete(l); }; }, () => psOpen);
}

function retrack() {
  if (!PS || !chan) return;
  if (tapOn) void chan.track({ app: "ps" }); else void chan.untrack();
}
// The developer keeps the shared "ps-presence" topic; every other owner has a private one of their own (migration 025),
// so nobody ever sees whether someone else's PS is open.
function presenceTopic(s: { red: boolean; userId: string | null }) {
  return s.red ? "ps-presence" : `ps-presence:${s.userId}`;
}
let chanTopic = "";
function joinPresence(topic: string) {
  chanTopic = topic;
  chan = sb.channel(topic, { config: { private: true, presence: { key: crypto.randomUUID() } } });
  const c = chan;
  c.on("presence", { event: "sync" }, () => {
    if (PS) return;
    const st = c.presenceState<{ app?: string }>();
    setPsOpen(Object.values(st).some((list) => list.some((p) => p.app === "ps")));
  }).subscribe((status) => { if (status === "SUBSCRIBED") retrack(); });
}
function leavePresence() {
  if (chan) void sb.removeChannel(chan);
  chan = null;
  setPsOpen(false);
}

let presenceStarted = false;
/** Main window (website or PS): join while the owner's vault is unlocked, leave on lock. */
export function startPsPresence() {
  if (presenceStarted) return;
  presenceStarted = true;
  const check = () => {
    const s = vaultStore.get();
    const want = s.status === "unlocked" && s.role === "owner" && s.userId !== "dev" && s.userId !== "ps-overlay" && !s.local   // local first: no server to tell
      && presenceOn(settingsData(s).psPresence);   // Settings, Privacy and sharing: "Tell the website PS app is open" (missing = on)
    const topic = want ? presenceTopic(s) : "";
    if (chan && (!want || topic !== chanTopic)) leavePresence();
    if (want && !chan) joinPresence(topic);
  };
  vaultStore.subscribe(check);
  check();
}

// ---------- PS settings (this Mac only, kept by the shell, never in the vault) ----------
/** Auto reboot for this Mac (ps-mac Sources/AutoReboot.swift; `status` is the root helper's own report). */
export interface RebootSettings {
  helper: "on" | "approve" | "off" | "missing" | "test"; mode: "off" | "watch" | "active";
  /** The timer length in minutes, 10 to 4320 (18 hours, 1080, unless the developer changes it; V1.28). */
  minutes: number; defaultMinutes: number;
  fileVault: "on" | "off" | "unknown"; passwordImmediately: boolean | null; model: string; error?: string;
  /** V1.28: the helper running now is from an older PS (Active and Postpone wait for this Mac's next restart). */
  helperOld?: boolean;
  /** V1.45 (ps-mac RebootHelperCore.swift): why a helper that ran here before is not running now. "update": macOS
   *  switched it off after an update; "settings": someone switched PS off in System Settings. */
  offBy?: "update" | "settings";
  /** V1.54 (ps-mac HelperCheckCore.swift): this Mac checks the helper fresh before Sentry mode (reboot:check), and the
   *  id of the last check it finished. */
  checks?: number; checked?: string;
  status?: {
    mode: "off" | "watch" | "active"; effectiveMode?: "off" | "watch" | "active"; activeAllowed?: boolean; bootTried?: boolean; safeMode?: boolean; watchOnlyBecause?: string | null;
    minutes: number; testOnce: boolean; session: "unlocked" | "locked" | "noUser";
    seenUnlock: boolean; counting: boolean; periodMinutes: number; deadline?: number; left?: number; wake?: number;
    bootedAt: number; configError: boolean; history: { at: number; kind: string; text: string }[]; log: string[];
    /** V1.28 (proto 2): seconds postponed so far, when the lock now running began (epoch s), whether the helper has its own
     *  record of a sign in this boot, and its last three lock periods, newest first. */
    proto?: number; postponed?: number; lockedAt?: number; signedIn?: boolean; periods?: import("./core/second").LockPeriod[];
  };
}
export interface PsSettings {
  reboot?: RebootSettings; error?: string;
  triggerKey?: "tab" | "rightOption"; screenTime?: boolean;
  /** Security, "Remind me to set up the restart helper" (ps-mac HelperAlert.swift, UserDefaults helperAlert.remind): on unless switched off. */
  helperRemind?: boolean;
  /** This Mac's own computer name (PS 1.65, for the device list in Settings, Looks). */
  hostName?: string;
  /** V1.47 Tab overlay shortcuts (core/openkeys.ts, ps-mac OpenKeysCore.swift): the list in use (custom false: the old
   *  settings as a list, never changed), what each key code types on this Mac's layout, and which combos (their place
   *  among the combos) another app already holds. */
  /** overProtected (V1.58, the Mac's BuildRules): false on the developer's account, where PS never opens over 1Password or
   *  Signal. Missing (an older Mac) means true. */
  shortcuts?: { custom: boolean; list: import("./core/openkeys").OpenShortcut[]; labels?: Record<string, string>; layout?: string; taken?: number[]; overProtected?: boolean };
  /** Hold / and press . (on by default), and what those two keys type on this Mac's keyboard layout. */
  slashChord?: boolean; slashKeys?: { slash: string; dot: string; layout: string }; ignoredApps?: { id: string; name: string }[]; runningApps?: { id: string; name: string }[];
  /** Tab keeps the list open (core/tabstays.ts): on now, and whether someone chose it on this Mac. */
  tabStays?: boolean; tabStaysChosen?: boolean;
  /** Mac settings > App name (V1.36, ps-mac AppRename.swift): the name now, a rename running, why the last one stopped. */
  appName?: { name: string; busy: boolean; max: number; canRename: boolean; error?: string };
  islandMoved?: boolean;   // the Dynamic Island was dragged off the top centre on this Mac (Island.swift, G Squad)
  /** V1.58: the island is away (its right click menu: Disappear for this meeting, or for a time) until this wall clock
   *  time (ms), or null. Island.swift; the island settings show it and bring it back ({type:"island:show"}). */
  islandAway?: { kind: "minutes" | "meeting"; until: number } | null;
  /** Reply from PS (ps-mac MailSend.swift): which Gmail accounts can send, whether an Instantly key is kept, how many
   *  sends are waiting. Never a token or the key itself. */
  mailSend?: MailSendStatus;
  /** Add Telegram Bot (V1.47, ps-mac TelegramBot.swift, src/tgbot.ts): a bot key kept in this Mac's Keychain (never the key
   *  itself), and what the main page's reader says. */
  tgBot?: { saved: boolean } & Partial<Omit<import("./tgbot").TgView, "saved">>;
  /** Settings, AI task API (ps-mac TaskApi.swift): on or off, listening or why not, the switches, the key's last 4
   *  characters (never the key), and the last request (when, which endpoint, its status). */
  taskApi?: { on: boolean; running: boolean; port: number; error?: string | null; scopes?: Record<string, boolean>; keyTail?: string | null;
    last?: { at: number; what: string; status: number } | null; count?: number };
}
export interface MailSendStatus {
  gmail: { account: string; connected: boolean; problem?: string }[];
  instantly: { saved: boolean; problem?: string };
  /** 1.65: Proton Mail Bridge linked on this Mac, and a problem code (core/protonmail.ts PROTON_PROBLEMS). */
  proton?: { linked: boolean; problem?: string | null };
  waiting: number;
}
let psSettings: PsSettings | null = null;
const settingsListeners = new Set<() => void>();
export function usePsSettings() {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }, () => psSettings);
}
/** V1.52: the Mac's settings now (null until they came), and a listener for changes outside React (Sleep mode's plan). */
export const psSettingsNow = (): PsSettings | null => psSettings;
export function onPsSettings(l: () => void): () => void { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }

// Tab over other apps (shell state) and "remembered on this Mac".
let tabState: { enabled: boolean; trusted: boolean } | null = null;
let remembered = false;
export function usePsTab() {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }, () => tabState);
}
export function usePsRemembered() {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }, () => remembered);
}

// "Remember me" (sign-in screen, ticked by default). Lock (27 Oct 2026): keys leave memory and PS
// opens again with Touch ID or the Mac password (ps-mac TouchLock.swift); "Sign out of this Mac"
// forgets this Mac (both Keychain items deleted, the passphrase next time).
let keepSignedIn = true;
let touchLocked = false;
let touchMissed = 0;
export function rememberChoice() { return keepSignedIn; }
export function setRememberChoice(v: boolean) { keepSignedIn = v; }
/** Locked with Touch ID: the locked screen offers "Unlock with Touch ID". */
export function usePsTouchLocked() {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }, () => touchLocked);
}
/** When Touch ID was last cancelled or failed (0: never), for a quiet hint. */
export function usePsTouchMissed() {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => { settingsListeners.delete(l); }; }, () => touchMissed);
}
/** PS Lock: wipe keys from memory; Touch ID (or the Mac password) opens PS again. */
export function psLock() {
  if (vaultStore.get().local) { lock(); return; }   // local first: no Keychain sign in to lock; Open on the sign in brings it back
  psPost({ type: "lock:mac" });
  lock();
}
/** Asks the Mac for Touch ID (or its password); the keys come back as a "remember" message. */
export function psTouchUnlock() { psPost({ type: "touchid:unlock" }); }
/** Sign out of this Mac: wipe keys from memory and forget this Mac, back to the passphrase. */
export function psSignOut() {
  psPost({ type: "signout" });
  lock();
}

// ---------- the Mac's default microphone (PS only) ----------
export type MicState = { current: string; devices: { uid: string; name: string }[] };
let mic: MicState | null = null;
const micListeners = new Set<() => void>();
function setMic(m: MicState) {
  mic = { current: String(m.current || ""), devices: Array.isArray(m.devices) ? m.devices.filter((d) => d && typeof d.uid === "string").map((d) => ({ uid: d.uid, name: String(d.name || d.uid) })) : [] };
  micListeners.forEach((l) => l());
}
/** null outside PS (a website cannot change the Mac's microphone). */
export function usePsMic() {
  return useSyncExternalStore((l) => { micListeners.add(l); return () => { micListeners.delete(l); }; }, () => mic);
}
export function askMic() { if (PS) psPost({ type: "mic:get" }); }
export function chooseMic(uid: string) { if (PS) psPost({ type: "mic:set", uid }); }
