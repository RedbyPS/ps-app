// The control of every row in Settings (V1.43, views/SettingsScreen.tsx), keyed by the setting's id in
// core/settingsindex.ts (which says its name, its one line, its group, its More and who sees it). Small controls sit on
// the right of their row; a bigger one opens below it (`open` keeps it open, else the row's arrow or a search jump
// opens it). A row with no control here and a `go` in the index is an Open button (onGo below).
// Adding a setting: an entry in core/settingsindex.ts and its control here, under the same id.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { PS, psPost, usePsMic, usePsSettings, type PsSettings } from "../ps";
import { GOS, MWEB } from "../gos/bridge";
import { useVault } from "../ui/kit";
import { LocalBackupSetting, LocalDataSetting } from "./LocalFirst";
import { localView } from "../localfirst";
const hasLocalBackup = () => { const v = localView(); return !!v.mirror?.backup || v.head?.state === "moved"; };
import { editSfx, sfx } from "../ui/sfx";
import { editSoundsOn } from "../core/editsounds";
import { isRedAccount } from "../core/account";
import { settingsData } from "../core/select";
import { appName } from "../core/appname";
import { islandPrefs } from "../core/island";
import { ChatFadeRow } from "./IslandCards";
import { tabStaysShown } from "../core/tabstays";
import { DAY_ENDS_DEFAULT } from "../core/daylog";
import { cleanUpdateEvery, UPDATE_EVERY_CHOICES, UPDATE_EVERY_OFF } from "../core/updateevery";
import { onUnlessOff } from "../core/offswitches";
import { rewindOn } from "../core/rewind";
import { setRewindOn } from "../rewind";
import { RewindBody } from "./RewindSettings";
import { CURRENCIES } from "../core/receiptparse";
import { defaultCurrency } from "../core/receipts";
import { hasExamples } from "../core/examples";
import type { Settings } from "../core/model";
import type { Go, SetEntry, Where } from "../core/settingsindex";
import { OpenButton, openSettings, SetRow, SettingsScreen, useSettingsWanted, type Controls, type RowProps, type SettingsOwner } from "./SettingsScreen";
import {
  AfkControls, Choice, LookBackground, LookBgColour, LookOutline, LookOwnColour, LookRain, MicPicker, NetworkSetting, networkNote, NotifyControls,
  SoundControls, StHoursControls, taskMapActions, TzSelect, type GenProps,
} from "./TaskMap";
import { AccentPart, LookPicker, TypePart, WorkPart } from "../looks/AppearanceSettings";
import { ListTransparency } from "./ListTransparency";
import { MouseTrailSettings } from "./MouseTrail";
import { OverdueLookSettings } from "./OverdueLook";
import { AddButtonControls, ListBehaviourControls } from "./Completed";
import { TypedPrioSwitch } from "./TypedPrio";
import { NewBadgeControls } from "./NewBadge";
import { NotifyPage } from "./NoteLook";
import { AiDoneSettings, type AiDoneState } from "./AiDone";
import { AiNotesChoice } from "./AiMessage";
import { AutoApproveSettings } from "./AutoApprove";
import { MeetPrefsPanel } from "./MeetPrefs";
import { CalSwitch } from "./CalSwitch";
import { CalPicker } from "./CalPicker";
import { RemindSettings, RemTestCard } from "./RemindSettings";
import { TelegramBotSettings } from "./TelegramBot";
import { ProtonBridgeSettings } from "./ProtonBridgeSettings";
import { TaskApiSettings } from "./TaskApi";
import { MailPeople } from "./MailPeople";
import { ClientEmailsSettings } from "./ClientEmailsSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";
import { ScreenRecSettings } from "./ScreenRec";
import { cleanSwitches, feature } from "../core/features";
import { CHK_FEATURE, CHK_EVERY_CHOICES, chkCardItem, cleanChk, everyLabel } from "../core/chkremind";
import { chkTest } from "../chkwatch";
import { SR_FEATURE } from "../core/screenrec";
import { mailOnSnap } from "../core/mailsnap";
import { mailCan } from "../core/mailswitch";
import { AutoResetSetting } from "./AutoReset";
import { AppNameSetting, IgnoredAppsSetting } from "./PsSettings";
import { IslandSettingsPage } from "./IslandSettings";
import { OpenShortcuts } from "./OpenShortcuts";
import { MiddleClickSettings } from "./MiddleClickSettings";
import { AfkSettings } from "./AfkSettings";
import { useAfkOn } from "./AfkBadge";
import { MediaGuardSettings } from "./MediaGuardSettings";
import { PsProjectSetting } from "./PsCreate";
import { SecondSwitch } from "./SecondSwitch";
import { openSleepSettings } from "./SleepSettings";
import { SentryBatterySetting, SentryLidSetting, SentryRestartSetting, SentryRestartSleepSetting } from "./Sentry";
import { SharingList, openGSquad } from "./GSquad";
import { FromTheSquad } from "./FromTheSquad";
import { AddFriendPanel } from "./AddFriend";
import { PomoSetting } from "./Pomodoro";
import { AssistAiRow, AssistOnRow, AssistPopRow, AssistRequestsRow } from "./AssistSettings";
import { PostureSetting } from "./PostureSettings";
import { MeetBubbleSetting, StandSetting, WelcomeBackSetting, WorkoutMacSetting } from "./IslandTimersSettings";
import { LinkIphoneRow } from "./LinkIphone";
import { MacUpdateRow } from "./MacUpdate";
import { WhatsNewEntry } from "./WhatsNew";
import { ExamplesEntry, WelcomeEntry } from "./Welcome";
import { TipsAgainEntry } from "./Tips";
import { TourAgainEntry } from "./TourAgain";
import { openSecurity } from "./Security";
import { askFitness } from "../fitness/fitask";
import { MINECRAFT_ENABLED } from "../core/mcmode";
import { MinecraftEntry } from "./Minecraft";
import { MAC_NOTE } from "../core/webtodo";
import { PHONE_CONTROLS } from "../gos/PhoneRows";

