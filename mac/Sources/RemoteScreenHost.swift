import AppKit
import ApplicationServices
import CoreMedia
import ScreenCaptureKit

// Second Computer remote screen, the secondary's side (the M1): its main display captured with ScreenCaptureKit, straight into
// the hardware encoder (RSSender), and the primary's mouse, scroll and keys replayed with CGEvent. Its own pointer's shape goes to
// the primary, which draws it locally (no waiting for a frame to see the pointer move).
//
// 1Password and Signal (Protected.swift, the golden rule), checked on the bundle id only, exactly as the screen recorder does
// (SRProtect in ScreenRecCore.swift):
//  - Their windows are left out of the picture by ScreenCaptureKit itself (excludingApplications): their pixels never reach PS.
//    Nothing else about them is read: no window, title, bounds or name. The filter is renewed when an app launches.
//  - While either is in front, the primary's KEYS are not replayed (the same rule as PS's own keyboard tap); the primary is
//    told only "a protected app is in front", never which. Mouse clicks still go, so another window can be clicked.
//  - Never named in the log.
// Nothing is recorded or saved: frames go from the capture to the encoder to the network and are gone.
// While a session is live, a small sign at the top of the M1's screen says it is being viewed (RSViewingSign).

final class RSHost: NSObject, SCStreamOutput, SCStreamDelegate {
  let link: RSLink
  let sender: RSSender
  private let q: DispatchQueue
  private let captureQ = DispatchQueue(label: "ps.screen.capture", qos: .userInteractive)
  private let inputQ = DispatchQueue(label: "ps.screen.input", qos: .userInteractive)
  private var stream: SCStream?
  private var display: SCDisplay?
  private var launchWatch: NSObjectProtocol?
  private var cursorTimer: Timer?
  private var permTimer: Timer?
  private var lastCursor: Int?
  private var held = Set<UInt16>()      // keys down on the secondary because of the primary
  private var heldButtons: UInt8 = 0
  private var stopped = false
  private var lastState: RSState?
  private let source = CGEventSource(stateID: .hidSystemState)
  /// Settings from the coordinator: widest picture (pixels) and codec.
  var maxWidth = 2560
  var codec: RSCodec = .h264
  /// The listener's UDP port (told to the primary with the screen size).
  var udpPort: UInt16?
  /// Remote commands (lock, restart, shut down) go to the same runner as Second Computer's signed `cmd` (RemoteCommand).
  var runCommand: (_ action: String, _ id: String, _ from: String, _ done: @escaping (Bool, String?) -> Void) -> Void = { _, _, _, d in d(false, "Not set up on this Mac") }
  var log: (String) -> Void = { psLog($0) }
  var onEnd: () -> Void = {}

  init(link: RSLink, q: DispatchQueue) {
    self.link = link; self.q = q; sender = RSSender(link: link)
    super.init()
    sender.log = { [weak self] in self?.log($0) }
    link.onCtl = { [weak self] t, d in self?.ctl(t, d) }   // at once: the link starts right after this, frames may follow
  }

  // MARK: permissions

  static var screenAllowed: Bool { CGPreflightScreenCaptureAccess() }
  static var accessAllowed: Bool { AXIsProcessTrusted() }
  static let screenPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  static let accessPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

