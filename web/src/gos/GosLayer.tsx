// PS GOS home screen. The Tab list from the Mac (the same Overlay component, every panel in it) is
// the phone's home, split into three panes a thumb can reach: Plan (the meetings), List (the tasks) and Inbox
// (client emails, meeting notes, New tasks, Urgent). Vault shows the website's pages, PS (far right) opens Settings,
// and on the developer's account Rules, left of PS, opens his rule book.
// V1.47 (the developer, 10 Nov 2026): "The hamburger navbar on the very top left: I like it, but add more to it: the screen time,
// the PS rules (which is for some reason at the very top of the screen, like the copy to clipboard stuff), the numerology
// tab and the timelines. All in the hamburger icon to clear it up. On the Plan tab I just want the Meetings menu, and put
// everything else including Goals and Time zones in the hamburger icon." So the top row of buttons (screen time, Morning
// brief, End your day with its PS rules check, clear the clipboard, the gear) and every Plan panel but Meetings moved into
// the menu (GosMenu below, items in gos/menu.ts). They still render where they did, hidden (gos.css), and the menu taps
// them, so each opens exactly as before. And "Redesign the settings menu on the GOS app ... like the macOS app": the gear
// opens the same Settings as the Mac (a search bar and a list of groups, views/SettingsScreen.tsx, gos/PhoneRows.tsx).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Overlay, openAddTask } from "../views/TaskMap";
import { useVault } from "../ui/kit";
import { primeSfx } from "../ui/sfx";
import { setPsOverlayShown } from "../ps";
import { isRedAccount } from "../core/account";
import { openRuleBook, useRuleBook } from "../rulegate";
import { sync } from "../core/vault";
import { MWEB, gosPost, haptic, onShell, useGos } from "./bridge";
import { startTouch } from "./touch";
import { MobileLockExtras } from "../mobile/MobileSettings";
import { openSettings, useSettingsWanted } from "../views/SettingsScreen";
import { openGSquad } from "../views/GSquad";
import { MENU, menuItems, type MenuId, type MenuItem } from "./menu";
import { NoteIcon, SoundboardHost, openSoundboard } from "../soundboard/SoundboardButton";
import { useSb } from "../soundboard/store";
import { BgProblemCard } from "./GosBackgrounds";
import { useGosLayout } from "./layout";
import { DndButton } from "../views/Dnd";
import { SleepRow } from "../views/SleepMode";
import { phoneLayout, settingsData } from "../core/select";
import { swiped } from "../core/lists";
import { setDnd } from "../core/actions";
import { DumbbellIcon } from "../fitness/FitnessApp";
import { FitnessPop } from "../fitness/FitnessPop";
import { TipsHost } from "../views/Tips";
import { NewPopupsHost } from "../views/NewPopups";
import { fitPop, useFitPop } from "../fitness/pop";
import { defaultPhoneLayout, lookOf, navLabel } from "../core/phonelayout";
import { clearPhoneNow, setPhoneNow, thisPhoneKind, viewOf } from "./phonepage";
import { usePhoneBeat, phoneDevName } from "./phonebeat";
import { setDeviceNameHint } from "../devicebeat";
import { PhoneEditMount } from "./PhoneEditMode";
import { useFlip } from "./flip";
import { noteGymScreen } from "../squad/presence";
import { panelOpen } from "../core/phonepanels";
import { PhoneIsland } from "./PhoneIsland";
import { usePhonePref } from "./phoneprefs";
import type { MomentOpen } from "../core/phoneisland";
// PS 1.67 the wheel menu (bottom left; replaces the hamburger while Settings, This phone, Wheel menu is on).
import { PhoneWheel } from "./PhoneWheel";
import { wheelItems, type Pt, type WheelId } from "./wheel";
import { closeLaunched, launch } from "./launch";
import { goToSleep } from "../sleepmode/engine";
import { sleepModeOf } from "../core/sleepmode";
import { openWhatsNew } from "../views/WhatsNew";

type Pane = "plan" | "list" | "inbox";
// PS Fitness is a pop up over any of them since V1.29 (fitness/FitnessPop.tsx). V1.56: "page:<id>" is a page of panels
// from the phone layout (core/phonelayout.ts, made on the Mac in Edit mode's phone editor).
type View = Pane | "vault" | `page:${string}`;
const isPane = (v: string): v is Pane => v === "plan" || v === "list" || v === "inbox";

