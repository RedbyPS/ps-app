// The "Show the squad's Priority 1 tasks" switch (PS 1.63), in Squad settings, What you share. Its own file so Squad settings and the
// panel (views/SquadP1Panel.tsx, which opens the G Squad window) do not import each other.
import { feature } from "../core/features";
import { P1_FEATURE } from "../core/squadp1";
import { settingsData } from "../core/select";
import { squadOp } from "../squad/mirror";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";

/** The "Show the squad's Priority 1 tasks" switch (Squad settings, What you share). */
export function SquadP1Switch() {
  const st = settingsData(useVault());
  if (!feature("squad-p1")) return null;
  const on = st.squadP1Show !== false;
  return (
    <ul className="gs-list" data-p1="show">
      <li>
        <button type="button" role="switch" aria-checked={on} className={`gs-sw${on ? " on" : ""}`} onClick={() => { sfx.click(); squadOp({ op: "p1show", on: !on }); }}>
          <span className="gs-tt">Show the squad's Priority 1 tasks<em>{on ? "A small panel on the right, and a card when someone misses their 24 hours." : "Off: no panel and no cards about other people's tasks."}</em></span>
          <i className="gs-tog" aria-hidden="true"><b /></i>
        </button>
      </li>
    </ul>
  );
}
