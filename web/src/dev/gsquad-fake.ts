// FICTIONAL G Squad for the dev server's Tab list only (never in a release build): made up people, tasks, chat,
// boards and gym data, handed to the Tab list the way PS's main page would (the plain views, no keys), so the
// G Squad window can be drawn and pictured with no hub. Load with /client/overlay?fake&gsquad (src/App.tsx);
// V1.49 (one squad, everyone in): &gsquad=joining (or none) shows Getting you in, &gsquad=left (Join again),
// &gsquad=removed, &gsquad=full, &gsquad=error; &gsquad=solo is the developer alone in The G Squad.
// &open (or the phone's page) opens the G Squad screen straight away; &gstab=settings or another section picks it.
import { setSquadMirror } from "../squad/mirror";
import { setChatMirror } from "../squad/chatmirror";
import { setGymMirror } from "../squad/gymview";
import { gymStore } from "../squad/gym";
import { loadGymFake } from "./gym-fake";
import { p1Board, type P1Log } from "../core/squadp1board";

const ME = "00000000-0000-4000-8000-000000000001";
const SAM = "00000000-0000-4000-8000-0000000000a1", KIT = "00000000-0000-4000-8000-0000000000a2", ANA = "00000000-0000-4000-8000-0000000000a3";
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A made up round picture (PS 1.65), drawn here so no image file is needed. */
function fakePic(a: string, b: string): string | undefined {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"); if (!g) return undefined;
    const gr = g.createLinearGradient(0, 0, 64, 64); gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); g.fillStyle = "rgba(255,255,255,.55)"; g.beginPath(); g.arc(32, 26, 11, 0, 7); g.fill(); g.beginPath(); g.ellipse(32, 60, 21, 18, 0, 0, 7); g.fill();
    return c.toDataURL("image/png");
  } catch { return undefined; }
}

