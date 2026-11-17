// G Squad Priority 1 (PS 1.63, feature "squad-p1") on the page that holds the vault. The rules are in core/squadp1.ts; this only
// runs them and draws nothing itself:
//  - the 24 hour clock: every P1 you share gets its start time (Todo.p1At), and a task that left P1 loses it;
//  - the panel's data: while the panel is on, the hub's changes are read now and then even with the G Squad window closed (the
//    same small "changes since" read the window does, never more than one every 5 minutes without the window open);
//  - the cards: "<first name> did not complete their task" for other people's missed P1s, and your own gentle reminder two hours
//    before your own deadline. Cards go the normal PS way (Mac: the top right card stack and the island when Island notifications
//    is on; Android: the notification). PS never messages anyone: each person's own PS works their cards out from copies it holds.
import { docs, vaultStore } from "../core/vault";
import { updateTodo } from "../core/actions";
import { settingsData } from "../core/select";
import type { Doc, Todo } from "../core/model";
import { feature } from "../core/features";
import { cleanShareOpts } from "../core/squadshare";
import { dndMutes } from "../core/dnd";
import { cleanLedger, type Ledger } from "../core/maildedupe";
import { noteSound } from "../core/squadnotify";
import { P1_FEATURE, P1_GRACE_MS, alertCard, p1Clockable, p1On, p1PanelOn, p1Stamps, planMissedAlerts, planOwnReminders, cleanStart, type AlertCard, type P1Row } from "../core/squadp1";
import { sleepState } from "../sleepmode/engine";
import type { SquadRec } from "../core/squadrec";
import type { SquadView } from "./view";
import { lpClear, lpInterval } from "../core/lowpower.ts";   // PS 1.65 Low power mode: these timers stop while asleep

type Post = (m: object) => void;
const PS_PAGE = import.meta.env.MODE === "ps";
const LEDGER_STORE = "ps-gsquad-p1-announced", SINCE_STORE = "ps-gsquad-p1-since";
const TICK_MS = 60_000, QUIET_PULL_MS = 5 * 60_000;

let phonePost: Post | null = null;
/** The phone's page: where its notifications go (gos/bridge.ts hands its card poster, like the message cards). */
export function setP1Post(p: Post | null) { phonePost = p; }
const device = (): "mac" | "phone" | "web" => (PS_PAGE ? "mac" : phonePost ? "phone" : "web");

let memLedger: Ledger = {}, memSince: string | null = null;
// Read from storage each time, so two tabs of the website share one list; a blocked storage keeps this run's list in memory.
const readLedger = (): Ledger => { try { memLedger = cleanLedger(JSON.parse(localStorage.getItem(LEDGER_STORE) || "{}")); } catch { /* the memory copy */ } return memLedger; };
const writeLedger = (l: Ledger) => { memLedger = l; try { localStorage.setItem(LEDGER_STORE, JSON.stringify(l)); } catch { /* storage blocked */ } };
const getSince = (): string | null => { try { return localStorage.getItem(SINCE_STORE) || memSince; } catch { return memSince; } };
const setSince = (v: string | null) => { memSince = v; try { if (v) localStorage.setItem(SINCE_STORE, v); else localStorage.removeItem(SINCE_STORE); } catch { /* storage blocked */ } };

let sentryNow: () => boolean = () => false;
if (PS_PAGE) void import("../views/Sentry").then((m) => { sentryNow = m.sentryUp; }).catch(() => { /* no Sentry here */ });

export interface P1Hooks {
  post: Post | null;
  rec: () => SquadRec | null;
  view: () => SquadView;
  /** All the squad's P1 rows (not the panel's short list): missed alerts are planned from these. */
  p1All: () => P1Row[];
  onPulled: (f: () => void) => void;
  pull: () => void;
  push: () => void;
  isOpen: () => boolean;
}

