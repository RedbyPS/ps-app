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

/// "User input" pauses (V1.69, 19 Nov 2026). macOS pauses every tap with "user input" when secure
/// input comes on (a password field, a password manager, Terminal's Secure Keyboard Entry), and it
/// pauses each NEW tap the moment it is made while that lasts. A tap that was paused and switched back
/// on keeps handing over clicks, but the pressure tap stays deaf (1 Nov 2026), so presses then carry
/// 0 pressure events and no firm press can become a middle click.
///
/// V1.65 (SecureInputPause) only waited while IsSecureEventInputEnabled() said yes. On macOS 27 it
/// almost never does for another app's secure input (1 time in about 400 pauses on 18 and 19 Nov), so
/// the helper went on making new taps every 5 s, each one paused at once (deaf) for as long as it
/// lasted: 12 minutes after PS 1.67 started on 19 Nov at 01:01.
///
/// Now it does not need to see secure input at all:
/// - A pause only switches the taps back on. They are made again once, after 10 s with no pause.
/// - If the new taps are paused at once (within 2 s), the condition is still on: the wait doubles
///   (10, 20, 40, then 60 s at most) instead of a new try every 5 s. A rebuild that holds for 2 s
///   brings the wait back to 10 s.
/// - When secure input can be seen (macOS sometimes says so), the taps are made again within 2 s of
///   it ending.
/// One log line per episode, never one per pause.
struct PauseCalm {
  static let calm = 10.0
  static let echoWindow = 2.0
  static let waitMax = 60.0

  private(set) var waiting = false
  private(set) var wait = PauseCalm.calm
  private var lastPause = -Double.infinity
  private var lastRebuild = -Double.infinity
  private var sawSecure = false

  /// macOS paused the taps (or a tap was found off). True when this opens an episode (one log line).
  mutating func paused(at t: Double, secure: Bool) -> Bool {
    if t - lastRebuild < PauseCalm.echoWindow, lastPause < lastRebuild {   // the fresh taps were paused at once
      wait = min(wait * 2, PauseCalm.waitMax)
    }
    let first = !waiting
    waiting = true
    lastPause = t
    if secure { sawSecure = true }
    return first
  }

  /// Every 2 s. True: make the taps again now (once per episode).
  mutating func check(at t: Double, secure: Bool) -> Bool {
    guard waiting else {
      if lastRebuild > lastPause, t - lastRebuild >= PauseCalm.echoWindow { wait = PauseCalm.calm }   // the last rebuild held
      return false
    }
    if secure { sawSecure = true; return false }
    guard sawSecure || t - lastPause >= wait else { return false }
    waiting = false
    sawSecure = false
    return true
  }

  /// Any rebuild (after calm, a timeout, or deaf pressure): for telling an echo pause from a new one.
  mutating func rebuilt(at t: Double) { lastRebuild = t }
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
