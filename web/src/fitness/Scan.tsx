// PS Fitness, Gym scan (V1.59, the developer: "in a workout, a Scan button opens the camera. Point it at a machine or its
// label. PS reads the text on the phone, translates it to English if it is German, and matches it to an exercise...
// a big green tick Yes. On Yes it logs that exercise... and plays a little animation of how to use it").
// The camera is the page's own (getUserMedia, as the Mac code scanner in src/mobile/Scan.tsx); one still, cropped to
// the frame, goes to the phone's reader (src/gos/gymscan.ts, ps-gos GymScan.kt) and is dropped once read. Nothing is
// saved or sent. The matching is pure and tested (scan-logic.ts). Where the phone's reader is missing, or the camera
// is off, the developer can type what the label says instead.
import { feature } from "../core/features";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { appName } from "../core/appname";
import { GOS, gos, haptic } from "../gos/bridge";
import { CAMERA_BUTTON, cameraOffText } from "../core/camerahelp";
import { gymScan } from "../gos/gymscan";
import { prefillSets, setsFor, type FitPrefs, type FitProgram, type FitSet, type FitWorkout } from "../core/fitness";
import { LIB, libById, planFromLib, type LibEx } from "./lib";
import { PicArt } from "./ExPic";
import { picFor } from "./pics";
import { MUSCLE_LABEL } from "./library";
import { yourExercises } from "./gym-logic";
import { fold, matchScan, type ScanHit, type ScanResult } from "./scan-logic";
import { scanSay } from "./scan-state";
import { Overlay } from "./Overlay";
import { fitnessNow } from "./store";
import type { exAdd } from "./store";
import "./scan.css";

type Dated = { id: string; data: FitWorkout };
export type NewEx = Parameters<typeof exAdd>[1] & { sets: FitSet[] };
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** An exercise ready for the workout: from the library, one of the developer's own names, or a name as written. The weights
 *  come from last time; how many sets from the developer's own number, else his default (as Add an exercise does). */
export function newExFor(x: LibEx | null, own: { name: string; exId: string | null } | null, typed: string, workouts: Dated[], prefs: FitPrefs): NewEx {
  const now = new Date().toISOString();
  const link = own?.exId ? libById(own.exId) : null;
  const nm = own?.name ?? x?.name ?? typed;
  const lx = x ?? link;
  const plan = { exId: lx?.id ?? null, name: nm, sets: own ? [] : [0, 1, 2].map(() => ({ reps: 10, kg: null })) };
  return {
    exId: lx?.id ?? null, name: nm, kind: lx?.kind, perSide: lx?.perSide ?? false, step: lx?.step ?? null,
    target: [], rir: null, rest: null, sets: prefillSets(x ? planFromLib(x) : plan, workouts, now, null, setsFor({ exId: lx?.id ?? null, name: nm }, 0, prefs)),
  };
}

/** Gym scan is on (the feature "gym-scan-better" and Fitness settings, both default on) and this device can read a label (the phone app). */
export const scanOn = (prefs: FitPrefs) => feature("gym-scan-better") && prefs.scan !== false && gymScan.available();

/** A search box for exercises with a clear Scan button inside it (V1.60). Tap Scan, point the phone at the machine's label, and
 *  the exercise's name lands in the search. Anywhere an exercise is searched. Without a label reader (the Mac, the website) or
 *  with Scan off in Fitness settings, it is the plain search box. */
