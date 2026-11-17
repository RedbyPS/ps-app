import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { BASE, agentWorkspaceCount, confirmAgent, docs, lock, put, remove, restoreSession, setImportHandler, setOpsHandler, setTelegramHandler, setTrustedAgents, sync, vaultStore } from "./core/vault";
import { addClientTask, addPreview, addProject, suggestTodo, attachDoc, setStage, updateClient, updateProject, updateTodo } from "./core/actions";
import { newSubId, titleMatches } from "./core/subtasks";
import { mergePeople, peopleOf } from "./core/numerology";
import type { Brief, CalendarSnap, CampaignStats, ClientRec, CTask, IEmail, Payment, Pipeline, ProjectDoc, ProjectType, Proposal, Tick, Todo } from "./core/model";
import { parseImportFile, runImport } from "./core/importer";
import { agenda, clientViews, projectViews, settingsData } from "./core/select";
import { applyNotesOp } from "./core/notescard";
import { maybeAutoReset, migrateClaudeAdds, migrateLooks, migrateP1, saveSettings } from "./core/actions";
import { addChatDone, chatDoneFrom } from "./core/chatdone";
import { NotesDock } from "./views/NotesDock";
import { TaskMap } from "./views/TaskMap";
import { usePageLook } from "./views/ListPager";
import { usePhoneLook } from "./gos/phonepage";
import { Icon, Logo, Toasts, toast, useHash, useVault } from "./ui/kit";
import { LockScreen, usePendingRecovery } from "./views/Lock";
import { MoveScreen } from "./views/LocalFirst";
import { bootLocal, localMoveWanted, useLocalView } from "./localfirst";
import { isRedAccount } from "./core/account";
import { mailOnSnap } from "./core/mailsnap";
import { TodoView } from "./views/Todo";
import { WebTodoView } from "./views/WebTodo";
import { landingPage } from "./core/webtodo";
import { SettingsView } from "./views/Settings";
import { FriendJoinCard, FriendLanding } from "./views/AddFriend";
import { pendingFriendLink, takeFriendLink } from "./squad/engine";
import { PS, psPost, psUpdateReady, startPsBridge, startPsOverlay, startPsPresence, startPsSecondWindow } from "./ps";
import { rewindAddMoney, startRewind } from "./rewind";
import { describeOps, notify, quietOp, setNotifySink, type NoteCard } from "./core/notify";
import { dndMutes } from "./core/dnd";
import { storeCampaignsPage } from "./core/campaigns";
// The website's own pages load when opened (V1.44, src/pages.ts): the lock screen and To-do come first.
import { CampaignsNotForYou, CampaignsPageView, ClientDetailView, ClientPortal, ClientsView, DemoPage, EmailsView, FitnessPage, FitnessTestView, GSquadLink, JoinOwnerScreen, JoinScreen, MeetingsView, ProposalsView, TodayView, prefetchPages } from "./pages";
import { WebUpdateBanner, WebUpdateNote } from "./views/WebUpdateNote";
import { WhatsNewHost } from "./views/WhatsNew";
import { FeatureIntroHost } from "./views/FeatureIntro";
import { PosturePopupHost } from "./views/PosturePopup";
import { ChecklistReminderHost } from "./views/ChecklistReminder";
import { TipsHost } from "./views/Tips";
import { NewPopupsHost } from "./views/NewPopups";
import { cleanPastDoc, cleanPastMonths } from "./core/squadpast";
import { privateNotesPlan, type PrivateNotes } from "./core/privatenotes";
import { PsLayout, PsLocked, PsOpenPill, PsOverlay, PsSecondWindow } from "./views/PsApp";
import { RuleBookHost } from "./views/RuleBook";
import { MWEB } from "./gos/bridge";
import { AppMark } from "./mobile/mark";
import { MOBILE_APP_NAME } from "./core/appname";
import { mainCalendar } from "./core/calfeeds";
import { shownEvents } from "./core/calpick";
import { MailCardsWeb } from "./views/MailCards";
import { SquadNoteCards } from "./views/SquadNoteCards";
import { ReplyWindow, startReplyWindow } from "./views/ReplyWindow";
import { startFeatureSync } from "./featuresync";
import { startDeviceBeat } from "./devicebeat";
import { useAppearanceEngine } from "./looks/engine";
import { addProgram, fitnessNow } from "./fitness/store";
import { programFromPlan, type PlanIn } from "./fitness/lib";

// V1.44 Add friend: a scanned QR code opens cincee.com/client/#add=... (or #ask=...). Read it before anything else
// looks at the address (the hash router would take it for a page), keep it, and take the key out of the address bar.
// The website only: PS's own pages never open such a link.
if (!PS && import.meta.env.MODE !== "gos") takeFriendLink();

// V1.61: feature() knows who is signed in on every page (the website, the phone, the Mac), src/featuresync.ts.
startFeatureSync();
startDeviceBeat();   // PS 1.65: this device tells the account it exists, for Backgrounds per device (src/devicebeat.ts)

// Dev page: every exercise picture in every look (src/dev/expics.tsx). Lazy so it never reaches a release build.
const ExPicsDev = import.meta.env.DEV ? lazy(() => import("./dev/expics")) : null;

