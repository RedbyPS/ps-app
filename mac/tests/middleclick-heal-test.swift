// Offline test for Sources/MiddleClickHealCore.swift (16 Nov 2026): when PS restarts the Force Touch middle click
// helper by itself. Replays the helper's reports over time and checks when PS restarts it. Then reads
// MiddleClick.swift for the wiring. Asks macOS nothing.
//   bash tests/middleclick-heal-test.sh
import Foundation

var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }

typealias C = MiddleClickHealCore

// The helper's report, as Helper.swift writes it.
let stuckJSON = #"{"running":true,"trusted":true,"tap":false,"yielding":false,"build":"2611120930","pid":700}"#
let goodJSON = #"{"running":true,"trusted":true,"tap":true,"yielding":false,"build":"2611151941","pid":800}"#
let r = C.report(stuckJSON)
check("report-reads", r == C.Report(running: true, trusted: true, tap: false, yielding: false, build: "2611120930", pid: 700))
check("report-bad-json", C.report("not json") == nil && C.report(nil) == nil)

// After an update: the same path, an older build still running (14 to 16 Nov).
let d0 = Date(timeIntervalSince1970: 1_000_000)
check("stale-build-differs", C.stale(runningPid: 700, report: r, diskBuild: "2611151941", launched: nil, written: nil))
check("same-build-not-stale", !C.stale(runningPid: 800, report: C.report(goodJSON), diskBuild: "2611151941", launched: nil, written: nil))
check("report-of-another-pid-not-trusted", !C.stale(runningPid: 999, report: r, diskBuild: "2611151941", launched: nil, written: nil))
check("fallback-written-after-launch", C.stale(runningPid: 999, report: r, diskBuild: "2611151941", launched: d0, written: d0.addingTimeInterval(86400)))
check("fallback-written-before-launch", !C.stale(runningPid: 999, report: nil, diskBuild: "x", launched: d0.addingTimeInterval(60), written: d0))
check("fallback-unknown-not-stale", !C.stale(runningPid: 999, report: nil, diskBuild: nil, launched: nil, written: nil))

/// Feeds the same report every 15 s for `secs`; returns when PS restarted it.
func play(_ json: String, secs: Double, alive: Bool = true, on: Bool = true, w: inout C.StuckWatch, from t0: Double = 0) -> [Double] {
  var out: [Double] = []
  var t = t0
  while t <= t0 + secs {
    if w.observe(C.report(json), alive: alive, on: on, at: t) { out.append(t) }
    t += C.watchEvery
  }
  return out
}

var w = C.StuckWatch()
check("stuck-restarts-once-after-60s", play(stuckJSON, secs: 90, w: &w) == [75])
var w2 = C.StuckWatch()
let longRun = play(stuckJSON, secs: 3600, w: &w2)
check("stuck-never-loops", longRun.count <= 6 && zip(longRun.dropFirst(), longRun).allSatisfy { $0 - $1 >= C.restartGap })
var w3 = C.StuckWatch()
check("short-gap-no-restart", play(stuckJSON, secs: 45, w: &w3).isEmpty && play(goodJSON, secs: 30, w: &w3, from: 60).isEmpty
      && play(stuckJSON, secs: 45, w: &w3, from: 100).isEmpty)
var w4 = C.StuckWatch()
check("taps-on-never", play(goodJSON, secs: 3600, w: &w4).isEmpty)
var w5 = C.StuckWatch()
check("dead-helper-not-this-rule", play(stuckJSON, secs: 600, alive: false, w: &w5).isEmpty)
var w6 = C.StuckWatch()
check("switched-off-never", play(stuckJSON, secs: 600, on: false, w: &w6).isEmpty)
var w7 = C.StuckWatch()
let waiting = #"{"running":true,"trusted":true,"tap":false,"yielding":true,"build":"1","pid":5}"#
let noAccess = #"{"running":true,"trusted":false,"tap":false,"yielding":false,"build":"1","pid":5}"#
check("standalone-app-in-use-never", play(waiting, secs: 600, w: &w7).isEmpty)
check("no-access-never", play(noAccess, secs: 600, w: &w7).isEmpty)
// A new helper process (a fresh copy) starts its own 60 s.
var w8 = C.StuckWatch()
_ = play(stuckJSON, secs: 45, w: &w8)
let fresh = #"{"running":true,"trusted":true,"tap":false,"yielding":false,"build":"2611120930","pid":701}"#
check("new-pid-starts-own-count", play(fresh, secs: 45, w: &w8, from: 60).isEmpty && play(fresh, secs: 30, w: &w8, from: 120) == [135])
// A stale restart counts for the 10 minutes too.
var w9 = C.StuckWatch()
w9.noteRestart(at: 0)
check("after-any-restart-waits-10-min", !w9.mayRestart(at: 599) && w9.mayRestart(at: 600) && play(stuckJSON, secs: 700, w: &w9).first == 600)

