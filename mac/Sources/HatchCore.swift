import Foundation
import CoreGraphics

// PS 1.67 "Hatch" (the developer, 18 Nov 2026), the rules of the update and start scenes, pure values only (tests/hatch-test.sh).
// Hatch.swift owns the window and ui/hatch.html draws it. The developer's picture:
//  1. Update now: the island leaves (it shrinks into a dot and drops into the middle), and while the update downloads and
//     installs the PS icon builds itself there, piece by piece, in step with the real progress.
//  2. The new version running: the icon finishes, cracks from the top to its middle, falls, hits the bottom of the screen,
//     bounces a little; at the bounce the island hatches out of it as a blob and flies up to its place, where it grows into
//     the real island; the icon falls off the bottom.
//  3. Only once the island has settled: the new number bursts out, rises to the top and reads 'Updated to' over '1.67'
//     with rolling digits. 4. Then What's new comes down from the island.
// The start scene (every time PS starts, a switch in Settings, on unless switched off) is the same without the update
// parts: no number, no 'Updated to', no What's new, a couple of seconds.
// The app is replaced and relaunched in the middle, so the scene is split: the old build builds the icon up to 90 % and
// writes how far it got (HatchCarry); the new build picks up from there and finishes the icon, then plays the rest.

enum HatchMode: String { case update, launch }

/// How far the old build got, handed to the new one across the relaunch (Application Support/PS/update/hatch.json).
struct HatchCarry: Codable, Equatable {
  var to: Int          // the build being installed
  var version: String  // "1.67"
  var built: Double    // 0...1 of the icon on screen when the old build quit
  var at: Double       // when (seconds since 1970)
}

enum HatchCore {
  /// The Settings switch for the start scene (UserDefaults, this Mac): on unless switched off.
  static let launchKey = "hatch.launch"
  /// The version whose update scene already played ("V1.67 · Hatch"): one play per update, never twice (a crash, a second
  /// launch). The name, not the build number: a web only update moves the name on and keeps the app's build.
  static let playedKey = "hatch.played"
  /// The island's sound switch as the page last sent it (the start scene plays before the page has loaded).
  static let soundsKey = "hatch.sounds"
  static let carryName = "hatch.json"
  /// A carry older than this is a leftover (a relaunch never takes 10 minutes): the new build starts the icon afresh.
  static let carryMaxAge: Double = 600
  /// A start scene that could not begin within this (1Password or Signal stayed in front) is not played late.
  static let launchWait: Double = 20
  /// An update scene waits for 1Password and Signal to go as long as this, then gives up (What's new comes as always).
  static let updateWait: Double = 1800
  /// The icon waiting for "Relaunch to finish" stays this long, then tucks itself away until the click.
  static let restSeconds: Double = 6
  /// The most of the icon the old build ever builds: the new build always has the last piece to finish.
  static let preRelaunchMax: Double = 0.9

  /// What the scene does when the updater moves on a step (Updater.pageSet's state and its progress).
  enum Step: Equatable { case build(Double), rest(Double), end, none }
  static func step(_ state: String, frac: Double?) -> Step {
    switch state {
    case "downloading": return .build(0.04 + 0.66 * clamp(frac ?? 0))
    case "verifying": return .build(0.76)
    case "installing": return .build(0.84)
    case "relaunching": return .build(preRelaunchMax)
    case "ready": return .rest(0.84)          // waiting for Relaunch to finish
    case "error", "none": return .end         // stopped, or nothing newer after all: the island comes back
    default: return .none                     // "done" is played by afterUpdate; checking and the rest change nothing
    }
  }
  static func clamp(_ v: Double) -> Double { v.isFinite ? min(1, max(0, v)) : 0 }

  /// Where the new build picks the icon up: the old build's last step when the carry is for this build and fresh,
  /// else 0 (an update from a build without the scene, or a leftover): the icon then builds quickly from nothing.
  static func resume(_ c: HatchCarry?, mine: Int, now: Double) -> Double {
    guard let c, c.to == mine, now - c.at >= -5, now - c.at < carryMaxAge else { return 0 }
    return min(preRelaunchMax, clamp(c.built))
  }
  static func encode(_ c: HatchCarry) -> Data? { try? JSONEncoder().encode(c) }
  static func decode(_ d: Data?) -> HatchCarry? { d.flatMap { try? JSONDecoder().decode(HatchCarry.self, from: $0) } }

  /// One play per update.
  static func playUpdate(played: String?, version: String) -> Bool { !version.isEmpty && played != version }
  /// The Settings switch: on unless it was switched off.
  static func launchOn(_ stored: Any?) -> Bool { (stored as? Bool) != false }
  /// The start scene: the switch on, not a launch that follows an update (that one plays the update scene, never both),
  /// never in a test copy or the install screen.
  static func playLaunch(on: Bool, afterUpdate: Bool, test: Bool, install: Bool) -> Bool { on && !afterUpdate && !test && !install }

