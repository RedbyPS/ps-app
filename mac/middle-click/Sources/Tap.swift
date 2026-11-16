import Cocoa
import Carbon   // IsSecureEventInputEnabled

// The mouse tap: sees left button presses and trackpad pressure, asks ClickMachine what to do,
// and does it. Each tap runs on its own thread with its own run loop and never waits on the main
// thread, so a busy or stuck app can never hold up a click on the Mac.
//
// Kept fast (16 Nov 2026, after macOS paused the tap for a slow answer on 14 Nov): the click
// callback only reads event fields, the window cache and a lock that nobody holds across a call
// into macOS. Events are built under the lock but posted on their own queue, in order; the real
// button state is asked with the lock let go; the pressure tap (AppKit conversion) has its own
// thread, so it can never hold a click up behind it.
//
// Safety (the developer's rules):
// - 1Password or Signal in front: the tap is switched off (macOS hands it nothing).
// - Main thread silent for over 1.5 s: every event passes straight through until it is back.
// - macOS switched the tap off (too slow, or secure input such as a password field): it is
//   switched back on at once, and a click held at that moment is given back as the real button
//   now is (still down: the down; already up: a whole click), so nothing is lost or left stuck.
//   Then both taps are torn down and made again (1 Nov 2026: a switched-back-on pressure tap can
//   go on delivering nothing). Also when browser clicks stop carrying any pressure (TapHealth).
//   During secure input they are only switched back on, and made again once it ends
//   (SecureInputPause in Recovery.swift: new taps made during secure input get paused at once).
// - The taps cannot be made for 30 s in a row, or macOS times them out again and again: a fresh
//   copy of the app starts and this one quits (TapRecovery in Recovery.swift).
//
// Where the pressure comes from (fixed 30 Oct 2026): on macOS 27 a tap never gets Quartz type 34.
// Force Touch pressure arrives as gesture events (Quartz type 29) that AppKit turns into
// NSEvent .pressure. So type 29 is tapped and each one is converted with NSEvent(cgEvent:).
//
// Only browser windows (31 Oct 2026): a press is held back only when the window under the pointer
// is a browser window at the normal level (Windows.swift). Mission Control, the Dock, Spaces, the
// menu bar and every other app get their clicks straight through, untouched. Mission Control and
// Dock swipes (Quartz 30 to 32) are not tapped at all.

final class Tap {
  static let shared = Tap()

  /// Marks events PSMiddleClicker posts, so it lets them through when they come back.
  private let MAGIC: Int64 = 0x4D49_4443   // "MIDC"
  private let mu = NSLock()
  private var m = ClickMachine()
  private var held: CGEvent?
  private var holdGen = 0
  private let holdQ = DispatchQueue(label: "psmiddleclicker.hold", qos: .userInteractive)
  /// Posts what the click logic asks for, in the order it asked, with no lock held.
  private let postQ = DispatchQueue(label: "psmiddleclicker.post", qos: .userInteractive)
  private(set) var tap: CFMachPort?
  private var pressureTap: CFMachPort?
  private var loops: [CFRunLoop] = []
  private var health = TapHealth()
  // Main thread only.
  private var recovery = TapRecovery()
  private var securePause = SecureInputPause()
  /// Main thread: called when a fresh copy of the app should start (main.swift does it).
  var onRelaunch: ((String) -> Void)?
  /// Main thread: the wall time of the last fresh start (any copy), nil if none.
  var lastRelaunch: () -> Double? = { nil }

  // Kept up to date on main, read by the tap thread under the lock.
  private var beat = ProcessInfo.processInfo.systemUptime
  private var stalled = false
  private var enabled = true
  private var protectedFront = false
  private var selfFront = false
  private var sawPressure = false
  private var press = PressLog()

  private var shouldRun: Bool { enabled && !protectedFront }
  var installed: Bool { tap != nil }

  // MARK: Main thread

