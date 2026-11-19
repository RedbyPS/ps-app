import Foundation

// Tab blocked alert (PS 1.70, the developer 19 Nov 2026: "When PS sees Tab being held but the Tab overlay can't open, the island
// pops out with a fancy animation. It names the app that has taken over the Tab key and shows a few short steps to fix
// it."). The rules and the words only, with no macOS calls, so tests/tab-blocked-test.swift runs them offline.
// TabBlocked.swift asks macOS, watches for the hold and draws the card.
//
// When PS is blind to Tab (the keyboard tap hears nothing):
//  - Secure Input: an app has macOS Secure Input on (a password box), so macOS hands PS no keys. On 19 Nov it was
//    DuckDuckGo with a password box in front: PS said nothing, because a password box in the app in front was taken as
//    normal (SecureInputCore.stuck). The holder is named; 1Password and Signal never are ("a password app", no icon).
//  - Permission: PS lost its keyboard permission (not trusted), or macOS passes it no keys although it is (deaf).
// Never while: the switch is off, the Tab overlay is off, plain Tab is not one of the hold keys, the list is up or kept,
// Sleep mode or Sentry mode is up, PS's own window is in front, the app in front is on the ignore list, 1Password or
// Signal is in front (golden rule: PS reads nothing there, not even whether Tab is down), or PS itself holds Secure Input.
//
// How the hold is seen (TabBlocked.swift has the reasons):
//  - hotkey: SafePeek's plain Tab hotkey (a Carbon hotkey: macOS does the matching in the window server and tells PS only
//    "Tab went down" and "Tab came up"). Armed now also while the app in front holds Secure Input.
//  - keyState: macOS's own record of which keys are down (CGEventSourceKeyState on the HID state), polled about 12 times
//    a second only while PS is blind. macOS may hide it under Secure Input too; it is the way in for a lost permission.
// The first signal to see Tab held for `holdFor` fires the card, once per hold, rate limited.

enum TabBlockedCause: String, Equatable {
  case secureInput
  case permission
}

/// What PS knows right now (plain values).
struct TabBlockedFacts: Equatable {
  var on = true               // Settings: "Tell me when Tab is blocked"
  var enabled = true          // the Tab overlay is on
  var holdsTab = true         // plain Tab is one of the hold keys
  var trusted = true          // macOS lets PS see keys (AXIsProcessTrusted)
  var deaf = false            // trusted, yet a fresh keyboard tap gets no keys while you type (TabWatch.deafCheck)
  var secureOn = false        // some app has Secure Input on
  var holderIsMe = false      // PS's own Sign in window holds it (you are typing the passphrase)
  var protectedFront = false  // 1Password or Signal is in front
  var shown = false           // the list is up
  var kept = false            // Keep overlay
  var sleepUp = false         // Sleep mode or Sentry mode
  var appActive = false       // PS's own Sign in window is in front
  var frontIgnored = false    // the app in front is on PS's "leave the key alone" list
  var testCopy = false
}

/// The card's words (no em or en dashes; the tests check).
struct TabBlockedText: Equatable {
  var title: String
  var line: String
  var steps: [String]
  var button: String?         // Open Settings (the permission card); nil: only OK
}

/// Who holds Secure Input, as the card says it.
enum TabBlockedHolder: Equatable {
  case app(String)            // a name PS may say
  case secureEntry(String)    // a terminal with Secure Keyboard Entry switched on in its own menu (it stays on)
  case lockScreen
  case passwordApp            // 1Password or Signal: never named, no icon
  case unknown
}

/// What the card remembers between shows.
struct TabBlockedMemo: Equatable {
  var lastShown = -Double.greatestFiniteMagnitude
  var closedKey: String?
  var closedAt = -Double.greatestFiniteMagnitude
}

enum TabBlockedCore {
  /// Tab held this long (seconds) with the list not up: the card. The list itself opens after 0.18 s (HOLD_SECONDS).
  static let holdFor: Double = 0.5
  /// The key state poll's beat while PS is blind (seconds). Only while blind, so a Mac where nothing is wrong never polls.
  static let pollEvery: Double = 0.08
  /// No two cards closer than this (seconds).
  static let gap: Double = 3
  /// Closed with Esc, its x or OK: the same cause and app stay quiet this long (seconds). Short on purpose: a hold
  /// that does nothing for long is the silence this card exists to end.
  static let quietAfterClose: Double = 10
  /// "Tab works again" stays this long, then goes by itself (seconds).
  static let fixedFor: Double = 2.5
  /// The app in front must hold Secure Input this long before SafePeek takes Tab to watch for a hold (seconds).
  static let frontAfter: Double = 2
  /// The name of the pane in System Settings, Privacy and Security. macOS 27 renamed Accessibility: its own English
  /// string for ACCESSIBILITY (SecurityPrivacyExtension.appex, checked on 27.2.1) is the one below, as Installer.axPane.
  static func paneName(macOSMajor: Int) -> String { macOSMajor >= 27 ? "Device Control and Data Access" : "Accessibility" }