export function loadGSquadFake() {
  const mode = new URLSearchParams(location.search).get("gsquad") || "in";
  const members = [
    { id: ME, name: "Alex", me: true, creator: true, working: true },
    { id: SAM, name: "Sam Rivera", me: false, creator: false, working: true, pic: fakePic("#6d8fa8", "#2f4a63") },
    { id: KIT, name: "Kit", me: false, creator: false, working: false },
    { id: ANA, name: "Ana Petrova", me: false, creator: false, working: true },
  ];
  const tasks = [
    { id: "t1", member: ME, t: "Finish the onboarding copy", p: 1, d: null, x: false },
    { id: "t2", member: ME, t: "Send the weekly numbers", p: 2, d: null, x: true },
    { id: "t3", member: SAM, t: "Fix the checkout bug", p: 1, d: null, x: false },
    { id: "t4", member: SAM, t: "Gym at 18:00", p: null, d: null, x: false, e: true },
    { id: "t5", member: ANA, t: "Client call prep", p: 2, d: null, x: false, a: true },
    { id: "t6", member: ANA, t: "Draft the new landing page", p: 3, d: null, x: true },
  ];
  // PS 1.63 Priority 1 rows (core/squadp1.ts P1Row): made up, started so one is open, one nearly out, one missed, one done.
  const p1 = [
    { id: "p1a", member: ANA, t: "Draft the new landing page", s: ago(60 * 22 + 40), x: false },
    { id: "p1b", member: SAM, t: "Fix the checkout bug", s: ago(60 * 5), x: false },
    { id: "p1c", member: KIT, t: "Send the invoices", s: ago(60 * 26), x: false },
    { id: "p1d", member: SAM, t: "Review the pricing page", s: ago(60 * 20), x: true, xa: ago(60 * 2) },
  ];
  // PS 1.68 Squad Priority 1 board: &p1n=2 (or 5, 12) people, made up names, made up history (core/squadp1board.ts).
  const p1n = Math.max(1, Math.min(12, Number(new URLSearchParams(location.search).get("p1n")) || 4));
  const FAKE_NAMES = ["Alex", "Sam Rivera", "Kit", "Ana Petrova", "Lee Moss", "Rui", "Noor Haddad", "Ben Ode", "Ivy", "Max Lund", "Zoe Kerr", "Tom Vale"];
  const boardMembers = FAKE_NAMES.slice(0, p1n).map((name, i) => ({ id: i === 0 ? ME : i === 1 ? SAM : i === 2 ? KIT : i === 3 ? ANA : id(900 + i), name, me: i === 0 }));
  const H = 3_600_000, D = 24 * H, NOW = Date.now();
  const log: P1Log = { since: new Date(NOW - 40 * D).toISOString(), e: {} };
  boardMembers.forEach((m, i) => {
    const n = [25, 22, 14, 31, 9, 18, 2, 12, 20, 6, 16, 11][i], misses = [2, 4, 5, 1, 1, 6, 0, 2, 3, 3, 1, 2][i], lastMiss = [6, 9, 2, 12, 4, 1, 99, 3, 5, 2, 8, 7][i];
    for (let k = 0; k < n; k++) {
      const at = NOW - (k + 1) * (28 * D) / n, miss = k < misses ? k === 0 ? NOW - lastMiss * D - 2 * H : NOW - (lastMiss + 3 * k) * D : 0;
      log.e[`${m.id}-${k}@x`] = { m: m.id, id: `${i}-${k}`, s: new Date((miss || at) - 20 * H).toISOString(), o: miss ? "miss" : "hit", at: miss || at };
    }
  });
  const openCopies = boardMembers.flatMap((m, i) => {
    const t = ["Finish the onboarding copy", "Fix the checkout bug", "Send the invoices", "Draft the new landing page", "Client task", "Book the venue", "Ship the beta", "Call the bank", "Write the brief", "Plan the launch", "Pay the team", "Update the deck"][i];
    const left = [22, 1.5, -3, 5, 15, 0.6, 11, 19, 7, 2.5, 23, 9][i];
    return [{ id: `bo${i}`, member: m.id, t, x: false, s: new Date(NOW - (24 - left) * H).toISOString() },
      ...(i % 3 === 0 ? [{ id: `bd${i}`, member: m.id, t: "Review the pricing page", x: true, s: new Date(NOW - 20 * H).toISOString(), xa: new Date(NOW - 2 * H).toISOString() }] : []),
      ...(i === 1 ? [{ id: "bx1", member: m.id, t: "Reply to the agency", x: false, s: new Date(NOW - 6 * H).toISOString() }] : [])];
  });
  const p1b = p1Board({ log, copies: openCopies, members: boardMembers, now: NOW, tz: "UTC" });
  const entry = (member: string, rank: number, n: number) => ({ member, state: "ok" as const, rank, n });
  const board = {
    rules: { money: "revenue", show: "exact", currency: "GBP" },
    money: { "1": [{ member: SAM, state: "ok" as const, rank: 1, amount: 12400, months: 1 }, { member: ME, state: "ok" as const, rank: 2, amount: 9150, months: 1 }, { member: KIT, state: "ok" as const, rank: 3, amount: 4300, months: 1 }, { member: ANA, state: "off", rank: null }, ], "3": [], "6": [] },
    tasks: { "7d": [entry(ANA, 1, 31), entry(ME, 2, 24), entry(SAM, 3, 19), entry(KIT, 4, 6)], month: [entry(ANA, 1, 92), entry(ME, 2, 88), entry(SAM, 3, 61), entry(KIT, 4, 20)], "3m": [] },
    screen: [ME, SAM, KIT, ANA].map((m, i) => ({ member: m, state: i === 2 ? "off" : "ok", today: [14200, 9800, null, 17100][i], mac: [11000, 8000, null, 12000][i], phone: [3200, 1800, null, 5100][i], avg: [15000, 10400, null, 16000][i],
      week: [12000, 15000, 13800, 16000, 9000, 14100, 14200].map((x) => (i === 2 ? null : x + i * 900)), at: ago(3) })),
    days: Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10)),
    mine: { tz: "Asia/Dubai", on: true, months: [] }, ask: null, loaded: true,
  };
  const asks: never[] = [];   // V1.49: nobody asks to join any more (everyone is in by themselves)
  const notIn = (stage: string, error: string | null = null) => ({ in: false, loaded: true, auto: { stage, error } });
  const squad = mode === "none" || mode === "joining"
    ? notIn("joining")
    : mode === "left"
      ? notIn("left")
    : mode === "removed"
      ? notIn("removed", "The admin took you out of The G Squad.")
    : mode === "full"
      ? notIn("full", "The G Squad is full (200 people).")
    : mode === "error"
      ? notIn("error", "G Squad could not be reached. Check your internet and try again.")
    : mode === "solo"
      ? { in: true, name: "The G Squad", me: ME, meName: "Alex", creator: true, count: 1, waiting: 0, members: [members[0]], tasks: [], hands: [], link: null, busy: null, error: null, loaded: true, board, asks: [] }
      : { in: true, name: "The G Squad", me: ME, meName: "Alex", creator: true, count: 3, waiting: 1, members: p1n > 4 ? [...members, ...boardMembers.slice(4).map((m) => ({ ...m, creator: false, working: false }))] : members, tasks, p1, p1b, p1since: log.since,
        hands: [{ id: id(700), from: SAM, to: ME, state: "open", t: "Review the pricing page", d: null, at: ago(30) }], link: null, busy: null, error: null, loaded: true, board, asks };

  const day = (d: number, h: number, m: number) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  const lines = [
    { id: id(1), from: SAM, name: "Sam Rivera", mine: false, t: "Morning all. Who is in for a focus block at 10?", at: day(1, 9, 2), edited: false, left: false },
    { id: id(2), from: ANA, name: "Ana Petrova", mine: false, t: "Me, after my client call", at: day(1, 9, 5), edited: false, left: false },
    { id: id(3), from: ME, name: "Alex", mine: true, t: "In. Starting the onboarding copy", at: day(1, 9, 6), edited: false, left: false },
    { id: id(4), from: KIT, name: "Kit", mine: false, t: "I'll join at 11, gym first", at: day(1, 9, 20), edited: false, left: false },
    { id: id(5), from: SAM, name: "Sam Rivera", mine: false, t: "New bench best today", at: day(0, 8, 41), edited: false, left: false, a: { k: "gym", l: "Barbell bench press, 72.5 kg x 4" }, r: [{ e: "🔥", n: 3, mine: true, who: ["You", "Ana Petrova", "Kit"] }, { e: "💪", n: 1, mine: false, who: ["Kit"] }] },
    { id: id(6), from: SAM, name: "Sam Rivera", mine: false, t: "Felt strong. Two more weeks of this block", at: day(0, 8, 42), edited: false, left: false },
    { id: id(7), from: ME, name: "Alex", mine: true, t: "That is a big jump, nice one", at: day(0, 8, 50), edited: false, left: false, r: [{ e: "👍", n: 1, mine: false, who: ["Sam Rivera"] }] },
    { id: id(8), from: ME, name: "Alex", mine: true, t: "Handing you the pricing page review, it is in your Tasks", at: day(0, 8, 51), edited: true, left: false },
    { id: id(9), from: ANA, name: "Ana Petrova", mine: false, t: "Done with the landing page draft. 92 tasks this month, catch me if you can", at: day(0, 9, 14), edited: false, left: false },
    { id: id(10), from: SAM, name: "Sam Rivera", mine: false, t: "🎉", at: day(0, 9, 16), edited: false, left: false },
    { id: id(11), from: ME, name: "Alex", mine: true, t: "😂😂", at: day(0, 9, 17), edited: false, left: false },
    { id: id(12), from: ANA, name: "Ana Petrova", mine: false, at: day(0, 9, 30), edited: false, left: false,
      t: "Here is how my week went, in case it helps anyone. Monday I wrote the whole landing page draft and sent it to the client for a first look. Tuesday was calls all day, four of them, and I still got the pricing table done between two of them. Wednesday I fixed the checkout flow with Sam and we tested it on three phones. Thursday was the big one: the new onboarding emails went out to the whole list and the first replies came in within an hour. Friday I wrote up what worked and what did not, so the next block starts clean. " + "The part I would copy is the order. First the thing the client is waiting on, then the thing that makes money, then the thing that makes the next week easier. Everything else waits until after lunch. It sounds boring, but it is why I have 92 tasks done this month. If you want my template for the Friday write up, say so and I will share it here, it is one page and takes ten minutes. " + "One more thing, because people ask: I do not answer messages before 11. That is the whole trick. The first three hours are only for the work that cannot be done by anyone else, and I protect them like a meeting. Try it for one week and tell me what changes." },
    { id: id(13), from: ME, name: "Alex", mine: true, t: "Send the template please, and thanks for writing this up", at: day(0, 9, 41), edited: false, left: false },
  ];
  const convs = [
    { id: "squad", kind: "squad", title: "G Squad", memberIds: [ME, SAM, KIT, ANA], last: { text: "Send the template please, and thanks for writing this up", at: day(0, 9, 41), from: "You" }, unread: 2 },
    { id: "g1", kind: "group", title: "Gym crew", memberIds: [ME, SAM, KIT], last: { text: "Leg day at 18:00?", at: day(0, 8, 5), from: "Kit" }, unread: 0 },
    { id: "d1", kind: "dm", title: "Sam Rivera", memberIds: [ME, SAM], last: { text: "Can you check the pricing page before 3?", at: day(1, 17, 20), from: "Sam Rivera" }, unread: 1, avatar: SAM },
    { id: "d2", kind: "dm", title: "Ana Petrova", memberIds: [ME, ANA], last: { text: "Thanks!", at: day(4, 12, 0), from: "You" }, unread: 0, avatar: ANA },
  ];
  // &conv=d1 opens that conversation (the real view gives `lines` of the open one only); &nodm shows a hub without DMs; &note=gone or &note=leave shows the two chat notes.
  const qq = new URLSearchParams(location.search);
  const conv = convs.some((c) => c.id === qq.get("conv")) ? qq.get("conv")! : "squad";
  const dmLines = conv === "d1" ? [
    { id: id(81), from: SAM, name: "Sam Rivera", mine: false, t: "Hey, got a minute?", at: day(1, 17, 10), edited: false, left: false },
    { id: id(82), from: ME, name: "Alex", mine: true, t: "Sure, what is up?", at: day(1, 17, 12), edited: false, left: false },
    { id: id(83), from: SAM, name: "Sam Rivera", mine: false, t: "Can you check the pricing page before 3?", at: day(1, 17, 20), edited: false, left: false },
  ] : conv === "g1" ? [
    { id: id(91), from: KIT, name: "Kit", mine: false, t: "Leg day at 18:00?", at: day(0, 8, 5), edited: false, left: false },
  ] : conv === "d2" ? [{ id: id(95), from: ME, name: "Alex", mine: true, t: "Thanks!", at: day(4, 12, 0), edited: false, left: false }] : lines;
  const hasDm = !qq.has("nodm");
  const noteText = qq.get("chatnote") === "gone" ? "A message was not sent because that chat is gone." : qq.get("chatnote") === "leave" ? "You cannot leave a private message." : null;
  const chat = { convs: hasDm ? convs : [convs[0]], activeConv: hasDm ? conv : "squad", dm: hasDm, members: members.map((m) => ({ id: m.id, name: m.me ? "You" : m.name, me: m.me, left: false, ...((m as { pic?: string }).pic ? { pic: (m as { pic?: string }).pic } : {}) })), in: !["none", "joining", "left", "removed", "full", "error"].includes(mode), ready: true, open: true, unread: 2, lines: hasDm ? dmLines : lines, more: false, votes: [], note: null, sound: false, notify: true, notifyOn: true, noteSound: true, sending: 0, error: noteText, loaded: true, gif: { on: true, q: "", items: [], next: null, busy: false, failed: false } };

  setTimeout(() => {
    setSquadMirror(squad);
    setChatMirror(chat);
    const q = new URLSearchParams(location.search);
    // &note: the website's G Squad message card (views/SquadNoteCards.tsx, PS 1.60) with a made up message (dev page /client/dev?fake&note).
    if (q.has("note")) void Promise.all([import("../squad/chatengine"), import("../core/squadnotify")]).then(([e, n]) => {
      e.devShowNote(n.noteCard({ id: id(50), from: SAM, name: "Sam Rivera", t: "Landing page is live. Can you check the pricing section before 3?", at: new Date().toISOString() }));
    });
    if (q.has("open") || (globalThis as { __psMobile?: unknown }).__psMobile === true) void import("../views/GSquad").then((g) => g.openGSquad(true, q.get("gstab") || undefined));
    if (mode === "in" || mode === "asks") {
      loadGymFake();
      const push = () => setGymMirror(gymStore.get());
      gymStore.subscribe(push);
      push();
    }
  }, 700);
}
