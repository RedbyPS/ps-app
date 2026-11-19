import Cocoa
import CryptoKit
import Darwin

// The remote screen's own Dock app (PS 1.69 part 2), PS's half. "Remote Screen.app" ships inside PS (Resources, built by
// tools/remote-screen-app, signed like PS's other helpers). The app icon button at the top left of the remote screen window
// copies it to ~/Applications and opens it once; it then sits in the Dock while it runs, and the person keeps it there with
// one right click (Options, Keep in Dock). PS never edits the Dock or any setting: that one click is the person's.
// The Dock app talks to PS over a Unix socket in PS's own folder (0700, this user only). Before PS acts on a word it checks
// the caller: same user, and its executable is byte for byte the Dock app inside this PS (SHA-256). Words: open, lock,
// sentry, shutdown, restart (Shut down and Restart still ask in PS first, RemoteScreen.menuCommand).

final class RSDockApp {
  static let shared = RSDockApp()
  static let name = "Remote Screen.app"
  private let q = DispatchQueue(label: "ps.screen.dock", qos: .userInitiated)
  private var fd: Int32 = -1
  private var source: DispatchSourceRead?
  /// Main thread: a word from the Dock app that checked out.
  var onVerb: (String) -> Void = { _ in }

  var bundled: URL? { Bundle.main.resourceURL.map { $0.appendingPathComponent(RSDockApp.name) } }
  var installed: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").appendingPathComponent(RSDockApp.name) }
  static var socketDir: String { FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/PS/Screen" }
  static var socketPath: String { socketDir + "/dock.sock" }

  /// At launch (RemoteScreen.start). Test copies never listen.
  func start() {
    guard !IS_TEST_COPY, fd < 0 else { return }
    q.async { [weak self] in self?.startListening() }
  }

  private func startListening() {
    let dir = RSDockApp.socketDir, path = RSDockApp.socketPath
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(dir, 0o700)
    unlink(path)
    let s = socket(AF_UNIX, SOCK_STREAM, 0)
    guard s >= 0 else { return }
    var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { close(s); return }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in bytes.withUnsafeBytes { raw.copyMemory(from: $0) } }
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard bound == 0, listen(s, 4) == 0 else { close(s); return }
    chmod(path, 0o600)
    fd = s
    let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: q)
    src.setEventHandler { [weak self] in self?.acceptOne() }
    src.resume()
    source = src
  }

  private func acceptOne() {
    let c = accept(fd, nil, nil)
    guard c >= 0 else { return }
    defer { close(c) }
    var tv = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    guard let verb = checkedVerb(c) else { return }
    _ = "ok\n".withCString { write(c, $0, 3) }
    DispatchQueue.main.async { [weak self] in self?.onVerb(verb) }
  }

  /// The caller is this user and is exactly the Dock app inside this PS; then one known word.
  private func checkedVerb(_ c: Int32) -> String? {
    var uid: uid_t = 0, gid: gid_t = 0
    guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else { return nil }
    var pid: pid_t = 0; var len = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(c, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0, pid > 1 else { return nil }
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
    let exe = String(cString: buf)
    guard let mine = bundled?.appendingPathComponent("Contents/MacOS/RemoteScreen").path, let want = RSDockRules.sha(mine),
          RSDockRules.sha(exe) == want else { psLog("PS screen: a Dock app request from something else was ignored"); return nil }
    var line = [UInt8](repeating: 0, count: 33)
    let n = read(c, &line, 32)
    guard n > 0 else { return nil }
    return RSDockRules.verb(Data(line[0..<n]))
  }

  /// The window's app icon button: copy the Dock app to ~/Applications (replacing an older copy) and open it once, then say
  /// how to keep it in the Dock. Main thread.
  func install() {
    guard let src = bundled, FileManager.default.fileExists(atPath: src.path) else {
      Toast.shared.show(title: "This PS build has no Dock app", sub: nil, body: nil); return
    }
    let dst = installed
    q.async {
      let fm = FileManager.default
      try? fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
      let same = RSDockRules.sha(dst.appendingPathComponent("Contents/MacOS/RemoteScreen").path) == RSDockRules.sha(src.appendingPathComponent("Contents/MacOS/RemoteScreen").path)
      if !same {
        let tmp = dst.deletingLastPathComponent().appendingPathComponent(".Remote Screen.app.new")
        try? fm.removeItem(at: tmp)
        do {
          try fm.copyItem(at: src, to: tmp)
          if fm.fileExists(atPath: dst.path) { _ = try fm.replaceItemAt(dst, withItemAt: tmp) } else { try fm.moveItem(at: tmp, to: dst) }
        } catch {
          DispatchQueue.main.async { Toast.shared.show(title: "PS could not put Remote Screen in your Applications folder", sub: nil, body: nil) }
          return
        }
      }
      DispatchQueue.main.async {
        NSWorkspace.shared.openApplication(at: dst, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        Toast.shared.show(title: "Remote Screen is in your Dock", sub: nil,
                          body: "To keep it there, right click its icon, then Options, Keep in Dock. Click it any time to see your other Mac.")
        psLog("PS screen: the Dock app was placed in ~/Applications and opened")
      }
    }
  }
}
