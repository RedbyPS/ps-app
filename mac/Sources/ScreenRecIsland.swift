import AppKit
import SwiftUI
import Darwin

// Screen recorder, the island side on screen (PS 1.60, pull request 12b). The rules are in ScreenRecIslandCore.swift (tested without
// recording, without windows, without sounds); this file only reads real macOS and draws.
//
// OFF means off: while the person has not said yes (or the feature is off in this build) NO timer in here runs. sync() starts the
// meeting look (every 10 seconds, only while the gate is open, "ask to record meetings" is on and nothing is recording) and the
// performance watch (every 4 seconds, only while a recording runs). Both stop again the moment the gate closes.
//
// Cards (the meeting question, "Resources are high", Saved, the controls) go through Toast.showCard, which already queues every card
// under the island one at a time (IslandColumn, IslandQueue). The recording part (red dot, name, time) is a small black capsule of its
// own beside the island, like the timer bubble (IslandBubble.swift). Private mode: the part is put away, no card is shown and no
// sound plays; held cards come out when it goes off.
//
// Privacy (rule 7): window owners are read only to find Zoom, Teams, FaceTime or a browser's Google Meet window. 1Password and Signal
// are filtered out by name BEFORE anything else about the window is asked, and nothing read here is kept or sent anywhere.
final class ScreenRecIsland {
  static let shared = ScreenRecIsland()
  private(set) var brain: SRIslandBrain?
  private weak var capture: SRRealCapture?
  private var meetTimer: Timer?, perfTimer: Timer?
  private var page: (name: String?, key: String?, privateAsk: Bool, at: Date, attendees: [String])?
  private var memSource: DispatchSourceMemoryPressure?
  private var mem: SRMemory = .normal
  private var cpuPrev: (busy: UInt64, total: UInt64)?
  private var lastState: SRRunState = .off
  private var countTimer: Timer?
  let part = RecPartModel()
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  /// Called once by ScreenRec.start(). Builds the brain and reads nothing from macOS.
  func attach(controller: SRController, capture: SRRealCapture) {
    guard brain == nil else { return }
    self.capture = capture
    let b = SRIslandBrain(controller: controller, queue: SRRealQueue())   // every card goes through the shared island queue (PR 6)
    b.reduceMotion = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    b.privateOn = { PrivateHold.shared.on }
    b.dndMutesSounds = { DND.shared.mutes("sounds") }
    b.adjuster = capture
    b.diskBytesPerHour = {
      let s = controller.settings, scr = ScreenRec.screenInfoNow()
      return SRMath.bytesPerHour(s, screenW: scr.width, screenH: scr.height)
    }
    b.screenH = { ScreenRec.screenInfoNow().height }
    b.emit = { [weak self] card, sound in self?.show(card, sound: sound) }
    b.router.retract = { id in Toast.shared.retractCard(id) }
    Toast.onCardGone = { id in DispatchQueue.main.async { ScreenRecIsland.shared.cardGone(id) } }
    brain = b
    PrivateHold.shared.watch { [weak self] in self?.brain?.privateChanged(); self?.syncPart(); ScreenRecCloud.shared.syncRing() }
  }

  // ----- the recorder or the switches changed -----
  func recorderChanged() {
    guard let b = brain else { return }
    let s = b.controller.snapshot.state
    b.recorderChanged()
    if s == .recording, lastState != .recording, lastState != .paused {
      if let n = SRPrivacy.chime("start", privateOn: PrivateHold.shared.on, soundsOn: b.controller.settings.sounds, dndMutes: DND.shared.mutes("sounds")) { Sfx.shared.play(n, volume: 0.55) }
      part.born = Date()
    }
    lastState = s
    sync()
    syncPart()
    // 12c: the cloud side learns the recorder state (uploads never run during a recording) and picks up a finished file
    let who = page.flatMap { $0.name != nil && $0.name == b.meetingName && Date().timeIntervalSince($0.at) < 600 ? $0.attendees : nil } ?? []
    ScreenRecCloud.shared.recorderChanged(state: s, meeting: b.meetingName, attendees: who)
  }