function route(): "demo" | "join" | "join-owner" | "app" | "overlay" | "campaigns" | "fitview" | "second-window" | "reply-window" | "gsquad" | "expics" {
  const p = location.pathname.replace(BASE, "/").replace(/\/+$/, "");
  // cincee.com/campaigns (also /client/campaigns): the Cincee Campaigns dashboard, owner only.
  if (!PS && (/^\/campaigns(\/|$)/.test(location.pathname) || p === "/campaigns")) return "campaigns";
  if (PS && p === "/overlay") {   // PS Mac app: the floating Tab window
    // the dev server only: ?fake shows the list with fictional data, as PS would hand it in
    if (import.meta.env.DEV && location.search.includes("fake")) void import("./dev/fake").then((f) => setTimeout(() => (window as unknown as { __psOverlay: { load(s: unknown, o: boolean): void } })
      .__psOverlay.load({ unlocked: true, docs: devWork(f.fakeDocs()), lastSync: new Date().toISOString(), red: false }, true), 300));   // the public app
    if (import.meta.env.DEV && location.search.includes("gsquad")) void import("./dev/gsquad-fake").then((g) => g.loadGSquadFake());   // &gsquad: a fictional G Squad (V1.43 window)
    return "overlay";
  }
  if (PS && p === "/fitview") return "fitview"; // PS self test only: Fitness over fictional data it hands in (no vault)
  if (PS && p === "/second-window") return "second-window";   // PS Mac app: the Second Computer window (views/SecondWindow.tsx)
  if (PS && p === "/reply-window") return "reply-window";     // PS Mac app: Reply from PS, the compose window (views/ReplyWindow.tsx)
  if (import.meta.env.DEV && p === "/dev-reply-window") { void import("./dev/reply-fake").then((f) => setTimeout(f.loadReplyFake, 200)); return "reply-window"; }   // fictional email
  if (import.meta.env.DEV && p === "/dev-second-window") {     // the same window with fictional data
    void Promise.all([import("./dev/fake"), import("./dev/second-fake"), import("./core/vault"), import("./second/store")]).then(([f, sf, v, st]) => {
      const x = sf.fakeSecond(Date.now(), new URLSearchParams(location.search).get("as"));
      const code = new URLSearchParams(location.search).has("code");   // ?code: Code jobs switched on (PS 1.65)
      v.__devLoad([...f.fakeDocs().map((d) => code && d.kind === "settings" ? { ...d, data: { ...(d.data as object), secondCodeJobs: true } } : d), ...x.docs]);
      st.setSecondMirror(x.local);
    });
    return "second-window";
  }
  if (import.meta.env.DEV && p === "/dev-campaigns") {
    void import("./dev/fake").then((m) => import("./core/vault").then((v) => v.__devLoad(m.fakeDocs())));
    void Promise.all([import("./dev/clive-fake"), import("./core/campaignsLive")]).then(([f, l]) => l.__devLive((b) => f.fakeLivePayload(new Date(), b)));
    return "campaigns";
  }
  if (import.meta.env.DEV && p === "/dev") {
    void import("./dev/fake").then((m) => {
      (window as { __devTimeline?: unknown }).__devTimeline = m.fakeTimeline();
      void Promise.all([import("./dev/clive-fake"), import("./core/campaignsLive")]).then(([f, l]) => l.__devLive((b) => f.fakeLivePayload(new Date(), b)));
      return import("./core/vault").then(async (v) => v.__devLoad(location.search.includes("est") ? (await import("./dev/timeest-fake")).withEst(m.fakeDocs()) : m.fakeDocs()));   // ?est: time estimates (PS 1.65)
    }).then(() => { if (location.search.includes("squad")) void import("./dev/gym-fake").then((g) => g.loadGymFake()); });   // ?squad: a fictional G Squad for Fitness
    if (location.search.includes("note")) void import("./dev/gsquad-fake").then((g) => g.loadGSquadFake());   // &note: a made up G Squad message card in the corner (PS 1.60)
    return "app";
  }
  if (import.meta.env.DEV && p === "/dev-second") {   // Second Computer panel with fictional data (src/dev/second-fake.ts)
    void Promise.all([import("./dev/fake"), import("./dev/second-fake"), import("./core/vault"), import("./second/store")]).then(([f, sf, v, st]) => {
      const x = sf.fakeSecond();
      v.__devLoad([...f.fakeDocs(), ...x.docs]);
      st.setSecondMirror(x.local);
    });
    return "app";
  }
  if (import.meta.env.DEV && p === "/dev-purchases") {   // the Purchases screen with made up receipts (src/dev/receipts-fake.ts)
    void Promise.all([import("./dev/fake"), import("./dev/receipts-fake"), import("./core/vault"), import("./core/features")]).then(([f, r, v, ft]) => { v.__devLoad([...f.fakeDocs(), ...r.fakeReceipts()]); (window as unknown as { __dbg: unknown }).__dbg = () => ({ on: ft.feature("receipts"), reg: ft.registry().length, st: v.vaultStore.get().status }); setTimeout(() => void import("./views/Purchases").then((pu) => pu.openPurchases()), 1500); });
    return "app";
  }
  if (import.meta.env.DEV && p === "/dev-expics") return "expics";
  if (p === "/demo") return "demo";
  if (p === "/join") return "join";
  if (p === "/join-owner") return "join-owner";
  if (!PS && p === "/gsquad") return "gsquad";   // a G Squad invite opened in a browser: says to paste it into PS (views/GSquadLink.tsx)
  return "app";
}

/** The dev server only: ?work=<style> makes the first open task the one being worked on, in that Working on look. */
function devWork<T extends { kind: string; data: unknown; id: string }>(docs: T[]): T[] {
  const w = new URLSearchParams(location.search).get("work");
  if (!import.meta.env.DEV || !w) return docs;
  const todo = docs.find((d) => d.kind === "todo" && !(d.data as { done?: boolean }).done && (d.data as { type?: string }).type === "once");
  const st = docs.find((d) => d.kind === "settings");
  if (todo && st) st.data = { ...(st.data as object), workingIds: [todo.id], tmWorkStyle: w };
  return docs;
}

/** The page the website shows now (V1.44: with no hash, the developer's Today, everyone else their To-do list). */
function pageOf(red: boolean): { page: string; parts: string[] } {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  return { page: landingPage(parts[0] || "", red || MWEB), parts };   // the mobile web app keeps Today under its own home
}
/** The website's To-do page in web form (views/WebTodo.tsx) is showing: an owner, in a browser, on To-do. */
function useWebTodo(s: ReturnType<typeof useVault>): boolean {
  useHash();   // redraws on every page change
  if (PS || import.meta.env.MODE === "gos" || MWEB || s.status !== "unlocked" || s.role !== "owner") return false;
  return pageOf(isRedAccount(s)).page === "todo";
}

function useTheme() {
  const s = useVault();
  const webTodo = useWebTodo(s);
  const theme = s.status === "unlocked" ? settingsData(s).theme : "system";
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  // The PS look (V1.31, src/looks/engine.ts): every PS page and the phone. The website gets it only on its To-do page
  // in web form (V1.44), which is the Tab list; its other pages (clients, pipeline, settings) never get a look.
  // V1.55: a list page can have its own look (views/ListPager.tsx); it goes on as the page lands, with the usual fade.
  const appSt = s.status === "unlocked" ? settingsData(s) : {};
  const listLook = usePageLook(appSt);
  const phoneLook = usePhoneLook();   // V1.56: the phone layout's look for the page the phone shows (gos/phonepage.ts)
  const pageLook = phoneLook ?? listLook;
  useAppearanceEngine(pageLook ? { ...appSt, look: pageLook } : appSt, (PS || import.meta.env.MODE === "gos" || MWEB || webTodo) && s.status === "unlocked");   // MWEB: the mobile web app (src/mobile/)
}

const opsTally: { done: number; missing: string[]; parts: string[]; timer?: ReturnType<typeof setTimeout> } = { done: 0, missing: [], parts: [] };

