import Foundation

// Unit tests for ClickMachine with made up event sequences. build.sh runs them before every
// build and stops if one fails. Run alone: ./build.sh test
//
// The Sim below plays the part of macOS: it records what the app under the cursor would get,
// in order, and feeds the events PSMiddleClicker posts back through the tap (as macOS does),
// either at once or later (to check nothing overtakes a posted event).

var failures = 0
var checks = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  checks += 1
  if !ok { failures += 1; print("FAIL (line \(line)): \(what)") }
}

struct Sim {
  var m = ClickMachine()
  var t = 0.0
  /// What the app under the cursor receives, in order.
  var got: [String] = []
  /// Posted events not yet back through the tap.
  var pending: [String] = []
  /// false: posted events stay pending until pump() (a slow trip through macOS).
  var instant = true

  init(_ f: Firmness = .normal) { m.firmness = f }

  mutating func send(_ i: ClickMachine.Input, after dt: Double = 0.01) {
    t += dt
    let name = Sim.name(i)
    switch m.handle(i, at: t) {
    case .pass: if let name { got.append(name) }
    case .drop: break
    case .post(let outs): pending += outs.map { Sim.name($0, current: name) }
    }
    if instant { pump() }
  }
  mutating func tick(at time: Double) {
    t = time
    if case .post(let outs) = m.handle(.tick, at: t) { pending += outs.map { Sim.name($0, current: nil) } }
    if instant { pump() }
  }
  mutating func pump() {
    while !pending.isEmpty {
      let e = pending.removeFirst()
      check(m.handle(.ownEvent, at: t) == .pass, "own event passes")
      got.append(e)
    }
  }
  // Downs and ups only (drags and pressure are noise for most checks).
  var clicks: [String] { got.filter { $0.hasSuffix("down") || $0.hasSuffix("up") } }

  static func name(_ i: ClickMachine.Input) -> String? {
    switch i {
    case .leftDown: return "L down"
    case .leftDragged: return "L drag"
    case .leftUp: return "L up"
    case .pressure(let s, _, _): return "pressure \(s)"
    case .quickLook: return "quick look"
    case .ownEvent, .tick: return nil
    }
  }
  static func name(_ o: ClickMachine.Out, current: String?) -> String {
    switch o {
    case .current: return current ?? "?"
    case .held: return "L down"
    case .heldUp: return "L up"
    case .middleDown: return "M down"
    case .middleDrag: return "M drag"
    case .middleUp, .middleUpSynth: return "M up"
    }
  }
}

func test(_ name: String, _ body: () -> Void) {
  let before = failures
  body()
  print(failures == before ? "ok    \(name)" : "FAILED \(name)")
}

test("plain click: left down and up arrive, in order") {
  var s = Sim()
  s.send(.leftDown(x: 100, y: 100))
  check(s.got.isEmpty, "down is held back until we know")
  s.send(.pressure(stage: 1, pressure: 0.4, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "L up"], "got \(s.got)")
  check(s.m.state == .idle, "back to idle")
}

test("tap to click (no pressure events at all)") {
  var s = Sim()
  s.send(.leftDown(x: 5, y: 5)); s.send(.leftUp, after: 0.002)
  check(s.got == ["L down", "L up"], "got \(s.got)")
}

test("drag: tiny jitter is ignored, a real move gives the click back at once") {
  var s = Sim()
  s.send(.leftDown(x: 100, y: 100))
  s.send(.leftDragged(x: 101, y: 102))
  check(s.got.isEmpty, "jitter inside 4 points still held")
  s.send(.leftDragged(x: 108, y: 100))
  check(s.got == ["L down", "L drag"], "got \(s.got)")
  s.send(.leftDragged(x: 130, y: 100))
  s.send(.pressure(stage: 2, pressure: 0.5, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "L drag", "L drag", "pressure 2", "L up"], "a drag stays a drag even if pressed hard later: \(s.got)")
}

