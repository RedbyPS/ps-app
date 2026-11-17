// AFK timer (the developer, 22 Oct 2026, "kind of a screen time addition"). After 10 minutes (PS > Settings)
// with no keyboard, mouse or trackpad input, a card swoops in at the top centre of the screen:
// "AFK for 10:00 minutes" and a stopwatch counting the WHOLE time away since the last input. It
// keeps counting through any typing or mouse movement (the developer, 22 Oct: "continue until I literally
// dismiss it"); only its "Back in the game" button stops it and puts it away. The first input after
// it started is kept too ("Back at your Mac since"). Each finished stretch goes to the main window,
// which saves it in the vault as a named break ("AFK") on the screen time timeline.
//
// Input: only the system's time since the last input (CGEventSource, the same reading screen time
// uses), polled once a second on its own queue. Never the keyboard tap, never which key.
// Not counted: while an exempt app is in front (PS > Settings), while 1Password or Signal is in
// front (always, golden rule: never named, never listed), and (optional) while a video keeps the
// display awake. Sleep, lock and display sleep keep the true time: the start is kept on disk and
// a stretch that spanned a sleep is found from the last input before it and the first after.
// The card never takes focus or keys, is only as big as itself (clicks elsewhere reach the apps
// below), and shows on every Space and over full screen apps.
// Passive (the developer, 22 Oct): the card's "Passive" button morphs it into a tiny stopwatch in the top
// left corner (just the running time in a thin purple outline). Hovering it opens a small pop-up
// with the details, "Back in the game" and "Full card"; leaving shrinks it again. Passive is kept
// with the stretch on disk, so sleep, lock and a restart keep it. "Start in passive" (off) skips
// the big card. The meeting notes card (NotesCard.swift) sits just below whatever is up there.
// Watcher (23 Oct): "Watcher" on the card (for a film): pick how long (wheel through 15 min to 3 h,
// Shorter and Longer for any other length, a click confirms). The card closes, the stretch is saved,
// and no AFK card starts until it ends; then "Watcher mode ended" with Back in the game and Extend
// (if the developer is idle then, the AFK clock runs from the end). Kept on disk with wall clock time.
// The card's gear sets how the stopwatch looks (outline, colours, font, size, see through,
// brightness, how obvious), with a live preview. The stopwatch can be dragged anywhere (snaps to the
// edges, remembered per display) and made invisible (hovering its spot brings it back). The Tab list
// shows "AFK 14:32" or "Watcher 42:10 left" top right while either runs; a click brings the card.
// Meetings (V1.40, the developer 7 Nov 2026): while a calendar meeting is on (Sources/MeetingTime.swift, from the
// Meetings panel's events, 5 minutes before to 10 after), no card comes up and a card already up goes away
// (the part before the meeting is kept as a break; nothing inside it is). When the meeting is over the clock
// starts from its end, so sitting still through a call is never AFK. "Stay off during meetings", on by default.
import AppKit
import CoreGraphics
import IOKit.pwr_mgt
import WebKit

