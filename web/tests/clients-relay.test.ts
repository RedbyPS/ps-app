// Run: node --experimental-strip-types tests/clients-relay.test.ts
// PS 1.74 check: every Clients save in the Mac's Tab list goes to the main page as an op (core/clientsop.ts). The Tab list
// answers at once (the relay resolves before the main page has run it, and the screen says "added" or "removed"), but the Mac
// passed it on with sendToMain, which has no answer and no retry: while the main page loads (an update reload, a wake, the
// reload for a new web build) window.__ps is not there and the save was dropped without a word. main.swift says so itself
// for card answers (sendCardAction). Clients ops now go the same way. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../../mac/Sources/main.swift", import.meta.url), "utf8");
const at = m.indexOf('"looks" where fromOverlay:\n');
assert.ok(at > 0, "the Tab list's looks case is there");
const body = m.slice(at, m.indexOf("case \"timeline:get\"", at));
// sendToMain: no completion handler, so nothing knows the save never arrived.
assert.match(m, /func sendToMain\(_ json: String\) \{\n\s*main\.callAsyncJavaScript\([^\n]*completionHandler: nil\)/);
assert.match(m, /func sendCardAction\(_ json: String\) \{ cardSend\.send\(json\) \}/);
assert.match(body, /\["clientsOp"\]\) != nil \{ sendCardAction\(text\) \} else \{ sendToMain\(text\) \}/, "a Clients op is tried again while the main page loads");
// The retry only runs once window.__ps answers, so an op is never run twice.
assert.match(m, /if \(!window\.__ps\) return false; window\.__ps\.apply\(JSON\.parse\(m\)\); return true/);
assert.match(m, /asyncAfter\(deadline: \.now\(\) \+ 10\) \{ if !answered/, "a page that never answers lets the queue go on after 10 s");
console.log("ok - a Clients save from the Tab list is tried again while the main page loads, never dropped\n1 passed");
