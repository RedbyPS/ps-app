import AppKit
import CoreVideo
import QuartzCore

// Second Computer remote screen, the primary's side (the M4): the other Mac's screen in a PS window, scaled to fit, full screen
// capable, and every mouse, scroll and key event in it sent back. The picture is a decoded IOSurface put straight into a layer
// (no copy, no main thread hop). The pointer is this Mac's own, wearing the other Mac's pointer shape, so it moves with no delay.
//
// Keys: while this window has the keyboard, every key goes to the other Mac, Command shortcuts too (Command Q quits the app over
// there, not PS). Esc goes too; two Escs in a row close the window here (RSEscape: PS's rule that every PS screen closes on Esc,
// without taking Esc away from the other Mac). System shortcuts macOS keeps for itself (Command Tab, Command Space, Mission
// Control) stay on this Mac in part 1; part 2's key tap can take them while the window is full screen (`keyHook`).

final class RSView: NSView {
  let picture = CALayer()
  /// The other Mac's screen in pixels (what the picture is) and points (what the input maps to).
  var info: RSScreenInfo? { didSet { needsLayout = true; rebuildCursor() } }
  /// Input out (to the link). Set by the coordinator.
  var send: (RSInput) -> Void = { _ in }
  /// Part 2 (the hold key, the Tab overlay): sees each key event first; true means it was taken and is not sent.
  var keyHook: ((NSEvent) -> Bool)?
  /// Two Escs in a row: the window closes (or leaves full screen first).
  var onEscapeTwice: () -> Void = {}
  /// Input on or off (part 2's quick look shows the screen without controlling it).
  var inputOn = true
  /// A mouse button went down in the picture (the hold key keeps the screen up when it is clicked while held).
  var onPress: () -> Void = {}
  private var escape = RSEscape()
  private var remoteCursor: NSCursor?
  private var buttons: UInt8 = 0
  private var tracking: NSTrackingArea?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.black.cgColor
    picture.contentsGravity = .resizeAspect
    picture.backgroundColor = NSColor.black.cgColor
    picture.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]   // no fades: every frame at once
    layer?.addSublayer(picture)
  }
  required init?(coder: NSCoder) { nil }

  override var isFlipped: Bool { false }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func layout() {
    super.layout()
    rebuildCursor()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    picture.frame = bounds
    CATransaction.commit()
  }

  /// Shows a decoded picture. Any thread (the link's queue): an explicit transaction, flushed at once.
  func show(_ pb: CVPixelBuffer) {
    guard let s = CVPixelBufferGetIOSurface(pb)?.takeUnretainedValue() else { return }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    picture.contents = s
    CATransaction.commit()
    CATransaction.flush()
  }
  func clear() { CATransaction.begin(); CATransaction.setDisableActions(true); picture.contents = nil; CATransaction.commit() }

  /// Where the picture is inside the view (black bars around it when the shapes differ).
  var pictureRect: CGRect { RSFit.rect(content: CGSize(width: info?.w ?? 16, height: info?.h ?? 10), in: bounds) }

  // MARK: the pointer

  private var cursorSource: (png: Data, hot: CGPoint, size: CGSize)?
  private var cursorScale: CGFloat = 0
  /// The other Mac's pointer shape (from RSCtl.cursor), sized for its points on this view's scale (again on every resize).
  func setCursor(png: Data, hot: CGPoint, size: CGSize) { cursorSource = (png, hot, size); cursorScale = 0; rebuildCursor() }
  private func rebuildCursor() {
    guard let (png, hot, size) = cursorSource, let img = NSImage(data: png) else { return }
    let k = info.map { pictureRect.width / CGFloat(max($0.pw, 1)) } ?? 1
    guard abs(k - cursorScale) > 0.001 else { return }
    cursorScale = k
    let s = NSSize(width: max(4, size.width * k), height: max(4, size.height * k))
    img.size = s
    remoteCursor = NSCursor(image: img, hotSpot: NSPoint(x: hot.x * k, y: hot.y * k))
    window?.invalidateCursorRects(for: self)
  }
  override func resetCursorRects() { if let c = remoteCursor { addCursorRect(pictureRect, cursor: c) } }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self, userInfo: nil)
    addTrackingArea(t); tracking = t
  }
  override func cursorUpdate(with e: NSEvent) { (remoteCursor ?? .arrow).set() }

  // MARK: mouse and scroll

  private func pos(_ e: NSEvent) -> (Float, Float) { RSFit.normalize(convert(e.locationInWindow, from: nil), picture: pictureRect) }
  private func out(_ i: RSInput) { if inputOn && info != nil { send(i) } }

  override func mouseMoved(with e: NSEvent) { let (x, y) = pos(e); out(.move(x: x, y: y, buttons: buttons)) }
  override func mouseDragged(with e: NSEvent) { mouseMoved(with: e) }
  override func rightMouseDragged(with e: NSEvent) { mouseMoved(with: e) }
  override func otherMouseDragged(with e: NSEvent) { mouseMoved(with: e) }
  private func press(_ e: NSEvent, _ b: UInt8, down: Bool) {
    window?.makeFirstResponder(self)
    if down { onPress() }
    let bit: UInt8 = b == 0 ? 1 : b == 1 ? 2 : 4
    if down { buttons |= bit } else { buttons &= ~bit }
    let (x, y) = pos(e), c = UInt8(min(max(e.clickCount, 1), 3)), f = UInt64(e.modifierFlags.rawValue)
    out(down ? .down(x: x, y: y, button: b, clicks: c, flags: f) : .up(x: x, y: y, button: b, clicks: c, flags: f))
  }
  override func mouseDown(with e: NSEvent) { press(e, 0, down: true) }
  override func mouseUp(with e: NSEvent) { press(e, 0, down: false) }
  override func rightMouseDown(with e: NSEvent) { press(e, 1, down: true) }
  override func rightMouseUp(with e: NSEvent) { press(e, 1, down: false) }
  override func otherMouseDown(with e: NSEvent) { press(e, UInt8(min(e.buttonNumber, 31)), down: true) }
  override func otherMouseUp(with e: NSEvent) { press(e, UInt8(min(e.buttonNumber, 31)), down: false) }
  override func scrollWheel(with e: NSEvent) {
    let (x, y) = pos(e)
    out(.scroll(x: x, y: y, dx: Float(e.scrollingDeltaX), dy: Float(e.scrollingDeltaY), continuous: e.hasPreciseScrollingDeltas,
                phase: UInt8(truncatingIfNeeded: e.phase.rawValue), momentum: UInt8(truncatingIfNeeded: e.momentumPhase.rawValue), flags: UInt64(e.modifierFlags.rawValue)))
  }

  // MARK: keys

  override func keyDown(with e: NSEvent) {
    if keyHook?(e) == true { return }
    if e.keyCode == 53 && info == nil { onEscapeTwice(); return }   // no picture yet (looking, connecting, a message): one Esc closes
    if e.keyCode == 53 && !e.isARepeat && escape.press(at: e.timestamp) { send(.key(code: 53, down: false, flags: 0, repeating: false)); onEscapeTwice(); return }
    out(.key(code: e.keyCode, down: true, flags: UInt64(e.modifierFlags.rawValue), repeating: e.isARepeat))
  }
  override func keyUp(with e: NSEvent) {
    if keyHook?(e) == true { return }
    out(.key(code: e.keyCode, down: false, flags: UInt64(e.modifierFlags.rawValue), repeating: false))
  }
  override func flagsChanged(with e: NSEvent) {
    if keyHook?(e) == true { return }
    out(.flags(code: e.keyCode, flags: UInt64(e.modifierFlags.rawValue)))
  }
  /// Command shortcuts go to the other Mac, not to PS's menus (key down here; macOS sends the key up to keyUp).
  override func performKeyEquivalent(with e: NSEvent) -> Bool {
    guard window?.firstResponder === self, e.type == .keyDown else { return super.performKeyEquivalent(with: e) }
    keyDown(with: e)
    return true
  }
  override func resignFirstResponder() -> Bool { releaseAll(); return true }
  func releaseAll() { buttons = 0; if info != nil { send(.releaseAll) } }
}

