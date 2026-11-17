// The setup menu (V1.40, G Squad; cut to the few steps that matter in V1.43, the developer 8 Nov 2026). Once on every account in
// PS on the Mac: a new account gets the welcome, one that ran an earlier version the update offer. Then one short card
// per thing to decide: what it is, what happens if on and if off, and a small drawing of the Tab list on the right
// where a pointer walks to the place it lives. Mac permissions are explained and given right on their card, with
// macOS's answer shown live; G Squad's sharing switches are on theirs. Appearance is one card whose button saves the
// choices and opens Settings, Looks. A progress bar with percent and N left, Back, Skip (leave this one as it is),
// Skip to the end. The summary lists the choices, offers "Delete all example tasks", and Create sets everything at
// once. Not now or Esc change nothing. Settings, General has "Setup menu" to open it again, and "Example tasks".
// Like What's new, it only shows while the Tab list is on screen and asks PS for the keyboard ("dimx"). If PS hides
// the list (System Settings opening for a permission), the menu comes back where it was the next time the list shows.
// The words and rules are in core/welcome.ts; the drawing is views/MiniPs.tsx.
// V1.62: after Create comes one last step, Make PS yours (views/SetupLooks.tsx, core/setuplooks.ts): a background that is not the
// blank one and an effect must be picked before Done. The "setup done" mark is written when it closes (Done or Esc).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { PS, psPost, useOverlayShown, usePsSettings, usePsTab, type PsSettings, type RebootSettings } from "../ps";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { vaultStore } from "../core/vault";
import { settingsData } from "../core/select";
import { isRedAccount } from "../core/account";
import { appName } from "../core/appname";
import { gymPrefs } from "../core/gym";
import { calStatus } from "../core/calstatus";
import { accountOlderThan } from "../core/whatsnew";
import { EXAMPLE_WORDS, hasExamples } from "../core/examples";
import {
  cardPerms, choiceLabel, cleanWelcomeDone, clampStep, fillApp, lastStep, PERM_WORDS, PERMS, progressWords, sectionAt, SETUP_GEN, setupAsked, startChoices, TOUR_DEFAULTS, TOUR_WORDS, tourDeck,
  holdDone, tourPlan, tourProgress, tourSeenOnly, WELCOME_LOCAL_KEY, welcomeStep, type ChoiceValue, type Choices, type PermId, type TourCard, type TourNow, type TourOp,
} from "../core/welcome";
import { taskMapActions } from "./TaskMap";
import { openSettings, settingsWanted } from "./SettingsScreen";
import { SetupAssist } from "./Assistant";
import { useMixerPermission } from "./Mixer";
import { feature } from "../core/features";
import { SR_FEATURE } from "../core/screenrec";
import { askScreenRec, optIn, send as srSend, useScreenRec } from "../screenrec";
import { MiniPs } from "./MiniPs";
import { FitPeek } from "./FitPeek";
import { useFitness } from "../fitness/store";
import { useFitTheme } from "../fitness/theme";
import { setCalendarOn } from "./CalSwitch";
import { SharingList } from "./GSquad";
import { StoreBox } from "./LocalFirst";
import { SetupLooks, SetupLooksDoneButton } from "./SetupLooks";
import { registerSetup, type SetupDetail } from "../setuphook";
import type { Settings } from "../core/model";
import "./whatsnew.css";
import "./welcome.css";

// ---------- open requests, whether it is up (What's new waits), and where it was (a hidden list comes back to it) ----------
let manual = 0;
let showing = false;
let resume: { step: number; touched: Choices; looks?: boolean } | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const sub = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const useManual = () => useSyncExternalStore(sub, () => manual);
/** True while the setup menu is on screen (What's new stays away until it is gone). */
export const useWelcomeShowing = () => useSyncExternalStore(sub, () => showing);
const setShowing = (v: boolean) => { if (showing !== v) { showing = v; emit(); } };

let viaUpdate = false;   // opened from PS's "See what's new and set it up": it shows as the update offer

