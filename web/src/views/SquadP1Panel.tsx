// The squad's Priority 1 panel (PS 1.63, feature "squad-p1"): in the Tab list's right column, under the client emails and above Sleep.
// PS 1.68 (feature "squad-p1-board", Jan 18 Nov 2026): one row per PERSON, ranked like a competition, instead of one row per task:
// place, name, their open P1 with the time left (green, amber under 8 hours, red only in the last 2 hours), hit rate and streak.
// Every number says what it is on hover. Click a person to see their P1s; click a P1 to open G Squad on Tasks. The line at the foot
// drags to show more or fewer people (saved with the panel, like its other settings). With the board switched off it is the 1.63
// panel: one row per task. Hidden when the feature is off, when you are not in a squad, or when you switched "Show the squad's
// Priority 1 tasks" off (Squad settings, What you share).
// The rules and the words are in core/squadp1.ts and core/squadp1board.ts (tests). The rows come from the plain view (no keys).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { feature } from "../core/features";
import { P1_FEATURE, P1_MISSED_SHOW_MS, P1_DONE_SHOW_MS, firstName, p1Deadline, p1PanelOn, p1State, stateText, type P1Row } from "../core/squadp1";
import { BOARD_FEATURE, ROWS_MAX, ROWS_MIN, headTip, leadOf, leadTip, leftTone, leftWords, placeTip, rateTip, rowsOf, streakTip, type P1Person } from "../core/squadp1board";
import { settingsData } from "../core/select";
import { useSquad } from "../squad/mirror";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Avatar } from "./SquadAvatar";
import { openGSquad } from "./GSquad";
import { useInst, useInstSave } from "./EditMode";
import "./squadp1.css";