export function ScanSearch({ value, onChange, className, placeholder, label, autoFocus, prefs }: {
  value: string; onChange: (v: string) => void; className: string; placeholder?: string; label: string; autoFocus?: boolean; prefs?: FitPrefs;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const show = scanOn(prefs ?? fitnessNow().prefs);
  const input = <input className={cx(className, show && "sc-in-box")} type="search" value={value} autoFocus={autoFocus} enterKeyHint="search"
    placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.currentTarget.value)} />;
  if (!show) return input;
  const v = open ? fitnessNow() : null;
  const root = open ? (host.current?.closest(".fit-phone, .fit-desk, .fit") as HTMLElement | null) ?? document.body : null;
  return (
    <div className="sc-field" ref={host}>
      {input}
      <button type="button" className="sc-field-go" onClick={() => { haptic("press"); setOpen(true); }} aria-label="Scan a machine">
        <CamIcon size={20} /><span>Scan</span>
      </button>
      {v && root && createPortal(
        <div className="fg fg-scanhost">
          <Overlay label="Scan a machine" kind="tall" onClose={() => setOpen(false)}>
            {(close) => <ScanPanel workouts={v.workouts} programs={v.programs} prefs={v.prefs} close={close} onPick={(name) => onChange(name)} />}
          </Overlay>
        </div>, root)}
    </div>
  );
}

const ASKED = "ps.fit.scanAsked";
const asked = () => { try { return localStorage.getItem(ASKED) === "1"; } catch { return false; } };
const markAsked = () => { try { localStorage.setItem(ASKED, "1"); } catch { /* storage off: asked again next time */ } };
const LIB_NAMES: ReadonlySet<string> = new Set(LIB.map((x) => x.name.toLowerCase()));

type Phase = "ask" | "cam" | "reading" | "result" | "type" | "done";
const FROM: Record<ScanHit["from"], string> = { plan: "In your plan", yours: "Yours", library: "From the exercise list" };

/** `onAdd` puts the exercise in the workout (the gym). `onPick` is for a search box instead (V1.60): the exercise's name goes into
 *  the search, nothing is added. */
