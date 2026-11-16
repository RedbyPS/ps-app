// PS > Settings > Force Touch middle click (the developer, 31 Oct 2026). The helper "PS Middle Click" inside the PS
// app on this Mac (ps-mac Sources/MiddleClick.swift, built from ~/Projects/middle-click, the same code as
// the standalone PSMiddleClicker app): a firm trackpad press on a link in a browser opens it in a new
// background tab. On by default for everyone (the developer, 16 Nov 2026); an explicit off stays off. The helper
// never asks for its permission by itself: "Open Privacy & Security" has it ask macOS (one click) and
// opens the page. PS never changes a system setting: it says what to switch and opens the right page.
import { psPost, usePsSettings, type PsSettings } from "../ps";
import { appName } from "../core/appname";

type MiddleClickState = {
  on: boolean;
  status: "off" | "starting" | "needsAccess" | "standalone" | "on";
  present?: boolean;    // false: this PS app has no helper inside
  approval?: boolean;   // macOS wants the login item allowed
};

const PILL: Record<MiddleClickState["status"], [string, string]> = {
  off: ["Off", "ink"],
  starting: ["Starting", "ink"],
  needsAccess: ["Needs permission", "warn"],
  standalone: ["PSMiddleClicker app in use", "ink"],
  on: ["On", "good"],
};

export function MiddleClickSettings() {
  const st = usePsSettings() as (PsSettings & { middleClick?: MiddleClickState }) | null;
  const m = st?.middleClick;
  if (st && (!m || m.present === false)) return null;   // an older PS app, or one without the helper
  const set = (on: boolean) => { if (m && m.on !== on) psPost({ type: "middleClick", op: "set", on }); };
  const [pill, tone] = m ? PILL[m.status] ?? PILL.off : ["", ""];
  return (
    <section className="panel stack" aria-labelledby="mc-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="mc-h">Force Touch middle click</h2>
        {m && <span className={`pill ${tone}`}>{pill}</span>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Press a link on the trackpad, then keep pressing until you feel the second, deeper click: the link opens in a new
        background tab, and a firm press on a browser tab closes it. Works in Safari, Chrome, Brave, Arc, Firefox and Edge;
        everywhere else the trackpad is left alone. It runs as its own small helper, PS Middle Click, so it keeps working while
        {" "}{appName()} restarts or updates. It never connects to the internet and steps aside while 1Password or Signal is in front.
      </p>
      <div className="tabs" role="radiogroup" aria-label="Force Touch middle click on or off" style={{ justifySelf: "start" }}>
        <button className="tab" role="radio" aria-checked={!!m?.on} aria-selected={!!m?.on} disabled={!m} onClick={() => set(true)}>On</button>
        <button className="tab" role="radio" aria-checked={!!m && !m.on} aria-selected={!!m && !m.on} disabled={!m} onClick={() => set(false)}>Off</button>
      </div>
      {m?.on && m.status === "needsAccess" && (
        <div className="stack tight">
          <p className="small" style={{ margin: 0 }}>
            One step left: switch on <b>PS Middle Click</b> in System Settings › Privacy &amp; Security › Device Control and
            Data Access (called Accessibility on older macOS). It needs this to see trackpad clicks.
          </p>
          <button className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => psPost({ type: "middleClick", op: "accessibility" })}>
            Open Privacy &amp; Security
          </button>
        </div>
      )}
      {m?.status === "standalone" && (
        <p className="xs muted" style={{ margin: 0 }}>
          The PSMiddleClicker app is running, so it does the firm press and {appName()}'s helper waits. Quit that app to use this one.
        </p>
      )}
      {m?.on && m.approval && (
        <p className="xs muted" style={{ margin: 0 }}>
          To start it with your Mac, allow PS Middle Click in System Settings › General › Login Items. Until then {appName()} starts it
          each time {appName()} opens.
        </p>
      )}
      {m?.on && (
        <p className="xs muted" style={{ margin: 0 }}>Keep “Force Click and haptic feedback” on in System Settings › Trackpad.</p>
      )}
    </section>
  );
}
