import Foundation
// Run: bash tests/island-rejoin-test.sh. The island's every desktop watchdog (Sources/IslandRejoinCore.swift).
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
typealias C = IslandRejoinCore
func inp(_ t: Double, on: Bool = false, visible: Bool = true, dragging: Bool = false, paused: Bool = false) -> C.Input {
  C.Input(visible: visible, onActiveSpace: on, dragging: dragging, paused: paused, now: t)
}
let T = 1_763_600_000.0

// ---------- nothing to look at ----------
do {
  var c = C()
  ok("on the desktop in front: nothing done, nothing written", c.step(inp(T, on: true), why: "placed") == C.Decision(action: .none, recheckIn: nil))
  ok("not meant to show (off, away, hidden, over 1Password or Signal in the developer's build): nothing", c.step(inp(T, visible: false), why: "placed").action == .none)
  ok("while dragged: nothing", c.step(inp(T, dragging: true), why: "drag").action == .none)
  ok("under Sleep mode, Sentry mode or the lock screen: nothing, not even a look again", c.step(inp(T, paused: true), why: "placed") == C.Decision(action: .none, recheckIn: nil))
  ok("none of those started a missing spell", c.missingSince == nil && c.checks == 0)
}

// ---------- just ordered in: macOS gets its moment ----------
do {
  var c = C()
  c.shown(now: T)
  let d = c.step(inp(T + 0.1), why: "placed")
  ok("missing right after it was ordered in waits, writes nothing", d.action == .wait && d.logs.isEmpty)
  ok("and looks again once the moment is over", (d.recheckIn ?? 0) >= C.settle - 0.1 - 0.001 && (d.recheckIn ?? 99) <= C.settle)
  ok("on the desktop by then: back quietly (it never was missing)", c.step(inp(T + 0.7, on: true), why: "check") == C.Decision(action: .none, recheckIn: nil))
}

// ---------- the 12 Nov drag case: one put back mends it ----------
do {
  var c = C()
  let d = c.step(inp(T), why: "desktop change")
  ok("missing: put back once", d.action == .rejoin)
  ok("one line, with why", d.logs == ["PS island: missing from this desktop (desktop change), putting it back"])
  ok("looks again after the moment", d.recheckIn == C.settle + 0.05)
  let b = c.step(inp(T + 0.65, on: true), why: "check")
  ok("back: one line with the count, no new window", b.action == .none && b.logs == ["PS island: back on this desktop after 1 checks in 1 s"])
  ok("state cleared for next time", c.missingSince == nil && c.checks == 0 && c.rejoinsThisWindow == 0 && c.rebuilds.isEmpty)
}

// ---------- the 20 Nov case: put back does not help, a new window does ----------
do {
  var c = C()
  _ = c.step(inp(T), why: "desktop change")
  // A burst of page states (60 a second, as in ps.log at 06:44:47Z): nothing done, nothing written.
  var burst: [C.Decision] = []
  for k in 1...30 { burst.append(c.step(inp(T + Double(k) / 60), why: "placed")) }
  ok("a burst inside the moment does nothing", burst.allSatisfy { $0.action == .wait && $0.logs.isEmpty })
  let r = c.step(inp(T + 0.7), why: "check")
  ok("still missing after the put back: a new window", r.action == .rebuild)
  ok("one line for it", r.logs.count == 1 && r.logs[0].hasPrefix("PS island: still missing after putting it back (") && r.logs[0].hasSuffix("making it a new window (1 this hour)"))
  let b = c.step(inp(T + 1.4, on: true), why: "check")
  ok("the new window is on the desktop: back, said once, with the count", b.logs.count == 1 && b.logs[0].hasPrefix("PS island: back on this desktop after ") && b.logs[0].hasSuffix(", on a new window"))
  ok("a later spell starts with a put back again", c.step(inp(T + 100), why: "desktop change").action == .rejoin)
}

