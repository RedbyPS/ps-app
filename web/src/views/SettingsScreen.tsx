// Settings, full screen. V1.32 made it a screen like the Network monitor (the developer: "the settings menu should also be like a
// full screen like the network tab is"). V1.43 (the developer, 8 Nov 2026: "the settings button is very confusing. When I go into
// the massive General settings on desktop or mobile, it's unclear where everything is. Add a search bar and a settings
// menu so you can search for settings. Simplify the whole design"): no more tabs and no giant General page.
// - A search bar at the top: any word (sound, reset, transparency, AFK, time zone) lists the matching settings from
//   every section with their section's name; a click (or Enter for the first) jumps straight to it and lights it up.
//   Fitness, Sleep mode, Security and the other screens of their own open from there too.
// - A side menu of groups with icons (Mac and website); on the phone, or any narrow window, a list of sections to tap
//   into, and back (the back button, Esc or the phone's back gesture) steps out again.
// - Each setting is one row: a short name, one plain line on what it does, the control on the right. A bigger one
//   opens below its row. Rarely used ones sit under a small "More" at the foot of their group.
// The groups, the rows, their words and who sees them come from core/settingsindex.ts; each row's control is in
// views/SettingsGroups.tsx. This file is the shell, the open state, the search and the jump.
// Opened by the gear: the Tab list (owner "tab"), the website's To-do page (owner "docked", a layer over the page) and
// the phone. Esc ends a Looks preview first, then clears the search, then steps out of a section (narrow), then closes.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { psPost } from "../ps";
import { settingsRests } from "../core/screenrest";
import { restBehind } from "../ui/screenrest";
import { sfx } from "../ui/sfx";
import { morph } from "./DimensionX";
import { CinceeCredit } from "./CinceeCredit";
import "./macsettings.css";
import "./moresettings.css";
import "./settingsscreen.css";
import { appName } from "../core/appname";
import { PART_SHOWN, type LooksPart } from "../core/looksoptions";
import { setPeekPart, usePeek } from "../looks/peek";
import "../looks/peek.css";
import { GROUPS, groupById, groupsFor, landingOf, rowsOf, searchSettings, settingById, type Ctx, type Go, type GroupId, type SetEntry } from "../core/settingsindex";
import { AssistBotButton, AssistCard, AssistSpot } from "./Assistant";
import { assistCtx, assistEsc, installBridge, settingsOpened } from "../assist";
import { LOOKS_PREVIEW_MS, LOOKS_PREVIEW_NOTE_MS } from "../core/lookspreview";

/** The old tab names (V1.32 to V1.42), still accepted: General is Your list now, Mac settings is Mac. */
export type SettingsTab = "general" | "notify" | "looks" | "mac";
const OLD: Record<SettingsTab, GroupId> = { general: "list", notify: "notify", looks: "looks", mac: "mac" };
export type SettingsOwner = "tab" | "docked";
const isGroup = (x: string): x is GroupId => GROUPS.some((g) => g.id === x);

// ---------- open or closed, which group, and a setting to land on ----------
type Want = { group: GroupId; jump: string | null; owner: SettingsOwner; home: boolean };
let want: Want | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
/** Opens Settings on a group (or an old tab name), or switches group while open; null closes it. `jump` lands on one
 *  setting and lights it up. `home` (narrow screens): start on the list of sections. */
export function openSettings(to: SettingsTab | GroupId | null, o: { jump?: string; owner?: SettingsOwner; home?: boolean } = {}) {
  if (to === null) { if (want) { want = null; emit(); } return; }
  const group = (to in OLD ? OLD[to as SettingsTab] : isGroup(to) ? to : "list") as GroupId;
  const owner = o.owner ?? want?.owner ?? (document.querySelector(".tm-overlay:not(.tm-docked)") ? "tab" : "docked");
  const next: Want = { group, jump: o.jump ?? null, owner, home: o.home ?? false };
  if (want && want.group === next.group && want.jump === next.jump && want.owner === next.owner && want.home === next.home) return;
  want = next;
  emit();
}
/** Which group is open (null: Settings is closed). */
export const settingsWanted = () => want?.group ?? null;
export function useSettingsWanted(): GroupId | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => want?.group ?? null);
}
const useWant = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => want);
const gearOf = (owner: SettingsOwner) => document.querySelector<HTMLElement>(owner === "docked"
  ? ".tm-overlay.tm-docked button[aria-label=Settings]" : ".tm-overlay:not(.tm-docked) .tm-tr button[aria-label=Settings]");

