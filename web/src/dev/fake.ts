// DEV ONLY: fictional data to look at the owner screens without a real vault.
// Never imported in production builds (guarded by import.meta.env.DEV in App.tsx).
// Deliberately stressful: long names, long sentences, many projects, owed money, overdue to-dos.
import type { ClientRec, Doc, Draft, Kind, Meeting, Payment, Project, ProjectPrivate, ProjectType, Pipeline, Proposal, Reply, Todo } from "../core/model";
import { newProject } from "../core/model";
import { addDays, todayISO } from "../ui/kit";
import { fakeCampaignStats } from "./cstats-fake";
import { thisDevId, thisKind } from "../devicebgnow";
import { fakeRadarFeeds } from "./radar-fake";
import { fitnessFakeDocs } from "./fitness-fake";
import { toHours } from "../core/stline";

let n = 0;
const id = () => `dev-${++n}`;

interface ProjOpts {
  price?: number;
  currency?: string;
  priv?: Partial<ProjectPrivate>;
  payments?: Omit<Payment, "id">[];
  proposal?: Partial<Proposal>;
  promised?: number;
  start?: number;
  status?: Project["status"];
  nowLine?: string;
  liveUrls?: string[];
  archived?: boolean;
  hidden?: boolean;
  tasks?: { title: string; detail?: string; due?: number; done?: boolean }[];
  update?: { title: string; bullets: string[] };
}