function useNow(every = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setN(Date.now()), every); return () => window.clearInterval(t); }, [every]);
  return n;
}
const tzNow = (st: { tmHomeTz?: string | null }) => (typeof st.tmHomeTz === "string" && st.tmHomeTz) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const Tick = ({ size = 13 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const Flame = () => <svg width="10" height="12" viewBox="0 0 20 24" fill="currentColor" aria-hidden="true"><path d="M10 1.5c.9 3.6 5.6 6.1 5.6 11.7A5.6 5.6 0 0 1 10 18.8a5.6 5.6 0 0 1-5.6-5.6c0-2.6 1.3-4.3 2.6-5.5.2 2 1.1 3.2 2.4 3.6-.7-3.4-.4-6.6.6-9.8z" /><path d="M10 22.5a3 3 0 0 1-3-3c0-1.6 1.4-2.6 3-4.6 1.6 2 3 3 3 4.6a3 3 0 0 1-3 3z" opacity=".55" /></svg>;

export function SquadP1Panel() {
  const v = useSquad();
  const st = settingsData(useVault());
  const now = useNow();
  if (!v.in || !p1PanelOn(feature(P1_FEATURE), st)) return null;
  if (feature(BOARD_FEATURE) && v.p1b) return <Board people={v.p1b} since={v.p1since ?? null} now={now} tz={tzNow(st)} />;
  const names = new Map(v.members.map((m) => [m.id, m.name]));
  const rows = (v.p1 ?? []).filter((r) => names.has(r.member) && (r.x ? !r.xa || now - Date.parse(r.xa) <= P1_DONE_SHOW_MS : now - p1Deadline(r.s) <= P1_MISSED_SHOW_MS));
  return (
    <section className="sqp1" aria-label="Priority 1 in G Squad">
      <header className="sqp1-h"><span>Squad Priority 1</span></header>
      {rows.length === 0
        ? <p className="sqp1-empty">Nobody has a Priority 1 task right now.</p>
        : <ul>
          {rows.map((r) => {
            const s = p1State(r, now);
            const name = names.get(r.member) ?? "Someone";
            return (
              <li key={r.id}>
                <button type="button" className={`sqp1-row ${s.kind}`} onClick={() => { sfx.click(); openGSquad(true, "tasks"); }}
                  aria-label={`${firstName(name)}: ${r.t}. ${stateText(s)}`} data-tip={r.t} data-tip-line="Open G Squad">
                  <Avatar id={r.member} name={name} size={22} />
                  <span className="sqp1-who">{firstName(name)}</span>
                  <span className="sqp1-t">{r.t}</span>
                  <span className={`sqp1-s${s.kind === "open" ? ` ${leftTone(s.left)}` : ""}`}>{s.kind === "done" ? <Tick /> : stateText(s)}</span>
                </button>
              </li>
            );
          })}
        </ul>}
    </section>
  );
}

/** The time left (or Missed, or a tick) of one P1, coloured, with its words on hover. */
function State({ r, now }: { r: P1Row; now: number }) {
  const s = p1State(r, now);
  if (s.kind === "done") {
    const late = !!r.xa && Date.parse(r.xa) > p1Deadline(r.s);
    return <span className={`sqb-st ${late ? "warn" : "done"}`} data-tip={late ? "Done late" : "Done"} data-tip-line={late ? "Finished after its 24 hours ran out" : "Finished inside its 24 hours"}>{late ? "Late" : <Tick size={12} />}</span>;
  }
  if (s.kind === "missed") return <span className="sqb-st bad" data-tip="Missed" data-tip-line={`The 24 hours ran out ${stateText({ kind: "open", left: Math.max(60_000, now - p1Deadline(r.s)) })} ago`}>Missed</span>;
  return <span className={`sqb-st ${leftTone(s.left)}`} data-tip={leftWords(s.left)} data-tip-line="Time left of the 24 hours this Priority 1 task has">{leftWords(s.left)}</span>;
}

function Board({ people, since, now, tz }: { people: P1Person[]; since: string | null; now: number; tz: string }) {
  const inst = useInst();
  const save = useInstSave();
  const [own, setOwn] = useState<number | null>(null);   // outside a Slot (the website's To-do page, the phone): this run only
  const [drag, setDrag] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const start = useRef<{ y: number; n: number; h: number } | null>(null);
  const saved = rowsOf(save ? inst?.cfg.rows : own);
  const n = drag ?? saved;
  const shown = all ? people : people.slice(0, n);
  const more = people.length - shown.length;
  const log = since ? { since, e: {} } : null;
  const setRows = (k: number) => { if (save) save({ rows: k }); else setOwn(k); };

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    const first = listRef.current?.querySelector<HTMLElement>(":scope > li > .sqb-row");
    start.current = { y: e.clientY, n: shown.length || n, h: Math.max(16, first?.getBoundingClientRect().height ?? 26) };
    e.currentTarget.setPointerCapture(e.pointerId);
    setAll(false);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    const k = Math.max(ROWS_MIN, Math.min(ROWS_MAX, s.n + Math.round((e.clientY - s.y) / s.h)));
    if (k !== drag) { if (drag !== null) sfx.hover(); setDrag(k); }
  };
  const up = () => { const k = drag; start.current = null; setDrag(null); if (k !== null && k !== saved) { sfx.click(); setRows(k); } };
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = Math.max(ROWS_MIN, Math.min(ROWS_MAX, saved + d));
    if (k !== saved) { sfx.hover(); setRows(k); }
  };

  return (
    <section className="sqp1 sqb" aria-label="Priority 1 in G Squad, ranked">
      <header className="sqp1-h"><span data-tip="Squad Priority 1" data-tip-line={headTip(log, now, tz)}>Squad Priority 1</span></header>
      {people.length === 0
        ? <p className="sqp1-empty">Nobody has a Priority 1 task right now.</p>
        : <ul ref={listRef} className="sqb-list">
          {shown.map((p) => {
            const lead = leadOf(p.rows, now);
            const isOpen = openId === p.member;
            return (
              <li key={p.member} className={isOpen ? "open" : ""}>
                <button type="button" className={`sqb-row${p.me ? " me" : ""}`} aria-expanded={isOpen}
                  aria-label={`${p.place ? `Place ${p.place}, ` : ""}${firstName(p.name)}. ${leadTip(lead, now)} ${rateTip(p, now, tz)} ${streakTip(p)}`}
                  onClick={() => { sfx.click(); setOpenId(isOpen ? null : p.member); }}>
                  <span className="sqb-pl num" data-tip={p.place ? `Place ${p.place}` : "Not ranked yet"} data-tip-line={placeTip(p)}>{p.place ?? ""}</span>
                  <Avatar id={p.member} name={p.name} size={18} />
                  <span className="sqb-who">{firstName(p.name)}</span>
                  <span className="sqb-lead">
                    {lead.kind === "open" && <span className={`sqb-st ${leftTone(lead.left)}`} data-tip={leftWords(lead.left)} data-tip-line={leadTip(lead, now)}>{leftWords(lead.left)}{lead.more ? <i className="sqb-more">+{lead.more}</i> : null}</span>}
                    {lead.kind === "missed" && <span className="sqb-st bad" data-tip="Missed" data-tip-line={leadTip(lead, now)}>Missed</span>}
                    {lead.kind === "done" && <span className="sqb-st done" data-tip="Done" data-tip-line={leadTip(lead, now)}><Tick size={12} /></span>}
                  </span>
                  <span className={`sqb-rate num${p.stats.rate === null ? " none" : ""}`} data-tip={p.stats.rate === null ? "Hit rate" : `${p.stats.rate}% hit rate`} data-tip-line={rateTip(p, now, tz)}>
                    {p.stats.rate === null ? "" : `${p.stats.rate}%`}
                  </span>
                  <span className={`sqb-streak num${p.stats.streak ? "" : " none"}`} data-tip={`${p.stats.streak} day streak`} data-tip-line={streakTip(p)}><Flame />{p.stats.streak}</span>
                </button>
                {isOpen && (
                  <ul className="sqb-tasks">
                    {p.rows.length === 0 && <li className="sqb-none">No Priority 1 task right now.</li>}
                    {p.rows.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="sqb-task" onClick={() => { sfx.click(); openGSquad(true, "tasks"); }} data-tip={r.t} data-tip-line="Open G Squad on Tasks">
                          <span className={`sqb-tt${r.x ? " done" : ""}`}>{r.t}</span>
                          <State r={r} now={now} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>}
      {(more > 0 || all) && (
        <button type="button" className="sqb-all" onClick={() => { sfx.click(); setAll(!all); }}>{all ? "Show fewer" : `${more} more`}</button>
      )}
      {people.length > 1 && (
        <button type="button" className={`sqb-grip${drag !== null ? " on" : ""}`} role="slider" aria-label="People shown" aria-valuemin={ROWS_MIN} aria-valuemax={ROWS_MAX} aria-valuenow={n}
          data-tip={`Shows ${n} ${n === 1 ? "person" : "people"}`} data-tip-line="Drag down to show more people, up to show fewer"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}><i /></button>
      )}
    </section>
  );
}