test("text selection with pressure wobbling in stage 1") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 1, pressure: 0.3, transition: 0.1))
  s.send(.leftDragged(x: 20, y: 0))
  s.send(.pressure(stage: 1, pressure: 0.6, transition: 0.2))
  s.send(.leftDragged(x: 60, y: 2))
  s.send(.leftUp)
  check(s.clicks == ["L down", "L up"], "got \(s.got)")
  check(!s.got.contains { $0.hasPrefix("M") }, "no middle anything")
}

test("Force Touch press: a middle click, no left click, no Look Up") {
  var s = Sim()
  s.send(.leftDown(x: 300, y: 200))
  s.send(.pressure(stage: 1, pressure: 0.7, transition: 0.3))
  s.send(.pressure(stage: 2, pressure: 0.05, transition: 0))
  check(s.got == ["M down"], "middle down at the deep click: \(s.got)")
  s.send(.pressure(stage: 2, pressure: 0.4, transition: 0))
  s.send(.quickLook)
  s.send(.pressure(stage: 1, pressure: 0.2, transition: -0.5))
  s.send(.leftUp)
  check(s.got == ["M down", "M up"], "middle up when the finger lifts: \(s.got)")
  check(s.m.state == .idle, "idle after")
}

test("Force Touch press then drag: a middle drag") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  s.send(.leftDragged(x: 50, y: 0))
  s.send(.leftUp)
  check(s.got == ["M down", "M drag", "M up"], "got \(s.got)")
}

test("press then drag (not firm yet): normal drag") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 1, pressure: 0.9, transition: 0.4))
  s.send(.leftDragged(x: 0, y: 30))
  s.send(.pressure(stage: 2, pressure: 0.2, transition: 0))
  s.send(.leftDragged(x: 0, y: 60))
  s.send(.leftUp)
  check(s.clicks == ["L down", "L up"], "got \(s.got)")
  check(s.got.contains("pressure 2"), "a later deep press goes to the app as usual")
}

test("fast double click, with posted events slow to come back") {
  var s = Sim()
  s.instant = false
  s.send(.leftDown(x: 10, y: 10))
  s.send(.leftUp, after: 0.06)
  s.send(.leftDown(x: 10, y: 10), after: 0.05)
  s.send(.leftUp, after: 0.06)
  s.pump()
  check(s.got == ["L down", "L up", "L down", "L up"], "got \(s.got)")
}

test("fast double click, posted events back at once") {
  var s = Sim()
  for _ in 0..<2 { s.send(.leftDown(x: 10, y: 10), after: 0.05); s.send(.leftUp, after: 0.05) }
  check(s.got == ["L down", "L up", "L down", "L up"], "got \(s.got)")
}

test("nothing overtakes a posted event (middle down still on its way)") {
  var s = Sim()
  s.instant = false
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  s.send(.leftDragged(x: 10, y: 0))
  s.send(.leftUp)
  check(s.got.isEmpty, "all queued behind the middle down")
  s.pump()
  check(s.got == ["M down", "M drag", "M up"], "got \(s.got)")
}

test("long press held still: left down goes out after the hold time") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.tick(at: 0.3)
  check(s.got.isEmpty, "still waiting at 0.3 s")
  s.tick(at: 0.62)
  check(s.got == ["L down"], "released at 0.6 s: \(s.got)")
  s.send(.pressure(stage: 2, pressure: 0.3, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "pressure 2", "L up"], "late deep press is the Mac's own (Look Up): \(s.got)")
}

test("long press: finger lifts just as the timer fires (up must not beat the down)") {
  var s = Sim()
  s.instant = false
  s.send(.leftDown(x: 0, y: 0))
  s.tick(at: 0.61)
  s.send(.leftUp, after: 0.001)
  s.pump()
  check(s.got == ["L down", "L up"], "got \(s.got)")
}