  /// Main thread. Sends the state; starts the picture once Screen Recording is allowed (checks again every 2 s until then).
  func start() {
    sendState()
    RSViewingSign.shared.show(by: link.peer.name)
    if !RSHost.screenAllowed {
      log("PS screen: Screen Recording is not allowed for PS on this Mac yet")
      _ = CGRequestScreenCaptureAccess()   // macOS adds PS to the list (asks once in its life)
      askForSettings()
    } else if !RSHost.accessAllowed { askForSettings() }
    if RSHost.screenAllowed { startCapture() }
    permTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      guard let self, !self.stopped else { return }
      self.sendState()
      if self.stream == nil && RSHost.screenAllowed { self.startCapture() }
    }
    cursorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in self?.cursorTick() }
    // A protected app that starts while the M1 is viewed is left out of the picture at once.
    launchWatch = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] n in
      let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      if Protected.matches(app) { self?.refreshFilter() }
    }
  }

  /// Once per PS run (a reconnect must not stack cards).
  private static var asked = false
  /// The plain card on the M1 itself (PS's own non modal panel, never over 1Password or Signal: SecondConfirm's rule).
  private func askForSettings() {
    guard !Protected.front, !RSHost.asked else { return }
    RSHost.asked = true
    let needScreen = !RSHost.screenAllowed
    SecondConfirm.shared.ask("Allow PS in System Settings",
                             "\(link.peer.name) wants to see and control this Mac. Turn PS on under \(needScreen ? "Screen & System Audio Recording" : "Accessibility"), then come back. Nothing is recorded or saved.",
                             "Open System Settings") { yes in
      if yes { NSWorkspace.shared.open(URL(string: needScreen ? RSHost.screenPane : RSHost.accessPane)!) }
    }
  }

  private func sendState() {
    let s = RSState(screen: RSHost.screenAllowed, access: RSHost.accessAllowed, guarded: Protected.front)
    guard s != lastState else { return }
    lastState = s
    link.sendJSON(.state, s)
  }

  // MARK: the picture

  private func startCapture() {
    guard stream == nil, !stopped else { return }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, err in
      DispatchQueue.main.async {
        guard let self, !self.stopped, self.stream == nil else { return }
        guard let content, let d = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
          self.log("PS screen: no display to capture (\(err.map { ($0 as NSError).code } ?? 0))"); return
        }
        self.display = d
        let mode = CGDisplayCopyDisplayMode(d.displayID)
        let px = CGSize(width: mode?.pixelWidth ?? d.width * 2, height: mode?.pixelHeight ?? d.height * 2)
        let (w, h) = RSFit.encodeSize(pixels: px, maxW: self.maxWidth)
        let pts = CGDisplayBounds(d.displayID).size
        guard var info = self.sender.configure(width: w, height: h, points: pts, fps: 60, codec: self.codec) else { return }
        info.fps = 60
        info.udp = self.udpPort.map { Int($0) }
        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        cfg.queueDepth = 4                       // short: a late frame is dropped, never queued
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange   // what the encoder takes, no conversion
        cfg.showsCursor = false                  // the primary draws the pointer itself (RSCursor)
        cfg.capturesAudio = false
        if #available(macOS 14.0, *) { cfg.captureResolution = .best }
        let s = SCStream(filter: self.filter(content, d), configuration: cfg, delegate: self)
        do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.captureQ) } catch { self.log("PS screen: could not take the picture"); return }
        self.stream = s
        s.startCapture { [weak self] e in
          if e != nil { self?.log("PS screen: the capture did not start"); DispatchQueue.main.async { self?.stream = nil } }
          else { self?.log("PS screen: capturing \(w)x\(h)"); self?.link.sendJSON(.screen, info) }
        }
      }
    }
  }

  /// The display without 1Password and Signal (bundle ids only, SRProtect: the screen recorder's exact rule).
  private func filter(_ content: SCShareableContent, _ d: SCDisplay) -> SCContentFilter {
    let out = Set(SRProtect.excludedAppIDs(running: content.applications.map { $0.bundleIdentifier }, chosen: [], own: nil))
    return SCContentFilter(display: d, excludingApplications: content.applications.filter { out.contains($0.bundleIdentifier) }, exceptingWindows: [])
  }

  private func refreshFilter() {
    guard let s = stream, let d = display else { return }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, _ in
      guard let self, let content, !self.stopped else { return }
      s.updateContentFilter(self.filter(content, d)) { _ in }
    }
  }

  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopped, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    // Only whole new frames (ScreenCaptureKit also sends "nothing changed" ones).
    if let a = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let st = a.first?[.status] as? Int,
       st != SCFrameStatus.complete.rawValue { return }
    var cap = RSTime.nowNs
    if let a = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let t = a.first?[.displayTime] as? UInt64 {
      cap = RSTime.ns(fromHost: t)   // when the display showed it (mach time), so the latency counts from the real screen
    }
    sender.frame(pb, pts: CMSampleBufferGetPresentationTimeStamp(sb), captureNs: cap)
  }

  func stream(_ s: SCStream, didStopWithError error: Error) {
    log("PS screen: the capture stopped (\((error as NSError).code))")
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      self.stream = nil
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startCapture() }   // e.g. the display changed
    }
  }

  // MARK: the pointer's shape

  private func cursorTick() {
    guard !stopped, let c = NSCursor.currentSystem, let cg = c.image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
    var h = Hasher()
    h.combine(c.hotSpot.x); h.combine(c.hotSpot.y); h.combine(cg.width); h.combine(cg.height)
    if let d = cg.dataProvider?.data as Data? { h.combine(d) }
    let key = h.finalize()
    guard key != lastCursor else { return }
    lastCursor = key
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let png = rep.representation(using: .png, properties: [:]), png.count < 512 * 1024 else { return }
    var w = RSWriter(capacity: png.count + 16)
    w.f32(Float(c.hotSpot.x)); w.f32(Float(c.hotSpot.y)); w.f32(Float(c.image.size.width)); w.f32(Float(c.image.size.height)); w.bytes(png)
    link.send(.cursor, w.data)
  }

  // MARK: control and input

  private func ctl(_ t: RSCtl, _ d: Data) {
    if sender.handle(t, d) { return }
    switch t {
    case .input: if let i = RSInput.decode(d) { inputQ.async { [weak self] in self?.replay(i) } }
    case .command:
      guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let a = o["action"] as? String, let id = o["id"] as? String, id.count <= 64 else { return }
      // The same allowlist as the signed vault command (SecondIdentity.cmdAction) minus the auto reboot settings. Only the
      // paired primary ever gets this far (the handshake), as the signed command's main Mac only rule wants for sentry.
      guard RemoteScreen.menuActions.contains(a) else { reply(id, false, "Unknown command"); return }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.runCommand(a, id, self.link.peer.name) { ok, why in self.reply(id, ok, why) }
      }
    case .openSettings:
      guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let p = o["pane"] as? String else { return }
      let url = p == "access" ? RSHost.accessPane : p == "screen" ? RSHost.screenPane : nil
      if let url { DispatchQueue.main.async { NSWorkspace.shared.open(URL(string: url)!) } }
    case .bye: link.close("the other Mac ended it")
    default: break
    }
  }

  private func reply(_ id: String, _ ok: Bool, _ why: String?) {
    var o: [String: Any] = ["id": id, "ok": ok]; if let why { o["why"] = why }
    if let d = try? JSONSerialization.data(withJSONObject: o) { link.send(.commandDone, d) }
  }

  private var bounds: CGRect { CGDisplayBounds(display?.displayID ?? CGMainDisplayID()) }

  /// One input event, on its own queue. Never while PS lacks Accessibility (macOS would drop it anyway).
  private func replay(_ i: RSInput) {
    guard !stopped, RSHost.accessAllowed else { return }
    let b = bounds
    func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
    switch i {
    case let .move(x, y, buttons):
      let p = RSFit.toDisplay(x, y, bounds: b)
      let type: CGEventType = buttons & 1 != 0 ? .leftMouseDragged : buttons & 2 != 0 ? .rightMouseDragged : buttons & 4 != 0 ? .otherMouseDragged : .mouseMoved
      let btn: CGMouseButton = buttons & 1 != 0 ? .left : buttons & 2 != 0 ? .right : .center
      post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: btn))
    case let .down(x, y, button, clicks, flags), let .up(x, y, button, clicks, flags):
      var down = false; if case .down = i { down = true }
      let p = RSFit.toDisplay(x, y, bounds: b)
      let type: CGEventType, btn: CGMouseButton
      switch button {
      case 0: type = down ? .leftMouseDown : .leftMouseUp; btn = .left
      case 1: type = down ? .rightMouseDown : .rightMouseUp; btn = .right
      default: type = down ? .otherMouseDown : .otherMouseUp; btn = CGMouseButton(rawValue: UInt32(button)) ?? .center
      }
      let bit: UInt8 = button == 0 ? 1 : button == 1 ? 2 : 4
      if down { heldButtons |= bit } else { heldButtons &= ~bit }
      let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: btn)
      e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
      if button >= 2 { e?.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button)) }
      e?.flags = CGEventFlags(rawValue: RSFlags.clean(flags))
      post(e)
    case let .scroll(x, y, dx, dy, continuous, phase, momentum, flags):
      let e = continuous
        ? CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0)
        : CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: RSScroll.lines(dy), wheel2: RSScroll.lines(dx), wheel3: 0)
      guard let e else { return }
      e.location = RSFit.toDisplay(x, y, bounds: b)
      if continuous {
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        e.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(dy))
        e.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: Double(dx))
        e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(dy))
        e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(dx))
        e.setIntegerValueField(.scrollWheelEventScrollPhase, value: RSScroll.cgPhase(phase))
        e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: RSScroll.cgMomentum(momentum))
      }
      e.flags = CGEventFlags(rawValue: RSFlags.clean(flags))
      post(e)
    case let .key(code, down, flags, repeating):
      // Golden rule: no keys into 1Password or Signal (PS's keyboard tap is off while they are in front, and so is this).
      if Protected.front { if !down { held.remove(code) }; return }
      if down { held.insert(code) } else { held.remove(code) }
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      e?.flags = CGEventFlags(rawValue: RSFlags.clean(flags))
      if repeating { e?.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
      post(e)
    case let .flags(code, flags):
      if Protected.front { return }
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
      e?.type = .flagsChanged
      e?.flags = CGEventFlags(rawValue: RSFlags.clean(flags))
      post(e)
    case .releaseAll: releaseAll()
    }
  }

  /// Every key and button the primary pressed goes up (never a stuck key or a drag that never ends).
  private func releaseAll() {
    for k in held { CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: false)?.post(tap: .cghidEventTap) }
    held = []
    if heldButtons != 0 {
      let p = CGEvent(source: nil)?.location ?? .zero
      if heldButtons & 1 != 0 { CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap) }
      if heldButtons & 2 != 0 { CGEvent(mouseEventSource: source, mouseType: .rightMouseUp, mouseCursorPosition: p, mouseButton: .right)?.post(tap: .cghidEventTap) }
      if heldButtons & 4 != 0 { CGEvent(mouseEventSource: source, mouseType: .otherMouseUp, mouseCursorPosition: p, mouseButton: .center)?.post(tap: .cghidEventTap) }
      heldButtons = 0
    }
    // Modifier keys the primary held: a clean flags event.
    let e = CGEvent(source: source); e?.type = .flagsChanged; e?.flags = []; if RSHost.accessAllowed { e?.post(tap: .cghidEventTap) }
  }

  /// Main thread. The session ended: capture, encoder, timers and the sign go; held keys go up.
  func stop() {
    guard !stopped else { return }
    stopped = true
    permTimer?.invalidate(); cursorTimer?.invalidate()
    if let w = launchWatch { NSWorkspace.shared.notificationCenter.removeObserver(w) }
    stream?.stopCapture { _ in }; stream = nil
    sender.stop()
    inputQ.async { [weak self] in if RSHost.accessAllowed { self?.releaseAll() } }
    RSViewingSign.shared.hide()
    onEnd()
  }
}

