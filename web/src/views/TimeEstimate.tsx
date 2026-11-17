// Time estimates on screen (PS 1.65; the rules are core/timeest.ts, the saving core/timesave.ts):
//  - EstPicker: the calm picker (15 min, 30 min, 1 h, 2 h, or typed), in a task's right click menu and in its Edit,
//  - EstBadge and EstHint: the small estimate on a task ("30m", a soft dot while its clock runs) and, for a minute and a half after a
//    task was added with a name used before, "Usually takes about 40 min" under its name,
//  - EditTime: in a task's Edit, the picker, the usual time and the past times ("35, 50, 40 min"), and Start or Stop,
//  - OverloadLine: one quiet line at the top of the list, "You've planned 9 h with 5 h free", with Rethink (the Checklist reminder's
//    Rethink screen) and Not now. Never a pop-up, once a day at most.
// Esc closes the picker (and the menu around it); nothing here takes focus by itself except the typed box when it is opened.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Doc, Settings, Todo } from "../core/model";
import type { TabLists } from "../core/groups";
import { vaultStore, type Snapshot } from "../core/vault";
import { calendarDocs, settingsData } from "../core/select";
import { feature } from "../core/features";
import { overdueZone } from "../core/overdue";
import { meetingEvents } from "../core/calpick";
import { eventBlocks } from "../core/tzfree";
import { checklistTasks } from "../core/chkremind";
import * as T from "../core/timeest";
import { runTimeOp, type TimeOp } from "../core/timesave";
import { psInOverlay } from "../ps";
import { openChkScreen } from "../chkscreen";
import { sfx } from "../ui/sfx";
import { todayISO } from "../ui/kit";
import { taskMapActions } from "./TaskMap";
import "./timeest.css";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- what the vault holds, worked out once per snapshot ----------
type TimeView = { prefs: T.TePrefs; on: boolean; live: T.TLive; done: () => (T.TDone & { id: string })[]; away: T.Span[] };
const cache = new WeakMap<Snapshot, TimeView>();
export function timeView(s: Snapshot): TimeView {
  let v = cache.get(s);
  if (v) return v;
  const st = s.status === "unlocked" ? settingsData(s) : ({} as Settings);
  const recs = s.status === "unlocked" ? [...s.docs.values()].filter((d) => d.kind === T.TE_KIND) : [];
  const isLive = (d: { data: unknown }) => (d.data as { t?: unknown } | null)?.t === "live";
  const live = T.foldTime(recs.filter(isLive)).live;
  let done: (T.TDone & { id: string })[] | null = null;   // the month records only when a screen asks (Edit's past times), once per snapshot
  v = { prefs: T.cleanTe(st.timeEst), on: s.status === "unlocked" && feature(T.TE_FEATURE), live, away: T.awaySpans(st.awayLog),
    done: () => (done ??= T.allDone([...T.foldTime(recs.filter((d) => !isLive(d))).months.values()].map((m) => m.rec))) };
  cache.set(s, v);
  return v;
}
/** One value from the time view, re-rendering only when it changes. */
function useTimeSel<R>(pick: (v: TimeView) => R): R {
  const last = useRef<{ s: Snapshot; r: R } | null>(null);
  const get = () => {
    const s = vaultStore.get();
    if (last.current?.s === s) return last.current.r;
    const r = pick(timeView(s));
    if (last.current && JSON.stringify(last.current.r) === JSON.stringify(r)) { last.current = { s, r: last.current.r }; return last.current.r; }
    last.current = { s, r };
    return r;
  };
  return useSyncExternalStore(vaultStore.subscribe, get, get);
}
export const useEstOn = () => useTimeSel((v) => v.on && v.prefs.est);

/** Start or Stop, here or from the Tab list (the main window holds the vault). */
export function timeAct(o: TimeOp) {
  if (psInOverlay()) void taskMapActions.looks({ timeOp: o } as Partial<Settings>);
  else void runTimeOp(o);
}

