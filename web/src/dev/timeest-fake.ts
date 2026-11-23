// The dev server only (/dev?est): fictional time estimates for trying the screens (core/timeest.ts). Estimates on the made up tasks,
// past times for a few names, one clock running, two overlapping meetings today and working hours around now, so the overload
// line shows. Never real data.
import type { Doc } from "../core/model";
import { addDone, emptyLive, startClock, teRecId, monthOf, type TMonth } from "../core/timeest";

const hm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function withEst(docs: Doc[]): Doc[] {
  const now = Date.now(), H = 3_600_000, tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const est: Record<string, number> = {
    "Invoice Petal and Pine for the October CRO retainer": 45,
    "Renew the domain": 15,
    "Draft the Halden follow up": 120,
    "Update the case study page with the new numbers": 90,
    "Send Annabelle the revised homepage hero options with the lookbook photography and the studio shots side by side": 120,
    "Follow-ups": 60,
  };
  let running = "";
  for (const d of docs) {
    if (d.kind !== "todo") continue;
    const t = d.data as { title: string; done?: boolean; est?: number; estBy?: string };
    if (est[t.title] && !t.done) t.est = est[t.title];
    if (t.title === "Update the case study page with the new numbers") running = d.id;
  }
  const st = docs.find((d) => d.kind === "settings");
  if (st) st.data = { ...(st.data as object), timeEst: { from: hm(now - 2 * H), to: hm(now + 5 * H) } };
  // A task added a moment ago with a name used before: "Usually takes about 40 min".
  docs.push({ id: "dev-te-new", kind: "todo", ws: null, author: "dev", updatedAt: new Date().toISOString(), data: { title: "Write the weekly report", type: "once", done: false, order: 9, createdAt: new Date(now - 10_000).toISOString(), source: "manual", est: 40, estBy: "past" } } as unknown as Doc);
  let mo: TMonth | null = null;
  const month = monthOf(now, tz);
  // PS 1.77 learning: seven finishes, one a 1 minute tick and one a 5 hour day (both left out), five clean ones: learned 40 min.
  for (const [i, m] of [35, 50, 1, 40, 300, 45, 38].entries()) mo = addDone(mo, month, `dev-te-old${i}`, { n: "Write the weekly report", m, e: 30, at: now - (i + 1) * 2 * 24 * H });
  mo = addDone(mo, month, "dev-te-x", { n: "Update the case study page with the new numbers", m: 80, e: 90, at: now - 30 * 24 * H });
  docs.push({ id: teRecId("dev", month), kind: "ttime", ws: null, author: "dev", updatedAt: new Date().toISOString(), data: mo } as unknown as Doc);
  if (running) docs.push({ id: teRecId("dev", "live"), kind: "ttime", ws: null, author: "dev", updatedAt: new Date().toISOString(), data: startClock(emptyLive(), running, "Update the case study page with the new numbers", now - 25 * 60_000) } as unknown as Doc);
  const iso = (t: number) => new Date(t).toISOString();
  docs.push({ id: "dev-te-cal", kind: "calendar", ws: null, author: "dev", updatedAt: new Date().toISOString(), data: { account: "dev@example.com", at: iso(now), from: iso(now - 24 * H), to: iso(now + 24 * H), events: [
    { id: "dev-te-m1", title: "Design review", start: iso(now + 1 * H), end: iso(now + 2 * H), allDay: false, attendees: [] },
    { id: "dev-te-m2", title: "Client call", start: iso(now + 1.5 * H), end: iso(now + 2.5 * H), allDay: false, attendees: [] },
  ] } } as unknown as Doc);
  return docs;
}
