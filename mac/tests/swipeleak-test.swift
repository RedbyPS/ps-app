// Unit tests for the PS 1.73 swipe leak (Sources/SwipeLeakCore.swift), plus source checks that the wiring keeps every
// old behaviour when the Tab list is not up or no sideways gesture runs. Run: bash tests/swipeleak-test.sh
import Foundation

var passed = 0
func ok(_ name: String, _ cond: Bool) {
  if cond { passed += 1; print("ok - \(name)") } else { print("FAIL - \(name)"); exit(1) }
}
typealias W = SwipeLeakCore.Wheel
let B = SwipeLeakCore.began, C = SwipeLeakCore.changed, E = SwipeLeakCore.ended, M = SwipeLeakCore.mayBegin
func w(_ phase: UInt = 0, _ mom: UInt = 0, _ dx: Double = 0, _ dy: Double = 0, _ t: Double, precise: Bool = true) -> W {
  W(phase: phase, momentum: mom, dx: dx, dy: dy, t: t, precise: precise)
}

// ---------- 1. card route ----------
do {
  // List up, a sideways swipe right over a card: the start goes to both, every move and the glide to the list only.
  var r = SwipeLeakCore.CardRoute()
  ok("list up: fingers down before any move go to both", r.route(w(M, 0, 0, 0, 0.00), listUp: true) == .both && r.route(w(B, 0, 0, 0, 0.01), listUp: true) == .both)
  ok("list up: a first move sideways (right) goes to the list", r.route(w(C, 0, 12, 1, 0.02), listUp: true) == .list)
  ok("list up: later moves stay with the list even if they drift down", r.route(w(C, 0, 1, 9, 0.03), listUp: true) == .list)
  ok("list up: the fingers lift and the glide go to the list", r.route(w(E, 0, 0, 0, 0.05), listUp: true) == .list && r.route(w(0, B, 8, 0, 0.06), listUp: true) == .list && r.route(w(0, C, 3, 0, 0.08), listUp: true) == .list && r.route(w(0, E, 0, 0, 0.30), listUp: true) == .list)
  ok("list up: left first goes to the list too", { var r2 = SwipeLeakCore.CardRoute(); _ = r2.route(w(B, 0, 0, 0, 1), listUp: true); return r2.route(w(C, 0, -10, 2, 1.01), listUp: true) == .list }())
}
do {
  // List up, up or down first: the cards keep it (the stack scrolls, Remind me in changes).
  var r = SwipeLeakCore.CardRoute()
  _ = r.route(w(B, 0, 0, 0, 0), listUp: true)
  ok("list up: a first move up or down stays with the cards", r.route(w(C, 0, 1, -8, 0.01), listUp: true) == .cards)
  ok("list up: a vertical gesture that drifts sideways stays with the cards", r.route(w(C, 0, 15, 2, 0.02), listUp: true) == .cards)
  ok("list up: its fingers lift (no move) goes to both, so the list hears the end of the start it heard", r.route(w(E, 0, 0, 0, 0.04), listUp: true) == .both)
  ok("list up: its glide stays with the cards", r.route(w(0, B, 0, -5, 0.05), listUp: true) == .cards)
  ok("a new gesture decides again", { _ = r.route(w(B, 0, 0, 0, 2), listUp: true); return r.route(w(C, 0, 9, 0, 2.01), listUp: true) == .list }())
}
do {
  // The list hidden: exactly as before 1.73, the cards get every event, sideways included.
  var r = SwipeLeakCore.CardRoute()
  ok("list hidden: everything goes to the cards (sideways dismiss as always)", r.route(w(B, 0, 0, 0, 0), listUp: false) == .cards && r.route(w(C, 0, 14, 0, 0.01), listUp: false) == .cards && r.route(w(E, 0, 0, 0, 0.03), listUp: false) == .cards && r.route(w(0, B, 9, 0, 0.04), listUp: false) == .cards)
  ok("the list going away mid gesture hands the rest back to the cards", { var r2 = SwipeLeakCore.CardRoute(); _ = r2.route(w(B, 0, 0, 0, 5), listUp: true); _ = r2.route(w(C, 0, 9, 0, 5.01), listUp: true); return r2.route(w(C, 0, 9, 0, 5.02), listUp: false) == .cards }())
}
do {
  // A plain mouse wheel (no phases): a rest of 180 ms starts a new decision.
  var r = SwipeLeakCore.CardRoute()
  ok("mouse wheel: up or down goes to the cards", r.route(w(0, 0, 0, -3, 0, precise: false), listUp: true) == .cards)
  ok("mouse wheel: still the same gesture within 180 ms", r.route(w(0, 0, 3, 0, 0.1, precise: false), listUp: true) == .cards)
  ok("mouse wheel: after a rest a sideways wheel goes to the list", r.route(w(0, 0, 3, 0, 0.5, precise: false), listUp: true) == .list)
}

