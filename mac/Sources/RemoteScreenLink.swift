import Cocoa
import QuartzCore

// The link animations (PS 1.69 part 2), in PS's own look (the dark HUD and pink of Second Computer's own panels). No sound.
//  - RSLinkView: two Macs drawn with plain shapes. Looking: a row of dots runs from one to the other. Linked: the dots join into
//    one glowing line, both Macs light up and a check pops in. With "Reduce motion" on, it only fades.
//  - RSLinkPanel: the pairing screen. On the main Mac when Pair is clicked (looking), then both Macs show the same six digit
//    code (SecondIdentity.pairCode, from both Macs' keys) rolling in digit by digit as the link joins, so the person can see
//    the two Macs agree. It closes by itself a few seconds after, and on Esc (the keyboard tap's Esc rule, main.swift).
//    On the second Mac it never takes the keyboard, and never shows while 1Password or Signal is in front.
// The remote screen window shows RSLinkView while it looks for and connects to the other Mac, then the picture fades in.

let RS_PINK = NSColor(red: 0.93, green: 0.31, blue: 0.53, alpha: 1)

final class RSLinkView: NSView {
  enum Phase { case looking, linked }
  private let left = CAShapeLayer(), right = CAShapeLayer()
  private let dots = CAReplicatorLayer(), dot = CALayer()
  private let line = CAShapeLayer(), check = CAShapeLayer()
  private let code = CATextLayer()
  private(set) var phase: Phase = .looking
  private var reduce: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    for l in [left, right] { l.fillColor = NSColor(white: 1, alpha: 0.10).cgColor; l.strokeColor = NSColor(white: 1, alpha: 0.85).cgColor; l.lineWidth = 2.5; layer?.addSublayer(l) }
    dot.backgroundColor = RS_PINK.cgColor
    dots.addSublayer(dot)
    layer?.addSublayer(dots)
    line.strokeColor = RS_PINK.cgColor; line.lineWidth = 4; line.lineCap = .round; line.strokeEnd = 0
    line.shadowColor = RS_PINK.cgColor; line.shadowRadius = 8; line.shadowOpacity = 0; line.shadowOffset = .zero
    layer?.addSublayer(line)
    check.fillColor = RS_PINK.cgColor; check.strokeColor = NSColor.white.cgColor; check.lineWidth = 3; check.lineCap = .round; check.lineJoin = .round
    check.opacity = 0
    layer?.addSublayer(check)
    code.alignmentMode = .center; code.foregroundColor = NSColor.white.cgColor
    code.font = NSFont.monospacedDigitSystemFont(ofSize: 30, weight: .semibold); code.fontSize = 30
    code.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
    layer?.addSublayer(code)
  }
  required init?(coder: NSCoder) { nil }

  /// A laptop: a rounded screen and a thin base.
  private static func mac(_ r: CGRect) -> CGPath {
    let p = CGMutablePath()
    let screen = CGRect(x: r.minX + r.width * 0.12, y: r.minY + r.height * 0.22, width: r.width * 0.76, height: r.height * 0.70)
    p.addRoundedRect(in: screen, cornerWidth: 6, cornerHeight: 6)
    p.addRoundedRect(in: CGRect(x: r.minX, y: r.minY + r.height * 0.08, width: r.width, height: r.height * 0.10), cornerWidth: 3, cornerHeight: 3)
    return p
  }

  override func layout() {
    super.layout()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    let b = bounds, size: CGFloat = 64, cy = b.midY + 18
    let l = CGRect(x: b.midX - 150, y: cy - size / 2, width: size * 1.2, height: size), r = CGRect(x: b.midX + 150 - size * 1.2, y: cy - size / 2, width: size * 1.2, height: size)
    left.path = RSLinkView.mac(l); right.path = RSLinkView.mac(r)
    let x0 = l.maxX + 14, x1 = r.minX - 14, y = cy + 4
    let n = 9, gap = (x1 - x0) / CGFloat(n - 1)
    dots.frame = CGRect(x: x0 - 3, y: y - 3, width: x1 - x0 + 6, height: 6)
    dot.frame = CGRect(x: 0, y: 0, width: 6, height: 6); dot.cornerRadius = 3
    dots.instanceCount = n; dots.instanceTransform = CATransform3DMakeTranslation(gap, 0, 0)
    let lp = CGMutablePath(); lp.move(to: CGPoint(x: x0, y: y)); lp.addLine(to: CGPoint(x: x1, y: y)); line.path = lp
    let c = CGPoint(x: b.midX, y: y), cr: CGFloat = 15
    let cp = CGMutablePath(); cp.addEllipse(in: CGRect(x: c.x - cr, y: c.y - cr, width: cr * 2, height: cr * 2))
    cp.move(to: CGPoint(x: c.x - 6, y: c.y)); cp.addLine(to: CGPoint(x: c.x - 1.5, y: c.y - 5)); cp.addLine(to: CGPoint(x: c.x + 7, y: c.y + 5))
    check.path = cp; check.frame = b; check.bounds = b
    code.frame = CGRect(x: b.midX - 160, y: cy - size / 2 - 64, width: 320, height: 40)
    CATransaction.commit()
  }

  /// Looking for the other Mac: the dots run across, over and over.
  func looking() {
    phase = .looking
    layoutSubtreeIfNeeded()
    line.removeAllAnimations(); line.strokeEnd = 0; line.shadowOpacity = 0
    check.removeAllAnimations(); check.opacity = 0
    for l in [left, right] { l.strokeColor = NSColor(white: 1, alpha: 0.85).cgColor }
    dots.opacity = 1
    dot.removeAllAnimations()
    if reduce { dot.opacity = 0.6; return }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 1; a.toValue = 0.12; a.duration = 0.9; a.repeatCount = .infinity
    dot.add(a, forKey: "run")
    dots.instanceDelay = 0.09
    let s = CABasicAnimation(keyPath: "transform.scale")
    s.fromValue = 1.35; s.toValue = 0.8; s.duration = 0.9; s.repeatCount = .infinity
    dot.add(s, forKey: "size")
  }

  /// The link joins: the dots become one glowing line drawn across, both Macs light up pink, the check pops in.
  func linked(code c: String? = nil) {
    phase = .linked
    layoutSubtreeIfNeeded()
    let t = CACurrentMediaTime()
    dot.removeAllAnimations()
    CATransaction.begin()
    CATransaction.setAnimationDuration(reduce ? 0.2 : 0.45)
    dots.opacity = 0
    line.strokeEnd = 1; line.shadowOpacity = 0.9
    for l in [left, right] { l.strokeColor = RS_PINK.cgColor }
    CATransaction.commit()
    if !reduce {
      let draw = CABasicAnimation(keyPath: "strokeEnd"); draw.fromValue = 0; draw.toValue = 1; draw.duration = 0.45
      draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
      line.add(draw, forKey: "draw")
      let pop = CAKeyframeAnimation(keyPath: "transform.scale")
      pop.values = [0.2, 1.18, 1]; pop.keyTimes = [0, 0.7, 1]; pop.duration = 0.35; pop.beginTime = t + 0.4; pop.fillMode = .backwards
      check.add(pop, forKey: "pop")
    }
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.2; fade.beginTime = t + (reduce ? 0 : 0.4); fade.fillMode = .backwards
    check.add(fade, forKey: "in"); check.opacity = 1
    if let c { roll(c, from: t + (reduce ? 0 : 0.2)) }
  }

  /// The six digit code, one digit after another (each slides up into place), then it stays.
  private func roll(_ c: String, from t: CFTimeInterval) {
    code.string = c
    guard !reduce else { return }
    let up = CABasicAnimation(keyPath: "position.y"); up.byValue = -10; up.duration = 0.5; up.beginTime = t; up.fillMode = .backwards
    up.timingFunction = CAMediaTimingFunction(name: .easeOut)
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.5; fade.beginTime = t; fade.fillMode = .backwards
    code.add(up, forKey: "up"); code.add(fade, forKey: "fade")
    // The digits appear one by one: the string grows, a step every 70 ms.
    let digits = Array(c)
    for i in 1...digits.count {
      DispatchQueue.main.asyncAfter(deadline: .now() + (t - CACurrentMediaTime()) + Double(i) * 0.07) { [weak self] in
        guard let self else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        self.code.string = String(digits.prefix(i)) + String(repeating: " ", count: digits.count - i)
        CATransaction.commit()
      }
    }
  }

  func clearCode() { code.string = nil }
}

