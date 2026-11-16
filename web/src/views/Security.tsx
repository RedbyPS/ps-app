// Security (the developer, 1 Nov 2026): "a security icon just to the left of the second computer button, with like
// a padlock, where I can click onto that and I can restart my other computer and the auto rebooting timer
// and stuff like that. Just to have all the security settings all in one place."
// The padlock sits in the Tab list's top right row, directly left of the Second Computer button
// (views/Second.tsx). A click grows this window out of it, the way Mac settings grows out of the gear
// (the cstats.css .cs-* shell with Mac settings' dark look, macsettings.css .mac-win). Inside: both Macs at
// a glance, this Mac's auto reboot and restart helper (RebootCard), the other Mac's Lock, Restart, Shut
// down and Postpone (signed by this Mac, exactly as the Second Computer Machine pane does; that pane keeps
// its own copy), the phone that may restart and lock your Macs, Are you sure, and signing out of this Mac.
// Mac settings points here for all of these. Nothing here changes a macOS setting: it says where to.
// Its own classes all start with sec (tests/security.test.ts): a short class owned by another page once
// pinned the reboot card over Mac settings (V1.24, rulebook.css .rb).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "../core/vault";
import { secondOnSnap } from "../core/secondsnap";
import { isOnline, machineMs, seenText, timerOn, type LockPeriod, type Machine, type RebootSetMode, type StatBody } from "../core/second";
import { secondStore } from "../second/store";
import { parseEnv, secondView, type SecondView } from "../second/view";
import { psPost, psSignOut, usePsSettings, type RebootSettings } from "../ps";
import { sfx } from "../ui/sfx";
import { morph } from "./DimensionX";
import { chipText, lengthText, REBOOT_CHOICES, RebootCard } from "./RebootCard";
import { AysSettings } from "./AysSettings";
import { secondActions } from "./Second";
import { helperWords } from "../core/helperwords";
import { appName } from "../core/appname";
import "./macsettings.css";
import "./security.css";

let open = false;
const listeners = new Set<() => void>();
export function openSecurity(v = true) { if (v !== open) { open = v; listeners.forEach((l) => l()); } }
function useOpen() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open);
}

function useSecondView(s: Snapshot): SecondView {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return useMemo(() => secondView([...s.docs.values()], local, now), [s.docs, local, now]);
}

/** The other Mac's own newest status. On the main Mac that is v.stat; on the second Mac v.stat is its OWN
 *  status (Second Computer shows the working Mac there), so the main Mac's is looked up by its device. */
function peerStat(s: Snapshot, v: SecondView): StatBody | null {
  if (!v.peer) return null;
  if (v.role === "primary") return v.stat;
  let best: StatBody | null = null;
  for (const d of s.docs.values()) {
    if (d.kind !== "sstat") continue;
    const b = parseEnv<StatBody>((d.data as { env?: unknown }).env);
    if (b?.t === "stat" && b.from === v.peer.device && (!best || b.at > best.at)) best = b;
  }
  return best;
}

const HOUR = 3_600_000;
/** The other Mac's auto reboot restarts it within the hour (it is counting toward a real restart). */
function restartsSoon(m: Machine | null | undefined, now = Date.now()) {
  const dl = machineMs(m?.timer?.deadline);
  return timerOn(m) && !!dl && dl - now < HOUR && dl - now > -2 * HOUR;
}
/** Something here wants the developer: shown as a small amber dot on the padlock (the other Mac's restart only on the
 *  main Mac, which is the one that can postpone it). */
function needsLook(r: RebootSettings | undefined, v: SecondView) {
  return r?.fileVault === "off" || r?.passwordImmediately === false || r?.helper === "approve" || (v.role === "primary" && restartsSoon(v.machine));
}

function Padlock({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9" />
      <path d="M12 14.4v2.4" />
    </svg>
  );
}