export default function App() {
  const [r, setR] = useState(route);
  useTheme();
  useEffect(() => { if (r !== "overlay" && r !== "second-window" && r !== "reply-window") { startPsBridge(); startPsPresence(); } }, [r]);
  // Rewind (PS 1.64): the private history for the yearly recap, in the main page only (src/rewind.ts, core/rewind.ts).
  useEffect(() => { if (r !== "overlay" && r !== "second-window" && r !== "reply-window" && r !== "fitview" && r !== "expics") startRewind(); }, [r]);
  if (r === "overlay") { startPsOverlay(); return <PsOverlay />; }
  if (r === "fitview") { startPsOverlay(); return <Wait><FitnessTestView /></Wait>; }
  if (r === "expics" && ExPicsDev) return <Suspense fallback={null}><ExPicsDev /></Suspense>;
  if (r === "second-window") { startPsSecondWindow(); return <PsSecondWindow />; }
  if (r === "reply-window") { startReplyWindow(); return <ReplyWindow />; }
  if (r === "demo") return <><Wait><DemoPage /></Wait><Toasts /></>;
  if (r === "gsquad") return <Wait><GSquadLink /></Wait>;
  if (r === "join-owner") return <><Wait><JoinOwnerScreen onDone={() => { history.replaceState(null, "", BASE); setR("app"); }} /></Wait><Toasts /></>;
  if (r === "join") return <><Wait><JoinScreen onDone={() => { history.replaceState(null, "", BASE); setR("app"); }} /></Wait><Toasts /></>;
  if (r === "campaigns") return <><Vaulted page="campaigns" /><Toasts /></>;
  return <><Vaulted /><Toasts /></>;
}