/// The window: the picture, and a plain message on top whenever there is no picture to show.
final class RSWindowController: NSObject, NSWindowDelegate {
  let view = RSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800))
  private let message = NSTextField(wrappingLabelWithString: "")
  private let button = NSButton(title: "", target: nil, action: nil)
  private let numbers = NSTextField(labelWithString: "")
  private(set) var window: NSWindow?
  private var buttonAction: (() -> Void)?
  /// The window closed (by the person, or two Escs).
  var onClose: () -> Void = {}
  var showsNumbers = false { didSet { numbers.isHidden = !showsNumbers } }
  /// The window got or lost the keyboard (the hold key then puts it away instead of opening it).
  var onKeyChange: () -> Void = {}
  /// The menu (top right, and the same four in the Dock app): lock, sentry, shutdown, restart.
  var onCommand: (String) -> Void = { _ in }
  /// The app icon button (top left): make the Dock app.
  var onDockApp: () -> Void = {}
  /// The link animation while it looks for and connects to the other Mac.
  let link = RSLinkView(frame: NSRect(x: 0, y: 0, width: 420, height: 200))

  var isVisible: Bool { window?.isVisible == true }

  /// PS 1.77: which way the live link goes, under the window's title: "Direct" or "Through the relay" (nil: not connected).
  enum Via { case direct, relay }
  var via: Via? { didSet { window?.subtitle = RSWindowController.words(via) } }
  static func words(_ v: Via?) -> String { v == .relay ? "Through the relay" : v == .direct ? "Direct" : "" }

  private func make() -> NSWindow {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "Second Computer"
    w.isReleasedWhenClosed = false
    w.collectionBehavior = [.fullScreenPrimary]
    w.backgroundColor = .black
    w.contentMinSize = NSSize(width: 480, height: 300)
    w.delegate = self
    let root = NSView(frame: w.contentRect(forFrameRect: w.frame)); root.autoresizingMask = [.width, .height]
    view.frame = root.bounds; view.autoresizingMask = [.width, .height]
    root.addSubview(view)
    message.alignment = .center; message.textColor = .white; message.font = .systemFont(ofSize: 17, weight: .medium)
    message.translatesAutoresizingMaskIntoConstraints = false
    button.bezelStyle = .rounded; button.target = self; button.action = #selector(pressed); button.translatesAutoresizingMaskIntoConstraints = false
    numbers.textColor = NSColor(white: 1, alpha: 0.7); numbers.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular); numbers.isHidden = !showsNumbers
    numbers.translatesAutoresizingMaskIntoConstraints = false
    link.translatesAutoresizingMaskIntoConstraints = false
    for v in [link, message, button, numbers] { root.addSubview(v) }
    NSLayoutConstraint.activate([
      link.centerXAnchor.constraint(equalTo: root.centerXAnchor), link.bottomAnchor.constraint(equalTo: message.topAnchor, constant: 4),
      link.widthAnchor.constraint(equalToConstant: 420), link.heightAnchor.constraint(equalToConstant: 200),
      message.centerXAnchor.constraint(equalTo: root.centerXAnchor), message.centerYAnchor.constraint(equalTo: root.centerYAnchor, constant: 40),
      message.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
      button.centerXAnchor.constraint(equalTo: root.centerXAnchor), button.topAnchor.constraint(equalTo: message.bottomAnchor, constant: 14),
      numbers.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8), numbers.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -6),
    ])
    w.contentView = root
    w.center()
    view.onEscapeTwice = { [weak self] in self?.escape() }
    addTitlebarButtons(w)
    return w
  }

  /// Opens and brings the window forward (only on the person's own action: never by itself, never over 1Password or Signal).
  func show() {
    let w = window ?? make(); window = w
    w.makeKeyAndOrderFront(nil)
    w.makeFirstResponder(view)
    NSApp.activate(ignoringOtherApps: true)
  }
  func hide() { window?.orderOut(nil) }
  func toggleFullScreen() { window?.toggleFullScreen(nil) }
  var isFullScreen: Bool { window?.styleMask.contains(.fullScreen) == true }

  /// The message over the picture (nil: the picture alone), with an optional button. `linking`: the link animation runs
  /// above it (looking for and connecting to the other Mac); a message without it (not found, refused) shows alone.
  func say(_ text: String?, button title: String? = nil, linking: Bool = false, action: (() -> Void)? = nil) {
    _ = window ?? { let w = make(); window = w; return w }()
    message.stringValue = text ?? ""
    message.isHidden = text == nil
    button.title = title ?? ""; button.isHidden = title == nil
    buttonAction = action
    if text != nil { view.clear(); view.info = nil }
    link.isHidden = !linking
    if linking { link.looking() }
  }

  /// The link joined and the first picture is here: the link lights up, then fades away over the picture.
  func linked() {
    guard !link.isHidden else { return }
    link.linked()
    message.isHidden = true; button.isHidden = true
    DispatchQueue.main.asyncAfter(deadline: .now() + (NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.2 : 0.75)) { [weak self] in
      guard let self else { return }
      NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; self.link.animator().alphaValue = 0 }) { self.link.isHidden = true; self.link.alphaValue = 1 }
    }
  }

  // MARK: the title bar: the Dock app button (left) and the menu (right)

  private func addTitlebarButtons(_ w: NSWindow) {
    func button(_ symbol: String, _ tip: String, _ sel: Selector) -> NSButton {
      let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip) ?? NSImage(), target: self, action: sel)
      b.bezelStyle = .texturedRounded; b.isBordered = false; b.toolTip = tip; b.contentTintColor = .secondaryLabelColor
      b.frame = NSRect(x: 0, y: 0, width: 28, height: 22)
      return b
    }
    let dock = NSTitlebarAccessoryViewController()
    dock.view = button("dock.rectangle", "Keep Remote Screen in the Dock", #selector(dockApp))
    dock.layoutAttribute = .left
    w.addTitlebarAccessoryViewController(dock)
    let menu = NSTitlebarAccessoryViewController()
    menu.view = button("ellipsis.circle", "Lock, Sentry mode, Shut down, Restart", #selector(showMenu(_:)))
    menu.layoutAttribute = .right
    w.addTitlebarAccessoryViewController(menu)
  }
  @objc private func dockApp() { onDockApp() }
  @objc private func showMenu(_ sender: NSButton) {
    let m = NSMenu()
    for (title, verb) in RSWindowController.menu {
      let i = NSMenuItem(title: title, action: #selector(pick(_:)), keyEquivalent: ""); i.target = self; i.representedObject = verb; m.addItem(i)
    }
    m.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
  }
  @objc private func pick(_ i: NSMenuItem) { if let v = i.representedObject as? String { onCommand(v) } }
  /// The four, in this order (the Dock app has the same).
  static let menu = [("Lock", "lock"), ("Sentry mode", "sentry"), ("Shut down", "shutdown"), ("Restart", "restart")]
  func setNumbers(_ s: String) { numbers.stringValue = s }

  @objc private func pressed() { buttonAction?() }

  private func escape() { if isFullScreen { toggleFullScreen() } else { window?.performClose(nil) } }

  func windowWillClose(_ n: Notification) { view.releaseAll(); onClose(); onKeyChange() }
  func windowDidResignKey(_ n: Notification) { view.releaseAll(); onKeyChange() }
  func windowDidBecomeKey(_ n: Notification) { onKeyChange() }
}
