// Unit tests for the AI message card's page code (V1.58, Sources/AiMessageCard.swift): the detail opens and folds on a
// click on the words, buttons keep their own jobs, a short detail gets no "Read more", and nothing is written as HTML.
// Reads the script straight out of the Swift file and runs it against tiny fake elements: no page, no window, no Mac.
// Run: node tests/aimessage-card-test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "Sources", "AiMessageCard.swift"), "utf8");
const raw = (n) => { const i = src.indexOf('#"""', src.indexOf(n)) + 4; return src.slice(i, src.indexOf('"""#', i)); };
const js = raw("static let js"), css = raw("static let css");
let passed = 0;
function ok(name, cond) { if (cond) { passed++; } else { console.log(`FAIL - ${name}`); process.exit(1); } }

// Tiny fakes: a class list, closest() by tag or class, and the "words" element with a measured height.
function cls() { const s = new Set(); return { contains: (x) => s.has(x), toggle: (x) => (s.has(x) ? s.delete(x) : s.add(x)), add: (x) => s.add(x) }; }
function node(tag, classes = [], parent = null) {
  const n = { tagName: tag.toUpperCase(), className: classes.join(" "), classList: cls(), parentNode: parent, kids: [], textContent: "", dataset: {} };
  n.appendChild = (k) => { k.parentNode = n; n.kids.push(k); };
  classes.forEach((c) => n.classList.add(c));
  n.closest = (sel) => { for (let x = n; x; x = x.parentNode) { if (sel.startsWith(".") ? x.classList.contains(sel.slice(1)) : x.tagName === sel.toUpperCase()) return x; } return null; };
  n.insertBefore = (k) => { k.parentNode = n; n.kids.push(k); };
  return n;
}
function card(scrollH, clientH) {
  const el = node("div", ["card", "meet", "t-ai"]);
  const inner = node("div", ["in"], el), full = node("div", ["full"], inner), b = node("div", ["b"], full), acts = node("div", ["acts"], full), btn = node("button", ["dis"], acts);
  b.scrollHeight = scrollH; b.clientHeight = clientH; b.nextSibling = acts;
  inner.querySelector = (q) => (q === ".b" ? b : null);
  return { c: { el, inner }, b, btn, acts };
}
const ICON = {};
const fakeDoc = { createElement: (t) => node(t) };
const make = new Function("ICON", "document", "requestAnimationFrame", `${js}\nreturn AiMsg;`);
const AiMsg = make(ICON, fakeDoc, (f) => f());

ok("the icon is a fixed path", typeof ICON.ai === "string" && ICON.ai.startsWith("<path"));
ok("the script never writes HTML", !/innerHTML|outerHTML|insertAdjacentHTML/.test(js));
ok("the style sheet has no url or import", !/url\(|@import/.test(css));

// A long detail: "Read more", a click opens it ("Show less"), another folds it.
const long = card(200, 60);
AiMsg.made(long.c);
ok("a long detail gets Read more", long.c.aiMore && long.c.aiMore.textContent === "Read more");
ok("a click on the words opens it", AiMsg.click(long.c, long.b) === true && long.c.el.classList.contains("open") && long.c.aiMore.textContent === "Show less");
ok("another click folds it", AiMsg.click(long.c, long.b) === true && !long.c.el.classList.contains("open") && long.c.aiMore.textContent === "Read more");
ok("a click on a button is the button's", AiMsg.click(long.c, long.btn) === false && !long.c.el.classList.contains("open"));
ok("a click in the buttons row is the row's", AiMsg.click(long.c, long.acts) === false);
AiMsg.made(long.c);
ok("Read more is made once", long.b.parentNode.kids.filter((k) => k.className === "more").length === 1);

// A short detail (it all fits): nothing to open.
const short = card(40, 40);
AiMsg.made(short.c);
ok("a short detail gets no Read more", !short.c.aiMore);
ok("a click on a short one does nothing", AiMsg.click(short.c, short.b) === false && !short.c.el.classList.contains("open"));

// No detail at all.
const none = { el: node("div", ["card", "t-ai"]), inner: { querySelector: () => null } };
AiMsg.made(none);
ok("no detail: nothing made, nothing opens", !none.aiMore && AiMsg.click(none, node("div")) === false);

// PS 1.74 Mark done: only when the page said so, first and main, sending "done", words as text.
const withDone = card(40, 40); withDone.c.data = { tone: "ai", markDone: true };
const row = node("div", ["acts"]);
AiMsg.buttons(withDone.c, row);
const md = row.kids[0];
ok("markDone: one Mark done button", row.kids.length === 1 && md.tagName === "BUTTON" && md.textContent === "Mark done");
ok("Mark done sends the action done and looks like the main button", md.dataset.act === "done" && md.className.split(" ").includes("main"));
ok("a click on Mark done is the button's, not the words'", AiMsg.click(withDone.c, md) === false);
for (const d of [{ tone: "ai" }, { tone: "ai", markDone: "true" }, { tone: "ai", markDone: 1 }, undefined]) {
  const r = node("div", ["acts"]); AiMsg.buttons({ data: d }, r);
  ok(`no Mark done without markDone true (${JSON.stringify(d)})`, r.kids.length === 0);
}
const swift = src;
ok("the Swift side lets markDone through for AI messages only", /static func markDone\(tone: String, _ v: Any\?\) -> Bool \{ tone == Self.tone && \(v as\? Bool\) == true \}/.test(swift));
ok("the label and action match the page (core/aimessage.ts AI_MSG_DONE)", swift.includes('doneLabel = "Mark done", doneAction = "done"') && js.includes("'Mark done'") && js.includes("dataset.act='done'"));

console.log(`${passed} AI message card checks passed`);
