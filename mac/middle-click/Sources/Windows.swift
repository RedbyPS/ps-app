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
// V1.72 (21 Nov 2026): a browser window holding one of Apple's own panels, such as Brave's save box
// sheet, is not a browser window for this purpose (PanelHost.swift says why and how).
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
  /// pid to "browser / protected / other" (and panel service), so each app is looked up once.
  private var apps: [pid_t: App] = [:]
  /// Browser windows that hold a system panel right now (PanelHost), for the one log line each.
  private var panelHosts = Set<UInt32>()

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
    // Every window (V1.72): the on screen ones are sorted as before; the rest only matter when they
    // belong to an AppKit panel service (PanelHost), whose window need not be on screen itself.
    let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var fresh: [CGWindowID: Kind] = [:]
    var seenApps: [pid_t: App] = [:]
    var browserWins: [(id: UInt32, frame: CGRect)] = []
    var panels: [CGRect] = []
    mu.lock(); let known = apps; mu.unlock()
    for w in list {
      guard let num = w[kCGWindowNumber as String] as? Int, let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
      let layer = w[kCGWindowLayer as String] as? Int ?? 0
      let on = w[kCGWindowIsOnscreen as String] as? Bool ?? false
      if !on && layer != 0 { continue }
      let p = pid_t(pid)
      let app = seenApps[p] ?? known[p] ?? Windows.appInfo(p)
      seenApps[p] = app
      if app.panelService && layer == 0, let f = Windows.frame(w) { panels.append(f) }
      guard on else { continue }
      if layer != 0 { fresh[CGWindowID(num)] = .systemUI(layer: layer); continue }
      fresh[CGWindowID(num)] = app.kind
      if app.kind == .browser, let f = Windows.frame(w) { browserWins.append((UInt32(num), f)) }
    }
    let hosts = PanelHost.hosts(browserWins, panels: panels)
    for id in hosts { fresh[CGWindowID(id)] = .other }
    mu.lock()
    let new = hosts.subtracting(panelHosts)
    panelHosts = hosts
    kinds = fresh
    apps = seenApps
    lastRefresh = ProcessInfo.processInfo.systemUptime
    pending = false
    mu.unlock()
    // One line per sheet, no names: what the window is for is not looked at.
    for id in new.sorted() { Log.write("browser window \(id) holds a system panel (a save or open box), its clicks pass straight through") }
  }

  private static func frame(_ w: [String: Any]) -> CGRect? {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b as CFDictionary)
  }

  /// What an app is, for the tap: its kind, and whether it is an AppKit panel service (PanelHost).
  struct App: Equatable { var kind: Kind; var panelService = false }

  private static func appInfo(_ pid: pid_t) -> App {
    let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    if Protected.matches(id) { return App(kind: .other) }   // golden rule: pass through, never looked at further
    return App(kind: isBrowser(id) ? .browser : .other, panelService: PanelHost.isPanelService(id))
  }
}
