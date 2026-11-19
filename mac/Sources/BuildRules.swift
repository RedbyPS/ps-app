import Foundation

// Per account rules (V1.58, the developer, 13 Nov 2026). ONE place for the things that differ between the developer's own PS and
// everyone else's (friends, the G Squad, the public build). Plain values only, so tests/buildrules-test.swift checks
// them without macOS. Who is who comes from Owner.red (Owner.swift, said by the server after each unlock).
//
// 1Password and Signal ("protected apps", Protected.swift):
//  - Everyone except the developer: holding Tab opens the list over them (SafePeek, one macOS hotkey, no key read), and the
//    floating island stays on screen while one of them is in front.
//  - the developer: PS never opens over them (SafePeek never arms there, a pinned list goes away) and the island hides while
//    one of them is in front. His golden rule.
//  - Both: PS never reads or touches either app. No names, keys, window titles or bounds, screen, audio, time or
//    network rows, and no log line when one comes to the front. Only the bundle id check in Protected.swift.
//
// PS 1.71 (the developer: two rules per BUILD, never one shared switch): the BUILD decides whenever it says (Profile.allows):
// the G Squad build's profile says on, so it is on there for every account, the developer's too; the developer's private build carries
// its layer's rules (Resources/build-rules.json) and says off, so it is off there for every account, also before
// anyone has signed in. The per account answer below only counts for a build that says nothing (built without a
// profile or a layer, as in V1.57).
//
// To add a person later: add an entry to `table` and say in `account(red:)` (or a later per person setting) who gets
// it. Anyone not named gets "public".
enum BuildRules {
  /// Codable with these exact key names, so a per person settings file (profiles-158, for example profiles/gsquad.json)
  /// can hold the same two fields: {"tabOverProtected": true, "islandOverProtected": true}.
  struct Rules: Codable, Equatable {
    /// Holding Tab (and the list's combos) opens PS while 1Password or Signal is in front.
    var tabOverProtected: Bool
    /// The floating island stays on screen while 1Password or Signal is in front.
    var islandOverProtected: Bool
  }

  static let table: [String: Rules] = [
    "red": Rules(tabOverProtected: false, islandOverProtected: false),
    "public": Rules(tabOverProtected: true, islandOverProtected: true),
  ]

  /// Which entry an account uses. Not known yet (first launch before any sign in) counts as public: a friend must be
  /// able to open PS over Signal before signing in, and the developer's Mac keeps his last answer from launch on.
  static func account(red: Bool) -> String { red ? "red" : "public" }

  static func rules(red: Bool) -> Rules { table[account(red: red)] ?? table["public"]! }
}

/// The island's side of the rule (Island.swift asks these; plain values for the tests).
enum IslandRules {
  /// Whether the island may be on screen with this app in front.
  static func show(protectedFront: Bool, rules: BuildRules.Rules) -> Bool { !protectedFront || rules.islandOverProtected }
  /// Whether the island may look at the windows on screen (its full screen check reads window bounds and logs).
  /// Never while 1Password or Signal is in front, whoever is signed in.
  static func lookAtWindows(protectedFront: Bool) -> Bool { !protectedFront }
}