// On by default for everyone (the developer, 16 Nov 2026); an explicit off stays off.
check("default-on-when-never-chosen", C.isOn(stored: nil))
check("explicit-off-stays-off", !C.isOn(stored: false) && !C.isOn(stored: NSNumber(value: false)) && !C.isOn(stored: 0))
check("explicit-on-stays-on", C.isOn(stored: true) && C.isOn(stored: NSNumber(value: true)))
let d = UserDefaults(suiteName: "ps-middleclick-heal-test")!
d.removePersistentDomain(forName: "ps-middleclick-heal-test")
check("missing-key-reads-on", C.isOn(stored: d.object(forKey: "middleClick.on")))
d.set(false, forKey: "middleClick.on")
check("saved-off-reads-off", !C.isOn(stored: d.object(forKey: "middleClick.on")))
d.removePersistentDomain(forName: "ps-middleclick-heal-test")

// The wiring, read from the source.
let dir = ProcessInfo.processInfo.environment["PS_MAC_DIR"] ?? "."
func src(_ f: String) -> String { (try? String(contentsOfFile: "\(dir)/\(f)", encoding: .utf8)) ?? "" }
let mc = src("Sources/MiddleClick.swift")
func section(_ s: String, from a: String, to b: String) -> String {
  guard let r1 = s.range(of: a), let r2 = s.range(of: b, range: r1.upperBound..<s.endIndex) else { return "" }
  return String(s[r1.lowerBound..<r2.lowerBound])
}
let ens = section(mc, from: "private func ensureRunning()", to: "/// What the helper said")
check("start-checks-build", ens.contains("self.stale($0, f)") && ens.contains("psLog("))
let facts = section(mc, from: "private func facts(", to: "private func stale(")
check("files-read-off-main", facts.contains("readQ.async") && facts.contains("DispatchQueue.main.async"))
check("disk-build-read-fresh", facts.contains("NSDictionary(contentsOf:") && !facts.contains("Bundle(url: url"))
let wh = section(mc, from: "private func watchHelper()", to: "private func restart(")
check("watch-uses-rules", wh.contains("watch.observe(") && wh.contains("watch.mayRestart(") && wh.contains("watch.noteRestart("))
let rep = section(mc, from: "private func replace(", to: "/// For PS Settings.")
check("only-its-own-helper", rep.contains("h.bundleIdentifier == MiddleClick.helperID") && !mc.contains("killall") && !mc.contains("pkill"))
check("never-blocks-main", !(wh + rep + ens + facts).contains("Thread.sleep") && !(wh + rep + ens + facts).contains(".sync {")
      && !(wh + rep + ens + facts).contains("DispatchSemaphore") && !(wh + rep + ens + facts).contains("waitUntilExit"))
check("no-pop-up", !(wh + rep).contains("NSAlert") && !(wh + rep).contains("showError") && !(wh + rep).contains("pageSet("))
check("timer-every-15s", mc.contains("Timer(timeInterval: MiddleClickHealCore.watchEvery"))
check("notice-also-watches", section(mc, from: "func start(testDir:", to: "/// From the page").contains("self?.watchHelper()"))
check("self-test-copy-never-starts", section(mc, from: "private func watchHelper()", to: "facts {").contains("!test"))

check("on-uses-default-rule", mc.contains("MiddleClickHealCore.isOn(stored: UserDefaults.standard.object(forKey: \"middleClick.on\"))") && !mc.contains("bool(forKey: \"middleClick.on\")"))
let ask = section(mc, from: "case \"accessibility\":", to: "default: break")
check("button-asks-helper-and-opens-page", ask.contains("MiddleClick.askNotice") && ask.contains("Privacy_Accessibility") && ask.contains("!test"))
check("ask-notice-name-matches-helper", mc.contains("Notification.Name(\"com.cincee.ps.middleclick.ask\")"))

print(fails == 0 ? "ALL OK" : "\(fails) FAILED")
exit(fails == 0 ? 0 : 1)
