import Foundation

// Secure Input (V1.41, the developer, 7 Nov 2026). While any app has macOS's Secure Event Input switched on, macOS hands
// NO keys to a keyboard tap: holding Tab does nothing, silently, in every app. Normal while you type in a password
// box (it goes off when you leave it), but a lock and unlock sometimes leaves it on (the lock screen, or an app
// that never switched it off). This file decides, from plain values only, when that is worth telling and what
// to say. SecureInput.swift asks macOS. Golden rule: 1Password and Signal are never named, only "a password app".

/// One process macOS says has Secure Input on.
struct SecureHolder: Equatable {
  var pid: Int32
  var bundleId: String?
  var name: String?
}

enum SecureInputCore {
  static let lockScreenId = "com.apple.loginwindow"

  /// Who the developer is told holds it.
  static func label(_ h: SecureHolder?, me: Int32, appName: String) -> String {
    guard let h else { return "another app" }
    if h.pid == me { return appName }
    if h.bundleId == lockScreenId || h.name == "loginwindow" { return "the lock screen" }
    if Protected.matches(h.bundleId) || Protected.matches(h.name) { return "a password app" }
    if let n = h.name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { return String(n.prefix(40)) }
    return "another app"
  }

  /// Stuck means worth telling: it is on and no holder is the app in front (a password box in
  /// the app you are typing in is normal and goes away by itself). On with no holder macOS will name: stuck too.
  /// Returns the holder to name (nil: unknown), or `stuck: false`.
  static func stuck(on: Bool, holders: [SecureHolder], frontPid: Int32?) -> (stuck: Bool, holder: SecureHolder?) {
    guard on else { return (false, nil) }
    if holders.isEmpty { return (true, nil) }
    // Any holder in front: most likely the password box you are typing in (macOS's two records can lag behind
    // each other), so never a card then. Switching to another app while it stays on shows it.
    if let f = frontPid, holders.contains(where: { $0.pid == f }) { return (false, nil) }
    // The lock screen first: it is the usual leftover and its fix is the clearest.
    if let l = holders.first(where: { $0.bundleId == lockScreenId || $0.name == "loginwindow" }) { return (true, l) }
    if let h = holders.first(where: { $0.pid != frontPid }) { return (true, h) }
    return (false, nil)
  }

  /// PS 1.70 (the Tab blocked alert): the holder that is the app in FRONT, or nil. Never PS itself (its own passphrase
  /// box), never 1Password or Signal in front (golden rule: PS reads nothing there).
  static func frontHolder(on: Bool, holders: [SecureHolder], frontPid: Int32?, me: Int32, protectedFront: Bool) -> SecureHolder? {
    guard on, !protectedFront, let f = frontPid, f != me else { return nil }
    return holders.first { $0.pid == f && !Protected.matches($0.bundleId) && !Protected.matches($0.name) }
  }

  /// The card's words.
  static func notice(label: String, appName: String) -> String {
    let lead = "macOS has paused keys to \(appName) and apps like it (Secure Input"
    let relock = "lock the screen with Control Command Q and unlock by typing your password"
    switch label {
    case "the lock screen": return "\(lead), left on by the lock screen). To fix it, \(relock)."
    case "a password app": return "\(lead), held by a password app). Close the password box in it or quit it, or \(relock)."
    case "another app": return "\(lead), held by another app). To fix it, \(relock)."
    default: return "\(lead), held by \(label)). Quit \(label), or \(relock)."
    }
  }

  static func logOn(_ label: String) -> String { "PS tab: macOS Secure Input is on, held by \(label)" }
}

/// Tells only after it has been stuck for `after` seconds without a break: switching apps or a moment in a
/// password box never shows the card.
struct SecureDebounce {
  private(set) var since: Date?
  mutating func step(stuck: Bool, now: Date, after: Double) -> Bool {
    guard stuck else { since = nil; return false }
    if since == nil { since = now }
    return now.timeIntervalSince(since!) >= after
  }
}