// ---------- the picker ----------
export function EstPicker({ value, onPick, compact }: { value: number | null; onPick: (m: number | null) => void; compact?: boolean }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(value && !(T.EST_CHOICES as readonly number[]).includes(value) ? T.estLabel(value) : "");
  const read = T.parseEst(text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (typing) input.current?.focus({ preventScroll: true }); }, [typing]);
  const pick = (m: number | null) => { sfx.click(); onPick(m); };
  return (
    <div className={`te-pick${compact ? " compact" : ""}${reduced() ? " still" : ""}`} role="group" aria-label={T.TE_WORDS.estimate}>
      {T.EST_CHOICES.map((m) => (
        <button key={m} type="button" className={`te-chip${value === m ? " on" : ""}`} aria-pressed={value === m} onClick={() => pick(value === m ? null : m)}>{T.estLabel(m)}</button>
      ))}
      {typing ? (
        <span className="te-type">
          <input ref={input} className={`te-in${text && read === null ? " bad" : ""}`} value={text} placeholder={T.TE_WORDS.typeHint} aria-label={T.TE_WORDS.typeHint} inputMode="text"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (read !== null) pick(read); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTyping(false); }
            }} />
          <button type="button" className="te-chip te-set" disabled={read === null} onClick={() => read !== null && pick(read)}>{T.TE_WORDS.set}</button>
        </span>
      ) : (
        <button type="button" className={`te-chip te-other${value && !(T.EST_CHOICES as readonly number[]).includes(value) ? " on" : ""}`} onClick={() => { sfx.hover(); setTyping(true); }}>
          {value && !(T.EST_CHOICES as readonly number[]).includes(value) ? T.estLabel(value) : T.TE_WORDS.other}
        </button>
      )}
      {value !== null && <button type="button" className="te-chip te-none" onClick={() => pick(null)}>{T.TE_WORDS.noEstimate}</button>}
    </div>
  );
}

/** The estimate from a task's right click menu: saved at once, with the same Undo as a new date. */
export function setTaskEst(d: Doc<Todo>, m: number | null) {
  void taskMapActions.update(d.id, { est: m, estBy: null } as Partial<Todo>);
}

// ---------- on the task ----------
/** The small estimate beside a task's name, and a soft dot while its clock runs. */
export function EstBadge({ d }: { d: Doc<Todo> }) {
  const on = useEstOn();
  const running = useTimeSel((v) => v.on && v.prefs.track && T.isRunning(v.live, d.id));
  const est = T.cleanEst(d.data.est);
  if (d.data.done || (!running && !(on && est))) return null;
  const tip = [on && est ? `${T.TE_WORDS.estimate}: ${T.estLabel(est)}` : "", running ? T.TE_WORDS.running : ""].filter(Boolean).join(". ");
  return (
    <span className={`tm-due te-badge num${running ? " run" : ""}`} title={tip} aria-label={tip}>
      {running && <i className="te-dot" aria-hidden="true" />}
      {on && est ? T.estShort(est) : null}
    </span>
  );
}
const HINT_MS = 90_000;
/** "Usually takes about 40 min" under a task that was just added with a name used before. */
export function EstHint({ d }: { d: Doc<Todo> }) {
  const on = useEstOn();
  const made = Date.parse(d.data.createdAt || "");
  const left = Number.isFinite(made) ? made + HINT_MS - Date.now() : -1;
  const [, wake] = useState(0);
  useEffect(() => { if (left > 0) { const t = window.setTimeout(() => wake((n) => n + 1), left + 50); return () => window.clearTimeout(t); } }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = T.cleanEst(d.data.est);
  if (!on || d.data.estBy !== "past" || !est || left <= 0 || d.data.done) return null;
  return <span className="te-hint">{T.TE_WORDS.usually(est)}</span>;
}

/** The time now, every `ms` while `on`. */
function useNow(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!on) return; setNow(Date.now()); const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [on, ms]);
  return now;
}