test("firmness Light fires before the deep click, Normal at it, Firm after it") {
  var l = Sim(.light)
  l.send(.leftDown(x: 0, y: 0))
  l.send(.pressure(stage: 1, pressure: 0.8, transition: 0.3))
  check(l.got.isEmpty, "light: not yet at transition 0.3")
  l.send(.pressure(stage: 1, pressure: 0.9, transition: 0.6))
  check(l.got == ["M down"], "light: fires at transition 0.6: \(l.got)")

  var n = Sim(.normal)
  n.send(.leftDown(x: 0, y: 0))
  n.send(.pressure(stage: 1, pressure: 1, transition: 0.9))
  check(n.got.isEmpty, "normal: stage 1 is not enough")
  n.send(.pressure(stage: 2, pressure: 0, transition: 0))
  check(n.got == ["M down"], "normal: fires at stage 2")

  var f = Sim(.firm)
  f.send(.leftDown(x: 0, y: 0))
  f.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  check(f.got.isEmpty, "firm: stage 2 at 0.1 not enough")
  f.send(.pressure(stage: 2, pressure: 0.35, transition: 0))
  check(f.got == ["M down"], "firm: fires at 0.35")
  f.send(.leftUp)
  check(f.got == ["M down", "M up"], "got \(f.got)")
}

test("Firm: a deep click that never gets firm enough is still a normal click") {
  var s = Sim(.firm)
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "L up"], "got \(s.got)")
}

test("stepping aside (off, 1Password or Signal in front, app stuck, tap paused)") {
  var a = ClickMachine()
  _ = a.handle(.leftDown(x: 0, y: 0), at: 1)
  check(a.flush(buttonDown: true) == [.held], "button still down: the held down goes out, the real up follows")
  check(a.state == .idle, "idle")

  var b = ClickMachine()
  _ = b.handle(.leftDown(x: 0, y: 0), at: 1)
  check(b.flush(buttonDown: false) == [.held, .heldUp], "the up went past while paused: a whole click, nothing lost")

  var c = ClickMachine()
  _ = c.handle(.leftDown(x: 0, y: 0), at: 1)
  _ = c.handle(.pressure(stage: 2, pressure: 0.1, transition: 0), at: 1.1)
  check(c.flush(buttonDown: true) == [.middleUpSynth], "a middle press is always closed")

  var d = ClickMachine()
  check(d.flush(buttonDown: false) == [], "idle: nothing to do")

  var e = Sim()
  e.send(.leftDown(x: 0, y: 0))
  _ = e.m.flush(buttonDown: true)
  e.send(.leftUp)
  check(e.m.state == .idle, "the real up after stepping aside passes and leaves it idle")
}

test("posted events lost: after 0.5 s events pass straight through again") {
  var m = ClickMachine()
  _ = m.handle(.leftDown(x: 0, y: 0), at: 1)
  _ = m.handle(.leftUp, at: 1.05)   // posts 2, never come back
  check(m.inFlight == 2, "2 in flight")
  check(m.handle(.leftDown(x: 0, y: 0), at: 2) == .drop, "next press held as normal")
  check(m.inFlight == 0, "in flight cleared")
}

test("an up the tap missed: the next down starts a fresh press") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.leftDragged(x: 40, y: 0))
  // the up is lost here
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  s.send(.leftUp)
  check(s.clicks == ["L down", "M down", "M up"], "got \(s.got)")
}

test("pressure and Look Up events with no press pass untouched") {
  var s = Sim()
  s.send(.pressure(stage: 2, pressure: 0.5, transition: 0))
  s.send(.quickLook)
  check(s.got == ["pressure 2", "quick look"], "got \(s.got)")
}

test("Mission Control, Dock, menu bar, other apps: clicks pass at once, untouched") {
  var s = Sim()
  s.send(.leftDown(x: 400, y: 30, holdable: false))
  check(s.got == ["L down"], "the down goes through at once, no delay: \(s.got)")
  s.send(.pressure(stage: 1, pressure: 0.5, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "pressure 1", "L up"], "got \(s.got)")
  check(s.m.state == .idle, "idle")
}

