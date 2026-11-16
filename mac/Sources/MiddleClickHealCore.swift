import Foundation

// When PS restarts the Force Touch middle click helper by itself (16 Nov 2026). Pure, so the rules
// are unit tested (tests/middleclick-heal-test.sh); MiddleClick.swift does the quitting and opening.
//
// Why: the helper had not worked for a few releases. Two things:
// - A PS update replaces the helper on disk at the SAME path, so PS's old check ("a helper from
//   another path is still running") never fired and the old helper process went on running
//   (build 2611120930 still running after 1.63 was installed). Now the running helper's build
//   (from its own middleclick.json report, matched by pid) is compared with the build on disk;
//   when the report cannot be matched, its launch time with the time the new one was written.
// - That old helper sat 2.5 days with its taps gone ("running", "tap": false). Now, when the
//   helper reports running with tap false for over 60 s (allowed, not waiting on the standalone
//   app), PS restarts it once and logs it: no pop up, no loop, at most once every 10 minutes.
enum MiddleClickHealCore {
  static let stuckAfter = 60.0
  static let restartGap = 600.0
  static let watchEvery = 15.0

  /// PS Settings' switch (the developer, 16 Nov 2026: on by default for everyone). stored: what UserDefaults holds
  /// for "middleClick.on". Never chosen: on. An explicit choice stays as it is.
  static func isOn(stored: Any?) -> Bool {
    if let b = stored as? Bool { return b }
    if let n = stored as? NSNumber { return n.boolValue }
    return true
  }

  /// The helper's own report (middleclick.json).
  struct Report: Equatable {
    var running = false, trusted = false, tap = false, yielding = false
    var build = "", pid: Int32 = 0
  }

  static func report(_ json: String?) -> Report? {
    guard let json, let o = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return nil }
    var r = Report()
    r.running = o["running"] as? Bool == true
    r.trusted = o["trusted"] as? Bool == true
    r.tap = o["tap"] as? Bool == true
    r.yielding = o["yielding"] as? Bool == true
    r.build = o["build"] as? String ?? ""
    r.pid = (o["pid"] as? NSNumber)?.int32Value ?? 0
    return r
  }

  /// Is this running helper an older build than the one on disk (after a PS update)?
  /// report: its own middleclick.json (only trusted when its pid is this process).
  /// launched: when the process started. written: when the helper's program on disk was written.
  static func stale(runningPid: Int32, report: Report?, diskBuild: String?, launched: Date?, written: Date?) -> Bool {
    if let r = report, r.pid == runningPid, !r.build.isEmpty, let disk = diskBuild, !disk.isEmpty {
      return r.build != disk
    }
    if let l = launched, let w = written { return w.timeIntervalSince(l) > 1 }
    return false
  }

  /// Watches the helper's reports (every 15 s and on each change notice). Says when to restart it.
  struct StuckWatch {
    private(set) var since: Double?
    private var pid: Int32 = 0
    private(set) var lastRestart: Double?

    /// now: seconds since boot. alive: the pid in the report is a running helper. on: PS Settings.
    /// True means restart it now (it was written down as a restart).
    mutating func observe(_ r: Report?, alive: Bool, on: Bool, at now: Double) -> Bool {
      guard on, alive, let r, r.running, r.trusted, !r.yielding, !r.tap else { since = nil; return false }
      if r.pid != pid || since == nil { pid = r.pid; since = now }   // a new process starts its own count
      guard let s = since, now - s > MiddleClickHealCore.stuckAfter, mayRestart(at: now) else { return false }
      noteRestart(at: now)
      return true
    }

    /// No restart in the last 10 minutes (any reason: stuck, or stale after an update).
    func mayRestart(at now: Double) -> Bool {
      guard let l = lastRestart else { return true }
      return now - l >= MiddleClickHealCore.restartGap || now < l
    }

    mutating func noteRestart(at now: Double) { lastRestart = now; since = nil }
  }
}