  /// Starts and stops the two clocks. Nothing runs while the gate is closed.
  func sync() {
    guard let b = brain else { return }
    let on = b.controller.gateOpen
    let looking = on && b.controller.settings.askMeetings && b.controller.snapshot.state == .idle
    if looking, meetTimer == nil {
      let t = Timer(timeInterval: 10, repeats: true) { [weak self] _ in self?.meetingLook() }
      t.tolerance = 3; RunLoop.main.add(t, forMode: .common); meetTimer = t
    } else if !looking { meetTimer?.invalidate(); meetTimer = nil }
    // The sampler runs for every recording: the disk stop never depends on the Performance watch switch. Only the quiet adjust and the
    // question (CPU, heat, memory, frame gaps) are behind the switch, and only then are those read.
    let watching = on && (b.controller.snapshot.state == .recording || b.controller.snapshot.state == .paused)
    if watching, perfTimer == nil {
      if b.controller.settings.perfWatch { startMemory() }
      let t = Timer(timeInterval: SRThresholds.sampleEvery, repeats: true) { [weak self] _ in self?.sample() }
      t.tolerance = 1; RunLoop.main.add(t, forMode: .common); perfTimer = t
    } else if watching, b.controller.settings.perfWatch { startMemory() }
    else if !watching, perfTimer != nil {
      perfTimer?.invalidate(); perfTimer = nil; memSource?.cancel(); memSource = nil; cpuPrev = nil; mem = .normal
    }
    if !on { part.hide(); countTimer?.invalidate(); countTimer = nil; part.count = nil }
    ScreenRecCloud.shared.sync()   // 12c: the cloud queue and its timers follow the same gate
  }

  /// The feature may have been switched off (Settings, From the squad) or the person said No: stop and save a recording, cancel a start and a count in.
  func gateChanged() {
    guard let b = brain else { return }
    b.gateChanged()
    if !b.controller.gateOpen { countTimer?.invalidate(); countTimer = nil; part.count = nil }
    sync(); syncPart()
  }

  // ----- the page says a meeting is on (src/meetwatch.ts) -----
  func pageMeeting(_ m: [String: Any]) {
    guard brain?.controller.gateOpen == true else { return }
    let name = (m["name"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(120)) }
    // 12c: who is on the call (email addresses from the calendar entry), kept only to match the recording to a client afterwards
    let who = ((m["attendees"] as? [String]) ?? []).filter { $0.contains("@") && $0.count < 200 }.prefix(20).map { String($0).lowercased() }
    page = (name, (m["key"] as? String).map { String($0.prefix(120)) }, m["privateAsk"] as? Bool == true, Date(), who)
    if name != nil { meetingLook() }
  }

  // ----- the meeting look -----
  private func meetingLook() {
    guard let b = brain, b.controller.gateOpen, b.controller.settings.askMeetings else { return }
    var f = SRMeetingFacts()
    var pending = false
    if let p = page, Date().timeIntervalSince(p.at) < 90 { f.calendarName = p.name; f.calendarKey = p.key; pending = p.privateAsk }
    // The private mode question comes first: the page says so (privateAsk) from the start of the meeting, and the record question is
    // never asked earlier than that. If it is still on the island or queued, the record question waits too.
    if IslandQueue.shared.isActive("private-ask") || IslandQueue.shared.isWaiting("private-ask") { pending = true }
    if f.calendarName == nil {
      f.appWindows = Self.meetingWindows()
      f.micInUse = !f.appWindows.isEmpty && Mic.inUse   // last known state from the audio queue, never waits on Core Audio
    }
    b.meetingTick(f, privateAskPending: pending)
  }