test("not a browser: a firm press stays the Mac's own (no middle click, Look Up as usual)") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0, holdable: false))
  s.send(.pressure(stage: 2, pressure: 0.3, transition: 0))
  s.send(.quickLook)
  s.send(.leftDragged(x: 50, y: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "pressure 2", "quick look", "L drag", "L up"], "got \(s.got)")
  check(!s.got.contains { $0.hasPrefix("M") }, "no middle anything")
}

test("double click in Mission Control: both clicks straight through, in order") {
  var s = Sim()
  s.instant = false
  for _ in 0..<2 { s.send(.leftDown(x: 9, y: 9, holdable: false), after: 0.05); s.send(.leftUp, after: 0.05) }
  s.pump()
  check(s.got == ["L down", "L up", "L down", "L up"], "got \(s.got)")
}

test("browser click, then a Mission Control click: the second is never held") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.leftUp)
  s.send(.leftDown(x: 0, y: 0, holdable: false))
  check(s.got == ["L down", "L up", "L down"], "got \(s.got)")
  check(s.m.state == .idle, "nothing held")
}

test("a missed up, then a down outside a browser: passes, nothing held") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.leftDragged(x: 40, y: 0))   // passthrough
  s.send(.leftDown(x: 0, y: 0, holdable: false))
  check(s.m.state == .passthrough, "still passing")
  s.send(.leftUp)
  check(s.got.suffix(2) == ["L down", "L up"], "got \(s.got)")
}

test("a middle press cut short by a down outside a browser: middle closed, down passes") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.send(.pressure(stage: 2, pressure: 0.1, transition: 0))
  s.send(.leftDown(x: 0, y: 0, holdable: false))
  check(s.got == ["M down", "M up", "L down"], "got \(s.got)")
  s.send(.leftUp)
  check(s.got.last == "L up" && s.m.state == .idle, "got \(s.got)")
}

test("pressure is only looked at while a browser press is held (near zero cost otherwise)") {
  var m = ClickMachine()
  check(!m.wantsPressure, "idle: pressure ignored (every Mission Control swipe, scroll, gesture)")
  _ = m.handle(.leftDown(x: 0, y: 0, holdable: false), at: 1)
  check(!m.wantsPressure, "Mission Control / other app press: pressure ignored")
  _ = m.handle(.leftUp, at: 1.1)
  _ = m.handle(.leftDown(x: 0, y: 0), at: 2)
  check(m.wantsPressure, "browser press held: pressure matters")
  _ = m.handle(.leftDragged(x: 50, y: 0), at: 2.1)
  check(!m.wantsPressure, "became a drag: pressure ignored again")
  _ = m.handle(.leftUp, at: 2.2)
  _ = m.handle(.leftDown(x: 0, y: 0), at: 3)
  _ = m.handle(.pressure(stage: 2, pressure: 0, transition: 0), at: 3.1)
  check(m.wantsPressure, "middle press: pressure still matters (until the finger lifts)")
  _ = m.handle(.leftUp, at: 3.2)
  check(!m.wantsPressure, "after: ignored")
}

extension Sim {
  /// Pressure from the listen-only tap: fed to the machine only while it wants pressure, and the
  /// app always gets the pressure event itself (a listen-only tap cannot drop anything).
  mutating func listen(_ i: ClickMachine.Input) {
    t += 0.01
    if m.wantsPressure, case .post(let outs) = m.handle(i, at: t) {
      pending += outs.map { Sim.name($0, current: nil) }
      if instant { pump() }
    }
    if let n = Sim.name(i) { got.append(n) }
  }
}

test("listen-only pressure: a firm press in a browser is still a clean middle click") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.listen(.pressure(stage: 1, pressure: 0.5, transition: 0))
  s.listen(.pressure(stage: 2, pressure: 0, transition: 0))
  s.listen(.pressure(stage: 1, pressure: 1, transition: 0.3))
  s.send(.leftUp)
  check(s.clicks == ["M down", "M up"], "no left click reached the app: \(s.got)")
}

test("listen-only pressure: a light click in a browser is a normal click") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0))
  s.listen(.pressure(stage: 1, pressure: 0.4, transition: 0))
  s.send(.leftUp)
  check(s.clicks == ["L down", "L up"], "got \(s.got)")
}

