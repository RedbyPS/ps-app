import AppKit
import Carbon.HIToolbox
import Darwin
import IOKit

// Secure Input watch (V1.41, SecureInputCore.swift has the rules and the words). Every 2 s, off the main thread,
// one cheap Carbon call: is Secure Input on? Only while it is on does PS ask macOS which process holds it (the
// window server's session and the console user's record, which can name different ones) and whether that is the
// app in front. Stuck for 6 s: one log line and the "PS is active" card with the fix and Open list. Off again:
// the card's words go by themselves and the keyboard tap is checked (and switched back on if macOS had turned it
// off). PS never reads keys or windows here; for 1Password or Signal only Protected's bundle id check runs.
final class SecureInputWatch {
  static let shared = SecureInputWatch()
  /// Whether any app has Secure Input on right now (one cheap Carbon call, any thread).
  static func isOn() -> Bool { IsSecureEventInputEnabled() }
  /// Main thread: the card's words, nil when there is nothing to tell.
  var onChange: ((String?) -> Void)?
  /// Main thread: Secure Input went off after it had been told. Returns what happened to the tap, for the log.
  var onEnded: (() -> String)?
  /// Main thread (V1.44): stuck on in the background for 2 s (true), or not any more (false). SafePeek arms its plain
  /// Tab hotkey meanwhile, so holding Tab opens the list even though the keyboard tap hears nothing.
  var onStuck: ((Bool) -> Void)?
  /// Main thread (PS 1.70, the Tab blocked alert): the app in FRONT has held Secure Input for 2 s (true), or not any more
  /// (false). Normal while you type a password, so no card; SafePeek takes plain Tab meanwhile only to see a hold
  /// (TabBlocked.swift). Never true for 1Password or Signal in front, nor for PS's own window.
  var onFront: ((Bool) -> Void)?
  /// Main thread: who holds Secure Input as last read (nil: off, or macOS names nobody). 1Password and Signal arrive
  /// here with no name (holders() drops it at the first read).
  private(set) var holder: SecureHolder?
  private var arm = SecureDebounce()
  private var armed = false
  private var frontArm = SecureDebounce()
  private var frontArmed = false
  private let q = DispatchQueue(label: "ps.secureinput", qos: .utility)
  private var timer: DispatchSourceTimer?
  // main thread only
  private var debounce = SecureDebounce()
  private var told: String?          // the label told, nil while nothing is told
  private var text: String?
  private var lastOn = false         // q only: the last answer, so an off Mac costs one call per tick

  func start() {
    guard timer == nil, ProcessInfo.processInfo.environment["PS_SELFTEST"] == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 3, repeating: 2, leeway: .milliseconds(500))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
  }

  private func tick() {
    let on = IsSecureEventInputEnabled()
    if !on && !lastOn { return }      // the usual case: nothing to do, nothing sent to main
    lastOn = on
    let hs = on ? SecureInputWatch.holders() : []
    DispatchQueue.main.async { [weak self] in self?.decide(on, hs) }
  }

  private func decide(_ on: Bool, _ hs: [SecureHolder]) {
    let me = ProcessInfo.processInfo.processIdentifier
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let s = SecureInputCore.stuck(on: on, holders: hs, frontPid: frontPid)
    let a = arm.step(stuck: s.stuck, now: Date(), after: 2)
    if a != armed { armed = a; onStuck?(a) }
    // PS 1.70: held by the app in front (a password box, or one left on like DuckDuckGo's on 19 Nov).
    let fh = SecureInputCore.frontHolder(on: on, holders: hs, frontPid: frontPid, me: me, protectedFront: Protected.front)
    holder = s.stuck ? s.holder : (fh ?? hs.first)
    let f = frontArm.step(stuck: fh != nil, now: Date(), after: TabBlockedCore.frontAfter)
    if f != frontArmed { frontArmed = f; onFront?(f) }
    let show = debounce.step(stuck: s.stuck, now: Date(), after: 6)
    if show {
      let label = SecureInputCore.label(s.holder, me: me, appName: AppName.current)
      if label != told { psLog(SecureInputCore.logOn(label)); told = label }
      set(SecureInputCore.notice(label: label, appName: AppName.current))
    } else if told != nil && !on {
      told = nil
      let tap = onEnded?() ?? "not checked"
      psLog("PS tab: macOS Secure Input is off again, keys reach PS (tap \(tap))")
      set(nil)
    } else if told != nil && !s.stuck {
      // Still on, but now held only by the app in front (a password box): not stuck any more.
      told = nil
      psLog("PS tab: macOS Secure Input now only in the app in front, card cleared")
      set(nil)
    }
  }

  private func set(_ t: String?) {
    guard t != text else { return }
    text = t
    onChange?(t)
  }

  /// The processes macOS names as holding Secure Input (the session's latest, and the console user's record).
  static func holders() -> [SecureHolder] {
    var pids: [Int32] = []
    if let d = CGSessionCopyCurrentDictionary() as? [String: Any], let p = (d["kCGSSessionSecureInputPID"] as? NSNumber)?.int32Value, p > 0 {
      pids.append(p)
    }
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    if root != 0 {
      if let v = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
         let users = v as? [[String: Any]] {
        for u in users {
          if let p = (u["kCGSSessionSecureInputPID"] as? NSNumber)?.int32Value, p > 0, !pids.contains(p) { pids.append(p) }
        }
      }
      IOObjectRelease(root)
    }
    return pids.map { p in
      let a = NSRunningApplication(processIdentifier: p)
      let id = a?.bundleIdentifier
      if Protected.matches(id) { return SecureHolder(pid: p, bundleId: id, name: nil) }   // golden rule: no name read
      return SecureHolder(pid: p, bundleId: id, name: a?.localizedName ?? procName(p))
    }
  }

  private static func procName(_ p: Int32) -> String? {
    var buf = [CChar](repeating: 0, count: 256)
    guard proc_name(p, &buf, UInt32(buf.count)) > 0 else { return nil }
    return String(cString: buf)
  }
}