  /// Why PS is blind to Tab right now, or nil when it is not (or the card must stay out of the way).
  static func blind(_ f: TabBlockedFacts) -> TabBlockedCause? {
    guard f.on, f.enabled, f.holdsTab, !f.testCopy else { return nil }
    if f.protectedFront || f.shown || f.kept || f.sleepUp || f.appActive || f.frontIgnored { return nil }
    if !f.trusted || f.deaf { return .permission }
    if f.secureOn && !f.holderIsMe { return .secureInput }
    return nil
  }

  /// Terminals whose app menu has "Secure Keyboard Entry": while it is ticked they hold Secure Input all the time.
  static let secureEntryApps: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty"]

  /// The holder from SecureInputCore.label's answer ("the lock screen", "a password app", "another app" or a name).
  static func holder(label: String, appName: String, bundleId: String? = nil) -> TabBlockedHolder {
    switch label {
    case "the lock screen": return .lockScreen
    case "a password app": return .passwordApp
    case "another app", "", appName: return .unknown
    default: return bundleId.map { secureEntryApps.contains($0) } == true ? .secureEntry(label) : .app(label)
    }
  }

  /// Rate limit: true when a card may come up now for `key` (the cause and the holder).
  static func allow(key: String, now: Double, memo: TabBlockedMemo, up: Bool) -> Bool {
    if up { return false }
    if now - memo.lastShown < gap { return false }
    if memo.closedKey == key && now - memo.closedAt < quietAfterClose { return false }
    return true
  }
  static func shown(_ m: TabBlockedMemo, now: Double) -> TabBlockedMemo { var m = m; m.lastShown = now; return m }
  static func closed(_ m: TabBlockedMemo, key: String, now: Double) -> TabBlockedMemo { var m = m; m.closedKey = key; m.closedAt = now; return m }

  /// The key the rate limit and the log use. Never a protected app's name: the holder is already neutral by then.
  static func key(_ cause: TabBlockedCause, _ h: TabBlockedHolder?) -> String {
    switch (cause, h) {
    case (.permission, _): return "permission"
    case (_, .app(let n)?), (_, .secureEntry(let n)?): return "secure:" + n
    case (_, .lockScreen?): return "secure:lock"
    case (_, .passwordApp?): return "secure:password"
    default: return "secure:unknown"
    }
  }

  /// The card's words.
  static func text(_ cause: TabBlockedCause, holder: TabBlockedHolder?, appName: String, pane: String) -> TabBlockedText {
    let hides = "which hides your keys from \(appName)."
    let again = "Then hold Tab again."
    switch cause {
    case .permission:
      return TabBlockedText(title: "\(appName) can't see the Tab key",
                            line: "macOS turned off its keyboard permission.",
                            steps: ["Click Open Settings.", "Find \(appName) in \(pane).", "Turn it off, then on again."],
                            button: "Open Settings")
    case .secureInput:
      switch holder ?? .unknown {
      case .app(let n):
        return TabBlockedText(title: "\(n) is blocking Tab", line: "It turned on Secure Input, \(hides)",
                              steps: ["Click outside the password box in \(n).", "Or quit \(n).", again], button: nil)
      case .secureEntry(let n):
        return TabBlockedText(title: "\(n) is blocking Tab", line: "Its Secure Keyboard Entry is on, \(hides)",
                              steps: ["Click the \(n) menu at the top of the screen.", "Turn off Secure Keyboard Entry.", again], button: nil)
      case .passwordApp:
        return TabBlockedText(title: "A password app is blocking Tab", line: "It turned on Secure Input, \(hides)",
                              steps: ["Click outside the password box in your password app.", "Or lock it or quit it.", again], button: nil)
      case .lockScreen:
        return TabBlockedText(title: "macOS is blocking Tab", line: "The lock screen left Secure Input on, \(hides)",
                              steps: ["Lock your Mac with Control Command Q.", "Unlock it with your password.", again], button: nil)
      case .unknown:
        return TabBlockedText(title: "Another app is blocking Tab", line: "Secure Input is on, \(hides)",
                              steps: ["Click outside any password box.", "Or lock your Mac with Control Command Q, then unlock it.", again], button: nil)
      }
    }
  }

  static let ok = "OK"
  static let fixed = "Tab works again"
  static let closeHelp = "Close (Esc)"

  /// Log lines. The holder part is the card's own wording, so 1Password and Signal are never in the log.
  static func logShow(_ cause: TabBlockedCause, holder: TabBlockedHolder?, signal: String) -> String {
    let who: String
    switch holder {
    case .app(let n)?, .secureEntry(let n)?: who = n
    case .lockScreen?: who = "the lock screen"
    case .passwordApp?: who = "a password app"
    default: who = cause == .permission ? "no permission" : "an unknown app"
    }
    return "PS tab blocked: Tab held \(holdFor) s and the list could not open (\(cause.rawValue), \(who), seen by \(signal)), showing the card"
  }
}

/// One hold of Tab, sample by sample: true once per hold, when it has been down `after` seconds without a break.
struct TabHoldClock {
  private(set) var since: Double?
  private(set) var fired = false
  mutating func step(down: Bool, now: Double, after: Double = TabBlockedCore.holdFor) -> Bool {
    guard down else { since = nil; fired = false; return false }
    if since == nil { since = now }
    if !fired, let s = since, now - s >= after { fired = true; return true }
    return false
  }
  mutating func reset() { since = nil; fired = false }
}
