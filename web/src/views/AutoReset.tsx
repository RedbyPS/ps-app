// The automatic Reset: the on/off switch and the time it runs (the developer, 8 Nov 2026: "make it so you can actually alter
// the time as well, so for example if you want to change it to 4am you can"). One control for every place it shows:
// Mac settings (End of day, in the Tab list), the website's To-do page and Settings, and the phone (the same web
// pages). Everyone's, public build included. The rules are in core/resetday.ts.
import { useEffect, useState } from "react";
import type { Settings } from "../core/model";
import { okResetAt, resetAtOf, resetAtWords, RESET_AT_DEFAULT } from "../core/resetday";
import { appName } from "../core/appname";
import { CD_FEATURE, cdPatch, cleanCd, okHm, type CdPrefs } from "../core/daycount";
import { feature } from "../core/features";
import { isRedAccount } from "../core/account";
import { useVault } from "../ui/kit";

/** onCountdown (Settings, Time and reset): shows the day countdown's own end right under the reset time (PS 1.72, Jan: "I wanted
 *  ... the timer I see on the screen [at midnight], but my tasks should reset at 5am"), with a link to Countdown text. Two times,
 *  side by side: the countdown follows the reset time until you set its own. */
export function AutoResetSetting({ st, save, className = "st-switch", onCountdown }: {
  st: Pick<Settings, "autoReset" | "autoResetAt" | "countdown">; save: (patch: Partial<Settings>) => void; className?: string; onCountdown?: () => void;
}) {
  const on = st.autoReset === "midnight";
  const at = resetAtOf(st);
  const [v, setV] = useState(at);
  useEffect(() => { setV(at); }, [at]);
  const words = resetAtWords(at);
  const cd = cleanCd(st.countdown, isRedAccount(useVault()));
  const cdShown = !!onCountdown && feature(CD_FEATURE) && cd.on;
  const cdAt = cd.mode === "reset" ? at : cd.at;   // the countdown's end: the reset time until you set its own
  const [cv, setCv] = useState(cdAt);
  useEffect(() => { setCv(cdAt); }, [cdAt]);
  const setCd = (change: Partial<CdPrefs>) => save({ countdown: cdPatch(cd, change) });
  const pickCd = (x: string) => {
    setCv(x);
    if (okHm(x) && (x !== cdAt || cd.mode === "reset")) setCd({ mode: "daily", at: x });
  };
  const pick = (x: string) => {
    setV(x);
    if (okResetAt(x) && x !== at) save({ autoResetAt: x });
  };
  return (
    <div className={`${className} ar-row`} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <input type="checkbox" className="check" id="ar-on" checked={on} aria-label="Reset automatically"
        onChange={(e) => save({ autoReset: e.target.checked ? "midnight" : "off" })} />
      <span className="stack tight" style={{ gap: 4, flex: 1 }}>
        <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="small" htmlFor="ar-on" style={{ fontWeight: 700 }}>Reset automatically at</label>
          <input type="time" className="input ar-time" step={60} value={v} aria-label="Reset time"
            style={{ width: "auto", minWidth: 110, padding: "2px 8px" }}
            onChange={(e) => pick(e.target.value)} onBlur={() => { if (!okResetAt(v)) setV(at); }} />
          {at !== RESET_AT_DEFAULT && (
            <button type="button" className="btn ghost sm" onClick={() => pick(RESET_AT_DEFAULT)}>Midnight</button>
          )}
        </span>
        <span className="xs muted">
          {on
            ? `If you have not pressed Reset by ${words} (your own time zone), ${appName()} resets your list for you, once a day. A device that was asleep or off then does it when it wakes.`
            : "Off: your list only resets when you press Reset."}
          {at !== RESET_AT_DEFAULT && ` Your day starts at ${words} too: a task ticked before ${words} counts for the day before (Completed today, streaks, G Squad counts).`}
        </span>
        {cdShown && (
          <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="small" style={{ fontWeight: 700 }}>Day ends</span>
            {cd.mode !== "week" && (<>
              <input type="time" className="input ar-time" step={60} value={cv} aria-label="Day ends"
                style={{ width: "auto", minWidth: 110, padding: "2px 8px" }}
                onChange={(e) => pickCd(e.target.value)} onBlur={() => { if (!okHm(cv)) setCv(cdAt); }} />
              {cdAt !== RESET_AT_DEFAULT && (
                <button type="button" className="btn ghost sm" onClick={() => pickCd(RESET_AT_DEFAULT)}>Midnight</button>
              )}
            </>)}
            <button type="button" className="cds-link" onClick={onCountdown}>Countdown text</button>
          </span>
        )}
      </span>
    </div>
  );
}