  /// The main thread says it is alive (every 0.4 s).
  func heartbeat() {
    mu.lock()
    beat = ProcessInfo.processInfo.systemUptime
    let was = stalled; stalled = false
    mu.unlock()
    if was { Log.write("main thread back, handling clicks again") }
  }
  func setFirmness(_ f: Firmness) { mu.lock(); m.firmness = f; mu.unlock() }
  func setEnabled(_ on: Bool) { mu.lock(); enabled = on; mu.unlock(); stepAside(); applyEnabled() }
  /// Golden rule: with 1Password or Signal in front the tap is off, macOS hands it nothing.
  func setProtectedFront(_ p: Bool) { mu.lock(); protectedFront = p; mu.unlock(); stepAside(); applyEnabled() }
  /// At quit: waits until every event already asked for has been posted.
  func drain() { postQ.sync {} }
  /// PSMiddleClicker's own window in front (the test pad): every event goes to it untouched.
  func setSelfFront(_ s: Bool) { mu.lock(); selfFront = s; mu.unlock() }

  private func applyEnabled() {
    mu.lock(); let run = shouldRun, ts = taps; mu.unlock()
    for t in ts { CGEvent.tapEnable(tap: t, enable: run) }
  }
  private func stepAside() {
    mu.lock(); let run = shouldRun; mu.unlock()
    if !run { flush() }
  }

  /// Both taps, for switching on and off together (read under the lock off main).
  private var taps: [CFMachPort] { [tap, pressureTap].compactMap { $0 } }

  /// Every 2 s: install the taps once allowed, and switch them back on if macOS turned one off
  /// (then make them again, as after a pause notice).
  func check() {
    if securePause.check(secure: IsSecureEventInputEnabled()) {
      Log.write("secure input ended, making the taps again")
      rebuild("after secure input")
      return
    }
    if tap == nil { if AXIsProcessTrusted() { install() }; return }
    mu.lock(); let run = shouldRun, ts = taps; mu.unlock()
    for t in ts where run && !CGEvent.tapIsEnabled(tap: t) {
      CGEvent.tapEnable(tap: t, enable: true)
      if securePause.waiting { continue }   // made again once secure input ends
      Log.write("tap was off, switched back on")
      scheduleRebuild("a tap was found off")
    }
  }

  /// Main thread: macOS paused the taps (the tap thread already switched them back on).
  private func paused(timeout: Bool) {
    if timeout {
      Log.write("macOS paused the tap (timeout: an answer took too long), switched back on")
      let wall = Date().timeIntervalSince1970
      if recovery.timedOut(at: ProcessInfo.processInfo.systemUptime, wall: wall, lastRelaunch: lastRelaunch()) {
        onRelaunch?("macOS timed the tap out \(TapRecovery.timeoutLimit) times within 2 minutes")
        return
      }
      scheduleRebuild("after macOS paused them")
      return
    }
    switch securePause.paused(secure: IsSecureEventInputEnabled()) {
    case .waitForEnd:
      Log.write("macOS paused the taps for secure input (a password field), switched back on; made again once it ends")
    case .alreadyWaiting:
      break
    case .rebuildNow:
      if scheduleRebuild("after macOS paused them") { Log.write("macOS paused the tap (user input), switched back on") }
    }
  }

