// Unit tests for the G Squad message card's page code (Sources/SquadMessageCard.swift, PS 1.60): Open, Dismiss, the Reply box,
// Send with a short Undo, Esc and Cancel, the typing keyboard, and a card that leaves while a Send waits. Reads the script out of
// the Swift file and runs it against tiny fake elements: no page, no window, no Mac. Made up words only.
// Run: node tests/squad-message-card-test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "Sources", "SquadMessageCard.swift"), "utf8");
const raw = (n) => { const i = src.indexOf('#"""', src.indexOf(n)) + 4; return src.slice(i, src.indexOf('"""#', i)); };
const js = raw("static let js"), css = raw("static let css");
let passed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("ok -", name); } else { console.log(`FAIL - ${name}`); process.exit(1); } }

// Tiny fake DOM: elements with children, dataset, listeners, closest().
function mk(tag, cls = "") {
  const n = { tagName: tag.toUpperCase(), className: cls, dataset: {}, style: {}, kids: [], parentNode: null, listeners: {}, textContent: "", value: "", focused: false };
  n.classList = { contains: (x) => n.className.split(" ").includes(x) };
  n.appendChild = (k) => { k.parentNode = n; n.kids.push(k); return k; };
  n.removeChild = (k) => { n.kids = n.kids.filter((x) => x !== k); k.parentNode = null; };
  n.replaceChild = (nw, old) => { n.kids = n.kids.map((x) => (x === old ? nw : x)); nw.parentNode = n; old.parentNode = null; };
  n.addEventListener = (t, f) => { (n.listeners[t] ||= []).push(f); };
  n.setAttribute = () => {};
  n.focus = () => { n.focused = true; };
  n.setSelectionRange = () => {};
  n.closest = (sel) => { for (let x = n; x; x = x.parentNode) { if (sel.startsWith(".") ? x.classList.contains(sel.slice(1)) : x.tagName === sel.toUpperCase()) return x; } return null; };
  n.find = (pred) => { for (const k of n.kids) { if (pred(k)) return k; const f = k.find(pred); if (f) return f; } return null; };
  return n;
}
const el = (tag, cls, text) => { const e = mk(tag, cls || ""); if (text != null) e.textContent = text; return e; };

let posted = [], answers = [], removed = [], laid = 0, held = 0;
const post = (m) => posted.push(m);
const answer = (c, a) => answers.push([c.data.id, a]);
const remove = (c) => { if (SquadMsg.hold(c)) { held++; return; } removed.push(c.data.id); SquadMsg.gone(c); };   // like Toast's remove()
const layout = () => { laid++; };
const ICON = {};
let now = 1_000_000;
const realNow = Date.now; Date.now = () => now;
const timers = []; let tid = 0;
const setIntervalF = (f) => { timers.push({ id: ++tid, f }); return tid; };
const clearIntervalF = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
const lates = [];
const setTimeoutF = (f, ms) => { lates.push({ at: now + ms, f }); return lates.length; };
const advance = (ms) => { for (let s = 0; s < ms; s += 250) { now += 250; [...timers].forEach((t) => t.f()); for (const l of [...lates]) if (l.at <= now) { lates.splice(lates.indexOf(l), 1); l.f(); } } };
const SquadMsg = new Function("ICON", "el", "post", "answer", "remove", "layout", "setInterval", "clearInterval", "setTimeout", `${js}\nreturn SquadMsg;`)(ICON, el, post, answer, remove, layout, setIntervalF, clearIntervalF, setTimeoutF);

// Built in Toast's own order (Toast.swift add): the buttons are drawn first, and only then is their row put into the card.
// PS 1.73: the test used to put the row in first, which hid that the real card's Reply box had nowhere to go.
function card(id = "g:11111111-2222-4333-8444-555555555555") {
  const full = el("div", "full"), mb = el("div", "acts");
  const c = { data: { id, tone: "squad" } };
  SquadMsg.buttons(c, mb);
  full.appendChild(mb);
  return { c, full, mb };
}
const btn = (root, sq) => root.find((x) => x.tagName === "BUTTON" && x.dataset.sq === sq);
const press = (c, root, sq) => SquadMsg.click(c, btn(root, sq));
const reset = () => { posted = []; answers = []; removed = []; laid = 0; held = 0; };

