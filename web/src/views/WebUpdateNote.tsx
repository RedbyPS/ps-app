// The website's "New version, Reload" note (cincee.com/client only; PS on the Mac and the phone have their
// own Update now). The page never reloads itself into a new build: it looks at version.json every few
// minutes and when the tab comes back, and only the developer's click on Reload loads the new build. When the live
// build needs a page this one cannot be (core/webupdate.ts WEB_COMPAT), a plain banner says why, and it
// still waits for the click.
import { useState, useSyncExternalStore } from "react";
import { sync } from "../core/vault";
import { PS } from "../ps";
import { onUpdateEvery, updateEvery } from "../updateevery";
import { updateChecksOff } from "../core/updateevery";
import { WEB_CHANNEL, WEB_COMPAT, lookDelay, lookOnReturn, webNote, type WebNote } from "../core/webupdate";
import "./webupdate.css";
import { lowPower } from "../core/lowpower.ts";
import { saveBeforeLeaving } from "../core/savenow";

// The website in a browser only: PS on the Mac and the phone get new pages through their own Update now.
const WEBSITE = !PS && import.meta.env.MODE !== "gos" && import.meta.env.MODE !== "ps";
const MINE = { src: WEBSITE && typeof __WEB_SRC__ === "string" ? __WEB_SRC__ : "", compat: WEB_COMPAT, built: typeof __WEB_BUILT__ === "string" ? __WEB_BUILT__ : "" };

// `failed`: the look could not get an answer (offline, a server error), which lengthens the wait (lookDelay).
async function look(): Promise<{ note: WebNote; failed: boolean }> {
  // The dev server only, for pictures: ?webnote=new or ?webnote=must shows the note with nothing live.
  if (import.meta.env.DEV && !PS) { const q = new URLSearchParams(location.search).get("webnote"); return { note: q === "new" || q === "must" ? { kind: q } : null, failed: false }; }
  if (!MINE.src) return { note: null, failed: false };   // PS and the phone
  try {
    // V1.57: the public PS repo on GitHub (a few bytes), never cincee.com, so the looks do not show cincee.com's
    // hosting who is still on the page (core/webupdate.ts WEB_CHANNEL). No cookies and no Referer go with it.
    // GitHub keeps it up to 5 minutes in its cache, which is fine for a note.
    const r = await fetch(WEB_CHANNEL, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15_000) });
    return r.ok ? { note: webNote(MINE, await r.json()), failed: false } : { note: null, failed: true };
  } catch { return { note: null, failed: true }; }
}

// One look shared by the note and the banner, running only while either is on screen.
// Every 5 minutes (V1.54), one look at a time (a slow one is never queued behind), and after failed looks the wait
// doubles, 5, 10, 20, 30 minutes (core/webupdate.ts lookDelay). A hidden tab does not look; coming back does.
let cur: WebNote = null, last = 0, fails = 0, running = false, timer: ReturnType<typeof setTimeout> | undefined, stopPace: (() => void) | undefined;
const subs = new Set<() => void>();
// "Check for updates every" Off (0): the page never looks by itself.
const off = () => updateChecksOff(updateEvery());
const wakeLook = () => arm();
function arm() { clearTimeout(timer); if (lowPower.asleep("updates")) { lowPower.onWake("updates", wakeLook); return; } if (subs.size && !off()) timer = setTimeout(go, lookDelay(fails, updateEvery())); }
// A new choice in Settings counts from the last look, so a shorter wait looks at once if it is already over, no restart.
function repace() {
  if (running || !subs.size) return;
  clearTimeout(timer);
  if (off()) return;
  timer = setTimeout(go, Math.max(0, lookDelay(fails, updateEvery()) - (last ? Date.now() - last : 0)));
}
async function go() {
  if (running || off()) return;
  if (lowPower.asleep("updates")) { lowPower.onWake("updates", wakeLook); return; }   // PS 1.65 Low power mode
  if (document.visibilityState === "hidden") { arm(); return; }
  running = true; last = Date.now();
  try {
    const { note, failed } = await look();
    fails = failed ? fails + 1 : 0;
    if (!failed && note?.kind !== cur?.kind) { cur = note; subs.forEach((f) => f()); }
  } finally { running = false; arm(); }
}
// Back on the tab after a while: look again once the wait since the last look is over.
function vis() { if (document.visibilityState === "visible" && !running && lookOnReturn(Date.now(), last, fails, updateEvery())) void go(); }
function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) { void go(); document.addEventListener("visibilitychange", vis); stopPace = onUpdateEvery(repace); }
  return () => {
    subs.delete(f);
    if (!subs.size) { clearTimeout(timer); document.removeEventListener("visibilitychange", vis); stopPace?.(); stopPace = undefined; }
  };
}
function useWebNote() { return useSyncExternalStore(subscribe, () => cur); }

/** Saves what is waiting (a few seconds at most), then loads the new build. Only ever from a click. */
async function reloadNow() {
  await saveBeforeLeaving(window);   // PS 1.74 (core/savenow.ts): the box being typed in and any waiting save first
  await Promise.race([sync().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  location.reload();
}

export function WebUpdateNote() {
  const note = useWebNote();
  const [busy, setBusy] = useState(false);
  if (!note) return null;
  const go = () => { if (busy) return; setBusy(true); void reloadNow(); };
  return (
    <button type="button" className={`pill wu-note${note.kind === "must" ? " must" : ""}`} onClick={go} disabled={busy}
      title={note.kind === "must" ? "This page is out of date and can no longer work with your vault. Click to load the new version." : "A new version is out. Click to load it. Nothing you saved is lost."}>
      {busy ? "Reloading" : note.kind === "must" ? "Update needed · Reload" : "New version · Reload"}
    </button>
  );
}

/** Only when this page cannot work with the server any more: says so in plain words, under the top bar. */
export function WebUpdateBanner() {
  const note = useWebNote();
  if (note?.kind !== "must") return null;
  return (
    <div className="banner wu-banner no-print" role="status">
      <span>This page is an older version of the vault and can no longer save safely. Reload to keep working; nothing you saved is lost.</span>
      <button type="button" className="btn" onClick={() => void reloadNow()}>Reload</button>
    </div>
  );
}
