// Who is signed in, for the native features that are the developer's own (public PS, 27 Oct 2026).
// PS is handed to other people too. Some native parts are the developer's hardware conveniences and must stay
// off and harmless for everyone else: the AirPods Max switch and USB mic (AutoRoute.swift) and the
// background videos from the vault (Backgrounds.swift). The AirPods controls card (MediaGuard.swift) is everyone's
// since V1.40.
// (The daily reminder card, now the Annoying 15 min reminders in Reminders.swift, is everyone's since 7 Nov 2026; only its default words and time zone
// follow this.)
// The page says who it is after each unlock ({type:"owner", red}, from web
// src/core/account.ts isRedAccount). Off until it says so; the last answer is kept on this Mac so
// The developer's features start at launch; Sign out of this Mac clears it. A wrong answer only switches
// these conveniences, never data: every developer-only feed is sealed to the developer's key on the server side.
import Foundation

enum Owner {
  private static let key = "owner.red"
  /// Test copies never read or write the developer's real settings: PS_SELFTEST_RED=0 makes one a stranger's.
  private static let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  private static var testRed = ProcessInfo.processInfo.environment["PS_SELFTEST_RED"] != "0"
  /// Main thread, when the answer changes (V1.58: the per account rules in BuildRules.swift follow it at once).
  static var onChange: (() -> Void)?
  /// Called on main the first time the developer is known on this run (his features start then).
  private static var waiting: [() -> Void] = []

  static var red: Bool { (test ? testRed : UserDefaults.standard.bool(forKey: key)) && ProjectStore.isRed }

  /// Runs `start` now if this is the developer's PS, else as soon as the page says it is (once).
  static func whenRed(_ start: @escaping () -> Void) {
    if red { start() } else { waiting.append(start) }
  }

  /// From the page (main thread). Only a change is logged and saved.
  /// The developer's features need the developer's own Supabase project: the first owner of any project someone linked
  /// themselves (Project.swift) is never the developer, whatever the page says (fails closed).
  static func set(_ said: Bool) {
    let v = said && ProjectStore.isRed
    if v != red {
      if test { testRed = v } else { UserDefaults.standard.set(v, forKey: key) }
      psLog("PS owner: \(v ? "primary account, its own features on" : "not the primary account, its own features stay off")")
      onChange?()
    }
    if v { let w = waiting; waiting = []; w.forEach { $0() } }
  }
}

extension BuildRules {
  /// Self test only: pretend to be the developer's account (true) or anyone else's (false). nil: who is really signed in.
  static var testAccount: Bool?
  /// The rules for this build and whoever is signed in on this Mac now.
  /// PS 1.71: what the build says decides (the bundled profile, else the layer's rules, Profile.swift); the account only
  /// where the build says nothing. Self tests (testAccount set) skip the build and pretend to be that account.
  static var now: Rules {
    let a = rules(red: testAccount ?? Owner.red)
    return testAccount != nil ? a : fromProfile(a)
  }
}
