// Your other Mac is about to restart by its auto reboot (V1.28, the developer: a warning before a restart, and a way
// to postpone it). Main window of the MAIN Mac only (only it can sign Postpone, protocol section 13):
// every 30 s and on every vault change it reads the other Mac's last status (its stat record) and, from 10
// minutes before its auto reboot is due, shows a card with Postpone 1 hour. The card goes when the time
// moves (a Postpone, an unlock there), when the restart has happened, or when the developer clicks OK; each restart
// time gets one card. Watch only never restarts, so it gets none. Postpone is offered only while the other
// Mac is online and its helper takes it (an asleep Mac restarts the moment its wake comes).
import { vaultStore } from "./core/vault";
import { rebootWarnCard } from "./core/rebootwarn";
import { runSecondOp, secondLocal } from "./second/store";
import { secondView } from "./second/view";

type Post = (m: object) => void;
let post: Post = () => {};
let shown: { id: string; json: string } | null = null;
const done = new Set<string>();   // restart times the developer already answered (OK or Postpone)

function sync() {
  const s = vaultStore.get();
  if (s.status !== "unlocked" || s.role !== "owner") { hide(); return; }
  const card = rebootWarnCard(secondView([...s.docs.values()], secondLocal()), Date.now());
  if (!card || done.has(card.id)) { hide(); return; }
  const json = JSON.stringify(card);
  if (shown?.json === json) return;
  if (shown && shown.id !== card.id) post({ type: "cardHide", id: shown.id });
  shown = { id: card.id, json };
  post({ type: "cardShow", card });
}
function hide() { if (shown) { post({ type: "cardHide", id: shown.id }); shown = null; } }

/** The card's buttons (cardAction "rw:..."): Postpone signs the command for the other Mac (store.ts). */
export function rebootWarnMessage(m: { type?: string; id?: string; action?: string }) {
  if (m.type !== "cardAction" || typeof m.id !== "string" || !m.id.startsWith("rw:")) return false;
  done.add(m.id);
  if (m.action === "postpone") runSecondOp({ op: "cmd", action: "postpone" });
  hide();
  return true;
}

let started = false;
export function startRebootWarn(p: Post) {
  if (started) return;
  started = true;
  post = p;
  vaultStore.subscribe(sync);
  window.setInterval(sync, 30_000);
  sync();
}