/** What a Looks preview needs: show a look for 5 seconds (LOOKS_PREVIEW_MS) while the screen steps aside. `part` says which part of PS it
 *  changes (core/looksoptions.ts): the Tab list makes sure that part is on screen and highlights it (looks/peek.ts). */
export type Preview = (label: string, set: () => void, clear: () => void, part?: LooksPart) => void;
const PREVIEW_MS = LOOKS_PREVIEW_MS;
const PREVIEW_NOTE_MS = LOOKS_PREVIEW_NOTE_MS;   // a preview that needs a sentence of explaining stays a little longer, to read it
const MORPH = { body: ".cs-content", tint: ".cs-morph" };
const FLASH_MS = 2200;

// ---------- what every row can reach ----------
interface RowCtx { expanded: Set<string>; toggle: (id: string) => void; flash: { id: string; n: number } | null; jump: (e: SetEntry) => void }
const RowContext = createContext<RowCtx>({ expanded: new Set(), toggle: () => {}, flash: null, jump: () => {} });
/** What a row's control gets: its entry, and the Looks preview. */
export interface RowProps { e: SetEntry; preview: Preview }
export type Controls = Record<string, (p: RowProps) => ReactNode>;

/** One setting: its short name and one line on the left, the control on the right. A bigger control (`body`) opens
 *  below the row: `open` keeps it open (Sleep mode, the looks), otherwise the row's arrow (or a search jump) opens it. */