// ---------- what the Tab list hands in (the volume, the task size slider, the time zone) ----------
const GenContext = createContext<{ gen: GenProps; st: Settings } | null>(null);
const useGen = () => useContext(GenContext)!;
const save = (patch: Partial<Settings>) => void taskMapActions.looks(patch);

/** Where this page runs (core/settingsindex.ts Where). */
export const settingsWhere = (): Where => (PS ? "mac" : GOS || MWEB ? "phone" : "web");

/** Settings, for the Tab list (owner "tab"), the website's To-do page ("docked") and the phone. */
export function SettingsHost({ st, gen, owner }: { st: Settings; gen: GenProps; owner: SettingsOwner }) {
  const red = isRedAccount(useVault());
  const v = useVault();
  // Reply from PS is for people whose PS shows client email cards (Gmail replies or Who emails me records).
  const mail = mailOnSnap(v);   // the Client emails switch (core/mailswitch.ts); it was "has email records" before 1.60
  const mailC = mailCan(v);
  const sr = feature(SR_FEATURE);   // PS 1.60: the Screen recording group shows only where the feature is on in this build
  const pf = feature("posture-reminder");   // PS 1.65: the Posture Reminder group shows only where the feature is on
  const ck = feature(CHK_FEATURE);   // PS 1.65: the Checklist Reminder group shows only where the feature is on
  const ctx = useMemo(() => ({ red, where: settingsWhere(), mail, mailCan: mailC, sr, pf, ck, shell: GOS ? "gos" as const : MWEB ? "mweb" as const : undefined }), [red, mail, mailC, sr, pf, ck]);
  return (
    <GenContext.Provider value={{ gen, st }}>
      <SettingsScreen owner={owner} ctx={ctx} controls={CONTROLS} phone={GOS || MWEB} onGo={(go, e, close) => goTo(go, e, close, owner)} />
    </GenContext.Provider>
  );
}