/** While a page's own file loads (pages.ts): the same quiet dot as the vault opening. */
function Wait({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page-wait" role="status" aria-label="Loading"><span className="dot-live" /></div>}>{children}</Suspense>;
}

function Vaulted({ page }: { page?: "campaigns" }) {
  const s = useVault();
  const pendingRecovery = usePendingRecovery();
  // After a refresh, reopen the vault if this device still holds an unexpired session.
  const [restoring, setRestoring] = useState(true);
  // Local first (V1.44, src/localfirst.ts): a local vault opens with the device's key; a move waiting to run means the
  // person signs in again (never a silently reopened session), so the move runs before the account opens.
  useEffect(() => { void (async () => { if (!(await localMoveWanted()) && (await restoreSession())) return; await bootLocal(); })().finally(() => setRestoring(false)); }, []);
  const lf = useLocalView();
  const [signIn, setSignIn] = useState(false);
  if (restoring && s.status !== "unlocked") return <div className="lock"><span className="dot-live" aria-label="Opening your vault" /></div>;
  if (!pendingRecovery && (lf.move.phase === "confirm" || lf.move.phase === "running" || lf.move.phase === "failed" || lf.move.phase === "key")) {
    return <MoveScreen look={PS ? "ps" : import.meta.env.MODE === "gos" ? "gos" : MWEB ? "mweb" : "web"} />;
  }
  // V1.44 Add friend: someone scanned a code and PS is not open here yet (views/AddFriend.tsx).
  if (s.status !== "unlocked" && !PS && !signIn && !pendingRecovery && pendingFriendLink()) return <FriendLanding onSignIn={() => setSignIn(true)} />;
  if (s.status !== "unlocked" || pendingRecovery) return PS && !pendingRecovery ? <PsLocked /> : <LockScreen />;
  if (page === "campaigns") return <Wait>{isRedAccount(s) ? <CampaignsPageView /> : <CampaignsNotForYou />}</Wait>;
  return s.role === "owner" ? <><OwnerShell /><FriendJoinCard /></> : <ClientShell />;
}

// What's new after an update (V1.36): the website here; PS shows it in its Tab list window (views/PsApp.tsx).
// V1.53: the phone shows it too, the first time it opens after an update. Its update card runs in the OLD app and can
// only list what that old version knew how to list, so the full list of skipped versions comes here, in the new one.
const WEBSITE_WN = !PS;

const NAV = [
  { href: "#/today", label: "Today", icon: "today" },
  { href: "#/todo", label: "To-do", icon: "todo" },
  { href: "#/clients", label: "Clients", icon: "clients" },
  { href: "#/proposals", label: "Pipeline", icon: "proposals" },
  { href: "#/meetings", label: "Meetings", icon: "meetings" },
  { href: "#/emails", label: "Emails", icon: "emails" },
  { href: "#/fitness", label: "Fitness", icon: "today" },
  { href: "#/settings", label: "Settings", icon: "settings" },
];
const BOTTOM = ["#/today", "#/todo", "#/clients", "#/proposals", "#/settings"];

// PS on the Mac: is a newer web build installed on this Mac (after the developer clicked Update now in the gear, or
// a release run on this Mac)? The Mac app says so. The website never asks here: it has its own quiet
// "New version, Reload" note (views/WebUpdateNote.tsx) and never reloads by itself (the developer, 4 Nov 2026).
function useUpdateAvailable() {
  const [avail, setAvail] = useState(false);
  useEffect(() => {
    if (!PS) return;
    const check = () => setAvail(psUpdateReady());
    check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, []);
  return avail;
}
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}
function agoText(iso: string | null) {
  if (!iso) return "not synced yet";
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h}h ago`;
}

// Refresh: pulls the latest data now. In PS on the Mac it also loads a newer web build that is already
// installed on this Mac (the vault stays unlocked through the reload, see restoreSession). On the website
// it only syncs: a new version there waits for the note's Reload.
function RefreshButton() {
  const s = useVault();
  const [busy, setBusy] = useState(false);
  const update = useUpdateAvailable();
  async function go() {
    setBusy(true);
    if (PS && psUpdateReady()) { toast("Loading the new version..."); location.reload(); return; }
    await sync();
    setBusy(false);
    toast(s.online ? "Up to date" : "Offline. Showing your saved copy");
  }
  return (
    <button className="btn quiet icon cv-refresh" onClick={() => void go()} disabled={busy}
      title={update ? "A new version is ready. Click to update" : "Refresh"} aria-label={update ? "Update to the new version" : "Refresh"}
      style={{ position: "relative" }}>
      <span style={{ display: "inline-flex", animation: busy ? "cv-spin 1s linear infinite" : undefined }}><Icon name="sync" /></span>
      {update && <span aria-hidden="true" style={{ position: "absolute", top: 4, right: 4, width: 9, height: 9, borderRadius: 99, background: "var(--pink)", boxShadow: "0 0 0 2px var(--bg)" }} />}
    </button>
  );
}

// Light / dark switch in the top bar. Saved in the vault settings (same as Settings > Theme),
// so it follows the developer to every device. "System" resolves to whatever the device shows now.
function ThemeToggle() {
  const s = useVault();
  const [local, setLocal] = useState<"light" | "dark" | null>(null);
  const pref = local ?? settingsData(s).theme;
  const sysDark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && sysDark);
  const next = dark ? "light" : "dark";
  return (
    <button className="btn quiet icon" onClick={() => {
      document.documentElement.setAttribute("data-theme", next); // instant, then saved for every device
      setLocal(next);
      void saveSettings({ theme: next }).catch(() => {});
    }}
      title={`Switch to ${next} mode`} aria-label={`Switch to ${next} mode`}>
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

// "Updated 2 min ago" on every screen: amber when older than 5 minutes, live dot when the
// realtime channel is connected.
function SyncPill() {
  const s = useVault();
  useTick(20_000);
  const off = !s.online;
  const stale = !s.lastSync || Date.now() - Date.parse(s.lastSync) > 5 * 60_000;
  const label = off ? "Offline" : s.pendingCount ? `Saving ${s.pendingCount}` : s.syncError ? "Sync issue" : `Updated ${agoText(s.lastSync)}`;
  const tone = off || s.syncError || stale ? "warn" : "good";
  return (
    <button className={`pill ${tone} cv-syncpill`} onClick={() => void sync()} style={{ border: 0 }}
      title={s.syncError || `${s.live ? "Live: changes arrive instantly. " : ""}Last synced ${s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : "never"}. Click to sync now.`}>
      {label}
    </button>
  );
}

function OwnerShell() {
  const s = useVault();
  const hash = useHash();
  // The website's other pages, fetched quietly once the list is up (pages.ts). PS on a Mac has them built in.
  useEffect(() => { if (!PS) prefetchPages(); }, []);
  useEffect(() => {
    const tick = () => { void maybeAutoReset(); void migrateClaudeAdds(); void migrateP1(); void migrateLooks(); };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);
  // Claude access (Settings): trust Claude's account in client workspaces. The id comes from the developer's
  // own encrypted settings, never from the server.
  const st = settingsData(s);
  useEffect(() => { setTrustedAgents(st.agentId ? [st.agentId] : []); }, [st.agentId]);
  // Waiting for Claude to use the invites the developer made for it: check every 15s, then save who it is.
  const pendingInvites = (st.agentInvites || []).join(",");
  useEffect(() => {
    if (!pendingInvites) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await confirmAgent(pendingInvites.split(","));
        if (stop || !r.agentId) return;
        if (st.agentId && st.agentId !== r.agentId) { toast("A different account used Claude's invites. Not trusted: revoke and start again in Settings.", undefined, 12000); return; }
        stop = true;
        await saveSettings({ agentId: r.agentId, agentInvites: [], agentSince: st.agentSince || new Date().toISOString() });
        const n = await agentWorkspaceCount(r.agentId);
        toast(`Claude can now open ${n} client workspace${n === 1 ? "" : "s"}. Your own vault stays yours only.`, undefined, 9000);
      } catch { /* try again on the next tick */ }
    };
    void check();
    const t = setInterval(() => void check(), 15_000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvites]);
  // Notification pop-ups (Tab list gear > Notification pop-ups): a toast here, a small pop-up at the
  // top right of the screen in PS (its window is usually hidden).
  // Do Not Disturb (core/dnd.ts) holds them: still in the history, and one pop-up says what came while it was on.
  useEffect(() => {
    const show = (text: string, card?: NoteCard) => { if (PS) psPost({ type: "notify", text, ...(card || {}) }); else toast(text, undefined, 6000); };
    const held: { text: string; card?: NoteCard }[] = [];
    setNotifySink((text, card) => {
      // History first (gear > Notification pop-ups > history): the last 24 hours, newest last.
      const st = settingsData(vaultStore.get());
      const since = Date.now() - 86400_000;
      const log = [...(st.notifyLog || []).filter((n) => Date.parse(n.at) > since), { at: new Date().toISOString(), text }].slice(-100);
      void saveSettings({ notifyLog: log });
      if (st.tmNotify === false) return;
      if (dndMutes(st.dnd, "vault")) { held.push({ text, card }); held.splice(0, held.length - 30); return; }
      show(text, card);
    });
    const flush = () => {
      if (!held.length || vaultStore.get().status !== "unlocked") return;
      const st = settingsData(vaultStore.get());
      if (dndMutes(st.dnd, "vault")) return;
      const list = held.splice(0);
      if (st.tmNotify === false) return;
      if (list.length === 1) return show(list[0].text, list[0].card);
      show(`While Do Not Disturb was on: ${list.length} notices`, { title: "While Do Not Disturb was on", sub: `${list.length} notices, newest last`, body: list.slice(-4).map((x) => x.text).join("\n") });
    };
    const off = vaultStore.subscribe(flush);
    const iv = window.setInterval(flush, 30_000);   // DND ending by its own clock changes nothing in the vault
    return () => { setNotifySink(null); off(); clearInterval(iv); };
  }, []);
  // A sealed import package (sent to this vault's public key) arrives through the inbox.
  useEffect(() => {
    setImportHandler(async (file) => {
      toast("Importing your clients and proposals. Keep this tab open...", undefined, 8000);
      const r = await runImport(parseImportFile(JSON.stringify(file)));
      toast(`Imported ${r.clients} clients and ${r.projects} projects${r.skipped.length ? `, skipped ${r.skipped.length} already here` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}`, undefined, 12000);
    });
    // The developer texted his Telegram bot "AT <task>": it waits in New tasks (the big pop-up in the Tab
    // list) until he accepts or declines it. With ASAP in it, accepting puts it on Urgent
    // instead of the list (the developer, 17 Oct 2026); "AT Dimension X / Upside Down / Actionables ..."
    // makes that Dimension X band the place accepting puts it. It never skips the pop-up.
    setTelegramHandler(async (raw) => {
      const t = raw as { id?: string; text?: string; asap?: boolean; zone?: string | null; at?: string };
      const text = String(t?.text || "").trim().slice(0, 300);
      if (!text) return;
      const asap = t.asap === true;
      const zone = t.zone === "act" || t.zone === "soon" || t.zone === "x" ? t.zone : null;
      const where = zone ? ` for ${({ act: "Actionables", soon: "the Upside Down", x: "Dimension X" } as const)[zone]}` : "";
      await suggestTodo({ title: text, type: "once", clientId: null, note: null, claudeDone: false, asap, from: "telegram", zone });
      notify(`${asap ? "ASAP" : "Task"} from Telegram${where}: ${text}`, { title: `${asap ? "ASAP" : "Task"} from Telegram`, sub: `Waiting in New tasks${where}`, body: text });
    });
    // Sealed edit packages, eg rename a client, set its tab or order.
    setOpsHandler(async (ops) => {
      type Op =
        | { op: "updateClient"; name: string; set: Partial<ClientRec> }
        | { op: "upsertTask"; name: string; project: string; match: string; set: { title: string; detail?: string | null; due?: string | null } }
        | { op: "attachDoc"; name: string; project: string; label: string; docKind: "proposal" | "agreement" | "other"; file: string; fileName: string; mime?: string }
        | { op: "putBrief"; name?: string; brief: Brief }
        | { op: "putCampaignStats"; stats: CampaignStats }
        | { op: "putCampaignsPage"; gz: string }
        | { op: "addTodo"; name?: string; title: string; due?: string | null; type?: "daily" | "once"; claudeNote?: string | null }
        | { op: "claudeTick"; name?: string; match: string; note: string; addIfMissing?: boolean }
        | { op: "addSubtask"; match: string; title: string; note?: string | null }
        | { op: "claudeTickSubtask"; match: string; sub: string; note: string; addIfMissing?: boolean }
        | { op: "upsertProject"; name: string; title: string; type: ProjectType; pipeline?: Pipeline; proposal?: Partial<Proposal>; promisedDelivery?: string | null }
        | { op: "setPayments"; name: string; project: string; payments: Omit<Payment, "id">[] }
        | { op: "pruneInstantly"; keep: number }
        | { op: "updateSettings"; set: { birthday?: string | null } }
        | { op: "numPeople"; people: { name: string; birthday: string; me?: boolean }[] }
        | { op: "fitPlans"; programs: PlanIn[]; activate?: string | null }
        | { op: "meetingNotes"; eventId?: string; title?: string; start?: string; items: string[]; every?: boolean }
        | { op: "chatDone"; id: string; chat: string; at: string }
        | { op: "updateProject"; name: string; project: string; set: { pipeline?: Pipeline; startsMonth?: string | null; price?: number | null; priceUnit?: "month" | "video" | null } }
        | { op: "tickTask"; name: string; project: string; match: string; done: boolean; by?: string; at?: string }
        | { op: "setStage"; name: string; project: string; current: number; doneAt?: Record<string, string>; nowLine?: string | null; nowWindow?: string | null }
        | { op: "addPreview"; name: string; project: string; stage: string; label: string; url: string; note?: string | null; expiresAt?: string | null }
        | { op: "psPrivateNotes"; version: string; notes: string[] }
        | { op: "rewindMoney"; months: unknown }
        | { op: "sqPastBoards"; months?: unknown; remove?: unknown };
      const list = Array.isArray(ops) ? ops as Op[] : [];
      let done = 0;
      const missing: string[] = [];
      const findClient = (n: string) => docs<ClientRec>("client").find((d) => d.data.name.trim().toLowerCase() === n.trim().toLowerCase());
      const findProject = (ws: string, t: string) => projectViews(vaultStore.get(), ws).find((p) => p.p.title.toLowerCase().includes(t.toLowerCase()));
      // A package with a step this version does not know is left in the inbox (the throw
      // below stops it being deleted) so a newer version can apply it. Known steps are
      // idempotent, so applying them again later is safe.
      const KNOWN = new Set(["updateClient", "upsertTask", "attachDoc", "putBrief", "putCampaignStats", "putCampaignsPage", "addTodo", "claudeTick", "addSubtask", "claudeTickSubtask", "upsertProject", "setPayments", "updateProject", "pruneInstantly", "updateSettings", "tickTask", "setStage", "addPreview", "meetingNotes", "chatDone", "numPeople", "fitPlans", "psPrivateNotes", "rewindMoney", "sqPastBoards"]);
      const unknown = list.filter((o) => !KNOWN.has((o as { op: string }).op));
      if (unknown.length) throw new Error(`Package needs a newer app version (${unknown.map((o) => (o as { op: string }).op).join(", ")})`);
      // Never apply against an empty vault: keep the package for the next sync instead.
      if (list.some((o) => "name" in o && o.name) && !docs<ClientRec>("client").length) throw new Error("Client list not loaded yet");
      for (const o of list) {
        if (o.op === "psPrivateNotes") {
          // The developer's private release notes for one PS version (core/privatenotes.ts, sealed by scripts/ps-private.ts at
          // release time): one owner-only record per version. Only the developer's own vault inbox ever gets this step.
          if (!vaultStore.get().red) continue;
          const plan = privateNotesPlan(o, docs<PrivateNotes>("psnote"));
          if (plan.act === "put") { await put<PrivateNotes>("psnote", plan.data, { id: plan.id, ws: null }); for (const id of plan.extra) await remove(id); }
          else if (plan.act === "remove") for (const id of plan.ids) await remove(id);
          continue;   // the What's new panel is its notice (quietOp)
        }
        if (o.op === "rewindMoney") {
          // Rewind (PS 1.64): months of money in from the squad's board, for the person's own recap. Write only: it adds
          // into their sealed Rewind and nothing about Rewind ever goes back (src/rewind.ts, core/rewind.ts moneyRecs).
          await rewindAddMoney(o.months);
          continue;
        }
        if (o.op === "sqPastBoards") {
          // G Squad Past boards (PS 1.64, core/squadpast.ts; sealed by scripts/gsquad-past.ts after the developer approved the
          // exact entries): one record per month in the owner's vault; his PS publishes them to the squad (squad/board.ts).
          if (!vaultStore.get().red) continue;
          const have = new Map(docs<unknown>("sqpast").map((d) => [cleanPastDoc(d.data)?.month ?? "", d]));
          for (const m of cleanPastMonths({ months: o.months })) {
            const old = have.get(m.month);
            if (old && JSON.stringify(cleanPastDoc(old.data)) === JSON.stringify({ month: m.month, data: m })) continue;
            await put("sqpast", { month: m.month, data: m }, old ? { id: old.id, ws: null } : { ws: null });
            done++;
          }
          for (const month of Array.isArray(o.remove) ? o.remove.filter((x): x is string => typeof x === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(x)).slice(0, 36) : []) {
            const old = have.get(month);
            await put("sqpast", { month, removed: true }, old ? { id: old.id, ws: null } : { ws: null });
            done++;
          }
          continue;
        }
        if (o.op === "chatDone") {
          // A Claude Code chat finished (core/chatdone.ts): a card on the Mac and the phone (mailcards.ts).
          const d = chatDoneFrom(o);
          if (d) { const cur = settingsData(vaultStore.get()); await saveSettings({ chatDone: addChatDone(cur.chatDone, d, Date.now(), cur.dnd) }); }
          continue;   // its own card is the notice: never "Claude updated your vault" (quietOp)
        }
        if (o.op === "meetingNotes") {
          // Notes for a meeting (the pop-up and the Meetings panel), by event id or title and start time.
          const cal = mainCalendar(docs<CalendarSnap>("calendar"));   // the usual calendar (core/calfeeds.ts)
          const st = settingsData(vaultStore.get());
          const r = applyNotesOp(o, shownEvents(cal?.data.events || [], st.calChoices), st.meetingNotes || [], st.standingNotes || [], () => crypto.randomUUID());
          if (!r) throw new Error("Meeting not in the calendar yet");   // the package waits in the inbox and tries again
          await saveSettings({ meetingNotes: r.meetingNotes, standingNotes: r.standingNotes });
          done++;
          continue;
        }
        if (o.op === "fitPlans") {
          // The developer's own workout plans for Fitness, joined in by name: a plan he already has is never touched.
          if (!docs<ClientRec>("client").length) throw new Error("Vault not loaded yet");   // never judge "already there" on an empty vault
          for (const pl of Array.isArray(o.programs) ? o.programs : []) {
            const prog = programFromPlan(pl);
            if (!prog || fitnessNow().programs.some((d) => d.data.name.trim().toLowerCase() === prog.name.toLowerCase())) continue;
            await addProgram(prog, { activate: prog.name === o.activate || !fitnessNow().program });
            done++;
          }
          continue;
        }
        if (o.op === "numPeople") {
          // People for the Tab list's Numerology, joined in by name: nobody already there is changed.
          const st = settingsData(vaultStore.get());
          const cur = peopleOf(st.tmNumPeople, st.birthday);
          const next = mergePeople(cur, o.people, () => crypto.randomUUID());
          if (next.length !== cur.length || !st.tmNumPeople) { await saveSettings({ tmNumPeople: next }); done++; }
          continue;
        }
        if (o.op === "updateSettings") {
          // Only the fields Claude may set for the developer (his birthday for the numbers on Today).
          const b = o.set?.birthday;
          // An empty one changes nothing and says nothing (Claude uses it to time how fast PS picks packages up).
          if (b === null || (typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b))) { await saveSettings({ birthday: b }); done++; }
          continue;
        }
        if (o.op === "pruneInstantly") {
          // The developer only wants the newest Instantly emails kept (the rest are preview copies).
          const keep = Math.max(0, Number(o.keep) || 0);
          const list = docs<IEmail>("iemail").sort((a, b) => (b.data.at || "").localeCompare(a.data.at || ""));
          for (const d of list.slice(keep)) await remove(d.id);
          continue;   // housekeeping, nothing to tell the developer (quietOp)
        }
        if (o.op === "putBrief") {
          // One brief per date: replace the existing one for that day.
          const ex = docs<Brief>("brief").find((d) => d.data.date === o.brief.date);
          await put<Brief>("brief", { ...o.brief, createdAt: o.brief.createdAt || new Date().toISOString() }, { id: ex?.id, ws: null });
          done++;
          continue;
        }
        if (o.op === "putCampaignsPage") {
          // The full Cincee Campaigns dashboard (cincee.com/campaigns): one encrypted blob, newest only.
          await storeCampaignsPage(o.gz);
          done++;
          continue;
        }
        if (o.op === "putCampaignStats") {
          // Campaign statistics for the Tab list (one record: the newest export replaces it).
          const st = o.stats;
          if (!st || st.v !== 1 || typeof st.dataThrough !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(st.dataThrough) || !st.day || !st.instantly || !st.gmail) { missing.push("campaign stats (bad package)"); continue; }
          const all = docs<CampaignStats>("cstats").sort((a, b) => (b.data.exportedAt || "").localeCompare(a.data.exportedAt || ""));
          if (all[0] && (all[0].data.exportedAt || "") > (st.exportedAt || "")) { done++; continue; }   // an older export arriving late
          await put<CampaignStats>("cstats", st, { id: all[0]?.id, ws: null });
          for (const d of all.slice(1)) await remove(d.id);
          done++;
          continue;
        }
        if (o.op === "addTodo") {
          const cl = o.name ? findClient(o.name) : undefined;
          const dup = docs<Todo>("todo").some((d) => !d.data.clearedAt && !d.data.done && d.data.title.toLowerCase() === o.title.toLowerCase());
          // Claude suggests, the developer decides: it waits in New tasks until he accepts or declines it.
          if (!dup) await suggestTodo({ title: o.title, due: o.due ?? null, type: o.type ?? "once", clientId: cl?.id ?? null,
            note: o.claudeNote ?? null, claudeDone: !!o.claudeNote });
          done++;
          continue;
        }
        if (o.op === "claudeTick") {
          // Claude finished a task in a chat: purple tick, the developer's own tick still completes it.
          const t = docs<Todo>("todo").find((d) => !d.data.clearedAt && !d.data.done && d.data.title.toLowerCase().includes(o.match.toLowerCase()));
          if (t) await updateTodo(t.id, { claudeDoneAt: new Date().toISOString(), claudeNote: o.note });
          else if (o.addIfMissing) {
            const cl = o.name ? findClient(o.name) : undefined;
            await suggestTodo({ title: o.match, type: "once", clientId: cl?.id ?? null, note: o.note, claudeDone: true });
          } else { missing.push(`to-do "${o.match}"`); continue; }
          done++;
          continue;
        }
        if (o.op === "addSubtask" || o.op === "claudeTickSubtask") {
          // Mini tasks under one of the developer's tasks, the parent found by the words of its title.
          // addSubtask adds one (never twice); claudeTickSubtask gives one a purple tick (the developer's tick still completes it).
          const parent = docs<Todo>("todo").find((d) => !d.data.clearedAt && !d.data.done && titleMatches(d.data.title, o.match));
          if (!parent) { missing.push(`to-do "${o.match}"`); continue; }
          const subs = parent.data.subtasks || [];
          const at = new Date().toISOString();
          if (o.op === "addSubtask") {
            const title = String(o.title || "").trim().slice(0, 300);
            if (title && !subs.some((x) => x.title.toLowerCase() === title.toLowerCase()))
              await updateTodo(parent.id, { subtasks: [...subs, { id: newSubId(), title, done: false, ...(o.note ? { claudeDoneAt: at, claudeNote: String(o.note).slice(0, 300) } : {}) }] });
          } else {
            const hit = subs.find((x) => !x.done && titleMatches(x.title, o.sub));
            if (hit) await updateTodo(parent.id, { subtasks: subs.map((x) => (x.id === hit.id ? { ...x, claudeDoneAt: at, claudeNote: String(o.note || "done").slice(0, 300) } : x)) });
            else if (o.addIfMissing && String(o.sub || "").trim()) await updateTodo(parent.id, { subtasks: [...subs, { id: newSubId(), title: String(o.sub).trim().slice(0, 300), done: false, claudeDoneAt: at, claudeNote: String(o.note || "done").slice(0, 300) }] });
            else { missing.push(`mini task "${o.sub}" under "${o.match}"`); continue; }
          }
          done++;
          continue;
        }
        const c = o.name ? findClient(o.name) : undefined;
        if (!c) { missing.push(o.name || "(no name)"); continue; }
        if (o.op === "setPayments") {
          // Replace a project's payment schedule (eg a 3 way split with two already paid).
          const pv = findProject(c.data.ws, o.project);
          if (!pv) { missing.push(`${o.name}: ${o.project}`); continue; }
          await updateProject(pv.doc.id, { payments: o.payments.map((x) => ({ ...x, id: crypto.randomUUID() })) });
          done++;
          continue;
        }
        if (o.op === "tickTask") {
          // A client task done (or undone) on the client's behalf, with the real date it happened.
          // The newest tick per task wins, whoever wrote it.
          const pv = findProject(c.data.ws, o.project);
          const t = pv?.tasks.find((x) => x.doc.data.title.toLowerCase().includes(o.match.toLowerCase()));
          if (!pv || !t) { missing.push(`${o.name}: task "${o.match}"`); continue; }
          const at = o.at && !Number.isNaN(Date.parse(o.at)) ? new Date(o.at).toISOString() : new Date().toISOString();
          const mine = docs<Tick>("tick", pv.ws).find((x) => x.data.taskId === t.doc.id && x.author === vaultStore.get().userId);
          await put<Tick>("tick", { taskId: t.doc.id, done: !!o.done, at, by: o.by || null }, { id: mine?.id, ws: pv.ws });
          done++;
          continue;
        }
        if (o.op === "setStage") {
          // Move the tracker, then put the real finish dates on the stages behind it.
          const pv = findProject(c.data.ws, o.project);
          if (!pv) { missing.push(`${o.name}: ${o.project}`); continue; }
          await setStage(pv.doc.id, Math.max(0, Math.floor(Number(o.current) || 0)));
          const dates = o.doneAt || {};
          await updateProject(pv.doc.id, (p) => ({ ...p,
            stages: p.stages.map((st) => (dates[st.key] && /^\d{4}-\d{2}-\d{2}$/.test(dates[st.key]) && st.doneAt ? { ...st, doneAt: dates[st.key] } : st)),
            ...(o.nowLine !== undefined ? { nowLine: o.nowLine } : {}),
            ...(o.nowWindow !== undefined ? { nowWindow: o.nowWindow } : {}) }));
          done++;
          continue;
        }
        if (o.op === "addPreview") {
          // A live preview link on a stage (eg the design directions). Skips a link already there.
          const pv = findProject(c.data.ws, o.project);
          const st = pv?.p.stages.find((x) => x.key === o.stage);
          if (!pv || !st) { missing.push(`${o.name}: ${o.project} stage ${o.stage}`); continue; }
          if (!/^https:\/\//.test(o.url)) { missing.push(`${o.name}: preview link must be https`); continue; }
          if (!st.previews.some((x) => x.url === o.url)) await addPreview(pv.doc.id, o.stage, { label: o.label, url: o.url, note: o.note ?? undefined, expiresAt: o.expiresAt ?? null });
          done++;
          continue;
        }
        if (o.op === "updateProject") {
          // Small corrections: stage, a later start month, the price or its unit (per month / per video).
          const pv = findProject(c.data.ws, o.project);
          if (!pv) { missing.push(`${o.name}: ${o.project}`); continue; }
          const { pipeline, startsMonth, price, priceUnit } = o.set;
          await updateProject(pv.doc.id, (p) => ({ ...p,
            ...(pipeline !== undefined ? { pipeline } : {}),
            ...(startsMonth !== undefined ? { startsMonth } : {}),
            proposal: { ...p.proposal, ...(price !== undefined ? { price } : {}), ...(priceUnit !== undefined ? { priceUnit } : {}) } }));
          done++;
          continue;
        }
        if (o.op === "upsertProject") {
          // A proposal written in a chat lands in the Pipeline (hidden from the client until shown).
          const ex = findProject(c.data.ws, o.title);
          if (ex) {
            await updateProject(ex.doc.id, (p) => ({ ...p, pipeline: o.pipeline ?? p.pipeline,
              promisedDelivery: o.promisedDelivery ?? p.promisedDelivery,
              proposal: { ...p.proposal, ...(o.proposal || {}), scope: o.proposal?.scope ?? p.proposal.scope,
                links: [...(o.proposal?.links || []), ...(p.proposal.links || []).filter((l) => !(o.proposal?.links || []).some((n) => n.url === l.url))] } }));
          } else {
            await addProject(c.data.ws, o.type, o.title, { pipeline: o.pipeline ?? "proposal_sent", promisedDelivery: o.promisedDelivery ?? null,
              proposal: { scope: [], status: "draft", ...(o.proposal || {}) } });
          }
          done++;
          continue;
        }
        if (o.op === "updateClient" && o.set) {
          const { name, status, order, timezone, contactName, greetingName } = o.set;
          await updateClient(c.id, Object.fromEntries(Object.entries({ name, status, order, timezone, contactName, greetingName }).filter(([, v]) => v !== undefined)));
          done++;
        } else if (o.op === "upsertTask") {
          const pv = findProject(c.data.ws, o.project);
          if (!pv) { missing.push(`${o.name}: ${o.project}`); continue; }
          const t = pv.tasks.find((x) => x.doc.data.title.toLowerCase().includes(o.match.toLowerCase()));
          if (t) await put<CTask>("ctask", { ...t.doc.data, ...o.set }, { id: t.doc.id, ws: t.doc.ws });
          else await addClientTask(pv.doc.id, pv.ws, { title: o.set.title, detail: o.set.detail ?? undefined, due: o.set.due ?? null });
          done++;
        } else if (o.op === "attachDoc") {
          const pv = findProject(c.data.ws, o.project);
          if (!pv) { missing.push(`${o.name}: ${o.project}`); continue; }
          const already = [...vaultStore.get().docs.values()].some((d) => d.kind === "doc" && (d.data as ProjectDoc).projectId === pv.doc.id && (d.data as ProjectDoc).name === o.fileName);
          if (!already) {
            const bin = atob(o.file);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await attachDoc(pv.doc.id, { bytes, name: o.fileName, mime: o.mime || "application/pdf" }, o.label, o.docKind);
          }
          done++;
        }
      }
      opsTally.done += done;
      opsTally.missing.push(...missing);
      for (const p of describeOps(list as { op: string; name?: string }[])) if (!opsTally.parts.includes(p)) opsTally.parts.push(p);
      clearTimeout(opsTally.timer);
      // Several packages arriving together get one message, not a stack of them.
      opsTally.timer = setTimeout(() => {
        const { done: d, missing: m, parts } = opsTally;
        opsTally.done = 0; opsTally.missing = []; opsTally.parts = [];
        if (d) notify(`Claude updated your vault: ${parts.join(", ") || `${d} change${d === 1 ? "" : "s"}`}`);
        if (m.length) toast(`Not found in a Claude update: ${m.join(", ")}`, undefined, 9000);
      }, 800);
    });
    void sync();
    return () => { setImportHandler(null); setOpsHandler(null); };
  }, []);
  // PS Mac app: the To-do page only, same data and same top bar tools.
  if (PS) return <PsLayout tools={<><SyncPill /><RefreshButton /><ThemeToggle /></>} />;
  // Meetings (Fireflies, his calendar) are the developer's own; other owners never see the page.
  const red = isRedAccount(s);
  void hash;   // useHash above redraws this on every page change
  const { page, parts } = pageOf(red);
  const items = agenda(s, 0);
  const due = items.filter((i) => i.late || i.today || i.kind === "approval" || i.kind === "draft").length;
  const drafts = items.filter((i) => i.kind === "draft").length;
  const badge = (href: string) => href === "#/today" ? due : href === "#/emails" ? drafts : 0;
  const cur = (href: string) => (href.slice(2) === page || (page === "client" && href === "#/clients") || (page === "preview" && href === "#/clients")) ? "page" : undefined;

  const nav = red ? NAV : NAV.filter((n) => n.href !== "#/meetings");
  let body;
  // To-do: the Tab list itself, in web form (V1.44, views/WebTodo.tsx). The mobile web app keeps the old page.
  if (page === "todo") body = MWEB ? <TodoView /> : <WebTodoView />;
  else if (page === "clients") body = <ClientsView />;
  else if (page === "client" && parts[1]) body = <ClientDetailView clientId={parts[1]} projectId={parts[2] === "project" ? parts[3] : undefined} />;
  else if (page === "preview" && parts[1]) body = <PreviewAsClient ws={parts[1]} />;
  else if (page === "proposals") body = <ProposalsView />;
  else if (page === "meetings" && red) body = <MeetingsView />;
  else if (page === "emails") body = <EmailsView />;
  else if (page === "settings") body = <SettingsView />;
  else if (page === "fitness") body = <FitnessPage />;
  else body = <TodayView />;

  return (
    <>
      <header className="top">
        <div className="wrap">
          {/* G Squad, the mobile web app: its own name and mark for everyone but the developer (his account keeps the website's). */}
          {MWEB && !red
            ? <a className="brand psm-brand" href="#/today"><AppMark size={28} /> {MOBILE_APP_NAME}</a>
            : <a className="brand" href="#/today"><Logo /> Cincee <small>VAULT</small></a>}
          <nav className="nav" aria-label="Main">
            {nav.map((n) => (
              <a key={n.href} href={n.href} aria-current={cur(n.href)}>{n.label}{badge(n.href) > 0 && <span className="badge num">{badge(n.href)}</span>}</a>
            ))}
          </nav>
          <span className="spacer" />
          <PsOpenPill />
          <WebUpdateNote />
          <SyncPill />
          <RefreshButton />
          <ThemeToggle />
          <button className="btn quiet icon" onClick={lock} title="Lock now" aria-label="Lock now"><Icon name="lock" /></button>
        </div>
      </header>
      <main className="page wrap" key={page}><WebUpdateBanner /><Wait>{body}</Wait></main>
      <NotesDock />
      {/* Holding Tab in the browser (V1.44): the developer's own, and not on To-do, which is the list already. Everyone else has
          the list on To-do, with the keyboard's Tab left for moving between buttons. */}
      {red && page !== "todo" && <TaskMap />}
      {WEBSITE_WN && <WhatsNewHost />}
      {WEBSITE_WN && import.meta.env.MODE !== "gos" && !MWEB && <PosturePopupHost />}{/* the Posture reminder pop-up on the website (PS 1.65); the Mac draws its own card */}
      {WEBSITE_WN && import.meta.env.MODE !== "gos" && !MWEB && <ChecklistReminderHost />}{/* the Checklist reminder's pop-up on the website (PS 1.65, views/ChecklistReminder.tsx); the Mac draws its own */}
      {WEBSITE_WN && <FeatureIntroHost />}{/* the same "Did you know?" intro, plain, for the website and the phone */}
      {WEBSITE_WN && <NewPopupsHost />}{/* the "new in this version" pop-ups (V1.56): only the open source one can show on the website */}
      {WEBSITE_WN && <TipsHost />}{/* the first use tips (V1.55, views/Tips.tsx): only where the list shows them something to point at */}
      {red && <RuleBookHost owner="docked" />}
      {mailOnSnap(s) && <MailCardsWeb />}
      {WEBSITE_WN && <SquadNoteCards />}{/* G Squad message cards (PS 1.60, views/SquadNoteCards.tsx): the website only */}
      <nav className="bottom" aria-label="Main">
        {BOTTOM.map((h) => { const n = NAV.find((x) => x.href === h)!; return (
          <a key={h} href={h} aria-current={cur(h)}><Icon name={n.icon} />{n.label}{badge(h) > 0 && <span className="badge num">{badge(h)}</span>}</a>
        ); })}
      </nav>
    </>
  );
}

function PreviewAsClient({ ws }: { ws: string }) {
  const s = useVault();
  const view = clientViews(s).find((c) => c.ws === ws);
  if (!view) return <div className="empty">Client not found.</div>;
  const visible = { ...view, projects: view.projects.filter((p) => p.p.clientVisible !== false && !p.p.archived) };
  return (
    <div className="stack">
      <div className="banner pinkish no-print"><Icon name="eye" /> You are seeing exactly what {view.name} sees. Their ticks and approvals are theirs; yours here are not saved.</div>
      <Wait><ClientPortal view={visible} preview /></Wait>
      <a className="btn ghost" href={view.client ? `#/client/${view.client.id}` : "#/clients"} style={{ justifySelf: "start" }}><Icon name="back" /> Back to {view.name}</a>
    </div>
  );
}

function ClientShell() {
  const s = useVault();
  const views = clientViews(s);
  const [i, setI] = useState(0);
  const view = views[Math.min(i, views.length - 1)];
  return (
    <>
      <header className="top">
        <div className="wrap">
          <span className="brand"><Logo /> Cincee</span>
          {views.length > 1 && (
            <div className="tabs" role="tablist">
              {views.map((v, j) => <button key={v.ws} className="tab" role="tab" aria-selected={j === i} onClick={() => setI(j)}>{v.name}</button>)}
            </div>
          )}
          <span className="spacer" />
          <WebUpdateNote />
          <SyncPill />
          <RefreshButton />
          <button className="btn quiet icon" onClick={lock} title="Lock" aria-label="Lock"><Icon name="lock" /></button>
        </div>
      </header>
      <main className="page wrap" style={{ paddingBottom: 60 }}>
        <WebUpdateBanner />
        {view ? <Wait><ClientPortal view={view} /></Wait>
          : !s.lastSync && s.online ? <div className="empty"><span className="dot-live" style={{ display: "inline-block", marginRight: 10 }} />Decrypting your project page...</div>
          : <div className="empty">Your project page is being set up. Check back soon.</div>}
      </main>
    </>
  );
}
