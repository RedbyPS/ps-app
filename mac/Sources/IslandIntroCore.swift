// The Mac's side of the "Did you know?" feature intros (PS 1.60, web/src/core/featureintro.ts has the list and the clock rules).
// The page decides WHEN an intro is due (a minute of active use, not linked yet, a day apart, Later once more after 3 days). The Mac
// only answers the part it alone knows: is the island free right now (the shared queue, IslandQueueCore.swift), and is this a moment
// that must stay quiet: Sentry mode, Sleep mode, screen sharing, a full screen app. Pure values here: no windows, no sounds, no clock.
// tests/island-intro-test.sh checks it. Do Not Disturb is the page's to know (it is in the person's settings), the page checks it too.
import Foundation

struct IslandIntroFacts: Equatable {
  var featureOn = true        // features.json "feature-intros" (and Settings, From the squad)
  var sentry = false          // Sentry mode is up (the screen is covered)
  var sleep = false           // Sleep mode's screen is up
  var sharing = false         // a screen sharing helper is running
  var fullScreen = false      // an app is full screen on the island's screen
}

enum IslandIntroCore {
  /// How long an intro may wait in the island queue for its turn before it is let go (the page asks again at the next free moment).
  static let queueTTL: TimeInterval = 120
  /// The longest a card (or the guide it grows into) may hold the island's turn: a page that never says it is done cannot block the queue for good.
  static let holdCap: TimeInterval = 1800

  /// Why the intro must not show right now, or nil. The words are the ones the page understands (web/src/core/featureintro.ts macBlocked).
  /// Order matters only for the word that is sent back, never for whether it shows: any one of them blocks.
  static func blocked(_ f: IslandIntroFacts) -> String? {
    if !f.featureOn { return "off" }
    if f.sentry { return "sentry" }
    if f.sleep { return "sleep" }
    if f.sharing { return "sharing" }
    if f.fullScreen { return "fullScreen" }
    return nil
  }

  /// The program names that mean the screen is being shared right now (Zoom's share helper, macOS Screen Sharing). Names only: nothing
  /// else about any program is read, and no window titles (never 1Password or Signal, rule 7).
  static let sharingHelpers: Set<String> = ["CptHost", "screensharingd", "ScreensharingAgent"]
  /// The system keeps a process name to 16 letters ("ScreensharingAgent" is "ScreensharingAge" there), so both sides are cut to 16.
  static let sharingShort: Set<String> = Set(sharingHelpers.map { String($0.prefix(16)) })
  static func isHelper(_ name: String) -> Bool { sharingShort.contains(String(name.prefix(16))) }
  static func isSharing(processNames: [String]) -> Bool { processNames.contains { isHelper($0) } }

  /// The island's turn: the card is on screen only after the island's squeeze and chime, so Reduce Motion, the island being off or not on
  /// screen means a plain card (no place to hang from), never no intro.
  /// PS 1.69: also not when the island is kept in the lower half of the screen (V1.58): the card hangs from the island's lower
  /// edge, which would put it off the bottom. It is the plain card in the middle then (the same as What's new).
  static func hangsFromIsland(islandOff: Bool, reduceMotion: Bool, momentsOn: Bool, islandOnScreen: Bool, islandLow: Bool = false) -> Bool {
    !islandOff && !reduceMotion && momentsOn && islandOnScreen && !islandLow
  }
}