export function ScanPanel({ workouts, programs, prefs, close, onAdd, onPick }: { workouts: Dated[]; programs: { id: string; data: FitProgram }[]; prefs: FitPrefs; close: () => void; onAdd?: (ex: NewEx) => void; onPick?: (name: string) => void }) {
  const camOk = gymScan.available();
  const [phase, setPhase] = useState<Phase>(() => (!camOk ? "type" : asked() ? "cam" : "ask"));
  const [still, setStill] = useState<string | null>(null);
  const [res, setRes] = useState<ScanResult | null>(null);
  const [pick, setPick] = useState<ScanHit | null>(null);
  const [say, setSay] = useState("");
  const [added, setAdded] = useState<ScanHit | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; if (camOk) gymScan.warm(); return () => { live.current = false; scanSay("idle"); }; }, [camOk]);

  // The developer's own exercises: his typed names and his plans' names (linked to the library where they are), and the library
  // exercises in his active plan.
  const active = programs.find((p) => p.id === prefs.programId) ?? null;
  const own = useMemo(() => yourExercises(workouts, programs, "", LIB_NAMES, 400).map((x) => ({ name: x.name, exId: x.exId, inPlan: x.inPlan })), [workouts, programs]);
  const planIds = useMemo(() => new Set((active?.data.days ?? []).flatMap((d) => d.exercises.map((e) => e.exId).filter((x): x is string => !!x))), [active]);

  const judge = (text: string) => {
    const r = matchScan(text, { own, planIds });
    setRes(r); setPick(r.best); setStill(null);
    scanSay(r.best ? "found" : "notfound", { hit: r.best ? { name: r.best.name, exId: r.best.exId } : null, text: r.text });
    haptic(r.best ? "drop" : "reject");
    setPhase("result");
  };
  const read = async (img: string) => {
    setStill(img); setSay(""); setPhase("reading");
    scanSay("scanning");
    const a = await gymScan.read(img);
    if (!live.current) return;
    if ("error" in a) {
      scanSay("idle");
      setStill(null);
      setSay(a.error === "model" ? "The label reader could not start. Type what it says instead." : a.error === "timeout" ? "That took too long. Try again, a little closer." : "That did not work. Try again.");
      setPhase(a.error === "model" ? "type" : "cam");
      return;
    }
    if (!/\p{L}{2}/u.test(a.text)) { scanSay("notfound", { hit: null, text: "" }); setStill(null); setSay("No words found. Get a little closer, hold still, and try again."); setPhase("cam"); haptic("reject"); return; }
    judge(a.text);
  };
  const again = () => { haptic("press"); scanSay("idle"); setRes(null); setPick(null); setSay(""); setPhase(camOk ? "cam" : "type"); };
  const yes = (h: ScanHit) => {
    haptic("drop");
    if (onPick || !onAdd) { onPick?.(h.name); close(); return; }
    const x = h.from === "library" && h.exId ? libById(h.exId) : null;
    onAdd(newExFor(x, x ? null : { name: h.name, exId: h.exId }, h.name, workouts, prefs));
    scanSay("added", { hit: { name: h.name, exId: h.exId }, text: res?.text });
    if (!picFor(h.exId, h.name)) { close(); return; }
    setAdded(h); setPhase("done");
  };
  const asWritten = () => {
    if (!res) return;
    haptic("press");
    if (onPick || !onAdd) { onPick?.(oneLine(res.text)); close(); return; }
    onAdd(newExFor(null, null, oneLine(res.text), workouts, prefs));
    scanSay("added", { hit: { name: oneLine(res.text), exId: null }, text: res.text });
    close();
  };

  return (
    <div className={cx("sc", `sc-${phase}`)}>
      {phase === "ask" && (
        <div className="sc-ask sc-in">
          <span className="sc-ask-ic" aria-hidden="true"><CamIcon size={40} /></span>
          <h3 className="fg-h3">Scan a machine</h3>
          <p className="sc-p">Point the camera at a machine's label. {appWord()} reads the words, puts German into English, and finds the exercise in your list.</p>
          <p className="sc-p sc-p-small">{appWord()} needs the camera for this. The picture is read on this phone and thrown away: it is never saved and never sent anywhere.</p>
          <button type="button" className="sc-big" onClick={() => { haptic("press"); markAsked(); setPhase("cam"); }}>Turn on the camera</button>
          <button type="button" className="fg-second" onClick={() => { markAsked(); setPhase("type"); }}>Type it instead</button>
          <button type="button" className="fg-second" onClick={close}>Not now</button>
        </div>
      )}

      {(phase === "cam" || phase === "reading") && (
        <Camera still={still} reading={phase === "reading"} say={say} onShot={(img) => void read(img)}
          onType={() => { setStill(null); setPhase("type"); }} onCancel={close} />
      )}

      {phase === "type" && <Typed say={say} onRead={(t) => { haptic("press"); judge(t); }} onCam={camOk ? () => { setSay(""); setPhase("cam"); } : null} onCancel={close} />}

      {phase === "result" && res && (
        <div className="sc-res sc-in">
          <p className="sc-k">It says</p>
          <p className="sc-said">{res.text || "Nothing readable"}</p>
          {res.english && fold(res.english).replace(/\s+/g, " ") !== fold(oneLine(res.text)) && (
            <>
              <p className="sc-k">In English</p>
              <p className="sc-en">{res.english}</p>
            </>
          )}
          {res.brand && <p className="sc-brand">Made by {res.brand}</p>}
          {pick ? (
            <>
              <div className="sc-hit" key={pick.name}>
                <span className="sc-hit-pic"><PicArt pic={picFor(pick.exId, pick.name)} mode="still" /></span>
                <span className="sc-hit-t">
                  <small>Is it this one?</small>
                  <b>{pick.name}</b>
                  <small>{FROM[pick.from]}</small>
                </span>
              </div>
              <button type="button" className="sc-yes" onClick={() => yes(pick)} aria-label={`Yes, ${pick.name}`}>
                <TickIcon size={34} /><span>Yes</span>
              </button>
              {[res.best, ...res.others].filter((h): h is ScanHit => !!h && h.name !== pick.name).length > 0 && (
                <div className="sc-others">
                  <p className="sc-k">Not this one? Maybe</p>
                  <div className="sc-chips">
                    {[res.best, ...res.others].filter((h): h is ScanHit => !!h && h.name !== pick.name).map((h) => (
                      <button key={h.name} type="button" onClick={() => { haptic("tick"); setPick(h); }}>{h.name}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="sc-row">
                <button type="button" className="fg-second" onClick={asWritten}>{onPick ? "Search as written" : "Add as written"}</button>
                <button type="button" className="fg-second" onClick={again}>Try again</button>
              </div>
            </>
          ) : (
            <>
              <p className="sc-none">Nothing in your list matches this.</p>
              <div className="sc-row">
                <button type="button" className="sc-big" onClick={asWritten} disabled={!res.text}>{onPick ? "Search as written" : "Add as written"}</button>
                <button type="button" className="fg-second" onClick={again}>Try again</button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === "done" && added && <HowTo hit={added} onClose={close} />}
    </div>
  );
}

const oneLine = (t: string) => t.replace(/\s*\n\s*/g, " ").trim().slice(0, 60);
const appWord = () => appName();

// ---------- the camera ----------
function Camera({ still, reading, say, onShot, onType, onCancel }: { still: string | null; reading: boolean; say: string; onShot: (img: string) => void; onType: () => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLSpanElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const [state, setState] = useState<"starting" | "on" | "denied" | "nocamera">("starting");
  const [torch, setTorch] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true, stream: MediaStream | null = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setState("nocamera"); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      } catch (e) {
        if (live) setState((e as DOMException)?.name === "NotFoundError" ? "nocamera" : "denied");
        return;
      }
      if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current!;
      v.srcObject = stream;
      track.current = stream.getVideoTracks()[0] ?? null;
      try { await v.play(); } catch { /* plays once the first frame is in */ }
      const caps = (track.current?.getCapabilities?.() ?? {}) as { torch?: boolean };
      if (caps.torch) setTorch(false);
      setState("on");
    })();
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); track.current = null; const v = video.current; if (v) v.srcObject = null; };
  }, []);

  const shoot = () => {
    const v = video.current, f = frame.current;
    if (!v || !f || state !== "on" || reading) return;
    const img = grab(v, f);
    if (!img) return;
    haptic("press");
    onShot(img);
  };
  const flip = async () => {
    const t = track.current;
    if (!t || torch == null) return;
    haptic("tick");
    try { await t.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); } catch { setTorch(null); }
  };
  const bad = state === "denied" || state === "nocamera";
  const msg = state === "denied" ? cameraOffText(appName(), "Or type what the label says.")
    : state === "nocamera" ? "No camera found. Type what the label says instead."
    : reading ? "Reading the label..." : say || (state === "starting" ? "Opening the camera..." : "Fit the machine's name inside the frame, then tap Read.");
  return (
    <div className="sc-cam sc-in">
      <div className={cx("sc-view", reading && "reading")} onClick={shoot}>
        <video ref={video} playsInline muted autoPlay aria-hidden="true" />
        {still && <img className="sc-still" src={still} alt="" aria-hidden="true" />}
        <span ref={frame} className="sc-frame" aria-hidden="true"><i /><i /><i /><i /><b /></span>
        {torch != null && (
          <button type="button" className={cx("sc-torch", torch && "on")} onClick={(e) => { e.stopPropagation(); void flip(); }} aria-pressed={torch} aria-label="Torch">
            <TorchIcon />
          </button>
        )}
      </div>
      <p className={cx("sc-say", (bad || (!!say && !reading)) && "bad")} role="status" aria-live="polite" key={msg}>{msg}</p>
      {state === "denied" && GOS && <button type="button" className="fg-second sc-open" onClick={() => { haptic("press"); gos.openAppSettings(); }}>{CAMERA_BUTTON}</button>}
      <div className="sc-foot">
        <button type="button" className="fg-second sc-side" onClick={onCancel}>Cancel</button>
        <button type="button" className={cx("sc-shoot", reading && "busy")} onClick={shoot} disabled={state !== "on" || reading} aria-label="Read the label">
          {reading ? <span className="sc-spin" aria-hidden="true" /> : <CamIcon size={30} />}
          <span>{reading ? "Reading" : "Read"}</span>
        </button>
        <button type="button" className="fg-second sc-side" onClick={onType}>Type it</button>
      </div>
    </div>
  );
}