/** A setting that lives on a screen of its own: Settings steps aside, then that screen opens. */
function goTo(go: Go, e: SetEntry, close: () => void, owner: SettingsOwner) {
  const later = (f: () => void) => window.setTimeout(f, 170);
  if (go === "macApp") { window.open(MAC_NOTE.link, "_blank", "noopener,noreferrer"); return; }   // a new tab; Settings stays
  close();
  if (go === "fitness") later(() => askFitness("settings", { docked: owner === "docked", phone: GOS || MWEB }));
  else if (go === "security") later(() => openSecurity(true));
  else if (go === "sleepSettings") later(() => openSleepSettings(e.id.startsWith("sleep.") ? e.id.slice(6) : null));   // V1.47: full screen, on that setting
  else if (go === "gsquad") later(() => openGSquad(true));
  else if (go === "phone") later(() => openSettings("phone", { owner }));   // V1.47: This phone is a group of Settings now
  else if (go === "dnd") later(() => {
    const cogs = [...document.querySelectorAll<HTMLElement>(owner === "docked" ? ".tm-overlay.tm-docked .dnd-cog" : ".dnd-cog")];
    (cogs.find((c) => c.offsetParent !== null) ?? cogs[0])?.click();
  });
  else if (go === "vault") openVault(e.anchor);
}
/** The website's own Settings page (vault, passphrase, sign-in log): there, scrolled to the heading and lit up. */
function openVault(anchor?: string) {
  if (location.hash !== "#/settings") location.hash = "#/settings";
  let tries = 0;
  const find = () => {
    const h = anchor ? document.getElementById(anchor) : null;
    if (!h) { if (++tries < 30) window.setTimeout(find, 100); return; }
    const box = h.closest<HTMLElement>(".panel") ?? h;
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    box.classList.add("gs-landed");
    window.setTimeout(() => box.classList.remove("gs-landed"), 2400);
  };
  window.setTimeout(find, 60);
}

// ---------- small pieces ----------
function OnOff({ on, ready = true, set, label }: { on: boolean; ready?: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <div className={`tm-ed-seg${ready ? "" : " gs-notyet"}`} role="radiogroup" aria-label={label}>
      <Choice selected={ready && on} onPick={() => { if (ready) { sfx.hover(); set(true); } }}>On</Choice>
      <Choice selected={ready && !on} onPick={() => { if (ready) { sfx.hover(); set(false); } }}>Off</Choice>
    </div>
  );
}
/** A synced On/Off that is on unless switched off (core/offswitches.ts), saved in the vault's settings for every device. */
function SyncedOnOff({ e, field }: { e: RowProps["e"]; field: "squadAutoJoin" | "psPresence" | "tipsShow" | "taskHistory" }) {
  const v = useVault();
  return <SetRow e={e} right={<OnOff label={e.name} on={onUnlessOff(settingsData(v)[field])} ready={v.status === "unlocked"} set={(on) => save({ [field]: on })} />} />;
}
type Ps = (PsSettings & { afk?: { on: boolean }; mediaGuard?: { on: boolean }; middleClick?: { on: boolean }; fu?: { on: boolean }; aiDone?: AiDoneState }) | null;
const usePs = () => usePsSettings() as Ps;
const row = (right: (p: RowProps) => ReactNode) => (p: RowProps) => <SetRow e={p.e} right={right(p)} />;
const block = (body: (p: RowProps) => ReactNode, open = true) => (p: RowProps) => <SetRow e={p.e} body={body(p)} open={open} />;

function Looks({ p, part }: { p: RowProps; part: "look" | "accent" | "type" | "work" | "lt" | "outline" | "bg" | "bgc" | "own" | "rain" | "trail" }) {
  const { st } = useGen();
  const body = part === "look" ? <LookPicker st={st} set={save} preview={p.preview} />
    : part === "accent" ? <AccentPart st={st} set={save} />
    : part === "type" ? <TypePart st={st} set={save} />
    : part === "work" ? <WorkPart st={st} set={save} preview={p.preview} />
    : part === "lt" ? <ListTransparency saved={st.tmBackdrop} save={(v, keep) => taskMapActions.backdrop(v, keep)} />
    : part === "outline" ? <LookOutline st={st} preview={p.preview} />
    : part === "bg" ? <LookBackground st={st} preview={p.preview} />
    : part === "bgc" ? <LookBgColour st={st} preview={p.preview} />
    : part === "own" ? <LookOwnColour st={st} preview={p.preview} />
    : part === "trail" ? <MouseTrailSettings st={st} set={save} />
    : <LookRain st={st} preview={p.preview} />;
  return <SetRow e={p.e} body={<div className="gs-looks ms-win">{body}</div>} open plain className="gs-look-row" />;
}
const looks = (part: Parameters<typeof Looks>[0]["part"]) => (p: RowProps) => <Looks p={p} part={part} />;

