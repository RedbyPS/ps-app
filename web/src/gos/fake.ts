// Emulator tests only (scripts/build-web.sh --fake): the same fictional data as the dev page, so no
// real client, task or email is ever on a test screen. Never in a release build (release.sh checks).
// One fictional task has no priority yet, to show how such a task looks (no P number, at the bottom).
// Two fictional Claude chats have just finished, to show their notifications (core/chatdone.ts).
import { __devLoad } from "../core/vault";
import { fakeDocs } from "../dev/fake";
import type { Doc, Settings, Todo } from "../core/model";

export const GOS_FAKE_MARKER = "gos-fictional-test-data";
export function loadFake() {
  const docs = fakeDocs();
  const open = docs.filter((d): d is Doc<Todo> => d.kind === "todo" && (d.data as Todo).type === "once" && !(d.data as Todo).done && !(d.data as Todo).p1);
  const last = open.sort((a, b) => (b.data.order ?? 0) - (a.data.order ?? 0))[0];
  if (last) last.data = { ...last.data, unranked: true };
  const st = docs.find((d): d is Doc<Settings> => d.kind === "settings");
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  if (st) st.data = { ...st.data, chatDone: [
    { id: "fake-chat-1", chat: "Fictional chat: rebuild the pricing page", at: ago(1) },
    { id: "fake-chat-2", chat: "Fictional chat: draft the Lumi follow up", at: ago(4) },
  ] };
  // ?work=<style>: the first open task is the one being worked on, in that Working on look (pictures only)
  const w = typeof location !== "undefined" ? new URLSearchParams(location.search).get("work") : null;
  if (w && st && open.length) st.data = { ...st.data, workingIds: [open[open.length - 1].id], tmWorkStyle: w };
  // ?rem: a fictional Annoying 15 min reminder showing now that needs its word typed (PS 1.72, the island's card), with the
  // first open task being worked on, so the island shows the task, the reminder comes out of it and a tap opens the card.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("rem")) {
    const rd = docs.find((d) => d.kind === "remind");
    const hm = (ms: number) => { const x = new Date(ms); return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
    const now = Date.now();
    const one = { id: "devrem2", on: true, label: "", text: "Drink a glass of water", at: hm(now - 30 * 60_000), until: hm(now + 3 * 3600_000), days: [0, 1, 2, 3, 4, 5, 6], tz: "",
      snooze: 15, later: "", yes: "Done", word: "", click: false, bg: "#2a1608", accent: "#f59e0b", sound: "none", vol: 0.8, edited: 1 };
    if (rd) rd.data = { ...(rd.data as object), list: [one, ...((rd.data as { list: unknown[] }).list)] } as typeof rd.data;
    if (st && open.length && !w) st.data = { ...st.data, workingIds: [open[open.length - 1].id] };
    // &nomeet: the fictional meeting stays off the island, so the task shows there by itself.
    if (st && new URLSearchParams(location.search).has("nomeet")) st.data = { ...st.data, meetBubble: { on: false } } as typeof st.data;
  }
  __devLoad(docs);
}
