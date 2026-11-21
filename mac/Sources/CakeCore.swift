import Foundation

// PS Cake (the developer, 21 Nov 2026), the rules of the boot animation and the logo reveal, pure values only (tests/cake-test.sh).
// Cake.swift owns the window and ui/cake.html draws it. The developer's rules, from his own words:
//  1. A boot animation on every start of PS (quit and open again, a Mac restart): ONE of three, picked at random, never the
//     same one twice in a row. 1 Night drive (6.0 s), 2 Harbor lights (5.4 s), 3 City swarm (5.4 s). Each ends by building
//     the Dynamic Island in neon at the island's real place.
//  2. Fixed speed: never tied to how long PS takes to load. Ready early: it still plays at its own pace. Still loading at
//     the end: it holds on its calm loop (the neon outline glowing, the scene slowed) until PS is ready, never slower or faster.
//  3. Esc skips the boot animation and the logo reveal (a click too). The Hatch update scene keeps the developer's 'must be watched'.
//  4. It ends on the REAL island: signed in, the neon outline settles into PS's real island (Island.hatchBorn) with the
//     current task, no sign in box. Signed out: the same, then the Sign in window rises in.
//  5. The logo reveal (the old white PS icon turns into the neon knight globe): once, and again from Settings, About and
//     updates, 'Replay the logo reveal'.
//  6. The boot animation replaces the Hatch START scene (same Settings switch, UserDefaults hatch.launch).
//  7. Reduce Motion: a calm fade. No sound at all. Original art only.

/// The three boot animations, numbered as on the approved demo page.
enum CakeScene: Int, CaseIterable {
  case nightDrive = 1, harborLights = 2, citySwarm = 3
  var name: String { ["", "Night drive", "Harbor lights", "City swarm"][rawValue] }
}

enum CakeKind: Equatable { case boot(CakeScene), reveal(replay: Bool) }

enum CakeCore {
  /// The big word on every scene. The developer chose 'CAKE' (21 Nov 2026). A future release changes the look with this one line; the
  /// line under it always reads the running version ('PS 1.73'), so it never needs changing.
  static let headline = "CAKE"
  /// The boot animation played last on this Mac (UserDefaults), so the next start picks another one.
  static let lastKey = "cake.boot.last"
  /// Set once the logo reveal has played (or was skipped) on this Mac: it never comes by itself again.
  static let revealKey = "cake.reveal.seen"

  /// Each scene's own length on the animation clock, from the demo (the developer approved these). Nothing ever scales them.
  static func seconds(_ s: CakeScene) -> Double { s == .nightDrive ? 6.0 : 5.4 }
  static let revealSeconds = 6.4
  /// The scene fades away in this long at its end (after its fixed length, and after PS is ready).
  static let fadeSeconds = 0.6
  /// The longest the calm loop holds for PS to be ready; then the scene ends anyway (the island comes as soon as it can).
  static let holdMax = 20.0
  /// A scene that could not begin within this (1Password or Signal stayed in front) is not played late.
  static let startWait = 20.0

  /// Never the same one twice in a row. `roll` is 0..<1 (random in the app, fixed in the tests). With no last one (the first
  /// start, or a value from somewhere else) any of the three.
  static func pick(last: Int?, roll: Double) -> CakeScene {
    let all = CakeScene.allCases.filter { $0.rawValue != last }
    let r = roll.isFinite ? min(max(roll, 0), 0.999_999) : 0
    return all[Int(r * Double(all.count))]
  }

  /// The boot animation plays: the Start animation switch on, not a start that follows an update (that start plays the
  /// update scene, never both), never in a test copy or the install screen.
  static func playBoot(on: Bool, afterUpdate: Bool, test: Bool, install: Bool) -> Bool { on && !afterUpdate && !test && !install }

  /// How the boot animation ends, asked once the island is built in neon (and again while it holds).
  enum Ending: Equatable { case island, signIn, hold }
  /// signedIn: the vault is open. islandKnown: the page has told the island what to show (its task). signedOut: no
  /// Remember me (or it ran out), the Sign in window is what comes next. locked: Touch ID lock, the island shows.
  /// held: seconds the calm loop has held so far.
  static func ending(signedIn: Bool, islandKnown: Bool, signedOut: Bool, locked: Bool, held: Double) -> Ending {
    if signedIn && islandKnown { return .island }
    if signedOut && !signedIn { return .signIn }
    if locked { return .island }
    return held >= holdMax ? .island : .hold
  }

  /// Every scene is skippable: Esc or a click. The developer, 21 Nov 2026: Esc skips the boot animation and the logo reveal.
  static func skippable(_ k: CakeKind) -> Bool { true }
  /// The longest a scene may stay on screen once it has started, whatever happens (a page that never answers).
  static func maxSeconds(_ k: CakeKind) -> Double {
    switch k {
    case .boot(let s): return seconds(s) + holdMax + fadeSeconds + 4
    case .reveal: return revealSeconds + fadeSeconds + 4
    }
  }

  /// "V1.73 · Something" as "PS 1.73", the line under the headline (the running version, never a fixed number).
  static func versionLine(_ name: String) -> String {
    let v = HatchCore.versionText(name)
    return v.isEmpty ? "PS" : "PS " + v
  }

  /// The logo reveal comes by itself only once per Mac (replays from Settings are always allowed).
  static func revealDue(seen: Bool, test: Bool, install: Bool) -> Bool { !seen && !test && !install }

  /// The island's place as the page sees it, and whether it is the notch shape (top edge) or a pill (moved, or a Mac with
  /// no notch). The outline is drawn a few points larger than it.
  static func notchShaped(_ r: [String: Double]?) -> Bool { (r?["y"] ?? 0) <= 1 }
}
