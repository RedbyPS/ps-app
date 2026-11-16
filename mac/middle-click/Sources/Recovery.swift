import Foundation

// When the mouse taps cannot be made, the app starts itself again (16 Nov 2026).
//
// Why: on 14 Nov 03:23 macOS paused the helper's tap for a slow answer ("timeout"), the rebuild
// then could not make new taps although Accessibility was allowed, and the same process went on
// failing quietly for 2.5 days (one log line, then nothing). Killing it and opening it again
// fixed it at once. So after about 30 s of failing in a row, the app opens a fresh copy of itself
// (by its own bundle path) and quits cleanly.
//
// Rules (pure, unit tested in Tests/main.swift):
// - One log line when the failing starts, then one line every 5 minutes while it goes on. Never
//   one per 2 s try.
// - A fresh start after 30 s of failing in a row, at most once every 5 minutes (wall clock, kept
//   across starts, so a fresh copy that fails too cannot start a loop).
// - While the screen is locked or this login is not the one on screen, taps may not be made at
//   all: the 30 s only count once it is back.
// - macOS timing the tap out 3 times within 2 minutes counts as failing too (fresh start, same
//   5 minute limit).
struct TapRecovery {
  static let giveUpAfter = 30.0
  static let stillEvery = 300.0
  static let relaunchGap = 300.0
  static let timeoutLimit = 3
  static let timeoutWindow = 120.0

  enum Action: Equatable {
    case none
    case logFirst                  // the first failure: one line
    case logStill(seconds: Int)    // still failing (every 5 minutes): one line
    case relaunch                  // open a fresh copy and quit
  }

  private(set) var failingSince: Double?
  private var lastLog = 0.0
  private var relaunching = false
  private var timeouts: [Double] = []

  /// A fresh start is allowed: none yet, or the last one at least 5 minutes ago (or the clock
  /// went back, then the old time means nothing).
  static func relaunchAllowed(wall: Double, lastRelaunch: Double?) -> Bool {
    guard let last = lastRelaunch else { return true }
    return wall - last >= relaunchGap || wall < last
  }

  /// The taps could not be made (main thread, every 2 s while it lasts).
  /// now: seconds since boot. wall: seconds since 1970. lastRelaunch: wall time of the last fresh
  /// start (any copy), nil if none. locked: screen locked or this login not on screen.
  mutating func failed(at now: Double, wall: Double, lastRelaunch: Double?, locked: Bool = false) -> Action {
    guard let since = failingSince else {
      failingSince = now; lastLog = now
      return .logFirst
    }
    if locked { failingSince = now; return stillLine(now, since) }   // the 30 s start again once unlocked
    if !relaunching, now - since >= TapRecovery.giveUpAfter, TapRecovery.relaunchAllowed(wall: wall, lastRelaunch: lastRelaunch) {
      relaunching = true
      return .relaunch
    }
    return stillLine(now, since)
  }

  private mutating func stillLine(_ now: Double, _ since: Double) -> Action {
    guard now - lastLog >= TapRecovery.stillEvery else { return .none }
    lastLog = now
    return .logStill(seconds: Int(now - since))
  }

  /// The fresh copy could not be opened: keep trying in this process (the 5 minute limit holds,
  /// because the caller already wrote the try down as the last fresh start).
  mutating func relaunchFailed() { relaunching = false }

  /// The taps were made: all clear. Returns how long it had failed, nil if it had not.
  @discardableResult
  mutating func installed(at now: Double) -> Double? {
    defer { failingSince = nil; relaunching = false }
    return failingSince.map { now - $0 }
  }

  /// macOS paused the tap for a slow answer. True: open a fresh copy and quit.
  mutating func timedOut(at now: Double, wall: Double, lastRelaunch: Double?) -> Bool {
    timeouts = timeouts.filter { now - $0 < TapRecovery.timeoutWindow } + [now]
    guard !relaunching, timeouts.count >= TapRecovery.timeoutLimit,
          TapRecovery.relaunchAllowed(wall: wall, lastRelaunch: lastRelaunch) else { return false }
    relaunching = true
    timeouts = []
    return true
  }
}

/// Secure input (a password field, 1Password, Terminal's Secure Keyboard Entry) makes macOS pause
/// every tap with "user input", and pause each NEW tap again the moment it is made. On 14 Nov the
/// helper rebuilt its taps every 5 s for as long as a password field was open (824 pause lines),
/// each rebuild making a new pause. Now: while secure input is on, the taps are only switched back
/// on (that sticks), and they are made again once, after it ends. One log line each way.
struct SecureInputPause {
  private(set) var waiting = false

  enum Step: Equatable { case rebuildNow, waitForEnd, alreadyWaiting }

  /// macOS paused the taps for user input. secure: secure input is on right now.
  mutating func paused(secure: Bool) -> Step {
    guard secure else { return waiting ? .alreadyWaiting : .rebuildNow }
    if waiting { return .alreadyWaiting }
    waiting = true
    return .waitForEnd
  }

  /// Every 2 s. True: secure input just ended, make the taps again now.
  mutating func check(secure: Bool) -> Bool {
    guard waiting, !secure else { return false }
    waiting = false
    return true
  }
}

/// A fresh copy is opened with "--replaces <pid of the old copy>": it may start while that copy is
/// still quitting (the one at a time rule lets it), and waits for it to be gone first.
enum Replaces {
  static let flag = "--replaces"
  static func pid(_ args: [String]) -> Int32? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count, let p = Int32(args[i + 1]), p > 0 else { return nil }
    return p
  }
  /// The one at a time rule: true when this copy must quit because another one runs.
  /// others: pids of the other running copies. replaces: what this copy was opened to replace.
  static func mustQuit(others: [Int32], replaces: Int32?) -> Bool {
    guard !others.isEmpty else { return false }
    guard let r = replaces else { return true }
    return others.contains { $0 != r }
  }
}
