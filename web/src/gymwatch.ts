// The gym reminder at work (core/gym.ts has the rules). Runs in the page that holds the vault.
//   Mac PS: ONE card ({type:"cardShow"}, id "gym") at 2 h, 1 h, 30 min and 10 min before, or in nag mode (V1.57)
//           every 15 minutes from the nag start; each step replaces the words and chimes once (a Mac that slept
//           shows one, never a pile). "Yes, I'm going" saves the day in the vault (settings.gymAck), so the phone
//           stops ringing and the day stays quiet; Later puts the card away for 5 minutes, then it comes back
//           with its chime (a new step brings it back at once). Quiet under PS Do Not Disturb. The steps
//           this Mac really showed are kept in localStorage (ids like "2026-11-03:60", no words), so after a
//           restart the card comes back quietly, and a step slept through is never shown late.
//   Phone:  the plan ({type:"gymPlan"}: times only) for the shell, which notifies and rings by itself while
//           PS sleeps (ps-gos Gym.kt): 10 minutes a ring, Later rings again in 5, through DND (an alarm).
//           The shell's Yes comes back as {type:"gymAck", day}.
//           V1.57: the plan also carries the alarms (Settings, Annoying 15 min reminder, Alarms; core/remind.ts
//           alarmRings), so the same ring rings for them; their Acknowledge comes back as {type:"remAct"} (remwatch).
import { vaultStore } from "./core/vault";
import { remindRec, settings, settingsData } from "./core/select";
import { saveSettings } from "./core/actions";
import { rewindNote } from "./rewind";   // Rewind (PS 1.64): reminders shown, Later and Yes, as behaviour notes for the recap
import { ackGym, gymReady, gymCard, gymCardText, gymDue, gymEnd, gymLater, gymNextWake, gymPlan, gymPrefs, gymQuiet, gymRingAt, gymSnoozed, pruneFired, YES_WORDS, type GymSnooze } from "./core/gym";
import { alarmRings } from "./core/remind";
import { duePlan } from "./duewatch";
import { DEVICE_TZ } from "./core/tz";
import { homeTz, setHomeTz } from "./core/tz";
import { dndMutes } from "./core/dnd";
import { lowPower } from "./core/lowpower.ts";

type Post = (m: object) => void;
const PHONE = import.meta.env.MODE === "gos";
const FIRED = "ps.gymFired", SNOOZE = "ps.gymSnooze";
let post: Post = () => {};
let shown = "";            // the card on screen now (its JSON), this run of the page
let shownDay = "";
let lastPlan = "";
let timer = 0;
let waiting: string[] = [];   // acknowledgements that came while the vault was still locked
const words = new Map<string, { title: string; sub: string }>();   // the card's words per step, fixed when first shown

const load = (k: string): string[] => { try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
const keep = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v.slice(-80))); } catch { /* storage off */ } };
const loadSnooze = (): GymSnooze | null => { try { const v = JSON.parse(localStorage.getItem(SNOOZE) || "null"); return v && typeof v.day === "string" && typeof v.until === "number" ? v : null; } catch { return null; } };
const keepSnooze = (v: GymSnooze | null) => { try { if (v) localStorage.setItem(SNOOZE, JSON.stringify(v)); else localStorage.removeItem(SNOOZE); } catch { /* storage off */ } };
// Every owner's since 7 Nov 2026 (its settings were always shown in Fitness); off until switched on for anyone but the developer.
const unlocked = () => { const s = vaultStore.get(); return s.status === "unlocked" && s.role === "owner"; };
const prefsOf = (st: { gym?: unknown }) => gymPrefs(st.gym, !!vaultStore.get().red);

/** Yes to that day's gym: on every device (the vault), from the Mac card or the phone. Never from the Task API. */
export function ackGymDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  if (!unlocked()) { if (!waiting.includes(day)) waiting.push(day); return; }
  const st = settingsData(vaultStore.get());
  if ((st.gymAck || []).includes(day)) return;
  void saveSettings({ gymAck: ackGym(st.gymAck, day, Date.now(), homeTz()) });
}

function hide() { if (shown) { post({ type: "cardHide", id: "gym" }); shown = ""; shownDay = ""; } }