test("listen-only pressure: Mission Control press, even pressed hard, stays the Mac's own") {
  var s = Sim()
  s.send(.leftDown(x: 0, y: 0, holdable: false))
  s.listen(.pressure(stage: 2, pressure: 0.5, transition: 0))
  s.send(.leftUp)
  check(s.got == ["L down", "pressure 2", "L up"], "got \(s.got)")
}

test("tap rebuild: a pause notice from both taps makes one rebuild, soon") {
  var h = TapHealth()
  check(h.paused(at: 100) == 0.3, "first notice: rebuild in 0.3 s")
  check(h.paused(at: 100) == nil, "the other tap's notice joins it")
  h.rebuilt(at: 100.3)
  check(!h.pending, "done")
  let w = h.paused(at: 101)
  check(w != nil && abs(w! - 4.3) < 1e-9, "another pause 0.7 s later: rebuilt, but not before 5 s since the last (\(String(describing: w)))")
  h.rebuilt(at: 105.3)
  check(h.paused(at: 200) == 0.3, "much later: soon again")
}

test("tap rebuild: browser clicks that stop carrying pressure rebuild the taps (1 Nov 2026)") {
  var h = TapHealth()
  check(!h.pressEnded(pressures: 0, at: 1) && !h.pressEnded(pressures: 0, at: 2) && !h.pressEnded(pressures: 0, at: 3)
        && !h.pressEnded(pressures: 0, at: 4), "pressure never seen (tap to click only, or Force Click off): never")
  check(!h.pressEnded(pressures: 9, at: 10), "a normal click with pressure")
  check(!h.pressEnded(pressures: 0, at: 11) && !h.pressEnded(pressures: 0, at: 12), "two quiet clicks: not yet")
  check(h.pressEnded(pressures: 0, at: 13), "third quiet click in a row: rebuild")
  check(h.paused(at: 13) == nil, "a pause notice now joins the rebuild already coming")
  h.rebuilt(at: 13)
  check(h.pressEnded(pressures: 8, at: 20) == false && h.dry == 0, "pressure back: all well")
}

test("tap rebuild: one quiet click between good ones never rebuilds") {
  var h = TapHealth()
  var any = false
  for i in 0..<30 { any = h.pressEnded(pressures: i % 3 == 0 ? 0 : 7, at: Double(i)) || any }
  check(!any, "a light tap with no pressure now and then is normal")
}

test("tap rebuild: pressure that stays away backs off, never loops") {
  var h = TapHealth()
  _ = h.pressEnded(pressures: 5, at: 0)
  var at: [Double] = []
  var t = 0.0
  while t < 2000 {
    t += 1
    if h.pressEnded(pressures: 0, at: t) { at.append(t); h.rebuilt(at: t) }
  }
  check(at.count >= 2 && at[0] == 3, "first rebuild at the third quiet click: \(at)")
  let gaps = zip(at.dropFirst(), at).map { $0 - $1 }
  check(gaps.first.map { $0 >= TapHealth.dryGap } ?? false, "then 30 s at the least: \(gaps)")
  check(zip(gaps.dropFirst(), gaps).allSatisfy { $0 >= $1 } && (gaps.max() ?? 0) <= TapHealth.dryGapMax + 3, "gaps grow, up to 10 min: \(gaps)")
  _ = h.pressEnded(pressures: 6, at: t + 1)
  check(h.dryGap == TapHealth.dryGap, "pressure back: the gap starts at 30 s again")
}

// MARK: Recovery (16 Nov 2026): the helper sat for 2.5 days unable to make its taps.

