// Remote restart, shut down and lock (Second Computer protocol section 13). Second.swift checks the
// signed `cmd` envelope first (a trusted primary or an enrolled phone, for this Mac, good for 2
// minutes, never seen before) and only then calls run(). This file only carries the command out:
//   - lock: locks the screen (no root needed),
//   - restart / shut down: if the Mac is unlocked, a card with a 10 second countdown and Cancel; if it
//     is locked there is nobody to ask, so it goes at once. The work is done by rebootd.
//   - cancel: stops a countdown that is still running.
//   - postpone (V1.28): the auto reboot of this Mac comes an hour later (AutoReboot.postpone, at most
//     12 hours for one countdown). No card: it never restarts anything.
//   - set:<mode>:<minutes> (V1.28, only from the main Mac): this Mac's auto reboot settings, as if the developer had
//     chosen them in its own Security window (Off, Watch only or Active; 10 minutes to 72 hours).
// Nothing here wipes or erases anything. Test copies only record what they would have done.
import Cocoa

final class RemoteCommand {
  static let shared = RemoteCommand()
  static let cancelWindow = 10
  private var pending: (id: String, action: String, from: String, left: Int, done: (Bool, String?) -> Void)?
  private var timer: Timer?
  /// Self test: what a test copy would have done.
  private(set) var testDid: [String] = []

  /// `id`: the command id (also the card id); `from`: the signer's name as the developer knows it ("MacBook M4", "Phone").
  /// `at`: when the command was signed (epoch ms, from its body); one signed before this Mac last
  /// started is dropped, so a restart command can never restart the Mac twice.
  func run(action: String, id: String, from: String, at: Double? = nil, done: @escaping (Bool, String?) -> Void) {
    let at = at.map { $0 / 1000 }
    let who = String(from.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }.prefix(40).map(Character.init))
    psLog("remote command \(action) from \(who)")
    switch action {
    case "lock":
      if IS_TEST_COPY { testDid.append("lock"); return done(true, nil) }
      guard RemoteCommand.lockScreen() else { return done(false, "This macOS has no lock call") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { let ok = RemoteCommand.screenLocked(); done(ok, ok ? nil : "The screen did not lock") }
    case "postpone":
      AutoReboot.shared.postpone(from: who) { done($0 == nil, $0) }
    case "sentry":   // PS 1.69: Sentry mode from the main Mac (the Dock app's menu, the remote screen's menu), with the default plan
      if IS_TEST_COPY { testDid.append("sentry"); return done(true, nil) }
      if RemoteCommand.screenLocked() { return done(false, "This Mac is locked. Sentry mode starts only while it is unlocked.") }
      Sentry.shared.handle("sentry:start", ["plan": [String: Any]()])
      done(true, nil)
    case _ where SecondIdentity.autoRebootSet(action) != nil:
      let s = SecondIdentity.autoRebootSet(action)!
      AutoReboot.shared.setFromMain(mode: s.mode, minutes: s.minutes, from: who)
      done(true, nil)
    case "cancel":
      guard pending != nil else { return done(false, "Nothing to cancel") }
      finish(ok: false, why: "Cancelled from \(who)")
      done(true, nil)
    case "restart", "shutdown":
      if pending != nil { return done(false, "Another restart is already counting down") }
      // No Cancel card for a command that cannot be carried out anyway.
      if !IS_TEST_COPY && AutoReboot.shared.helperState != "on" { return done(false, "The restart helper is not set up on this Mac") }
      if let at, at < RemoteCommand.bootedAt() { return done(false, "Sent before this Mac last started") }
      if RemoteCommand.screenLocked() { return go(action, who, done) }
      pending = (id, action, who, RemoteCommand.cancelWindow, done)
      showCard()
      timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    default:
      done(false, "Unknown command")
    }
  }

  private func tick() {
    guard var p = pending else { timer?.invalidate(); timer = nil; return }
    p.left -= 1; pending = p
    if p.left <= 0 {
      timer?.invalidate(); timer = nil; pending = nil
      Toast.shared.hideCard(cardId(p.id))
      go(p.action, p.from, p.done)
    } else { showCard() }
  }

  private func cardId(_ id: String) -> String { "rr:" + String(id.prefix(30)) }

  private func showCard() {
    guard let p = pending else { return }
    let verb = p.action == "restart" ? "Restarting" : "Shutting down"
    Toast.shared.showCard(["id": cardId(p.id), "sticky": true, "title": "\(verb) this Mac in \(p.left) s",
                           "sub": "Asked from \(p.from)", "body": "Save your work now, or press Cancel.",
                           "actions": [["id": "cancel", "label": "Cancel"]]])
  }

  /// The card's Cancel button (main.swift routes "rr:" card actions here).
  func cardAction(_ id: String, _ action: String) {
    guard let p = pending, cardId(p.id) == id, action == "cancel" else { return }
    finish(ok: false, why: "Cancelled on this Mac")
  }

  private func finish(ok: Bool, why: String) {
    guard let p = pending else { return }
    timer?.invalidate(); timer = nil; pending = nil
    Toast.shared.hideCard(cardId(p.id))
    psLog("remote \(p.action) from \(p.from): \(why)")
    p.done(ok, why)
  }

  private func go(_ action: String, _ from: String, _ done: @escaping (Bool, String?) -> Void) {
    if IS_TEST_COPY { testDid.append(action); return done(true, nil) }
    let reason = "\(action == "restart" ? "restart" : "shut down") asked from \(from)"
    if action == "restart" { AutoReboot.shared.restartNow(reason: reason) { done($0 == nil, $0) } }
    else { AutoReboot.shared.shutDownNow(reason: reason) { done($0 == nil, $0) } }
  }

  /// When this Mac last started (wall epoch seconds).
  static func bootedAt() -> Double {
    var tv = timeval(), size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0 else { return 0 }
    return Double(tv.tv_sec) + Double(tv.tv_usec) / 1e6
  }

  // MARK: the screen

  /// Locked = macOS says the console screen is locked (or nobody is logged in on the console).
  static func screenLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    if (d["kCGSSessionOnConsoleKey"] as? Bool) == false { return true }
    return (d["CGSSessionScreenIsLocked"] as? Bool) == true
  }

  /// The same lock as Control Command Q (login.framework's SACLockScreenImmediate), looked up at run
  /// time so a macOS without it only fails the command. False when the call is missing.
  static func lockScreen() -> Bool {
    guard let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
          let sym = dlsym(h, "SACLockScreenImmediate") else { return false }
    typealias Fn = @convention(c) () -> Void
    unsafeBitCast(sym, to: Fn.self)()
    return true
  }
}
