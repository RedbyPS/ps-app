import Cocoa

// Which windows a firm press may turn into a middle click (31 Oct 2026, the developer: clicks in Mission
// Control did not work). Only a browser window at the normal window level qualifies. Everything
// else gets its clicks straight through, untouched and undelayed: Mission Control, the Dock,
// Spaces, Launchpad, the menu bar, Notification Center, Control Center, system dialogs, every
// other app, and any window not known yet.
//
// The tap never asks WindowServer anything (that could stall the click it is handling). Each
// mouse event already says which window is under the pointer (a public event field), and this
// cache, filled on a background queue, says what that window is.
// 1Password and Signal windows are only ever marked "pass through", never logged by name.

final class Windows {
  static let shared = Windows()

  /// What a window is, for the tap's purpose.
  enum Kind: Equatable {
    case browser
    case systemUI(layer: Int)   // above the normal window level: menu bar, Dock, Mission Control...
    case other                  // another app's window, or 1Password / Signal
  }

  static let browsers = [
    "com.brave.browser", "com.google.chrome", "com.apple.safari", "com.apple.safaritechnologypreview",
    "company.thebrowser.browser", "company.thebrowser.dia", "org.mozilla.firefox", "com.microsoft.edgemac",
    "com.vivaldi.vivaldi", "com.operasoftware.opera", "com.kagi.kagimacos", "org.chromium.chromium",
    "app.zen-browser.zen",
  ]
  /// Brave, Chrome and Edge ship Beta, Dev and Canary builds as longer ids, so a prefix match.
  static func isBrowser(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return browsers.contains { id == $0 || id.hasPrefix($0 + ".") }
  }

  private let q = DispatchQueue(label: "psmiddleclicker.windows", qos: .userInitiated)
  private let mu = NSLock()
  private var kinds: [CGWindowID: Kind] = [:]
  private var lastRefresh = 0.0
  private var pending = false
  /// pid to "browser / protected / other", so each app is looked up once.
  private var apps: [pid_t: Kind] = [:]

  /// Tap thread: what the window is, nil if not known yet. Never blocks for more than the lock.
  func kind(_ id: CGWindowID) -> Kind? {
    mu.lock(); defer { mu.unlock() }
    return kinds[id]
  }

  /// Any thread: refresh soon, on the background queue (at most one waiting at a time).
  /// minAge: skip if the last refresh is younger than this.
  func refresh(minAge: Double = 0) {
    mu.lock()
    let now = ProcessInfo.processInfo.systemUptime
    if pending || now - lastRefresh < minAge { mu.unlock(); return }
    pending = true
    mu.unlock()
    q.async { self.load() }
  }

  private func load() {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var fresh: [CGWindowID: Kind] = [:]
    var seenApps: [pid_t: Kind] = [:]
    mu.lock(); let known = apps; mu.unlock()
    for w in list {
      guard let num = w[kCGWindowNumber as String] as? Int, let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
      let layer = w[kCGWindowLayer as String] as? Int ?? 0
      if layer != 0 { fresh[CGWindowID(num)] = .systemUI(layer: layer); continue }
      let p = pid_t(pid)
      let app = seenApps[p] ?? known[p] ?? Windows.appKind(p)
      seenApps[p] = app
      fresh[CGWindowID(num)] = app
    }
    mu.lock()
    kinds = fresh
    apps = seenApps
    lastRefresh = ProcessInfo.processInfo.systemUptime
    pending = false
    mu.unlock()
  }

  private static func appKind(_ pid: pid_t) -> Kind {
    let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    if Protected.matches(id) { return .other }   // golden rule: pass through, never looked at further
    return isBrowser(id) ? .browser : .other
  }
}