/// Plays the main thread's 2 s tries while the taps cannot be made. Returns the log lines and the
/// times of each fresh start (a fresh start writes down its wall time, like SelfRestart does).
func failRun(seconds: Double, every: Double = 2, wall0: Double = 1_000_000, last: Double? = nil,
             relaunchWorks: Bool = false, locked: (Double) -> Bool = { _ in false })
  -> (lines: [String], relaunches: [Double]) {
  var r = TapRecovery()
  var lines: [String] = [], relaunches: [Double] = []
  var lastRelaunch = last
  var t = 0.0
  while t <= seconds {
    switch r.failed(at: 500 + t, wall: wall0 + t, lastRelaunch: lastRelaunch, locked: locked(t)) {
    case .none: break
    case .logFirst: lines.append("first")
    case .logStill(let s): lines.append("still \(s)")
    case .relaunch:
      relaunches.append(t); lastRelaunch = wall0 + t
      if relaunchWorks { return (lines, relaunches) }
      r.relaunchFailed()
    }
    t += every
  }
  return (lines, relaunches)
}

test("recovery: taps that cannot be made start a fresh copy after 30 s, logged once") {
  let (lines, rel) = failRun(seconds: 40, relaunchWorks: true)
  check(lines == ["first"], "one line, never one per 2 s try: \(lines)")
  check(rel == [30], "a fresh start at 30 s: \(rel)")
}

test("recovery: a short failure (taps back within 30 s) never restarts") {
  var r = TapRecovery()
  check(r.failed(at: 0, wall: 0, lastRelaunch: nil) == .logFirst, "first failure: one line")
  for t in stride(from: 2.0, through: 28, by: 2) { check(r.failed(at: t, wall: t, lastRelaunch: nil) == .none, "at \(t): quiet") }
  check(r.installed(at: 29) == 29, "back after 29 s")
  check(r.failed(at: 100, wall: 100, lastRelaunch: nil) == .logFirst, "a new failure later starts its own count")
  check(r.failed(at: 120, wall: 120, lastRelaunch: nil) == .none, "20 s into the new one: not yet")
  check(r.failed(at: 130, wall: 130, lastRelaunch: nil) == .relaunch, "30 s into the new one: fresh start")
}

test("recovery: fresh starts at most every 5 minutes, one line every 5 minutes in between") {
  // The fresh copy cannot be opened (or the last start was just now): this copy keeps trying.
  let (lines, rel) = failRun(seconds: 3600, relaunchWorks: false)
  check(rel.first == 30, "first at 30 s: \(rel)")
  let gaps = zip(rel.dropFirst(), rel).map { $0 - $1 }
  check(!gaps.isEmpty && gaps.allSatisfy { $0 >= TapRecovery.relaunchGap }, "then 5 minutes apart at the least: \(gaps)")
  check(rel.count <= 13, "an hour: at most 13 tries, never a loop (\(rel.count))")
  let still = lines.filter { $0.hasPrefix("still") }
  check(lines.first == "first" && still.count >= 11 && still.count <= 12, "one still failing line every 5 minutes: \(lines.count) lines")
}

test("recovery: a fresh copy that fails too waits for the 5 minutes from the last start") {
  // The copy before started fresh 60 s ago (wall time kept in UserDefaults).
  let (_, rel) = failRun(seconds: 600, wall0: 1_000_000, last: 1_000_000 - 60, relaunchWorks: true)
  check(rel == [240], "not at 30 s, but once 5 minutes have passed since the last start: \(rel)")
}

test("recovery: the clock going back never blocks a fresh start") {
  check(TapRecovery.relaunchAllowed(wall: 100, lastRelaunch: 5000), "last start in the future: allowed")
  check(TapRecovery.relaunchAllowed(wall: 100, lastRelaunch: nil), "never started: allowed")
  check(!TapRecovery.relaunchAllowed(wall: 100, lastRelaunch: 50), "50 s ago: not yet")
}

test("recovery: a locked screen holds the fresh start until 30 s after unlocking") {
  let (lines, rel) = failRun(seconds: 2000, relaunchWorks: true, locked: { $0 < 1000 })
  check(rel.count == 1 && rel[0] >= 1026 && rel[0] <= 1032, "fresh start about 30 s after the unlock at 1000 s (counted from the last locked try): \(rel)")
  check(lines.count <= 5, "still only one line every 5 minutes while locked: \(lines)")
}