/// The small sign at the top of the M1's screen while it is viewed: "<M4's name> is viewing this Mac". Never takes focus, never
/// takes a click (the pointer goes through it), on every Space, small (Mission Control rule: no big invisible window).
final class RSViewingSign {
  static let shared = RSViewingSign()
  private var panel: NSPanel?

  func show(by name: String) {
    DispatchQueue.main.async { [self] in
      hide()
      let safe = String(name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }.prefix(40).map(Character.init))
      let text = "\(safe.isEmpty ? "Your main Mac" : safe) is viewing this Mac"
      let label = NSTextField(labelWithString: text)
      label.font = .systemFont(ofSize: 12, weight: .semibold); label.textColor = .white; label.alignment = .center
      let dot = NSView(frame: .zero); dot.wantsLayer = true; dot.layer?.backgroundColor = NSColor.systemRed.cgColor; dot.layer?.cornerRadius = 4
      let w = label.intrinsicContentSize.width + 44, h: CGFloat = 26
      let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: w, height: h), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true
      p.level = .statusBar; p.ignoresMouseEvents = true; p.hidesOnDeactivate = false
      p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
      let bg = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h)); bg.wantsLayer = true
      bg.layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.88).cgColor; bg.layer?.cornerRadius = h / 2
      dot.frame = NSRect(x: 12, y: (h - 8) / 2, width: 8, height: 8)
      label.frame = NSRect(x: 26, y: (h - 16) / 2, width: w - 34, height: 16)
      bg.addSubview(dot); bg.addSubview(label)
      p.contentView = bg
      if let s = NSScreen.main {
        let top = s.visibleFrame.maxY
        p.setFrameOrigin(NSPoint(x: s.frame.midX - w / 2, y: top - h - 6))
      }
      p.orderFrontRegardless()
      panel = p
    }
  }
  func hide() { panel?.orderOut(nil); panel = nil }
  var showing: Bool { panel != nil }
}
