// DEV ONLY (/dev-clients): the Clients workspace (PS 1.73) with FICTIONAL clients, the same made up names as the approved demo
// (Halden & Rye, Solberg Skin, Kettle Moon Teas, Northpine Outdoor). Never imported in production builds.
// ?cal=0: Google Calendar not linked (no Next call line at all).
import type { CalendarSnap, ClientRec, Doc, Kind, Project, ProjectPrivate, Todo } from "../core/model";
import { newProject } from "../core/model";
import { layStages, repeatPatch, type ProjectTpl } from "../core/clientwork";
import { addDays, todayISO } from "../ui/kit";

export function clientsFakeDocs(cal = true): Doc[] {
  let n = 0;
  const id = () => `cw-${++n}`;
  const out: Doc[] = [];
  const t = todayISO(), d = (k: number) => addDays(t, k);
  const push = (kind: Kind, ws: string | null, data: unknown, did = id()) => { out.push({ id: did, ws, kind, author: "dev", updatedAt: new Date().toISOString(), data }); return did; };
  const key = () => `s${++n}`;
  out.push({ id: "settings", ws: null, kind: "settings", author: "dev", updatedAt: new Date().toISOString(),
    data: { ownerName: "Sam", countdown: { mode: "daily", at: "12:00" }, dayEndsHour: 15 } });
  const client = (name: string, contact: string, email: string, order: number, colour?: string) => {
    const ws = `ws-${order}`;
    const cid = push("client", null, { name, ws, contactName: contact, email, status: "client", order, createdAt: d(-40), ...(colour ? { colour } : {}) } satisfies Partial<ClientRec>);
    return { cid, ws };
  };
  const project = (ws: string, title: string, stages: { name: string; days: number }[], from: number, current: number, extra: Partial<Project> = {}, priv: Partial<ProjectPrivate> = {}) => {
    const st = layStages(stages, d(from), key).map((s, i) => ({ ...s, doneAt: i < current ? d(from + 1) : null }));
    const pid = push("project", null, { ...newProject("custom", title), stages: st, current, pipeline: "in_build", clientVisible: false, clientWs: ws, status: "on_track", ...extra } satisfies Project);
    push("pprivate", null, { projectId: pid, history: [], ...priv } satisfies ProjectPrivate);
    return pid;
  };
  const todo = (data: Partial<Todo> & { title: string }, order: number) => push("todo", null, { type: "once", done: false, order: 100 + order, createdAt: d(-2), source: "project", ...data } satisfies Todo);

  const hr = client("Halden & Rye", "Mara Quill", "mara@haldenrye.example", 0);
  const hrp = project(hr.ws, "Shopify redesign", [{ name: "Kickoff", days: 2 }, { name: "Research", days: 5 }, { name: "Design directions", days: 7 }, { name: "Build", days: 12 }, { name: "Client review", days: 3 }, { name: "Launch", days: 1 }], -22, 3,
    { nowLine: "Building the product page and the gift box picker" },
    { notes: "Mara wants the seasonal gift box above the fold.\nBakery photos arrive Thursday, shot on the new counter.\nNo discount codes on the homepage, ever.",
      checklist: [["Collect fonts and logo files", true], ["Homepage direction approved", true], ["Build the gift box picker", false], ["Product page with reviews", false], ["Set up 301 redirects", false], ["Test checkout on iPhone", false], ["Send the preview link", false]]
        .map(([text, done], i) => ({ id: `c${i}`, text: text as string, done: done as boolean, at: done ? d(-3) : null })) });
  project(hr.ws, "Holiday landing page", [{ name: "Brief", days: 2 }, { name: "Design", days: 4 }, { name: "Live", days: 1 }], 3, 0);
  const callDay = d(2);
  todo({ title: "Check the Halden & Rye build preview", ...repeatPatch([1, 2, 3, 4, 5], t), clientId: hr.cid, projectId: hrp }, 1);
  todo({ title: "Prep the gift box demo for the call", p1: true, doOn: d(1), deadline: { date: callDay, time: "16:00", eventId: "ev-hr", title: "Build check in" }, clientId: hr.cid, projectId: hrp }, 2);
  todo({ title: "Send the Friday update to Mara", ...repeatPatch([5], t), clientId: hr.cid, projectId: hrp }, 3);
  todo({ title: "Upload the bakery photos", doOn: d(2), clientId: hr.cid, projectId: hrp }, 4);

  const ss = client("Solberg Skin", "Ines Varga", "ines@solberg.example", 1);
  const ssp = project(ss.ws, "CRO retainer", [{ name: "Onboarding", days: 3 }, { name: "Baseline", days: 7 }, { name: "Testing", days: 21 }, { name: "Report", days: 2 }], -12, 2, {}, { checklist: [{ id: "x1", text: "Clarity installed", done: true, at: d(-10) }, { id: "x2", text: "First test live", done: false, at: null }] });
  todo({ title: "CRO for Solberg Skin", type: "daily", repeat: null, p1: true, clientId: ss.cid, projectId: ssp }, 5);
  todo({ title: "Build the CRO deck", p1: true, doOn: d(3), deadline: { date: d(4), time: "15:00", eventId: "ev-ss", title: "CRO deck review" }, clientId: ss.cid, projectId: ssp }, 6);

  const km = client("Kettle Moon Teas", "Oona Brask", "oona@kettlemoon.example", 2);
  project(km.ws, "Amazon brand store", [{ name: "Kickoff", days: 3 }, { name: "Build", days: 14 }, { name: "Launch", days: 3 }], -2, 0);
  const np = client("Northpine Outdoor", "Callum Reyes", "callum@northpine.example", 3);
  const npp = project(np.ws, "Lead gen", [{ name: "Setup", days: 2 }, { name: "Batches", days: 10 }], -4, 1);
  todo({ title: "Lead gen batch for Northpine", doOn: d(1), clientId: np.cid, projectId: npp }, 7);

  push("ptpl", null, { name: "Shopify redesign", stages: [{ name: "Kickoff", days: 2 }, { name: "Build", days: 12 }, { name: "Launch", days: 2 }], checklist: ["Collect fonts and logo files", "Set up 301 redirects"],
    tasks: [{ title: "Check the {client} build preview", days: [1, 2, 3, 4, 5] }, { title: "Send the preview link", doDay: 13, deadlineDay: 14, p1: true }], createdAt: d(-5) } satisfies ProjectTpl);

  if (cal) {
    const at = (k: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + k); x.setHours(h, m, 0, 0); return x.toISOString(); };
    push("calendar", null, { account: "dev", at: new Date().toISOString(), from: at(-1, 0), to: at(14, 0), events: [
      { id: "ev-hr", title: "Build check in", start: at(2, 16), end: at(2, 16, 30), allDay: false, link: "https://meet.example.com/abc", attendees: [{ email: "mara@haldenrye.example", name: "Mara Quill" }] },
      { id: "ev-ss", title: "CRO deck review", start: at(4, 15), end: at(4, 15, 45), allDay: false, link: "https://meet.example.com/def", attendees: [{ email: "ines@solberg.example", name: "Ines Varga" }] },
    ] } satisfies CalendarSnap);
  }
  return out;
}