/** Inside a task's Edit: the estimate (saved with Save), the usual time and the past times, and Start or Stop (at once). */
export function EditTime({ d, title, est, setEst }: { d: Doc<Todo>; title: string; est: number | null; setEst: (m: number | null) => void }) {
  const v = timeView(useVaultSnap());
  const estOn = v.on && v.prefs.est, track = v.on && v.prefs.track;
  const running = track && T.isRunning(v.live, d.id);
  const now = useNow(running, 15_000);
  const past = useMemo(() => (v.on ? T.pastTimes(v.done(), title || d.data.title, { id: d.id }) : []), [v, title, d.id, d.data.title]);
  const usual = T.usualMin(past);
  const sofar = running ? T.spentMin(v.live, d.id, now, v.away) : 0;
  if (!estOn && !track) return null;
  return (
    <div className="te-edit">
      {estOn && (
        <div className="te-edit-row">
          <span className="te-label">{T.TE_WORDS.estimate}</span>
          <EstPicker value={est} onPick={setEst} />
        </div>
      )}
      {(past.length > 0 || track) && (
        <div className="te-edit-row te-facts">
          {estOn && usual !== null && (
            <span className="te-usual">
              {T.TE_WORDS.usually(usual)}
              {est !== usual && <button type="button" className="te-link" onClick={() => { sfx.click(); setEst(usual); }}>{T.TE_WORDS.set}</button>}
            </span>
          )}
          {past.length > 0 && <span className="te-past"><span className="te-label">{T.TE_WORDS.past}</span> <span className="num">{T.pastWords(past)}</span></span>}
          {track && !d.data.done && (
            <span className="te-clock">
              {running && <span className="te-sofar num" aria-live="polite"><i className="te-dot" aria-hidden="true" />{T.TE_WORDS.spentSoFar(sofar)}</span>}
              <button type="button" className={`te-chip te-go${running ? " on" : ""}`} onClick={() => { sfx.click(); timeAct({ op: running ? "stop" : "start", id: d.id }); }}>
                {running ? T.TE_WORDS.stop : T.TE_WORDS.start}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
const useVaultSnap = () => useSyncExternalStore(vaultStore.subscribe, vaultStore.get, vaultStore.get);

// ---------- the overload line ----------
let shownDay: string | null = null;   // the day this page showed the line (so it is marked when it goes by itself)
export function OverloadLine({ lists }: { lists: TabLists }) {
  const s = useVaultSnap();
  const v = timeView(s);
  const st = s.status === "unlocked" ? settingsData(s) : null;
  const on = !!st && v.on && v.prefs.est && v.prefs.warn;
  const now = useNow(on, 60_000);
  const tz = overdueZone(st?.tmHomeTz);
  const facts = useMemo(() => {
    if (!on || !st) return null;
    const win = T.workWindow(now, v.prefs, tz);
    const cals = calendarDocs(s);
    const busy = eventBlocks(meetingEvents(cals.flatMap((d) => d.data.events || []), st.calChoices), tz, st.meetHidden);
    const tasks = T.todayTasks(checklistTasks(lists), todayISO());
    const planned = T.plannedMin(tasks.map((d) => ({ id: d.id, est: d.data.est, done: d.data.done })), (id) => (v.prefs.track && T.isRunning(v.live, id) ? T.spentMin(v.live, id, now, v.away) : 0));
    return { win, planned, free: T.freeMin(win, now, busy) };
  }, [on, st, s, v, lists, now, tz]);
  const line = facts ? T.overloadLine({ on, planned: facts.planned, free: facts.free, now, win: facts.win, seenDay: st?.estWarnDay }) : null;
  const [leaving, setLeaving] = useState<string | null>(null);
  const mark = (day: string) => void taskMapActions.looks({ estWarnDay: day } as Partial<Settings>);
  // Shown, then gone by itself (ticks, a meeting cancelled): marked for the day, so it never comes back today.
  useEffect(() => {
    if (line) { shownDay = line.day; return; }
    if (facts && shownDay === facts.win.day && st?.estWarnDay !== shownDay && on) { const d = shownDay; shownDay = null; mark(d); }
  }, [line?.text, facts?.win.day, on]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (rethink: boolean) => {
    if (!line) return;
    sfx.click();
    shownDay = null;
    setLeaving(line.text);
    window.setTimeout(() => { mark(line.day); setLeaving(null); }, reduced() ? 0 : 220);
    if (rethink) openChkScreen("rethink");
  };
  const text = line?.text ?? leaving;
  if (!text) return null;
  return (
    <p className={`te-over${leaving ? " out" : ""}${reduced() ? " still" : ""}`} role="status">
      <span className="te-over-t num">{text}</span>
      <button type="button" className="te-over-go" onClick={() => go(true)}>{T.TE_WORDS.rethink}</button>
      <button type="button" className="te-over-x" onClick={() => go(false)} aria-label={T.TE_WORDS.close} title={T.TE_WORDS.close}>&times;</button>
    </p>
  );
}

// ---------- Settings, Your list: the working hours (the three On and Off rows are in views/SettingsGroups.tsx) ----------
export function TimeHours() {
  const s = useVaultSnap();
  const ready = s.status === "unlocked";
  const p = T.cleanTe(ready ? settingsData(s).timeEst : null);
  const set = (patch: Partial<T.TePrefs>) => { if (ready) void taskMapActions.looks({ timeEst: { ...p, ...patch } } as Partial<Settings>); };
  return (
    <span className="te-hours">
      <input type="time" value={p.from} aria-label="From" disabled={!ready} onChange={(e) => { if (e.target.value) set({ from: e.target.value }); }} />
      <span>to</span>
      <input type="time" value={p.to} aria-label="To" disabled={!ready} onChange={(e) => { if (e.target.value) set({ to: e.target.value }); }} />
    </span>
  );
}