/** The padlock, top right of the Tab list, just left of the Second Computer button. PS on a Mac only. */
export function SecurityButton({ s }: { s: Snapshot }) {
  const want = useOpen();
  const st = usePsSettings();
  const v = useSecondView(s);
  useEffect(() => { psPost({ type: "psSettings:get" }); }, []);
  const warn = needsLook(st?.reboot, v);
  const label = warn ? "Security: something needs a look" : "Security";
  return (
    <button type="button" className={`sec-btn${want ? " sec-open" : ""}${warn ? " sec-warn" : ""}`} onClick={() => { sfx.click(); openSecurity(!want); }}
      aria-haspopup="dialog" aria-expanded={want} aria-label={label}
      data-tip={warn ? "Security needs a look" : "Security"} data-tip-line={warn ? "Click to see what needs you" : "Auto reboot, Are you sure and signing in"}>
      <Padlock />
      {warn && <i className="sec-dot" aria-hidden="true" />}
    </button>
  );
}

export function SecurityWindow({ s }: { s: Snapshot }) {
  const want = useOpen();
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const win = useRef<HTMLElement>(null), dim = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const padlock = () => document.querySelector<HTMLElement>(".tm-tr .sec-btn");
  // PS can ask for it too (the same way the pop-up's Settings button opens Mac settings).
  useEffect(() => {
    const w = window as Window & { __psOpenSecurity?: () => boolean };
    w.__psOpenSecurity = () => { openSecurity(true); return true; };
    return () => { if (w.__psOpenSecurity) delete w.__psOpenSecurity; };
  }, []);
  useEffect(() => {
    if (want && phaseRef.current === "closed") { setHost(document.querySelector<HTMLElement>(".tm-overlay")); setPhase("open"); }
    else if (!want && phaseRef.current === "open") setPhase("closing");
  }, [want]);
  useLayoutEffect(() => {
    if (phase === "open") {
      psPost({ type: "dimx", open: true });          // PS pins the list and gives it the keyboard (Esc comes back here)
      psPost({ type: "psSettings:get" });
      void morph(win.current, padlock(), dim.current, "in", { body: ".cs-content", tint: ".cs-morph" });
    } else if (phase === "closing") {
      psPost({ type: "dimx", open: false });
      void morph(win.current, padlock(), dim.current, "out", { body: ".cs-content", tint: ".cs-morph" }).then(() => setPhase((p) => (p === "closing" ? "closed" : p)));
    }
  }, [phase, host]);
  const close = () => { if (phaseRef.current === "open") { sfx.drop(); openSecurity(false); } };
  useEffect(() => {
    if (phase !== "open") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    const w = window as Window & { __psDimxClose?: () => boolean };
    const esc = () => { close(); return true; };
    window.addEventListener("keydown", key, true);
    w.__psDimxClose = esc;
    return () => { window.removeEventListener("keydown", key, true); if (w.__psDimxClose === esc) delete w.__psDimxClose; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (open) openSecurity(false); }, []);

  if (phase === "closed" || !host) return null;
  return createPortal(
    <div className="dx-layer cs-layer sec-layer" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={dim} className="cs-dim" onMouseDown={close} aria-hidden="true" />
      <section ref={win} className="cs-win mac-win sec-win" role="dialog" aria-modal="true" aria-label="Security">
        <div className="cs-morph" aria-hidden="true" />
        <div className="cs-glow" aria-hidden="true" />
        <div className="cs-content">
          <header className="cs-head sec-head">
            <button type="button" className="cs-min" onClick={close} aria-label="Close Security" title="Back to the Tab list (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
            </button>
            <div className="cs-title"><span className="cs-eyebrow">Restarts, locks and who may ask, on both Macs</span><h2>Security</h2></div>
          </header>
          <div className="cs-scroll mac-scroll sec-scroll">
            <SecurityBody s={s} />
          </div>
        </div>
      </section>
    </div>, host);
}

function SecurityBody({ s }: { s: Snapshot }) {
  const v = useSecondView(s);
  const second = secondOnSnap(s);   // PS 1.65: the other Mac and the phones need Second Computer, now everyone's behind its switch
  return (
    <>
      <Glance s={s} v={v} second={second} />
      <RebootCard title="Auto reboot on this Mac" />
      <HelperRemindRow />
      {second && <OtherMac s={s} v={v} />}
      {second && <Phones v={v} />}
      <AysSettings />
      <SignOut />
    </>
  );
}

// ---------- the restart helper pop up (open source build): it can be switched off, next to Auto reboot ----------
/** "Remind me to set up the restart helper": On (default) or Off, this Mac only (ps-mac HelperAlert.swift). */
function HelperRemindRow() {
  const st = usePsSettings();
  if (!st) return null;
  const on = st.helperRemind !== false;
  const set = (v: boolean) => { if (v !== on) { sfx.click(); psPost({ type: "psSettings:helperRemind", on: v }); } };
  return (
    <section className="panel stack sec-remind" aria-labelledby="sec-remind-h">
      <h2 className="h2" id="sec-remind-h">Remind me to set up the restart helper</h2>
      <div className="tabs" role="radiogroup" aria-labelledby="sec-remind-h" style={{ justifySelf: "start" }}>
        <button className="tab" role="radio" aria-checked={on} aria-selected={on} onClick={() => set(true)}>On</button>
        <button className="tab" role="radio" aria-checked={!on} aria-selected={!on} onClick={() => set(false)}>Off</button>
      </div>
      <small className="hint">On: a pop up asks you to switch the restart helper on when auto reboot or Sentry mode needs it and it is off. Off: no pop up; the helper's state still shows above.</small>
    </section>
  );
}

// ---------- both Macs at a glance: the live timer, the protections, the last three locks ----------

type Row = { k: string; val: string; good?: boolean | null; fix?: string };
const fileVaultRow = (fv: string | undefined): Row => ({ k: "Disk lock (FileVault)", val: fv === "on" ? "On" : fv === "off" ? "Off" : "Unknown",
  good: fv === "on" ? true : fv === "off" ? false : null, fix: "System Settings, Privacy & Security, FileVault: turn it on" });
const passwordRow = (p: boolean | null | undefined): Row => ({ k: "Password after sleep", val: p ? "Asked at once" : p === false ? "Delayed" : "Unknown",
  good: p ?? null, fix: "System Settings, Lock Screen: require the password immediately" });

/** What a Mac's timer shows: the digits, one plain line, and whether it ticks. */
type ClockView = { digits: string; line: string; live: boolean };
const pad2 = (n: number) => String(n).padStart(2, "0");
/** 18:00:00, hours not folded at 24 (72:00:00 is three days). */
const hms = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}`; };
const at = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** This Mac: read while the developer is at it, so it is unlocked and the timer is not running; it says what it counts from. */
function myClock(r: RebootSettings | undefined): ClockView {
  const idle = (line: string) => ({ digits: "00:00:00", line, live: false });
  if (!r) return { digits: "--:--:--", line: "Waiting for PS app", live: false };
  if (r.helper !== "on") return { digits: "--:--:--", line: helperWords(r.helper, r.offBy, appName())?.clock ?? "Not running: the restart helper is not set up", live: false };
  if (r.mode === "off") return { digits: "--:--:--", line: "Auto reboot is off", live: false };
  const s = r.status;
  if (s?.counting && s.deadline) return { digits: hms(s.deadline * 1000 - Date.now()), line: `Counting down since ${s.lockedAt ? at(s.lockedAt) : "the lock"}`, live: true };
  if (s && (!s.seenUnlock || s.signedIn === false)) return idle("Not running: waiting for your first sign in since this Mac started");
  return idle(`Not running: this Mac is unlocked. ${r.mode === "watch" ? "Watch only counts" : "Counts"} down from ${hms(r.minutes * 60_000)} when you lock it.`);
}

/** The other Mac, from its last status (sent when it changes): its countdown ticks here while it stays locked. */
function peerClock(name: string, st: StatBody | null, online: boolean): ClockView {
  const m = st?.machine, t = m?.timer;
  const idle = (line: string) => ({ digits: "00:00:00", line, live: false });
  if (!t) return { digits: "--:--:--", line: st ? `${name} sends no timer yet (an older PS app there)` : `Nothing heard from ${name} yet`, live: false };
  if (t.safeMode) return { digits: "--:--:--", line: "Paused: it started in Safe Mode", live: false };
  if (t.mode === "off" || t.asked === "off") return { digits: "--:--:--", line: "Auto reboot is off there", live: false };
  const dl = machineMs(t.deadline);
  const heard = online ? "" : ` Last heard ${seenText(st?.at)}; it keeps counting asleep.`;
  if (dl) {
    const verb = t.mode === "watch" ? "Would restart" : "Restarts";
    return { digits: hms(dl - Date.now()), line: `Locked since ${t.lockedAt ? at(t.lockedAt) : "a while"}. ${verb} at ${at(dl / 1000)} unless someone unlocks it.${heard}`, live: true };
  }
  if (t.signedIn === false) return idle(`Not running: waiting for a sign in at ${name} (Before First Unlock)`);
  if (m?.locked === false) return idle(`Not running: ${name} is unlocked`);
  return idle(`Not running${heard}`);
}

function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => { if (!on) return; const id = window.setInterval(() => setN((n) => n + 1), 1000); return () => clearInterval(id); }, [on]);
}
function Clock({ get }: { get: () => ClockView }) {
  const v = get();
  useTick(v.live);
  return (
    <div className={`sec-clock${v.live ? " sec-run" : ""}`} role="timer" aria-live="off">
      <b className="sec-digits">{v.digits}</b>
      <span>{v.line}</span>
    </div>
  );
}

const END: Record<string, string> = { unlock: "Unlocked", timer: "Restarted by the timer", restart: "Restarted by you", shutdown: "Shut down by you",
  boot: "The Mac started again", changed: "Settings changed: counted again", off: "Auto reboot switched off" };
const ranText = (sec: number) => { const m = Math.round(sec / 60), h = Math.floor(m / 60); return h ? (m % 60 ? `${h} h ${m % 60} min` : `${h} h`) : `${m} min`; };
/** The last three lock periods, newest first: when it locked, when and how it ended, how long the timer ran. */
function Periods({ list, missing }: { list?: LockPeriod[]; missing: string }) {
  return (
    <div className="sec-hist">
      <span className="sec-hist-h">Last locks</span>
      {!list ? <small className="sec-sub">{missing}</small> : !list.length ? <small className="sec-sub">None written down yet.</small> : (
        <ol className="sec-periods">
          {list.slice(0, 3).map((p) => (
            <li key={`${p.lockedAt}-${p.end}`}>
              <b>{at(p.lockedAt)} to {at(p.endedAt)}</b>
              <span>Ran {ranText(p.ran)}: {END[p.end] ?? p.end}{p.postponed ? `, postponed ${ranText(p.postponed)}` : ""}{p.would ? `, would have restarted ${at(p.would)} (Watch only)` : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GlanceCard({ title, sub, rows, online, clock, periods }: { title: string; sub: string; rows: Row[]; online?: boolean; clock: () => ClockView; periods: React.ReactNode }) {
  return (
    <article className="sec-card">
      <h3><span className={`sec-live${online ? " sec-on" : ""}`} aria-hidden="true" />{title}</h3>
      <span className="sec-sub">{sub}</span>
      <Clock get={clock} />
      {rows.map((r) => (
        <div key={r.k} className="sec-row">
          <span>{r.k}</span>
          <b className={r.good === true ? "sec-good" : r.good === false ? "sec-bad" : ""}>{r.val}</b>
          {r.fix && r.good === false && <em>{r.fix}</em>}
        </div>
      ))}
      {periods}
    </article>
  );
}

function timerText(m: Machine | null | undefined): string {
  const t = m?.timer;
  if (!t) return "Unknown";
  if (t.safeMode) return "Paused (Safe Mode)";
  const len = lengthText(t.minutes ?? t.hours * 60);
  if (t.mode === "watch") return `Watch only, ${len}`;
  if (!timerOn(m)) return "Off";
  return `Active, ${len}`;
}
const fmtLeft = (ms: number) => { const h = Math.floor(ms / HOUR), mm = Math.round((ms % HOUR) / 60_000); return h ? (mm ? `${h} h ${mm} min` : `${h} h`) : `${Math.max(1, mm)} min`; };
const HELPER: Record<string, string> = { approved: "Switched on", "needs approval": "Needs your OK on that Mac", "not set up": "Not set up", missing: "Not in that build" };

function Glance({ s, v, second }: { s: Snapshot; v: SecondView; second: boolean }) {
  const r = usePsSettings()?.reboot;
  const mode = r?.mode === "active" ? "Active" : r?.mode === "watch" ? "Watch only" : "Off";
  const mine: Row[] = [
    fileVaultRow(r?.fileVault), passwordRow(r?.passwordImmediately),
    { k: "Auto reboot", val: !r ? "Unknown" : r.helper === "on" ? `${mode}${r.mode === "off" ? "" : `, ${lengthText(r.minutes)}`}` : helperWords(r.helper, r.offBy, appName())?.autoRow ?? "Not set up",
      good: r?.helper === "on" && r.mode === "active" ? true : null },
    { k: "Restart helper", val: !r ? "Unknown" : r.helperOld ? "Older version (updates at the next restart)" : r.helper === "on" ? "Switched on"
      : r.helper === "approve" ? helperWords(r.helper, r.offBy, appName())!.row : r.helper === "missing" ? "Not in this build" : "Not set up",
      good: r?.helper === "approve" || r?.helperOld ? false : r?.helper === "on" ? true : null, fix: `System Settings, General, Login Items & Extensions: switch on ${appName()}. If it already looks on, switch it off and then on again.` },
  ];
  const st = peerStat(s, v), m = st?.machine, online = isOnline(st);
  const theirs: Row[] = [
    { k: "Status", val: online ? "Online" : st ? `Offline since ${seenText(st.at)}` : "Not heard from yet", good: online ? true : null },
    { k: "Screen", val: m?.locked ? "Locked" : m?.locked === false ? "Unlocked" : "Unknown" },
    fileVaultRow(m?.fileVault), passwordRow(m?.passwordImmediately),
    { k: "Auto reboot", val: timerText(m), good: timerOn(m) ? true : null },
    { k: "Restart helper", val: m?.helper ? HELPER[m.helper] ?? m.helper : "Unknown", good: m?.helper === "approved" ? true : m?.helper === "needs approval" ? false : null,
      fix: "On that Mac: System Settings, General, Login Items & Extensions: switch on PS app. If it already looks on, switch it off and then on again." },
  ];
  const myPeriods = r?.helper === "on" ? r.status?.periods : undefined;
  return (
    <div className="sec-glance">
      <GlanceCard title={v.me?.name ?? "This Mac"} sub="This Mac" rows={mine} online clock={() => myClock(r)}
        periods={<Periods list={myPeriods} missing={r?.helper === "on" ? "The restart helper on this Mac writes these from this version on." : "Set up the restart helper to keep these."} />} />
      {second && v.peer && (
        <GlanceCard title={v.peer.name} sub={v.role === "primary" ? "Your second Mac" : "Your main Mac"} rows={theirs} online={online} clock={() => peerClock(v.peer!.name, st, online)}
          periods={<Periods list={m?.timer?.periods} missing={`${v.peer.name} sends these once it has this version of PS app.`} />} />
      )}
    </div>
  );
}

// ---------- the other Mac: lock, restart, shut down, postpone ----------

function OtherMac({ s, v }: { s: Snapshot; v: SecondView }) {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [confirm, setConfirm] = useState<"restart" | "shutdown" | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { if (!sent) return; const t = window.setTimeout(() => setSent(null), 6000); return () => clearTimeout(t); }, [sent]);
  if (!v.peer) {
    return (
      <section className="panel stack" aria-labelledby="sec-other-h">
        <h2 className="h2" id="sec-other-h">Your other Mac</h2>
        <p className="muted" style={{ margin: 0 }}>
          {v.role === "none" ? "Second Computer is not set up on this Mac yet." : "No other Mac is paired yet."} Once your other Mac is
          paired, you lock it, restart it, shut it down and postpone its auto reboot from here.
        </p>
        <button type="button" className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => { sfx.click(); secondActions.run({ op: "window", tab: "setup" }); }}>Open Second Computer</button>
      </section>
    );
  }
  const name = v.peer.name;
  const primary = v.role === "primary";
  const st = peerStat(s, v), m = st?.machine, t = m?.timer, online = isOnline(st);
  const dl = machineMs(t?.deadline);
  const left = dl ? dl - Date.now() : null;
  const counting = !!t && !t.safeMode && t.mode !== "off" && left !== null;
  const run = (action: "lock" | "restart" | "shutdown" | "postpone") => {
    sfx.click();
    secondActions.run({ op: "cmd", action });
    setConfirm(null);
    setSent(action === "lock" ? `Asked ${name} to lock.` : action === "postpone" ? `Asked ${name} to wait an hour longer.` : `Asked ${name} to ${action === "restart" ? "restart" : "shut down"}.`);
  };
  return (
    <section className="panel stack" aria-labelledby="sec-other-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="sec-other-h">{name}</h2>
        <span className={`pill ${online ? "good" : "ink"}`}>{online ? "Online" : "Offline"}</span>
      </div>
      {counting && (
        <div className="sec-next">
          <span className="small muted">Its auto reboot</span>
          <b>{`${t!.mode === "watch" ? "Would restart" : "Restarts"} ${clock(dl!)}${left! > 0 ? `, in ${fmtLeft(left!)}` : ""}`}</b>
          {!!t!.postponed && <span className="small muted">Postponed {fmtLeft(t!.postponed * 1000)} so far (12 hours at most)</span>}
        </div>
      )}
      {primary ? (
        <>
          {m?.helper && m.helper !== "approved" && (
            <div className="banner">Restart, Shut down and Postpone need PS's restart helper switched on once on {name}: System Settings, General, Login Items & Extensions. If it already looks on, switch it off and then on again.</div>
          )}
          {confirm ? (
            <div className="banner sec-confirm" role="alertdialog" aria-label={confirm === "restart" ? `Restart ${name}?` : `Shut down ${name}?`}>
              <b>{confirm === "restart" ? `Restart ${name}?` : `Shut down ${name}?`}</b>
              <span>{confirm === "restart" ? "Running jobs stop. It comes back only after you log in at it." : "Running jobs stop. It stays off until someone turns it on and logs in."} If someone is using it, it shows a 10 second Cancel first.</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn primary sm" onClick={() => run(confirm)}>{confirm === "restart" ? "Restart now" : "Shut down now"}</button>
                <button type="button" className="btn ghost sm" onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row sec-acts" role="group" aria-label={`Control ${name}`}>
              <button type="button" className="btn ghost sm" onClick={() => run("lock")}>Lock now</button>
              <button type="button" className="btn ghost sm" onClick={() => { sfx.click(); setConfirm("restart"); }}>Restart</button>
              <button type="button" className="btn ghost sm" onClick={() => { sfx.click(); setConfirm("shutdown"); }}>Shut down</button>
              {/* Postpone only for a countdown that ends in a real restart (Watch only never restarts). */}
              {counting && timerOn(m) && t!.postpone && <button type="button" className="btn ghost sm" onClick={() => run("postpone")}>Postpone 1 hour</button>}
            </div>
          )}
          {(sent || local.note) && <small className="hint" role="status">{sent ?? local.note}</small>}
          {t?.set ? <RemoteReboot key={v.peer.device} name={name} t={t} helperOn={m?.helper === "approved"} />
            : <small className="hint">Update PS on {name} to choose its auto reboot from here.</small>}
          <small className="hint">
            Signed by this Mac, good for 2 minutes and refused if replayed. After a restart or shut down, {name} is offline for Second
            Computer until someone logs in at it: FileVault locks the disk, which is the point.
          </small>
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Lock, Restart, Shut down and Postpone go from your main Mac to this one, never back. Your phone can lock, restart and shut down both Macs.
        </p>
      )}
    </section>
  );
}
const clock = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

const MODES: [RebootSetMode, string][] = [["off", "Off"], ["watch", "Watch only"], ["active", "Active"]];
/** The other Mac's auto reboot, chosen here (the developer, 2 Nov 2026). Each choice is a signed command its PS carries out as if
 *  the developer had chosen it there; the tabs show what it last reported, or what was just sent until it reports back. */
function RemoteReboot({ name, t, helperOn }: { name: string; t: NonNullable<Machine["timer"]>; helperOn: boolean }) {
  const reported: RebootSetMode = t.asked === "off" || t.asked === "watch" || t.asked === "active" ? t.asked : t.mode ?? "watch";
  const reportedMinutes = t.minutes ?? t.hours * 60;
  const [pending, setPending] = useState<{ mode: RebootSetMode; minutes: number; at: number } | null>(null);
  const [sure, setSure] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => { if (pending && pending.mode === reported && pending.minutes === reportedMinutes) setPending(null); }, [pending, reported, reportedMinutes]);
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(() => { setPending(null); setLate(true); }, 150_000);   // commands are good for 2 minutes
    return () => clearTimeout(id);
  }, [pending]);
  const mode = pending?.mode ?? reported, minutes = pending?.minutes ?? reportedMinutes;
  const send = (m: RebootSetMode, n: number) => {
    sfx.click(); setSure(false); setLate(false);
    secondActions.run({ op: "cmd", action: `set:${m}:${n}` });
    setPending({ mode: m, minutes: n, at: Date.now() });
  };
  return (
    <div className="stack tight sec-rset" role="group" aria-label={`Auto reboot on ${name}`}>
      <span className="small sec-l">Auto reboot on {name}</span>
      <div className="tabs" role="radiogroup" aria-label={`${name} mode`} style={{ justifySelf: "start" }}>
        {MODES.map(([m, label]) => (
          <button key={m} type="button" className="tab" role="radio" aria-checked={mode === m} aria-selected={mode === m}
            onClick={() => { if (m === "active" && mode !== "active") { sfx.click(); setSure(true); return; } send(m, minutes); }}>{label}</button>
        ))}
      </div>
      {sure && (
        <div className="banner sec-confirm">
          <span>Active really restarts {name} once it has stayed locked for {lengthText(minutes)}, even with a job running there.
            After the restart it waits for a sign in there before the timer can run again, and Second Computer cannot reach it until then.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn primary sm" onClick={() => send("active", minutes)}>Yes, make {name} Active</button>
            <button type="button" className="btn ghost sm" onClick={() => setSure(false)}>Not yet</button>
          </div>
        </div>
      )}
      <div className="row sec-acts" role="group" aria-label={`${name} restarts after`}>
        {REBOOT_CHOICES.map((n) => (
          <button key={n} type="button" className={`btn sm ${minutes === n ? "primary" : "ghost"}`} aria-label={`${name}: ${lengthText(n)}`} onClick={() => send(mode, n)}>{chipText(n)}</button>
        ))}
      </div>
      {pending ? <small className="hint" role="status">Sent: {MODES.find(([m]) => m === pending.mode)?.[1]}, {lengthText(pending.minutes)}. Waiting for {name} to take it.</small>
        : late ? <small className="hint" role="status">{name} did not take it within 2 minutes (asleep or offline?). Choose again when it is online.</small>
        : !helperOn && mode !== "off" ? <small className="hint">Saved on {name}, but nothing restarts there until its restart helper is switched on (at {name}: System Settings, General, Login Items & Extensions. If it already looks on, switch it off and then on again.).</small>
        : null}
    </div>
  );
}

// ---------- the phone ----------

function Phones({ v }: { v: SecondView }) {
  return (
    <section className="panel stack" aria-labelledby="sec-phone-h">
      <h2 className="h2" id="sec-phone-h">Your phone</h2>
      <p className="muted" style={{ margin: 0 }}>
        A phone you trust can restart, shut down and lock this Mac, after your fingerprint on the phone. It can never run jobs or see
        files. Trust shows a six digit code here and on the phone: trust it only if they match.
      </p>
      {v.phones.length === 0 ? <small className="hint">No phone has asked yet. On the phone: PS app, Settings, Your Macs.</small>
        : v.phones.map((p) => (
          <div key={p.device} className="row sec-phone">
            <span className="stack tight"><b>{p.name}</b><small className="hint">{p.trusted ? "Trusted for restart, shut down and lock" : `Asked ${seenText(p.at)}`}</small></span>
            {p.trusted
              ? <button type="button" className="btn ghost sm" onClick={() => { sfx.click(); secondActions.run({ op: "unpair", device: p.device }); }}>Remove</button>
              : <button type="button" className="btn primary sm" onClick={() => { sfx.click(); secondActions.run({ op: "trustPhone", device: p.device }); }}>Trust phone</button>}
          </div>
        ))}
    </section>
  );
}

// ---------- signing in on this Mac (was Mac settings, This Mac) ----------

function SignOut() {
  return (
    <section className="panel stack" aria-labelledby="sec-out-h">
      <h2 className="h2" id="sec-out-h">Signing in on this Mac</h2>
      <p className="muted" style={{ margin: 0 }}>
        With Remember me, PS stays signed in on this Mac (through quits, restarts, sleep and Mac lock). Lock closes it until Touch ID or
        your Mac password opens it again. Your keys stay in this Mac's Keychain only (not iCloud) and never leave it. Sign out forgets
        this Mac: next time it is your passphrase.
      </p>
      <button type="button" className="btn ghost" style={{ justifySelf: "start" }} onClick={psSignOut}>Sign out of this Mac</button>
    </section>
  );
}
