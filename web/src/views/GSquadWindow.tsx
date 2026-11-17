// G Squad screen (V1.47), the developer 10 Nov 2026: "Redesign the G Squad interface on the macOS app. It looks like a macOS app
// pop up, a bit weird. Make it a full screen thing, a bit like a Telegram chat, but make everything much bigger, make
// the settings more intuitive so it's simpler and easier to navigate, and let you adjust appearance options."
// PS's own messenger layout (no other app's name, logo, icons or colours). It fills the Tab list's screen (no Mac window
// buttons, no small size): on the left the squad and one big row per section (Chat, Tasks, Fitness, Leaderboard, Screen
// time, Members) with Squad settings at the bottom; the open section on the right under its own header, Close at the
// top right. It grows out of the G Squad button and shrinks back into it. Esc (and the phone's back gesture) steps
// back one layer (a Fitness sheet, an edit or a form step, a settings page, the list on a narrow screen), then closes.
// On a phone (GOS, the iPhone web app) the same screens show one at a time. Colours come from the PS look (--k-*),
// unless Appearance in Squad settings picks light or dark, a colour, bubbles, text size or a background.
// The rules live in squad/window.ts, squad/single.ts and squad/looks.ts; this file only draws.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { psPost } from "../ps";
import { squadOp } from "../squad/mirror";
import { onSquadTabs, squadTabs, type SquadTabProps } from "../squad/tabs";
import { workingLine, type SquadView } from "../squad/view";
import { useChat } from "../squad/chatmirror";
import { useGymSquad } from "../squad/gymclient";
import { popBack } from "../squad/back";
import { holdChatOpen } from "../squad/chathold";
import {
  boardRow, chatRow, escStep, firstSection, fitnessRow, membersRow, NARROW_PX, screenRow, settingsRow, tasksRow,
  type LastLine, type RowInfo,
} from "../squad/window";
import { listTime, unreadText } from "../squad/chatgroups";
import { THE_SQUAD, type SettingsPage } from "../squad/single";
import { looksClass, looksVars } from "../squad/looks";
import { signalOn } from "../squad/signal";
import { todayISO } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { MembersButton, MembersList } from "./GSquadMembers";
import { GroupCard, NewGroupCard } from "./GSquadGroups";
import { SettingsIcon, SquadSettings, useShownLooks } from "./GSquadSettings";
import { ConvAvatar, ConvRow, openConv, useConvs, v3On, v3Op } from "./GSquadV3";
import { clampWin, dragWin, floats, readWin, saveWin, type WinSize } from "../core/gswinsize";
import "./gswin.css";
import "./gswnew.css";
import "./gssignal.css";
import "./gssignal3.css";