ok("the icon is a fixed path and the style sheet has no url or import", typeof ICON.chat === "string" && ICON.chat.startsWith("<path") && !/url\(|@import/.test(css));
ok("the script never writes HTML", !/innerHTML|outerHTML|insertAdjacentHTML/.test(js));

{ reset(); const { c, mb } = card();
  ok("three buttons: Open, Reply, Dismiss", mb.kids.map((b) => b.textContent).join("|") === "Open|Reply|Dismiss");
  ok("Open answers open and the card goes", press(c, mb, "open") && answers[0][1] === "open" && removed.length === 1);
}
{ reset(); const { c, mb } = card();
  ok("Dismiss answers dismiss and the card goes", press(c, mb, "dismiss") && answers[0][1] === "dismiss" && removed.length === 1);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply");
  const box = full.kids.find((k) => k.className === "sqbox");
  ok("PS 1.73 (the developer): one click on Reply puts the box on the card, under the buttons' row", !!box && !!box.find((x) => x.tagName === "TEXTAREA") && box === c.sqBox);
  SquadMsg.close(c);
}
{ reset(); const c = { data: { id: "g:x", tone: "squad" } }, mb = el("div", "acts");
  SquadMsg.buttons(c, mb);   // a row that is not on a card: Reply must never hide the buttons and show nothing
  let threw = false; try { SquadMsg.click(c, btn(mb, "reply")); } catch { threw = true; }
  ok("PS 1.73: with nowhere to put the box, Reply leaves the buttons as they were", !threw && !c.sqOpen && mb.style.display !== "none" && !posted.length);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply");
  ok("PS 1.73: the source keeps no box place from before the row was on the card", !/sqFull/.test(js) && /host:function\(c\)\{return c\.sqActs&&c\.sqActs\.parentNode\|\|null\}/.test(js));
  SquadMsg.close(c);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply");
  ok("Reply opens a box, hides the buttons and asks for the keyboard", c.sqOpen && mb.style.display === "none" && posted.some((m) => m.type === "typing" && m.on === true) && !!c.sqTa);
  ok("the box takes the keyboard when Swift asks (focus)", (SquadMsg.focus(), c.sqTa.focused));
  c.sqTa.value = "on my way";
  press(c, full, "send");
  ok("Send starts the Undo and sends nothing yet", c.sqUndo && !posted.some((m) => m.type === "sqreply") && !!btn(full, "undo"));
  ok("the keyboard goes back while the Undo runs", posted.filter((m) => m.type === "typing").at(-1).on === false);
  advance(2000);
  ok("still nothing after 2 seconds", !posted.some((m) => m.type === "sqreply") && c.sqUntil > now);
  ok("the words count down", /Sending in \d s/.test(full.find((x) => x.className === "say").textContent));
  advance(3250);
  const sent = posted.filter((m) => m.type === "sqreply");
  ok("when the Undo runs out the page gets the words, once, and the card goes", sent.length === 1 && sent[0].text === "on my way" && sent[0].id === c.data.id && removed.length === 1);
  advance(5000);
  ok("nothing more is sent later", posted.filter((m) => m.type === "sqreply").length === 1 && timers.length === 0);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "wrong chat"; press(c, full, "send"); advance(1500);
  press(c, full, "undo");
  ok("Undo brings the words back into the box and the keyboard", c.sqTa && c.sqTa.value === "wrong chat" && !c.sqUndo && posted.filter((m) => m.type === "typing").at(-1).on === true);
  advance(10000);
  ok("after Undo nothing is ever sent", !posted.some((m) => m.type === "sqreply") && removed.length === 0);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "x";
  SquadMsg.esc();
  ok("Esc closes the box, the buttons come back, nothing is sent, the card stays", !c.sqOpen && mb.style.display === "" && !posted.some((m) => m.type === "sqreply") && removed.length === 0 && !c.sqBox);
  press(c, mb, "reply"); press(c, full, "cancel");
  ok("Cancel closes it too", !c.sqOpen && mb.style.display === "");
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "x"; press(c, full, "send"); advance(1000);
  SquadMsg.esc();
  ok("Esc during the Undo cancels the reply", !posted.some((m) => m.type === "sqreply") && timers.length === 0 && !c.sqOpen);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply");
  press(c, full, "send");
  ok("Send with nothing typed does nothing", !c.sqUndo && !!c.sqTa);
  c.sqTa.value = "   "; press(c, full, "send");
  ok("Send with only spaces does nothing", !c.sqUndo);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "hi";
  c.sqTa.listeners.keydown[0]({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {}, stopPropagation() {} });
  ok("Enter sends (starts the Undo), Shift+Enter does not", c.sqUndo);
  press(c, full, "undo");
  c.sqTa.listeners.keydown[0]({ key: "Enter", shiftKey: true, isComposing: false, preventDefault() {}, stopPropagation() {} });
  ok("Shift+Enter is a new line, not a send", !c.sqUndo);
  c.sqTa.listeners.keydown[0]({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("Escape in the box closes it", !c.sqOpen);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "keep going"; press(c, full, "send"); advance(1000);
  remove(c);   // asked to leave during the Undo (a swipe, another device read the chat)
  ok("a card asked to leave during the Undo stays, nothing is sent yet", held === 1 && removed.length === 0 && !posted.some((m) => m.type === "sqreply") && c.sqUndo);
  advance(3000);
  ok("still waiting before the Undo time is up", !posted.some((m) => m.type === "sqreply"));
  advance(1500);
  ok("sent once when the Undo time is up, and then the card goes", posted.filter((m) => m.type === "sqreply").length === 1 && removed.length === 1 && timers.length === 0);
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "wait for it"; press(c, full, "send"); advance(1000);
  remove(c); press(c, full, "undo");
  ok("Undo on a held card still works: nothing is sent, the box is back", !posted.some((m) => m.type === "sqreply") && !c.sqUndo && !!c.sqTa && c.sqTa.value === "wait for it");
  advance(10000);
  ok("and nothing goes later either", !posted.some((m) => m.type === "sqreply"));
}
{ reset(); const { c, full, mb } = card();
  press(c, mb, "reply"); c.sqTa.value = "moved stack"; press(c, full, "send"); advance(1000);
  SquadMsg.gone(c);   // the card is really gone (it moved to the other stack)
  ok("a card really gone during the Undo does not send at once", !posted.some((m) => m.type === "sqreply"));
  advance(4500);
  ok("it sends once, when the Undo time is up", posted.filter((m) => m.type === "sqreply").length === 1 && posted.find((m) => m.type === "sqreply").text === "moved stack");
}
{ reset(); const { c, mb } = card();
  press(c, mb, "reply"); SquadMsg.gone(c);
  ok("a card that leaves with an open box sends nothing and gives the keyboard back", !posted.some((m) => m.type === "sqreply") && posted.at(-1).type === "typing" && posted.at(-1).on === false && SquadMsg.cur === null);
}
{ reset(); const a = card("g:aaaaaaaa-2222-4333-8444-555555555555"), b = card("g:bbbbbbbb-2222-4333-8444-555555555555");
  press(a.c, a.mb, "reply"); press(b.c, b.mb, "reply");
  ok("only one reply box is open at a time", !a.c.sqOpen && b.c.sqOpen && SquadMsg.cur === b.c);
}
{ reset(); const { c } = card();
  const t = mk("span"); 
  ok("a click on the words (not a button) is left to the card", SquadMsg.click(c, t) === false);
  const box = el("div", "sqbox"), inner = el("p"); box.appendChild(inner);
  ok("a click inside the box is the box's own", SquadMsg.click(c, inner) === true);
}
Date.now = realNow;
console.log(`\n${passed} checks passed`);