  /// "V1.67 · Hatch" or "1.67" as "1.67" (digits and dots only, at most 8 characters).
  static func versionText(_ name: String) -> String {
    let first = name.components(separatedBy: " · ")[0].trimmingCharacters(in: .whitespaces)
    let v = first.hasPrefix("V") || first.hasPrefix("v") ? String(first.dropFirst()) : first
    return String(v.filter { $0.isNumber || $0 == "." }.prefix(8))
  }

  /// Sounds follow PS's island sound switch (Settings, Dynamic Island), Do Not Disturb and private mode.
  static func sounds(islandSounds: Bool, dndMutes: Bool, privateOn: Bool) -> Bool { islandSounds && !dndMutes && !privateOn }
  /// The only sounds the page may ask for (Sfx.swift has their tones).
  static let soundNames: Set<String> = ["hatch-tick0", "hatch-tick1", "hatch-tick2", "hatch-tick3", "hatch-tick4", "hatch-chime",
    "hatch-crack", "hatch-whistle", "hatch-thud", "hatch-bloop", "hatch-gulp", "hatch-burst", "hatch-digits", "hatch-land",
    "hatch-shrink", "hatch-drop", "hatch-whoosh"]
  static func sound(_ name: Any?) -> String? { (name as? String).flatMap { soundNames.contains($0) ? $0 : nil } }
  /// Quiet: about a third of full volume.
  static let volume = 0.35

  /// Esc and clicks: the start scene can be skipped; the update scene cannot. The developer, 18 Nov 2026: the update animation must be
  /// watched. His own exception to "Esc always exits" (EscAlways.swift), for this one screen only. It is safe because the
  /// scene never takes the keyboard or the mouse (its window lets every click through and never becomes key, so other apps
  /// keep their keys and clicks), it is short (maxSeconds ends it whatever happens), and What's new after it closes on Esc
  /// as always. Reduce Motion gives the short fade, also not skippable.
  /// PS 1.69: a replay the user asked for (Settings, About and updates, "Replay the update animation") is the update scene,
  /// but it may be skipped with Esc: they chose to watch it, and nothing is being installed.
  static func skippable(_ mode: HatchMode, replay: Bool = false) -> Bool { mode == .launch || replay }
  /// The longest a scene may stay on screen once it has started: then it ends by itself, even if something stalls.
  static func maxSeconds(_ mode: HatchMode) -> Double { mode == .launch ? 10 : 15 }
  /// PS 1.69, the replay: the icon builds in this many seconds (a made up download), then the scene finishes as after a real update.
  static let replaySeconds: Double = 4.5
  /// How much of the icon the replay shows after this many seconds (eased, from the first piece to the last the old build
  /// would have built before the relaunch): the same range a real download covers.
  static func replayBuilt(elapsed: Double) -> Double {
    let t = clamp(elapsed / replaySeconds)
    let e = t * t * (3 - 2 * t)
    return 0.04 + (preRelaunchMax - 0.04) * e
  }
  /// Never over 1Password or Signal, whatever the build's rule for the island: the scene waits (or, mid scene, ends).
  static func mayShow(protectedFront: Bool) -> Bool { !protectedFront }
  /// A wait that ran too long: the scene is not played late.
  static func giveUp(_ mode: HatchMode, waited: Double) -> Bool { waited > (mode == .launch ? launchWait : updateWait) }

  /// PS 1.69: where the blob flies, in the order of how sure it is: the real island on screen now, the place it will rest
  /// (it shows something), the kept spot (the island has nothing to show yet, as just after a relaunch, or is hidden for a
  /// while), and last the top centre (the island is switched off, or no screen is known). The first one that exists wins.
  static func aim(shown: [String: Double]?, rest: [String: Double]?, spot: [String: Double]?, fallback: [String: Double]) -> [String: Double] {
    shown ?? rest ?? spot ?? fallback
  }
  /// The lower half of the screen (both rects bottom left origin, as AppKit gives them). What's new hangs from the island's
  /// lower edge, so an island down there cannot hold it: it opens in the middle then.
  static func inLowerHalf(_ island: CGRect, screen s: CGRect) -> Bool { island.midY < s.midY }

  /// The island's shape (bottom left origin, points) in the scene page's coordinates (top left origin, the screen's own).
  static func pageRect(_ r: CGRect?, screen s: CGRect) -> [String: Double]? {
    guard let r, r.width > 0, r.height > 0, s.intersects(r) else { return nil }
    return ["x": Double(r.minX - s.minX), "y": Double(s.maxY - r.maxY), "w": Double(r.width), "h": Double(r.height)]
  }
}
