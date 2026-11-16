import Cocoa

// The Test Pad: a window to try the press and pick a firmness. The bar rises with the press
// (bottom half: a normal click, top half: the deep Force Click). It turns blue at the point the
// chosen firmness makes a middle click. The numbers underneath are what macOS reports, so the developer
// can read them out if the firmness needs tuning.
// While this window is in front the mouse tap steps aside, so the pad sees the raw press.

final class PadView: NSView {
  var firmness = Firmness.normal { didSet { needsDisplay = true } }
  var onChange: (() -> Void)?
  private(set) var stage = 0
  private(set) var pressure = 0.0
  private(set) var transition = 0.0
  private(set) var pressing = false
  private(set) var fired = false
  private(set) var fromTap = false
  private(set) var middles = 0
  private(set) var normals = 0

  override init(frame: NSRect) {
    super.init(frame: frame)
    pressureConfiguration = NSPressureConfiguration(pressureBehavior: .primaryDeepClick)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// One scale for the bar: stage 1 fills the bottom half, stage 2 the top half.
  private var level: Double {
    switch stage {
    case 0: return 0
    case 1: return 0.5 * min(max(pressure, 0), 1)
    default: return 0.5 + 0.5 * min(max(pressure, 0), 1)
    }
  }

  override func mouseDown(with event: NSEvent) {
    pressing = true; fired = false; fromTap = false; stage = 1; pressure = 0; transition = 0
    update()
  }
  override func mouseUp(with event: NSEvent) {
    if !fired { normals += 1 }
    pressing = false; stage = 0; pressure = 0; transition = 0
    update()
  }
  override func pressureChange(with event: NSEvent) {
    guard pressing else { return }
    stage = event.stage; pressure = Double(event.pressure); transition = Double(event.stageTransition)
    if !fired && firmness.reached(stage: stage, pressure: pressure, transition: transition) {
      fired = true; middles += 1
    }
    update()
  }
  // A real middle click sent by the tap (when the pad was clicked while another app was in front).
  override func otherMouseDown(with event: NSEvent) {
    guard event.buttonNumber == 2 else { return }
    pressing = true; fired = true; fromTap = true; middles += 1; stage = 2; pressure = 0
    update()
  }
  override func otherMouseUp(with event: NSEvent) {
    guard event.buttonNumber == 2 else { return }
    pressing = false; stage = 0
    update()
  }
  private func update() { needsDisplay = true; onChange?() }

  override func draw(_ dirtyRect: NSRect) {
    let r = bounds.insetBy(dx: 1, dy: 1)
    let shape = NSBezierPath(roundedRect: r, xRadius: 18, yRadius: 18)
    NSColor.quaternaryLabelColor.withAlphaComponent(0.12).setFill()
    shape.fill()

    // The press, rising from the bottom.
    NSGraphicsContext.saveGraphicsState()
    shape.addClip()
    let fill = NSRect(x: r.minX, y: r.minY, width: r.width, height: r.height * (fired ? 1 : level))
    (fired ? NSColor.controlAccentColor : NSColor.secondaryLabelColor.withAlphaComponent(0.22)).setFill()
    fill.fill()
    NSGraphicsContext.restoreGraphicsState()

    // The deep click line (halfway), shown while pressing: Normal fires here.
    let y = r.minY + r.height * 0.5
    let small: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .medium),
                                                .foregroundColor: NSColor.tertiaryLabelColor]
    if pressing && !fired {
      let line = NSBezierPath()
      line.move(to: NSPoint(x: r.minX + 14, y: y)); line.line(to: NSPoint(x: r.maxX - 14, y: y))
      line.setLineDash([4, 4], count: 2, phase: 0)
      line.lineWidth = 1
      NSColor.tertiaryLabelColor.setStroke()
      line.stroke()
      let label = NSAttributedString(string: "deep click", attributes: small)
      label.draw(at: NSPoint(x: r.maxX - 16 - label.size().width, y: y + 3))
    }

