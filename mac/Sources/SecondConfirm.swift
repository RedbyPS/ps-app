import AppKit

// Second Computer's questions ("Let your primary Mac run jobs here?", Pair, Trust, Unpair) in a small
// panel of their own (the developer, 1 Nov 2026: on the M1, picking "This is my second Mac" froze everything).
// They used to be an NSAlert run with runModal: an app modal alert sits at the modal panel level, BELOW
// the Tab list (status bar level), so it opened hidden under the list while every PS window refused
// clicks until it was answered. This panel never runs a modal loop (PS keeps working while it is up),
// floats above the Tab list, and the Tab list is put away before it shows (`beforeShow`). One question
// at a time; another waits its turn. Return answers yes, Esc no. A test copy's panel is invisible,
// click-through and far off screen, and never activates PS.
final class SecondConfirmPanel: NSPanel {
  var onKey: ((Bool) -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func cancelOperation(_ sender: Any?) { onKey?(false) }   // Esc
  /// Return (or Enter) answers yes, Esc no, whichever control has the keyboard.
  override func performKeyEquivalent(with e: NSEvent) -> Bool {
    guard e.type == .keyDown, e.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return super.performKeyEquivalent(with: e) }
    switch e.keyCode {
    case 36, 76: onKey?(true); return true
    case 53: onKey?(false); return true
    default: return super.performKeyEquivalent(with: e)
    }
  }
}

/// The first click on Allow or Cancel counts even while PS is not the active app.
final class SecondConfirmButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class SecondConfirm {
  static let shared = SecondConfirm()
  /// Above the Tab list (main.swift's overlay panel sits at .statusBar).
  static let level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
  /// Runs before a question shows: main.swift puts the Tab list away.
  var beforeShow: () -> Void = {}
  /// A test copy or a unit test: invisible, click-through, off screen, never activates PS.
  var test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil

  private struct Ask { let title: String; let text: String; let ok: String; let done: (Bool) -> Void }
  private var queue: [Ask] = []
  private(set) var panel: SecondConfirmPanel?
  private var okButton: NSButton?, cancelButton: NSButton?
  private var current: Ask?

  /// Whether a question is up (tests).
  var showing: Bool { current != nil }
  var showingTitle: String? { current?.title }

  /// Asks; `done` runs once, on the main thread, with the developer's answer. Never blocks.
  func ask(_ title: String, _ text: String, _ ok: String, _ done: @escaping (Bool) -> Void) {
    queue.append(Ask(title: title, text: text, ok: ok, done: done))
    if current == nil { next() }
  }

  /// Tests: the same as clicking a button.
  func press(_ yes: Bool) { (yes ? okButton : cancelButton)?.performClick(nil) }

  private func next() {
    guard current == nil, !queue.isEmpty else { return }
    let a = queue.removeFirst()
    current = a
    beforeShow()
    let p = build(a)
    panel = p
    if test {
      p.alphaValue = 0; p.ignoresMouseEvents = true
      p.setFrameOrigin(NSPoint(x: -60000, y: 0))
      p.orderFrontRegardless()
    } else {
      p.orderFrontRegardless()
      p.makeKey()
      if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }
  }

  private func answer(_ yes: Bool) {
    guard let a = current else { return }
    current = nil
    panel?.onKey = nil
    panel?.orderOut(nil)
    panel = nil; okButton = nil; cancelButton = nil
    a.done(yes)
    // The next question after this run loop turn, so an answer that asks again never nests.
    DispatchQueue.main.async { [weak self] in self?.next() }
  }