// ---------- small parts ----------
function Svg({ children, size = 24, w = 1.9 }: { children: ReactNode; size?: number; w?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
const ICONS: Record<string, ReactNode> = {
  chat: <Svg><path d="M4.5 6.8c0-1.3 1-2.3 2.3-2.3h10.4c1.3 0 2.3 1 2.3 2.3v7.4c0 1.3-1 2.3-2.3 2.3H10l-4.2 3.2c-.5.4-1.3 0-1.3-.6V6.8z" /><path d="M8.5 9.6h7M8.5 12.6h4.4" /></Svg>,
  tasks: <Svg><path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" /><path d="M4 6.4l1.3 1.3L7.4 5.4M4 11.9l1.3 1.3 2.1-2.3M4 17.4l1.3 1.3 2.1-2.3" /></Svg>,
  fitness: <Svg><path d="M6.5 8v8M17.5 8v8M3.8 10v4M20.2 10v4M6.5 12h11" /></Svg>,
  leaderboard: <Svg><path d="M8 4.5h8v4.8a4 4 0 0 1-8 0V4.5z" /><path d="M8 6.2H5.2c0 2.4 1.2 3.9 3.1 4.2M16 6.2h2.8c0 2.4-1.2 3.9-3.1 4.2M12 13.3v3.2M8.6 19.5h6.8M9.8 16.5h4.4v3H9.8z" /></Svg>,
  screen: <Svg><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M9 19.5h6M12 16v3.5M12 7.8v2.8l1.9 1.2" /></Svg>,
  members: <Svg><circle cx="9" cy="8.4" r="3.1" /><path d="M3.6 19c.5-3.2 2.7-5.1 5.4-5.1s4.9 1.9 5.4 5.1" /><circle cx="17" cy="9.2" r="2.4" /><path d="M16.2 14.1c2.3 0 3.9 1.6 4.3 4.4" /></Svg>,
  settings: <SettingsIcon />,
};
const TONE: Record<string, string> = { chat: "acc", tasks: "info", fitness: "fit", leaderboard: "warn", screen: "acc2", members: "ok", settings: "mute" };
const SUBTITLE: Record<string, string> = {
  tasks: "Shared tasks and hand overs", fitness: "Gym boards, bests and challenges", leaderboard: "Money made and tasks done",
  screen: "Each person's daily total, never which apps", members: "Who is in, invite and approve", settings: "Sharing, your name, notifications and appearance",
};
function Lock() { return <Svg size={13} w={2.2}><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" /></Svg>; }
const CloseIcon = () => <Svg size={20} w={2.2}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></Svg>;
const PlusIcon = () => <Svg size={20} w={1.8}><path d="M12 5.5v13M5.5 12h13" /></Svg>;
const PeopleIcon = () => <Svg size={20} w={1.7}><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.5-3 2.6-4.6 5.5-4.6s5 1.6 5.5 4.6" /><circle cx="17" cy="9.8" r="2.3" /><path d="M16.5 14.6c2.2 0 3.7 1.3 4.2 3.8" /></Svg>;
const BackIcon = () => <Svg size={22} w={2.4}><path d="M14.5 5.5L8 12l6.5 6.5" /></Svg>;

const rowTime = (iso: string) => listTime(iso);

// ---------- what stays between openings (memory only) ----------
let lastSection: string | null = null;
let lastLine: LastLine | null = null;          // the newest chat message seen in this PS run; never written to disk
const FIT_SEEN = "gsquad.fitSeen";              // the day you last opened Fitness here (no squad data, just a date)
const readSeen = () => { try { return localStorage.getItem(FIT_SEEN); } catch { return null; } };
const markSeen = () => { try { localStorage.setItem(FIT_SEEN, todayISO()); } catch { /* storage off */ } };

const safeLocal = (): Storage | null => { try { return localStorage; } catch { return null; } };
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.22, 1, .36, 1)";
/** PS's own text size (core/looks.ts puts it on the page); Appearance's text size multiplies it. */
const psFs = () => { try { return parseFloat(document.documentElement.style.getPropertyValue("--k-fs")) || 1; } catch { return 1; } };
const PHONE = import.meta.env.MODE === "gos" || (globalThis as { __psMobile?: unknown }).__psMobile === true;

export interface GSquadWindowProps {
  /** The G Squad button it grows out of (none on the phone: it rises from the bottom). */
  anchor: React.RefObject<HTMLElement | null> | null;
  onClose: () => void;
  v: SquadView;
  props: SquadTabProps;
  /** A section asked for from outside (the chat hook opens on Chat), and the way to say it was taken. */
  asked: string | null;
  onAsked: () => void;
  Icon: (p: { size?: number }) => ReactNode;
  welcome: ReactNode;
  /** Requests to join, pinned under every section's header but Members (which lists them itself). */
  asks: ReactNode;
  /** Pinned under every section's header: Set up The G Squad (the developer's PS), the older squad card. */
  pins?: ReactNode;
}

export function GSquadWindow({ anchor, onClose, v, props, asked, onAsked, Icon, welcome, asks, pins }: GSquadWindowProps) {
  const win = useRef<HTMLDivElement>(null);
  const tabs = useSyncExternalStore(onSquadTabs, squadTabs);
  const ids = useMemo(() => [...tabs.map((t) => t.id), "settings"], [tabs]);
  const chat = useChat();
  const gym = useGymSquad();
  const looks = useShownLooks();
  const [vw, setVw] = useState(() => window.innerWidth);
  const [vh, setVh] = useState(() => window.innerHeight);
  const [tab, setTab] = useState<string>(() => firstSection({ asked, waiting: v.in ? v.waiting : 0, last: lastSection, ids }));
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [list, setList] = useState(() => PHONE && !asked);   // narrow screens: the list instead of the section (the phone opens on the list)
  const [seen, setSeen] = useState(readSeen);
  const [grp, setGrp] = useState<null | "new" | "info">(null);   // PS 1.65: the new group card, or the open group's card
  const [people, setPeople] = useState(false);   // PS 1.64: the members list from the pictures at the top right
  const leaving = useRef(false);
  const narrow = PHONE || vw < NARROW_PX;
  // PS 1.65 (feature gsquad-v3): the Signal style window. On a wide screen it is a window of its own size that grows out of
  // the G Squad button and can be resized (the size is kept on this device); on a phone it fills the screen.
  const v3 = v3On() && looks.look === "new";
  const float = v3 && floats(narrow, PHONE);
  const panel = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<WinSize>(() => readWin(safeLocal()));
  const sizeNow = clampWin(size, vw, vh);
  const conv = useConvs(v);

  useEffect(() => {
    const f = () => { setVw(window.innerWidth); setVh(window.innerHeight); };
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  useEffect(() => { if (asked) { setTab(asked); setList(false); onAsked(); } }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v.in && v.waiting > 0 && !asked && lastSection === null) setTab("tasks"); }, [v.in]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPeople(false); }, [tab]);
  useEffect(() => { lastSection = tab; if (tab === "fitness") { markSeen(); setSeen(todayISO()); } if (tab !== "settings") setPage(null); }, [tab]);
  useEffect(() => {
    const l = chat.lines.at(-1);
    if (l && !l.sending && !l.failed) lastLine = { name: l.name, mine: l.mine, t: l.t, at: l.at };
  }, [chat.lines]);

  // Where it grows from: the G Squad button's middle (the phone: the bottom middle, like a sheet).
  const origin = () => {
    const r = anchor?.current?.getBoundingClientRect();
    return r && r.width ? `${Math.round(r.left + r.width / 2)}px ${Math.round(r.top + r.height / 2)}px` : "50% 100%";
  };
  // Opening: it grows out of the button with a soft spring; the list and the section follow a beat later (CSS).
  useLayoutEffect(() => {
    const pn = panel.current;
    if (float && pn && !reduced() && typeof pn.animate === "function") {
      // grows out of the G Squad button: it starts as a small round dot on the button and opens to the window
      const a = anchor?.current?.getBoundingClientRect();   // the window is centred, so its middle is the screen's middle (read before any animation moves it)
      const dx = a && a.width ? a.left + a.width / 2 - window.innerWidth / 2 : 0, dy = a && a.width ? a.top + a.height / 2 - window.innerHeight / 2 : 40;
      const k = a && a.width ? 0.05 : 0.94;
      pn.animate([
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${k})`, borderRadius: "60px" },
        { opacity: 1, offset: 0.28 },
        { opacity: 1, transform: "none", borderRadius: "16px" },
      ], { duration: 520, easing: "cubic-bezier(.22, 1.12, .3, 1)" });
      win.current?.animate([{ backgroundColor: "rgba(0,0,0,0)" }, { backgroundColor: "rgba(0,0,0,.3)" }], { duration: 360, easing: "ease-out" });
      pn.querySelector(".gsw-side")?.animate([{ opacity: 0, transform: "translateX(-14px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 140, easing: EASE, fill: "backwards" });
      return;
    }
    const el = win.current;
    if (!el || reduced() || typeof el.animate !== "function") return;
    el.style.transformOrigin = origin();
    el.animate(PHONE
      ? [{ opacity: 0, transform: "translateY(36px) scale(.98)" }, { opacity: 1, transform: "none" }]
      : [{ opacity: 0, transform: "scale(.86)", borderRadius: "28px" }, { opacity: 1, transform: "none", borderRadius: "0px" }],
    { duration: PHONE ? 320 : 380, easing: EASE });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing: it shrinks back the way it came, then is gone. Any outside close (the list hid) just unmounts.
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    const pn = panel.current;
    if (float && pn && !reduced() && typeof pn.animate === "function") {
      const a = anchor?.current?.getBoundingClientRect();   // the window is centred, so its middle is the screen's middle (read before any animation moves it)
      const dx = a && a.width ? a.left + a.width / 2 - window.innerWidth / 2 : 0, dy = a && a.width ? a.top + a.height / 2 - window.innerHeight / 2 : 40;
      const k = a && a.width ? 0.05 : 0.94;
      const an = pn.animate([{ opacity: 1, transform: "none", borderRadius: "16px" }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${k})`, borderRadius: "60px" }],
        { duration: 260, easing: "cubic-bezier(.5, 0, .9, .4)", fill: "forwards" });
      win.current?.animate([{ backgroundColor: "rgba(0,0,0,.3)" }, { backgroundColor: "rgba(0,0,0,0)" }], { duration: 240, fill: "forwards" });
      an.onfinish = () => onClose();
      window.setTimeout(onClose, 400);
      return;
    }
    const el = win.current;
    if (!el || reduced() || typeof el.animate !== "function") { onClose(); return; }
    el.style.transformOrigin = origin();
    const a = el.animate(PHONE
      ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(28px)" }]
      : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }], { duration: 200, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
    a.onfinish = () => onClose();
    window.setTimeout(onClose, 320);   // the end of the animation never came: close anyway
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // The list of sections exists only once you are in a squad; the join screen has none to step back to.
  const listRef = useRef({ narrow, list, inSquad: v.in });
  listRef.current = { narrow, list, inSquad: v.in };

  // Open: the main page pulls now and every 20 s; PS keeps the list up and gives it the keyboard (the dimx flag).
  // Esc: a Fitness sheet first, then a step inside (an edit, a form, a settings page), then the list on a narrow
  // screen, then close. The phone's back gesture does the same (its Fitness sheets answer it before this does).
  useEffect(() => {
    squadOp({ op: "open", on: true });
    psPost({ type: "dimx", open: true });
    const w = window as Window & { __psDimxClose?: () => boolean };
    let asking = false;
    const step = (fromBack = false) => {
      let sheet = false;
      if (!fromBack) {
        const inner = new Event("gos-back", { cancelable: true });   // Fitness's sheet stack (fitness/Squad.tsx) answers this
        asking = true;
        try { window.dispatchEvent(inner); } finally { asking = false; }
        sheet = inner.defaultPrevented;
      }
      const { narrow: n, list: l, inSquad } = listRef.current;
      const s = escStep({ sheet, back: !sheet && popBack(), narrowInSection: n && !l && inSquad });
      if (s === "list") { sfx.hover(); setList(true); }
      else if (s === "close") leaveRef.current();
      return true;
    };
    w.__psDimxClose = () => step();
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); step(); };
    const back = (e: Event) => { if (asking) return; e.preventDefault(); e.stopImmediatePropagation(); step(true); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("gos-back", back, true);
    return () => {
      squadOp({ op: "open", on: false });
      psPost({ type: "dimx", open: false });
      if (w.__psDimxClose) delete w.__psDimxClose;
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("gos-back", back, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const style = { ...looksVars(looks, psFs()) } as CSSProperties;
  const cls = `gsw${narrow ? " narrow" : ""}${PHONE ? " phone" : ""} ${looksClass(looks)}${looks.look === "new" && signalOn() ? " sg" : ""}${v3 ? " v3" : ""}${float ? " float" : ""}`;
  const closeBtn = (
    <button type="button" className="gsw-x" onClick={() => { sfx.click(); leave(); }} aria-label="Close" data-tip="Close" data-tip-line="Closes G Squad. Or press Esc">
      <CloseIcon /></button>
  );
  // The window's edges and corners: pull one to resize (the window stays in the middle), the size is remembered.
  const grab = (dir: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget, x0 = e.clientX, y0 = e.clientY, start = sizeNow;
    el.setPointerCapture(e.pointerId);
    let last = start, frame = 0;
    // Each move writes the size straight to the window's element once per frame; React draws again only when you let go.
    const paint = () => { frame = 0; const p = panel.current; if (p) { p.style.width = `${last.w}px`; p.style.height = `${last.h}px`; } };
    const move = (m: PointerEvent) => { last = dragWin(start, m.clientX - x0, m.clientY - y0, dir, window.innerWidth, window.innerHeight); if (!frame) frame = requestAnimationFrame(paint); };
    let done = false;
    const up = () => {
      if (done) return; done = true;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      for (const t of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const) el.removeEventListener(t, t === "pointermove" ? move as EventListener : up);
      setSize(last); saveWin(last, safeLocal());
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up); el.addEventListener("lostpointercapture", up);
  };
  const HANDLES: { c: string; x: -1 | 0 | 1; y: -1 | 0 | 1 }[] = [
    { c: "n", x: 0, y: -1 }, { c: "s", x: 0, y: 1 }, { c: "w", x: -1, y: 0 }, { c: "e", x: 1, y: 0 },
    { c: "nw", x: -1, y: -1 }, { c: "ne", x: 1, y: -1 }, { c: "sw", x: -1, y: 1 }, { c: "se", x: 1, y: 1 },
  ];
  // A click closes the window only when the press AND the release were on the dark area: selecting text and letting go outside must not.
  const bgDown = useRef(false);
  const frame = (mode: string, body: ReactNode) => createPortal(
    <div ref={win} className={`${cls} ${mode}`} role="dialog" aria-modal="true" aria-label="G Squad" style={style}
      onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => { bgDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { e.stopPropagation(); const both = bgDown.current && e.target === e.currentTarget; bgDown.current = false; if (float && both) { sfx.click(); leave(); } }}>
      <div className="gsw-bg" aria-hidden="true" />
      <div ref={panel} className="gsw-in" style={float ? { width: sizeNow.w, height: sizeNow.h } : undefined}>
        {body}
        {float && HANDLES.map((h) => <i key={h.c} className={`gsw-rs ${h.c}`} onPointerDown={grab(h)} aria-hidden="true" />)}
      </div>
    </div>, document.body);

  // ---------- not in a squad yet: The G Squad in the middle, one step at a time ----------
  const holdTab = v.in && (tab === "settings" ? "settings" : (tabs.find((t) => t.id === tab) ?? tabs[0])?.id ?? "chat");
  useEffect(() => (holdTab === "chat" ? holdChatOpen() : undefined), [holdTab]);   // once for the chat tab, not per conversation
  if (!v.in) return frame("solo", <>
    <div className="gsw-top"><span className="gsw-top-t">G Squad</span>{closeBtn}</div>
    <div className="gsw-solo">
      <div className="gsw-hero">
        <span className="gsw-hero-orb"><Icon size={46} /></span>
        <h2>{THE_SQUAD}</h2>
        <p>Work alongside your squad. See who is working, share tasks, chat and train together.</p>
      </div>
      {welcome}
      <p className="gsw-e2e solo"><Lock />End to end encrypted: the squad's server only ever holds locked data.</p>
    </div>
  </>);

  // ---------- in a squad: the list and the open section ----------
  const rowOf = (id: string): RowInfo | null => {
    switch (id) {
      case "chat": return chatRow(chat.unread, lastLine, rowTime);
      case "tasks": return tasksRow(v);
      case "fitness": return fitnessRow(gym, seen);
      case "leaderboard": return boardRow(v, v3);
      case "screen": return screenRow();
      case "members": return membersRow(v);
      case "settings": return settingsRow();
    }
    return null;
  };
  const working = v.members.filter((m) => m.working).length;
  const showList = !narrow || list;
  const showMain = !narrow || !list;
  const pick = (id: string) => { if (id !== tab) sfx.hover(); setTab(id); setList(false); };
  const isSettings = tab === "settings";
  const cur = isSettings ? null : tabs.find((t) => t.id === tab) ?? tabs[0];
  const curId = isSettings ? "settings" : cur?.id ?? "chat";
  const chatConv = v3 && curId === "chat" ? conv.cur : null;
  const curTitle = isSettings ? "Squad settings" : chatConv ? chatConv.title : cur?.title ?? "";

  const row = (id: string, title: string, extra?: { placeholder?: boolean; count?: number; dot?: boolean }) => {
    const r = rowOf(id);
    const count = r?.count ?? extra?.count ?? 0;
    const on = curId === id && !(narrow && list);
    return (
      <li key={id}>
        <button type="button" role="tab" aria-selected={curId === id} className={`gsw-row${on ? " on" : ""}${extra?.placeholder ? " soon" : ""}`} onClick={() => pick(id)}>
          <span className={`gsw-ico ${TONE[id] ?? "acc"}`}>{ICONS[id] ?? ICONS.chat}</span>
          <span className="gsw-row-m">
            <span className="gsw-row-t"><b>{title}</b>{r?.time && <time className="num">{r.time}</time>}</span>
            <span className="gsw-row-s"><span className={r?.strong ? "strong" : undefined}>{r?.line ?? ""}</span>
              {count > 0 ? <i className="gsw-count num" aria-label={`${count} new`}>{unreadText(count)}</i> : r?.dot || extra?.dot ? <i className="gsw-dot" aria-label="New" /> : null}</span>
          </span>
        </button>
      </li>
    );
  };
  const side = (
    <aside className="gsw-side" aria-label="Sections">
      <div className="gsw-squad">
        <span className="gsw-orb"><Icon size={26} /></span>
        <span className="gsw-squad-t">{v.name || THE_SQUAD}<em>{workingLine(v.count)}</em></span>
        {narrow && closeBtn}
      </div>
      <ul className="gsw-rows" role="tablist" aria-orientation="vertical">
        {tabs.map((t) => v3 && t.id === "chat"
          ? <Fragment key={t.id}>
              {conv.list.map((c) => <ConvRow key={c.id} c={c} v={v} on={curId === "chat" && conv.active === c.id && !(narrow && list)} onPick={() => { if (curId !== "chat" || conv.active !== c.id) sfx.hover(); setGrp(null); openConv(c.id); setTab("chat"); setList(false); }} />)}
              {conv.dm && v.members.length > 2 && (
                <li><button type="button" className="gsw-newgroup" data-gsg-open onClick={() => { sfx.click(); setGrp("new"); setPeople(false); setTab("chat"); setList(false); }}><PlusIcon />New group</button></li>
              )}
            </Fragment>
          : row(t.id, t.title, { placeholder: t.placeholder, count: t.badge?.(v), dot: t.dot?.(v) }))}
      </ul>
      <ul className="gsw-rows gsw-rows-end" role="tablist" aria-orientation="vertical">{row("settings", "Squad settings")}</ul>
      <p className="gsw-e2e"><Lock />End to end encrypted</p>
    </aside>
  );
  const sub = curId === "chat" ? (chatConv && chatConv.kind === "dm" ? "Direct message" : `${chatConv && chatConv.kind === "group" ? chatConv.memberIds.length : v.members.length} ${(chatConv && chatConv.kind === "group" ? chatConv.memberIds.length : v.members.length) === 1 ? "member" : "members"}${chatConv && chatConv.kind === "group" ? "" : `, ${working} working`}`) : (v3 && curId === "leaderboard" ? "Money made" : SUBTITLE[curId]) ?? "";
  const main = (
    <section className="gsw-main" aria-label={curTitle}>
      <header className="gsw-head">
        {narrow && <button type="button" className="gsw-back" onClick={() => { sfx.hover(); setList(true); }} aria-label="Back to the list" data-tip="Back to the list" data-tip-line="Or press Esc"><BackIcon /></button>}
        {chatConv
          ? <span className="gsw-ico big conv"><ConvAvatar c={chatConv} v={v} size={36} /></span>
          : <span className={`gsw-ico big ${TONE[curId] ?? "acc"}`}>{ICONS[curId] ?? ICONS.chat}</span>}
        <span className="gsw-head-t">{curTitle}<em>{sub}</em></span>
        {curId === "chat" && v.members.length > 0 && (!chatConv || chatConv.kind === "squad") && <MembersButton v={v} size={narrow ? 28 : 34} max={narrow ? 3 : 5} open={people} onToggle={() => setPeople(!people)} />}
        {chatConv && chatConv.kind === "group" && <button type="button" className={`gsw-grpinfo${grp === "info" ? " on" : ""}`} data-gsg-open aria-label="Group members" data-tip="Group members" onClick={() => { sfx.click(); setPeople(false); setGrp(grp === "info" ? null : "info"); }}><PeopleIcon /></button>}
        {!narrow && closeBtn}
      </header>
      {people && curId === "chat" && <MembersList v={v} narrow={narrow} onClose={() => setPeople(false)}
        onMessage={v3 && conv.dm ? (m) => { v3Op({ op: "newDm", memberId: m.id }); setPeople(false); setTab("chat"); setList(false); } : undefined} />}
      {grp === "new" && curId === "chat" && <NewGroupCard v={v} narrow={narrow} onClose={() => setGrp(null)} onMade={() => { setGrp(null); setTab("chat"); }} />}
      {grp === "info" && curId === "chat" && chatConv && chatConv.kind === "group" && <GroupCard v={v} c={chatConv} narrow={narrow} onClose={() => setGrp(null)} />}
      {curId !== "members" && asks}
      {pins}
      <div key={curId === "chat" && v3 ? `chat-${conv.active}` : curId} className={`gsw-body${curId === "chat" ? " fill" : ""}${curId === "fitness" ? " wide" : ""}`} role="tabpanel">
        {isSettings ? <SquadSettings view={v} page={page} onPage={setPage} /> : cur && <cur.Panel {...props} />}
      </div>
      {v.error && <p className="gs-err gsw-err" role="alert">{v.error}</p>}
    </section>
  );
  return frame("duo", <>
    {showList && side}
    {showMain && main}
  </>);
}