  /// Any thread: rebuild after a pause, unless one is already coming (TapHealth decides when).
  /// True when this call set one up.
  @discardableResult
  private func scheduleRebuild(_ why: String) -> Bool {
    mu.lock(); let wait = health.paused(at: ProcessInfo.processInfo.systemUptime); mu.unlock()
    if let wait { rebuildLater(wait, why) }
    return wait != nil
  }
  private func rebuildLater(_ wait: Double, _ why: String) {
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.rebuild(why) }
  }

  /// Main thread: tears both taps down and makes them again. Anything held is given back first;
  /// for the moment in between every event passes straight through, untouched.
  private func rebuild(_ why: String) {
    flush()
    mu.lock()
    let old = taps, oldLoops = loops
    tap = nil; pressureTap = nil; loops = []
    health.rebuilt(at: ProcessInfo.processInfo.systemUptime)
    mu.unlock()
    for t in old { CGEvent.tapEnable(tap: t, enable: false); CFMachPortInvalidate(t) }
    for l in oldLoops { CFRunLoopStop(l) }   // the old tap threads end
    Log.write("rebuilding the taps (\(why))")
    if AXIsProcessTrusted() { install() }   // otherwise check() installs them once allowed again
  }

  private func makeTap(_ at: CGEventTapLocation, _ types: [UInt32], listenOnly: Bool) -> CFMachPort? {
    let mask = types.reduce(UInt64(0)) { $0 | 1 << UInt64($1) }
    return CGEvent.tapCreate(tap: at, place: .headInsertEventTap, options: listenOnly ? .listenOnly : .defaultTap,
                             eventsOfInterest: CGEventMask(mask), callback: { proxy, type, event, ref in
      Unmanaged<Tap>.fromOpaque(ref!).takeUnretainedValue().handle(type, event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque())
  }

  /// Two taps, each on its own thread (16 Nov 2026; one shared thread before), feeding the same
  /// click logic (31 Oct 2026):
  /// - Clicks: an active tap at the annotated session level. macOS has worked out which window
  ///   each click goes to by there, so the click carries the window under the pointer (at plain
  ///   session level that field is 0, measured on the developer's Mac). Its callback only reads that field
  ///   and looks the number up: no AppKit, no WindowServer calls.
  /// - Pressure: a LISTEN-ONLY tap at the session level. macOS never waits on a listen-only tap,
  ///   so it cannot hold up a single gesture: swipes, Spaces and Mission Control flow past it
  ///   untouched. (the developer's Mission Control froze on 31 Oct with an active tap on gestures that ran
  ///   an AppKit conversion on every gesture event.) It only looks at pressure while a browser
  ///   click is being held; the rest of the time it returns at once.
  /// Never 30 to 32: Mission Control, Dock and Spaces swipes travel there and are not tapped.
  func install() {
    guard tap == nil else { return }
    let clicks = makeTap(.cgAnnotatedSessionEventTap, [1, 2, 6,       // left down, up, dragged
                                                       25, 26, 27],   // middle: ours coming back
                         listenOnly: false)
    let pressure = makeTap(.cgSessionEventTap, [29,        // gestures: Force Touch pressure arrives here
                                                33, 34],   // Quick Look and pressure, should macOS ever send them as such
                           listenOnly: true)
    guard let clicks, let pressure else {
      for t in [clicks, pressure].compactMap({ $0 }) { CFMachPortInvalidate(t) }
      couldNotMake(clicks: clicks != nil, pressure: pressure != nil)
      return
    }
    mu.lock(); tap = clicks; pressureTap = pressure; mu.unlock()
    // One thread each: the pressure tap's AppKit conversion can never hold a click up behind it.
    run(clicks, "PSMiddleClicker clicks")
    run(pressure, "PSMiddleClicker pressure")
    applyEnabled()
    Log.write("taps installed (clicks: active, annotated session level; pressure: listen only, session level)")
    if let secs = recovery.installed(at: ProcessInfo.processInfo.systemUptime) {
      Log.write("the taps are back after \(Int(secs)) s of failing")
    }
  }

  private func run(_ port: CFMachPort, _ name: String) {
    let src = CFMachPortCreateRunLoopSource(nil, port, 0)
    let t = Thread { [weak self] in
      guard let self, let rl = CFRunLoopGetCurrent() else { return }
      self.mu.lock()
      let current = self.tap === port || self.pressureTap === port   // not already torn down again
      if current { self.loops.append(rl) }
      self.mu.unlock()
      if current, let src { CFRunLoopAddSource(rl, src, .commonModes) }   // an invalid one is not added
      CFRunLoopRun()   // returns when stopped, or with no sources left
    }
    t.name = name
    t.qualityOfService = .userInteractive
    t.start()
  }

  /// Main thread: the taps could not be made. One line, then one every 5 minutes; after 30 s in a
  /// row (screen unlocked) a fresh copy of the app starts (TapRecovery).
  private func couldNotMake(clicks: Bool, pressure: Bool) {
    let now = ProcessInfo.processInfo.systemUptime
    switch recovery.failed(at: now, wall: Date().timeIntervalSince1970, lastRelaunch: lastRelaunch(), locked: Tap.screenLocked) {
    case .none: break
    case .logFirst:
      Log.write("could not create the mouse taps (clicks \(clicks ? "made" : "failed"), pressure \(pressure ? "made" : "failed"), "
        + "trusted=\(AXIsProcessTrusted()), listen=\(CGPreflightListenEventAccess()), post=\(CGPreflightPostEventAccess()), "
        + "screen locked=\(Tap.screenLocked)), trying again every 2 s, a fresh start after \(Int(TapRecovery.giveUpAfter)) s")
    case .logStill(let s):
      Log.write("still cannot create the mouse taps (\(s) s now, screen locked=\(Tap.screenLocked))")
    case .relaunch:
      onRelaunch?("could not create the mouse taps for \(Int(TapRecovery.giveUpAfter)) s")
    }
  }

  /// Main thread: the fresh copy could not be opened, this one keeps trying.
  func relaunchFailed() { recovery.relaunchFailed() }

  /// Screen locked, or this login is not the one on screen (then macOS may refuse new taps).
  static var screenLocked: Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if (d[kCGSessionOnConsoleKey as String] as? Bool) == false { return true }
    return (d["CGSSessionScreenIsLocked"] as? Bool) == true
  }

  // MARK: Tap thread

  private func handle(_ type: CGEventType, _ e: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      mu.lock(); let state = m.state; mu.unlock()
      flush()
      if state != .idle { Log.write("tap paused mid press (\(state)), click given back") }
      mu.lock(); let run = shouldRun, ts = taps; mu.unlock()
      if run { for t in ts { CGEvent.tapEnable(tap: t, enable: true) } }
      let timeout = type == .tapDisabledByTimeout
      DispatchQueue.main.async { self.paused(timeout: timeout) }   // what next is decided on main
      return Unmanaged.passUnretained(e)
    }
    let raw = type.rawValue
    if raw == 29 || raw == 33 || raw == 34 { pressure(type, e); return Unmanaged.passUnretained(e) }
    let now = ProcessInfo.processInfo.systemUptime
    let own = e.getIntegerValueField(.eventSourceUserData) == MAGIC
    // Click path: reads event fields and the window cache only (no AppKit, no WindowServer calls).
    let input = own ? nil : input(type, e)
    mu.lock()

    if own {
      _ = m.handle(.ownEvent, at: now)
      mu.unlock()
      return Unmanaged.passUnretained(e)
    }
    if !shouldRun || selfFront || now - beat > 1.5 {
      let busy = m.state != .idle || m.inFlight > 0
      if now - beat > 1.5 && !stalled { stalled = true; Log.write("main thread silent for over 1.5 s, every click passes straight through") }
      mu.unlock()
      if busy { flush() }   // asks the real button state with the lock let go
      return Unmanaged.passUnretained(e)
    }
    defer { mu.unlock() }

    guard let input else { return Unmanaged.passUnretained(e) }
    let before = m.state
    let v = m.handle(input, at: now)
    if let n = press.note(input, quartz: type.rawValue, before: before, after: m.state, at: now),
       health.pressEnded(pressures: n, at: now) {
      Log.write("\(TapHealth.dryLimit) browser clicks in a row had no pressure at all, the pressure tap looks deaf")
      rebuildLater(0, "pressure went quiet")
    }
    if case .leftDown = input, m.state == .holding {
      held = e.copy()
      holdGen += 1
      let gen = holdGen
      holdQ.asyncAfter(deadline: .now() + m.holdLimit + 0.01) { [weak self] in self?.holdTimer(gen) }
    }
    switch v {
    case .pass: return Unmanaged.passUnretained(e)
    case .drop: return nil
    case .post(let outs):
      post(outs, e)
      return nil
    }
  }

  /// The listen-only pressure tap (its return value is ignored by macOS). Near zero cost unless a
  /// browser click is being held right now: only then is the event converted and looked at.
  private func pressure(_ type: CGEventType, _ e: CGEvent) {
    let now = ProcessInfo.processInfo.systemUptime
    mu.lock()
    let want = shouldRun && !selfFront && now - beat <= 1.5 && m.wantsPressure
    mu.unlock()
    guard want, let input = input(type, e) else { return }
    mu.lock(); defer { mu.unlock() }
    guard m.wantsPressure else { return }   // the press ended while converting
    let before = m.state
    let v = m.handle(input, at: now)
    press.note(input, quartz: type.rawValue, before: before, after: m.state, at: now)
    // A drop cannot be done from here (listen only), and is not needed: the app never got the
    // left down, so it starts no Look Up from these. Only what to post matters.
    if case .post(let outs) = v { post(outs, nil) }
  }

  private func holdTimer(_ gen: Int) {
    mu.lock(); defer { mu.unlock() }
    guard gen == holdGen else { return }
    if case .post(let outs) = m.handle(.tick, at: ProcessInfo.processInfo.systemUptime) { post(outs, nil) }
  }

  private var lastSystemLog = 0.0
  private var diagLeft = 12
  /// Whether this press may become a middle click: only over a known browser window.
  private func holdable(_ e: CGEvent) -> Bool {
    let id = CGWindowID(truncatingIfNeeded: e.getIntegerValueField(.mouseEventWindowUnderMousePointer))
    let kind = id == 0 ? nil : Windows.shared.kind(id)
    if diagLeft > 0 {   // the first clicks after a start: the raw window fields, to check the tap level
      diagLeft -= 1
      let can = e.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
      Log.write("check: window under pointer \(id), can handle \(can), kind \(kind.map { "\($0)" } ?? "unknown")")
    }
    if kind == nil { Windows.shared.refresh() }
    switch kind {
    case .browser: return true
    case .systemUI(let layer): noteSystem("system UI under the pointer (window level \(layer))"); return false
    case nil: noteSystem(id == 0 ? "no window under the pointer" : "a window not known yet"); return false
    case .other: return false
    }
  }
  /// One log line at most every 2 s, so Mission Control clicks show up without flooding the log.
  private func noteSystem(_ why: String) {
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastSystemLog < 2 { return }
    lastSystemLog = now
    Log.write("click passed straight through: \(why)")
  }

  /// Steps aside (lock NOT held). Asks the real button state only when a press is in progress, so
  /// the usual case (nothing held) costs nothing; and asks it with the lock let go, so a slow
  /// answer from macOS can never keep the click tap waiting on the lock.
  private func flush() {
    mu.lock(); let busy = m.state != .idle || m.inFlight > 0; mu.unlock()
    guard busy else { return }
    let down = Tap.leftIsDown
    mu.lock(); defer { mu.unlock() }
    guard m.state != .idle || m.inFlight > 0 else { return }
    post(m.flush(buttonDown: down), nil)
  }

  /// True while the left button (or trackpad click) is physically down right now.
  static var leftIsDown: Bool { CGEventSource.buttonState(.hidSystemState, button: .left) }

  private func input(_ type: CGEventType, _ e: CGEvent) -> ClickMachine.Input? {
    let p = e.location
    switch type.rawValue {
    case CGEventType.leftMouseDown.rawValue: return .leftDown(x: p.x, y: p.y, holdable: holdable(e))
    case CGEventType.leftMouseDragged.rawValue: return .leftDragged(x: p.x, y: p.y)
    case CGEventType.leftMouseUp.rawValue: return .leftUp
    case 29, 33, 34:
      // Gesture carriers: only Force Touch pressure and Look Up matter, all else passes untouched.
      guard let ns = NSEvent(cgEvent: e) else { return nil }
      switch ns.type {
      case .pressure:
        if !sawPressure { sawPressure = true; Log.write("first Force Touch pressure event seen (Quartz type \(type.rawValue))") }
        return .pressure(stage: ns.stage, pressure: Double(ns.pressure), transition: Double(ns.stageTransition))
      case .quickLook:
        return .quickLook
      default:
        return nil
      }
    default: return nil   // a real middle button from a mouse: untouched
    }
  }

  /// Builds an event to send. current: the event as it came in, used as the base where needed.
  private func make(_ o: ClickMachine.Out, from current: CGEvent?) -> CGEvent? {
    switch o {
    case .current:
      return current?.copy()
    case .held:
      return held?.copy()
    case .heldUp:
      guard let ev = held?.copy() else { return nil }
      ev.type = .leftMouseUp
      return ev
    case .middleDown:
      let at = held?.location ?? current?.location ?? CGEvent(source: nil)?.location ?? .zero
      guard let ev = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: at, mouseButton: .center) else { return nil }
      if let held { ev.flags = held.flags }
      ev.setIntegerValueField(.mouseEventClickState, value: 1)
      return ev
    case .middleDrag, .middleUp:
      guard let ev = current?.copy() else { return nil }
      toMiddle(ev, up: o == .middleUp)
      return ev
    case .middleUpSynth:
      let at = CGEvent(source: nil)?.location ?? .zero
      let ev = CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp, mouseCursorPosition: at, mouseButton: .center)
      ev?.setIntegerValueField(.mouseEventClickState, value: 1)
      return ev
    }
  }

  private func toMiddle(_ ev: CGEvent, up: Bool) {
    ev.type = up ? .otherMouseUp : .otherMouseDragged
    ev.setIntegerValueField(.mouseEventButtonNumber, value: 2)
    ev.setIntegerValueField(.mouseEventClickState, value: 1)
  }

  /// Lock held: builds the events now (they read `held`) and hands them to the post queue, which
  /// posts them in order with no lock held. They come back through this tap (tagged) and line up
  /// behind each other.
  private func post(_ outs: [ClickMachine.Out], _ current: CGEvent?) {
    let evs = outs.compactMap { make($0, from: current) }
    guard !evs.isEmpty else { return }
    for ev in evs { ev.setIntegerValueField(.eventSourceUserData, value: MAGIC) }
    postQ.async { for ev in evs { ev.post(tap: .cgSessionEventTap) } }
  }
}