export function SetRow({ e, right, body, open, className, plain }: { e: SetEntry; right?: ReactNode; body?: ReactNode; open?: boolean; className?: string; plain?: boolean }) {
  const c = useContext(RowContext);
  const shut = !!body && !open && !c.expanded.has(e.id);
  const lit = c.flash?.id === e.id;
  const toggle = () => { sfx.hover(); c.toggle(e.id); };
  return (
    <div className={`gs-set${body ? " has-body" : ""}${body && !open ? " can-shut" : ""}${shut ? " shut" : ""}${lit ? " gs-flash" : ""}${className ? ` ${className}` : ""}`} data-set={e.id} key={lit ? c.flash!.n : undefined}>
      <div className="gs-set-row">
        <div className="gs-set-t" onClick={body && !open ? toggle : undefined}>
          <b>{e.name}</b>
          <span>{e.line}</span>
        </div>
        {right !== undefined && <div className="gs-set-c">{right}</div>}
        {body && !open && (
          <button type="button" className="gs-set-x" onClick={toggle} aria-expanded={!shut} aria-label={shut ? `Show ${e.name}` : `Hide ${e.name}`} data-tip="">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        )}
      </div>
      {/* mac-win: the dark tokens of the old Mac settings for the pieces that came from it (inputs, tabs, hints); `plain` for the looks */}
      {body && !shut && <div className={`gs-set-body${plain ? "" : " mac-win mac-scroll"}`}>{body}</div>}
    </div>
  );
}
/** The button of a row whose settings live on a screen of their own (Fitness, Security, the Do Not Disturb cog). */
export function OpenButton({ e, label = "Open" }: { e: SetEntry; label?: string }) {
  const c = useContext(RowContext);
  return (
    <button type="button" className="gs-open" onClick={() => { sfx.click(); c.jump(e); }}>
      {label}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}
const DefaultRow = ({ e }: RowProps) => <SetRow e={e} right={e.go ? <OpenButton e={e} /> : undefined} />;

export function GroupIcon({ id, size = 18 }: { id: GroupId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={groupById(id).icon} />
    </svg>
  );
}

/** Narrow: the phone, or a window too small for a side menu. */
function useNarrow(phone: boolean) {
  const q = "(max-width: 720px)";
  const [n, setN] = useState(() => phone || (typeof matchMedia === "function" && matchMedia(q).matches));
  useEffect(() => {
    if (phone || typeof matchMedia !== "function") return;
    const m = matchMedia(q);
    const f = () => setN(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [phone]);
  return n;
}

export function SettingsScreen({ owner, ctx, controls, onGo, phone = false }: {
  owner: SettingsOwner; ctx: Ctx; controls: Controls;
  /** Opens a screen of its own (Fitness, Security...). `close` closes Settings first. */
  onGo: (go: Go, e: SetEntry, close: () => void) => void;
  phone?: boolean;
}) {
  const w = useWant();
  const mine = w && w.owner === owner ? w : null;
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const groups = useMemo(() => groupsFor(ctx), [ctx.red, ctx.where]); // eslint-disable-line react-hooks/exhaustive-deps
  const [group, setGroup] = useState<GroupId>("list");
  const narrow = useNarrow(phone);
  const [inside, setInside] = useState(false);   // narrow: in a section (else the list of sections)
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState<Set<GroupId>>(() => new Set());
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const win = useRef<HTMLElement>(null), dim = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  // Preview (Looks): which look is showing (its name), and how to end it.
  const [peek, setPeek] = useState<string | null>(null);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const endPeek = useRef<() => void>(() => {});
  const pv = usePeek();
  const timer = useRef(0);
  // PS 1.65 Settings assistant: who is looking (its list), the Mac's way in (window.__psAssist), and the island pop out when Settings opens.
  assistCtx(ctx);
  useEffect(() => installBridge(), []);
  useEffect(() => { if (mine && phase === "open") { settingsOpened(true); return () => settingsOpened(false); } }, [!!mine && phase === "open"]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview: Preview = (label, set, clear, part = "look") => {
    endPeek.current();
    setPeekPart(part); set(); sfx.click(); setPeek(label);
    timer.current = window.setTimeout(() => endPeek.current(), PREVIEW_MS);
    endPeek.current = () => { window.clearTimeout(timer.current); clear(); setPeekPart(null); setPeek(null); endPeek.current = () => {}; };
  };
  // The list explains what it staged (an example group, the glass slider): give it time to be read.
  const noted = peek !== null && !!pv.note;
  useEffect(() => {
    if (!noted) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => endPeek.current(), PREVIEW_NOTE_MS);
  }, [noted]);

  const showGroup = (g: GroupId) => groups.some((x) => x.id === g) ? g : groups[0]?.id ?? "list";
  // Land on one setting: its group, its More, its row open, scrolled to and lit up.
  const land = (hit: SetEntry) => {
    const row = landingOf(hit);
    const g = showGroup(row.group);
    endPeek.current();
    setQ(""); setGroup(g); setInside(true);
    if (row.more) setMoreOpen((m) => new Set(m).add(g));
    setExpanded((x) => new Set(x).add(row.id));
    setFlash({ id: row.id, n: Date.now() });
    if (want && want.owner === owner) want = { ...want, group: g, jump: null, home: false };
  };
  const close = () => { if (phaseRef.current === "open") { sfx.drop(); openSettings(null); } };
  const jump = (hit: SetEntry) => {
    const go = hit.go ?? landingOf(hit).go;
    if (go) { onGo(go, hit, close); return; }   // a screen of its own (Fitness, Security, Sleep mode...)
    sfx.click();
    land(hit);
  };
  const toggle = (id: string) => setExpanded((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // V1.53 (the developer: "the background of the settings menu randomly go dark then light, then dark again"): the Tab list's
  // moving looks (lightning, a background video, storm rain's flash, the scenes) rest behind this screen, as they do
  // behind Fitness and the Soundboard (core/screenrest.ts). A Looks preview lets them show again for its 5 seconds.
  const rests = settingsRests(phase, peek !== null);
  useLayoutEffect(() => {
    const root = gearOf(owner)?.closest(".tm-overlay") ?? document.querySelector(".tm-overlay:not(.tm-docked)");
    restBehind(root, "settings", rests);
    return () => restBehind(root, "settings", false);
  }, [rests, owner]);
  // PS asks for Mac settings by name (the "PS is active" pop up's Settings button, ps-mac NoWindow.swift). V1.59: or a
  // tab by its id (the first stand-up's See settings asks for "standup", ps-mac IslandBubbleCore.swift StandAsk).
  useEffect(() => {
    if (owner !== "tab") return;
    const g = window as Window & { __psOpenSettings?: (to?: unknown) => boolean };
    g.__psOpenSettings = (to?: unknown) => {
      openSettings(typeof to === "string" && isGroup(to) ? to : ctx.where === "mac" ? "mac" : "list", { owner: "tab" });
      return true;
    };
    return () => { if (g.__psOpenSettings) delete g.__psOpenSettings; };
  }, [owner, ctx.where]);
  // Follows what was asked. Also runs when a close finishes: a click on the gear while the screen was still shrinking
  // opens it again.
  useEffect(() => {
    if (mine) {
      const target = mine.jump ? settingById(mine.jump) : undefined;
      if (target) land(target);
      else if (phase === "closed" || mine.group !== group) {
        endPeek.current();
        setGroup(showGroup(mine.group));
        // Narrow: the gear opens on the list of sections; a door to one section (Looks, Mac settings) goes straight in.
        setInside(!narrow || (!mine.home && (phase !== "closed" || mine.group !== "list")));
      }
      if (phase === "closed") {
        if (!target) { setQ(""); setFlash(null); }
        setHost(owner === "docked" ? document.body : gearOf(owner)?.closest<HTMLElement>(".tm-overlay") ?? document.querySelector<HTMLElement>(".tm-overlay:not(.tm-docked)"));
        setPhase("open");
      }
    } else if (phase === "open") { endPeek.current(); setPhase("closing"); }
  }, [mine, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (phase === "open") {
      if (owner === "tab") { psPost({ type: "dimx", open: true }); psPost({ type: "psSettings:get" }); }   // PS pins the list and gives it the keyboard (Esc comes back here)
      void morph(win.current, gearOf(owner), dim.current, "in", MORPH);
      // A keyboard: straight into the search (never on the phone, where it would throw up the keyboard).
      if (!narrow) window.setTimeout(() => search.current?.focus({ preventScroll: true }), 60);
    } else if (phase === "closing") {
      if (owner === "tab") psPost({ type: "dimx", open: false });
      void morph(win.current, gearOf(owner), dim.current, "out", MORPH).then(() => setPhase((p) => (p === "closing" ? "closed" : p)));
    }
  }, [phase, host]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back, one step: a preview, the search, a section (narrow), then Settings itself.
  const back = (fromEsc: boolean) => {
    if (peekRef.current !== null) { endPeek.current(); return; }
    if (fromEsc && q) { setQ(""); return; }
    if (narrow && inside) { sfx.hover(); setInside(false); scroll.current?.scrollTo({ top: 0 }); return; }
    close();
  };
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    if (phase !== "open") return;
    // PS 1.65: the Settings assistant steps back first (a walk ends, then its answer clears), then Settings closes as before.
    const escape = () => { if (assistEsc()) return true; backRef.current(true); return true; };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); escape(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopImmediatePropagation(); setInside(false); window.setTimeout(() => search.current?.focus(), 0); }
    };
    const g = window as Window & { __psDimxClose?: () => boolean };
    window.addEventListener("keydown", key, true);
    if (owner === "tab") g.__psDimxClose = escape;
    return () => { window.removeEventListener("keydown", key, true); if (g.__psDimxClose === escape) delete g.__psDimxClose; };
  }, [phase, owner]);
  useEffect(() => () => { endPeek.current(); if (want?.owner === owner) openSettings(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After a jump: scroll the row into the middle of the page and let it glow for a moment.
  useLayoutEffect(() => {
    if (!flash || phase !== "open") return;
    const t = window.setTimeout(() => {
      const el = win.current?.querySelector<HTMLElement>(`[data-set="${CSS.escape(flash.id)}"]`);
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }, 40);
    const off = window.setTimeout(() => setFlash((f) => (f && f.n === flash.n ? null : f)), FLASH_MS);
    return () => { window.clearTimeout(t); window.clearTimeout(off); };
  }, [flash, phase, group]);
  // A new section starts at its top.
  useLayoutEffect(() => { if (!flash) scroll.current?.scrollTo({ top: 0 }); }, [group, inside]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo(() => (q.trim() ? searchSettings(q, ctx).slice(0, 40) : []), [q, ctx.red, ctx.where]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowCtx = useMemo<RowCtx>(() => ({ expanded, toggle, flash, jump }), [expanded, flash]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === "closed" || !host) return null;
  const searching = q.trim().length > 0;
  const showList = narrow && !inside && !searching;
  const g = groupById(group);
  const title = narrow && inside && !searching ? g.label : "Settings";
  const pick = (id: GroupId) => { sfx.hover(); endPeek.current(); setQ(""); setFlash(null); setGroup(id); setInside(true); if (want && want.owner === owner) want = { ...want, group: id, jump: null }; };
  const version = __PS_VERSION__.name ? (
    <p className="cs-hint gs-ver" aria-label={`${appName()} version ${__PS_VERSION__.name} ${__PS_VERSION__.keyword}`}>
      {appName()} {__PS_VERSION__.name}{__PS_VERSION__.keyword && <span>{__PS_VERSION__.keyword}</span>}
    </p>
  ) : null;
  return createPortal(
    <div className={`dx-layer cs-layer ms-layer gs-layer${owner === "docked" ? " docked" : ""}${peek ? " peek" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={dim} className="cs-dim" onMouseDown={close} aria-hidden="true" />
      <section ref={win} className={`cs-win gs-win${narrow ? " gs-narrow" : ""}`} role="dialog" aria-modal="true" aria-label="Settings" data-group={group}>
        <div className="cs-morph" aria-hidden="true" />
        <div className="cs-glow" aria-hidden="true" />
        <div className="cs-content">
          <header className="cs-head gs-head">
            <button type="button" className="cs-min gs-back" onClick={() => back(false)}
              aria-label={narrow && inside && !searching ? "Back to all settings" : "Close Settings"}
              title={narrow && inside && !searching ? "Back to all settings (Esc)" : "Back to the list (Esc)"}>
              {narrow && inside && !searching
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>}
            </button>
            <div className="cs-title"><h2>{title}</h2><CinceeCredit /></div>
            <AssistBotButton />
            {!narrow && version}
            {(!narrow || !inside || searching) && (
              <label className="gs-search">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
                <input ref={search} type="search" value={q} placeholder="Search settings" aria-label="Search settings" spellCheck={false} autoComplete="off" enterKeyHint="go"
                  onChange={(e) => { setQ(e.target.value); setFlash(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hits[0]) { e.preventDefault(); jump(hits[0].e); }
                    else if (e.key === "ArrowDown" && hits[0]) { e.preventDefault(); win.current?.querySelector<HTMLElement>(".gs-hit")?.focus(); }
                  }} />
                {q && <button type="button" className="gs-search-x" onClick={() => { setQ(""); search.current?.focus(); }} aria-label="Clear the search" data-tip="">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>}
              </label>
            )}
          </header>
          <div className="gs-main">
            {!narrow && (
              <nav className="gs-nav" aria-label="Settings sections">
                {groups.map((x) => (
                  <button key={x.id} type="button" className={`gs-nav-i${!searching && x.id === group ? " on" : ""}`} aria-current={!searching && x.id === group ? "page" : undefined}
                    data-group={x.id} onClick={() => pick(x.id)} data-tip="">
                    <GroupIcon id={x.id} /><span>{x.label}</span>
                  </button>
                ))}
              </nav>
            )}
            <div ref={scroll} className="cs-scroll gs-scroll">
              <RowContext.Provider value={rowCtx}>
                {!searching && (showList || !narrow || inside) && <AssistCard />}
                {searching ? (
                  <Results q={q} hits={hits.map((h) => h.e)} onPick={jump} />
                ) : showList ? (
                  <div className="gs-home" role="list" aria-label="Settings sections">
                    {groups.map((x) => (
                      <button key={x.id} type="button" role="listitem" className="gs-home-i" data-group={x.id} onClick={() => pick(x.id)}>
                        <span className="gs-home-ic"><GroupIcon id={x.id} size={20} /></span>
                        <span className="gs-home-t"><b>{x.label}</b><em>{x.line}</em></span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                      </button>
                    ))}
                    {version}
                  </div>
                ) : (
                  <GroupPage key={group} group={group} ctx={ctx} controls={controls} preview={preview} more={moreOpen.has(group)}
                    onMore={() => { sfx.hover(); setMoreOpen((m) => { const n = new Set(m); if (n.has(group)) n.delete(group); else n.add(group); return n; }); }}
                    showHead={!narrow} />
                )}
              </RowContext.Provider>
            </div>
          </div>
        </div>
      </section>
      <AssistSpot />
      {peek && (
        <div className="ms-catch" onMouseDown={(e) => { e.stopPropagation(); endPeek.current(); }}>
          <div className={`ms-peek-chip${pv.note ? " has-note" : ""}`} role="status">
            <span className="ms-peek-l"><b>{peek}</b>{pv.part && PART_SHOWN[pv.part] ? <> {PART_SHOWN[pv.part]}</> : null}. Click anywhere to go back</span>
            {pv.note && <span className="ms-peek-note">{pv.note}</span>}
            <i key={pv.note ? "n" : "p"} style={{ animationDuration: `${pv.note ? PREVIEW_NOTE_MS : PREVIEW_MS}ms` }} />
          </div>
        </div>
      )}
    </div>, host);
}

/** One group: its title and line, its rows, and its small More. */
function GroupPage({ group, ctx, controls, preview, more, onMore, showHead }: {
  group: GroupId; ctx: Ctx; controls: Controls; preview: Preview; more: boolean; onMore: () => void; showHead: boolean;
}) {
  const g = groupById(group);
  const { main, more: rare } = rowsOf(group, ctx);
  const row = (e: SetEntry) => { const C = controls[e.id] ?? DefaultRow; return <C key={e.id} e={e} preview={preview} />; };
  return (
    <div className={`gs-view gs-pg gs-grp gs-grp-${group}`} role="group" aria-label={g.label}>
      {showHead && (
        <div className="gs-grp-h">
          <span className="gs-grp-ic"><GroupIcon id={group} size={22} /></span>
          <div><h3>{g.label}</h3><p>{g.line}</p></div>
        </div>
      )}
      <div className="gs-rows">{main.map(row)}</div>
      {rare.length > 0 && (
        <div className={`gs-more${more ? " open" : ""}`}>
          <button type="button" className="gs-more-b" onClick={onMore} aria-expanded={more}>
            <span>More</span><em>{rare.length}</em>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {more && <div className="gs-rows">{rare.map(row)}</div>}
        </div>
      )}
    </div>
  );
}

/** The search's answers: each setting with its section, best first. */
function Results({ q, hits, onPick }: { q: string; hits: SetEntry[]; onPick: (e: SetEntry) => void }) {
  if (!hits.length) return (
    <div className="gs-view gs-none" role="status">
      <b>Nothing called "{q.trim()}"</b>
      <span>Try another word, like sound, reset, colour or time zone.</span>
    </div>
  );
  return (
    <div className="gs-view gs-hits" role="list" aria-label={`${hits.length} matching settings`}>
      {hits.map((e, i) => (
        <button key={e.id} type="button" role="listitem" className="gs-hit" data-hit={e.id} onClick={() => onPick(e)}
          onKeyDown={(ev) => {
            const sib = (d: number) => (ev.currentTarget.parentElement?.children[i + d] as HTMLElement | undefined);
            if (ev.key === "ArrowDown") { ev.preventDefault(); sib(1)?.focus(); }
            else if (ev.key === "ArrowUp") { ev.preventDefault(); (sib(-1) ?? ev.currentTarget.closest(".gs-win")?.querySelector<HTMLInputElement>(".gs-search input"))?.focus(); }
          }}>
          <span className="gs-hit-ic"><GroupIcon id={e.group} /></span>
          <span className="gs-hit-t"><b>{e.name}</b><em>{e.line}</em></span>
          <span className="gs-hit-g">{groupById(e.group).label}{e.go ? <i>Opens {GO_WORD[e.go]}</i> : null}</span>
        </button>
      ))}
    </div>
  );
}
const GO_WORD: Record<Go, string> = { fitness: "Fitness", security: "Security", dnd: "Do Not Disturb", gsquad: "G Squad", sleepSettings: "Sleep mode settings", phone: "phone settings", vault: "your vault", macApp: "the download page" };

/** A group of cards under one heading (older pieces still use it: the Notifications cards). */
export function GsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    // A div with role group, not a labelled section: those count as screens for pinning (core/pinrules.ts).
    <div className="gs-group" role="group" aria-label={title}>
      <h3 className="gs-group-h">{title}</h3>
      {children}
    </div>
  );
}
/** One row of cards in a section: they share the row's width and height, so their edges line up and no row leaves
 *  a hole. On a narrow window the row wraps and the last card takes the whole width. */
export function GsRow({ children }: { children: ReactNode }) {
  return <div className="gs-row">{children}</div>;
}
/** One card: a heading (optional, some pieces bring their own) and its controls. */
export function GsCard({ title, note, children, className }: { title?: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`gs-card${className ? ` ${className}` : ""}`}>
      {title && <span className="tm-panel-h">{title}</span>}
      {children}
      {note && <span className="tm-pop-note">{note}</span>}
    </div>
  );
}
