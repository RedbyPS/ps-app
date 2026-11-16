import Cocoa

// Embedded mode: the same app, built as "PS Middle Click", lives inside PS
// (PS.app/Contents/Library/LoginItems) and runs as its own process, so PS restarts and updates
// never drop a click and a tap problem can never take PS down. Info.plist key PSMCEmbedded = true.
// - No menu bar icon: PS Settings is its switch (PS starts and stops it by its own handle).
// - Never asks for Accessibility by itself: it waits quietly until PS Settings asks (one click).
// - Never runs alongside the standalone PSMiddleClicker: while that app runs, the helper keeps
//   its tap off and waits, and takes over again when it quits.
// - Tells PS how it is doing through a small JSON file plus a distributed notification
//   (~/Library/Application Support/PS/middleclick.json, "com.cincee.ps.middleclick.changed").

enum Helper {
  static let embedded = Bundle.main.object(forInfoDictionaryKey: "PSMCEmbedded") as? Bool == true
  static let standaloneID = "com.cincee.psmiddleclicker"
  static let changed = Notification.Name("com.cincee.ps.middleclick.changed")
  /// From PS, after the person clicks the permission button in PS Settings: ask macOS now.
  /// The helper never asks by itself, so a Mac where it is on by default gets no surprise prompt.
  static let askNotice = Notification.Name("com.cincee.ps.middleclick.ask")
  static let stateURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/PS/middleclick.json")

  /// True while the standalone PSMiddleClicker is running (then the helper waits).
  private(set) static var yielding = false
  private static var lastJSON = ""

  /// Main thread, once at start (embedded only): watch for the standalone app coming and going.
  static func start(onChange: @escaping () -> Void) {
    yielding = standaloneRunning()
    let nc = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
      nc.addObserver(forName: name, object: nil, queue: .main) { n in
        guard (n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == standaloneID else { return }
        let y = standaloneRunning()
        guard y != yielding else { return }
        yielding = y
        Log.write(y ? "PSMiddleClicker app started: this helper waits (never both at once)" : "PSMiddleClicker app quit: this helper takes over")
        onChange()
      }
    }
  }

  private static func standaloneRunning() -> Bool {
    NSRunningApplication.runningApplications(withBundleIdentifier: standaloneID).contains { !$0.isTerminated }
  }

  /// Main thread: writes the state for PS when it changed (and always when forced).
  static func publish(trusted: Bool, tap: Bool, running: Bool = true, force: Bool = false) {
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
    let json = #"{"running":\#(running),"trusted":\#(trusted),"tap":\#(tap),"yielding":\#(yielding),"build":"\#(build)","pid":\#(getpid())}"#
    guard force || json != lastJSON else { return }
    lastJSON = json
    try? FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data(json.utf8).write(to: stateURL, options: .atomic)
    DistributedNotificationCenter.default().postNotificationName(changed, object: nil, userInfo: nil, deliverImmediately: true)
  }
}
