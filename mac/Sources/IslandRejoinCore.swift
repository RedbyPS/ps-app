import Foundation

// The island's "every desktop" watchdog (the developer, 21 Nov 2026: the island kept disappearing and only came back when PS was
// quit and opened again). Pure numbers, no windows: tests/island-rejoin-test.sh checks it on any Mac.
//
// What ps.log showed (20 Nov 06:42Z to 21 Nov 01:34Z, about 3,500 lines; the same on 15 and 16 Nov): "PS island: was
// missing from this desktop (desktop change)", then "(placed)" over and over, up to 60 lines a second, until the developer
// relaunched PS. The V1.58 watchdog (Island.joinAllSpaces) saw the island's window was showing but not on the desktop
// in front (NSWindow.isOnActiveSpace false), cleared and set its collection behaviour, ordered it out and straight back
// in, and wrote the line. It never looked again to see whether that worked, and it ran on every place(): every state
// from the page (a burst of them after a wake, while the vault syncs) and every desktop change. On those days macOS
// had stopped counting that one window as being on every desktop (after a wake, an unlock or a screen lock), and no
// amount of reordering the same window put it back: the window server keeps that state per window. A relaunch made a
// new window, which is why only a relaunch helped.
//
// Now:
//  - Missing just after it was ordered in is not missing yet: macOS needs a moment (settle), so it is looked at again.
//  - Missing: put back once on the same window (still the right fix for a window left behind by a drag, 12 Nov).
//  - Still missing a moment later: the window is replaced by a new one (Island.rebuildPanel), at most once per
//    rebuildGap and maxRebuildsPerHour an hour, so it can never loop.
//  - One line when it goes missing, one when a new window is made, one when it is back with the count of checks, and
//    while it waits at most one line every summaryGap. Never a line per check.
//  - Nothing at all while it is not meant to show (switched off, away for a time, hidden by its grab line, over
//    1Password or Signal in the developer's own build: Island.place decides that and orders it out), while it is dragged, under
//    Sleep mode or Sentry mode, or while the Mac is locked.
struct IslandRejoinCore: Equatable {
  /// How long macOS gets after the window is ordered in, put back or replaced before it is judged again.
  static let settle = 0.6
  /// Put backs on one window before it is replaced (reordering a window macOS has given up on never helps).
  static let maxRejoins = 1
  /// The least time between two new windows, and how many an hour at most.
  static let rebuildGap = 30.0
  static let maxRebuildsPerHour = 4
  /// While it waits for the next allowed new window: one line at most this often.
  static let summaryGap = 1800.0

  enum Action: Equatable { case none, wait, rejoin, rebuild }
  struct Decision: Equatable {
    var action: Action
    /// Lines for ps.log (most often none).
    var logs: [String] = []
    /// Look again in this many seconds (nil: nothing to look at again).
    var recheckIn: Double?
  }
  struct Input: Equatable {
    /// The window is ordered in (Island.place wants it on screen: switched on, something to show, not away or hidden,
    /// not over 1Password or Signal where the build hides it).
    var visible: Bool
    var onActiveSpace: Bool
    var dragging: Bool
    /// Sleep mode, Sentry mode or the lock screen is up: the island is under them, nothing is looked at.
    var paused: Bool
    var now: Double
  }

  private(set) var missingSince: Double?
  private(set) var checks = 0
  private(set) var rejoinsThisWindow = 0
  private(set) var rebuilds: [Double] = []
  private(set) var rebuildsThisTime = 0
  private(set) var lastFix = -Double.infinity
  private(set) var shownAt = -Double.infinity
  private(set) var lastSummary = -Double.infinity

  /// The window was just ordered in (Island.place) or made new: give macOS its moment.
  mutating func shown(now: Double) { shownAt = now }

  mutating func step(_ i: Input, why: String) -> Decision {
    // Not meant to show, or something else owns the screen: nothing to look at, nothing written.
    if !i.visible || i.dragging || i.paused { return Decision(action: .none, recheckIn: nil) }
    rebuilds = rebuilds.filter { i.now - $0 < 3600 }
    if i.onActiveSpace {
      defer { missingSince = nil; checks = 0; rejoinsThisWindow = 0; rebuildsThisTime = 0; lastSummary = -.infinity }
      guard let since = missingSince else { return Decision(action: .none, recheckIn: nil) }
      let secs = Int((i.now - since).rounded())
      let made = rebuildsThisTime == 0 ? "" : rebuildsThisTime == 1 ? ", on a new window" : ", on a new window (\(rebuildsThisTime) made)"
      return Decision(action: .none, logs: ["PS island: back on this desktop after \(checks) checks in \(secs) s\(made)"], recheckIn: nil)
    }
    // Missing. Just ordered in, put back or replaced: macOS has not had its moment yet.
    let since = max(shownAt, lastFix)
    if i.now - since < IslandRejoinCore.settle {
      if missingSince != nil { checks += 1 }
      return Decision(action: .wait, recheckIn: IslandRejoinCore.settle - (i.now - since) + 0.05)
    }
    checks += 1
    var first: String?
    if missingSince == nil {
      missingSince = i.now
      first = "PS island: missing from this desktop (\(why)), putting it back"
    }
    if rejoinsThisWindow < IslandRejoinCore.maxRejoins {
      rejoinsThisWindow += 1
      lastFix = i.now
      return Decision(action: .rejoin, logs: first.map { [$0] } ?? [], recheckIn: IslandRejoinCore.settle + 0.05)
    }
    let gapLeft = (rebuilds.last.map { IslandRejoinCore.rebuildGap - (i.now - $0) } ?? 0)
    let hourLeft = rebuilds.count < IslandRejoinCore.maxRebuildsPerHour ? 0 : 3600 - (i.now - rebuilds[0])
    if gapLeft <= 0 && hourLeft <= 0 {
      rebuilds.append(i.now)
      rebuildsThisTime += 1
      rejoinsThisWindow = 0
      lastFix = i.now
      let line = "PS island: still missing after putting it back (\(checks) checks), making it a new window (\(rebuilds.count) this hour)"
      return Decision(action: .rebuild, logs: (first.map { [$0] } ?? []) + [line], recheckIn: IslandRejoinCore.settle + 0.05)
    }
    // No new window allowed yet: wait for the next one, saying so at most once every summaryGap.
    let wait = max(1, min(60, max(gapLeft, hourLeft)))
    var line = first
    if line == nil, i.now - lastSummary >= IslandRejoinCore.summaryGap, let s = missingSince {
      lastSummary = i.now
      line = "PS island: still missing from this desktop, \(checks) checks in \(Int((i.now - s) / 60)) min, \(rebuilds.count) new windows this hour, trying again in \(Int(wait.rounded())) s"
    } else if first != nil { lastSummary = i.now }
    return Decision(action: .wait, logs: line.map { [$0] } ?? [], recheckIn: wait)
  }
}
