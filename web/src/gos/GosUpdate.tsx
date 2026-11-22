// "Update now" for PS GOS (nothing downloads or installs before the developer taps it). The shell checks version.json beside the APK at an unlisted
// path (cincee.com/client/gos/), downloads it, verifies the SHA-256 from the manifest AND that the
// APK is signed with PS's own release certificate (pinned in the app), then hands it to the
// system installer (one confirm tap). The card only shows what the shell reports.
import { useEffect, useRef, useState } from "react";
import { gos, haptic, useGos, type GosUpdate } from "./bridge";
import { tickHolds } from "../core/updatetick";
import { tickStore, useTick } from "../updatetick";
import { catchUp } from "../core/notehistory";
import { NoteGroups } from "../ui/NoteGroups";
import { byLine } from "../core/releaseby";
import { cardShape, sizeText } from "../core/updatecard";
import { saveBeforeLeaving } from "../core/savenow";

const STEPS = ["Download", "Verify", "Install"] as const;

const mb = sizeText;

/** The reload button on "You are up to date" (a tick before V1.51): a tap looks for updates, the same as the Mac (core/updatetick.ts). */
const gosTick = tickStore<GosUpdate>();

export function GosUpdateCard() {
  const { update: raw, version, keyword } = useGos();
  const tk = useTick(gosTick);
  useEffect(() => { gosTick.seen(raw); }, [raw]);
  // While the tick looks, and after it found nothing (or could not look), the card stays up to date.
  const u = tk.home && tickHolds(raw.state, tk.phase, tk.check) ? tk.home : raw;
  const tickOn = u.state === "none";
  const tickBusy = tickOn && (tk.phase === "spin" || tk.phase === "fail");
  // Repeat taps while it looks do nothing.
  const tickGo = () => { if (tk.phase !== "tick") return; haptic("press"); gosTick.start(u); gos.checkUpdate(); };
  // "V1.07 · Wisdom": the shared PS version and its keyword, the keyword a little softer.
  // V1.58: "V1.59 by Jan · Harmony" for a release that says who made it.
  const named = (v?: string, k?: string, by?: string) => <>{v}{byLine(by) ? ` ${byLine(by)}` : null}{k ? <span className="gos-kw"> · {k}</span> : null}</>;
  // Smooth progress: the bar eases towards the reported value instead of jumping.
  const [shown, setShown] = useState(0);
  const target = u.state === "downloading" ? (u.progress ?? 0) : u.state === "verifying" || u.state === "ready" || u.state === "installing" ? 1 : 0;
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      setShown((v) => {
        const next = v + (target - v) * 0.14;
        if (Math.abs(target - next) < 0.002) return target;
        raf.current = requestAnimationFrame(step);
        return next;
      });
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  useEffect(() => { if (u.state === "ready") haptic("tick"); if (u.state === "error") haptic("reject"); }, [u.state]);

  const busy = u.state === "checking" || u.state === "downloading" || u.state === "verifying" || u.state === "installing";
  const stepAt = u.state === "downloading" ? 0 : u.state === "verifying" ? 1 : u.state === "ready" || u.state === "installing" ? 2 : -1;
  const title = u.state === "available" ? <>Update available · {named(u.version, u.keyword, u.by)}</>
    : u.state === "downloading" ? <>Downloading {named(u.version, u.keyword)}</>
    : u.state === "verifying" ? "Checking it is really yours"
    : u.state === "ready" ? "Verified. Ready to install"
    : u.state === "installing" ? "Installing"
    : u.state === "none" ? "You are up to date"
    : u.state === "checking" ? "Looking for updates"
    : u.state === "error" ? "Update stopped"
    : "Updates";
  // V1.52: an update across several versions lists every version newer than this phone's, newest first (the notes
  // field is the newest version's lines, history the earlier ones; with one version the line below is as before).
  const blocks = u.state === "available"
    ? catchUp([...(u.version && u.notes ? [{ version: u.version, keyword: u.keyword ?? "", notes: u.notes.split("\n").map((n) => n.trim()).filter(Boolean), by: u.by }] : []), ...(Array.isArray(u.history) ? u.history : [])], u.current, u.version)
    : [];
  // PS 1.60: the notes are a full width list under the title (below), the size is the only thing on this line.
  const shape = cardShape(u.state, u.notes, u.size, blocks.length);
  const sub = u.state === "available" ? (shape.size ? `Download size ${shape.size}` : "A new version is ready")
    : u.state === "downloading" ? `${Math.round(shown * 100)}% of ${mb(u.size)}`
    : u.state === "verifying" ? "SHA-256 and PS app's own signing certificate"
    : u.state === "ready" ? "GrapheneOS shows one confirm tap"
    : u.state === "installing" ? "PS app closes for a moment and comes back updated"
    : u.state === "error" ? (u.error || "Something went wrong. Nothing was installed.")
    : tickOn && tk.phase === "spin" ? "Looking for updates"
    : tickOn && tk.phase === "fail" ? "Could not check"
    : <>You have {version ? named(version, keyword) : "this build"}</>;
  return (
    <section className={`gos-upd s-${u.state}`} aria-live="polite">
      <div className="gos-upd-top">
        {tickOn ? (
          // V1.51 (the developer: people did not realise the tick was the check button): always the reload symbol, spinning while it looks.
          <button type="button" className={`gos-upd-orb tk t-${tk.phase}${tickBusy ? " busy" : ""}`} aria-disabled={tickBusy}
            aria-label={tickBusy ? "Looking for updates" : "Check for updates"} title="Check for updates" onClick={tickGo}>
            <svg className="gos-i-ref" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <g><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></g>
            </svg>
          </button>
        ) : (
          <span className={`gos-upd-orb${busy ? " spin" : ""}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {u.state === "ready" ? <path d="M5 12.5l4.2 4.2L19 7" className="gos-draw" /> : u.state === "error" ? <path d="M12 7v6M12 17h.01" /> : <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />}
            </svg>
          </span>
        )}
        <div className="gos-upd-txt">
          <div className="gos-upd-t" key={u.state}>{title}</div>
          {tickOn ? <div className={`gos-upd-s fx${tk.phase === "fail" ? " soft" : ""}`} key={tk.phase === "spin" || tk.phase === "fail" ? tk.phase : "v"}>{sub}</div> : <div className="gos-upd-s">{sub}</div>}
        </div>
        {/* V1.51: the reload symbol, not the word "Check" (when up to date the orb on the left is that button). */}
        {(u.state === "idle" || u.state === "checking" || u.state === "error") && (
          <button type="button" className={`gos-btn ghost gos-upd-check${u.state === "checking" ? " on" : ""}`} disabled={u.state === "checking"}
            aria-label={u.state === "checking" ? "Looking for updates" : "Check for updates"} title="Check for updates"
            onClick={() => { haptic("press"); gos.checkUpdate(); }}>
            <svg className="gos-i-ref" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <g><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></g>
            </svg>
          </button>
        )}
      </div>
      {blocks.length > 1 && <NoteGroups blocks={blocks} />}
      {shape.notes.length > 0 && <ul className="gos-upd-notes">{shape.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {shape.wide && (
        <button type="button" className="gos-btn primary gos-upd-go" onClick={() => { haptic("press"); gosTick.reset(); void saveBeforeLeaving(window).then(() => gos.installUpdate()); }}>
          {u.state === "ready" ? "Install" : "Update now"}
        </button>
      )}
      {stepAt >= 0 && (
        <>
          <div className="gos-upd-bar"><i style={{ transform: `scaleX(${shown})` }} /></div>
          <ol className="gos-upd-steps">
            {STEPS.map((s, i) => <li key={s} className={i < stepAt ? "done" : i === stepAt ? "on" : ""}><span />{s}</li>)}
          </ol>
        </>
      )}
    </section>
  );
}