export function fakeDocs(): Doc[] {
  n = 0;
  const out: Doc[] = [];
  const t = todayISO();
  const d = (k: number) => addDays(t, k);
  const push = (kind: Kind, ws: string | null, data: unknown, did = id()) => {
    out.push({ id: did, ws, kind, author: "dev", updatedAt: new Date().toISOString(), data });
    return did;
  };

  const clientIds: Record<string, string> = {};
  const client = (name: string, contact: string, tz: string, status: ClientRec["status"], order: number, extra: Partial<ClientRec> = {}) => {
    const ws = id();
    const cid = push("client", null, { name, ws, contactName: contact, timezone: tz, status, order, createdAt: d(-60), email: `${contact.split(" ")[0].toLowerCase()}@example.com`, ...extra });
    clientIds[ws] = cid;
    push("wsmeta", ws, { clientName: name, greetingName: contact.split(" ")[0] });
    return ws;
  };

  const project = (ws: string, type: ProjectType, title: string, pipeline: Pipeline, current: number, o: ProjOpts = {}) => {
    const pid = id();
    const base = newProject(type, title);
    const p: Project = {
      ...base,
      pipeline,
      current,
      status: o.status ?? "on_track",
      nowLine: o.nowLine ?? null,
      startDate: o.start != null ? d(o.start) : d(-14),
      promisedDelivery: d(o.promised ?? 12),
      originalDelivery: d((o.promised ?? 12) - 3),
      deliveryChanges: o.promised != null ? [{ from: d(o.promised - 3), to: d(o.promised), reason: "Client asked for an extra round of feedback on the product pages before we build", at: d(-4) }] : [],
      proposal: { price: o.price ?? 1500, currency: o.currency ?? "USD", scope: [], status: "accepted", ...o.proposal },
      payments: (o.payments || []).map((x) => ({ id: id(), ...x })),
      liveUrls: o.liveUrls || [],
      archived: o.archived,
      clientVisible: !o.hidden,
      clientWs: o.hidden ? ws : null,
    };
    push("project", o.hidden ? null : ws, p, pid);
    push("pprivate", null, { projectId: pid, history: [{ date: d(-10), text: "Kickoff call, scope agreed and the launch date pencilled in" }], ...o.priv });
    (o.tasks || []).forEach((tk, i) => {
      const tid = push("ctask", ws, { projectId: pid, title: tk.title, detail: tk.detail ?? null, due: tk.due != null ? d(tk.due) : null, order: i });
      if (tk.done) push("tick", ws, { taskId: tid, done: true, at: new Date().toISOString(), by: "client" });
    });
    if (o.update) push("update", ws, { projectId: pid, date: d(-1), title: o.update.title, bullets: o.update.bullets, status: p.status });
    return pid;
  };

  const LONG_WAIT = "Their final decision on whether the homepage hero uses the new lookbook photography or the older studio shots, plus written sign off on the product page layout from both co-founders";
  const LONG_NEXT = "Rebuild the collection page filters so size, colour and fabric work together on mobile, then record a short walkthrough video and send it over with the preview link before Friday";

  // 1. Active client, many projects, owed money
  const a = client("Northwind Silk and Linen Atelier International", "Annabelle Fieldhouse-Whitcombe", "America/New_York", "client", 10);
  project(a, "shopify_redesign", "Full Shopify homepage, collection and product page redesign", "client_review", 3, {
    price: 2500, priv: { waitingOn: "client", waitingWhat: LONG_WAIT, waitingSince: d(-5), nextDue: d(-1) },
    payments: [{ label: "Deposit, 50% before work starts", amount: 1250, currency: "USD", status: "paid", paidAt: d(-14) }, { label: "Final 50% on launch", amount: 1250, currency: "USD", status: "owed", due: d(-3) }],
    proposal: { scope: ["5 to 10 homepage directions with live previews", "Collection and product page redesign", "Mobile first build on a copy of the live theme", "30 days of free fixes after launch"], splitText: "50% before ($1,250), 50% after launch ($1,250)", afterLaunch: "30 days free fixes, then the CRO retainer at $1,250 a month", sentAt: d(-20), signedAt: d(-15), links: [{ label: "Live proposal", url: "https://example.com/p1", kind: "live" }, { label: "Designed PDF", url: "https://example.com/p1.pdf", kind: "pdf" }] },
    nowLine: "Three directions are live. Waiting on Annabelle to pick one, or mix two.",
    tasks: [{ title: "Pick a homepage direction", detail: "Open each preview on your phone first, then your laptop", due: 1 }, { title: "Send the brand fonts as files", due: -2 }, { title: "Share Shopify staff access", done: true }],
    update: { title: "Directions are ready", bullets: ["Three homepage directions built on a theme copy", "Each one has a live preview link that works for two days", "Product pages come next once you pick"] },
  });
  project(a, "cro_retainer", "Ongoing conversion optimisation retainer with monthly testing", "lead", 0, { price: 1250, priv: { nextStep: LONG_NEXT, nextDue: d(-2) } });
  project(a, "amazon_a_plus", "Amazon A+ content for the bedding range", "in_build", 2, { price: 1600, priv: { nextStep: "Finish module 3 for the pillowcase listing", nextDue: t }, payments: [{ label: "A+ deposit", amount: 800, currency: "USD", status: "owed", due: d(-8) }] });
  project(a, "amazon_brand_store", "Amazon Brand Store rebuild", "signed", 0, { price: 1200, hidden: true, priv: { nextStep: "Collect the category banner images", nextDue: d(3), nextInvoiceDate: d(2) } });

  // 2. Active client
  const b = client("Petal and Pine Botanical Skincare Company", "Samantha Leigh-Ardmore", "America/Los_Angeles", "client", 20);
  project(b, "amazon_a_plus", "Amazon A+ content for twelve serum and moisturiser listings", "in_build", 2, {
    price: 1600, priv: { nextStep: LONG_NEXT, nextDue: t, nextInvoiceDate: d(4) }, status: "at_risk",
    payments: [{ label: "Deposit", amount: 800, currency: "USD", status: "paid", paidAt: d(-9) }, { label: "Balance", amount: 800, currency: "USD", status: "upcoming", due: d(5) }],
    proposal: { scope: ["Twelve listings, five modules each", "Comparison chart module", "Two rounds of changes"], splitText: "50% before, 50% when Amazon approves", afterLaunch: "One free refresh after 90 days" },
  });
  project(b, "shopify_redesign", "Shopify product page redesign", "live", 7, { price: 1800, liveUrls: ["https://example.com/petal-and-pine-botanical-skincare-company/products/overnight-renewal-serum"], payments: [{ label: "Launch payment", amount: 900, currency: "USD", status: "paid", paidAt: d(-30) }] });
  project(b, "cro_retainer", "CRO retainer", "cro", 3, { price: 1250, payments: [{ label: "October retainer", amount: 1250, currency: "USD", status: "owed", due: d(-1) }] });
  project(b, "video", "Product launch video edits for social", "client_review", 2, { price: 450, currency: "GBP", priv: { waitingOn: "client", waitingWhat: "Notes on the second cut" } });

  // 3. Pending
  const c = client("Halden Selvedge Denim Workshop", "Christopher Raymond", "Europe/London", "pending", 30);
  project(c, "shopify_redesign", "Shopify redesign", "proposal_sent", 0, { price: 3500, currency: "GBP", priv: { waitingOn: "client", waitingWhat: LONG_WAIT, waitingSince: d(-12) }, proposal: { status: "sent", sentAt: d(-12), scope: ["Homepage", "Collection pages", "Product pages", "Size guide rebuild"], splitText: "40% before, 30% at design sign off, 30% on launch", afterLaunch: "60 days free fixes" } });

  // 4. Prospects
  const e = client("Lumi Botanics", "Jo Park", "America/Chicago", "prospect", 40);
  project(e, "custom", "AI calling assistant for wholesale order follow ups", "proposal_sent", 0, { price: 600, priv: { nextStep: "Follow up on the proposal with the two pricing options and a short Loom", nextDue: d(-4) }, proposal: { status: "sent", sentAt: d(-6), scope: ["Call script", "Integration with their order sheet", "Two weeks of tuning"] } });
  const f = client("Marisol and Wren Handmade Jewellery Collective", "Marisol Ortega-Vandenberg", "America/Denver", "prospect", 45);
  project(f, "shopify_redesign", "Homepage redesign demo follow up", "proposal_sent", 0, { price: 2200, priv: { nextStep: "Send the revised proposal", nextDue: d(1) }, proposal: { status: "draft", scope: ["Homepage redesign", "Gift guide landing page"], splitText: "50% before, 50% after", afterLaunch: "30 days free fixes" } });
  project(f, "cro_retainer", "CRO retainer option", "lead", 0, { price: 1250 });

  // 5. Leads
  const g = client("Oakhaven Candle Co", "Priya Raman", "Asia/Kolkata", "lead", 50);
  project(g, "custom", "Discovery call", "lead", 0, { price: 0, priv: { nextStep: "Book the discovery call for next week", nextDue: d(2) } });
  client("Brightwater Swim and Resortwear by the Coastal Design House", "Tomasz Kowalczyk-Brennan", "Europe/Warsaw", "lead", 55, { notes: "Met at the trade show, wants a video edit quote first" });

  // 6. Past
  const h = client("Fern and Fable Kidswear", "Lena Okafor", "Africa/Lagos", "past", 60);
  project(h, "shopify_redesign", "Shopify redesign", "finished", 8, { price: 2000, payments: [{ label: "Paid in full", amount: 2000, currency: "USD", status: "paid", paidAt: d(-90) }] });

  // ---- to-dos ----
  const todo = (title: string, type: Todo["type"], order: number, due?: number, done = false, ws?: string) =>
    push("todo", null, { title, type, done, order, due: due != null ? d(due) : null, createdAt: d(-3), clientId: ws ? clientIds[ws] : null, source: "manual", pushes: due != null && due < 0 ? 2 : 0 } satisfies Todo);
  push("todo", null, { title: "Check every inbox for client replies and answer the warm ones first", type: "daily", done: false, order: 1, due: null, createdAt: d(-3), source: "manual",
    subtasks: [{ id: "ci1", title: "Gmail, all five", done: true, doneAt: d(0) }, { id: "ci2", title: "Instantly unibox", done: false }] } satisfies Todo);
  todo("Post one before and after redesign clip", "daily", 2, undefined, true);
  todo("Send Annabelle the revised homepage hero options with the lookbook photography and the studio shots side by side", "once", 3, -3, false, a);
  todo("Invoice Petal and Pine for the October CRO retainer", "once", 4, -1, false, b);
  todo("Renew the domain", "once", 5, 0);
  push("todo", null, { title: "Follow-ups", type: "once", done: false, order: 5.5, due: null, createdAt: d(-1), source: "manual", subtasks: [
    { id: "fu1", title: "Jo at Petal and Pine about the reorder", done: true, doneAt: d(0) },
    { id: "fu2", title: "Annabelle about the hero photos", done: false },
    { id: "fu3", title: "Sam at Halden, second nudge", done: false, claudeDoneAt: d(0), claudeNote: "Drafted the nudge" },
  ] } satisfies Todo);
  todo("Draft the Halden follow up", "once", 6, 2, false, c);
  todo("Update the case study page with the new numbers", "once", 7);
  // Fictional work day logs, so the Map shows done tasks and search finds them.
  push("daylog", null, { date: d(-1), updatedAt: new Date().toISOString(), items: [
    { todoId: "x1", title: "Stretch for ten minutes", at: new Date(Date.now() - 20 * 3600_000).toISOString(), repeat: true },
    { todoId: "x2", title: "Send Northwind the launch checklist", at: new Date(Date.now() - 18 * 3600_000).toISOString(), p1: true },
  ], missed: [
    { id: "m1", t: "Update the case study page", p1: 1, due: d(-1), age: 6 },
    { id: "m2", t: "Walk after lunch", rep: 1 },
  ], totals: { done: 2, missed: 2, p1Done: 1, p1Missed: 1, added: 3, deleted: 1, dimx: 1 } });
  push("daylog", null, { date: d(-2), updatedAt: new Date().toISOString(), items: [
    { todoId: "x1", title: "Stretch for ten minutes", at: new Date(Date.now() - 44 * 3600_000).toISOString(), repeat: true },
  ] });
  // Fictional screen time (what PS would send), so the To-do card and the Map show it in dev.
  const screen = (k: number, f: number) => push("screentime", null, { day: d(k), updatedAt: new Date().toISOString(), apps: [
    { id: "com.example.editor", name: "Code Editor", secs: Math.round(11400 * f) }, { id: "com.example.browser", name: "Web Browser", secs: Math.round(7300 * f) },
    { id: "com.example.design", name: "Design Tool", secs: Math.round(3900 * f) }, { id: "com.example.mail", name: "Mail Client", secs: Math.round(1500 * f) },
    { id: "com.example.chat", name: "Chat App", secs: Math.round(900 * f) }, { id: "com.example.music", name: "Music Player", secs: Math.round(420 * f) },
    { id: "com.example.notes", name: "Notes App", secs: Math.round(200 * f) }, { id: "com.example.term", name: "Terminal App", secs: Math.round(90 * f) },
  ] });
  screen(0, 0.55); screen(-1, 1); screen(-2, 0.8); screen(-3, 1.15); screen(-5, 0.6);
  // And what PS GOS would send from the phone: its own record per day ("gos:" + package names).
  const phone = (k: number, f: number) => push("screentime", null, { day: d(k), device: "gos", updatedAt: new Date().toISOString(), apps: [
    { id: "gos:com.example.reader", name: "News Reader", secs: Math.round(2700 * f) }, { id: "gos:com.example.maps", name: "City Maps", secs: Math.round(1500 * f) },
    { id: "gos:com.example.camera", name: "Camera", secs: Math.round(640 * f) }, { id: "gos:com.example.podcasts", name: "Podcasts", secs: Math.round(1900 * f) },
    { id: "gos:com.example.chat", name: "Chat App", secs: Math.round(1100 * f) },
  ] });
  phone(0, 0.7); phone(-1, 1.2); phone(-2, 0.5); phone(-4, 0.9);
  // And each device's saved line hours (core/stline.ts), so the Mac | Phone switch draws the other device's timeline.
  const lineAt = new Date().toISOString();
  for (const h of toHours(fakeTimeline(), "mac", lineAt).map((x) => ({ ...x, upTo: Math.min(x.upTo, Date.now() - 6 * 60_000) }))) push("stline", null, h);
  for (const h of toHours(fakePhoneTimeline(), "gos", lineAt)) push("stline", null, h);
  // Fictional repeats and streaks, so the gold numbers and repeat tags show in dev.
  const stretch = push("todo", null, { title: "Stretch for ten minutes", type: "daily", done: false, order: 3, createdAt: d(-9), source: "manual", streak: 6, bestStreak: 6,
    // PS 1.68: mini tasks with their own streaks (the flame on each one from 2 in a row).
    subtasks: [{ id: "st1", title: "Neck and shoulders", done: true, doneAt: d(0), streak: 7, streakTicked: true, bestStreak: 7 },
      { id: "st2", title: "Hamstrings", done: false, streak: 6, bestStreak: 11 }, { id: "st3", title: "Hips", done: false, streak: 1, bestStreak: 3 }] } satisfies Todo);
  // V1.55: an Annoying 15 min reminder on that task, every day 18:00 to 21:00 (the bell on its row).
  push("remind", null, { v: 1, at: 1, state: {}, gone: {}, list: [{ id: "devtask1", on: true, label: "", text: "", at: "18:00", until: "21:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "",
    snooze: 15, later: "", yes: "Done", word: "", click: true, bg: "#0f1b2d", accent: "#3b82f6", sound: "none", vol: 0.8, edited: 1, task: stretch },
    // V1.57: one fictional alarm (Settings, Annoying 15 min reminder, Alarms).
    { id: "devalarm1", on: true, label: "Wake up", text: "Time to stretch", at: "07:30", until: "07:40", days: [1, 2, 3, 4, 5], tz: "",
      snooze: 5, later: "Later", yes: "I'm up", word: "", click: true, bg: "#2a1a08", accent: "#f59e0b", sound: "alarm", vol: 0.8, edited: 1, alarm: true }] });
  push("todo", null, { title: "Water the studio plants", type: "daily", done: false, order: 4, due: t, repeat: { every: 2, unit: "day", from: d(-6) }, createdAt: d(-9), source: "manual", streak: 3 } satisfies Todo);
  push("todo", null, { title: "Back up the laptop", type: "daily", done: false, order: 5, due: d(4), repeat: { every: 1, unit: "week", from: d(-10) }, createdAt: d(-12), source: "manual", streak: 2 } satisfies Todo);
  // PS 1.70: a Priority 1 task with its 24 hour clock running (the timer on its row, views/DayCountdown.tsx P1Timer).
  push("todo", null, { title: "Send Northwind the launch checklist", type: "once", done: false, order: 0.5, p1: true, p1At: new Date(Date.now() - 20.5 * 3600_000).toISOString(), due: null, createdAt: d(-1), source: "manual" } satisfies Todo);
  push("todo", null, { title: "Write the AI agents proposal for Lumi Botanics", type: "once", done: false, order: 8, due: t, createdAt: d(-1), clientId: clientIds[e], source: "manual", claudeDoneAt: new Date().toISOString(), claudeNote: "Proposal drafted as a Google Doc, waiting for your read through" } satisfies Todo);

  // ---- meetings ----
  push("meeting", null, { title: "Northwind Silk and Linen Atelier weekly check in on the homepage directions", date: d(-1) + "T15:00:00Z", clientId: clientIds[a], source: "fireflies", url: "https://example.com/call1", overview: "Walked through the three directions. Annabelle prefers the gallery first layout but wants the story section from direction B lower down the page, and asked for the size guide to be rebuilt as a drawer on mobile.", actionItems: ["Merge the story section from direction B into direction A", "Rebuild the size guide as a mobile drawer", "Send a new preview link by Thursday", "Ask for the final product photography for the linen range"], participants: ["Owner", "Annabelle Fieldhouse-Whitcombe", "Marcus Whitcombe"], addedToTodo: [] } satisfies Meeting);
  push("meeting", null, { title: "Lumi Botanics discovery", date: d(-6) + "T10:30:00Z", clientId: clientIds[e], source: "manual", overview: "They want to automate wholesale reorder calls.", actionItems: ["Send the proposal", "Share two pricing options"], participants: ["Owner", "Jo Park"], addedToTodo: ["Send the proposal"] } satisfies Meeting);

  // ---- drafts ----
  push("draft", null, { clientId: clientIds[c], template: "follow_up", to: "christopher@example.com", subject: "Quick follow up on the Halden Selvedge Denim Workshop redesign proposal and the size guide idea", body: "Hi Christopher,\n\nJust floating this back up. Happy to walk through the size guide idea on a short call this week if that helps.\n\nRed", status: "draft" } satisfies Draft);
  push("draft", null, { clientId: clientIds[a], template: "update", to: "annabelle@example.com", subject: "Your three homepage directions", body: "Hi Annabelle,\n\nThe three directions are live, links below. They work for about two days.\n\nRed", status: "approved", approvedAt: d(-1), approvedText: "Hi Annabelle" } satisfies Draft);

  // ---- replies ----
  push("reply", null, { clientId: clientIds[a], account: "red@example.com", threadId: "th1", msgIds: ["m1", "m2"], from: "annabelle@example.com", fromName: "Annabelle Fieldhouse-Whitcombe", subject: "Re: Your three homepage directions, plus a question about the linen range photography", snippet: "Love A, but could we bring the story section from B lower down? Also our photographer can only deliver the linen shots next Wednesday, is that still okay for the timeline", date: d(0) + "T08:12:00Z", count: 2, handled: false } satisfies Reply);
  push("reply", null, { clientId: clientIds[e], account: "red@example.com", threadId: "th2", msgIds: ["m3"], from: "jo@example.com", fromName: "Jo Park", subject: "Re: Proposal", snippet: "Thanks the developer, looking at it with the team on Monday.", date: d(-2) + "T17:40:00Z", count: 1, handled: false } satisfies Reply);

  // ---- Gmail senders, for Settings > Gmail replies, Who emails me (fictional) ----
  {
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const sender = (email: string, name: string, account: string, subject: string, hours: number[]) =>
      push("msender", null, { email, name, accounts: [account], last: ago(Math.min(...hours)), subject, ids: hours.map((h, i) => [`${email}-${i}`, ago(h)] as [string, string]).sort((x, y) => x[1].localeCompare(y[1])) });
    sender("annabelle@example.com", "Annabelle Fieldhouse-Whitcombe", "red@example.com", "Re: Your three homepage directions", [4, 30, 70]);
    sender("sam@partnerstudio.example", "Sam Okafor", "red@example.com", "", [1]);
    sender("news@weeklydigest.example", "The Weekly Digest", "red.work@example.com", "Five things this week", [20, 190, 360]);
    sender("lee@printshop.example", "Lee Varga", "red.work@example.com", "Quote for the lookbook print run", [52]);
  }

  // ---- morning brief (fictional) ----
  {
    const at = (days: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x.toISOString(); };
    const nowH = new Date().getHours();
    push("calendar", null, { account: "red@example.com", at: new Date(Date.now() - 4 * 60_000).toISOString(), from: d(-14), to: d(45), events: [
      { id: "c1", title: "Northwind weekly check in", start: at(-1, 15), end: at(-1, 15, 45), allDay: false, link: "https://example.com/meet1", attendees: [{ email: "annabelle@example.com", name: "Annabelle Fieldhouse-Whitcombe" }, { email: "red@example.com", self: true }] },
      { id: "c2", title: "Lumi Botanics follow up call about the reorder agent", start: at(0, nowH, 0), end: at(0, nowH + 1, 0), allDay: false, link: "https://example.com/meet2", attendees: [{ email: "jo@example.com", name: "Jo Park" }, { email: "red@example.com", self: true }] },
      { id: "c3", title: "Gym", start: at(0, 19), end: at(0, 20), allDay: false, attendees: [] },
      { id: "c4", title: "Discovery call, new prospect from the website form", start: at(1, 17, 30), end: at(1, 18), allDay: false, link: "https://example.com/meet3", place: null, attendees: [{ email: "founder@prospect.example", name: "Sam Rivera" }, { email: "cofounder@prospect.example" }, { email: "ops@prospect.example" }, { email: "assistant@prospect.example" }, { email: "red@example.com", self: true }] },
      { id: "c5", title: "Bank holiday", start: d(3), end: d(4), allDay: true, attendees: [] },
    ] });
  }
  for (let i = 0; i < 27; i++) {
    const who = [["annabelle@example.com", "Annabelle Fieldhouse-Whitcombe"], ["news@brand.example", "Brand Newsletter"], ["jo@example.com", "Jo Park"]][i % 3];
    push("iemail", null, { iid: "ie" + i, at: new Date(Date.now() - i * 3.7 * 3600_000).toISOString(), type: i === 4 ? "manual" : "received",
      from: who[0], fromName: who[1], account: "sender" + (i % 4) + "@outreach.example", to: "sender" + (i % 4) + "@outreach.example",
      subject: i % 3 === 1 ? `Our autumn edit is here, ${i}0% off this weekend only` : `Re: Quick idea for your homepage (${i})`,
      text: "Thanks for reaching out. We are looking at a homepage refresh before the holidays and would love to see what you have in mind. Could you send over a couple of examples?\n\nBest,\n" + who[1],
      unread: i < 3, campaignId: "c1", lead: who[0] });
  }
  push("ithread", null, { threadId: "t1", subject: "Re: Annabelle, I rebuilt your homepage", lead: "annabelle@example.com", leadName: "Annabelle Fieldhouse-Whitcombe", account: "sender1@outreach.example", lastAt: new Date(Date.now() - 3600_000).toISOString(), unread: true, messages: [
    { iid: "m1", at: new Date(Date.now() - 3 * 864e5).toISOString(), type: "sent", from: "sender1@outreach.example", account: "sender1@outreach.example", subject: "Annabelle, I rebuilt your homepage", text: "Hi Annabelle,\n\nI rebuilt your homepage to make the linen range easier to shop. Want me to send it over?\n\nRed" },
    { iid: "m2", at: new Date(Date.now() - 2 * 864e5).toISOString(), type: "received", from: "annabelle@example.com", fromName: "Annabelle Fieldhouse-Whitcombe", account: "sender1@outreach.example", subject: "Re: Annabelle, I rebuilt your homepage", text: "Hi the developer,\nSure, send it over.\n\nOn Mon, the developer Owner wrote:\n> Hi Annabelle,\n> I rebuilt your homepage" },
    { iid: "m3", at: new Date(Date.now() - 864e5).toISOString(), type: "manual", from: "sender1@outreach.example", account: "sender1@outreach.example", subject: "Re: Annabelle, I rebuilt your homepage", text: "Here it is: https://example.com/preview\n\nRed" },
    { iid: "m4", at: new Date(Date.now() - 3600_000).toISOString(), type: "received", from: "annabelle@example.com", fromName: "Annabelle Fieldhouse-Whitcombe", account: "sender1@outreach.example", subject: "Re: Annabelle, I rebuilt your homepage", text: "Love it. Can we talk Thursday?", unread: true },
  ] });
  // Fictional call reminders for the live test call (c2), so the Tab list's "Meeting notes" checklist shows.
  const liveStart = (() => { const x = new Date(); x.setHours(x.getHours(), 0, 0, 0); return x.toISOString(); })();
  push("settings", null, { tmBg: "none", tmBgDev: { fakephonepixel01: { b: "spotlight", t: Date.now() - 6e4 }, [thisDevId()]: { b: "none", t: Date.now() - 6e4 } }, ownerName: "Owner", p1Migrated: true, autoLockMin: 15, autoReset: "off", theme: "system", birthday: "1990-05-20",
    // Timelines (views/Timelines.tsx, V1.43): fictional countdowns of every kind. A birthday and an anniversary keep
    // their first year so the age and the years show; one with no kind is a timeline from before V1.43.
    timelines: [
      { id: "tl1", title: "Mum", kind: "birthday", date: `1966-${d(12).slice(5)}`, createdAt: d(-40) + "T10:00:00Z" },
      { id: "tl2", title: "Sam and Alex", kind: "wedding", date: d(41), time: "14:30", createdAt: d(-60) + "T10:00:00Z" },
      { id: "tl3", title: "Tokyo", kind: "trip", date: d(76), createdAt: d(-20) + "T10:00:00Z" },
      { id: "tl4", title: "Tax return", kind: "deadline", date: d(3), time: "17:00", createdAt: d(-30) + "T10:00:00Z" },
      { id: "tl5", title: "Mum and Dad", kind: "anniversary", date: `1996-${d(33).slice(5)}`, createdAt: d(-90) + "T10:00:00Z" },
      { id: "tl6", title: "Christmas", kind: "holiday", repeat: true, date: "2025-12-25", createdAt: d(-10) + "T10:00:00Z" },
      { id: "tl7", title: "Coldplay concert", kind: "event", date: d(1), time: "20:00", createdAt: d(-50) + "T10:00:00Z" },
      { id: "tl8", title: "Client launch party", date: d(-4), createdAt: d(-30) + "T10:00:00Z" },
      { id: "tl9", title: "First half marathon", kind: "custom", date: d(120), createdAt: d(-5) + "T10:00:00Z" },
    ],
    // Numerology (views/Numerology.tsx): fictional people; one has a birthday today.
    tmNumPeople: [
      { id: "me", name: "Alex", birthday: "1996-10-11", me: true },
      { id: "np1", name: "Sam Fox", birthday: `2001-${new Date().toISOString().slice(5, 10)}` },
      { id: "np2", name: "Kit Lane", birthday: "2003-06-12" },
      { id: "np3", name: "Robin Hale", birthday: "2000-02-29" },
    ],
    // The rule book (fictional rules; the developer writes his own).
    rules: [
      { id: "rl1", text: "Train before the first call of the day", createdAt: d(-9) + "T10:00:00Z" },
      { id: "rl2", text: "No phone for the first hour after waking", createdAt: d(-9) + "T10:01:00Z" },
      { id: "rl3", text: "Ship one thing a client can see, every single day", createdAt: d(-8) + "T10:00:00Z" },
      { id: "rl4", text: "Answer every client email before midnight", createdAt: d(-4) + "T10:00:00Z" },
    ],
    meetingNotes: [{ key: "c2" + liveStart, title: "Lumi Botanics follow up call", start: liveStart, items: [
      { id: "mn1", text: "Ask Jo for last month's reorder volume", done: false },
      { id: "mn2", text: "Mention the agent saves about 6 hours a week", done: true },
      { id: "mn3", text: "Agree a start date before the call ends", done: false },
    ] }],
    standingNotes: [{ title: "lumi botanics follow up call about the reorder agent", items: [{ id: "sn1", text: "Open with how their week is going" }] }],
    suggestMigrated: true,
    // Dimension X (fictional): a few cards in each band.
    dimx: [
      { id: "dx1", text: "Send Lumi Botanics the revised timeline", zone: "act", createdAt: new Date().toISOString() },
      { id: "dx2", text: "Record the Northwind walkthrough video", zone: "act", createdAt: new Date().toISOString() },
      { id: "dx3", text: "Plan the Halden CRO test list", zone: "soon", createdAt: new Date().toISOString() },
      { id: "dx4", text: "Redo the case study page", zone: "soon", createdAt: new Date().toISOString() },
      { id: "dx5", text: "Learn the new Shopify checkout extensibility", zone: "soon", createdAt: new Date().toISOString() },
      { id: "dx6", text: "Maybe a podcast about redesigns?", zone: "x", createdAt: new Date().toISOString() },
      { id: "dx7", text: "Buy a better microphone", zone: "x", createdAt: new Date().toISOString() },
      { id: "dx8", text: "Holiday offer for beauty brands", zone: "x", createdAt: new Date().toISOString() },
      { id: "dx9", text: "Ask Jo for a referral", zone: "x", createdAt: new Date().toISOString() },
    ],
    goals: [
      { id: "g1", title: "Close 3 new Shopify clients", level: "macro", start: d(-15), end: d(76), color: "#EC4E86", createdAt: new Date().toISOString() },
      { id: "g2", title: "Launch the Northwind store", level: "meso", start: d(-15), end: d(15), color: "#A855F7", createdAt: new Date().toISOString() },
      { id: "g3", title: "Two proposals out", level: "micro", start: d(-2), end: d(4), color: "#38BDF8", createdAt: new Date().toISOString() },
    ],
    notifyLog: [
      { at: new Date(Date.now() - 3 * 3600_000).toISOString(), text: "Calendar refreshed: 42 events" },
      { at: new Date(Date.now() - 40 * 60_000).toISOString(), text: "Claude updated your vault: Lumi Botanics's dashboard, 2 to-do items" },
    ],
    mailCardsSince: d(-7) + "T00:00:00Z",
    mailRules: { e: { "partnerstudio.example": { l: "notify", at: new Date().toISOString() }, "news@weeklydigest.example": { l: "mute", at: new Date().toISOString() } } },
    suggestions: [
      { id: "sg1", title: "Send Lumi Botanics the AI agents proposal", type: "once", due: t, clientId: clientIds[e], note: "Proposal drafted as a Google Doc", claudeDone: true, createdAt: new Date().toISOString() },
      { id: "sg2", title: "Reply to the Halden pricing question", type: "once", due: d(1), clientId: clientIds[c], note: null, asap: true, from: "telegram", createdAt: new Date(Date.now() - 12 * 60_000).toISOString() },
      { id: "sg3", title: "Check the Northwind launch analytics", type: "once", due: null, note: null, from: "telegram", createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
    ] });
  push("agenda", null, { title: "Close 3 new Shopify clients", note: "Two proposals out, one call booked. Done when 3 deposits land.", startedAt: d(-9), endedAt: null, order: 0 });
  push("agenda", null, { title: "Get the pipeline moving", note: null, startedAt: d(-3), endedAt: null, order: 1 });
  push("agenda", null, { title: "September: finish the Northwind build", note: "Shipped on the 28th.", startedAt: d(-45), endedAt: d(-15), order: 0 });
  {
    const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    push("journal", null, { key: `m:${ym}`, title: "The Comeback", note: "The month the vault went live and the pipeline started moving again." });
    push("journal", null, { key: `d:${d(-1)}`, note: "Long call with Northwind, they picked direction A. Gym after." });
    push("journal", null, { key: `d:${d(0)}`, note: "Built the series map." });
  }
  push("quote", null, { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln", order: 0, createdAt: new Date().toISOString() });
  push("note", null, { title: "Northwind call prep", html: "<h2>Agenda</h2><ul><li>Walk through direction A</li><li>Size guide drawer</li></ul><ul class=\"nt-check\"><li data-done=\"\">Send preview link</li><li>Ask for linen photos</li></ul><p>Remember to ask about the <b>holiday</b> launch.</p>", createdAt: new Date(Date.now() - 864e5).toISOString(), updatedAt: new Date(Date.now() - 3600_000).toISOString(), pinned: true, deletedAt: null });
  push("note", null, { title: "", html: "<p>Ideas for the CRO tests</p><p>Reviews higher on the page, sticky add to bag.</p>", createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), updatedAt: new Date(Date.now() - 5 * 864e5).toISOString(), pinned: false, deletedAt: null });
  push("brief", null, {
    date: t,
    headline: "2 things need you before lunch",
    source: "Daily Report email, fictional dev copy",
    createdAt: new Date().toISOString(),
    weather: [
      { city: "Lisbon", today: "21 C, sunny", tomorrow: "19 C, light rain" },
      { city: "Austin", today: "28 C, clear", tomorrow: "30 C, hot and humid" },
      { city: "Kyoto", today: "16 C, cloudy", tomorrow: "14 C, showers" },
    ],
    stats: [
      { label: "Replies overnight", value: "4", sub: "2 warm, 1 asking for a call", tone: "good" },
      { label: "Days since a new call", value: "3", sub: "Book one this week", tone: "warn" },
      { label: "Drafts waiting", value: "12", sub: "Across 3 inboxes", tone: null },
      { label: "Tasks done yesterday", value: "9", sub: "Up 28% on the day before", tone: "good" },
    ],
    sections: [
      { title: "Client updates", items: ["Northwind posted a new lookbook teaser, a good moment to send the homepage preview", "Petal and Pine started a serum giveaway that ends Sunday", "Halden opened a pop up shop this weekend", "Lumi Botanics hired a new wholesale manager", "Marisol and Wren added a gift guide page to their store"], tone: null },
      { title: "Needs you today", items: ["Two overdue invoices total more than $2,000", "A warm lead asked for a call slot tomorrow morning"], tone: "alert" },
      { title: "Tech and AI", items: [{ text: "A new phone OS update fixes a Safari scrolling bug on product pages", url: "https://example.com/" }, "A popular store builder released faster theme previews", "Browser vendors announced a change to third party cookies next year", "An image model update makes product shots with clean backgrounds easier"], tone: "muted" },
      { title: "Wins", items: ["A 31% reply rate on the latest follow up sequence", "One proposal moved to signed"], tone: "good" },
    ],
  });
  // Fictional devices for Settings, Looks, Backgrounds per device (core/devicebg.ts): this page, another Mac and a phone.
  { const seen = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    push("bgdev", null, { dev: thisDevId(), kind: thisKind(), name: "Mac", seen: seen(0.1) });
    push("bgdev", null, { dev: "fakemacstudio001", kind: "mac", name: "Mac Studio", own: true, seen: seen(3) });
    push("bgdev", null, { dev: "fakephonepixel01", kind: "phone", name: "Pixel 8", seen: seen(6) }); }
  // Fictional campaign statistics (Tab list > Campaign stats). /dev?stale=19 shows the amber "old data" look.
  const stale = Number(new URLSearchParams(location.search).get("stale")) || 0;
  push("cstats", null, fakeCampaignStats(new Date(), { staleDays: stale }));
  // Fictional follow-up engine snapshot and Instantly reply feed (Follow-up Radar).
  const feeds = fakeRadarFeeds(new Date());
  push("fup", null, feeds.fup);
  push("irep", null, feeds.irep);

  out.push(...fitnessFakeDocs(t));   // Fitness: a fictional program and two weeks of workouts
  // People on the Time zones screen (core/tzpeople.ts, V1.39): fictional names, a few zones each side of the world.
  for (const [name, tz] of [["Zoë Ångström", "Europe/Stockholm"], ["Mateo Ruiz", "America/Vancouver"], ["Aunt Hilde", "Europe/Berlin"], ["Kenji Watanabe", "Asia/Tokyo"], ["Ruby Calloway", "America/New_York"]] as const) {
    push("tzperson", null, { name, tz, at: new Date(Date.now() - 86400000 * (10 + name.length)).toISOString() });
  }
  return out;
}

/** A fictional day on the Mac for the screen time timeline (dev only). */
/** The phone's line (what PS GOS counts from GrapheneOS's usage events): short looks, screen off between. */
export function fakePhoneTimeline() {
  const now = Date.now(), H = 3600_000, M = 60_000;
  const apps = [{ id: "gos:com.example.reader", name: "News Reader" }, { id: "gos:com.example.maps", name: "City Maps" }, { id: "gos:com.example.chat", name: "Chat App" }, { id: "gos:com.example.podcasts", name: "Podcasts" }];
  const plan: [number, number][] = [[2, 6], [-1, 55], [0, 14], [2, 3], [-1, 120], [1, 9], [-1, 300], [3, 25], [-1, 90], [0, 18], [2, 4], [-1, 40], [2, 7]];
  let t = now - plan.reduce((n, [, m]) => n + m, 0) * M;
  const segs: [number, number, number][] = [], away: [number, number][] = [];
  for (const [a, m] of plan) { const e = t + m * M; if (a < 0) away.push([t, e]); else segs.push([a, t, e]); t = e; }
  return { now, from: now - 24 * H, apps, segs, away };
}
export function fakeTimeline() {
  const now = Date.now(), H = 3600_000, M = 60_000;
  const apps = [{ id: "dev.editor", name: "Code Editor" }, { id: "dev.browser", name: "Web Browser" }, { id: "dev.design", name: "Design Tool" }, { id: "dev.mail", name: "Mail Client" }, { id: "dev.chat", name: "Chat App" }];
  const plan: [number, number][] = [[1, 50], [0, 95], [3, 12], [0, 40], [-1, 380], [2, 70], [1, 25], [4, 8], [0, 110], [-1, 22], [1, 35], [0, 64], [3, 6], [2, 18]];
  let t = now - plan.reduce((n, [, m]) => n + m, 0) * M;
  const segs: [number, number, number][] = [], away: [number, number][] = [];
  for (const [a, m] of plan) { const e = t + m * M; if (a < 0) away.push([t, e]); else segs.push([a, t, e]); t = e; }
  return { now, from: now - 24 * H, apps, segs, away };
}