test("recovery: macOS timing the tap out 3 times within 2 minutes starts a fresh copy") {
  var r = TapRecovery()
  check(!r.timedOut(at: 0, wall: 0, lastRelaunch: nil), "one timeout: rebuild only")
  check(!r.timedOut(at: 200, wall: 200, lastRelaunch: nil), "another, minutes later: rebuild only")
  check(!r.timedOut(at: 250, wall: 250, lastRelaunch: nil), "two within 2 minutes: rebuild only")
  check(r.timedOut(at: 260, wall: 260, lastRelaunch: nil), "three within 2 minutes: fresh start")
  var q = TapRecovery()
  _ = q.timedOut(at: 0, wall: 0, lastRelaunch: 1); _ = q.timedOut(at: 1, wall: 1, lastRelaunch: 1)
  check(!q.timedOut(at: 2, wall: 2, lastRelaunch: 1), "but not within 5 minutes of the last fresh start")
}

test("secure input: the taps are made again once, after it ends (no rebuild every 5 s)") {
  var p = SecureInputPause()
  check(p.paused(secure: true) == .waitForEnd, "first pause during secure input: wait for its end (one line)")
  check(p.paused(secure: true) == .alreadyWaiting, "the other tap's pause: nothing more")
  for _ in 0..<100 { check(!p.check(secure: true), "still secure: no rebuild") }
  check(p.paused(secure: true) == .alreadyWaiting, "later pauses while waiting: nothing more")
  check(p.check(secure: false), "secure input ended: rebuild now")
  check(!p.check(secure: false), "only once")
  check(p.paused(secure: false) == .rebuildNow, "a user input pause without secure input: rebuild as before")
}

test("fresh copy: the one at a time rule lets only the replacing copy start") {
  check(Replaces.pid(["PSMiddleClick", "--replaces", "4321"]) == 4321, "reads the old pid")
  check(Replaces.pid(["PSMiddleClick"]) == nil && Replaces.pid(["x", "--replaces"]) == nil
        && Replaces.pid(["x", "--replaces", "abc"]) == nil && Replaces.pid(["x", "--replaces", "0"]) == nil, "anything else: none")
  check(!Replaces.mustQuit(others: [], replaces: nil), "alone: starts")
  check(Replaces.mustQuit(others: [99], replaces: nil), "another copy runs: quits at once (as before)")
  check(!Replaces.mustQuit(others: [99], replaces: 99), "the copy it replaces is still quitting: starts and waits")
  check(Replaces.mustQuit(others: [99, 100], replaces: 99), "a third copy as well: quits")
  check(Replaces.mustQuit(others: [100], replaces: 99), "a different copy: quits")
}

test("PS helper: never asks for Accessibility by itself, only when PS asks (on by default, 16 Nov 2026)") {
  let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  let src = (try? String(contentsOf: dir.appendingPathComponent("Sources/main.swift"), encoding: .utf8)) ?? ""
  func section(_ a: String, _ b: String) -> String {
    guard let r1 = src.range(of: a), let r2 = src.range(of: b, range: r1.upperBound..<src.endIndex) else { return "" }
    return String(src[r1.lowerBound..<r2.lowerBound])
  }
  let start = section("if trusted {\n      tap.install()", "refreshIcon()")
  check(!start.isEmpty && start.contains("} else if Helper.embedded {") && start.contains("waiting quietly"), "embedded start waits quietly")
  let embeddedBranch = section("} else if Helper.embedded {", "} else {")
  check(!embeddedBranch.isEmpty && !embeddedBranch.contains("askAccessibility"), "no prompt in the embedded start")
  check(!section("private func applyEmbedded()", "/// Embedded: the person clicked").contains("askAccessibility"), "no prompt when the standalone app quits")
  check(section("private func askedByPS()", "private var asked").contains("askAccessibility()"), "the prompt comes from PS's ask")
  check(start.contains("Helper.askNotice"), "listens for PS's ask")
}

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
