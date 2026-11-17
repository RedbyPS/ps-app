// The squad's Priority 1 panel (PS 1.63, feature "squad-p1"): in the Tab list's right column, under the client emails and above Sleep.
// A mini G Squad: each other member's Priority 1 tasks that they share, with the time left on their 24 hours ("Missed" in red once it
// passed, a tick when done). Thin and calm. Click a row: the G Squad window opens on Tasks. Hidden when the feature is off, when you
// are not in a squad, or when you switched "Show the squad's Priority 1 tasks" off (Squad settings, What you share).
// The rules and the words' maths are in core/squadp1.ts (tests/squadp1.test.ts). The rows come from the plain view (no keys).
import { useEffect, useState } from "react";
import { feature } from "../core/features";
import { P1_FEATURE, P1_MISSED_SHOW_MS, P1_DONE_SHOW_MS, firstName, p1Deadline, p1PanelOn, p1State, stateText } from "../core/squadp1";
import { settingsData } from "../core/select";
import { useSquad } from "../squad/mirror";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Avatar } from "./SquadAvatar";
import { openGSquad } from "./GSquad";
import "./squadp1.css";

function useNow(every = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setN(Date.now()), every); return () => window.clearInterval(t); }, [every]);
  return n;
}

export function SquadP1Panel() {
  const v = useSquad();
  const st = settingsData(useVault());
  const now = useNow();
  if (!v.in || !p1PanelOn(feature(P1_FEATURE), st)) return null;
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
                  <span className="sqp1-s">{s.kind === "done" ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-label="Done"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : stateText(s)}</span>
                </button>
              </li>
            );
          })}
        </ul>}
    </section>
  );
}