// ---------- 2. glide watch ----------
do {
  var g = SwipeLeakCore.GlideWatch()
  ok("nothing yet: no hold", g.holdOnHide(0) == nil)
  g.feed(w(B, 0, 0, 0, 0)); g.feed(w(C, 0, 10, 1, 0.01))
  ok("fingers on a sideways swipe: hold, capped at 1.2 s", g.holdOnHide(0.02) == SwipeLeakCore.cap && SwipeLeakCore.cap == 1.2)
  g.feed(w(E, 0, 0, 0, 0.05))
  ok("fingers just lifted: still held (the glide starts within a frame or two)", g.live(0.10))
  ok("fingers lifted and no glide came: over", !g.live(0.25))
  g.feed(w(0, B, 9, 0, 0.12)); g.feed(w(0, C, 5, 0, 0.20))
  ok("the glide running: held", g.live(0.30) && g.holdOnHide(0.30) != nil)
  ok("the glide gone quiet (no event for 0.25 s): over, so a stale state never holds later", !g.live(0.50))
  g.feed(w(0, C, 2, 0, 0.60)); g.feed(w(0, E, 0, 0, 0.70))
  ok("the glide ended: no hold", !g.live(0.71) && g.holdOnHide(0.71) == nil)
}
do {
  var g = SwipeLeakCore.GlideWatch()
  g.feed(w(B, 0, 0, 0, 0)); g.feed(w(C, 0, 1, -10, 0.01))
  ok("an up or down scroll is never held (only sideways swipes are)", g.holdOnHide(0.02) == nil)
  g.feed(w(B, 0, 0, 0, 1)); g.feed(w(C, 0, -9, 0, 1.01))
  ok("the next gesture, sideways, is", g.holdOnHide(1.02) != nil)
}
do {
  var g = SwipeLeakCore.GlideWatch()
  g.feed(w(0, 0, 9, 0, 0, precise: false))
  ok("a plain mouse wheel is never held", g.holdOnHide(0.01) == nil)
}

// ---------- source checks: the wiring keeps every old path ----------
let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Sources"
func src(_ f: String) -> String { (try? String(contentsOfFile: "\(dir)/\(f)", encoding: .utf8)) ?? "" }
let main = src("main.swift"), toast = src("Toast.swift"), page = src("PageSwipe.swift"), leak = src("SwipeLeak.swift"), core = src("SwipeLeakCore.swift")
ok("sources found", !main.isEmpty && !toast.isEmpty && !page.isEmpty && !leak.isEmpty && !core.isEmpty)
let mine = leak + core
ok("nothing posted to the system: no CGEvent post, no event tap, no global monitor in the new files", !mine.contains(".post(") && !mine.contains("tapCreate") && !mine.contains("addGlobalMonitor") && !mine.contains("CGEventPost"))
ok("handToList never posts either: it sends through the list's own window or view", { () -> Bool in
  guard let r = main.range(of: "func handToList(_ e: NSEvent)") else { return false }
  let body = String(main[r.lowerBound...].prefix(1400))
  return body.contains("panel.sendEvent(ev)") && body.contains("overlay.scrollWheel(with: ev)") && !body.contains(".post(") && body.contains("guard shown, !selfTest")
}())
ok("PageSwipe still never swallows or changes an event (returns each one as it came)", page.contains("heard(e, web)\n      return e") && page.components(separatedBy: "return nil").count == 2)   // the one return nil is phaseLetter's
ok("the card route asks whether the list is up every event, and the list hidden returns the cards' event untouched", toast.contains("let listUp = Toast.shared.listWindow() != nil") && toast.contains("case .cards: return e") && core.contains("guard listUp else { owner = nil; return .cards }"))
ok("only a .list route takes an event away from the cards", toast.contains("case .list: Toast.handToList?(e); return nil") && toast.contains("case .both: Toast.handToList?(e); return e"))
ok("a self test copy of the cards never routes", toast.contains("guard routeMonitor == nil, !Toast.testCopy"))
ok("the island stack is still ordered behind the list (island clearance unchanged)", toast.contains("if role == .island, let list = Toast.shared.listWindow(), list.isVisible { panel.order(.below, relativeTo: list.windowNumber) }"))
ok("hiding with no sideways gesture running goes click through at once, as before", main.contains("} else {\n      panel.ignoresMouseEvents = true\n    }\n    clickThrough = true"))
ok("the hold is never used in a self test", main.contains("if !selfTest, let hold = SwipeLeak.glide.holdOnHide(SwipeLeak.now)"))
ok("the hold ends click through and tucked, and only while the list is still hidden", main.contains("guard let self, !self.shown else { return }\n        self.panel.ignoresMouseEvents = true"))
ok("the fade still tucks the window when no hold runs", main.contains("if !self.glideHold.active { self.tuck() }"))
ok("showing the list again cancels a hold first", main.contains("func showOverlay() {\n    glideHold.stop()"))
ok("the hold ends on a click, a new gesture, the gesture's end or the cap", leak.contains("if SwipeLeakCore.starts(w) { self.finish(); return nil }") && leak.contains("if !SwipeLeak.glide.live(w.t) { self.finish() }") && leak.contains("t - self.startedAt >= secs"))
ok("the hold only touches the list's own window", leak.contains("guard let self, let window, e.window === window else { return e }"))
ok("Keep overlay click through is untouched", main.contains("panel.ignoresMouseEvents = selfTest || !onList"))
ok("the keyboard tap is still keys only (no scroll tap added)", main.contains("let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)"))
ok("1Password and Signal: the hold and the hand over never take the keyboard", !leak.contains("makeKey") && !leak.contains("activate"))
print("\(passed) of \(passed) ok")