export function GosLayer() {
  const s = useVault();
  const g = useGos();
  const [view, setView] = useState<View>("list");
  const settingsOpen = useSettingsWanted() !== null;
  const [menu, setMenu] = useState(false);
  const [show, setShow] = useState<"clocks" | null>(null);   // the Plan pane shows Time zones instead of Meetings
  const book = useRuleBook();
  const fit = useFitPop();
  useEffect(() => { noteGymScreen(fit !== "closed"); }, [fit]);   // G Squad members list (PS 1.64): "At the gym" while Gym is open
  const sbOpen = useSb().open;
  useGosLayout();   // Compact, Cards, Focus or Simple (the phone settings): follows the vault settings
  useEffect(() => { startTouch(); }, []);
  // V1.56 the phone layout (core/phonelayout.ts): this phone kind's pages, navbar and looks, synced from the Mac's
  // phone editor. A phone nobody changed shows exactly what it always did.
  const red0 = s.status === "unlocked" && isRedAccount(s);
  const kind = thisPhoneKind() ?? "gos";
  const pl = useMemo(() => (s.status === "unlocked" ? phoneLayout(s, kind, red0) : defaultPhoneLayout(kind, red0)), [s, kind, red0]);
  const order = useMemo(() => pl.pages.map(viewOf), [pl]);
  // A page of panels deleted on the Mac while it shows here: back to the list.
  useEffect(() => { if (view.startsWith("page:") && !order.includes(view)) setView("list"); }, [order, view]);
  useEffect(() => { if (g.device) setDeviceNameHint(phoneDevName(kind, g.device)); }, [kind, g.device]);   // PS 1.65: the model name for the device list (src/devicebeat.ts)
  usePhoneBeat(kind, s.status === "unlocked" && s.role === "owner", g.visible, g.device);

  // Settings (V1.47): the same screen as the Mac's, opened on its list of groups (or straight into one). It draws inside
  // the list's overlay, so from the Vault pages it first goes back to the list.
  const settings = (group?: "phone") => {
    setMenu(false); setShow(null);
    const go = () => openSettings(group ?? "list", { owner: "tab", home: !group });
    if (view === "vault") { setView("list"); window.setTimeout(go, 80); } else go();
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // From the tile, the widget, the notification or the bubble: open on the list (or Add task).
  useEffect(() => onShell((m) => {
    if (m.type !== "open") return;
    if (m.what === "settings") { settingsRef.current(); return; }
    if (m.what === "island-settings") { settingsRef.current("phone"); return; }   // V1.59 the island's hold menu, Settings
    openSettings(null);
    if (m.what === "gsquad") { openGSquad(true, "chat"); return; }   // a G Squad message notification (ps-gos Notifier.kt, core/squadnotify.ts)
    if (m.what === "fitness") { fitPop.open(); return; }   // the rest timer's notification (ps-gos Fitness.kt)
    // V1.55 Open task on a reminder's notification (ps-gos Remind.kt): the list, with that task glowing (views/TaskMap.tsx).
    if (typeof m.what === "string" && m.what.startsWith("task:")) {
      const id = m.what.slice(5);
      setView("list");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("ps-open-task", { detail: id })), 300);
      return;
    }
    setView(m.what === "inbox" ? "inbox" : m.what === "plan" ? "plan" : "list");   // V1.59 plan: a tap on the island's meeting
    if (m.what === "add") window.setTimeout(() => openAddTask("tab"), 260);
  }), []);
  // An older link to the phone's own sheet (V1.43 to V1.46) lands on Settings, This phone.
  useEffect(() => {
    const f = () => settingsRef.current("phone");
    window.addEventListener("ps-phone-settings", f);
    return () => window.removeEventListener("ps-phone-settings", f);
  }, []);
  // Back: the menu first, then Time zones goes back to Meetings, then the vault pages go back to the list. (Settings and
  // the layers inside the list close on Escape, which the back gesture sends next, gos/touch.ts.)
  useEffect(() => {
    const f = (e: Event) => {
      if (document.querySelector(".fit-pop-layer")) return;   // the Fitness pop up handles back itself (FitnessPop.tsx)
      const ntMin = document.querySelector<HTMLButtonElement>(".nt-min");
      const gear = document.querySelector<HTMLButtonElement>(".gos-home .tm-tr .hover-pop.open > .tm-pill-btn");
      if (menu) { e.preventDefault(); setMenu(false); }
      else if (gear && !document.querySelector(".ms-layer")) { e.preventDefault(); gear.click(); }   // the gear sheet
      else if (show && view === "plan" && !document.querySelector(".dx-layer, .ms-layer, .tm-add-layer, .scrim, [role='dialog']:not(.tm-overlay)")) { e.preventDefault(); setShow(null); }
      // The big New tasks pop-up: back tucks it into its bubble (it never closes on Escape).
      else if (ntMin && !document.querySelector(".dx-layer, .tm-add-layer")) { e.preventDefault(); ntMin.click(); }
      else if (view === "vault" && !document.querySelector(".scrim, [role='dialog']:not(.tm-overlay)")) { e.preventDefault(); setView("list"); }
      else if (view.startsWith("page:") && !document.querySelector(".dx-layer, .cs-layer, .ms-layer, .tm-add-layer, .tm-pop-wrap.open, .nt-win, .scrim, .sm-overlay, [role='dialog']:not(.tm-overlay)")) { e.preventDefault(); setView("list"); }
      else if (view === "plan" || view === "inbox") {
        // Only when nothing is open on top of the pane.
        if (!document.querySelector(".dx-layer, .cs-layer, .ms-layer, .tm-add-layer, .tm-pop-wrap.open, .nt-win, .scrim, .sm-overlay, [role='dialog']:not(.tm-overlay)")) { e.preventDefault(); setView("list"); }
      }
    };
    window.addEventListener("gos-back", f);
    return () => window.removeEventListener("gos-back", f);
  }, [menu, show, view]);
  // Time zones shows its clocks open; leaving it folds them again. Any other pane leaves it. The clocks open on hover
  // (a tap on the phone sends one), so they are opened the same way, and opened again if a tap elsewhere folds them.
  useEffect(() => { if (view !== "plan") setShow(null); }, [view]);
  useEffect(() => {
    if (!show) return;
    const dock = () => document.querySelector<HTMLElement>(".gos-home .tm-left .tm-ckdock");
    const hover = (type: "mouseover" | "mouseout") => dock()?.querySelector(".tm-ckpill")?.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: type === "mouseout" ? document.body : null }));
    const keep = () => { if (dock() && !dock()!.classList.contains("open")) hover("mouseover"); };
    const t = window.setTimeout(keep, 60);
    const el = dock();
    const mo = new MutationObserver(() => window.setTimeout(keep, 0));
    if (el) mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => { window.clearTimeout(t); mo.disconnect(); if (dock()?.classList.contains("open")) hover("mouseout"); };
  }, [show]);
  // A tap on the dimmed list behind the gear sheet closes it (and does nothing else).
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const w = e.target as Element | null;
      if (!w?.matches?.(".gos-home .tm-tr .hover-pop.open")) return;
      e.preventDefault(); e.stopPropagation();
      w.querySelector<HTMLButtonElement>(":scope > .tm-pill-btn")?.click();
    };
    window.addEventListener("click", f, true);
    return () => window.removeEventListener("click", f, true);
  }, []);
  // Screen time opens from the menu now, and its button is out of sight: a tap anywhere outside its card closes it (the
  // tap does nothing else). Its card used to close when the finger left the button, which is gone. Back still closes it.
  useEffect(() => {
    let swallow = false;
    const down = (e: PointerEvent) => {
      const open = document.querySelector<HTMLElement>(".gos-home .tm-tr .tm-st.open");
      if (!open || (e.target as Element | null)?.closest?.(".tm-st-pop")) return;
      e.preventDefault(); e.stopPropagation();
      open.querySelector<HTMLElement>(".tm-st-btn")?.click();   // first: the swallow below would eat this click too
      swallow = true;
      window.setTimeout(() => { swallow = false; }, 500);   // a drag sends no click: never eat a later tap
    };
    const click = (e: MouseEvent) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("click", click, true);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("click", click, true); };
  }, []);
  // Backgrounds and sounds only run while the phone shows PS.
  // V1.47: when Fitness opens, closes or shrinks, the list's background and moving looks stop or start once the
  // Fitness window has finished moving (600 ms in, 500 ms out). Each switch rebuilds the whole list, and doing it in
  // the tap held up the window's first frame.
  const fitWas = useRef(fit);
  useEffect(() => {
    const on = g.visible && view !== "vault" && fit !== "open";
    const moved = (fitWas.current === "open") !== (fit === "open");
    fitWas.current = fit;
    if (!moved) { setPsOverlayShown(on); return; }
    const t = window.setTimeout(() => setPsOverlayShown(on), fit === "open" ? 650 : 520);
    return () => window.clearTimeout(t);
  }, [g.visible, view, fit]);
  // V1.47: the Tab list element is made once, so a pane switch, the Gym button, the menu, the PS sheet or an
  // update's progress no longer rebuild the whole list (it follows the vault by itself).
  const go = (v: View) => { if (v !== view) { haptic("press"); primeSfx(); setView(v); } else if (v === "plan" && show) { haptic("press"); setShow(null); } };
  const goRef = useRef(go);
  goRef.current = go;
  const goStable = useMemo(() => (v: string) => goRef.current(v as View), []);
  // The page showing, for its background and look (TaskMap and App read them) and for a page of panels (PhonePages).
  const curPage = view === "vault" ? null : pl.pages.find((p) => viewOf(p) === view) ?? null;
  const listAt = order.indexOf("list");
  useEffect(() => {
    if (!curPage) { setPhoneNow({ layout: pl, page: null, bg: null, look: null, side: "r", order, go: goStable }); return; }
    const lk = lookOf(pl, curPage.id);
    setPhoneNow({ layout: pl, page: curPage, bg: lk.bg, look: lk.look, side: order.indexOf(viewOf(curPage)) < listAt ? "l" : "r", order, go: goStable });
  }, [pl, curPage, order, listAt, goStable]);
  useEffect(() => () => clearPhoneNow(), []);
  // The navbar's edge: the page makes room for it at the top or the bottom (gos/phonepages.css).
  useEffect(() => { document.documentElement.dataset.gosNav = pl.nav.edge; }, [pl.nav.edge]);
  // A change from the Mac (or this phone) glides: the navbar's buttons slide to their new places (gos/flip.ts).
  const dockRef = useRef<HTMLElement>(null);
  useFlip(dockRef, `${pl.nav.items.join()}|${pl.nav.align}|${pl.nav.edge}`, ".gos-dock-btn[data-flip]");
  const list = useMemo(() => <Overlay onClose={() => {}} hint="Tap a task to work on it. Hold one to lift it, then drag." />, []);
  // PS 1.66 the round Add task button (bottom right on every page and panel) and the island inside PS. Each has its own switch
  // in Settings, This phone (gos/phoneprefs.ts); both on by default.
  const fabOn = usePhonePref("addButton");
  const wheelOn = usePhonePref("wheel");
  useEffect(() => {
    const r = document.documentElement;
    if (wheelOn) r.dataset.gosWheel = ""; else delete r.dataset.gosWheel;
    return () => { delete r.dataset.gosWheel; };
  }, [wheelOn]);
  // Which hidden buttons the home had last time it was drawn: the wheel on the Vault pages (no home under them) offers the same.
  const seen = useRef(new Map<string, boolean>());
  useEffect(() => {
    const r = document.documentElement;
    if (fabOn) r.dataset.gosFab = ""; else delete r.dataset.gosFab;
    return () => { delete r.dataset.gosFab; };
  }, [fabOn]);

  const owner = s.status === "unlocked" && s.role === "owner";
  // The mobile web app has no fingerprint: its sign in screen offers Change project instead (src/mobile/).
  if (!owner) return s.status === "locked" ? (MWEB ? <MobileLockExtras /> : <FingerprintCard remembered={g.remembered} />) : null;
  // While the phone does a background check there is nobody looking: draw nothing heavy.
  if (!g.visible && view !== "vault" && fit === "closed") return null;

  const red = isRedAccount(s);
  // The navbar's buttons (Rules only on the developer's account), and which one glows.
  const dockItems = pl.nav.items.filter((it) => it !== "rules" || red);
  const glowAt = dockItems.findIndex((it) => it === "settings" ? settingsOpen : it === "gym" ? fit !== "closed" && !settingsOpen : it === "sounds" ? sbOpen && !settingsOpen && fit === "closed" : it === "rules" ? !!book && !settingsOpen : !settingsOpen && it === view);
  // The book draws inside the list, so from the Vault pages it first goes back to the list.
  // Do Not Disturb (views/Dnd.tsx): a tap turns it on, a tap while on opens its sheet. In the thumb row on every pane.
  const dnd = <DndButton st={settingsData(s)} s={s} act={(o) => setDnd(o)} homeTz={settingsData(s).tmHomeTz || undefined} size={24} />;
  const rules = () => { haptic("press"); primeSfx(); openSettings(null); setMenu(false); if (view === "vault") setView("list"); openRuleBook("tab", "edit"); void sync(); };   // fresh rules from the Mac straight away
  // What a menu item does: most tap the real button where it still renders (hidden, gos.css), so it opens as before.
  const pick = (it: MenuItem) => {
    haptic("press"); primeSfx();
    if (it.id === "rules") { rules(); return; }
    if (it.id === "settings") { settings(); return; }
    setMenu(false);
    const later = (f: () => void) => { if (view === "vault") { setView("list"); window.setTimeout(f, 120); } else f(); };
    if (it.id === "clocks") { setView("plan"); setShow("clocks"); return; }
    if (it.id === "gsquad") { later(() => openGSquad(true)); return; }
    if (it.id === "goals") { later(() => window.dispatchEvent(new Event("ps-open-goals"))); return; }
    if (it.sel) later(() => document.querySelector<HTMLElement>(`.gos-home ${it.sel}`)?.click());
  };
  // From anywhere: Quick add opens straight away. The Vault pages have no list under them, so it goes back to the list first.
  const addNow = () => {
    primeSfx();   // the buzz came on the press already
    if (view === "vault") { setView("list"); window.setTimeout(() => openAddTask("tab"), 140); } else openAddTask("tab");
  };
  // A tap on the island: the page or screen its moment belongs to.
  const openFrom = (o: MomentOpen) => {
    primeSfx();
    if (o === "gsquad") { openGSquad(true, "chat"); return; }
    if (o === "gym") { fitPop.open(); return; }
    if (o.startsWith("task:")) {
      const id = o.slice(5);
      if (view !== "list") setView("list");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("ps-open-task", { detail: id })), 300);
      return;
    }
    go(o as View);
  };
  // ---------- the wheel (PS 1.67) ----------
  const has = (sel: string) => {
    if (!document.querySelector(".gos-home")) return seen.current.get(sel) ?? true;   // the Vault pages: as the home last had it
    const v = !!document.querySelector(`.gos-home ${sel}`);
    seen.current.set(sel, v);
    return v;
  };
  const wheelList = () => wheelItems({ red, has, show: (id) => (id === "sleep" ? sleepModeOf(settingsData(s)).show : true) });
  const wheelLive = () => {
    const text = (sel: string) => document.querySelector(`.gos-home ${sel}`)?.textContent?.replace(/\s+/g, " ").trim() || "";
    const out: Partial<Record<WheelId, string>> = {};
    const st = text(".tm-st-v"), tl = text(".tm-tl-pill").replace(/^Timelines\s*/, ""), nu = text(".nu-pill").match(/\d+/)?.[0];
    if (st) out.screentime = `${st} today, on this phone and your Macs.`;
    if (tl) out.timelines = `Next: ${tl}`;
    if (nu) out.numerology = `Today's number is ${nu}.`;
    const dndOn = !!document.querySelector(".gos-wh-dnd .dnd-btn.on");
    out.dnd = dndOn ? "On now. Lift here to see what it mutes or turn it off." : "Off. Lift here to turn it on.";
    return out;
  };
  // Launch an item full screen out of its spot (gos/launch.ts). A screen the wheel opened before steps aside first.
  const wheelLaunch = (id: WheelId, at: Pt, size: number) => {
    primeSfx();
    const from = { getBoundingClientRect: () => new DOMRect(at.x - size / 2, at.y - size / 2, size, size) } as unknown as Element;
    const run = () => {
      if (settingsOpen && id !== "settings") openSettings(null);
      if (id !== "gym" && fitPop.get() === "open") fitPop.min();   // a workout steps aside to its bubble, like an app to the background
      if (id === "sleep") { launch(at, size, () => { void goToSleep(); }, "none"); return; }
      if (id === "dnd") {
        const btn = () => document.querySelector<HTMLElement>(".gos-wh-dnd .dnd-btn");
        const wasOn = !!document.querySelector(".gos-wh-dnd .dnd-btn.on");
        // Off: on at once, then its sheet (what it mutes, how long, off) so there is something to see. On: the sheet.
        launch(at, size, () => { btn()?.click(); if (!wasOn) window.setTimeout(() => btn()?.click(), 160); }, "none");
        return;
      }
      if (id === "gym") { fitPop.open(from); return; }   // Fitness grows out of the spot by itself (fitness/FitnessPop.tsx)
      if (id === "sounds") { launch(at, size, () => openSoundboard(from as HTMLElement), "own"); return; }
      if (id === "whatsnew") { launch(at, size, () => openWhatsNew()); return; }
      if (id === "plan" || id === "inbox") { launch(at, size, () => { setShow(null); if (view !== id) { setView(id); } }, "home"); return; }
      if (id === "vault") { launch(at, size, () => go("vault"), "none"); return; }
      const it = MENU.find((m) => m.id === id);
      if (!it) return;
      if (id === "clipboard") { launch(at, size, () => { document.querySelector<HTMLElement>(`.gos-home ${it.sel}`)?.click(); }, "none"); return; }
      launch(at, size, () => pick(it), id === "clocks" ? "home" : "layer");
    };
    if (closeLaunched()) window.setTimeout(run, 140); else run();
  };
  return createPortal(
    <>
      <FitnessPop />
      <NewPopupsHost />{/* the "new in this version" pop-ups (V1.56): only the open source one shows on the phone */}
      <TipsHost />{/* the first use tips (V1.55): one finger swipe, the dots, a right click... only when the list is showing */}
      <SoundboardHost anchor={() => null} />
      <PhoneEditMount kind={kind} red={red} />{/* V1.56 the phone's own Edit mode (gos/PhoneEditMode.tsx) */}
      {view !== "vault" && (
        <div className="gos-home" data-pane={isPane(view) ? view : curPage?.kind === "panels" ? (order.indexOf(view) < listAt ? "panels-l" : "panels-r") : "list"} data-show={view === "plan" && show ? show : undefined}>
          <Swipe pane={isPane(view) ? view : "list"} order={order} onPane={go} invert={settingsData(s).swipeInvert === true}>{list}</Swipe>
        </div>
      )}
      {view === "plan" && !show && (
        // Shown by gos.css only while the Plan pane has no Meetings panel (an account with no calendar yet).
        <div className="gos-plan-empty" role="status">
          <b>No meetings coming up</b>
          <span>{wheelOn ? "Time zones, Timelines, Goals and the rest are on the wheel: hold the round button at the bottom left." : "Time zones, Timelines, Goals and the rest are in the menu, top left."}</span>
        </div>
      )}
      {view !== "vault" && !wheelOn && <GosMenu open={menu} onOpen={setMenu} red={red} onPick={pick} />}
      {wheelOn && <PhoneWheel items={wheelList} live={wheelLive} onLaunch={wheelLaunch} />}
      {wheelOn && <span className="gos-wh-dnd" aria-hidden="true">{dnd}</span>}
      {view === "plan" && show && (
        <button type="button" className="gos-show-back" onClick={() => { haptic("press"); setShow(null); }} aria-label="Back to Meetings">
          <svg {...sv} width={18} height={18} strokeWidth={2.4}><path d="M15 6l-6 6 6 6" /></svg>
          <span>{MENU.find((m) => m.id === show)?.label}</span>
        </button>
      )}
      {(view === "list" || view === "plan") && <ThumbRow dnd={dnd} />}
      {view === "inbox" && <div className="gos-thumb">{dnd}</div>}
      <PhoneIsland hidden={view === "vault" || settingsOpen || menu || !!book || (view === "plan" && !!show)} onOpen={openFrom} />
      {fabOn && (
        <button type="button" className="gos-fab" onPointerDown={() => haptic("press")} onClick={addNow} aria-label="Add a task">
          <svg {...sv} width={28} height={28} strokeWidth={2.5}><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}
      {!g.online && <div className="gos-offline" role="status">Offline. Your saved copy is open</div>}
      {red && <BgProblemCard />}
      {/* The navbar (V1.56: its buttons, their order, its edge and its place come from the phone layout). */}
      <nav ref={dockRef} className="gos-dock" aria-label="PS" data-edge={pl.nav.edge} data-align={pl.nav.align} style={{ ["--n" as string]: dockItems.length }}>
        {dockItems.map((it) => {
          if (it === "plan") return <DockBtn key={it} flip={it} on={view === "plan"} onClick={() => go("plan")} label="Plan" icon={<PlanIcon />} />;
          if (it === "list") return <DockBtn key={it} flip={it} on={view === "list"} onClick={() => go("list")} label="List" icon={<ListIcon />} />;
          if (it === "inbox") return <DockBtn key={it} flip={it} on={view === "inbox"} onClick={() => go("inbox")} label="Inbox" icon={<InboxIcon />} />;
          if (it === "gym") return <DockBtn key={it} flip={it} on={fit !== "closed"} onClick={(el) => { haptic("press"); primeSfx(); fitPop.open(el); }} label="Gym" icon={<DumbbellIcon size={24} />} />;
          // The Soundboard (V1.47, src/soundboard/), next to Gym: audio and video, the player, the queue, timed plays.
          if (it === "sounds") return <DockBtn key={it} flip={it} on={sbOpen} onClick={(el) => { haptic("press"); primeSfx(); openSoundboard(el); }} label="Sounds" icon={<NoteIcon size={24} />} />;
          if (it === "vault") return <DockBtn key={it} flip={it} on={view === "vault"} onClick={() => go("vault")} label="Vault" icon={<VaultIcon />} />;
          if (it === "rules") return <Fragment key={it}>{red && <DockBtn flip={it} on={!!book} onClick={rules} label="Rules" icon={<span className="gos-dock-rb">PS</span>} />}</Fragment>;
          if (it === "settings") return <DockBtn key={it} flip={it} on={settingsOpen} onClick={() => { haptic("press"); primeSfx(); if (settingsOpen) openSettings(null); else settings(); }} label={MWEB ? "Settings" : "PS"} icon={<GearIcon />} badge={g.update.state === "available" || g.update.state === "ready"} />;
          if (it.startsWith("page:")) return <DockBtn key={it} flip={it} on={view === it} onClick={() => go(it as View)} label={navLabel(pl, it)} icon={<PageIcon />} />;
          return null;
        })}
        <span className="gos-dock-glow" aria-hidden="true" style={{ ["--i" as string]: glowAt, opacity: glowAt < 0 ? 0 : undefined }} />
      </nav>
    </>,
    document.body,
  );
}

