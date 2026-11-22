import Foundation

// PS 1.74: an edit made just before PS quits or reloads a page is saved first (the developer, 22 Nov 2026: "on update it
// sometimes deletes the updates I made recently"). Quit (an app update and its relaunch, the Hatch scene's restart, Quit in
// the menu) and the reload for a new web build first ask each page to save: the box being typed in, a save still waiting,
// and a save on its way to storage (web core/savenow.ts, window.__psSaveNow). The Tab list goes first, because its saves
// travel to the main page, which holds the vault. Never longer than `limit`: a page that does not answer never keeps PS open.
// Wired in main.swift (savePagesFirst). Tested in tests/savefirst-test.sh.
enum SaveFirstCore {
  /// What each page runs (an older page without __psSaveNow answers at once).
  static let js = "return window.__psSaveNow ? await window.__psSaveNow() : null"
  /// Seconds in all, both pages (the page itself gives up after 3).
  static let limit: Double = 4
  /// Seconds one page may take before the next one is asked: a Tab list that does not answer (a busy or stuck page) never
  /// stops the main page, which holds the vault, from saving. The last page has what is left of `limit`.
  static let pageLimit: Double = 1.8
  /// The order the pages save in.
  static let order = ["overlay", "main"]
}

/// Runs its job once, on the first call: the pages answered, or the time ran out.
final class SaveFirstOnce {
  private var job: (() -> Void)?
  init(_ job: @escaping () -> Void) { self.job = job }
  var done: Bool { job == nil }
  func fire() {
    guard let j = job else { return }
    job = nil
    j()
  }
}

/// Several things that must all finish before one job runs (the pages saving, a screen recording ending), each counted once.
final class SaveFirstAll {
  private var left: Set<String>
  private let once: SaveFirstOnce
  init(_ parts: [String], then job: @escaping () -> Void) {
    left = Set(parts)
    once = SaveFirstOnce(job)
    if left.isEmpty { once.fire() }
  }
  func finished(_ part: String) {
    guard left.remove(part) != nil, left.isEmpty else { return }
    once.fire()
  }
  /// The time ran out: the job runs now, whatever is left.
  func giveUp() { once.fire() }
  var done: Bool { once.done }
}
