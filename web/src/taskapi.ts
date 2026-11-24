// The Task API, the part that runs (rules: core/taskapi.ts; the Mac's listener: ps-mac TaskApi.swift; Settings:
// views/TaskApi.tsx; the instructions for an AI: core/taskapidoc.ts).
//
// Main page only (the one that holds the vault keys). PS on the Mac sends each checked request as
// {type:"api:req", id, method, path, query, body, scopes}; this answers {type:"api:res", id, status, body}.
// Requests run one at a time, in the order they came, so two quick writes never start from the same old copy.
// The Tab list's Settings shows the key only when asked: PS sends {type:"api:key"} to that page alone (apiOverlayMessage).
import { useSyncExternalStore } from "react";
import { psPost } from "./ps";
import { pokeCardsAfterSave, vaultStore } from "./core/vault";
import { remindRec, settingsData, todos } from "./core/select";
import { addTodo, deleteTodo, saveRemind, saveSettings, setTodoDone, updateTodo } from "./core/actions";
import { clockStart, clockStop } from "./core/timesave";
import { workingIdsOf } from "./core/model";
import { isRedAccount } from "./core/account";
import { DEVICE_TZ } from "./core/tz";
import { newGroupId } from "./core/groups";
import { todayISO } from "./ui/kit";
import { landDayNow } from "./clients/clientsday";
import { crmStore } from "./core/crmstore";
import { handleApi, API_PORT, cleanScopes, type ApiStore } from "./core/taskapi";
import { aiConnect, aiGuide } from "./core/taskapidoc";
import { startSentryForApi } from "./views/Sentry";

const store: ApiStore = {
  crm: crmStore,
  state: () => { const s = vaultStore.get(); return s.status === "unlocked" && s.role === "owner" ? "ok" : "locked"; },
  todos: () => todos(vaultStore.get()),
  settings: () => settingsData(vaultStore.get()),
  remind: () => remindRec(vaultStore.get()),
  today: () => todayISO(),
  land: () => landDayNow(vaultStore.get()),   // Clients (PS 1.73): the day client tasks land on, as the Tab list and the island use it
  now: () => Date.now(),
  deviceTz: () => DEVICE_TZ,
  red: () => isRedAccount(vaultStore.get()),
  version: () => __PS_VERSION__.name,
  add: (t) => addTodo(t),
  update: (id, patch) => updateTodo(id, patch),
  setDone: (id, done) => setTodoDone(id, done),
  remove: (id) => deleteTodo(id),
  // V1.59: an AI message (aiMsgs) reaches the phone within seconds (core/vault.ts pokeCardsAfterSave)
  saveSettings: (p) => { if ("aiMsgs" in p) pokeCardsAfterSave(); return saveSettings(p); },
  saveRemind: (change) => saveRemind(change),
  newGroupId: () => newGroupId(),
  startSentry: () => startSentryForApi(),   // start only (views/Sentry.tsx): there is no stop
  setFocus: (ids) => setFocus(ids),
};

/** PUT /v1/focus (PS 1.74): these tasks, in order, are the ones being worked on, as clicks on them in the Tab list would make
 *  them (the island shows the first, core/timesave.ts clocks start for new ones and stop for the ones taken off). core/taskapi.ts
 *  always keeps the working tasks outside the AI's reach in `ids`, so their clocks are never touched (no clockStopAll). */
async function setFocus(ids: string[]): Promise<void> {
  const was = workingIdsOf(settingsData(vaultStore.get()));
  if (was.length === ids.length && was.every((x, i) => x === ids[i])) return;   // already so: nothing to save
  for (const x of was) if (!ids.includes(x)) void clockStop(x);
  for (const x of ids) if (!was.includes(x)) void clockStart(x);
  await saveSettings({ workingIds: ids, workingOn: ids[0] ?? null });
}

const ID = /^[a-z0-9]{8,40}$/;
let lane: Promise<unknown> = Promise.resolve();
/** From PS on the Mac (main page). True when the message was this one. */
export function apiMessage(m: { type?: string; [k: string]: unknown }): boolean {
  if (m.type !== "api:req") return false;
  const id = typeof m.id === "string" && ID.test(m.id) ? m.id : null;
  if (!id) return true;
  const query: Record<string, string> = {};
  if (m.query && typeof m.query === "object") for (const [k, v] of Object.entries(m.query as Record<string, unknown>).slice(0, 20)) if (typeof v === "string") query[k.slice(0, 40)] = v.slice(0, 400);
  const req = { method: String(m.method || ""), path: String(m.path || "").slice(0, 400), query, body: m.body };
  const run = async () => {
    const res = await handleApi(req, m.scopes, store);
    psPost({ type: "api:res", id, status: res.status, body: res.body });
  };
  const p = lane.then(run, run);
  lane = p.catch(() => psPost({ type: "api:res", id, status: 500, body: { error: { code: "internal", message: "PS could not answer." } } }));
  return true;
}

// ---------- the Tab list's Settings: the key, shown only for a short while when asked ----------
let shown: string | null = null;
let hideT: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const KEY = /^ps_[A-Za-z0-9]{20,80}$/;
/** In the Tab list page. True when the message was this one. */
export function apiOverlayMessage(m: { type?: string; key?: unknown }): boolean {
  if (m.type !== "api:key") return false;
  clearTimeout(hideT);
  shown = typeof m.key === "string" && KEY.test(m.key) ? m.key : null;
  subs.forEach((f) => f());
  if (shown) hideT = setTimeout(() => { shown = null; subs.forEach((f) => f()); }, 30_000);
  return true;
}
export function hideApiKey() { clearTimeout(hideT); shown = null; subs.forEach((f) => f()); }
export const useShownApiKey = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => shown);

/** Copy for AI, the one place that does it (Settings, AI task API and the "new in this version" pop-up both call this):
 *  asks PS on the Mac to put the instructions for an AI on the clipboard with the key filled in. The page never has the key.
 *  `api` is psSettings.taskApi as PS last sent it. */
export function copyAiGuide(api: { scopes?: Record<string, boolean>; port?: number }) {
  psPost({ type: "api:copyGuide", text: aiGuide({ scopes: cleanScopes(api.scopes), port: api.port || API_PORT, today: todayISO() }) });
}
/** Connect your AI (V1.58, views/AiMessage.tsx): the short rule that has an AI message the island at the end of every task.
 *  The same way as Copy for AI: PS on the Mac fills the key in as it copies. */
export function copyAiConnect(api: { port?: number }) {
  psPost({ type: "api:copyGuide", text: aiConnect({ port: api.port || API_PORT }) });
}