// Under the thumb, above the dock (List and Plan): Undo and New tasks live in the Inbox pane's
// column, which is off screen here, so this row mirrors them and taps the real ones. Plus a big +.
// The Undo copy leaves by itself after UNDO_SHOWN_MS and comes back with the next thing to undo;
// the real one stays in the Inbox pane for 15 minutes as before.
const UNDO_SHOWN_MS = 6000;
function ThumbRow({ dnd }: { dnd: ReactNode }) {
  const [undo, setUndo] = useState<{ title: string; n: string } | null>(null);
  const [undoGone, setUndoGone] = useState(false);
  useEffect(() => {
    setUndoGone(false);
    if (!undo) return;
    const t = window.setTimeout(() => setUndoGone(true), UNDO_SHOWN_MS);
    return () => window.clearTimeout(t);
  }, [undo]);
  const [nt, setNt] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const u = document.querySelector(".gos-home .tm-right .tm-undo");
      const next = u ? { title: u.querySelector(".tm-undo-t")?.textContent || "", n: u.querySelector(".tm-undo-n")?.textContent || "" } : null;
      setUndo((cur) => (cur?.title === next?.title && cur?.n === next?.n ? cur : next));
      const b = document.querySelector(".gos-home .tm-right .nt-bubble");
      const count = b ? (b.querySelector(".num")?.textContent || b.textContent || "").replace(/\D+/g, " ").trim().split(" ")[0] || "" : null;
      setNt(document.querySelector(".nt-pop") ? null : count);
    };
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(read); });
    mo.observe(document.querySelector(".gos-home") || document.body, { childList: true, subtree: true, characterData: true });
    read();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  const tap = (sel: string) => { haptic("press"); document.querySelector<HTMLElement>(`.gos-home .tm-right ${sel}`)?.click(); };
  return (
    <div className="gos-thumb">
      {undo && !undoGone && (
        <button type="button" className="gos-thumb-undo" key={undo.title} onClick={() => tap(".tm-undo")} aria-label={`Undo: ${undo.title}`}>
          <svg {...sv} width={18} height={18}><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          <span className="gos-thumb-l">Undo</span><span className="gos-thumb-t">{undo.title}</span>{undo.n && <span className="gos-thumb-n">{undo.n}</span>}
        </button>
      )}
      {nt !== null && (
        <button type="button" className="gos-thumb-nt" onClick={() => tap(".nt-bubble")} aria-label="Open New tasks">
          <span className="gos-thumb-nn">{nt}</span> New
        </button>
      )}
      <SleepRow where="thumb" />
      {dnd}
      <button type="button" className="gos-thumb-add" onPointerDown={() => haptic("press")} onClick={() => { primeSfx(); openAddTask("tab"); }} aria-label="Add a task">
        <svg {...sv} width={26} height={26} strokeWidth={2.4}><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  );
}

