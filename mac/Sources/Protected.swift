import Cocoa

// THE DEVELOPER'S GOLDEN RULE: PS never looks at or touches 1Password or Signal. Not their names, not their
// time, not their keystrokes, never brings them forward. The only thing PS ever checks is whether
// the app in front IS one of them (its bundle id, at the moment it comes to the front), so it can
// step aside completely. Matching is broad on purpose: any 1Password or Signal build or helper.
// While one of them is in front the keyboard tap is switched OFF (macOS hands PS none of its keys).
// Whether the Tab list (SafePeek, one macOS hotkey for plain Tab, so PS still never sees a key typed in either app)
// and the floating island may show over them is decided per BUILD since PS 1.71 (BuildRules.swift, Profile.allows):
// yes in the G Squad build for every account, never in the developer's own build. A build that says nothing: per account as in
// V1.58 (yes for everyone except the developer).
enum Protected {
  static func matches(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return id.contains("1password") || id.contains("agilebits") || id.contains("whispersystems") || id.contains("signal")
  }
  static func matches(_ app: NSRunningApplication?) -> Bool { matches(app?.bundleIdentifier) }
  static func isSignal(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return id.contains("whispersystems") || id.contains("signal")
  }

  /// True while 1Password or Signal is the app in front. Kept up to date by one observer, so the
  /// keyboard tap can step aside instantly without asking macOS on every key.
  private(set) static var front = false
  /// True while the app in front is Signal (not 1Password). Since V1.40 nothing depends on it: the rules
  /// treat both the same. Kept so the self tests can still say which of the two they are pretending is in front.
  private(set) static var signalFront = false
  /// Runs on the main thread whenever either flag changes.
  static var onChange: (() -> Void)?
  static func start() {
    set(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
      set((n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier)
    }
  }
  private static func set(_ id: String?) {
    let f = matches(id), s = f && isSignal(id)
    guard f != front || s != signalFront else { return }
    front = f; signalFront = s
    onChange?()
  }
  /// Self test only: act as if 1Password or Signal were in front (no real app is involved).
  static func simulate(front f: Bool, signal s: Bool) { front = f; signalFront = s; onChange?() }
}