  private func build(_ a: Ask) -> SecondConfirmPanel {
    let width: CGFloat = 400
    // A test copy's panel is borderless: macOS pulls a titled window back onto a screen.
    let p = SecondConfirmPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 200), styleMask: test ? [.borderless] : [.titled, .fullSizeContentView], backing: .buffered, defer: false)
    p.title = "Second Computer"
    p.titleVisibility = .hidden
    p.titlebarAppearsTransparent = true
    p.isMovableByWindowBackground = true
    p.level = SecondConfirm.level
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.appearance = NSAppearance(named: .darkAqua)
    p.onKey = { [weak self] yes in self?.answer(yes) }

    let icon = NSImageView(image: NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: nil) ?? NSImage())
    icon.symbolConfiguration = .init(pointSize: 30, weight: .regular)
    icon.contentTintColor = NSColor(red: 0.93, green: 0.31, blue: 0.53, alpha: 1)
    let title = NSTextField(wrappingLabelWithString: a.title)
    title.font = .systemFont(ofSize: 15, weight: .bold)
    title.alignment = .center
    let text = NSTextField(wrappingLabelWithString: a.text)
    text.font = .systemFont(ofSize: 12.5)
    text.textColor = .secondaryLabelColor
    text.alignment = .center
    for f in [title, text] { f.preferredMaxLayoutWidth = width - 48; f.isSelectable = false }

    let ok = SecondConfirmButton(title: a.ok, target: nil, action: nil)
    ok.keyEquivalent = "\r"
    ok.bezelStyle = .rounded
    ok.controlSize = .large
    let cancel = SecondConfirmButton(title: "Cancel", target: nil, action: nil)
    cancel.keyEquivalent = "\u{1b}"
    cancel.bezelStyle = .rounded
    cancel.controlSize = .large
    let hold = Handler { [weak self] yes in self?.answer(yes) }
    ok.target = hold; ok.action = #selector(Handler.yes)
    cancel.target = hold; cancel.action = #selector(Handler.no)
    objc_setAssociatedObject(p, &Handler.key, hold, .OBJC_ASSOCIATION_RETAIN)
    okButton = ok; cancelButton = cancel

    let buttons = NSStackView(views: [cancel, ok])
    buttons.spacing = 10
    buttons.distribution = .fillEqually
    let stack = NSStackView(views: [icon, title, text, buttons])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(18, after: text)
    stack.edgeInsets = NSEdgeInsets(top: 30, left: 24, bottom: 20, right: 24)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let bg = NSVisualEffectView()
    bg.material = .hudWindow; bg.blendingMode = .behindWindow; bg.state = .active
    bg.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor), stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
      stack.topAnchor.constraint(equalTo: bg.topAnchor), stack.bottomAnchor.constraint(equalTo: bg.bottomAnchor),
      buttons.widthAnchor.constraint(equalToConstant: width - 48), stack.widthAnchor.constraint(equalToConstant: width),
    ])
    p.contentView = bg
    bg.layoutSubtreeIfNeeded()
    p.setContentSize(bg.fittingSize)
    // In the middle of the screen with the pointer, a little above centre, like a macOS alert.
    let mouse = NSEvent.mouseLocation
    if !test, let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main {
      let v = s.visibleFrame, f = p.frame
      p.setFrameOrigin(NSPoint(x: (v.midX - f.width / 2).rounded(), y: (v.midY - f.height / 2 + v.height * 0.12).rounded()))
    }
    p.initialFirstResponder = ok
    return p
  }

  // MARK: a notice (V1.26 one click pairing): nothing to answer, it goes by itself

  private var noticePanel: NSPanel?
  private var noticeTimer: Timer?
  /// The last notice's title (tests).
  private(set) var lastNotice: String?

  /// Shows a short line above everything for a few seconds. Never takes focus, never takes clicks, never waits.
  func notice(_ title: String, _ text: String, seconds: Double = 6) {
    lastNotice = title
    noticeTimer?.invalidate()
    noticePanel?.orderOut(nil)
    let width: CGFloat = 340
    let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 80), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.level = SecondConfirm.level
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false; p.ignoresMouseEvents = true
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true
    p.appearance = NSAppearance(named: .darkAqua)
    let icon = NSImageView(image: NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil) ?? NSImage())
    icon.symbolConfiguration = .init(pointSize: 24, weight: .regular)
    icon.contentTintColor = NSColor(red: 0.23, green: 0.84, blue: 0.48, alpha: 1)
    let t = NSTextField(labelWithString: title); t.font = .systemFont(ofSize: 13.5, weight: .bold)
    let x = NSTextField(wrappingLabelWithString: text); x.font = .systemFont(ofSize: 12); x.textColor = .secondaryLabelColor; x.preferredMaxLayoutWidth = width - 80
    let words = NSStackView(views: [t, x]); words.orientation = .vertical; words.alignment = .leading; words.spacing = 2
    let row = NSStackView(views: [icon, words]); row.spacing = 12; row.alignment = .centerY
    row.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16); row.translatesAutoresizingMaskIntoConstraints = false
    let bg = NSVisualEffectView(); bg.material = .hudWindow; bg.blendingMode = .behindWindow; bg.state = .active
    bg.wantsLayer = true; bg.layer?.cornerRadius = 14; bg.layer?.masksToBounds = true
    bg.addSubview(row)
    NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: bg.leadingAnchor), row.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
                                 row.topAnchor.constraint(equalTo: bg.topAnchor), row.bottomAnchor.constraint(equalTo: bg.bottomAnchor), row.widthAnchor.constraint(equalToConstant: width)])
    p.contentView = bg
    bg.layoutSubtreeIfNeeded(); p.setContentSize(bg.fittingSize)
    if test {
      p.alphaValue = 0; p.setFrameOrigin(NSPoint(x: -60000, y: 0))
    } else if let sc = NSScreen.main {
      let v = sc.visibleFrame
      p.setFrameOrigin(NSPoint(x: v.maxX - p.frame.width - 18, y: v.maxY - p.frame.height - 14))   // top right, like a notification
      p.alphaValue = 0
    }
    p.orderFrontRegardless()
    if !test { NSAnimationContext.runAnimationGroup { $0.duration = 0.25; p.animator().alphaValue = 1 } }
    noticePanel = p
    let tm = Timer(timeInterval: seconds, repeats: false) { [weak self, weak p] _ in
      guard let p else { return }
      NSAnimationContext.runAnimationGroup({ $0.duration = 0.35; p.animator().alphaValue = 0 }, completionHandler: { p.orderOut(nil); if self?.noticePanel === p { self?.noticePanel = nil } })
    }
    RunLoop.main.add(tm, forMode: .common)
    noticeTimer = tm
  }

  private final class Handler: NSObject {
    static var key = 0
    let f: (Bool) -> Void
    init(_ f: @escaping (Bool) -> Void) { self.f = f }
    @objc func yes() { f(true) }
    @objc func no() { f(false) }
  }
}