  /// The meeting apps with a window open. Owner names only; a blocked app is dropped on its name before anything else is asked.
  static func meetingWindows() -> [String] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out = Set<String>()
    for w in list {
      guard let owner = w[kCGWindowOwnerName as String] as? String else { continue }
      if SRMeetingApps.isBlocked(owner: owner) { continue }
      if let app = SRMeetingApps.classify(owner: owner, title: { w[kCGWindowName as String] as? String }) { out.insert(app) }
    }
    return out.sorted()
  }
  // ----- the performance watch's sampler (every few seconds, only while recording) -----
  private func startMemory() {
    guard memSource == nil else { return }
    let src = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
    src.setEventHandler { [weak self, weak src] in
      guard let e = src?.data else { return }
      self?.mem = e.contains(.critical) ? .critical : e.contains(.warning) ? .warning : .normal
    }
    memSource = src
    src.activate()
  }
  private func cpuBusy() -> Double {
    var info = host_cpu_load_info()
    var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) } }
    guard r == KERN_SUCCESS else { return 0 }
    let t = info.cpu_ticks
    let busy = UInt64(t.0) + UInt64(t.1) + UInt64(t.3), total = busy + UInt64(t.2)
    defer { cpuPrev = (busy, total) }
    guard let p = cpuPrev, total > p.total else { return 0 }
    return Double(busy - p.busy) / Double(total - p.total)
  }
  private func sample() {
    guard let b = brain else { return }
    let perf = b.controller.settings.perfWatch
    // The disk read (and the battery read) run off the main thread; the rest is cheap and only read when the watch switch is on.
    let th: SRThermal = { switch ProcessInfo.processInfo.thermalState { case .nominal: return .nominal; case .fair: return .fair; case .serious: return .serious; default: return .critical } }()
    let cpu = perf ? cpuBusy() : 0, memNow = mem, drop = perf ? (capture?.takeDropRatio() ?? 0) : 0
    let low = ProcessInfo.processInfo.isLowPowerModeEnabled
    ScreenRec.shared.freeBytesAsync { [weak self] free in
      guard let self, let b = self.brain else { return }
      let p = perf ? PowerWatch.readNow() : nil
      b.perfTick(SRSample(cpu: cpu, thermal: perf ? th : .nominal, memory: perf ? memNow : .normal, diskFree: free, onBattery: p?.onBattery ?? false, batteryPct: p?.pct, lowPower: perf ? low : false, dropRatio: drop))
    }
  }

  // ----- cards -----
  /// A card's turn has come (the island queue says so): it goes to Toast, with its sound.
  private func show(_ c: SRCard, sound: String?) {
    var d: [String: Any] = ["id": c.id, "title": c.title, "sticky": c.sticky, "actions": c.actions.map { ["id": $0.id, "label": $0.label] }]
    if let s = c.sub { d["sub"] = s }
    if let bd = c.body { d["body"] = bd }
    Toast.shared.showCard(d)
    if let n = sound { Sfx.shared.play(n, volume: 0.55) }
  }
  /// A button on one of our cards (Toast.onAction routes "sr:" ids here). The card is finished in the island queue, except the chip, which re-shows it.
  func cardAction(_ id: String, _ action: String) {
    guard let b = brain else { return }
    let next = b.answer(cardId: id, action: action)
    if next != .reshow { b.router.answered(id) }
    switch next {
    case .countIn(let n): countIn(n)
    case .reveal: ScreenRec.shared.handle(["op": "reveal"])
    case .play: ScreenRec.shared.playLast()
    case .mic: ScreenRec.shared.cycleMic()
    case .stopNow, .reshow, .none: break
    }
  }
  /// A card of ours closed without a button (the x, a timeout, a swipe, Esc): the question is a No, and the island queue moves on.
  func cardGone(_ id: String) { brain?.cardGone(id) }

  /// The short count in (3, 2, 1) on the island part, then the recording starts. Skipped in private mode and with reduced motion (n is 0 then:
  /// the brain asks the system setting, so there is no count in animation at all). A cancel (feature off, No) stops it.
  private func countIn(_ n: Int) {
    guard let b = brain else { return }
    countTimer?.invalidate()
    guard n > 0 else { _ = b.startAfterCountIn(); return }
    var left = n
    part.count = left; syncPart()
    if let s = SRPrivacy.chime("start", privateOn: PrivateHold.shared.on, soundsOn: b.controller.settings.sounds, dndMutes: DND.shared.mutes("sounds")) { Sfx.shared.play(s, volume: 0.4) }
    countTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
      guard let self else { t.invalidate(); return }
      left -= 1
      if !b.countInPending { t.invalidate(); self.part.count = nil; self.syncPart(); return }   // cancelled: nothing starts
      if left <= 0 { t.invalidate(); self.part.count = nil; _ = b.startAfterCountIn(); self.recorderChanged(); return }
      self.part.count = left; self.syncPart()
    }
  }

  /// The island menu's "Start recording" or "Stop recording", only while the gate is open.
  func menuAction() -> (title: String, run: () -> Void)? {
    guard let b = brain, b.controller.gateOpen else { return nil }
    if PrivateHold.shared.on { return nil }   // private mode: not even the menu says that a recording is going on
    if b.controller.snapshot.isRecording { return ("Stop recording", { b.controller.stop() }) }
    guard b.controller.snapshot.state == .idle else { return nil }
    return ("Start recording", { ScreenRec.shared.handle(["op": "start"]) })   // a refusal lands in snapshot.error and shows on the button
  }

  // ----- the recording part -----
  private var tracker = SRPartTracker()
  /// Draws the part beside the island, or puts it away (private mode, not recording, island off).
  func syncPart() {
    guard let b = brain else { return }
    let counting = part.count != nil
    let snap = b.controller.snapshot
    let priv = PrivateHold.shared.on
    var view = tracker.view(snap, now: Date(), privateOn: priv, name: b.meetingName)
    if view == nil && counting && !priv { view = SRPartTracker.Shown(display: SRSnapshot.Display(dot: true, pulsing: false, timer: nil, paused: false), comesBack: false, name: SRWords.countIn) }
    guard b.controller.gateOpen, let v = view, let a = Island.shared.timerAnchor() else { part.hide(); return }
    part.show(v, snapshot: snap, anchor: a, reduceMotion: reduceMotion) { [weak self] in self?.brain?.openControls() }
  }
}