// ---------- the new window is missing too: never a loop ----------
do {
  var c = C()
  var t = T
  var lines = 0, rebuilds: [Double] = [], fixes: [Double] = [], firsts = 0
  // 19 hours missing, looked at every 0.25 s (far more often than ps.log ever showed).
  while t < T + 19 * 3600 {
    let d = c.step(inp(t), why: "placed")
    lines += d.logs.count
    firsts += d.logs.filter { $0.hasPrefix("PS island: missing from") }.count
    if d.action == .rebuild { rebuilds.append(t) }
    if d.action == .rebuild || d.action == .rejoin { fixes.append(t) }
    t += 0.25
  }
  ok("the missing line is written once for the whole spell", firsts == 1)
  let perHour = (0..<19).map { h in rebuilds.filter { $0 >= T + Double(h) * 3600 && $0 < T + Double(h + 1) * 3600 }.count }
  ok("at most \(C.maxRebuildsPerHour) new windows in any hour", perHour.allSatisfy { $0 <= C.maxRebuildsPerHour })
  ok("and never more than \(C.maxRebuildsPerHour) inside any 60 minutes", rebuilds.indices.allSatisfy { i in rebuilds.filter { $0 >= rebuilds[i] && $0 < rebuilds[i] + 3600 }.count <= C.maxRebuildsPerHour })
  ok("new windows at least \(Int(C.rebuildGap)) s apart", zip(rebuilds, rebuilds.dropFirst()).allSatisfy { $1 - $0 >= C.rebuildGap })
  ok("no two fixes inside one moment", zip(fixes, fixes.dropFirst()).allSatisfy { $1 - $0 >= C.settle })
  // 1 missing line + a line per new window + a summary at most every 30 minutes: tens of lines, not thousands.
  let bound = 1 + rebuilds.count + Int(19 * 3600 / C.summaryGap) + 1
  ok("ps.log gets \(lines) lines in 19 hours (at most \(bound)), not thousands", lines <= bound && lines < 300)
  ok("it keeps trying, a few times an hour", rebuilds.count >= 19 * (C.maxRebuildsPerHour - 1))
}

// ---------- waiting for the next allowed new window ----------
do {
  var c = C()
  _ = c.step(inp(T), why: "desktop change")       // put back
  _ = c.step(inp(T + 1), why: "check")            // new window 1
  _ = c.step(inp(T + 2), why: "check")            // put back on the new window
  let w = c.step(inp(T + 3), why: "check")
  ok("a second new window waits out the gap", w.action == .wait && w.logs.count == 1 && w.logs[0].hasPrefix("PS island: still missing from this desktop, "))
  ok("and looks again when it is allowed", abs((w.recheckIn ?? 0) - (C.rebuildGap - 2)) < 0.001)
  let q = c.step(inp(T + 4), why: "check")
  ok("the summary is not written again soon after", q.action == .wait && q.logs.isEmpty)
  ok("after the gap, the next new window", c.step(inp(T + 31.5), why: "check").action == .rebuild)
}

// ---------- the settings and Sleep, Sentry, lock ----------
do {
  var c = C()
  _ = c.step(inp(T), why: "desktop change")                 // put back
  let p = c.step(inp(T + 5, paused: true), why: "check")
  ok("Sleep mode or Sentry mode came up meanwhile: nothing done, no look again", p == C.Decision(action: .none, recheckIn: nil))
  let a = c.step(inp(T + 6, visible: false), why: "placed")
  ok("sent away for N minutes (ordered out): nothing", a.action == .none && a.logs.isEmpty)
  c.shown(now: T + 1800)                                     // back from away: ordered in again
  ok("back from away: its moment first", c.step(inp(T + 1800.2), why: "placed").action == .wait)
  ok("then a new window (the put back on this one was spent)", c.step(inp(T + 1801), why: "check").action == .rebuild)
}

// ---------- an unlock that goes right ----------
do {
  var c = C()
  c.shown(now: T)
  ok("missing at the lock screen counts for nothing", c.step(inp(T + 5, paused: true), why: "placed").action == .none)
  ok("after the unlock, on the desktop: nothing written", c.step(inp(T + 10, on: true), why: "unlock").logs.isEmpty)
}

print("\(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