function run() {
  if (lowPower.asleep("alarms")) { lowPower.onWake("alarms", run); return; }   // PS 1.65 Low power mode: the gym ring rings while Keep reminders ringing is on
  clearTimeout(timer);
  const s = vaultStore.get();
  if (!unlocked()) { if (!PHONE) hide(); return; }
  if (waiting.length) { const w = waiting; waiting = []; w.forEach(ackGymDay); }
  // 1.60: only ever from the SAVED gym settings. Before they have loaded the 08:00 default would go to the phone as a
  // plan and it would ring in the morning for a gym that is set for the night. The phone keeps the plan it has.
  if (!gymReady({ hasSettings: !!settings(s), syncing: s.syncing, lastSync: s.lastSync })) return;
  const st = settingsData(s);
  setHomeTz(st.tmHomeTz);
  const tz = homeTz(), now = Date.now(), p = prefsOf(st), acked = st.gymAck || [];
  if (PHONE) {
    // PS 1.73: the Priority 1 alarms ring with the same ring (duewatch.ts), one button: I acknowledge.
    const alarms = [...alarmRings(remindRec(s), now, DEVICE_TZ), ...duePlan(s, now).rings].sort((a, b) => a.at - b.at).slice(0, 40);
    const plan = { ...gymPlan(p, now, tz, acked), alarms };
    const json = JSON.stringify(plan);
    if (json !== lastPlan) { lastPlan = json; post({ type: "gymPlan", plan }); }
    timer = window.setTimeout(run, 5 * 60_000);   // the plan rolls on (8 days ahead), even with nothing changing; PS 1.73: a P1 that is
                                                  // made now rings in under a day, so the plan looks again every 5 minutes (sent only when it changed)
    return;
  }
  let fired = load(FIRED);
  const due = gymDue(p, now, tz, acked, fired);
  let chime = false, snooze = loadSnooze();
  if (due) { fired = pruneFired([...fired, due.id], now, tz); keep(FIRED, fired); chime = true; rewindNote("gymShown"); }
  const card = gymCard(p, now, tz, acked, fired);
  const step = card ? `${card.day}:${card.mins}` : "";
  // Later is over (or a new step came): the card is back, chiming once.
  if (snooze && (due || !card || !gymSnoozed(snooze, card.day, now))) { if (card && snooze.day === card.day) chime = true; snooze = null; keepSnooze(null); }
  if (!card || gymSnoozed(snooze, card.day, now) || gymQuiet("card", st.dnd, now)) hide();
  else {
    if (!words.has(step)) words.set(step, gymCardText(card, now, tz, p.time, p.end || p.nag ? gymEnd(p) : undefined));
    const w = words.get(step)!;
    const body = p.nag
      ? `Going to the gym today? ${YES_WORDS} here or on your phone stops these reminders and the ${gymRingAt(p)} ring. Later: back in 5 minutes.`
      : `${YES_WORDS} here or on your phone stops the ${gymRingAt(p)} ring. Later: back in 5 minutes.`;
    const c = { id: "gym", sticky: true, title: w.title, sub: w.sub, body,
      actions: [{ id: "ack", label: YES_WORDS }, { id: "later", label: "Later" }] };
    const json = JSON.stringify(c);
    if (json !== shown || chime) {
      shown = json; shownDay = card.day;
      post({ type: "cardShow", card: c });
      if (chime && !st.tmMuted && !dndMutes(st.dnd, "sounds", now, "mac")) post({ type: "sfx", name: "meet-soon", vol: Math.max(0.5, (st.tmSound ?? 40) / 100), card: true });   // card: the Mac card's chime is silent in private mode (V1.57); the phone's ring is not this
    }
  }
  const next = gymNextWake(p, now, tz, acked, fired, snooze);
  // At most a minute between looks: a Mac that slept wakes into a fresh check, never a pile of old timers.
  timer = window.setTimeout(run, next ? Math.max(500, Math.min(next - now + 250, 60_000)) : 60_000);
}

/** The card's buttons (Mac): Yes, I'm going ("ack"), Later. */
export function gymCardMessage(m: { type?: string; id?: string; action?: string }) {
  if (m.type !== "cardAction" || m.id !== "gym") return false;
  const day = shownDay;
  if (m.action === "ack" && day) { ackGymDay(day); hide(); rewindNote("gymYes"); }
  else if (m.action === "later") {
    const s = vaultStore.get(), st = settingsData(s), tz = homeTz();
    const c = gymCard(prefsOf(st), Date.now(), tz, st.gymAck || [], load(FIRED));
    if (c) { keepSnooze(gymLater(c.day, Date.now())); rewindNote("gymLater"); }
    hide();
    run();   // arms the look for when Later is over
  }
  return true;
}
/** The phone shell: Yes on the ring or a notification. */
export function gymShellMessage(m: { type?: unknown; day?: unknown }) {
  if (m.type !== "gymAck" || typeof m.day !== "string") return false;
  ackGymDay(m.day);
  rewindNote("gymYes");
  return true;
}

let started = false;
export function startGymWatch(p: Post) {
  if (started) return;
  started = true;
  post = p;
  let t = 0;
  vaultStore.subscribe(() => { clearTimeout(t); t = window.setTimeout(run, 400); });
  if (!PHONE) window.addEventListener("focus", () => run());
  run();
}
/** Woken (the Mac's "wake", a phone background check): look now. */
export function gymWake() { if (started) run(); }