// ---------- every row ----------
export const CONTROLS: Controls = {
  // PS 1.65 Settings assistant (views/AssistSettings.tsx)
  "assist-on": AssistOnRow, "assist-pop": AssistPopRow, "assist-ai": AssistAiRow, "assist-requests": AssistRequestsRow,
  // The phone's own rows (V1.47): GrapheneOS app and iPhone web app, gos/PhoneRows.tsx.
  ...PHONE_CONTROLS,
  // Your list
  "tick-mode": row(() => <ListBehaviourControls part="mode" />),
  "completed-show": row(() => <ListBehaviourControls part="show" />),
  "completed-keep": row(() => <ListBehaviourControls part="keep" />),
  "task-size": function TaskSize({ e }) { return <SetRow e={e} right={<div className="tm-pop-row col gs-size">{useGen().gen.size}</div>} />; },
  "sounds": function Sounds({ e }) { const { gen } = useGen(); return <SetRow e={e} right={<SoundControls volume={gen.volume} muted={gen.muted} soundOff={gen.soundOff} onMute={gen.onMute} />} />; },
  "tick-sound": row(() => <ListBehaviourControls part="sound" />),
  "edit-sounds": row(() => <EditSoundsSwitch />),
  "add-button": block(() => <AddButtonControls />),
  "typed-prio": row(() => <TypedPrioSwitch save={save} />),
  // PS 1.65 dates in plain words (views/NlDates.tsx, core/nldates.ts). The same switch as in From the squad (squadFeatures).
  "nl-dates": function NlDates({ e }) {
    const v = useVault();
    const mine = cleanSwitches(settingsData(v).squadFeatures);
    return <SetRow e={e} right={<OnOff label={e.name} on={feature("nl-dates")} ready={v.status === "unlocked"} set={(on) => save({ squadFeatures: { ...mine, "nl-dates": on } })} />} />;
  },
  "nl-remind": function NlRemind({ e }) {
    const v = useVault();
    return <SetRow e={e} right={<OnOff label={e.name} on={settingsData(v).tmNlRemind !== false} ready={v.status === "unlocked"} set={(on) => save({ tmNlRemind: on })} />} />;
  },
  "new-badge": row(() => <NewBadgeControls />),

  // Pomodoro (V1.58, views/Pomodoro.tsx)
  "pomo-on": row(() => <PomoSetting k="on" />),
  "pomo-work": row(() => <PomoSetting k="work" />),
  "pomo-short": row(() => <PomoSetting k="short" />),
  "pomo-long": row(() => <PomoSetting k="long" />),
  "pomo-rounds": row(() => <PomoSetting k="rounds" />),
  "pomo-auto": row(() => <PomoSetting k="auto" />),
  "pomo-sound": row(() => <PomoSetting k="sound" />),
  "pomo-clock": row(() => <PomoSetting k="clock" />),
  // Stand-up reminders and the next meeting bubble (V1.58, views/IslandTimersSettings.tsx)
  // Posture Reminder (PS 1.65, views/PostureSettings.tsx)
  "posture-on": row(() => <PostureSetting k="on" />),
  "posture-every": row(() => <PostureSetting k="every" />),
  "posture-hours": row(() => <PostureSetting k="hours" />),
  "posture-test": row(() => <PostureSetting k="test" />),
  "stand-on": row(() => <StandSetting k="on" />),
  "stand-every": row(() => <StandSetting k="every" />),
  "stand-len": row(() => <StandSetting k="len" />),
  "stand-sound": row(() => <StandSetting k="sound" />),
  "stand-hours": row(() => <StandSetting k="hours" />),
  "stand-test": row(() => <StandSetting k="test" />),
  "meet-bubble": row(() => <MeetBubbleSetting k="on" />),
  "meet-bubble-lead": row(() => <MeetBubbleSetting k="lead" />),
  "meet-bubble-style": row(() => <MeetBubbleSetting k="style" />),
  "welcome-back": row(() => <WelcomeBackSetting k="on" />),
  "welcome-back-min": row(() => <WelcomeBackSetting k="minutes" />),
  "workout-mac": row(() => <WorkoutMacSetting />),

  // Appearance
  "look": looks("look"),
  "accent": looks("accent"),
  "layout-text": looks("type"),
  "working-on": looks("work"),
  "mouse-trail": looks("trail"),
  "transparency": looks("lt"),
  "overdue-tab": (p) => <SetRow e={p.e} body={<div className="gs-looks ms-win"><OverdueLookSettings preview={p.preview} /></div>} open plain className="gs-look-row" />,
  "outline": looks("outline"),
  "background": looks("bg"),
  "bg-colour": looks("bgc"),
  "rain": looks("rain"),
  "own-colour": looks("own"),

  // Notifications and Do Not Disturb
  "popups": function Popups({ e }) { const { gen } = useGen(); return <SetRow e={e} right={<NotifyControls notifyOn={gen.notifyOn} notifyLog={gen.notifyLog} />} />; },
  "ai-done": function AiDone({ e }) {   // V1.53, views/AiDone.tsx; V1.55 the cards' own time (views/IslandCards.tsx)
    const fade = settingsData(useVault()).chatFade;
    return <SetRow e={e} body={<><AiNotesChoice /><ChatFadeRow value={fade} save={(chatFade) => save({ chatFade })} /><AiDoneSettings state={usePs()?.aiDone} /></>} open />;
  },
  "card-looks": block(() => <NotifyPage />, false),
  "meetings": block(() => <div className="gs-meet"><MeetPrefsPanel /></div>, false),
  "calendar": row(() => <CalSwitch />),
  "calendars": block(() => <CalPicker />),
  // V1.46: the daily reminder lives in Annoying 15 min reminder now (reminder one); this row takes you there.
  "daily-reminder": function Daily({ e }) {
    return <SetRow e={e} right={<button type="button" className="gs-open" onClick={() => { sfx.click(); openSettings("remind", { jump: "reminders" }); }}>Open
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button>} />;
  },
  // Annoying 15 min reminder (core/remind.ts): the whole list, always open. The website's Test card sits here too.
  "reminders": function Reminders({ e }) { return <SetRow e={e} body={<><RemindSettings /><RemTestCard /></>} open plain />; },
  // Checklist Reminder (PS 1.65, core/chkremind.ts, views/ChecklistReminder.tsx): on or off, how often, the chime, and a look at the pop-up.
  "chk-on": function ChkOn({ e }) {
    const v = useVault(), c = cleanChk(settingsData(v).chkRemind);
    return <SetRow e={e} right={<OnOff label={e.name} on={c.on} ready={v.status === "unlocked"} set={(on) => save({ chkRemind: { ...c, on } })} />} />;
  },
  "chk-every": function ChkEvery({ e }) {
    const v = useVault(), c = cleanChk(settingsData(v).chkRemind), ready = v.status === "unlocked";
    const choices = CHK_EVERY_CHOICES.includes(c.every as never) ? [...CHK_EVERY_CHOICES] : [...CHK_EVERY_CHOICES, c.every].sort((a, b) => a - b);
    return <SetRow e={e} right={
      <select className="tm-pop-sel gs-sel" value={c.every} disabled={!ready} aria-label={e.name} onChange={(ev) => { save({ chkRemind: { ...c, every: Number(ev.target.value) } }); ev.target.blur(); }}>
        {choices.map((m) => <option key={m} value={m}>{everyLabel(m)}</option>)}
      </select>} />;
  },
  "chk-sound": function ChkSound({ e }) {
    const v = useVault(), c = cleanChk(settingsData(v).chkRemind);
    return <SetRow e={e} right={<OnOff label={e.name} on={c.sound} ready={v.status === "unlocked"} set={(sound) => save({ chkRemind: { ...c, sound } })} />} />;
  },
  "chk-test": function ChkTest({ e }) {
    const c = cleanChk(settingsData(useVault()).chkRemind);
    return <SetRow e={e} right={<button type="button" className="btn quiet sm" onClick={() => { sfx.click(); if (PS) psPost({ type: "rem:test", item: chkCardItem(c) }); else chkTest(); }}>Show it now</button>} />;
  },
  // Sentry mode (V1.48, views/Sentry.tsx): three simple settings.
  "sentry-battery": row(() => <SentryBatterySetting />),
  "sentry-restart": block(() => <SentryRestartSetting />),
  "sentry-restart-sleep": block(() => <SentryRestartSleepSetting />),
  "sentry-lid": block(() => <SentryLidSetting />),
  "auto-approve": function AutoApprove({ e }) { return <SetRow e={e} body={<AutoApproveSettings state={(usePs() as { autoApprove?: unknown } | null)?.autoApprove} />} open />; },
  // Add Telegram Bot (V1.47, views/TelegramBot.tsx): the four steps, the rules and Remove, always open.
  "telegram-bot": function TelegramBot({ e }) { return <SetRow e={e} body={<TelegramBotSettings />} open plain />; },
  // AI task API (views/TaskApi.tsx): on or off, the key, the switches, Copy for AI, always open.
  "task-api": function TaskApi({ e }) { return <SetRow e={e} body={<TaskApiSettings />} open plain />; },
  // Reply from PS: no settings page of its own (the developer, 8 Nov 2026); this opens the reply panel with no email in it.
  // V1.59 Reply in the email panel (core/inlinereply.ts): on unless switched off, on every device.
  "reply-in-panel": function ReplyInPanel({ e }) {
    const v = useVault();
    return <SetRow e={e} right={<OnOff label={e.name} on={settingsData(v).replyInPanel !== false} ready={v.status === "unlocked"} set={(on) => save({ replyInPanel: on })} />} />;
  },
  "reply-from-ps": row(() => <button className="btn quiet sm" onClick={() => psPost({ type: "looks", patch: { replySetup: true } })}
    data-tip="Open the reply panel" data-tip-line="Quick replies, your signature, Send now or at a random time, and the accounts that can send.">Open</button>),
  "client-emails": block(() => <ClientEmailsSettings compact />),
  "proton-bridge": block(() => <ProtonBridgeSettings />),   // PS 1.65 Proton Mail through Bridge (views/ProtonBridgeSettings.tsx)
  "whatsapp": block(() => <WhatsAppSettings />),
  "screenrec": block(() => <ScreenRecSettings />),   // PS 1.60 (views/ScreenRec.tsx)
  "gmail-replies": block(() => <MailPeople overlay={PS} />, false),

  // Time and reset
  "home-tz": function HomeTz({ e }) { return <SetRow e={e} right={<TzSelect homeTz={useGen().gen.homeTz} />} />; },
  "tz-names": row(() => undefined),
  // V1.65: click a zone to open it tall (views/TimeZones.tsx FocusCard). The same switch as in From the squad (squadFeatures).
  "tz-focus": function TzFocus({ e }) {
    const v = useVault();
    const mine = cleanSwitches(settingsData(v).squadFeatures);
    return <SetRow e={e} right={<OnOff label={e.name} on={feature("tz-focus")} ready={v.status === "unlocked"} set={(on) => save({ squadFeatures: { ...mine, "tz-focus": on } })} />} />;
  },
  "auto-reset": function Reset({ e }) { return <SetRow e={e} body={<AutoResetSetting className="gs-reset" st={settingsData(useVault())} save={save} />} open />; },
  "day-ends": function DayEnds({ e }) {
    const v = settingsData(useVault()).dayEndsHour ?? DAY_ENDS_DEFAULT;
    return <SetRow e={e} right={
      <select className="tm-pop-sel gs-sel" value={v} aria-label={e.name} onChange={(ev) => { save({ dayEndsHour: Number(ev.target.value) }); ev.target.blur(); }}>
        <option value={0}>Midnight (no night shifts)</option>
        {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })}</option>)}
      </select>} />;
  },
  "st-hours": function StHours({ e }) { return <SetRow e={e} right={<StHoursControls stHours={useGen().gen.stHours} />} />; },
  "screen-time": function ScreenTime({ e }) {
    const st = usePsSettings();
    return <SetRow e={e} right={<OnOff label={e.name} on={!!st?.screenTime} ready={!!st} set={(on) => psPost({ type: "psSettings:screenTime", on })} />} />;
  },

  // Tab overlay shortcuts (V1.47): the whole list, always open (the / then . chord is one of its shortcuts)
  "trigger-key": function Trigger({ e }) { return <SetRow e={e} body={<OpenShortcuts />} open />; },

  // Keyboard and Tab
  "tab-stays": function TabStays({ e }) {
    const st = usePsSettings();
    const on = tabStaysShown(st, isRedAccount(useVault()));
    return <SetRow e={e} right={<OnOff label={e.name} on={on} ready={!!st} set={(v) => psPost({ type: "psSettings:tabStays", on: v })} />} />;
  },
  "middle-click": function Middle({ e }) {
    const m = usePs()?.middleClick;
    return <SetRow e={e} className="gs-has-switch" right={<OnOff label={e.name} on={!!m?.on} ready={!!m} set={(on) => psPost({ type: "middleClick", op: "set", on })} />} body={<MiddleClickSettings />} />;
  },
  "ignored-apps": block(() => <IgnoredAppsSetting />, false),

  // Mac
  // Dynamic Island (V1.58): its own tab with the same settings as the island settings window (views/IslandSettings.tsx).
  "island": function Island({ e }) {
    const prefs = islandPrefs(settingsData(useVault()).island);
    return <SetRow e={e} plain open body={<IslandSettingsPage prefs={prefs} save={(p) => save({ island: { ...prefs, ...p } })} />} />;
  },
  "afk": function Afk({ e }) {
    const on = useAfkOn();
    return <SetRow e={e} className="gs-has-switch" right={on === undefined ? undefined : <AfkControls afkOn={on} />} body={<AfkSettings />} />;
  },
  "airpods": function AirPods({ e }) {
    const g = usePs()?.mediaGuard;
    return <SetRow e={e} className="gs-has-switch" right={<OnOff label={e.name} on={!!g?.on} ready={!!g} set={(on) => psPost({ type: "mediaGuard", on })} />} body={<MediaGuardSettings />} />;
  },
  "mic": function Mic({ e }) { return usePsMic() ? <SetRow e={e} body={<div className="gs-mic"><MicPicker /></div>} open /> : null; },
  "network": function Net({ e }) { const { st } = useGen(); return <SetRow e={e} right={<NetworkSetting st={st} />} body={<p className="gs-set-note">{networkNote(st)}</p>} open />; },
  "app-name": block(() => <AppNameSetting />, false),

  // Privacy and sharing (open source build): the "PS app is open" presence channel (src/ps.ts startPsPresence)
  "ps-presence": function PsPresence({ e }) { return <SyncedOnOff e={e} field="psPresence" />; },
  // Receipts and Purchases (PS 1.65): the switch, and the currency a new receipt starts with (views/Purchases.tsx)
  "receipts": function ReceiptsRow({ e }) {
    const v = useVault();
    const st = settingsData(v);
    const on = onUnlessOff(st.receipts);
    return <SetRow e={e} right={<OnOff label={e.name} on={on} ready={v.status === "unlocked"} set={(x) => save({ receipts: x })} />} body={on ? (
      <div className="gs-rewind stack" style={{ gap: 8 }}>
        <p className="gs-set-note">On. Scan a receipt on your phone, then open Purchases in the Tab list. Nothing leaves your devices.</p>
        <label className="gs-set-note" style={{ display: "flex", gap: 8, alignItems: "center" }}>New receipts start in
          <select value={defaultCurrency(st.receiptCur)} onChange={(ev) => save({ receiptCur: ev.target.value })}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
      </div>) : <p className="gs-set-note">Off. The Purchases button is hidden. Your saved receipts stay where they are.</p>} open />;
  },
  "fuller-history": function TaskHistory({ e }) { return <SyncedOnOff e={e} field="taskHistory" />; },
  // Rewind (PS 1.64): public, on unless switched off; the line says what it keeps, Delete my Rewind data under it (views/RewindSettings.tsx)
  "rewind": function Rewind({ e }) {
    const v = useVault();
    const on = rewindOn(settingsData(v).rewind);
    return <SetRow e={e} right={<OnOff label={e.name} on={on} ready={v.status === "unlocked" && v.role === "owner"} set={(x) => void setRewindOn(x)} />} body={<RewindBody on={on} />} open />;
  },

  // Sync and account
  "local-data": function LocalData({ e }) { const s = useVault(); return s.local || hasLocalBackup() ? <SetRow e={e} body={<LocalDataSetting s={s} />} open /> : null; },
  "local-backup": function LocalBackup({ e }) { const s = useVault(); return s.status === "unlocked" ? <SetRow e={e} body={<LocalBackupSetting s={s} />} open={!!s.local} /> : null; },
  "project": block(() => <PsProjectSetting />, false),
  "link-iphone": function LinkIphone({ e }) { return <LinkIphoneRow e={e} />; },
  "mac-phone-signin": function PhoneSignIn({ e }) { return <LinkIphoneRow e={e} red />; },
  "second": block(() => <SecondSwitch />, false),   // PS 1.65: its On/Off, then its settings while on
  "invite": row(() => undefined),

  // Sleep mode (V1.47): one line and a button, like Security; its settings open full screen (views/SleepSettings.tsx)
  "sleep-settings": function SleepEntryRow({ e }) { return <SetRow e={e} right={<OpenButton e={e} label="Open Sleep settings" />} />; },

  // G Squad
  "gs-share": block(() => <SharingList />),
  "squad-features": block(() => <FromTheSquad />),   // V1.58 (views/FromTheSquad.tsx)
  "gs-auto-join": function GsAutoJoin({ e }) { return <SyncedOnOff e={e} field="squadAutoJoin" />; },
  // V1.44: the QR code comes up as soon as the section opens (a fresh code each time; closing calls it off).
  "add-friend": function AddFriend({ e }) { return <SetRow e={e} body={<AddFriendPanel />} open plain className="af-row-set" />; },

  // About and updates
  "updates": function Updates({ e }) { const open = !!useSettingsWanted(); return <SetRow e={e} className="gs-upd-row" body={<MacUpdateRow menuOpen={open} />} open />; },
  // V1.54: one synced choice, 5 (default), 10, 15 or 30 minutes; the Mac, the website and the phone (while open) follow it at once.
  // The phone's grey line says what Android allows with the app closed.
  "update-every": function UpdateEvery({ e }) {
    const v = useVault();
    const now = cleanUpdateEvery(settingsData(v).updateEvery), ready = v.status === "unlocked";
    const line = GOS ? `${e.line} With the app closed, Android allows about every 15 minutes at most.` : e.line;
    return <SetRow e={{ ...e, line }} className="gs-upd-every" right={
      <div className={`tm-ed-seg${ready ? "" : " gs-notyet"}`} role="radiogroup" aria-label={e.name}>
        {UPDATE_EVERY_CHOICES.map((m) => <Choice key={m} selected={ready && now === m} onPick={() => { if (ready) { sfx.hover(); save({ updateEvery: m }); } }}>{m}</Choice>)}
        {/* Off: no automatic looks on any device; Check now still looks. */}
        <Choice selected={ready && now === UPDATE_EVERY_OFF} onPick={() => { if (ready) { sfx.hover(); save({ updateEvery: UPDATE_EVERY_OFF }); } }}>Off</Choice>
      </div>} />;
  },
  "whats-new": row(() => <WhatsNewEntry />),
  "setup": function Setup({ e }) {
    return (<>
      {/* Minecraft mode is switched off (core/mcmode.ts): switched on, its card sits here, above the setup menu. */}
      {MINECRAFT_ENABLED && <MinecraftEntry onOpen={() => openSettings(null)} />}
      <SetRow e={e} right={<WelcomeEntry />} />
    </>);
  },
  "tips": row(() => <TipsAgainEntry />),
  "tour-again": row(() => <TourAgainEntry />),
  "tips-show": function TipsShow({ e }) { return <SyncedOnOff e={e} field="tipsShow" />; },
  // V1.57 Settings, Controls: Invert swipe (off unless switched on; core/lists.ts swipeSign).
  "invert-swipe": function InvertSwipe({ e }) {
    const v = useVault();
    return <SetRow e={e} right={<OnOff label={e.name} on={settingsData(v).swipeInvert === true} ready={v.status === "unlocked"} set={(on) => save({ swipeInvert: on })} />} />;
  },
  "examples": function Examples({ e }) {
    const s = useVault();
    const set = settingsData(s);
    if (s.status !== "unlocked" || !hasExamples(set.examples, s.docs.values(), set.aware, set.timelines)) return null;
    return <SetRow e={e} body={<ExamplesEntry />} open />;
  },
  "version": function Version({ e }) {
    return <SetRow e={e} right={<span className="gs-ver-v">{appName()} {__PS_VERSION__.name || "dev"}{__PS_VERSION__.keyword ? <em>{__PS_VERSION__.keyword}</em> : null}</span>} />;
  },
};

/** V1.56 Edit mode sounds (core/editsounds.ts): On plays a soft sample as it turns on. */
function EditSoundsSwitch() {
  const on = editSoundsOn(settingsData(useVault()));
  return (
    <div className="tm-ed-seg" role="radiogroup" aria-label="Edit mode sounds">
      <button type="button" role="radio" aria-checked={on} className={`dwell${on ? " on" : ""}`} onClick={() => { if (!on) { save({ editSounds: true }); editSfx("edit-save", true); } }}>On</button>
      <button type="button" role="radio" aria-checked={!on} className={`dwell${!on ? " on" : ""}`} onClick={() => { if (on) { sfx.hover(); save({ editSounds: false }); } }}>Off</button>
    </div>
  );
}