// ---------- the part's window and view ----------
final class RecPartModel: ObservableObject {
  @Published var shown = false
  @Published var name = SRWords.recording
  @Published var paused = false
  @Published var pulsing = true
  @Published var startedAt: Date?
  @Published var pausedAt: Date?
  @Published var pausedTotal: TimeInterval = 0
  @Published var count: Int?
  @Published var width: CGFloat = 150
  var born = Date()
  var tap: () -> Void = {}
  private var win: IslandPanel?
  private var hideWork: DispatchWorkItem?
  static let h: CGFloat = 24, gap: CGFloat = 6, margin: CGFloat = 2

  func show(_ v: SRPartTracker.Shown, snapshot s: SRSnapshot, anchor a: (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow), reduceMotion calm: Bool, tap: @escaping () -> Void) {
    hideWork?.cancel(); hideWork = nil
    self.tap = tap
    name = v.name; paused = v.display.paused; pulsing = v.display.pulsing && !calm
    startedAt = s.startedAt; pausedAt = s.pausedAt; pausedTotal = s.pausedTotal
    let w = Self.measure(v.name, timer: count != nil || s.isRecording ? true : false)
    width = w
    let win = window(level: a.panel.level)
    // beside the island, on the left when there is room (the timer bubble prefers the right), else the right, else below
    let leftRoom = a.shape.minX - Self.gap - (a.screen.minX + 4), rightRoom = a.screen.maxX - 4 - (a.shape.maxX + Self.gap)
    let f: CGRect
    if w <= leftRoom { f = CGRect(x: a.shape.minX - Self.gap - w, y: a.bubbleY, width: w, height: Self.h) }
    else if w <= rightRoom { f = CGRect(x: a.shape.maxX + Self.gap, y: a.bubbleY, width: w, height: Self.h) }
    else { f = CGRect(x: max(a.screen.minX + 4, min(a.shape.maxX - w, a.screen.maxX - 4 - w)), y: a.shape.minY - Self.gap - Self.h, width: w, height: Self.h) }
    let full = f.insetBy(dx: -Self.margin, dy: -Self.margin).integral
    if win.frame != full { win.setFrame(full, display: true) }
    let anim: Animation = calm ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.62)
    if !win.isVisible { shown = false; win.orderFrontRegardless(); DispatchQueue.main.async { [weak self] in withAnimation(anim) { self?.shown = true } } }
    else if !shown { withAnimation(anim) { shown = true } }
  }
  func hide() {
    guard let w = win, w.isVisible, hideWork == nil else { return }
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    withAnimation(calm ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.86)) { shown = false }
    let work = DispatchWorkItem { [weak self] in self?.hideWork = nil; if self?.shown == false { self?.win?.orderOut(nil) } }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32, execute: work)
  }
  /// As wide as its words: the dot, the name (cut at 40 letters) and the time.
  static func measure(_ name: String, timer: Bool) -> CGFloat {
    let f = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
    let t = (name as NSString).size(withAttributes: [.font: f]).width
    return ceil(10 + 8 + 6 + min(t, 150) + (timer ? 6 + 42 : 0) + 12)
  }
  private func window(level: NSWindow.Level) -> IslandPanel {
    if let w = win { if w.level != level { w.level = level }; return w }
    let p = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: 160, height: 28), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = level
    p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false; p.collectionBehavior = IslandPlace.spaces; p.ignoresMouseEvents = false
    p.contentView = IslandHost(rootView: RecPartView(m: self))
    if ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { p.alphaValue = 0 }
    win = p
    return p
  }
}