// Top left: the menu (V1.47). A panel from the left with everything that used to sit on the Plan pane and in the top row,
// each with its icon and one line, a live value where it has one (today's screen time, the next timeline, today's
// number). Items show only when their real button is there (the developer only ones, a feature switched off), checked as it opens.
function GosMenu({ open, onOpen, red, onPick }: { open: boolean; onOpen: (v: boolean) => void; red: boolean; onPick: (it: MenuItem) => void }) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [live, setLive] = useState<Partial<Record<MenuId, string>>>({});
  const [cleared, setCleared] = useState(false);
  const toggle = () => {
    haptic("press");
    if (!open) {
      const has = (sel: string) => !!document.querySelector(`.gos-home ${sel}`);
      setItems(menuItems({ red, has }));
      const text = (sel: string) => document.querySelector(`.gos-home ${sel}`)?.textContent?.replace(/\s+/g, " ").trim() || "";
      setLive({ screentime: text(".tm-st-v"), timelines: text(".tm-tl-pill").replace(/^Timelines\s*/, ""), numerology: text(".nu-pill").match(/\d+/)?.[0] ?? "" });
      setCleared(false);
    }
    onOpen(!open);
  };
  const tap = (it: MenuItem) => {
    if (it.id === "clipboard") {   // a quick action: it stays in the menu and says it is done
      haptic("press"); primeSfx();
      document.querySelector<HTMLElement>(`.gos-home ${it.sel}`)?.click();
      setCleared(true);
      window.setTimeout(() => setCleared(false), 1800);
      return;
    }
    onPick(it);
  };
  let head = "";
  return (
    <div className={`gos-menu${open ? " open" : ""}`}>
      {open && <div className="gos-menu-dim" onClick={() => onOpen(false)} aria-hidden="true" />}
      <button type="button" className="gos-menu-btn" onClick={toggle} aria-expanded={open} aria-label="Menu">
        <svg {...sv} width={22} height={22}>{open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />}</svg>
      </button>
      {open && (
        <nav className="gos-menu-list" aria-label="Menu">
          {items.map((it, i) => {
            const sec = it.section !== head ? (head = it.section) : null;
            const got = live[it.id];
            const value = it.id === "clipboard" && cleared ? "Cleared" : it.live === "value" ? got : undefined;
            const line = it.id === "clipboard" && cleared ? "Nothing is on the clipboard now." : it.live === "line" && got ? `Next: ${got}` : it.line;
            return (
              <div key={it.id} className="gos-menu-it" style={{ ["--i" as string]: i }}>
                {sec && it.section && <h3 className="gos-menu-sec">{sec}</h3>}
                <button type="button" className={`gos-menu-i${it.id === "settings" ? " gos-menu-set" : ""}`} data-menu={it.id} onClick={() => tap(it)}>
                  <span className={`gos-menu-ic${it.id === "rules" ? " gos-menu-ic-rb" : ""}`}>{it.id === "rules" ? <span className="gos-dock-rb">PS</span> : <svg {...sv} width={20} height={20}><path d={it.icon} /></svg>}</span>
                  <span className="gos-menu-t"><b>{it.label}</b><em>{line}</em></span>
                  {value ? <span className={`gos-menu-v${it.id === "clipboard" ? " ok" : ""}`}>{value}</span>
                    : <svg {...sv} width={14} height={14} strokeWidth={2.4} className="gos-menu-go"><path d="M9 6l6 6-6 6" /></svg>}
                </button>
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}

function DockBtn({ on, onClick, label, icon, badge, flip }: { on: boolean; onClick: (el: HTMLElement) => void; label: string; icon: ReactNode; badge?: boolean; flip?: string }) {
  return (
    <button type="button" className={`gos-dock-btn${on ? " on" : ""}`} onClick={(e) => onClick(e.currentTarget)} aria-pressed={on} data-flip={flip}>
      <span className="gos-dock-ic">{icon}{badge && <i className="gos-dot" aria-hidden="true" />}</span>
      <span className="gos-dock-l">{label}</span>
    </button>
  );
}

// A sideways swipe moves between Plan, List and Inbox; the panes follow the finger and settle with
// a spring. Vertical swipes scroll as normal; a held (lifted) row never swipes.
// V1.55: on the List pane a sideways swipe on the list moves between the developer's lists instead (views/ListPager.tsx), so
// there Plan and Inbox are a tap on the dock; from Plan or Inbox a swipe still comes back to the list.
// V1.57 Settings, Controls, Invert swipe: the finger's move counts the other way (core/lists.ts swiped).
function Swipe({ pane, order, onPane, invert, children }: { pane: Pane; order: string[]; onPane: (p: View) => void; invert?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    let sx = 0, sy = 0, dx = 0, mode: "?" | "x" | "y" | null = null;
    const start = (e: TouchEvent) => {
      if (panelOpen()) { mode = null; return; }   // PS 1.66: a full screen panel is open, the pages behind it stay put (core/phonepanels.ts)
      if (e.touches.length !== 1 || (e.target as Element).closest(".tm-add-layer, .dx-layer, .cs-layer, .ms-layer, .nt-win, input, textarea, [contenteditable='true'], input[type='range'], .tm-clocks, .gt-wrap")) { mode = null; return; }
      if (pane === "list" && (e.target as Element).closest(".tm-scroll, .tl-dots")) { mode = null; return; }   // the list's own pages (V1.55)
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; mode = "?";
    };
    const move = (e: TouchEvent) => {
      if (!mode || mode === "y" || document.querySelector(".gos-lifted, [data-dragging]")) return;
      const x = swiped(e.touches[0].clientX - sx, invert), y = e.touches[0].clientY - sy;
      if (mode === "?") {
        if (Math.abs(x) < 12 && Math.abs(y) < 12) return;
        mode = Math.abs(x) > Math.abs(y) * 1.4 ? "x" : "y";
        if (mode === "y") return;
      }
      const i = order.indexOf(pane);
      dx = (i === 0 && x > 0) || (i === order.length - 1 && x < 0) ? x / 4 : x;   // rubber band at the ends
      el.style.setProperty("--gos-drag", `${dx}px`);
      el.classList.add("dragging");
      if (e.cancelable) e.preventDefault();
    };
    const end = () => {
      if (mode !== "x") { mode = null; return; }
      mode = null;
      el.classList.remove("dragging");
      el.style.setProperty("--gos-drag", "0px");
      // V1.56: the pages in the phone layout's order (a page of panels beside Plan or Inbox is a swipe away too).
      const i = order.indexOf(pane), w = el.clientWidth || 400;
      if (dx < -w * 0.22 && i >= 0 && i < order.length - 1) onPane(order[i + 1] as View);
      else if (dx > w * 0.22 && i > 0) onPane(order[i - 1] as View);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", end); };
  }, [pane, onPane, order, invert]);
  return <div ref={ref} className="gos-swipe">{children}</div>;
}

// On the sign in screen: open with the fingerprint (keys from the phone's Keystore).
function FingerprintCard({ remembered }: { remembered: boolean }) {
  const asked = useRef(false);
  const g = useGos();
  useEffect(() => {
    if (remembered && g.visible && !asked.current) { asked.current = true; gosPost({ type: "remember:unlock" }); }
    if (!g.visible) asked.current = false;
  }, [remembered, g.visible]);
  if (!remembered) return null;
  return createPortal(
    <button type="button" className="gos-finger" onClick={() => gosPost({ type: "remember:unlock" })}>
      <FingerIcon /> <span>Open with fingerprint</span>
    </button>,
    document.body,
  );
}

const sv = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function PageIcon() { return <svg {...sv}><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></svg>; }
function PlanIcon() { return <svg {...sv}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>; }
function ListIcon() { return <svg {...sv}><path d="M9 6.5h10M9 12h10M9 17.5h10" /><path d="M4.5 6.5l1 1 2-2M4.5 12l1 1 2-2M4.5 17.5l1 1 2-2" /></svg>; }
function InboxIcon() { return <svg {...sv}><path d="M4 13.5l2.2-7.2A1.5 1.5 0 0 1 7.6 5.3h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.2V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" /><path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20" /></svg>; }
function VaultIcon() { return <svg {...sv}><rect x="4" y="4.5" width="16" height="15" rx="2.5" /><circle cx="12" cy="12" r="3.2" /><path d="M12 8.8v-1M12 16.2v-1M15.2 12h1M7.8 12h1" /></svg>; }
function GearIcon() { return <svg {...sv}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>; }
function FingerIcon() { return <svg {...sv} width={22} height={22}><path d="M12 11v3.5a6 6 0 0 1-1.2 3.6" /><path d="M8.5 9.5a3.5 3.5 0 0 1 7 0V13a9 9 0 0 1-.8 3.8" /><path d="M5.6 15.6A9 9 0 0 1 5.5 13V9.5a6.5 6.5 0 0 1 11.2-4.5" /><path d="M18.3 8a6.5 6.5 0 0 1 .2 1.5V12" /></svg>; }