/** Settings, General: open the setup menu again. With Settings open, Settings goes back into the gear first. */
export function openWelcome() { ask(false); }

/** PS's door (src/setuphook.ts): the update card's "See what's new and set it up" lands here, in the Tab list. */
function onSetupAsked(d: SetupDetail) {
  const a = setupAsked(showing, d.from);
  if (a) ask(a.update);
}

/** The Tab list window, once at start (views/PsApp.tsx PsOverlay): tells PS this build has the setup menu, so after
 *  an update it offers it, and listens for the click. Returns the undo. */
export const startSetupDoor = () => registerSetup(onSetupAsked, { gen: SETUP_GEN });

function ask(update: boolean) {
  viaUpdate = update;
  resume = null;
  if (!settingsWanted()) { manual++; emit(); return; }
  openSettings(null);
  const until = Date.now() + 3000;
  const wait = () => {
    if (document.querySelector(".gs-layer") && Date.now() < until) { requestAnimationFrame(wait); return; }
    manual++; emit();
  };
  requestAnimationFrame(wait);
}

// The dev server only, for pictures: ?welcome=demo opens it, ?welcome=update as the update offer.
const DEV_W = import.meta.env.DEV ? new URLSearchParams(location.search).get("welcome") : null;
if (DEV_W === "demo" || DEV_W === "update") window.setTimeout(() => { manual++; emit(); }, 900);

const readLocal = () => { try { return localStorage.getItem(WELCOME_LOCAL_KEY); } catch { return null; } };
const writeLocal = (v: string) => { try { localStorage.setItem(WELCOME_LOCAL_KEY, v); } catch { /* private window: the synced record still counts */ } };
const BUILT = typeof __PS_WHATSNEW__ === "object" ? __PS_WHATSNEW__.built : "";
const VERSION = __PS_VERSION__.name.replace(/^V/, "");

/** Mounted once, in PS's Tab list window (views/PsApp.tsx). */
export function WelcomeHost() {
  const s = useVault();
  const listShown = useOverlayShown();
  const req = useManual();
  const [auto, setAuto] = useState(false);
  const [asked, setAsked] = useState(0);
  const [update, setUpdate] = useState(DEV_W === "update");
  const decided = useRef(false);
  const synced = s.status === "unlocked" ? settingsData(s).welcomeDone : undefined;

  // Once per page, after the vault is open and has synced, so a menu finished on another device is known.
  useEffect(() => {
    if (decided.current || s.status !== "unlocked" || !s.lastSync || s.syncing) return;
    const t = window.setTimeout(() => {
      if (decided.current) return;
      decided.current = true;
      const v = vaultStore.get();
      if (v.status !== "unlocked") return;
      const older = accountOlderThan(BUILT, [...v.docs.values()].map((d) => d.updatedAt));
      if (welcomeStep({ ps: PS, owner: v.role === "owner", synced: !!v.lastSync, localDone: readLocal(), syncedDone: settingsData(v).welcomeDone }) === "show") {
        setUpdate(older); setAuto(true);
      }
    }, 900);
    return () => window.clearTimeout(t);
  }, [s.status, s.lastSync, s.status === "unlocked" && s.syncing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (auto && cleanWelcomeDone(synced)) { setAuto(false); resume = null; } }, [auto, synced]);
  useEffect(() => { if (req) setAsked(req); }, [req]);

  const open = (auto || asked > 0) && listShown && s.status === "unlocked";
  // V1.58: the Mac's setup island guides through this menu while it is open (ps-mac Sources/SetupIsland.swift).
  useEffect(() => { setShowing(open); psPost({ type: "setupIsland", menu: open }); return () => setShowing(false); }, [open]);
  if (!open) return null;
  return <WelcomePanel key={asked} update={viaUpdate || (update && (auto || DEV_W === "update"))} onDone={() => { setAuto(false); setAsked(0); resume = null; viaUpdate = false; }} />;
}