/// A pulsing red dot, the meeting name and the running time, white on black like the island. Paused: the dot is still and it says Paused.
struct RecPartView: View {
  @ObservedObject var m: RecPartModel
  var body: some View {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    ZStack {
      if m.shown {
        Button(action: { m.tap() }) {
          HStack(spacing: 6) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: calm || !m.pulsing)) { ctx in
              let k = m.pulsing ? 0.55 + 0.45 * (0.5 + 0.5 * sin(ctx.date.timeIntervalSinceReferenceDate * 4)) : 1
              Circle().fill(Color(red: 1, green: 0.27, blue: 0.23).opacity(m.paused ? 0.55 : k)).frame(width: 8, height: 8)
            }
            Text(m.count != nil ? SRWords.countIn : (m.paused ? SRWords.paused : m.name))
              .font(.system(size: 11.5, weight: .semibold)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1).truncationMode(.tail)
            if let c = m.count {
              Text("\(c)").font(.system(size: 12, weight: .heavy)).monospacedDigit().foregroundColor(.white)
            } else if m.startedAt != nil {
              TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let snap = SRSnapshot(state: m.paused ? .paused : .recording, startedAt: m.startedAt, pausedTotal: m.pausedTotal, pausedAt: m.pausedAt)
                Text(SRSnapshot.timerText(snap.elapsed(now: ctx.date))).font(.system(size: 12, weight: .heavy)).monospacedDigit().foregroundColor(.white).fixedSize()
              }
            }
          }
          .padding(.horizontal, 10)
          .frame(width: m.width, height: RecPartModel.h)
          .background(Capsule().fill(Color.black))
          .overlay(Capsule().stroke(Color.white.opacity(0.14), lineWidth: 0.8))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(m.paused ? "Recording paused. Open the controls." : "Recording. Open the controls.")
        .transition(calm ? .opacity : .scale(scale: 0.2, anchor: .trailing).combined(with: .opacity).combined(with: .offset(x: 14)))
      }
    }
    .frame(width: m.width + 2 * RecPartModel.margin, height: RecPartModel.h + 2 * RecPartModel.margin)
    .environment(\.colorScheme, .dark)
  }
}

/// The shared island queue (IslandQueue.swift) as the recorder's cards use it.
final class SRRealQueue: SRQueueAPI {
  func enqueue(id: String, ttl: TimeInterval?, show: @escaping () -> Void, visible: @escaping () -> Bool, close: @escaping () -> Void, dropped: @escaping () -> Void) -> IslandQueueCore.Outcome {
    IslandQueue.shared.enqueue(id: id, kind: "screenrec", priority: .normal, ttl: ttl, show: show, visible: visible, close: close, dropped: dropped)
  }
  func finish(_ id: String) { IslandQueue.shared.finish(id) }
}