/// The debug log for each press (local file only, no screen content): every pressure stage change,
/// and one line per press saying what it became. This is how a real trackpad test is read back.
struct PressLog {
  private var active = false
  private var start = 0.0
  private var stages: [Int] = []
  private var pressures = 0
  private var carriers: [UInt32: Int] = [:]
  private var lastStage = -1

  /// Returns, when a browser click (held for a firm press) just ended, how many pressure events it had.
  @discardableResult
  mutating func note(_ i: ClickMachine.Input, quartz: UInt32, before: ClickMachine.State, after: ClickMachine.State, at t: Double) -> Int? {
    switch i {
    case .leftDown(_, _, let ok):
      if before == .holding || !ok { break }   // given back, or not a browser window: not logged
      active = true; start = t; stages = []; pressures = 0; carriers = [:]; lastStage = -1
    case .pressure(let st, let p, let tr):
      if active { pressures += 1; carriers[quartz, default: 0] += 1 }
      if st != lastStage {
        lastStage = st
        if active { stages.append(st) }
        Log.write(String(format: "pressure stage %d (pressure %.2f, towards next %.2f)%@", st, p, tr, active ? "" : " outside a press"))
      }
      if before == .holding && after == .middle { Log.write("middle click sent") }
    case .leftUp:
      guard active else { break }
      active = false
      let result: String
      switch before {
      case .holding: result = "normal click"
      case .middle: result = "MIDDLE CLICK"
      case .passthrough: result = "normal (drag or long press)"
      case .idle: result = "untouched"
      }
      let via = carriers.map { "Quartz \($0.key) x\($0.value)" }.sorted().joined(separator: ", ")
      let path = stages.isEmpty ? "none" : stages.map(String.init).joined(separator: ">")
      Log.write(String(format: "press %.0f ms: stages %@, %d pressure events%@, %@", (t - start) * 1000, path, pressures,
                       via.isEmpty ? "" : " (\(via))", result))
      // Drags and long presses stop listening early, so only clicks say whether pressure flows.
      return before == .holding || before == .middle ? pressures : nil
    default:
      break
    }
    return nil
  }
}