/** What every choice is now, and what Create needs to turn a choice into a setting. */
function useNow() {
  const s = useVault();
  const st = usePsSettings() as (PsSettings & { reboot?: RebootSettings }) | null;
  const red = isRedAccount(s);
  const set: Settings = settingsData(s);
  const gym = gymPrefs(set.gym, red);
  const fv = useFitness();
  const fitStyle = fv.prefs.style ?? "volt";
  const sr = useScreenRec();
  useEffect(() => { askScreenRec(); }, []);   // asks the Mac for its saved state; macOS is asked for nothing
  const now: TourNow = {
    dnd: !!set.dnd?.on, gym: gym.on,
    screenRec: sr ? sr.enabled : undefined,
    reboot: st?.reboot ? st.reboot.mode === "active" : undefined,
  };
  return { now, red, fitStyle, ctx: { gym } };
}

/** Sends what Create (or Not now) decided. In PS's Tab list every vault write goes through the engine page. */
function run(ops: TourOp[]) {
  for (const op of ops) {
    if (op.to === "native") psPost(op.msg);
    else if (op.to === "looks") void taskMapActions.looks(op.patch as Partial<Settings>);
    else if (op.to === "dnd") void taskMapActions.dnd({ op: op.on ? "on" : "off" });
  }
  psPost({ type: "psSettings:get" });   // the Mac settings show the new state at once
}