export function startP1(h: P1Hooks) {
  let hadRec = false, working = false, again = false, lastPull = 0, lastTick = Date.now();
  const myTodos = (): Doc<Todo>[] => docs<Todo>("todo").filter((d) => d.ws === null);
  const owner = () => { const s = vaultStore.get(); return s.status === "unlocked" && s.role === "owner" && s.userId !== "ps-overlay" && s.userId !== "dev"; };
  const sharing = () => !!h.rec() && feature(P1_FEATURE) && p1On(cleanShareOpts(settingsData(vaultStore.get()).squadShare));

  /** The clock on your own tasks (core/squadp1.ts p1Stamps). Runs after every change of your tasks. */
  async function reconcile() {
    if (!owner()) return;
    if (working) { again = true; return; }
    working = true;
    try {
      // Opted out (switch off, feature off, or left the squad) takes every start off, so turning it on again starts a fresh 24 hours.
      const inSquad = !!h.rec();
      if (inSquad) hadRec = true;
      const wants = feature(P1_FEATURE) && p1On(cleanShareOpts(settingsData(vaultStore.get()).squadShare));
      const leftSquad = !inSquad && hadRec;
      if (leftSquad) hadRec = false;
      const stamps = p1Stamps(myTodos(), { active: wants && inSquad, opted: wants && (inSquad || !leftSquad), now: Date.now() });
      for (const x of stamps.slice(0, 60)) await updateTodo(x.id, { p1At: x.p1At });
    } catch { /* tried again at the next change */ }
    finally { working = false; if (again) { again = false; window.setTimeout(() => void reconcile(), 1500); } }
  }

  const held = (now: number) => {
    const st = settingsData(vaultStore.get());
    return dndMutes(st.dnd, "gsquad", now, device()) || sleepState().here || sentryNow();
  };
  const show = (cards: AlertCard[], own: boolean, now: number) => {
    if (!cards.length) return;
    const st = settingsData(vaultStore.get());
    const send = h.post && PS_PAGE ? h.post : phonePost;
    if (!send) return;   // the website has no card stack: the panel itself shows the row as Missed
    for (const c of cards) send({ type: "meetCard", card: alertCard(c, own) });
    if (PS_PAGE && h.post && noteSound(st, now, "mac")) h.post({ type: "sfx", name: "note-drop", vol: Math.max(0.3, (st.tmSound ?? 40) / 100), card: true });
  };

  /** Cards: other people's missed P1s, and your own reminder. Cheap; runs after every pull and every minute. */
  function alerts() {
    if (!owner() || !h.rec()) return;
    const now = Date.now();
    const st = settingsData(vaultStore.get());
    const notify = st.squadNotify !== false && st.tmNotify !== false;
    const seeing = notify && p1PanelOn(feature(P1_FEATURE), st);
    if (!seeing) { if (getSince()) setSince(null); }
    else if (!getSince()) setSince(new Date(now).toISOString());   // nothing from before this moment alerts: an update never fires old deadlines at once
    const start = readLedger();
    let ledger = start;
    const quiet = held(now);
    if (seeing) {
      const v = h.view();
      const plan = planMissedAlerts(h.p1All(), { me: v.me, names: new Map(v.members.map((m) => [m.id, m.name])), now, since: getSince(), ledger, held: quiet });
      ledger = plan.ledger;
      show(plan.show, false, now);
    }
    if (notify && sharing()) {
      const mine = planOwnReminders(myTodos(), { shared: true, now, ledger, held: quiet });
      ledger = mine.ledger;
      show(mine.show, true, now);
    }
    if (ledger !== start) writeLedger(ledger);
  }

  /** The window is closed but the panel is on: read the hub's changes now and then (the same small read the window does). */
  function quietPull(now: number) {
    if (!h.rec() || h.isOpen() || !navigator.onLine) return;
    if (!p1PanelOn(feature(P1_FEATURE), settingsData(vaultStore.get()))) return;
    if (document.visibilityState === "hidden" && !PS_PAGE) return;
    if (now - lastPull < QUIET_PULL_MS) return;
    lastPull = now;
    h.pull();
  }

  /** A P1 that just went past its grace time is sealed now (the plan only sends what changed). */
  function graceCrossed(from: number, to: number): boolean {
    for (const d of myTodos()) {
      if (!p1Clockable(d.data) || d.data.done) continue;
      const s = cleanStart(d.data.p1At, to);
      if (!s) continue;
      const at = Date.parse(s) + P1_GRACE_MS;
      if (at > from && at <= to) return true;
    }
    return false;
  }

  let timer: number | undefined;
  vaultStore.subscribe(() => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => { timer = undefined; void reconcile(); }, 1200); });
  h.onPulled(() => { lastPull = Date.now(); alerts(); });
  lpInterval("squad-p1", () => {
    const now = Date.now();
    if (graceCrossed(lastTick, now) && sharing()) h.push();
    lastTick = now;
    quietPull(now);
    alerts();
  }, TICK_MS);
  window.setTimeout(() => { void reconcile(); quietPull(Date.now()); }, 8_000);
}