/** One still of what is inside the frame, grey with its contrast stretched (the reader likes that), as a JPEG data
 *  URL. Held in memory only. The video is drawn "cover", so the frame's box is mapped back into the video's pixels. */
function grab(v: HTMLVideoElement, f: HTMLElement): string | null {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
  const s = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * s) / 2, oy = (vr.height - vh * s) / 2;
  const pad = 0.06;
  let sx = (fr.left - vr.left - ox) / s, sy = (fr.top - vr.top - oy) / s, sw = fr.width / s, sh = fr.height / s;
  sx -= sw * pad; sy -= sh * pad; sw *= 1 + 2 * pad; sh *= 1 + 2 * pad;
  sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  if (sw < 20 || sh < 20) return null;
  const k = Math.max(0.5, Math.min(2, 1400 / sw));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = y; hist[y]++; }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.02) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.02) break; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const y = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span)); d[i] = d[i + 1] = d[i + 2] = y; }
  ctx.putImageData(img, 0, 0);
  const out = c.toDataURL("image/jpeg", 0.92);
  c.width = c.height = 0;
  return out;
}

// ---------- typing it ----------
function Typed({ say, onRead, onCam, onCancel }: { say: string; onRead: (t: string) => void; onCam: (() => void) | null; onCancel: () => void }) {
  const [t, setT] = useState("");
  return (
    <form className="sc-type sc-in" onSubmit={(e) => { e.preventDefault(); if (t.trim()) onRead(t); }}>
      <h3 className="fg-h3">What does the label say?</h3>
      {say && <p className="sc-say bad">{say}</p>}
      <p className="sc-p">German is fine: Beinpresse, Latzug, Brustpresse.</p>
      <input className="fg-search" type="text" value={t} autoFocus enterKeyHint="search" placeholder="Beinpresse" aria-label="What the label says"
        onChange={(e) => setT(e.currentTarget.value)} />
      <button type="submit" className="sc-big" disabled={!t.trim()}>Find it</button>
      {onCam && <button type="button" className="fg-second" onClick={onCam}>Use the camera</button>}
      <button type="button" className="fg-second" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ---------- after Yes: how to use it ----------
function HowTo({ hit, onClose }: { hit: ScanHit; onClose: () => void }) {
  const pic = useMemo(() => picFor(hit.exId, hit.name), [hit]);
  const x = pic?.exercise;
  const muscles = x ? x.muscles.map((m) => MUSCLE_LABEL[m]).join(", ") : "";
  return (
    <div className="sc-done sc-in">
      <span className="sc-done-tick" aria-hidden="true"><TickIcon size={30} /></span>
      <p className="sc-done-k">Added to this workout</p>
      <h3 className="fg-h3">{hit.name}</h3>
      <div className="sc-done-art"><PicArt pic={pic} mode="play" title={`${hit.name} being done`} /></div>
      {muscles && <p className="sc-done-mus">Works: {muscles}</p>}
      {x?.cue && <p className="sc-done-cue">{x.cue}</p>}
      <button type="button" className="sc-big" onClick={() => { haptic("press"); onClose(); }}>Start my sets</button>
    </div>
  );
}

// ---------- icons ----------
function Svg({ size = 24, children, w = 2.4 }: { size?: number; children: ReactNode; w?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
export const CamIcon = ({ size = 22 }: { size?: number }) => <Svg size={size} w={2.2}><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.4" /></Svg>;
const TickIcon = ({ size = 28 }: { size?: number }) => <Svg size={size} w={3}><path d="M4.5 12.5l5 5L19.5 7" /></Svg>;
const TorchIcon = () => <Svg size={22} w={2.2}><path d="M8 3h8l-1.5 5h-5zM9.5 8h5l-1 13h-3z" /><path d="M12 12v2.5" /></Svg>;
