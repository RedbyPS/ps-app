import Cocoa

// A fresh copy of this app, started by the app itself (rules in Recovery.swift, TapRecovery).
// It opens its own bundle path (after a PS update that is the new build) with "--replaces <pid>",
// then quits cleanly (exit 0, so launchd does not also start one). The fresh copy waits for the
// old one to be gone before it makes any tap: never two at once. Only its own copy is ever
// touched, by its own handle.
enum SelfRestart {
  private static let key = "tapRelaunchAt"

  /// Wall time (seconds since 1970) of the last fresh start, nil if none. Kept in UserDefaults so
  /// the 5 minute limit holds across copies.
  static var last: Double? {
    let v = UserDefaults.standard.double(forKey: key)
    return v > 0 ? v : nil
  }

  /// Main thread: opens a fresh copy, then quits this one. If it cannot be opened, failed() runs
  /// and this copy keeps trying (the try still counts for the 5 minute limit).
  static func now(_ why: String, failed: @escaping () -> Void) {
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key)
    Log.write("starting a fresh copy of the app (\(why))")
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false
    cfg.addsToRecentItems = false
    cfg.createsNewApplicationInstance = true
    cfg.arguments = [Replaces.flag, String(getpid())]
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { app, err in
      DispatchQueue.main.async {
        if let err {
          Log.write("could not open a fresh copy (\(err.localizedDescription)), this one keeps trying")
          failed()
          return
        }
        Log.write("fresh copy opened (pid \(app.map { String($0.processIdentifier) } ?? "?")), this one quits")
        NSApp.terminate(nil)
      }
    }
  }

  /// Main thread, in the fresh copy: runs start() once the old copy has quit. It waits without
  /// blocking (a process exit source). After 10 s the old copy (same bundle id, its own handle) is
  /// made to quit, and start() runs a moment later.
  static func whenGone(_ old: NSRunningApplication, start: @escaping () -> Void) {
    let pid = old.processIdentifier
    var started = false
    func go() { if !started { started = true; start() } }
    let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    src.setEventHandler { src.cancel(); Log.write("the old copy (pid \(pid)) has quit"); go() }
    src.resume()
    if kill(pid, 0) != 0 { src.cancel(); go(); return }   // gone before the watch began
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
      guard !started else { return }
      Log.write("the old copy (pid \(pid)) is still there after 10 s, making it quit")
      old.forceTerminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { src.cancel(); go() }
    }
  }
}
