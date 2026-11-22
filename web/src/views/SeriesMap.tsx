// To-do > map: a full-screen calendar of the developer's life as a series. Each month keeps its own name
// with an episode title beside it ("October · The Comeback"), and any day, week or month can
// hold a note on what happened. Year, Month and Week views. Everything is saved encrypted.
// The Tab list opens the same map in a window (SeriesPill.tsx): embedded, with its saves sent
// through PS to the main window, which holds the keys.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Doc, Goal, JournalEntry, ScreenTimeDay, Todo } from "../core/model";
import { calendarSnap, dayLogs, journal, screenTimeDays, settingsData } from "../core/select";
import { ScreenTimeBars, fmtDur, totalSecs } from "./ScreenTime";
import { DAY_ENDS_DEFAULT, itemKey, workDayOf } from "../core/daylog";
import { historyOn, readDay } from "../core/taskhist";
import { feature } from "../core/features";
import { saveSettings, setJournal } from "../core/actions";
import { GoalsTimeline, goalsEsc } from "./Goals";
import { Icon, useVault } from "../ui/kit";
import "./series.css";

type View = "year" | "month" | "week" | "timeline";
/** How the map saves: straight to the vault on the website, through PS in the Tab list. */
export interface MapSaves { journal: (key: string, patch: { title?: string | null; note?: string | null }) => Promise<unknown>; goals: (list: Goal[]) => Promise<unknown> }
const SAVES: MapSaves = { journal: setJournal, goals: (list) => saveSettings({ goals: list }) };
const Saves = createContext<MapSaves>(SAVES);
/** Fuller task history (PS 1.65, core/taskhist.ts): per work day, what was missed, added, deleted, moved to Dimension X, and the totals. */
type DayHist = ReturnType<typeof readDay>;
const Hist = createContext<Map<string, DayHist>>(new Map());
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mKey = (y: number, m: number) => `m:${y}-${pad(m + 1)}`;
const dKey = (d: Date) => `d:${iso(d)}`;
const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const wKey = (d: Date) => `w:${iso(monday(d))}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const weekNo = (d: Date) => { // ISO week number
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
};

export function SeriesMap({ onClose, embedded, saves = SAVES, escRef }: {
  onClose: () => void;
  /** In a window of its own (the Tab list): fills it, and its host owns the keyboard and Esc. */
  embedded?: boolean; saves?: MapSaves;
  /** Embedded: the host calls this on Esc. It clears the search, then closes a note, then the map. */
  escRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const s = useVault();
  const j = journal(s);
  const [view, setView] = useState<View>("month");
  const [cur, setCur] = useState(() => new Date());
  const [edit, setEdit] = useState<string | null>(null); // a "d:" or "w:" key open in the side panel
  const today = iso(new Date());

  // What happened on a day: calendar events and ticked off to-dos.
  const snap = calendarSnap(s);
  const events = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of snap?.data.events || []) {
      if (!e.start) continue;
      const k = e.allDay ? e.start.slice(0, 10) : iso(new Date(e.start));
      m.set(k, [...(m.get(k) || []), e.title]);
    }
    return m;
  }, [snap]);
  // What got done each work day: the logs Reset writes, plus what is ticked now (it counts for the
  // work day in progress), plus older finished tasks from before the logs existed (by tick date).
  const dayEnds = settingsData(s).dayEndsHour ?? DAY_ENDS_DEFAULT;
  const ticked = useMemo(() => {
    const m = new Map<string, string[]>();
    const seen = new Set<string>();
    const add = (k: string, title: string) => m.set(k, [...(m.get(k) || []), title]);
    for (const [date, log] of dayLogs(s)) for (const it of log.data.items) { seen.add(itemKey(it)); add(date, it.title); }
    const live = workDayOf(Date.now(), dayEnds);
    for (const d of s.docs.values()) {
      if (d.kind !== "todo") continue;
      const t = (d as Doc<Todo>).data;
      if (!t.doneAt || seen.has(itemKey({ todoId: d.id, at: t.doneAt }))) continue;
      if (t.done && !t.clearedAt) add(live, t.title);
      else if (t.clearedAt) add(iso(new Date(t.doneAt)), t.title);
    }
    return m;
  }, [s, dayEnds]);
  const hist = useMemo(() => {
    const m = new Map<string, DayHist>();
    if (!feature("fuller-history") || !historyOn(settingsData(s))) return m;
    for (const [date, log] of dayLogs(s)) { const h = readDay(log.data); if (h.missed.length || h.totals || h.added.length || h.deleted.length || h.dimx.length) m.set(date, h); }
    return m;
  }, [s]);
  // Screen time per local day, counted by PS.
  const screen = useMemo(() => screenTimeDays(s), [s]);
  const [q, setQ] = useState("");
  const jump = (k: string) => {
    setQ("");
    const date = new Date(k.slice(2, 12) + "T12:00:00");
    if (k.startsWith("m:")) { setCur(new Date(k.slice(2) + "-01T12:00:00")); setView("month"); setEdit(null); return; }
    setCur(date); setView("month"); setEdit(k);
  };

  useEffect(() => {
    // The goals Timeline first steps back by itself (its ghost, then its open goal).
    if (escRef) escRef.current = () => { if (goalsEsc()) return; if (q) setQ(""); else if (edit) setEdit(null); else onClose(); };
  });
  useEffect(() => {
    if (embedded) return;
    // PS 1.74: a title or note being typed is saved first (it saves on blur), then the panel or the map closes.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); if (goalsEsc()) return; (document.activeElement as HTMLElement | null)?.blur?.(); if (edit) setEdit(null); else onClose(); } };
    document.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; };
  }, [edit, onClose, embedded]);

  const step = (dir: -1 | 1) => setCur((c) => view === "year" ? new Date(c.getFullYear() + dir, c.getMonth(), 1)
    : view === "month" ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, 7 * dir));
  const heading = view === "timeline" ? "Goals timeline" : view === "year" ? String(cur.getFullYear())
    : view === "month" ? `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`
    : `Week ${weekNo(cur)}, ${monday(cur).getDate()} ${MONTHS[monday(cur).getMonth()].slice(0, 3)}`;

  return (
    <Saves.Provider value={saves}><Hist.Provider value={hist}>
    <div className={`sm-overlay${embedded ? " sm-embedded" : ""}`} role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label="Your series map">
      <header className="sm-bar">
        <div className="sm-bar-l">
          <span className="sm-eyebrow"><Icon name="map" size={15} /> Your series</span>
          <h2 className="sm-heading">{heading}</h2>
        </div>
        <label className="sm-search">
          <Icon name="search" size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, notes, calls" aria-label="Search the map"
            onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQ(""); } }} />
        </label>
        <div className="tabs" role="tablist" aria-label="View">
          {(["year", "month", "week", "timeline"] as View[]).map((v) => (
            <button key={v} role="tab" className="tab" aria-selected={view === v} onClick={() => { setView(v); if (v !== "month") setEdit(null); }}>{v === "timeline" ? "Goals timeline" : v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn quiet icon" onClick={() => step(-1)} aria-label="Previous"><Icon name="back" size={17} /></button>
          <button type="button" className="btn ghost sm" onClick={() => setCur(new Date())}>Today</button>
          <button type="button" className="btn quiet icon" onClick={() => step(1)} aria-label="Next"><Icon name="arrow" size={17} /></button>
          <button type="button" className="btn quiet icon sm-close" onClick={onClose} aria-label="Close the map"><Icon name="x" /></button>
        </div>
      </header>

      <div className={`sm-body${edit ? " has-panel" : ""}`}>
        <div className="sm-main">
          {view === "timeline" ? <div className="sm-goals"><GoalsTimeline goals={settingsData(s).goals || []} onSave={(list) => void saves.goals(list)} /></div>
          : q.trim() ? <SearchResults q={q.trim()} j={j} events={events} ticked={ticked} onPick={jump} /> : <>
          {view === "year" && <YearView year={cur.getFullYear()} j={j} ticked={ticked} onPick={(m) => { setCur(new Date(cur.getFullYear(), m, 1)); setView("month"); }} />}
          {view === "month" && <MonthView y={cur.getFullYear()} m={cur.getMonth()} j={j} today={today} events={events} ticked={ticked} screen={screen} onEdit={setEdit} active={edit} />}
          {view === "week" && <WeekView start={monday(cur)} j={j} today={today} events={events} ticked={ticked} screen={screen} />}
          </>}
        </div>
        {edit && <NotePanel k={edit} j={j} events={events} ticked={ticked} screen={screen} onClose={() => setEdit(null)} />}
      </div>
    </div>
    </Hist.Provider></Saves.Provider>
  );
}

/** The month's own name, with the episode title the developer gives it right beside. */
function MonthTitle({ y, m, j, big }: { y: number; m: number; j: Map<string, Doc<JournalEntry>>; big?: boolean }) {
  const k = mKey(y, m);
  const save = useContext(Saves);
  const saved = j.get(k)?.data.title || "";
  const [v, setV] = useState(saved);
  // PS 1.74: the saved copy coming back never replaces what is being typed in this box.
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setV(saved); }, [saved]);
  return (
    <div className={`sm-mtitle${big ? " big" : ""}`}>
      <span className="sm-mname">{MONTHS[m]}</span>
      <span className="sm-dot" aria-hidden="true">·</span>
      <input className="sm-mepisode" value={v} placeholder="Title this month" aria-label={`Title for ${MONTHS[m]} ${y}`}
        onFocus={() => { typing.current = true; }}
        onChange={(e) => setV(e.target.value)} onBlur={() => { typing.current = false; if (v.trim() !== saved) void save.journal(k, { title: v.trim() || null }); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

function NoteBox({ k, j, placeholder, rows = 3, label }: { k: string; j: Map<string, Doc<JournalEntry>>; placeholder: string; rows?: number; label: string }) {
  const save = useContext(Saves);
  const saved = j.get(k)?.data.note || "";
  const [v, setV] = useState(saved);
  const typing = useRef(false), shownKey = useRef(k);
  useEffect(() => { if (!typing.current || shownKey.current !== k) setV(saved); shownKey.current = k; }, [saved, k]);
  return (
    <textarea className="textarea sm-note" rows={rows} value={v} placeholder={placeholder} aria-label={label}
      onFocus={() => { typing.current = true; }}
      onChange={(e) => setV(e.target.value)} onBlur={() => { typing.current = false; if (v !== saved) void save.journal(k, { note: v.trim() || null }); }} />
  );
}

function YearView({ year, j, ticked, onPick }: { year: number; j: Map<string, Doc<JournalEntry>>; ticked: Map<string, string[]>; onPick: (m: number) => void }) {
  return (
    <div className="sm-year">
      {MONTHS.map((_, m) => {
        const prefix = `d:${year}-${pad(m + 1)}-`;
        const days = [...j.keys()].filter((k) => k.startsWith(prefix)).length;
        const done = [...ticked].filter(([k]) => k.startsWith(prefix.slice(2))).reduce((n, [, v]) => n + v.length, 0);
        const note = j.get(mKey(year, m))?.data.note;
        const isNow = year === new Date().getFullYear() && m === new Date().getMonth();
        return (
          <div key={m} className={`sm-ytile${isNow ? " now" : ""}`} role="button" tabIndex={0} onClick={() => onPick(m)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT") onPick(m); }}>
            <span className="sm-ep num">Episode {m + 1}</span>
            <MonthTitle y={year} m={m} j={j} />
            {note ? <p className="small sm-ynote">{note}</p> : <p className="xs muted">No month note yet</p>}
            <span className="xs muted num">{days} day{days === 1 ? "" : "s"} written{done > 0 && <> · <b className="sm-ydone">{done} task{done === 1 ? "" : "s"} done</b></>}</span>
          </div>
        );
      })}
    </div>
  );
}

type Screen = Map<string, Doc<ScreenTimeDay>>;

function MonthView({ y, m, j, today, events, ticked, screen, onEdit, active }: {
  y: number; m: number; j: Map<string, Doc<JournalEntry>>; today: string;
  events: Map<string, string[]>; ticked: Map<string, string[]>; screen: Screen; onEdit: (k: string) => void; active: string | null;
}) {
  const hist = useContext(Hist);
  const first = new Date(y, m, 1);
  const start = monday(first);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row = Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i));
    if (w > 3 && row[0].getMonth() !== m) break;
    weeks.push(row);
  }
  return (
    <div className="stack">
      <MonthTitle y={y} m={m} j={j} big />
      <NoteBox k={mKey(y, m)} j={j} rows={2} label={`Note for ${MONTHS[m]}`} placeholder={`What was ${MONTHS[m]} about? The story of the month.`} />
      <div className="sm-grid" role="grid" aria-label={`${MONTHS[m]} ${y}`}>
        <div className="sm-gh sm-wk-h">Wk</div>
        {DOW.map((d) => <div key={d} className="sm-gh">{d}</div>)}
        {weeks.map((row) => {
          const wk = wKey(row[0]);
          const wNote = j.get(wk)?.data.note;
          return [
            <button key={wk} type="button" className={`sm-wk${wNote ? " has" : ""}${active === wk ? " on" : ""}`} onClick={() => onEdit(wk)} title={wNote || "Add a note for this week"}>
              <span className="num">{weekNo(row[0])}</span>{wNote && <i className="sm-pip" aria-hidden="true" />}
            </button>,
            ...row.map((d) => {
              const k = dKey(d);
              const ds = iso(d);
              const note = j.get(k)?.data.note;
              const ev = events.get(ds)?.length || 0;
              const tk = ticked.get(ds)?.length || 0;
              const ms = hist.get(ds)?.totals?.missed || 0;
              const sc = totalSecs(screen.get(ds)?.data.apps || []);
              return (
                <button key={k} type="button" className={`sm-day${d.getMonth() !== m ? " out" : ""}${ds === today ? " today" : ""}${note ? " has" : ""}${active === k ? " on" : ""}`}
                  onClick={() => onEdit(k)} aria-label={`${d.getDate()} ${MONTHS[d.getMonth()]}${note ? ", has a note" : ""}`}>
                  <span className="sm-dnum num">{d.getDate()}</span>
                  {note && <span className="sm-dnote">{note}</span>}
                  {(ev > 0 || tk > 0 || ms > 0 || sc >= 60) && (
                    <span className="sm-dmeta xs num">
                      {ev > 0 && <span title="Calendar events">{ev} on calendar</span>}
                      {tk > 0 && <span title="Ticked off">{tk} done</span>}
                      {ms > 0 && <span className="sm-missed" title="Not done that day">{ms} missed</span>}
                      {sc >= 60 && <span title="Screen time">{fmtDur(sc)} screen</span>}
                    </span>
                  )}
                </button>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}

function WeekView({ start, j, today, events, ticked, screen }: {
  start: Date; j: Map<string, Doc<JournalEntry>>; today: string; events: Map<string, string[]>; ticked: Map<string, string[]>; screen: Screen;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="stack">
      <NoteBox k={wKey(start)} j={j} rows={2} label="Note for this week" placeholder="What happened this week?" />
      <div className="sm-week">
        {days.map((d, i) => {
          const ds = iso(d);
          const sc = totalSecs(screen.get(ds)?.data.apps || []);
          return (
            <div key={ds} className={`sm-wday${ds === today ? " today" : ""}`}>
              <div className="sm-wday-h"><b>{DOW[i]}</b> <span className="num muted">{d.getDate()} {MONTHS[d.getMonth()].slice(0, 3)}</span>
                {sc >= 60 && <span className="xs muted num" title="Screen time"> · {fmtDur(sc)} screen</span>}</div>
              <Happened ev={events.get(ds)} tk={ticked.get(ds)} ds={ds} />
              <NoteBox k={dKey(d)} j={j} rows={5} label={`Note for ${ds}`} placeholder="What happened today?" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Happened({ ev, tk, ds, all }: { ev?: string[]; tk?: string[]; ds?: string; all?: boolean }) {
  const h = useContext(Hist).get(ds || "");
  const miss = h?.missed || [];
  if (!ev?.length && !tk?.length && !miss.length) return null;
  const n = all ? 999 : 6;
  const t = h?.totals;
  return (
    <ul className="sm-happened">
      {(ev || []).slice(0, n).map((t, i) => <li key={"e" + i}><Icon name="cal" size={12} /> {t}</li>)}
      {(tk || []).slice(0, n).map((t, i) => <li key={"t" + i} className="done"><Icon name="check" size={12} /> {t}</li>)}
      {!all && (tk?.length || 0) > n && <li className="xs muted">and {tk!.length - n} more</li>}
      {miss.slice(0, all ? 999 : 3).map((x, i) => <li key={"m" + i} className="sm-missed" title={x.p1 ? "Priority 1, not done" : "Not done"}><Icon name="x" size={12} /> {x.t}{x.p1 ? " (P1)" : ""}</li>)}
      {t && (t.done > 0 || t.missed > 0) && all && <li className="xs muted num">{t.done} done, {t.missed} missed{t.p1Done + t.p1Missed > 0 ? `, P1 ${t.p1Done} done, ${t.p1Missed} missed` : ""}{t.added ? `, ${t.added} added` : ""}{t.deleted ? `, ${t.deleted} deleted` : ""}{t.dimx ? `, ${t.dimx} to Dimension X` : ""}</li>}
    </ul>
  );
}

/** Everything that matches the search: tasks done, notes and titles, calendar events. Click one to go to its day. */
function SearchResults({ q, j, events, ticked, onPick }: {
  q: string; j: Map<string, Doc<JournalEntry>>; events: Map<string, string[]>; ticked: Map<string, string[]>; onPick: (k: string) => void;
}) {
  const ql = q.toLowerCase();
  type Hit = { k: string; when: string; text: string; kind: "done" | "note" | "cal" };
  const hits: Hit[] = [];
  const nice = (date: string) => new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  for (const [date, list] of ticked) for (const t of list) if (t.toLowerCase().includes(ql)) hits.push({ k: `d:${date}`, when: date, text: t, kind: "done" });
  for (const [date, list] of events) for (const t of list) if (t.toLowerCase().includes(ql)) hits.push({ k: `d:${date}`, when: date, text: t, kind: "cal" });
  for (const [k, d] of j) {
    const text = [d.data.title, d.data.note].filter(Boolean).join(": ");
    if (text.toLowerCase().includes(ql)) hits.push({ k, when: k.slice(2) + (k.startsWith("m:") ? "-01" : ""), text, kind: "note" });
  }
  hits.sort((a, b) => b.when.localeCompare(a.when));
  const label = (h: Hit) => h.k.startsWith("m:") ? new Date(h.when + "T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : h.k.startsWith("w:") ? `Week of ${nice(h.when)}` : nice(h.when);
  if (!hits.length) return <p className="muted sm-noresults">Nothing matches "{q}".</p>;
  return (
    <div className="stack tight">
      <span className="xs muted num">{hits.length} result{hits.length === 1 ? "" : "s"}</span>
      <ul className="sm-results">
        {hits.slice(0, 300).map((h, i) => (
          <li key={i}>
            <button type="button" onClick={() => onPick(h.k)}>
              <Icon name={h.kind === "done" ? "check" : h.kind === "cal" ? "cal" : "edit"} size={14} />
              <span className="sm-r-t">{h.text}</span>
              <span className="sm-r-d num">{label(h)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotePanel({ k, j, events, ticked, screen, onClose }: {
  k: string; j: Map<string, Doc<JournalEntry>>; events: Map<string, string[]>; ticked: Map<string, string[]>; screen: Screen; onClose: () => void;
}) {
  const isWeek = k.startsWith("w:");
  const date = new Date(k.slice(2) + "T12:00:00");
  const title = isWeek
    ? `Week ${weekNo(date)}: ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} to ${addDays(date, 6).getDate()} ${MONTHS[addDays(date, 6).getMonth()].slice(0, 3)}`
    : date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const ds = k.slice(2);
  return (
    <aside className="sm-panel" aria-label={title}>
      <div className="row between">
        <h3 className="h3">{title}</h3>
        <button type="button" className="btn quiet icon sm" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
      <NoteBox key={k} k={k} j={j} rows={9} label={`Note for ${title}`} placeholder={isWeek ? "What happened this week?" : "What happened today?"} />
      {!isWeek && <Happened ev={events.get(ds)} tk={ticked.get(ds)} ds={ds} all />}
      {!isWeek && <DayScreen apps={screen.get(ds)?.data.apps} />}
      {isWeek && <WeekScreen start={date} screen={screen} />}
      <span className="xs muted">Saved automatically when you click away.</span>
    </aside>
  );
}

/** The day panel: that day's screen time, app by app. */
function DayScreen({ apps }: { apps?: ScreenTimeDay["apps"] }) {
  if (!apps?.length) return null;
  return (
    <div className="sm-st">
      <div className="sm-st-h"><b className="small">Screen time</b><span className="small num">{fmtDur(totalSecs(apps))}</span></div>
      <ScreenTimeBars apps={apps} limit={12} />
    </div>
  );
}

/** The week panel: the week's screen time added up per app. */
function WeekScreen({ start, screen }: { start: Date; screen: Screen }) {
  const sum = new Map<string, { id: string; name: string; secs: number }>();
  for (let i = 0; i < 7; i++) for (const a of screen.get(iso(addDays(start, i)))?.data.apps || []) {
    const p = sum.get(a.id);
    sum.set(a.id, { id: a.id, name: a.name, secs: (p?.secs || 0) + a.secs });
  }
  return <DayScreen apps={[...sum.values()]} />;
}