final class AfkPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class Afk: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Afk()

  /// Hands a finished stretch (JSON) to the main window; false when the vault is not open yet (kept for later).
  var deliver: ((String) -> Bool)?
  /// Settings changed: PS > Settings redraws.
  var onSettings: (() -> Void)?

  // Test hooks (a self test fakes the idle clock, the app in front and video playback).
  var idleNow: () -> Double = { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!) }
  var frontNow: () -> String? = { Afk.front }
  var videoNow: () -> Bool = { Afk.displayHeldAwake() }
  var pointerNow: () -> NSPoint = { NSEvent.mouseLocation }
  var buttonsNow: () -> Int = { NSEvent.pressedMouseButtons }

  // ---------- settings (this Mac only) ----------
  struct Prefs: Codable { var on = true; var threshold = 600; var sound = false; var video = false; var exempt: [String] = []; var startPassive: Bool? = nil
    /// "Stay off during meetings": nil (never chosen) or true is on, false is off. Optional so older saved prefs still load.
    var meetings: Bool? = nil
    var meetingsOn: Bool { meetings != false }
  }
  private(set) var prefs = Prefs()
  private var testDir: String?
  private let q = DispatchQueue(label: "PS afk", qos: .utility)
  private var timer: DispatchSourceTimer?

  // ---------- state (persisted, so a restart keeps it) ----------
  /// start: the last input before it. back: the first input after it (the clock keeps running). end: the "Back in the game" click.
  /// watcher: began when Watcher mode ended (the card says "Watcher mode ended").
  struct Stretch: Codable { var start: Date; var back: Date?; var passive: Bool? = nil; var end: Date? = nil; var watcher: Bool? = nil }
  /// watcherUntil: Watcher mode runs until then (wall clock). notice: Watcher ended while the developer was at the Mac (the card waits).
  private struct Saved: Codable { var current: Stretch?; var pending: [Stretch]; var watcherUntil: Date?; var notice: Date?; var lastWatch: Int? }
  private var watcherUntil: Date?
  private var notice: Date?
  private var lastWatch = 60
  private var current: Stretch?
  private var pending: [Stretch] = []
  private var lastActive = Date()
  private var afterGap = false          // the Mac slept or was locked: look for a stretch across it

  private var file: URL {
    if let d = testDir { return URL(fileURLWithPath: d).appendingPathComponent("afk.json") }
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PS", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return dir.appendingPathComponent("afk.json")
  }
  private func save() {
    guard let d = try? JSONEncoder().encode(Saved(current: current, pending: pending, watcherUntil: watcherUntil, notice: notice, lastWatch: lastWatch)) else { return }
    FileManager.default.createFile(atPath: file.path, contents: d, attributes: [.posixPermissions: 0o600])
  }
  private func load() {
    guard let d = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(Saved.self, from: d) else { return }
    current = s.current; pending = s.pending; watcherUntil = s.watcherUntil; notice = s.notice; lastWatch = s.lastWatch ?? 60
  }

  // The app in front (kept up to date on the main thread; read from the AFK queue).
  private static let frontLock = NSLock()
  private static var _front: String?
  static var front: String? { frontLock.lock(); defer { frontLock.unlock() }; return _front }
  private static func setFront(_ id: String?) { frontLock.lock(); _front = id; frontLock.unlock() }

  /// A video (or anything else) is keeping the display awake right now.
  static func displayHeldAwake() -> Bool {
    var out: Unmanaged<CFDictionary>?
    guard IOPMCopyAssertionsStatus(&out) == kIOReturnSuccess, let d = out?.takeRetainedValue() as? [String: Any] else { return false }
    return ((d["PreventUserIdleDisplaySleep"] as? Int) ?? 0) > 0
  }

  func start(testDir: String? = nil) {
    self.testDir = testDir
    if testDir == nil, let d = UserDefaults.standard.data(forKey: "afk.prefs"), let p = try? JSONDecoder().decode(Prefs.self, from: d) { prefs = p }
    if testDir != nil { prefs.on = false }   // a test copy only times its own fake idle clock (SelfTest.afkCheck)
    meetingTime.setEnabled(prefs.meetingsOn)
    load()
    loadUI()
    Afk.setFront(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
      Afk.setFront((n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier)
    }
    for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
      ws.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.gap() }
    }
    DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: nil) { [weak self] _ in self?.gap() }
    q.async { [self] in
      lastActive = Date().addingTimeInterval(-idleNow())
      if let c = current { DispatchQueue.main.async { self.show(c, animate: false) } }   // PS restarted while a card was up
      else if notice != nil { DispatchQueue.main.async { self.showNotice() } }
      pushStatus()
      let t = DispatchSource.makeTimerSource(queue: q)
      t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(200))
      t.setEventHandler { [weak self] in self?.tick() }
      t.resume()
      timer = t
      flush()
    }
  }
  /// After a sleep or a lock the next input decides whether the developer was away across it.
  func gap() { q.async { [self] in if prefs.on { afterGap = true } } }

  private func allowed() -> Bool {
    guard prefs.on else { return false }
    let f = frontNow()
    if Protected.matches(f) { return false }                        // golden rule: never timed while they are in front
    if let f, prefs.exempt.contains(f) { return false }
    if prefs.video && videoNow() { return false }
    return true
  }

  private var ticks = 0
  /// One look at the idle clock (every second).
  func tick(now: Date = Date()) {
    ticks += 1
    if ticks % 30 == 0 && !pending.isEmpty { flush() }   // stretches saved while the vault was locked go as soon as it opens
    guard prefs.on else { return }   // switched off (the developer's switch, or a Second Computer role default): nothing is timed or recorded
    let idle = idleNow()
    let inputAt = now.addingTimeInterval(-idle)
    let limit = TimeInterval(max(30, prefs.threshold))
    if let w = meetingNow(now) { inMeeting(w, now: now, inputAt: inputAt); return }   // a calendar meeting is on: no card
    if inMeetingLogged { inMeetingLogged = false; psLog("PS afk: meeting over, timing again") }
    // The clock starts at the last input, or at the end of a meeting that ended since (MeetingTime.swift).
    let from = meetingTime.after(inputAt, now: now)
    if let until = watcherUntil {
      if now < until { lastActive = max(lastActive, inputAt); afterGap = false; return }   // Watcher: no AFK card
      endWatcher(until, inputAt: inputAt, limit: limit)
      return
    }
    if notice != nil {
      // "Watcher mode ended" is waiting while the developer was at the Mac; if he goes idle now, the clock runs.
      if now.timeIntervalSince(from) >= limit && allowed() {
        let c = Stretch(start: from, back: nil, watcher: true)
        current = c; notice = nil; save(); pushStatus()
        DispatchQueue.main.async { self.show(c, animate: false) }
      }
      return
    }
    if var c = current {
      if c.back == nil, inputAt > c.start.addingTimeInterval(1) {      // input again: noted as "back at the Mac", the clock keeps running
        c.back = inputAt; current = c; save(); pushStatus()
        DispatchQueue.main.async { self.show(c, animate: false) }
      }
      lastActive = max(lastActive, inputAt)
      afterGap = false
      return
    }
    if afterGap, idle < limit {
      // The first input after a sleep or lock: away across it?
      afterGap = false
      let left = meetingTime.after(lastActive, now: inputAt)   // a meeting in the gap: away only from its end
      if inputAt.timeIntervalSince(left) >= limit && allowed() {
        let c = Stretch(start: left, back: inputAt, passive: prefs.startPassive == true ? true : nil)
        current = c; save(); pushStatus()
        psLog("PS afk: away across a sleep or lock (\(Int(inputAt.timeIntervalSince(left))) s)")
        DispatchQueue.main.async { self.show(c, animate: true) }
      }
      lastActive = inputAt
      return
    }
    if now.timeIntervalSince(from) >= limit && allowed() {
      let c = Stretch(start: from, back: nil, passive: prefs.startPassive == true ? true : nil)
      current = c; save(); pushStatus()
      psLog("PS afk: away")
      // V1.57: the stretch card's sound is skipped in private mode (PrivateCore.swift).
      DispatchQueue.main.async { self.show(c, animate: true); if self.prefs.sound && PrivateCore.cardSound(privateOn: PrivateHold.shared.on) { Sfx.shared.play("meet-soon", volume: 0.5) } }
      return
    }
    if idle < limit { lastActive = max(lastActive, inputAt) }
  }

  // ---------- meetings (Sources/MeetingTime.swift) ----------
  /// The meeting windows (a test can give its own).
  var meetingTime = MeetingTime.shared
  private var inMeetingLogged = false
  private func meetingNow(_ now: Date) -> MeetingTime.Win? { prefs.meetingsOn ? meetingTime.window(at: now) : nil }
  /// A meeting is on (AFK queue, every second): no card. A card already up goes away; the part of its stretch
  /// before the meeting is kept as a break, nothing inside the meeting is. "Watcher mode ended" goes too, and a
  /// Watcher that runs out during the meeting just ends.
  private func inMeeting(_ w: MeetingTime.Win, now: Date, inputAt: Date) {
    if !inMeetingLogged { inMeetingLogged = true; psLog("PS afk: meeting on, no AFK card until it ends") }
    var changed = false, close = false
    if var c = current {
      current = nil; changed = true; close = true
      if let k = MeetingTime.keep(start: c.start, window: w, now: now) {
        let (s0, e0) = k
        c.end = e0
        if let b = c.back, b > e0 { c.back = nil }
        pending.append(c)
        if testDir == nil { DispatchQueue.main.async { ScreenTime.shared.addAway(s0, e0) } }
        flush()
      }
      psLog("PS afk: card closed, a meeting started")
    }
    if notice != nil { notice = nil; changed = true; close = true }
    if let until = watcherUntil, now >= until { watcherUntil = nil; changed = true }
    lastActive = max(lastActive, inputAt)
    afterGap = false
    if changed { save(); pushStatus() }
    if close { DispatchQueue.main.async { self.hide() } }
  }

  /// "Back in the game": the card goes and the stretch is saved (now, or when the vault opens).
  private func backInTheGame() {
    q.async { [self] in
      if current == nil, notice != nil { notice = nil; save(); pushStatus() }
      guard var c = current else { return }
      c.end = Date()
      current = nil
      pending.append(c)
      save()
      psLog("PS afk: back in the game (\(Int(c.end!.timeIntervalSince(c.start))) s)")
      let (s0, e0) = (c.start, c.end!)
      if testDir == nil { DispatchQueue.main.async { ScreenTime.shared.addAway(s0, e0) } }   // the timeline shows it as a break
      flush()
      pushStatus()
    }
    DispatchQueue.main.async { self.hide() }
  }
  // ---------- Watcher mode ----------
  /// "Watcher" confirmed on the card: the stretch showing ends (saved as usual), the card closes, and
  /// no AFK card starts for that long. Extend from the end card or the Watcher card does the same.
  private func startWatcher(_ minutes: Int) {
    let m = max(5, min(720, minutes))
    q.async { [self] in
      if var c = current {
        c.end = Date(); current = nil; pending.append(c)
        let (s0, e0) = (c.start, c.end!)
        if testDir == nil { DispatchQueue.main.async { ScreenTime.shared.addAway(s0, e0) } }
        flush()
      }
      notice = nil
      watcherUntil = Date().addingTimeInterval(TimeInterval(m * 60))
      lastWatch = m
      save(); pushStatus()
      psLog("PS afk: watcher for \(m) min")
      DispatchQueue.main.async { self.hide() }
    }
  }
  /// "End watcher" on the Watcher card (from the Tab list badge).
  private func endWatcherNow() {
    q.async { [self] in
      watcherUntil = nil; lastActive = Date().addingTimeInterval(-idleNow()); save(); pushStatus()
      DispatchQueue.main.async { self.hide() }
    }
  }
  /// The time is up. Idle then (no input in the half minute before and none since): the AFK clock runs
  /// from the end. Away across a sleep since: the stretch from the end to his first input. Otherwise
  /// the card just says it ended. AFK queue.
  private func endWatcher(_ until: Date, inputAt: Date, limit: TimeInterval) {
    watcherUntil = nil
    var c: Stretch?
    if inputAt <= until, until.timeIntervalSince(inputAt) >= 30 { c = Stretch(start: until, back: nil, watcher: true) }
    else if inputAt > until, inputAt.timeIntervalSince(until) >= limit { c = Stretch(start: until, back: inputAt, watcher: true) }
    if let c { current = c } else { notice = until }
    lastActive = max(lastActive, inputAt)
    afterGap = false
    save(); pushStatus()
    psLog("PS afk: watcher ended\(c != nil ? ", away since" : "")")
    DispatchQueue.main.async { if let c { self.show(c, animate: true) } else { self.showNotice() } }
  }

  // ---------- status for the Tab list badge ----------
  /// Gets {"type":"afkStatus", afk: {start, back} or null, watcherUntil} (ms) for the Tab list page.
  var onStatus: ((String) -> Void)?
  func pushStatus() {
    q.async { [self] in
      var d: [String: Any] = ["type": "afkStatus"]
      if let c = current {
        var a: [String: Any] = ["start": c.start.timeIntervalSince1970 * 1000]
        if let b = c.back { a["back"] = b.timeIntervalSince1970 * 1000 }
        d["afk"] = a
      } else { d["afk"] = NSNull() }
      if let w = watcherUntil { d["watcherUntil"] = w.timeIntervalSince1970 * 1000 } else { d["watcherUntil"] = NSNull() }
      d["on"] = prefs.on   // the Tab list's AFK timer switch shows the real state
      guard let data = try? JSONSerialization.data(withJSONObject: d), let j = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { self.onStatus?(j) }
    }
  }

  /// Sends saved stretches to the main window (vault: settings.awayLog, reason "AFK").
  func flush() {
    q.async { [self] in
      guard !pending.isEmpty, let deliver else { return }
      let list: [[String: Int]] = pending.map {
        var x = ["s": Int($0.start.timeIntervalSince1970), "e": Int(($0.end ?? $0.back ?? $0.start).timeIntervalSince1970)]
        if let r = $0.back { x["r"] = Int(r.timeIntervalSince1970) }                   // first input after it started
        return x
      }
      guard let d = try? JSONSerialization.data(withJSONObject: ["type": "afkDone", "list": list]), let json = String(data: d, encoding: .utf8) else { return }
      DispatchQueue.main.async {
        if deliver(json) { self.q.async { self.pending = []; self.save() } }
      }
    }
  }

  // ---------- settings from PS > Settings ----------
  func handle(_ msg: [String: Any]) {
    q.async { [self] in
      var p = prefs
      if let b = msg["on"] as? Bool { p.on = b }
      if let t = msg["threshold"] as? Int, [30, 60, 120, 180, 300, 600, 900, 1800].contains(t) { p.threshold = t }
      if let b = msg["sound"] as? Bool { p.sound = b }
      if let b = msg["video"] as? Bool { p.video = b }
      if let b = msg["startPassive"] as? Bool { p.startPassive = b ? true : nil }
      if let b = msg["meetings"] as? Bool { p.meetings = b ? nil : false }
      if let ids = msg["exempt"] as? [String] { p.exempt = Array(Set(ids.filter { !$0.isEmpty && !Protected.matches($0) }.map { String($0.prefix(200)) })).sorted() }
      if msg["pick"] as? Bool == true { DispatchQueue.main.async { self.pickApp() }; return }
      let wasOn = prefs.on
      if p.meetingsOn != prefs.meetingsOn { psLog("PS afk: stay off during meetings \(p.meetingsOn ? "on" : "off")") }
      prefs = p
      meetingTime.setEnabled(p.meetingsOn)
      if testDir == nil && !IS_TEST_COPY, let d = try? JSONEncoder().encode(p) { UserDefaults.standard.set(d, forKey: "afk.prefs") }
      if !p.on && (current != nil || notice != nil || watcherUntil != nil) {
        // Off: the card, the passive stopwatch, Watcher and "Back in the game" go at once, and this stretch is not recorded.
        current = nil; notice = nil; watcherUntil = nil; afterGap = false; save()
        DispatchQueue.main.async { self.hide(); self.setUp() }   // the card's page loads before the first picture
      }
      if p.on && !wasOn { lastActive = Date().addingTimeInterval(-idleNow()); afterGap = false }   // time spent switched off is not "away"
      if p.on != wasOn { psLog("PS afk: switched \(p.on ? "on" : "off")"); pushStatus() }
      DispatchQueue.main.async { self.onSettings?() }
    }
  }
  /// This Mac's Second Computer role changed (Second.swift). Once per change of role: Secondary switches the AFK
  /// timer off, Primary switches it on (the developer, 31 Oct 2026: not on the second screen); the developer's own switch after that stands.
  /// A test copy only records it unless its self test lets it act (testRoleDefaults).
  var testRoleDefaults = false
  private var testRoleApplied: String?
  func roleChanged(_ role: String) {
    q.async { [self] in
      // A test copy (also the Second Computer peer, which never starts the timer) never reads or writes the real defaults.
      let test = testDir != nil || IS_TEST_COPY
      let applied = test ? testRoleApplied : UserDefaults.standard.string(forKey: "afk.roleDefaultApplied")
      guard applied != role else { return }
      if test { testRoleApplied = role } else { UserDefaults.standard.set(role, forKey: "afk.roleDefaultApplied") }
      guard !test || (testRoleDefaults && testDir != nil) else { return }
      if role == "secondary" && prefs.on { psLog("PS afk: off by default on the second computer"); handle(["on": false]) }
      if role == "primary" && !prefs.on { handle(["on": true]) }
    }
  }

  /// Exempt an app from /Applications (the running apps are offered in PS > Settings too).
  private func pickApp() {
    let p = NSOpenPanel()
    p.directoryURL = URL(fileURLWithPath: "/Applications")
    p.allowedContentTypes = [.application]
    p.allowsMultipleSelection = false
    p.message = "Pick an app: while it is in front, the AFK timer never starts."
    guard p.runModal() == .OK, let url = p.url, let id = Bundle(url: url)?.bundleIdentifier, !Protected.matches(id) else { return }
    handle(["exempt": prefs.exempt + [id]])
  }
  func settingsJSON() -> [String: Any] {
    func name(_ id: String) -> String {
      NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == id }?.localizedName
        ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { $0.deletingPathExtension().lastPathComponent } ?? id
    }
    return ["on": prefs.on, "threshold": prefs.threshold, "sound": prefs.sound, "video": prefs.video, "startPassive": prefs.startPassive == true, "meetings": prefs.meetingsOn,
            "exempt": prefs.exempt.filter { !Protected.matches($0) }.map { ["id": $0, "name": name($0)] }]
  }

  // ---------- the stopwatch's look, place and visibility (this Mac only: afk-ui.json) ----------
  /// The gear on the card. bold: how obvious, 0 subtle to 3 bold (glow and contrast).
  struct Look: Codable, Equatable {
    var outline = true; var outlineColor = "#8B5CF6"; var textColor = "#FFFFFF"; var font = "system"
    var size = 19; var opacity = 0.9; var brightness = 1.0; var bold = 1
    init() {}
    init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self); let z = Look()
      outline = (try? c.decode(Bool.self, forKey: .outline)) ?? z.outline
      outlineColor = (try? c.decode(String.self, forKey: .outlineColor)) ?? z.outlineColor
      textColor = (try? c.decode(String.self, forKey: .textColor)) ?? z.textColor
      font = (try? c.decode(String.self, forKey: .font)) ?? z.font
      size = (try? c.decode(Int.self, forKey: .size)) ?? z.size
      opacity = (try? c.decode(Double.self, forKey: .opacity)) ?? z.opacity
      brightness = (try? c.decode(Double.self, forKey: .brightness)) ?? z.brightness
      bold = (try? c.decode(Int.self, forKey: .bold)) ?? z.bold
    }
    static let fonts = ["system", "rounded", "mono", "serif"]
    /// Only sane values get in (the page is ours, but it is still a web page).
    static func clean(_ m: [String: Any], _ old: Look) -> Look {
      var l = old
      func color(_ v: Any?) -> String? { (v as? String).flatMap { $0.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil ? $0.uppercased() : nil } }
      if let b = m["outline"] as? Bool { l.outline = b }
      if let c = color(m["outlineColor"]) { l.outlineColor = c }
      if let c = color(m["textColor"]) { l.textColor = c }
      if let f = m["font"] as? String, fonts.contains(f) { l.font = f }
      if let n = m["size"] as? Double { l.size = max(12, min(36, Int(n.rounded()))) }
      if let n = m["opacity"] as? Double { l.opacity = max(0.15, min(1, (n * 100).rounded() / 100)) }
      if let n = m["brightness"] as? Double { l.brightness = max(0.6, min(1.4, (n * 100).rounded() / 100)) }
      if let n = m["bold"] as? Double { l.bold = max(0, min(3, Int(n))) }
      return l
    }
  }
  /// spots: per display (its UUID), the stopwatch's place from the bottom left of the usable screen.
  struct UI: Codable {
    var look = Look(); var spots: [String: [Double]] = [:]; var display: String? = nil; var invisible = false
    init() {}
    init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      look = (try? c.decode(Look.self, forKey: .look)) ?? Look()
      spots = (try? c.decode([String: [Double]].self, forKey: .spots)) ?? [:]
      display = try? c.decode(String.self, forKey: .display)
      invisible = (try? c.decode(Bool.self, forKey: .invisible)) ?? false
    }
  }
  private(set) var ui = UI()
  private var uiFile: URL {
    if let d = testDir { return URL(fileURLWithPath: d).appendingPathComponent("afk-ui.json") }
    return file.deletingLastPathComponent().appendingPathComponent("afk-ui.json")
  }
  private func loadUI() {
    if let d = try? Data(contentsOf: uiFile), let u = try? JSONDecoder().decode(UI.self, from: d) { ui = u } else { ui = UI() }
  }
  private func saveUI() {
    guard let d = try? JSONEncoder().encode(ui) else { return }
    let f = uiFile
    q.async { FileManager.default.createFile(atPath: f.path, contents: d, attributes: [.posixPermissions: 0o600]) }
  }
  private func sendLook() {
    guard ready, let d = try? JSONEncoder().encode(ui.look), let s = String(data: d, encoding: .utf8) else { return }
    web?.evaluateJavaScript("window.__afk.look(\(s),\(ui.invisible))", completionHandler: nil)
  }

  // ---------- the card ----------
  private(set) var panel: AfkPanel?
  private(set) var web: ClickThroughWebView?
  private var ready = false
  private var queued: String?
  private static let size = NSSize(width: 380, height: 196)
  private static let gearSize = NSSize(width: 380, height: 500)
  private static let popSize = NSSize(width: 330, height: 150)
  /// full: the big card top centre. mini: the tiny stopwatch (top left, or wherever the developer dragged it).
  /// pop: the stopwatch opened by hovering it. gear: the stopwatch's look, with a live preview.
  enum Mode: String { case full, mini, pop, gear }
  private(set) var mode = Mode.full
  private var gearFrom = Mode.full
  /// What the full card shows: an AFK stretch, "Watcher mode ended" (with or without a clock), or Watcher running.
  private var kind = "afk"
  private var hovering = false
  /// The alpha the card should have (an invisible stopwatch is 0). A test copy's window stays at 0 whatever this says.
  private(set) var targetAlpha: CGFloat = 1
  /// A self test copy is parked far to the left (ScreenGuard): its window sits at the logical place plus this.
  private var parkDX: CGFloat { testDir != nil ? ScreenGuard.parkX : 0 }

  private var miniSize: NSSize {
    let z = Double(ui.look.size)
    return NSSize(width: (z * 4.4 + 34).rounded() + 8, height: (z * 1.55 + 15).rounded() + 8)
  }
  static func displayKey(_ s: NSScreen) -> String {
    guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return "main" }
    if let u = CGDisplayCreateUUIDFromDisplayID(n.uint32Value)?.takeRetainedValue(), let str = CFUUIDCreateString(nil, u) as String? { return str }
    return n.stringValue
  }
  /// The display the stopwatch lives on: the one it was last dragged to, if it is still connected.
  private var home: NSScreen {
    let all = NSScreen.screens
    if let k = ui.display, let s = all.first(where: { Afk.displayKey($0) == k }) { return s }
    return all.first ?? NSScreen.main!
  }
  private func clamp(_ r: NSRect, _ v: NSRect) -> NSRect {
    var r = r
    r.origin.x = max(v.minX, min(v.maxX - r.width, r.minX)); r.origin.y = max(v.minY, min(v.maxY - r.height, r.minY))
    return r
  }
  /// Where each look sits, on screen (a parked test copy adds parkDX). The pop-up opens from the
  /// stopwatch towards the side with room, so it never runs off the screen.
  func frameFor(_ m: Mode) -> NSRect {
    let v = (m == .full || m == .gear) ? home.visibleFrame : home.visibleFrame
    switch m {
    case .full:
      let h = Afk.size.height + (asking ? Afk.askH : 0)   // PS 1.66: the one question sits under the buttons
      return NSRect(x: v.midX - Afk.size.width / 2, y: v.maxY - h - 6, width: Afk.size.width, height: h)
    case .gear:
      let h = min(Afk.gearSize.height, v.height - 12)
      return NSRect(x: v.midX - Afk.gearSize.width / 2, y: v.maxY - h - 6, width: Afk.gearSize.width, height: h)
    case .mini:
      let z = miniSize
      if let p = ui.spots[Afk.displayKey(home)], p.count == 2 { return clamp(NSRect(x: v.minX + p[0], y: v.minY + p[1], width: z.width, height: z.height), v) }
      return NSRect(x: v.minX + 4, y: v.maxY - z.height, width: z.width, height: z.height)
    case .pop:
      let m0 = frameFor(.mini), w = Afk.popSize.width, h = Afk.popSize.height
      let x = m0.minX + w <= v.maxX ? m0.minX : m0.maxX - w
      let y = m0.maxY - h >= v.minY ? m0.maxY - h : m0.minY
      return clamp(NSRect(x: x, y: y, width: w, height: h), v)
    }
  }
  static func frame(_ m: Mode) -> NSRect { shared.frameFor(m) }
  /// The stopwatch's spot (or its open pop-up) while it is up, for the meeting notes card to keep clear of. Main thread.
  var occupied: NSRect? {
    guard let panel, panel.isVisible, mode == .mini || mode == .pop else { return nil }
    return frameFor(mode)
  }

  private func setUp() {
    guard panel == nil else { return }
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "afk")
    let box = HoverView(frame: NSRect(origin: .zero, size: Afk.size))
    let w = ClickThroughWebView(frame: box.bounds, configuration: c)
    w.autoresizingMask = [.width, .height]
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    box.addSubview(w)
    box.onHover = { [weak self] on in self?.hover(on) }
    let p = AfkPanel(contentRect: NSRect(origin: .zero, size: Afk.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.contentView = box
    // A self test copy stays invisible and never catches a click (ScreenGuard also parks it off screen).
    if testDir != nil { p.alphaValue = 0; p.ignoresMouseEvents = true }
    panel = p; web = w
    w.loadHTMLString(Afk.page, baseURL: nil)
  }
  private func frame(on screen: NSScreen, hidden: Bool) -> NSRect {
    var r = frameFor(mode)
    if hidden && (mode == .full || mode == .gear) { r.origin.y = screen.frame.maxY + 8 }
    return r
  }
  /// The window's alpha for the look it has: an invisible stopwatch fades out, its pop-up fades in.
  private func applyAlpha(animate: Bool = true) {
    let a: CGFloat = (mode == .mini && ui.invisible) ? 0 : 1
    targetAlpha = a
    guard let panel, testDir == nil, panel.alphaValue != a else { return }
    if animate { NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.28; panel.animator().alphaValue = a } } else { panel.alphaValue = a }
  }
  /// Moves the card smoothly to another look (the page fades its contents across at the same time).
  private func morph(_ m: Mode, animate: Bool = true) {
    guard let panel, panel.isVisible, m != mode else { mode = m; tellMode(); applyAlpha(); return }
    let from = mode
    mode = m
    tellMode()
    let to = frameFor(m)
    if testDir != nil || !animate { panel.setFrame(to, display: true) } else {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = m == .pop || from == .pop ? 0.32 : 0.55
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
        panel.animator().setFrame(to, display: true)
      }
    }
    applyAlpha()
    watchPointer(m == .mini || m == .pop)
    NotesCard.shared.relayout()
  }
  private func tellMode() { if ready { web?.evaluateJavaScript("window.__afk.mode('\(mode.rawValue)')", completionHandler: nil) } }
  /// The mouse over the stopwatch opens it. Closing is left to watchPointer: a "mouse left" event alone
  /// is not trusted (a quick move slips out of the small stopwatch while it is still growing, and no
  /// "mouse entered" follows when the pop-up grows under a pointer that is already there).
  private func hover(_ on: Bool) {
    hovering = on
    if on, mode == .mini, !dragging { lastInside = Date(); morph(.pop) }
  }
  private var lastInside = Date.distantPast
  private var lastPointer = NSPoint(x: -1, y: -1)
  private var pointerTimer: Timer?
  /// While the stopwatch is up: opens it when the pointer moves onto it (also onto an invisible one's
  /// spot), and closes the pop-up only once the pointer has been outside it for a moment with no mouse
  /// button held. Main thread, 8 times a second.
  private func watchPointer(_ on: Bool) {
    if !on { pointerTimer?.invalidate(); pointerTimer = nil; return }
    guard pointerTimer == nil else { return }
    let t = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in self?.checkPointer() }
    RunLoop.main.add(t, forMode: .common)
    pointerTimer = t
  }
  private func checkPointer() {
    guard let panel, panel.isVisible, mode == .mini || mode == .pop else { watchPointer(false); return }
    guard !dragging else { return }
    var p = pointerNow(); p.x -= parkDX
    let held = buttonsNow() != 0
    let moved = p != lastPointer
    lastPointer = p
    switch mode {
    case .mini:                                                     // the pointer moved onto it (a stopwatch appearing under a resting pointer stays small)
      if moved, frameFor(.mini).contains(p) { lastInside = Date(); morph(.pop) }
    case .pop:
      let area = frameFor(.pop).union(frameFor(.mini)).insetBy(dx: -6, dy: -6)
      if area.contains(p) || held { lastInside = Date() }
      else if Date().timeIntervalSince(lastInside) > 0.4 { morph(.mini) }
    default: break
    }
  }

  // ---------- dragging the stopwatch ----------
  private var dragging = false
  private var dragTimer: Timer?
  /// The page saw the mouse go down on the stopwatch (or its pop-up) and move: from here the stopwatch
  /// follows the pointer until the button comes up, then snaps to a near edge and is remembered for
  /// that display. The page swallows the click that would end the drag, so a drag never presses a button.
  private func beginDrag() {
    guard let panel, panel.isVisible, mode == .mini || mode == .pop, !dragging, buttonsNow() != 0 else {
      web?.evaluateJavaScript("window.__afk.undrag()", completionHandler: nil); return   // no button really held: not a drag
    }
    dragging = true
    mode = .mini; tellMode(); applyAlpha(animate: false)
    targetAlpha = 1; if testDir == nil { panel.alphaValue = 1 }    // visible while it moves, even if invisible
    follow()
    let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.follow() }
    RunLoop.main.add(t, forMode: .common)
    dragTimer = t
  }
  private func follow() {
    guard let panel, dragging else { return }
    var p = pointerNow(); p.x -= parkDX
    let z = miniSize
    let r = NSRect(x: p.x - z.width / 2, y: p.y - z.height / 2, width: z.width, height: z.height)
    if buttonsNow() == 0 { endDrag(r); return }
    panel.setFrame(r, display: true)
  }
  private func endDrag(_ r0: NSRect) {
    dragTimer?.invalidate(); dragTimer = nil
    let center = NSPoint(x: r0.midX, y: r0.midY)
    let s = NSScreen.screens.first { $0.frame.contains(center) } ?? home
    let v = s.visibleFrame
    var r = clamp(r0, v)
    let snap: CGFloat = 28, gap: CGFloat = 4
    if r.minX - v.minX < snap { r.origin.x = v.minX + gap }
    if v.maxX - r.maxX < snap { r.origin.x = v.maxX - r.width - gap }
    if r.minY - v.minY < snap { r.origin.y = v.minY + gap }
    if v.maxY - r.maxY < snap { r.origin.y = v.maxY - r.height }
    let key = Afk.displayKey(s)
    ui.display = key
    ui.spots[key] = [Double(r.minX - v.minX), Double(r.minY - v.minY)]
    saveUI()
    dragging = false
    var lp = pointerNow(); lp.x -= parkDX
    lastPointer = lp                                               // dropped under the pointer: stays small until the pointer moves
    if let panel {
      if testDir != nil { panel.setFrame(r, display: true) } else {
        NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.18; panel.animator().setFrame(r, display: true) }
      }
    }
    mode = .mini
    applyAlpha()
    lastInside = Date()
    NotesCard.shared.relayout()
    psLog("PS afk: stopwatch moved")
  }

  /// "Passive" on the big card, or "Full card" in the pop-up. Kept with the stretch (restart, sleep).
  private func setPassive(_ on: Bool) {
    q.async { [self] in
      guard var c = current else { return }
      c.passive = on ? true : nil; current = c; save()
      DispatchQueue.main.async { self.morph(on ? .mini : .full) }
    }
  }
  private func send(_ state: [String: Any]) {
    var state = state
    state["ask"] = asking ? (askWords ?? [:]) as Any : NSNull()
    if let d = try? JSONSerialization.data(withJSONObject: state), let s = String(data: d, encoding: .utf8) {
      if ready { web?.evaluateJavaScript("window.__afk.set(\(s))", completionHandler: nil) } else { queued = s }
    }
  }
  private func show(_ c: Stretch, animate: Bool) {
    setUp()
    guard let panel else { return }
    kind = c.watcher == true ? "ended" : "afk"
    let want: Mode = mode == .gear ? .gear : (c.passive == true && kind == "afk" ? (mode == .pop ? .pop : .mini) : .full)   // an open pop-up stays open: the pointer decides
    // PS 1.66: the first full AFK card (and the first after updating) asks once whether to keep the AFK timer.
    let wasAsking = asking
    if !asking, kind == "afk", want == .full, askWords != nil, testDir == nil, !IS_TEST_COPY, !UserDefaults.standard.bool(forKey: Afk.askedKey) {
      asking = true
      psLog("PS afk: asking once whether to keep the AFK timer")
    }
    send(["kind": kind, "start": c.start.timeIntervalSince1970 * 1000, "back": c.back.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
          "threshold": prefs.threshold, "lastWatch": lastWatch])
    present(want, animate: animate)
    if asking != wasAsking { refit() }
  }

  // ---------- PS 1.66: the AFK timer asks once (web core/afkask.ts; the same question as the posture reminder's) ----------
  // The page tells the words while the question is still due for the person (the island state's afkAsk, synced settings), nil once
  // answered on any device. Turn off switches this Mac's AFK timer off (its own setting); Keep it on just carries on. Either answer is
  // saved by the page for every device, and kept here too. A card that goes without an answer (Back in the game, Esc) asks again
  // with the next card. Main thread.
  private var askWords: [String: String]?
  private(set) var asking = false
  private static let askH: CGFloat = 80
  private static let askedKey = "afk.askAnswered"
  func islandState(_ st: [String: Any]) {
    if let a = st["afkAsk"] as? [String: Any] {
      func t(_ k: String) -> String { String(((a[k] as? String) ?? "").prefix(80)) }
      let w = ["title": t("title"), "off": t("off"), "keep": t("keep")]
      askWords = w.values.contains("") ? nil : w
    } else {
      askWords = nil
      if asking { asking = false; if ready { web?.evaluateJavaScript("window.__afk.ask(null)", completionHandler: nil) }; refit() }   // answered elsewhere
    }
  }
  private func answerAsk(_ a: String) {
    guard asking, a == "off" || a == "keep" else { return }
    asking = false
    if testDir == nil && !IS_TEST_COPY { UserDefaults.standard.set(true, forKey: Afk.askedKey) }
    psLog("PS afk: question answered \(a)")
    Island.shared.onAction?("afkAsk", a)
    if a == "off" { handle(["on": false]) } else { refit() }
  }
  /// The full card grows or shrinks for the question, its top edge staying put.
  private func refit() {
    guard let panel, panel.isVisible, mode == .full else { return }
    let to = frameFor(.full)
    if testDir != nil { panel.setFrame(to, display: true); return }
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.45
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
      panel.animator().setFrame(to, display: true)
    }
  }
  /// "Watcher mode ended" while the developer was at the Mac: no clock, Back in the game or Extend.
  private func showNotice() {
    setUp()
    let dropAsk = asking; asking = false   // the question belongs to the AFK card only
    defer { if dropAsk { refit() } }
    kind = "notice"
    send(["kind": kind, "start": (notice ?? Date()).timeIntervalSince1970 * 1000, "back": NSNull(), "threshold": prefs.threshold, "lastWatch": lastWatch])
    present(.full, animate: true)
  }
  /// The Watcher card (from the Tab list badge): time left, Extend or End watcher.
  private func showWatching(_ until: Date) {
    setUp()
    let dropAsk = asking; asking = false   // the question belongs to the AFK card only
    defer { if dropAsk { refit() } }
    kind = "watching"
    send(["kind": kind, "until": until.timeIntervalSince1970 * 1000, "start": Date().timeIntervalSince1970 * 1000, "back": NSNull(), "threshold": prefs.threshold, "lastWatch": lastWatch])
    present(.full, animate: true)
  }
  private func present(_ want: Mode, animate: Bool) {
    guard let panel else { return }
    let screen = home
    if panel.isVisible { if want != mode { morph(want) }; return }
    mode = want
    tellMode()
    watchPointer(want == .mini || want == .pop)
    defer { NotesCard.shared.relayout() }
    if animate && testDir == nil && (want == .full || want == .gear) {
      // Swoops in from just above the top edge to the top centre.
      panel.setFrame(frame(on: screen, hidden: true), display: false)
      panel.alphaValue = 0
      panel.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.62
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
        panel.animator().setFrame(frame(on: screen, hidden: false), display: true)
        panel.animator().alphaValue = 1
      }
      targetAlpha = 1
    } else {
      panel.setFrame(frame(on: screen, hidden: false), display: true)
      if testDir == nil { panel.alphaValue = 0 }
      panel.orderFrontRegardless()
      applyAlpha()
    }
  }
  private func hide() {
    asking = false   // gone without an answer: the next card asks again
    guard let panel, panel.isVisible else { return }
    let screen = home
    let away = frame(on: screen, hidden: true)
    mode = .full; hovering = false; dragging = false
    dragTimer?.invalidate(); dragTimer = nil
    watchPointer(false)
    NotesCard.shared.relayout()
    if testDir != nil { panel.orderOut(nil); tellMode(); return }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.4
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0)
      panel.animator().setFrame(away, display: true)
      panel.animator().alphaValue = 0
    }) { panel.orderOut(nil); self.tellMode() }
  }
  /// A click on the Tab list badge: the full card for the AFK stretch running, or the Watcher card.
  func showFromBadge() {
    q.async { [self] in
      let c = current, w = watcherUntil, n = notice
      DispatchQueue.main.async { [self] in
        if let c {
          if c.passive == true { setPassive(false) }
          show(Stretch(start: c.start, back: c.back, passive: nil, end: nil, watcher: c.watcher), animate: true)
          if mode == .gear { morph(.full) }
        } else if let w { showWatching(w) }
        else if n != nil { showNotice() }
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    ready = true
    tellMode()
    sendLook()
    if let s = queued { webView.evaluateJavaScript("window.__afk.set(\(s))", completionHandler: nil); queued = nil }
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)    // nothing in the card navigates anywhere
  }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let m = message.body as? String else { return }
    switch m {
    case "back": backInTheGame()
    case "passive": setPassive(true)
    case "full": setPassive(false)
    case "drag": beginDrag()
    case "gear": gearFrom = mode == .pop ? .mini : mode; morph(.gear)
    case "gearDone":
      q.async { [self] in
        let c = current
        DispatchQueue.main.async { [self] in
          if c == nil && kind == "afk" { hide(); return }
          let back: Mode = (c?.passive == true && kind == "afk") ? .mini : (gearFrom == .gear ? .full : gearFrom)
          morph(back == .pop ? .mini : back)
        }
      }
    case "invisible:1", "invisible:0":
      ui.invisible = m.hasSuffix("1"); saveUI(); sendLook(); applyAlpha(); NotesCard.shared.relayout()
    case "lookReset":
      ui.look = Look(); ui.invisible = false; saveUI(); sendLook(); applyAlpha()
    case "endWatcher": endWatcherNow()
    case "ask:off", "ask:keep": answerAsk(String(m.dropFirst(4)))
    default:
      if m.hasPrefix("watch:"), let n = Int(m.dropFirst(6)) { startWatcher(n) }
      else if m.hasPrefix("look:"), let d = m.dropFirst(5).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        ui.look = Look.clean(o, ui.look); saveUI(); sendLook()
      }
    }
  }

  // Self test helpers.
  var showing: Bool { panel?.isVisible == true && current != nil }
  var cardVisible: Bool { panel?.isVisible == true }
  var cardKind: String { kind }
  var stretch: Stretch? { current }
  var watching: Date? { q.sync { watcherUntil } }
  var waitingNotice: Date? { q.sync { notice } }
  var pendingCount: Int { pending.count }
  var isDragging: Bool { dragging }
  func setLastActiveForTest(_ d: Date) { q.sync { lastActive = d } }
  func setWatcherUntilForTest(_ d: Date?) { q.sync { watcherUntil = d; save() } }
  func reloadForTest() {
    panel?.orderOut(nil); mode = .full; hovering = false; dragging = false; watchPointer(false)
    q.sync { current = nil; pending = []; watcherUntil = nil; notice = nil; load() }
    loadUI(); sendLook()
    if let c = current { show(c, animate: false) } else if notice != nil { showNotice() }
  }
  func sync(_ f: @escaping () -> Void) { q.async { DispatchQueue.main.async { f() } } }
  func tickForTest(now: Date = Date()) { q.sync { tick(now: now) } }
  func setPrefsForTest(_ p: Prefs) { q.sync { prefs = p } }
  func resetRoleForTest() { q.sync { testRoleApplied = nil } }
  func hoverForTest(_ on: Bool) {
    if on { let f = frameFor(.mini); let c = NSPoint(x: f.midX + parkDX, y: f.midY); pointerNow = { c } }   // over the stopwatch
    else { pointerNow = { NSPoint(x: -1_000_000, y: -1_000_000) } }
    hover(on)
  }
  /// A clean start for the self test (earlier steps simulate sleeps and wakes of their own).
  func resetForTest() { q.sync { afterGap = false; current = nil; pending = []; notice = nil; watcherUntil = nil; lastActive = Date(); save() }; DispatchQueue.main.async { self.hide() } }
  func resetUIForTest() { ui = UI(); saveUI(); sendLook() }

  // The card. Built in: no network, no vault, it only knows when the developer left and when he came back.
  private static let page = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  button{font-family:inherit}
  #card{position:absolute;left:10px;right:10px;top:6px;bottom:14px;border-radius:22px;overflow:hidden;padding:14px 18px 14px;box-sizing:border-box;
    background:linear-gradient(160deg,rgba(46,27,84,.97),rgba(20,12,28,.97) 65%);border:1.5px solid rgba(167,139,250,.6);
    box-shadow:0 18px 40px rgba(0,0,0,.42),0 0 0 1px rgba(0,0,0,.2);animation:drop .62s cubic-bezier(.22,1,.36,1) both;
    transition:border-radius .45s cubic-bezier(.22,1,.36,1),padding .45s cubic-bezier(.22,1,.36,1),left .45s,right .45s,top .45s,bottom .45s,border-color .3s}
  @keyframes drop{from{transform:translateY(-14px) scale(.97);opacity:.4}}
  #card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,#8B5CF6,#EC4E86,#8B5CF6);background-size:200% 100%;animation:stripe 4s linear infinite;transition:opacity .3s}
  @keyframes stripe{to{background-position:-200% 0}}
  .top{display:flex;align-items:center;gap:8px;padding-right:70px}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:850;letter-spacing:.14em;background:rgba(167,139,250,.22);color:#DDD6FE;flex:none}
  .pill i{width:7px;height:7px;border-radius:50%;background:#A78BFA;box-shadow:0 0 8px #A78BFA;animation:pulse 1.4s ease-in-out infinite}
  .back .pill{background:rgba(52,211,153,.18);color:#A7F3D0}.back .pill i{background:#34D399;box-shadow:0 0 8px #34D399;animation:none}
  @keyframes pulse{50%{opacity:.3}}
  #title{font-size:15px;font-weight:750;color:rgba(255,255,255,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tools{position:absolute;top:11px;right:12px;display:flex;gap:6px;align-items:center}
  .tools button{border:0;background:rgba(255,255,255,.07);color:rgba(255,255,255,.75);border-radius:99px;height:26px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .tools button:hover{background:rgba(255,255,255,.14);color:#fff}
  #gear{width:26px;padding:0}
  #inv{display:none;padding:0 10px;font-size:11.5px;font-weight:700}
  .tools button *{pointer-events:none}
  #clock{margin:6px 0 2px;font-size:44px;font-weight:850;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;
    background:linear-gradient(90deg,#fff 30%,#DDD6FE);-webkit-background-clip:text;background-clip:text;color:transparent}
  #since{font-size:12px;color:rgba(255,255,255,.55);white-space:nowrap}
  #ret{display:none;font-size:12px;color:rgba(167,243,208,.75);white-space:nowrap}
  body.pop #ret{display:block}
  .acts{position:absolute;right:16px;bottom:14px;display:flex;gap:8px;align-items:center}
  .acts button,#pick button{border:0;border-radius:99px;padding:9px 14px;font:800 13px -apple-system,sans-serif;color:#fff;cursor:pointer;transition:transform .15s,background .15s}
  .acts button:active,#pick button:active{transform:scale(.96)}
  .acts button span,#pick button span{pointer-events:none}
  #btn,#wpick{background:linear-gradient(135deg,#8B5CF6,#EC4E86);box-shadow:0 10px 24px -8px rgba(236,78,134,.8)}
  .sec{background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);font-weight:750}
  .sec:hover{background:rgba(255,255,255,.14)}
  #wat,#ext,#endw{display:none}
  body.full[data-kind=afk] #wat{display:inline-flex}
  body.full:not([data-kind=afk]) #alt{display:none}
  body.full[data-kind=ended] #ext,body.full[data-kind=notice] #ext,body.full[data-kind=watching] #ext{display:inline-flex}
  body.full[data-kind=watching] #btn{display:none}
  body.full[data-kind=watching] #endw{display:inline-flex}
  body.full[data-kind=notice] #clock{visibility:hidden;height:16px}
  body.full:not([data-kind=afk]) .tools{display:none}
  .back #btn{animation:glow 1.8s ease-in-out infinite}
  @keyframes glow{50%{box-shadow:0 0 0 5px rgba(236,78,134,.22),0 10px 28px -6px rgba(236,78,134,.95)}}
  .fade{animation:fade .35s ease both}
  @keyframes fade{from{opacity:0}}
  /* Watcher: how long. */
  #pick{display:none;margin-top:10px}
  body[data-pick="1"] #pick{display:block}
  body[data-pick="1"] #clock,body[data-pick="1"] #since,body[data-pick="1"] #ret,body[data-pick="1"] .acts,body[data-pick="1"] .tools{display:none}
  #pick .note{font-size:12px;color:rgba(255,255,255,.6);margin-bottom:10px}
  #wpick{display:block;width:100%;padding:11px 14px;font-size:14.5px;cursor:ns-resize}
  #pick .row{display:flex;gap:8px;margin-top:9px}
  #pick .row button{flex:1;padding:7px 10px;font-size:12px}
  /* Passive: the tiny stopwatch. Only the time (its look comes from the gear). */
  body.mini #card{left:7px;right:7px;top:7px;bottom:7px;border-radius:99px;padding:0;border:1.5px solid #8B5CF6;display:flex;align-items:center;justify-content:center;
    background:rgba(20,12,28,.9);box-shadow:0 6px 16px rgba(0,0,0,.35);animation:none}
  body.mini #card::before,body.mini .top,body.mini .tools,body.mini #since,body.mini #ret,body.mini .acts,body.mini #pick{display:none}
  body.mini #clock{margin:0;font-size:19px;font-weight:800;letter-spacing:0;background:none;color:#fff}
  /* Hovering the stopwatch: the details. */
  body.pop #card{left:3px;right:3px;top:3px;bottom:10px;border-radius:18px;padding:13px 15px;border-color:#8B5CF6;animation:none}
  body.pop #clock{display:none}
  body.pop #title{font-size:17px;font-weight:800;color:#fff}
  body.pop #inv{display:inline-flex}
  body.pop #since{margin-top:4px}
  body.pop .acts{left:13px;right:13px;top:88px;bottom:auto;justify-content:flex-end}
  body.pop .acts button{padding:8px 14px;font-size:12.5px}
  /* The gear: the stopwatch's look, with a live preview. */
  #gearv{display:none}
  body.gear #card>*:not(#gearv){display:none}
  body.gear #gearv{display:block}
  body.gear #card{animation:none}
  .gh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .gh b{font-size:15px;font-weight:800}
  .prev{height:74px;border-radius:14px;background:repeating-linear-gradient(45deg,rgba(255,255,255,.05) 0 10px,rgba(255,255,255,.09) 10px 20px);display:flex;align-items:center;justify-content:center;margin-bottom:10px}
  #pv{border-radius:99px;padding:5px 16px;border:1.5px solid #8B5CF6;display:inline-flex;align-items:center}
  #pvc{font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1}
  .gr{display:flex;align-items:center;gap:6px;min-height:30px;margin:3px 0}
  .gr>span{width:80px;flex:none;font-size:11.5px;font-weight:700;color:rgba(255,255,255,.62)}
  .chip{border:0;border-radius:99px;padding:5px 8px;font-size:11px;font-weight:750;color:rgba(255,255,255,.8);background:rgba(255,255,255,.08);cursor:pointer;white-space:nowrap}
  .chip.on{background:linear-gradient(135deg,#8B5CF6,#EC4E86);color:#fff}
  .sw{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0}
  .sw.on{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
  .gr input[type=range]{flex:1;accent-color:#A78BFA}
  .gb{display:flex;gap:8px;margin-top:10px}
  .gb button{border:0;border-radius:99px;padding:8px 14px;font-weight:800;font-size:12.5px;color:#fff;cursor:pointer}
  #gdone{background:linear-gradient(135deg,#8B5CF6,#EC4E86)}
  #greset{background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
  /* PS 1.66: the one question under the buttons (the posture reminder's look). */
  #ask{display:none;position:absolute;left:18px;right:18px;bottom:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.14)}
  body.full[data-kind=afk][data-ask="1"] #ask{display:block;animation:fade .45s ease both}
  body.full[data-kind=afk][data-ask="1"] .acts{bottom:94px}
  body[data-pick="1"] #ask{display:none}
  #ask p{margin:0 0 8px;font-size:12.5px;color:rgba(255,255,255,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #ask .ar{display:inline-flex;gap:8px}
  #ask button{border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;border-radius:99px;padding:6px 14px;font:600 12px -apple-system,sans-serif;cursor:pointer;transition:background .15s,transform .15s}
  #ask button:hover{background:rgba(255,255,255,.1)}
  #ask button:active{transform:scale(.96)}
  #ask button span{pointer-events:none}
  @media (prefers-reduced-motion:reduce){#card,#card::before,.pill i,.back #btn,.fade,#ask{animation:none;transition:none}}
  </style></head><body class="full" data-kind="afk"><div id="card">
  <div class="top"><span class="pill"><i></i><span id="tag">AFK</span></span><span id="title"></span></div>
  <div class="tools"><button id="inv"><span id="invl">Invisible</span></button><button id="gear" title="Stopwatch look"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></div>
  <div id="clock">0:00</div><div id="since"></div><div id="ret"></div>
  <div id="pick"><div class="note">No AFK cards until it ends. Scroll on the button to change the time, click it to start.</div>
    <button id="wpick"><span id="wpl">Remind me in 1 hour</span></button>
    <div class="row"><button id="wless" class="sec"><span>Shorter</span></button><button id="wmore" class="sec"><span>Longer</span></button><button id="wcancel" class="sec"><span>Cancel</span></button></div></div>
  <div class="acts"><button id="alt" class="sec"><span id="altl">Passive</span></button><button id="wat" class="sec"><span>Watcher</span></button><button id="ext" class="sec"><span>Extend</span></button><button id="endw" class="sec"><span>End watcher</span></button><button id="btn"><span>Back in the game</span></button></div>
  <div id="ask"><p id="aq"></p><div class="ar"><button id="aoff" type="button"><span id="aol"></span></button><button id="akeep" type="button"><span id="akl"></span></button></div></div>
  <div id="gearv"><div class="gh"><b>Stopwatch look</b><button id="gdone" class="chip on">Done</button></div>
    <div class="prev"><div id="pv"><span id="pvc">0:00</span></div></div>
    <div class="gr"><span>Outline</span><button class="chip" data-k="outline" data-v="1">On</button><button class="chip" data-k="outline" data-v="0">Off</button></div>
    <div class="gr"><span>Outline colour</span><div id="oc" style="display:flex;gap:7px"></div></div>
    <div class="gr"><span>Text colour</span><div id="tc" style="display:flex;gap:7px"></div></div>
    <div class="gr"><span>Font</span><button class="chip" data-k="font" data-v="system">System</button><button class="chip" data-k="font" data-v="rounded">Rounded</button><button class="chip" data-k="font" data-v="mono">Mono</button><button class="chip" data-k="font" data-v="serif">Serif</button></div>
    <div class="gr"><span>Size</span><input id="gsize" type="range" min="12" max="36" step="1"></div>
    <div class="gr"><span>See through</span><input id="gop" type="range" min="15" max="100" step="1"></div>
    <div class="gr"><span>Brightness</span><input id="gbr" type="range" min="60" max="140" step="1"></div>
    <div class="gr"><span>How obvious</span><button class="chip" data-k="bold" data-v="0">Subtle</button><button class="chip" data-k="bold" data-v="1">Normal</button><button class="chip" data-k="bold" data-v="2">Strong</button><button class="chip" data-k="bold" data-v="3">Bold</button></div>
    <div class="gr"><span>Invisible</span><button class="chip" data-k="inv" data-v="0">Off</button><button class="chip" data-k="inv" data-v="1">On</button></div>
    <div class="gb"><button id="greset">Reset</button></div></div>
  </div>
  <script>
  (function(){
    var st=null,mode='full',look=null,inv=false,picking=false,wmin=60,card=document.getElementById('card'),clock=document.getElementById('clock'),title=document.getElementById('title'),since=document.getElementById('since'),tag=document.getElementById('tag'),alt=document.getElementById('alt'),altl=document.getElementById('altl'),ret=document.getElementById('ret'),wpl=document.getElementById('wpl'),invl=document.getElementById('invl'),pvc=document.getElementById('pvc');
    var PRESETS=[15,30,60,90,120,180],OC=['#8B5CF6','#EC4E86','#34D399','#38BDF8','#FBBF24','#FFFFFF'],TC=['#FFFFFF','#DDD6FE','#A7F3D0','#BAE6FD','#FDE68A','#FBCFE8'];
    var FONTS={system:'-apple-system,BlinkMacSystemFont,sans-serif',rounded:'ui-rounded,"SF Pro Rounded",-apple-system,sans-serif',mono:'ui-monospace,"SF Mono",Menlo,monospace',serif:'ui-serif,"New York",Georgia,serif'};
    // Written only when they change: replacing the text under the pointer between mouse down and up
    // makes WebKit drop the click (the "Full card" button used to be rewritten 4 times a second).
    function put(e,t){if(e.textContent!==t)e.textContent=t}
    function fmt(ms){var s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return(h?h+':'+String(m).padStart(2,'0'):m)+':'+String(x).padStart(2,'0')}
    function hm(t){return new Date(t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}
    function mins(m){var h=Math.floor(m/60),r=m%60;return h?(h+(h>1?' hours':' hour')+(r?' '+r+' minutes':'')):r+' minutes'}
    function post(m){try{webkit.messageHandlers.afk.postMessage(m)}catch(e){}}
    function draw(){
      if(!st)return;
      var k=st.kind||'afk',total=Date.now()-st.start;
      if(document.body.dataset.kind!==k)document.body.dataset.kind=k;
      put(clock,k==='watching'?fmt(st.until-Date.now()):fmt(total));
      var cls=(k==='afk'&&st.back)?'back':'';if(card.className!==cls)card.className=cls;
      if(picking){put(tag,'WATCHER');put(title,'Watcher mode');put(wpl,'Remind me in '+mins(wmin));return}
      if(k==='afk'){
        put(tag,st.back?'BACK':'AFK');
        put(title,mode==='pop'||st.back?'AFK for '+fmt(total):'AFK for '+fmt(st.threshold*1000)+' minutes');
        put(since,'Since '+hm(st.start)+(st.back&&mode==='full'?', back at your Mac '+hm(st.back):''));
        put(ret,st.back?'Back at your Mac since '+hm(st.back):'');
      }else if(k==='watching'){
        put(tag,'WATCHER');put(title,'Watcher mode, '+fmt(st.until-Date.now())+' left');put(since,'Until '+hm(st.until));
      }else{
        put(tag,'ENDED');put(title,'Watcher mode ended');
        put(since,k==='notice'?'Ended at '+hm(st.start):'Since '+hm(st.start)+(st.back?', back at your Mac '+hm(st.back):''));
      }
      put(altl,mode==='full'?'Passive':'Full card');
      put(pvc,fmt(k==='afk'||k==='ended'?total:0));
    }
    function css(el,txt,L){
      if(!L){el.style.cssText='';txt.style.cssText='';return}
      var oc=L.outlineColor,tc=L.textColor,b=L.bold;
      el.style.borderColor=L.outline?oc:'transparent';
      el.style.background='rgba(20,12,28,'+L.opacity+')';
      el.style.filter='brightness('+L.brightness+')';
      el.style.boxShadow=['none','0 6px 16px rgba(0,0,0,.35)','0 6px 16px rgba(0,0,0,.35),0 0 12px '+oc+'99','0 6px 16px rgba(0,0,0,.4),0 0 0 1px '+oc+',0 0 20px '+oc][b];
      txt.style.color=tc;txt.style.fontFamily=FONTS[L.font]||FONTS.system;txt.style.fontSize=L.size+'px';
      txt.style.fontWeight=[600,800,800,900][b];txt.style.opacity=b===0?'.72':'1';
      txt.style.textShadow=['none','none','0 0 6px rgba(255,255,255,.35)','0 0 10px '+tc][b];
    }
    function applyLook(){
      if(!look)return;
      css(document.getElementById('pv'),pvc,look);
      if(mode==='mini')css(card,clock,look);else css(card,clock,null);
      [].forEach.call(document.querySelectorAll('#gearv .chip[data-k]'),function(c){
        var k=c.dataset.k,v=c.dataset.v,on=k==='outline'?String(look.outline?1:0)===v:k==='font'?look.font===v:k==='bold'?String(look.bold)===v:k==='inv'?String(inv?1:0)===v:false;
        if(c.classList.contains('on')!==on)c.classList.toggle('on',on)});
      [['oc',OC,'outlineColor'],['tc',TC,'textColor']].forEach(function(x){[].forEach.call(document.getElementById(x[0]).children,function(b){var on=b.dataset.c===look[x[2]];if(b.classList.contains('on')!==on)b.classList.toggle('on',on)})});
      var g=document.getElementById('gsize'),o=document.getElementById('gop'),r=document.getElementById('gbr');
      if(document.activeElement!==g)g.value=look.size;if(document.activeElement!==o)o.value=Math.round(look.opacity*100);if(document.activeElement!==r)r.value=Math.round(look.brightness*100);
      put(invl,inv?'Visible':'Invisible');
    }
    function setLook(p){for(var k in p)look[k]=p[k];applyLook();post('look:'+JSON.stringify(p))}
    [['oc',OC,'outlineColor'],['tc',TC,'textColor']].forEach(function(x){var box=document.getElementById(x[0]);x[1].forEach(function(c){var b=document.createElement('button');b.className='sw';b.style.background=c;b.dataset.c=c;b.title=c;b.onclick=function(){var p={};p[x[2]]=c;setLook(p)};box.appendChild(b)})});
    [].forEach.call(document.querySelectorAll('#gearv .chip[data-k]'),function(c){c.onclick=function(){var k=c.dataset.k,v=c.dataset.v;
      if(k==='inv'){inv=v==='1';applyLook();post('invisible:'+v)}else if(k==='outline')setLook({outline:v==='1'});else if(k==='font')setLook({font:v});else setLook({bold:Number(v)})}});
    [['gsize','size',1],['gop','opacity',100],['gbr','brightness',100]].forEach(function(x){var el=document.getElementById(x[0]);
      el.addEventListener('input',function(){look[x[1]]=Number(el.value)/x[2];applyLook()});
      el.addEventListener('change',function(){var p={};p[x[1]]=Number(el.value)/x[2];setLook(p)})});
    document.getElementById('greset').onclick=function(){post('lookReset')};
    document.getElementById('gdone').onclick=function(){post('gearDone')};
    document.getElementById('gear').onclick=function(){post('gear')};
    document.getElementById('inv').onclick=function(){inv=!inv;applyLook();post('invisible:'+(inv?1:0))};
    document.getElementById('btn').onclick=function(){post('back')};
    document.getElementById('endw').onclick=function(){post('endWatcher')};
    function askSet(a){if(a&&a.title){put(document.getElementById('aq'),a.title);put(document.getElementById('aol'),a.off);put(document.getElementById('akl'),a.keep)}
      var v=a&&a.title?'1':'';if((document.body.dataset.ask||'')!==v)document.body.dataset.ask=v}
    document.getElementById('aoff').onclick=function(){post('ask:off')};
    document.getElementById('akeep').onclick=function(){askSet(null);post('ask:keep')};
    alt.onclick=function(){post(mode==='full'?'passive':'full')};
    function pick(on){picking=on;document.body.dataset.pick=on?'1':'';draw()}
    document.getElementById('wat').onclick=function(){wmin=(st&&st.lastWatch)||60;pick(true)};
    document.getElementById('ext').onclick=function(){wmin=(st&&st.lastWatch)||60;pick(true)};
    document.getElementById('wcancel').onclick=function(){pick(false)};
    document.getElementById('wless').onclick=function(){wmin=Math.max(5,wmin-5);draw()};
    document.getElementById('wmore').onclick=function(){wmin=Math.min(720,wmin+5);draw()};
    document.getElementById('wpick').onclick=function(){post('watch:'+wmin);pick(false)};
    // The mouse wheel steps through 15 min, 30 min, 1 h, 1.5 h, 2 h, 3 h (from any other length, to the next one along).
    var acc=0,lastW=0;
    function step(d){var i=PRESETS.indexOf(wmin);if(i>=0)wmin=PRESETS[Math.max(0,Math.min(PRESETS.length-1,i+d))];
      else{var n=d>0?PRESETS.filter(function(p){return p>wmin})[0]:PRESETS.filter(function(p){return p<wmin}).pop();if(n)wmin=n}draw()}
    document.getElementById('wpick').addEventListener('wheel',function(e){e.preventDefault();acc+=e.deltaY;var now=Date.now();
      if(Math.abs(acc)<4||now-lastW<90)return;lastW=now;step(acc>0?1:-1);acc=0},{passive:false});
    // Dragging the stopwatch (or its pop-up): once the mouse moves with the button down, PS moves the
    // window and the click that ends the drag is swallowed, so a drag never presses a button.
    var down=null,dragged=false;
    document.addEventListener('mousedown',function(e){if(e.button!==0)return;dragged=false;down=(mode==='mini'||mode==='pop')?{x:e.screenX,y:e.screenY}:null},true);
    document.addEventListener('mousemove',function(e){if(!down)return;if(Math.abs(e.screenX-down.x)+Math.abs(e.screenY-down.y)>5){down=null;dragged=true;post('drag')}},true);
    document.addEventListener('mouseup',function(){down=null},true);
    document.addEventListener('click',function(e){if(dragged){e.stopPropagation();e.preventDefault();dragged=false}},true);
    window.__afk={
      set:function(s){st=s;askSet(s.ask);draw()},
      ask:function(a){askSet(a)},
      look:function(l,i){look=l;inv=!!i;applyLook()},
      mode:function(m){if(m===mode)return;mode=m;document.body.className=m;if(m!=='full'&&picking)pick(false);
        [document.querySelector('.top'),clock,since,ret,document.querySelector('.acts')].forEach(function(e){e.classList.remove('fade');void e.offsetWidth;e.classList.add('fade')});applyLook();draw()},
      pickValue:function(){return picking?wmin:null},
      undrag:function(){dragged=false;down=null}
    };
    setInterval(draw,250);
  })();
  </script></body></html>
  """#
}


// MARK: - Self test: the AFK timer with a FAKE idle clock, app in front and video (no real input read).
extension SelfTest {
  static func afkCheck(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let k = Afk.shared
    var lastInput = Date(), front: String? = "com.example.editor", video = false
    func idle(_ secs: Double) { lastInput = Date().addingTimeInterval(-secs) }   // the fake clock ages like the real one
    let keep = (k.idleNow, k.frontNow, k.videoNow, k.deliver)
    k.idleNow = { Date().timeIntervalSince(lastInput) }; k.frontNow = { front }; k.videoNow = { video }
    var got: [String] = []
    k.deliver = { j in got.append(j); return true }
    var p = Afk.Prefs(); p.threshold = 120
    k.resetForTest()
    k.setPrefsForTest(p)
    var r: [(String, Bool)] = []
    func js(_ s: String, _ f: @escaping (Any?) -> Void) { k.web?.evaluateJavaScript(s) { v, _ in f(v) } ?? f(nil) }
    let read = "JSON.stringify({title: document.getElementById('title').textContent, clock: document.getElementById('clock').textContent, since: document.getElementById('since').textContent, back: document.getElementById('card').className === 'back'})"
    func later(_ t: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: f) }
    /// The big number on the card, in seconds ("2:05" or "1:00:03" inside the page's JSON).
    func secs(_ json: String) -> Int? {
      guard let r = json.range(of: "\"clock\":\"") else { return nil }
      let parts = json[r.upperBound...].prefix(while: { $0 != "\"" }).split(separator: ":").compactMap { Int($0) }
      return parts.isEmpty ? nil : parts.reduce(0) { $0 * 60 + $1 }
    }
    /// The card shows the true time since the stretch began (within 2 s).
    func matchesStart(_ json: String) -> Bool {
      guard let n = secs(json), let st = k.stretch?.start else { return false }
      return abs(Double(n) - Date().timeIntervalSince(st)) < 2.5
    }
    func clickBack(_ f: @escaping () -> Void) { js("document.getElementById('btn').click()") { _ in later(0.9) { f() } } }

    // Passive: the click, the corner, the count, hover open and leave close, a restart, both cards
    // together (never overlapping), back to the full card, dismissing from the pop-up, start in passive.
    func near(_ a: NSRect, _ b: NSRect) -> Bool { abs(a.maxY - b.maxY) < 2 && abs(a.width - b.width) < 2 && abs(a.height - b.height) < 2 }
    func apart() -> Bool {
      guard let n = NotesCard.shared.panel, n.isVisible, let f = k.panel?.frame else { return false }
      return !n.frame.intersects(f) && n.frame.maxY <= f.minY + 0.5
    }
    func passiveCheck(_ next: @escaping () -> Void) {
      k.setPrefsForTest(p); idle(121); k.tickForTest()
      later(1.2) {
        js("document.getElementById('alt').textContent") { label in
          r.append(("full-card-has-passive", String(describing: label ?? "") == "Passive" && k.mode == .full))
          js("document.getElementById('alt').click()") { _ in
            later(1) {
              js("JSON.stringify({body: document.body.className, clock: document.getElementById('clock').textContent})") { v in
                let s1 = String(describing: v ?? "")
                r.append(("passive-goes-to-the-corner", k.mode == .mini && near(k.panel!.frame, Afk.frame(.mini)) && s1.contains("\"body\":\"mini\"") && k.stretch?.passive == true))
                snap(k.web!, "\(dir)/afk-mini.png") {
                  later(2) {
                    js("document.getElementById('clock').textContent") { v2 in
                      let c1 = s1.components(separatedBy: "\"clock\":\"").last?.prefix(while: { $0 != "\"" }) ?? ""
                      let c2 = String(describing: v2 ?? "")
                      r.append(("stopwatch-counts", c2.hasPrefix("2:") && c2 != String(c1) && k.showing))
                      idle(0.2); k.tickForTest()                                 // typing while passive: it keeps counting
                      later(1.5) {
                      js("JSON.stringify({clock: document.getElementById('clock').textContent})") { v2b in
                      let s2b = String(describing: v2b ?? "")
                      r.append(("passive-counts-through-input", (secs(s2b) ?? 0) > (secs("\"clock\":\"" + c2 + "\"") ?? 999_999) && matchesStart(s2b) && k.stretch?.back != nil && k.mode == .mini && k.showing))
                      k.hoverForTest(true)
                      later(0.8) {
                        js("JSON.stringify({body: document.body.className, title: document.getElementById('title').textContent, since: document.getElementById('since').textContent, ret: document.getElementById('ret').textContent, alt: document.getElementById('alt').textContent})") { v3 in
                          let s3 = String(describing: v3 ?? "")
                          r.append(("hover-opens", k.mode == .pop && near(k.panel!.frame, Afk.frame(.pop)) && s3.contains("\"body\":\"pop\"") && s3.contains("AFK for 2:") && s3.contains("Since") && s3.contains("Full card")))
                          r.append(("pop-says-back-at-your-mac", s3.contains("Back at your Mac since")))
                          snap(k.web!, "\(dir)/afk-pop.png") {
                            k.hoverForTest(false)
                            later(0.8) {
                              r.append(("leave-shrinks", k.mode == .mini && near(k.panel!.frame, Afk.frame(.mini))))
                              r.append(("hover-never-dismisses", k.showing))
                              k.reloadForTest()                                   // a restart while passive
                              later(1) {
                                r.append(("restart-keeps-passive", k.showing && k.mode == .mini && k.stretch?.passive == true && near(k.panel!.frame, Afk.frame(.mini))))
                                // Both cards: a fictional meeting notes card arrives while the stopwatch is up.
                                NotesCard.shared.show(["id": "nc:afktest", "tone": "notes", "title": "Fictional call", "blur": false, "snooze": [5, 10, 15],
                                                       "items": [["id": "a1", "text": "First thing"], ["id": "a2", "text": "Second thing"]]])
                                later(1.2) {
                                  r.append(("notes-below-stopwatch", apart()))
                                  k.hoverForTest(true)
                                  later(0.8) {
                                    r.append(("notes-below-popup", k.mode == .pop && apart()))
                                    k.hoverForTest(false)
                                    later(0.8) {
                                      r.append(("notes-back-up", k.mode == .mini && apart() && abs(NotesCard.shared.panel!.frame.maxY - k.panel!.frame.minY) < 12))
                                      if !(r.last?.1 ?? true) { print("AFK DEBUG notes-back-up: mode=\(k.mode.rawValue) afk=\(k.panel!.frame) notes=\(String(describing: NotesCard.shared.panel?.frame)) visible=\(NotesCard.shared.panel?.isVisible ?? false)") }
                                      k.hoverForTest(true)
                                      later(0.8) {
                                        js("document.getElementById('alt').click()") { _ in          // "Full card"
                                          later(1) {
                                            r.append(("pops-back-to-full", k.mode == .full && near(k.panel!.frame, Afk.frame(.full)) && k.stretch?.passive == nil && k.showing))
                                            r.append(("notes-to-the-top", Afk.shared.occupied == nil && abs((NotesCard.shared.panel?.frame.maxY ?? 0) - ((NSScreen.screens.first ?? NSScreen.main!).visibleFrame.maxY - 6)) < 2))
                                            NotesCard.shared.hide("nc:afktest")
                                            js("document.getElementById('alt').click()") { _ in    // passive again, then dismiss from the pop-up
                                              later(1) {
                                                k.hoverForTest(true)
                                                later(0.8) {
                                                  idle(0.3)                                      // the click is input, as on a real Mac
                                                  clickBack {
                                                    r.append(("dismiss-from-popup", !k.showing && k.stretch == nil))
                                                    var sp = p; sp.startPassive = true; k.setPrefsForTest(sp)
                                                    idle(121); k.tickForTest()
                                                    later(1) {
                                                      r.append(("start-in-passive", k.showing && k.mode == .mini && near(k.panel!.frame, Afk.frame(.mini))))
                                                      idle(0.3)
                                                      clickBack {
                                                        k.setPrefsForTest(p)
                                                        next()
                                                      }
                                                    }
                                                  }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Real mouse clicks: mouse down and up events through the window's own event path (hit test, first
    // click, WebKit), at the button's place on screen. The developer's pointer never moves: the window is parked off
    // screen and the events go straight to it. A click whose spot is no longer inside the window misses,
    // as it would on screen.
    var evn = 0, lastPress = ""
    func spot(_ id: String, _ f: @escaping (NSPoint?) -> Void) {
      js("(function(){var e=document.getElementById('\(id)');if(!e||!e.offsetParent)return null;var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()") { v in
        guard let a = v as? [NSNumber], a.count == 2, let w = k.web, let p = k.panel else { f(nil); return }
        let local = NSPoint(x: a[0].doubleValue, y: w.isFlipped ? a[1].doubleValue : w.bounds.height - a[1].doubleValue)
        f(p.convertPoint(toScreen: w.convert(local, to: nil)))
      }
    }
    func press(_ at: NSPoint?, _ f: @escaping (Bool) -> Void) {
      guard let at, let p = k.panel, p.isVisible else { f(false); return }
      let inWin = p.convertPoint(fromScreen: at)
      guard NSRect(origin: .zero, size: p.frame.size).contains(inWin) else { f(false); return }
      func ev(_ t: NSEvent.EventType) -> NSEvent? {
        evn += 1
        return NSEvent.mouseEvent(with: t, location: inWin, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: p.windowNumber,
                                  context: nil, eventNumber: evn, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1)
      }
      k.pointerNow = { at }; k.buttonsNow = { 1 }; idle(0)
      lastPress = "mode=\(k.mode.rawValue) win=\(Int(inWin.x)),\(Int(inWin.y)) size=\(Int(p.frame.width))x\(Int(p.frame.height))"
      js("window.__ev=[]") { _ in }
      if let d = ev(.leftMouseDown) { p.sendEvent(d) }
      later(0.09) { if let u = ev(.leftMouseUp) { p.sendEvent(u) }; k.buttonsNow = { 0 }; f(true) }
    }
    // 20 tries: Passive, hover, Full card (some with the pointer slipping out of the stopwatch while it
    // opens, as a quick move does), mixed with Passive, hover, Back in the game, half with the notes card up.
    func clickCheck(_ next: @escaping () -> Void) {
      var full = 0, fullOk = 0, back = 0, backOk = 0, passiveOk = 0, overlap = 0
      js("window.__ev=[];['mousedown','mouseup','click'].forEach(function(t){document.addEventListener(t,function(e){window.__ev.push(t+':'+(e.target.id||e.target.className||e.target.tagName)+'@'+Math.round(e.clientX)+','+Math.round(e.clientY))},true)})") { _ in }
      func miss(_ what: String, _ i: Int, _ then: @escaping () -> Void) {
        let lp = lastPress
        js("JSON.stringify({ev: window.__ev, body: document.body.className, w: innerWidth, h: innerHeight})") { v in
          print("AFK CLICKS: try \(i) \(what) missed: \(lp) page=\(String(describing: v ?? ""))"); then()
        }
      }
      func one(_ i: Int) {
        guard i < 20 else {
          NotesCard.shared.hide("nc:clicks")
          r.append(("real-click-passive", passiveOk == 20))
          r.append(("real-click-full-card", fullOk == full))
          r.append(("real-click-back", backOk == back))
          r.append(("never-overlaps-notes", overlap == 0))
          print("AFK CLICKS: passive \(passiveOk)/20 full-card \(fullOk)/\(full) back \(backOk)/\(back) overlaps=\(overlap)")
          next(); return
        }
        let notes = i % 2 == 1, slip = i % 3 == 0, isBack = i % 4 == 3
        if notes { NotesCard.shared.show(["id": "nc:clicks", "tone": "notes", "title": "Fictional call", "blur": false, "snooze": [5, 10],
                                          "items": [["id": "c1", "text": "First thing"], ["id": "c2", "text": "Second thing"]]]) }
        else { NotesCard.shared.hide("nc:clicks") }
        idle(121); k.tickForTest()
        later(0.8) {
          spot("alt") { pa in
            press(pa) { _ in                                                   // "Passive" on the big card
              later(0.7) {
                if k.mode == .mini { passiveOk += 1 } else { miss("Passive", i) {} }
                k.hoverForTest(true)                                           // the pointer reaches the stopwatch
                later(0.5) {
                  if notes, let n = NotesCard.shared.panel, let f = k.panel?.frame, n.frame.intersects(f) { overlap += 1 }
                  spot(isBack ? "btn" : "alt") { pb in
                    if slip { k.hoverForTest(false) }                          // a quick move: out of the small window before it grew
                    if let pb { k.pointerNow = { pb } }                        // the pointer rests on the button
                    later(0.6) {
                      press(pb) { _ in
                        later(0.8) {
                          idle(0.3)
                          if isBack { back += 1; if !k.showing { backOk += 1; one(i + 1) } else { miss("Back", i) { clickBack { one(i + 1) } } }; return }
                          full += 1
                          if k.mode == .full && k.showing { fullOk += 1; clickBack { one(i + 1) } }
                          else { miss("Full card (slip \(slip), notes \(notes))", i) { clickBack { one(i + 1) } } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      one(0)
    }

    // ---------- Watcher, the gear, dragging, invisible, the Tab list badge (23 Oct), with real mouse events ----------
    func spotQ(_ sel: String, _ f: @escaping (NSPoint?) -> Void) {
      js("(function(){var e=document.querySelector(\"\(sel)\");if(!e||!e.offsetParent)return null;var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,r.width]})()") { v in
        guard let a = v as? [NSNumber], a.count == 3, let w = k.web, let p = k.panel else { f(nil); return }
        let local = NSPoint(x: a[0].doubleValue, y: w.isFlipped ? a[1].doubleValue : w.bounds.height - a[1].doubleValue)
        f(p.convertPoint(toScreen: w.convert(local, to: nil)))
      }
    }
    func clickQ(_ sel: String, _ f: @escaping (Bool) -> Void) { spotQ(sel) { pt in press(pt) { ok in later(0.5) { f(ok) } } } }
    /// A real click on a range slider at a fraction of its width.
    func clickRange(_ sel: String, _ frac: Double, _ f: @escaping () -> Void) {
      js("(function(){var e=document.querySelector(\"\(sel)\");var r=e.getBoundingClientRect();return [r.left+r.width*\(frac),r.top+r.height/2]})()") { v in
        guard let a = v as? [NSNumber], a.count == 2, let w = k.web, let p = k.panel else { f(); return }
        let local = NSPoint(x: a[0].doubleValue, y: w.isFlipped ? a[1].doubleValue : w.bounds.height - a[1].doubleValue)
        press(p.convertPoint(toScreen: w.convert(local, to: nil))) { _ in later(0.6, f) }
      }
    }
    /// A real scroll wheel event at an element (made from a CGEvent, sent through the window). When the
    /// page did not see it, the page's own wheel handler gets a wheel event instead (reported).
    var wheelWay = "real"
    func wheel(_ sel: String, _ down: Bool, _ f: @escaping () -> Void) {
      js("window.__afk.pickValue()") { before in
        spotQ(sel) { pt in
          if let pt, let p = k.panel, let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: down ? -3 : 3, wheel2: 0, wheel3: 0) {
            cg.location = CGPoint(x: pt.x, y: (NSScreen.screens.first?.frame.height ?? 0) - pt.y)
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(p.windowNumber))
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(p.windowNumber))
            if let ev = NSEvent(cgEvent: cg) { p.sendEvent(ev); later(0.15) { if let w = k.web { w.scrollWheel(with: ev) } } }   // through the window, then straight to the web view
          }
          later(0.4) {
            js("window.__afk.pickValue()") { after in
              if "\(String(describing: before))" != "\(String(describing: after))" { f(); return }
              wheelWay = "js"
              js("document.querySelector(\"\(sel)\").dispatchEvent(new WheelEvent('wheel',{deltaY:\(down ? 100 : -100),bubbles:true,cancelable:true}))") { _ in later(0.3, f) }
            }
          }
        }
      }
    }
    /// Holds the mouse down on an element, moves it (real mouse down and dragged events, plus the pointer
    /// and button state PS reads), lets go at a spot (on screen), then sends the mouse up.
    func dragFrom(_ sel: String, to target: NSPoint, _ f: @escaping () -> Void) {
      spotQ(sel) { pt in
        guard let pt, let p = k.panel else { f(); return }
        let inWin = p.convertPoint(fromScreen: pt)
        func ev(_ t: NSEvent.EventType, _ at: NSPoint) -> NSEvent? {
          evn += 1
          return NSEvent.mouseEvent(with: t, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: p.windowNumber,
                                    context: nil, eventNumber: evn, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1)
        }
        k.pointerNow = { pt }; k.buttonsNow = { 1 }; idle(0)
        if let d = ev(.leftMouseDown, inWin) { p.sendEvent(d) }
        later(0.08) {
          for i in 1...4 { if let m = ev(.leftMouseDragged, NSPoint(x: inWin.x + CGFloat(i * 4), y: inWin.y - CGFloat(i * 2))) { p.sendEvent(m) } }
          later(0.3) {
            let parked = NSPoint(x: target.x + ScreenGuard.parkX, y: target.y)
            k.pointerNow = { parked }
            later(0.3) {
              k.buttonsNow = { 0 }
              later(0.3) {
                if let u = ev(.leftMouseUp, NSPoint(x: 10, y: 10)) { p.sendEvent(u) }
                later(0.5, f)
              }
            }
          }
        }
      }
    }
    func pageJS(_ code: String, _ f: @escaping (String) -> Void) { js(code) { v in f(v.map { "\($0)" } ?? "") } }
    func overlayJS(_ code: String, _ f: @escaping (String) -> Void) { a.overlay.evaluateJavaScript(code) { v, _ in f(v.map { "\($0)" } ?? "") } }
    func badgeText(_ f: @escaping (String) -> Void) { overlayJS("(document.querySelector('.afk-badge')||{textContent:''}).textContent", f) }
    /// The badge's click: a real click in the Tab list window when it is up, else the page's own click (reported).
    var badgeWay: [String] = []
    func clickBadge(_ f: @escaping () -> Void) {
      // The badge lives in the Tab list: if something closed the list (real use of the Mac during a
      // test), open it again first (a test copy's list stays invisible, parked and click through).
      if !a.shown { a.showOverlay(); later(0.8) { clickBadgeNow(f) } } else { clickBadgeNow(f) }
    }
    func clickBadgeNow(_ f: @escaping () -> Void) {
      a.overlay.evaluateJavaScript("(function(){var e=document.querySelector('.afk-badge');if(!e)return null;var r=e.getBoundingClientRect();if(r.width<1||r.height<1)return null;return [r.left+r.width/2,r.top+r.height/2]})()") { v, _ in
        guard let c = v as? [NSNumber], c.count == 2, let win = a.overlay.window, win.isVisible else {
          badgeWay.append("js")
          a.overlay.evaluateJavaScript("document.querySelector('.afk-badge')&&document.querySelector('.afk-badge').click()") { _, _ in later(0.9, f) }
          return
        }
        badgeWay.append("real")
        let w: WKWebView = a.overlay
        let local = NSPoint(x: c[0].doubleValue, y: w.isFlipped ? c[1].doubleValue : w.bounds.height - c[1].doubleValue)
        let inWin = w.convert(local, to: nil)
        func ev(_ t: NSEvent.EventType) -> NSEvent? {
          evn += 1
          return NSEvent.mouseEvent(with: t, location: inWin, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, eventNumber: evn, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1)
        }
        if let d = ev(.leftMouseDown) { win.sendEvent(d) }
        later(0.09) { if let u = ev(.leftMouseUp) { win.sendEvent(u) }; later(0.9, f) }
      }
    }
    /// A picture of the badge in the Tab list's top right corner.
    func snapBadge(_ f: @escaping () -> Void) {
      a.overlay.evaluateJavaScript("(function(){var e=document.querySelector('.afk-badge');if(!e)return null;var r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()") { v, _ in
        guard let c = v as? [NSNumber], c.count == 4 else { f(); return }
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(x: c[0].doubleValue - 16, y: c[1].doubleValue - 12, width: c[2].doubleValue + 220, height: c[3].doubleValue + 24)
        a.overlay.takeSnapshot(with: cfg) { img, _ in
          if let img, let t = img.tiffRepresentation, let rep = NSBitmapImageRep(data: t), let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: "\(dir)/afk-badge-\(badgeWay.count).png")); print("saved \(dir)/afk-badge-\(badgeWay.count).png")
          }
          f()
        }
      }
    }
    let vf = (NSScreen.screens.first ?? NSScreen.main!).visibleFrame
    func newStretch(_ then: @escaping () -> Void) { idle(121); k.tickForTest(); later(0.9, then) }

    func moreCheck(_ next: @escaping () -> Void) {
      k.setPrefsForTest(p); k.resetUIForTest()
      newStretch { watcherA(next) }
    }
    // Watcher: the picker (default 1 hour, Shorter and Longer, the wheel), the card closes, no AFK while it runs, a restart.
    func watcherA(_ next: @escaping () -> Void) {
      clickQ("#wat") { _ in
        pageJS("window.__afk.pickValue()") { pv in
          r.append(("watcher-opens-picker-at-1-hour", pv == "60"))
          snap(k.web!, "\(dir)/afk-watcher-pick.png") {
            clickQ("#wmore") { _ in
              pageJS("window.__afk.pickValue()") { pv2 in
                clickQ("#wless") { _ in
                  pageJS("window.__afk.pickValue()") { pv3 in
                    r.append(("watcher-shorter-longer", pv2 == "65" && pv3 == "60"))
                    wheel("#wpick", true) {
                      pageJS("window.__afk.pickValue()") { pv4 in
                        r.append(("watcher-wheel-steps", pv4 == "90" || pv4 == "30"))
                        let chosen = Int(pv4) ?? 60
                        let before = got.count
                        clickQ("#wpick") { _ in
                          let until = k.watching
                          r.append(("watcher-starts-card-closes", !k.cardVisible && k.stretch == nil && until != nil
                                    && abs((until ?? Date()).timeIntervalSinceNow - Double(chosen * 60)) < 5 && got.count > before))
                          idle(900); k.tickForTest()
                          r.append(("no-afk-during-watcher", !k.cardVisible && k.stretch == nil))
                          later(0.8) {
                            badgeText { b in
                              r.append(("badge-shows-watcher", b.hasPrefix("Watcher ") && b.hasSuffix(" left")))
                              snapBadge {
                                k.reloadForTest()                                 // a restart while watching
                                idle(900); k.tickForTest()
                                r.append(("watcher-survives-restart", k.watching != nil && !k.cardVisible))
                                watcherB(next)
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // The time is up while the developer is idle (the AFK clock runs from the end), Extend, the badge's Watcher card, End watcher, the notice.
    func watcherB(_ next: @escaping () -> Void) {
      let end = Date().addingTimeInterval(-1)
      k.setWatcherUntilForTest(end); idle(900); k.tickForTest()
      later(1.0) {
        pageJS("JSON.stringify({kind: document.body.dataset.kind, title: document.getElementById('title').textContent, ext: getComputedStyle(document.getElementById('ext')).display, btn: getComputedStyle(document.getElementById('btn')).display})") { e in
          r.append(("watcher-end-card", k.cardVisible && k.cardKind == "ended" && k.stretch?.watcher == true
                    && abs((k.stretch?.start ?? .distantPast).timeIntervalSince(end)) < 1.5 && e.contains("Watcher mode ended") && !e.contains("\"ext\":\"none\"") && !e.contains("\"btn\":\"none\"")))
          snap(k.web!, "\(dir)/afk-watcher-ended.png") {
            clickQ("#ext") { _ in
              clickQ("#wpick") { _ in
                r.append(("extend-restarts-watcher", k.watching != nil && !k.cardVisible && k.stretch == nil))
                a.hideOverlay(force: true)                                 // as if the Tab list had been closed meanwhile: the badge click must still work
                clickBadge {
                  pageJS("document.body.dataset.kind") { kd in
                    r.append(("badge-click-shows-watcher-card", k.cardVisible && kd == "watching"))
                    clickQ("#endw") { _ in
                      r.append(("end-watcher", k.watching == nil && !k.cardVisible))
                      later(0.6) {
                        badgeText { b0 in
                          r.append(("badge-hidden-when-nothing-runs", b0.isEmpty))
                          k.setWatcherUntilForTest(Date().addingTimeInterval(-1)); idle(2); k.tickForTest()
                          later(0.9) {
                            r.append(("watcher-end-while-at-the-mac", k.cardVisible && k.cardKind == "notice" && k.stretch == nil && k.waitingNotice != nil))
                            clickQ("#btn") { _ in
                              r.append(("notice-closes", !k.cardVisible && k.waitingNotice == nil))
                              gearA(next)
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // The gear: every setting by a real click, the live preview, kept after a restart.
    func gearA(_ next: @escaping () -> Void) {
      idle(0.2); k.tickForTest()
      newStretch {
        clickQ("#alt") { _ in                                          // passive
          later(0.4) {
            badgeText { b in
              r.append(("badge-shows-afk", b.hasPrefix("AFK 2:")))
              k.hoverForTest(true)
              later(0.6) {
                clickQ("#gear") { _ in
                  r.append(("gear-opens", k.mode == .gear && near(k.panel!.frame, k.frameFor(.gear))))
                  clickQ("#gearv .chip[data-k=outline][data-v='0']") { _ in
                    let o1 = k.ui.look.outline == false
                    clickQ("#oc button[data-c='#34D399']") { _ in
                      clickQ("#gearv .chip[data-k=outline][data-v='1']") { _ in
                        clickQ("#tc button[data-c='#FDE68A']") { _ in
                          clickQ("#gearv .chip[data-k=font][data-v=mono]") { _ in
                            clickRange("#gsize", 0.75) {
                              clickRange("#gop", 0.3) {
                                clickRange("#gbr", 0.9) {
                                  clickQ("#gearv .chip[data-k=bold][data-v='3']") { _ in gearB(next, o1) }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    func gearB(_ next: @escaping () -> Void, _ o1: Bool) {
      let L = k.ui.look
      pageJS("(function(){var p=getComputedStyle(document.getElementById('pv')),c=getComputedStyle(document.getElementById('pvc'));return JSON.stringify({b:p.borderTopColor,bg:p.backgroundColor,f:p.filter,c:c.color,ff:c.fontFamily,fs:c.fontSize,sh:p.boxShadow})})()") { pv in
        r.append(("gear-outline", o1 && L.outline && L.outlineColor == "#34D399" && pv.contains("rgb(52, 211, 153)")))
        r.append(("gear-text-colour", L.textColor == "#FDE68A" && pv.contains("rgb(253, 230, 138)")))
        r.append(("gear-font", L.font == "mono" && pv.lowercased().contains("mono")))
        r.append(("gear-size", L.size >= 27 && L.size <= 33 && pv.contains("\"fs\":\"\(L.size)px\"")))
        r.append(("gear-see-through", L.opacity >= 0.3 && L.opacity <= 0.5 && pv.contains("\(L.opacity)")))
        r.append(("gear-brightness", L.brightness >= 1.24 && L.brightness <= 1.4 && pv.contains("brightness(\(L.brightness))")))
        r.append(("gear-obvious", L.bold == 3 && pv.contains("20px")))
        print("AFK GEAR: \(L) preview=\(pv)")
        snap(k.web!, "\(dir)/afk-gear.png") {
          k.reloadForTest()                                             // a restart: the look is read back from disk
          later(1.0) {
            r.append(("gear-persists", k.ui.look == L && k.mode == .mini))
            snap(k.web!, "\(dir)/afk-mini-custom.png") { dragA(next) }
          }
        }
      }
    }
    // Dragging: four spots, snapping, remembered after a restart; a drag that starts on a button never presses it.
    func dragA(_ next: @escaping () -> Void) {
      let v = vf
      let spots: [(String, NSPoint, (NSRect) -> Bool)] = [
        ("top-right", NSPoint(x: v.maxX - 20, y: v.maxY - 20), { f in abs(f.maxX - (v.maxX - 4)) < 2 && abs(f.maxY - v.maxY) < 2 }),
        ("bottom-left", NSPoint(x: v.minX + 15, y: v.minY + 15), { f in abs(f.minX - (v.minX + 4)) < 2 && abs(f.minY - (v.minY + 4)) < 2 }),
        ("right-edge", NSPoint(x: v.maxX - 30, y: v.midY), { f in abs(f.maxX - (v.maxX - 4)) < 2 && abs(f.midY - v.midY) < 3 }),
        ("middle", NSPoint(x: v.midX, y: v.midY), { f in abs(f.midX - v.midX) < 3 && abs(f.midY - v.midY) < 3 }),
      ]
      var clicks = 0
      func one(_ i: Int) {
        guard i < spots.count else {
          let f0 = k.frameFor(.mini)
          k.reloadForTest()
          later(1.0) {
            let f1 = k.frameFor(.mini)
            r.append(("drag-persists", abs(f1.minX - f0.minX) < 1 && abs(f1.minY - f0.minY) < 1 && k.mode == .mini))
            r.append(("drag-never-clicks", clicks == 0 && k.showing))
            invisibleA(next)
          }
          return
        }
        let (name, target, ok) = spots[i]
        k.hoverForTest(true)
        later(0.6) {
          let before = k.pendingCount
          dragFrom(i == 0 ? "#btn" : "#title", to: target) {
            if !k.showing || k.pendingCount != before { clicks += 1 }
            let f = k.frameFor(.mini)
            r.append(("drag-\(name)", ok(f) && !k.isDragging && k.mode == .mini && near(k.panel!.frame, f)))
            if !ok(f) { print("AFK DRAG: \(name) frame=\(f) screen=\(v) mode=\(k.mode.rawValue)") }
            k.hoverForTest(false)
            later(0.7) { one(i + 1) }
          }
        }
      }
      one(0)
    }
    // Invisible: hidden in place, the pointer on its spot brings it back, leaving hides it again; it keeps counting.
    func invisibleA(_ next: @escaping () -> Void) {
      k.hoverForTest(true)
      later(0.6) {
        clickQ("#inv") { _ in
          let inv = k.ui.invisible
          k.hoverForTest(false)
          later(0.8) {
            r.append(("invisible-hides", inv && k.mode == .mini && k.targetAlpha == 0 && k.showing))
            let f = k.frameFor(.mini)
            k.pointerNow = { NSPoint(x: f.midX + ScreenGuard.parkX, y: f.midY) }   // the pointer moves onto its spot (the pointer check, no hover event)
            later(0.6) {
              r.append(("invisible-hover-reveals", k.mode == .pop && k.targetAlpha == 1))
              snap(k.web!, "\(dir)/afk-pop-invisible.png") {
                k.pointerNow = { NSPoint(x: -1_000_000, y: -1_000_000) }
                later(0.9) {
                  badgeText { b in
                    r.append(("invisible-leave-hides", k.mode == .mini && k.targetAlpha == 0 && abs(k.frameFor(.mini).minX - f.minX) < 1))
                    r.append(("invisible-keeps-counting", k.showing && b.hasPrefix("AFK ")))
                    k.hoverForTest(true)
                    later(0.6) { clickQ("#inv") { _ in k.hoverForTest(false); later(0.7) { notesA(next) } } }   // visible again
                  }
                }
              }
            }
          }
        }
      }
    }
    // The notes card keeps clear of the stopwatch wherever it is; the badge brings back the full card; Reset.
    func notesA(_ next: @escaping () -> Void) {
      let v = vf
      k.hoverForTest(true)
      later(0.6) {
      dragFrom("#title", to: NSPoint(x: v.minX + 160, y: v.maxY - 30)) {
        NotesCard.shared.show(["id": "nc:afkmore", "tone": "notes", "title": "Fictional call", "blur": false, "snooze": [5, 10],
                               "items": [["id": "m1", "text": "First thing"], ["id": "m2", "text": "Second thing"]]])
        later(1.0) {
          let nf = NotesCard.shared.panel?.frame ?? .zero, af = k.panel?.frame ?? .zero
          r.append(("notes-moves-aside-of-dragged-stopwatch", NotesCard.shared.panel?.isVisible == true && !nf.intersects(af)))
          k.hoverForTest(true)
          later(0.7) {
            let nf2 = NotesCard.shared.panel?.frame ?? .zero, af2 = k.panel?.frame ?? .zero
            r.append(("notes-clear-of-open-popup", k.mode == .pop && !nf2.intersects(af2)))
            NotesCard.shared.hide("nc:afkmore")
            k.hoverForTest(false)
            later(0.7) {
              snapBadge {
                clickBadge {
                  r.append(("badge-click-restores-full-card", k.mode == .full && k.cardVisible && k.showing && k.stretch?.passive == nil))
                  clickQ("#gear") { _ in
                    clickQ("#greset") { _ in
                      r.append(("gear-reset", k.ui.look == Afk.Look() && !k.ui.invisible))
                      clickQ("#gdone") { _ in
                        idle(0.2)
                        clickBack {
                          print("AFK MORE: wheel=\(wheelWay) badge-click=\(badgeWay.joined(separator: ","))")
                          k.resetUIForTest()
                          next()
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    }

    later(2) {                                                         // the card's page has loaded
    idle(30); k.tickForTest()
    r.append(("not-before-threshold", !k.showing))
    idle(121); k.tickForTest()
    later(1.5) {
      js(read) { v in
        let s = String(describing: v ?? "")
        r.append(("shows-at-threshold", k.showing && s.contains("AFK for 2:00 minutes") && (s.contains("2:02") || s.contains("2:03"))))
        snap(k.web!, "\(dir)/afk-away.png") {
          later(2) {
            js(read) { v2 in
              let s2 = String(describing: v2 ?? "")
              r.append(("counts-up", (secs(s2) ?? 0) > (secs(s) ?? 999_999) && matchesStart(s2) && !s2.contains("\"back\":true")))
              idle(0.4); k.tickForTest()                                   // he is back at the Mac: noted, the clock keeps running
              later(1.2) {
                js(read) { v3 in
                  let s3 = String(describing: v3 ?? "")
                  r.append(("back-at-the-mac-noted", k.stretch?.back != nil && s3.contains("back at your Mac") && s3.contains("\"back\":true")))
                  snap(k.web!, "\(dir)/afk-back.png") {
                    idle(0.1); k.tickForTest(); idle(0.2); k.tickForTest()  // more typing and mouse: it stays and keeps counting
                    later(1.5) {
                      js(read) { v3b in
                      r.append(("input-never-dismisses", k.showing))
                      r.append(("keeps-counting-through-input", (secs(String(describing: v3b ?? "")) ?? 0) > (secs(s3) ?? 999_999) && matchesStart(String(describing: v3b ?? ""))))
                      k.reloadForTest()                                       // a restart: read back from disk
                      later(1) {
                        js(read) { v3c in
                        r.append(("survives-restart", k.showing && k.stretch?.back != nil && matchesStart(String(describing: v3c ?? ""))))
                        later(1.5) {
                        let beforeClick = Date()
                        clickBack {
                          r.append(("click-dismisses", !k.showing))
                          k.sync {
                            let saved = got.last ?? ""
                            // s: last input before, r: first input after, e: the click. It ran past the input up to the click.
                            let row = ((try? JSONSerialization.jsonObject(with: Data(saved.utf8))) as? [String: Any])
                              .flatMap { ($0["list"] as? [[String: Int]])?.last } ?? [:]
                            let (s0, r0, e0) = (row["s"] ?? 0, row["r"] ?? 0, row["e"] ?? 0)
                            r.append(("stretch-goes-to-the-vault", saved.contains("afkDone") && s0 > 0 && r0 > s0 && e0 > r0 + 3
                                                                    && abs(Double(e0) - beforeClick.timeIntervalSince1970) < 3))
                            // Exempt app, 1Password or Signal, a video: never starts.
                            var p2 = p; p2.exempt = ["com.example.game"]; k.setPrefsForTest(p2)
                            front = "com.example.game"; idle(600); k.tickForTest()
                            r.append(("exempt-app-never-starts", !k.showing && k.stretch == nil))
                            // V1.58: the per account rules (BuildRules.swift) only open the Tab list and show the
                            // island over them; the AFK timer never starts there on either account (no time kept).
                            let wasAccount = BuildRules.testAccount
                            for (who, red) in [("red", true), ("public", false)] {
                              BuildRules.testAccount = red
                              front = "org.whispersystems.signal-desktop"; k.tickForTest()
                              r.append(("\(who):protected-app-never-starts", !k.showing && k.stretch == nil))
                              front = "com.agilebits.onepassword7"; k.tickForTest()
                              r.append(("\(who):onepassword-never-starts", !k.showing && k.stretch == nil))
                            }
                            BuildRules.testAccount = wasAccount
                            front = "com.example.editor"; p2.video = true; k.setPrefsForTest(p2); video = true; k.tickForTest()
                            r.append(("video-switch-holds-it", !k.showing && k.stretch == nil))
                            k.handle(["exempt": ["com.example.game", "org.whispersystems.signal-desktop"]])
                            k.sync {
                              let listed = (k.settingsJSON()["exempt"] as? [[String: String]] ?? []).map { $0["id"] ?? "" }
                              r.append(("protected-never-listed", listed.contains("com.example.game") && !listed.contains { Protected.matches($0) }))
                              // Sleep: away an hour across it; the first input after waking shows the whole time.
                              k.setPrefsForTest(p); video = false; idle(3); k.tickForTest()
                              k.setLastActiveForTest(Date().addingTimeInterval(-3600))
                              k.gap(); idle(1); k.tickForTest()
                              later(1.2) {
                                js(read) { v4 in
                                  let s4 = String(describing: v4 ?? "")
                                  r.append(("sleep-keeps-true-time", k.showing && (s4.contains("59:5") || s4.contains("1:00:0"))))
                                  snap(k.web!, "\(dir)/afk-sleep.png") {
                                    clickBack { passiveCheck { clickCheck { moreCheck {
                                      print("AFK CHECK:", r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "),
                                            "key=\(k.panel?.isKeyWindow ?? false)", "activePS=\(NSApp.isActive)")
                                      (k.idleNow, k.frontNow, k.videoNow, k.deliver) = keep
                                      k.pointerNow = { NSEvent.mouseLocation }; k.buttonsNow = { NSEvent.pressedMouseButtons }
                                      var off = p; off.on = false; k.setPrefsForTest(off)
                                      done()
                                    } } } }
                                    }
                                  }
                                }
                              }
                            }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