    // The big word in the middle.
    let word: String
    if fired { word = fromTap ? "Middle click received" : "Middle click" }
    else if pressing { word = stage >= 2 ? "Deep click" : "Click" }
    else { word = "Press here" }
    let big: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 26, weight: .semibold),
      .foregroundColor: fired ? NSColor.white : (pressing ? NSColor.labelColor : NSColor.secondaryLabelColor)]
    let s = NSAttributedString(string: word, attributes: big)
    let sz = s.size()
    // Pressing: the word sits in the top quarter, clear of the line and the rising bar.
    let wy = pressing && !fired ? r.minY + r.height * 0.75 - sz.height / 2 : r.midY - sz.height / 2 + (fired ? 0 : 10)
    s.draw(at: NSPoint(x: r.midX - sz.width / 2, y: wy))
    if !pressing && !fired {
      let hint = NSAttributedString(string: "Press like on a link, then press firmly", attributes: small)
      hint.draw(at: NSPoint(x: r.midX - hint.size().width / 2, y: r.midY - 22))
    }
  }
}

final class TestPad: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  private let pad = PadView(frame: NSRect(x: 0, y: 0, width: 380, height: 230))
  private let numbers = NSTextField(labelWithString: "")
  private let counts = NSTextField(labelWithString: "")
  private let picker = NSSegmentedControl(labels: Firmness.allCases.map(\.title), trackingMode: .selectOne, target: nil, action: nil)
  private let pickerNote = NSTextField(labelWithString: "")
  var onFirmness: ((Firmness) -> Void)?

  func show(firmness: Firmness) {
    if window == nil { build() }
    setFirmness(firmness)
    NSApp.activate(ignoringOtherApps: true)
    window?.center()
    window?.makeKeyAndOrderFront(nil)
  }
  func setFirmness(_ f: Firmness) {
    pad.firmness = f
    picker.selectedSegment = Firmness.allCases.firstIndex(of: f) ?? 1
    pickerNote.stringValue = f.detail
  }

  private func build() {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 400),
                     styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
    w.title = "PSMiddleClicker Test Pad"
    w.titlebarAppearsTransparent = true
    w.isReleasedWhenClosed = false
    w.delegate = self

    let title = NSTextField(labelWithString: "Try the press")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    let sub = NSTextField(wrappingLabelWithString: "A normal press stays a normal click. Press on until you feel the second, deeper click: the pad turns blue, and in a browser that would open the link in a new tab.")
    sub.font = .systemFont(ofSize: 12); sub.textColor = .secondaryLabelColor

    picker.target = self; picker.action = #selector(picked)
    pickerNote.font = .systemFont(ofSize: 11); pickerNote.textColor = .secondaryLabelColor
    let firmLabel = NSTextField(labelWithString: "Firmness")
    firmLabel.font = .systemFont(ofSize: 12, weight: .medium)
    let row = NSStackView(views: [firmLabel, picker, pickerNote])
    row.spacing = 10; row.alignment = .centerY

    numbers.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular); numbers.textColor = .secondaryLabelColor
    counts.font = .systemFont(ofSize: 12, weight: .medium)

    pad.translatesAutoresizingMaskIntoConstraints = false
    pad.onChange = { [weak self] in self?.refresh() }
    let stack = NSStackView(views: [title, sub, row, pad, counts, numbers])
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
    stack.setCustomSpacing(4, after: title); stack.setCustomSpacing(16, after: row)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = NSVisualEffectView()
    content.material = .windowBackground; content.state = .active
    content.addSubview(stack)
    w.contentView = content
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 40),
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
      sub.widthAnchor.constraint(equalTo: stack.widthAnchor),
      pad.widthAnchor.constraint(equalTo: stack.widthAnchor),
      pad.heightAnchor.constraint(equalToConstant: 200),
    ])
    window = w
    refresh()
  }

  @objc private func picked() {
    let f = Firmness.allCases[max(0, picker.selectedSegment)]
    setFirmness(f)
    onFirmness?(f)
  }

  private func refresh() {
    counts.stringValue = "Middle clicks: \(pad.middles)     Normal clicks: \(pad.normals)"
    numbers.stringValue = pad.pressing
      ? String(format: "stage %d    pressure %.2f    towards next stage %.2f", pad.stage, pad.pressure, pad.transition)
      : "stage, pressure and how far towards the next stage show here while you press"
  }

  // Hand the front back to the app the developer was in, so the tap is fully on again (it steps aside
  // while PSMiddleClicker itself is in front).
  func windowWillClose(_ notification: Notification) { NSApp.hide(nil) }
}