/// The pairing screen (on Pair, and on the second Mac when it was paired from the main Mac).
final class RSLinkPanel: NSObject {
  static let shared = RSLinkPanel()
  private var panel: NSPanel?
  private let view = RSLinkView(frame: NSRect(x: 0, y: 0, width: 420, height: 230))
  private let title = NSTextField(labelWithString: "")
  private let line = NSTextField(wrappingLabelWithString: "")
  private var closeTimer: Timer?
  /// True while it is on screen: the keyboard tap's Esc closes it (main.swift).
  private(set) static var upNow = false

  private final class Panel: NSPanel {
    var onEsc: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEsc?() }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { onEsc?() } else { super.keyDown(with: e) } }
  }

  private func make() -> NSPanel {
    let p = Panel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
    p.titleVisibility = .hidden; p.titlebarAppearsTransparent = true; p.isMovableByWindowBackground = true
    p.level = SecondConfirm.level; p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false
    p.appearance = NSAppearance(named: .darkAqua)
    p.onEsc = { [weak self] in self?.close() }
    let bg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 420, height: 300))
    bg.material = .hudWindow; bg.blendingMode = .behindWindow; bg.state = .active
    title.font = .systemFont(ofSize: 15, weight: .bold); title.alignment = .center
    line.font = .systemFont(ofSize: 12.5); line.textColor = .secondaryLabelColor; line.alignment = .center; line.preferredMaxLayoutWidth = 372
    view.frame = NSRect(x: 0, y: 70, width: 420, height: 200)
    title.frame = NSRect(x: 24, y: 48, width: 372, height: 22)
    line.frame = NSRect(x: 24, y: 10, width: 372, height: 36)
    for v in [view, title, line] { bg.addSubview(v) }
    p.contentView = bg
    let mouse = NSEvent.mouseLocation
    if let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main {
      let v = s.visibleFrame
      p.setFrameOrigin(NSPoint(x: (v.midX - 210).rounded(), y: (v.midY - 150 + v.height * 0.12).rounded()))
    }
    return p
  }

  /// On the main Mac, right after Pair: looking for the other Mac. `focus`: it was Pair's own click, so it may take the keyboard.
  func looking() {
    guard !IS_TEST_COPY, !Protected.front else { return }
    let p = panel ?? make(); panel = p
    title.stringValue = "Looking for your other Mac"
    line.stringValue = "Keep PS open on it, signed in to the same account."
    view.clearCode(); view.looking()
    show(p, focus: true)
    closeLater(60)
  }

  /// Both Macs: the link joined. Shows the code both Macs worked out from each other's keys.
  func linked(code: String, with name: String, focus: Bool) {
    guard !IS_TEST_COPY, !Protected.front else { return }
    let p = panel ?? make(); panel = p
    let safe = String(name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }.prefix(40).map(Character.init))
    title.stringValue = "Linked with \(safe)"
    line.stringValue = "Both Macs show this code. Esc closes this."
    show(p, focus: focus)
    view.linked(code: code)
    closeLater(8)
  }

  private func show(_ p: NSPanel, focus: Bool) {
    RSLinkPanel.upNow = true
    if focus { p.makeKeyAndOrderFront(nil) } else { p.orderFrontRegardless() }
  }
  private func closeLater(_ s: Double) {
    closeTimer?.invalidate()
    closeTimer = Timer.scheduledTimer(withTimeInterval: s, repeats: false) { [weak self] _ in self?.close() }
  }
  func close() {
    closeTimer?.invalidate(); closeTimer = nil
    RSLinkPanel.upNow = false
    guard let p = panel else { return }
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.18; p.animator().alphaValue = 0 }) { p.orderOut(nil); p.alphaValue = 1 }
  }
}
