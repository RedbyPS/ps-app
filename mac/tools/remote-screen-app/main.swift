// "Remote Screen", the remote screen's own app in the Dock (PS 1.69 part 2). A tiny app with no window: PS installs it
// (the app icon button at the top left of the remote screen window copies it to ~/Applications and opens it once), and the
// person keeps it in the Dock with one right click (Options, Keep in Dock): PS never edits the Dock or any setting itself.
//  - Clicking it (opening it, or clicking its Dock icon while it runs) asks PS to open the remote screen and connect.
//  - Its Dock menu (right click): Lock, Sentry mode, Shut down, Restart, the same four as in the window. PS carries them out
//    (Shut down and Restart ask first, in PS).
// It talks only to PS, over a Unix socket in PS's own folder (0700). PS checks that the caller is this exact app (its
// executable's SHA-256 against the copy inside PS) before it does anything. No network, no keys, nothing saved.
// If PS is not running it opens PS and tries again for a few seconds.
import Cocoa

let SOCKET = FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/PS/Screen/dock.sock"
let PS_ID = "com.cincee.ps"

/// Sends one word to PS. True when PS took it.
func send(_ verb: String) -> Bool {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let path = Array(SOCKET.utf8CString)
  guard path.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return false }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in path.withUnsafeBytes { raw.copyMemory(from: $0) } }
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  guard ok == 0 else { return false }
  let line = Array((verb + "\n").utf8)
  guard write(fd, line, line.count) == line.count else { return false }
  var b = [UInt8](repeating: 0, count: 8)
  return read(fd, &b, b.count) > 0 && b[0] == UInt8(ascii: "o")   // "ok"
}

final class Launcher: NSObject, NSApplicationDelegate {
  private var tries = 0

  func applicationDidFinishLaunching(_ n: Notification) { ask("open") }
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool { ask("open"); return false }

  /// Sends it; if PS is not there yet, opens PS and tries again every half second for 10 seconds.
  private func ask(_ verb: String) {
    if send(verb) { tries = 0; return }
    if tries == 0, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: PS_ID) {
      NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
    }
    tries += 1
    guard tries <= 20 else { tries = 0; return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.ask(verb) }
  }

  func applicationDockMenu(_ s: NSApplication) -> NSMenu? {
    let m = NSMenu()
    for (title, verb) in [("Lock", "lock"), ("Sentry mode", "sentry"), ("Shut down", "shutdown"), ("Restart", "restart")] {
      let i = NSMenuItem(title: title, action: #selector(pick(_:)), keyEquivalent: "")
      i.target = self; i.representedObject = verb
      m.addItem(i)
    }
    return m
  }
  @objc private func pick(_ i: NSMenuItem) { if let v = i.representedObject as? String { tries = 0; ask(v) } }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