function WelcomePanel({ update, onDone }: { update: boolean; onDone: () => void }) {
  const app = appName();
  const w = (k: keyof typeof TOUR_WORDS) => fillApp(TOUR_WORDS[k], app, VERSION);
  const f = (t: string) => fillApp(t, app, VERSION);
  const s = useVault();
  const { now, red, fitStyle, ctx } = useNow();
  const fitTheme = useFitTheme(fitStyle);
  const local = !!s.local;   // local first (V1.44): the account card says where the list lives, with Turn on sync
  const sr = feature("screen-recording");
  const deck = useMemo(() => tourDeck({ red, local, sr }), [red, local, sr]);
  const [step, setStep] = useState(resume?.step ?? 0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [touched, setTouched] = useState<Choices>(resume?.touched ?? {});
  const [phase, setPhase] = useState<"in" | "creating" | "created" | "out">("in");
  // V1.62 the last step, Make PS yours (views/SetupLooks.tsx): after Create, before the menu closes.
  const [looks, setLooks] = useState(resume?.looks ?? false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const choices: Choices = { ...startChoices(deck, now), ...touched };
  const last = lastStep(deck);
  const at = clampStep(step, deck);
  const card: TourCard | null = !looks && at >= 1 && at <= deck.length ? deck[at - 1] : null;
  const prog = tourProgress(at, deck);
  const pw = progressWords(prog);
  const sec = sectionAt(at, deck);
  const set = settingsData(s);
  const examples = s.status === "unlocked" && hasExamples(set.examples, s.docs.values(), set.aware, set.timelines);
  const [exGone, setExGone] = useState(false);
  const [exKept, setExKept] = useState(false);
  resume = { step: at, touched, looks };

  const go = (to: number) => {
    const t = clampStep(to, deck);
    if (t === at || phaseRef.current !== "in") return;
    sfx.hover();
    setDir(t > at ? 1 : -1);
    setStep(t);
  };
  const skipCard = () => { if (card) setTouched((x) => { const o = { ...x }; delete o[card.id]; return o; }); go(at + 1); };
  const close = (ops: TourOp[] | null, then?: () => void) => {
    if (phaseRef.current === "out") return;
    const done = new Date().toISOString();
    writeLocal(done);
    run(ops ?? tourSeenOnly(done));
    phaseRef.current = "out";
    setPhase("out");
    const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => { onDone(); then?.(); }, quick ? 0 : 260);
  };
  const create = () => {
    if (phaseRef.current !== "in") return;
    sfx.done();
    const ops = tourPlan(deck, now, choices, ctx, new Date().toISOString());
    phaseRef.current = "creating";
    setPhase("creating");
    window.setTimeout(() => { setPhase("created"); phaseRef.current = "created"; }, 650);
    // V1.62: the choices are set now, then the last step, Make PS yours. "Setup done" is written when it closes (Done or Esc).
    window.setTimeout(() => { run(holdDone(ops)); phaseRef.current = "in"; setPhase("in"); setDir(1); setLooks(true); }, 1900);
  };
  /** The Appearance card: save what was picked so far, then open Settings on Looks. */
  const openLooks = () => {
    if (phaseRef.current !== "in") return;
    sfx.click();
    close(tourPlan(deck, now, choices, ctx, new Date().toISOString()), () => openSettings("looks"));
  };
  const pick = (id: string, v: ChoiceValue) => { sfx.click(); setTouched((t) => ({ ...t, [id]: v })); };

  useLayoutEffect(() => {
    psPost({ type: "dimx", open: true });
    psPost({ type: "psSettings:get" });
    psPost({ type: "reboot:refresh" });
    return () => { psPost({ type: "dimx", open: false }); };
  }, []);
  const keys = useRef({ go, close, at, looks });
  keys.current = { go, close, at, looks };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = keys.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); k.close(null); }
      else if (k.looks) return;   // the last step has no steps either side (Create already ran)
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); if (k.at < last) k.go(k.at + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); k.go(k.at - 1); }
    };
    const g = window as Window & { __psDimxClose?: () => boolean };
    const before = g.__psDimxClose;
    const esc = () => { keys.current.close(null); return true; };
    window.addEventListener("keydown", key, true);
    g.__psDimxClose = esc;
    return () => {
      window.removeEventListener("keydown", key, true);
      if (g.__psDimxClose === esc) { if (before) g.__psDimxClose = before; else delete g.__psDimxClose; }
    };
  }, [last]);

  const summary = at === last && !looks;
  const showPerm = !!card?.perm && (card.permWhen === "always" || choices[card.id] === true);
  const sections = useMemo(() => [...new Set(deck.map((c) => c.section))], [deck]);
  const where = card ? (showPerm ? PERMS[card.perm!].where : card.where) : null;
  const perms = card ? cardPerms(card) : [];
  return createPortal(
    <div className={`wt-layer${phase === "out" ? " out" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="wt-dim" aria-hidden="true" />
      <section className={`wt-card wn-card${summary || looks ? " sum" : ""}${at === 0 && !looks ? " intro" : ""}${card ? " two" : ""}${looks ? " lk" : ""}`} role="dialog" aria-modal="true" aria-labelledby="wt-title">
        <div className="wn-glow" aria-hidden="true" />
        {at > 0 && !looks && (
          <div className="wt-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={prog.pct} aria-label={`${pw.done}, ${pw.left}`}>
            <div className="wt-bar"><i style={{ transform: `scaleX(${Math.max(0.02, prog.pct / 100)})` }} /></div>
            <div className="wt-prog-t">
              <b className="num">{pw.done}</b>
              {!summary && <span className="num">{pw.left}</span>}
              {!summary && <button type="button" className="wt-end" onClick={() => go(last)}>{w("toEnd")}</button>}
            </div>
          </div>
        )}
        <div className="wt-body-grid">
          <div className="wt-stage">
            <div key={looks ? "looks" : at} className={`wt-page ${dir > 0 ? "fwd" : "back"}`}>
              {looks && <SetupLooks />}
              {at === 0 && !looks && (
                <div className="wt-intro">
                  <span className="wt-orb" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path className="wn-star" d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" /><path className="wn-spark" d="M19 15.5v4M17 17.5h4" />
                    </svg>
                  </span>
                  <span className="wn-eyebrow">{update ? w("updateEyebrow") : w("introEyebrow")}</span>
                  <h2 id="wt-title" className="wt-h">{update ? w("updateTitle") : w("introTitle")}</h2>
                  <p className="wt-body">{update ? w("updateBody") : w("introBody")}</p>
                  {!update && examples && <p className="wt-note">{w("introExamples")}</p>}
                  <p className="wt-note">{w("laterNote")}</p>
                </div>
              )}
              {card && (
                <div className="wt-feat">
                  <span className="wn-eyebrow">{sec ? (sec.of > 1 ? `${sec.name} · ${sec.i} of ${sec.of}` : sec.name) : card.section}</span>
                  <h2 id="wt-title" className="wt-h">{f(card.title)}</h2>
                  <dl className="wt-rows">
                    <div style={{ "--i": 0 } as CSSProperties}><dt>{w("labelWhat")}</dt><dd>{f(card.what)}</dd></div>
                    {card.ifOn && <div style={{ "--i": 1 } as CSSProperties} className={choices[card.id] === true ? "hl" : ""}><dt>{w("labelOn")}</dt><dd>{f(card.ifOn)}</dd></div>}
                    {card.ifOff && <div style={{ "--i": 2 } as CSSProperties} className={choices[card.id] === false ? "hl" : ""}><dt>{w("labelOff")}</dt><dd>{f(card.ifOff)}</dd></div>}
                  </dl>
                  {card.ifOn && (
                    <div className="wt-sw-row">
                      <button type="button" role="switch" aria-checked={choices[card.id] === true} className={`wt-sw${choices[card.id] === true ? " on" : ""}`}
                        aria-label={`${f(card.title)}: ${choices[card.id] ? (card.yesNo ? "Yes" : w("on")) : (card.yesNo ? "No" : w("off"))}`} onClick={() => pick(card.id, !choices[card.id])}>
                        <span className="wt-sw-l">{card.yesNo ? "No" : w("off")}</span><span className="wt-sw-k" aria-hidden="true"><i /></span><span className="wt-sw-l">{card.yesNo ? "Yes" : w("on")}</span>
                      </button>
                    </div>
                  )}
                  {card.share && <div className="wt-share"><SharingList /></div>}
                  {card.store && <div className="wt-share"><StoreBox /></div>}
                  {card.open === "looks" && (
                    <div className="wt-open-row">
                      <button type="button" className="wt-btn go sm wt-open" onClick={openLooks}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r="1.6" /><circle cx="17.5" cy="10.5" r="1.6" /><circle cx="8.5" cy="7.5" r="1.6" /><circle cx="6.5" cy="12.5" r="1.6" /><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z" /></svg>
                        {w("openLooks")}
                      </button>
                    </div>
                  )}
                  {card.note && <p className="wt-note">{f(card.note)}</p>}
                  <SetupAssist />
                  {showPerm && <PermBox id={card.perm!} onUsed={() => { if (card.permWhen === "on") setTouched((t) => ({ ...t, [card.id]: true })); }} />}
                  {perms.map((id) => <PermBox key={id} id={id} compact onUsed={() => {}} />)}
                  {choices[card.id] === true && (card.permsOn ?? []).map((id) => <PermBox key={id} id={id} onUsed={() => {}} />)}
                </div>
              )}
              {summary && (
                <div className="wt-sum">
                  <span className="wn-eyebrow">{w("summaryEyebrow")}</span>
                  <h2 id="wt-title" className="wt-h">{w("summaryTitle")}</h2>
                  <p className="wt-body">{w("summaryBody")}</p>
                  <div className="wt-list">
                    {sections.map((name) => {
                      const cs = deck.filter((c) => c.section === name && !c.info);
                      if (!cs.length) return null;
                      return (
                        <div key={name} className="wt-sec">
                          <h3>{name}</h3>
                          {cs.map((c) => {
                            const v = choices[c.id];
                            const moved = (now[c.id] ?? TOUR_DEFAULTS[c.id]) !== v;
                            return (
                              <button key={c.id} type="button" className={`wt-li${moved ? " moved" : ""}`} onClick={() => go(deck.indexOf(c) + 1)}>
                                <span>{f(c.sumTitle ?? c.title)}</span><b>{f(choiceLabel(c, v))}</b>{moved && <em>{w("changed")}</em>}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  {(examples || exGone) && !exKept && <ExamplesBox gone={exGone} onGone={setExGone} keep={() => setExKept(true)} />}
                  <p className="wt-note">{w("summaryNote")}</p>
                </div>
              )}
            </div>
          </div>
          {card && where && (
            <aside className="wt-side" aria-label={w("labelWhere")}>
              {card.fit && <FitPeek kind={card.fit} rest={120} restSmall={90} sets={3} theme={fitTheme} style={fitStyle} />}
              <MiniPs where={{ ...where, sheet: where.sheet ? { ...where.sheet, rows: where.sheet.rows.map(f) } : undefined }} />
              <p className="wt-where"><b>{w("labelWhere")}</b>{f(where.text)}</p>
            </aside>
          )}
        </div>
        {looks ? (
          <footer className="wt-foot">
            <span className="wt-gap" />
            <SetupLooksDoneButton onDone={() => close(null)} />
          </footer>
        ) : <footer className="wt-foot">
          {at === 0
            ? <button type="button" className="wt-btn ghost" onClick={() => { sfx.click(); close(null); }}>{w("later")}</button>
            : <button type="button" className="wt-btn ghost" onClick={() => go(at - 1)} disabled={phase !== "in"}>{w("back")}</button>}
          {card && <button type="button" className="wt-btn ghost" title={w("skipTitle")} onClick={skipCard}>{w("skip")}</button>}
          <span className="wt-gap" />
          {summary
            ? (
              <button type="button" className={`wt-btn go create ${phase}`} onClick={create} disabled={phase !== "in"} aria-live="polite">
                {phase === "in" && w("create")}
                {phase === "creating" && <><span className="wt-spin" aria-hidden="true" />{w("creating")}</>}
                {(phase === "created" || phase === "out") && <><svg className="wt-tick" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>{w("created")}</>}
              </button>
            )
            : <button type="button" className="wt-btn go" onClick={() => go(at + 1)}>{at === 0 ? (update ? w("startUpdate") : w("start")) : w("next")}</button>}
        </footer>}
      </section>
    </div>,
    document.body,
  );
}

/** A Mac permission, explained and given right here, with macOS's answer shown live. `compact`: an optional one, in a
 *  shorter box (why, what it never does, the button). */
function PermBox({ id, onUsed, compact }: { id: PermId; onUsed: () => void; compact?: boolean }) {
  const app = appName();
  const f = (t: string) => fillApp(t, app);
  const p = PERMS[id];
  const tab = usePsTab();
  const cal = useSyncExternalStore(calStatus.subscribe, calStatus.get);
  const mix = useMixerPermission();
  const st = usePsSettings() as (PsSettings & { reboot?: RebootSettings }) | null;
  const reboot: RebootSettings | undefined = st?.reboot;
  const sr = useScreenRec();
  const [pressed, setPressed] = useState(false);
  let state: "done" | "waiting" | "denied" | "missing" | "idle" = "idle";
  if (id === "ax") state = tab?.trusted ? "done" : pressed ? "waiting" : "idle";
  else if (id === "calendar") state = cal.connected === true ? "done" : cal.connected === false ? "denied" : pressed ? "waiting" : "idle";
  else if (id === "audio") state = mix === "ok" ? "done" : mix === "denied" && pressed ? "denied" : pressed ? "waiting" : "idle";
  else if (id === "screen" || id === "mic") { const p = sr?.perms[id]; state = p === "granted" ? "done" : p === "denied" && pressed ? "denied" : pressed ? "waiting" : "idle"; }
  else if (id === "reboot") state = reboot?.helper === "on" ? "done" : reboot?.helper === "missing" ? "missing" : reboot?.helper === "approve" || pressed ? "waiting" : "idle";
  const act = () => {
    sfx.click(); setPressed(true); onUsed();
    if (id === "ax") psPost({ type: "tab:permission" });
    else if (id === "calendar") { if (cal.connected === false) psPost({ type: "localCal", op: "settings" }); else setCalendarOn(true); }
    else if (id === "audio") psPost({ type: "mixer", op: "allow" });
    else if (id === "reboot") psPost({ type: "reboot:setup" });
    // Screen recording: the person said Yes on this card and pressed this button, so the opt in is sent first (the Mac asks
    // macOS for nothing while it is off), then the one macOS question this box explained.
    else if (id === "screen") { optIn(true); srSend("askScreen"); }
    else if (id === "mic") { optIn(true); srSend("askMic"); }
  };
  const stateText = state === "done" ? PERM_WORDS.done : state === "waiting" ? (id === "reboot" ? PERM_WORDS.waitingHelper : PERM_WORDS.waiting) : state === "denied" ? PERM_WORDS.denied : state === "missing" ? PERM_WORDS.missing : "";
  return (
    <div className={`wt-perm ${state}${compact ? " compact" : ""}`} role="group" aria-label={f(p.title)}>
      <b className="wt-perm-h">{f(p.title)}</b>
      <dl>
        {!compact && <div><dt>{PERM_WORDS.label}</dt><dd>{f(p.asks)}</dd></div>}
        <div><dt>{PERM_WORDS.why}</dt><dd>{f(p.why)}</dd></div>
        <div><dt>{PERM_WORDS.never}</dt><dd>{f(p.never)}</dd></div>
        <div><dt>{PERM_WORDS.ifNo}</dt><dd>{f(p.ifNo)}</dd></div>
      </dl>
      {id === "reboot" && reboot?.fileVault === "off" && <p className="wt-warn">{PERM_WORDS.fileVault}</p>}
      {id === "reboot" && reboot?.passwordImmediately === false && <p className="wt-warn">{PERM_WORDS.passwordLater}</p>}
      <div className="wt-perm-foot">
        {state !== "done" && state !== "missing" && <button type="button" className="wt-btn go sm" onClick={act}>{f(p.button)}</button>}
        {stateText && <span className={`wt-perm-st ${state}`} role="status" aria-live="polite">
          {state === "done" && <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          {f(stateText)}
        </span>}
      </div>
    </div>
  );
}

/** "Delete all example tasks" (with Undo) and "Keep them for now": the summary page and Settings, General. */
function ExamplesBox({ gone, onGone, keep }: { gone: boolean; onGone: (v: boolean) => void; keep?: () => void }) {
  return (
    <div className={`wt-ex${gone ? " gone" : ""}`} role="group" aria-label={EXAMPLE_WORDS.settingsTitle}>
      <span><b>{EXAMPLE_WORDS.settingsTitle}</b><em>{gone ? EXAMPLE_WORDS.deleted : EXAMPLE_WORDS.settingsNote}</em></span>
      {gone
        ? <button type="button" className="wt-btn ghost sm" onClick={() => { sfx.click(); psPost({ type: "looks", patch: { examplesOp: "undo" } }); onGone(false); }}>{EXAMPLE_WORDS.undo}</button>
        : <>
          {keep && <button type="button" className="wt-btn ghost sm" onClick={() => { sfx.click(); keep(); }}>{EXAMPLE_WORDS.keep}</button>}
          <button type="button" className="wt-btn ghost sm danger" onClick={() => { sfx.drop(); psPost({ type: "looks", patch: { examplesOp: "delete" } }); onGone(true); }}>{EXAMPLE_WORDS.deleteAll}</button>
        </>}
    </div>
  );
}

/** Settings, General: the example tasks (while any are left, or right after deleting them, for Undo). */
export function ExamplesEntry() {
  const s = useVault();
  const [gone, setGone] = useState(false);
  if (!PS || s.status !== "unlocked") return null;
  const set = settingsData(s);
  if (!gone && !hasExamples(set.examples, s.docs.values(), set.aware, set.timelines)) return null;
  return <ExamplesBox gone={gone} onGone={setGone} />;
}

/** The entry in Settings, General (PS on the Mac): open the setup menu again. */
export function WelcomeEntry({ onOpen }: { onOpen?: () => void }) {
  if (!PS) return null;
  return (
    <button type="button" className="wn-entry wt-entry" onClick={() => { sfx.click(); onOpen?.(); openWelcome(); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h10M4 12h7M4 18h10" /><circle cx="18" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
      </svg>
      <span><b>{TOUR_WORDS.entryTitle}</b><em>{TOUR_WORDS.entrySub}</em></span>
    </button>
  );
}
