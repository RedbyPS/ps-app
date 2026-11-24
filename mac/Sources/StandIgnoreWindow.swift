import AppKit

/// The island itself stays non-key. Only an explicit click on Ignore opens this text field.
final class StandIgnorePanel: NSPanel {
  var onCancel: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func cancelOperation(_ sender: Any?) { onCancel?() }
}

final class StandIgnoreWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
  static let shared = StandIgnoreWindow()
  typealias Anchor = (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow)
  private static let size = NSSize(width: 260, height: 112)
  private var window: StandIgnorePanel?
  private var input: NSTextField?
  private var confirm: ((String) -> Void)?
  private(set) var occurrence: Double?

  func show(at: Double, anchor: Anchor, confirm: @escaping (String) -> Void) {
    guard window == nil else { return }
    let p = StandIgnorePanel(contentRect: .init(origin: .zero, size: Self.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.delegate = self
    p.onCancel = { [weak self] in self?.close() }
    p.level = .init(rawValue: anchor.panel.level.rawValue + 1)
    p.collectionBehavior = IslandPlace.spaces
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.appearance = NSAppearance(named: .darkAqua)

    let instruction = "Type '\(TimersCore.standIgnorePhrase)' to skip this reminder."
    let label = NSTextField(labelWithString: instruction)
    label.font = .systemFont(ofSize: 12, weight: .semibold)
    label.alignment = .center
    let field = NSTextField(string: "")
    field.delegate = self
    field.setAccessibilityLabel(instruction)
    field.placeholderString = "Type here"
    let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked))
    cancel.bezelStyle = .rounded
    cancel.keyEquivalent = "\u{1b}"

    let bg = NSView(frame: .init(origin: .zero, size: Self.size))
    bg.wantsLayer = true
    bg.layer?.backgroundColor = NSColor.black.cgColor
    bg.layer?.cornerRadius = 20
    bg.layer?.borderWidth = 1
    bg.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
    label.frame = NSRect(x: 12, y: 79, width: 236, height: 18)
    field.frame = NSRect(x: 22, y: 46, width: 216, height: 24)
    cancel.frame = NSRect(x: 90, y: 11, width: 80, height: 26)
    [label, field, cancel].forEach { bg.addSubview($0) }
    p.contentView = bg
    p.initialFirstResponder = field

    self.confirm = confirm
    occurrence = at
    input = field
    window = p
    follow(anchor)
    p.orderFrontRegardless()
    p.makeKey()
    p.makeFirstResponder(field)
  }

  func follow(_ anchor: Anchor?) {
    guard let p = window else { return }
    guard let anchor else { close(); return }
    let frame = Self.frame(anchor)
    if p.frame != frame { p.setFrame(frame, display: true) }
  }

  private static func frame(_ a: Anchor) -> NSRect {
    let x = min(max(a.screen.minX, a.shape.midX - size.width / 2), a.screen.maxX - size.width)
    let below = a.shape.minY - size.height - 8
    let y = below >= a.screen.minY ? below : min(a.shape.maxY + 8, a.screen.maxY - size.height)
    return NSRect(x: x, y: y, width: size.width, height: size.height).integral
  }

  func controlTextDidChange(_ note: Notification) {
    guard let field = note.object as? NSTextField, field === input,
          let text = field.currentEditor()?.string, text == TimersCore.standIgnorePhrase else { return }
    let action = confirm
    close()
    action?(text)
  }

  func windowDidResignKey(_ notification: Notification) {
    if let p = notification.object as? NSWindow, p === window { close() }
  }

  @objc private func cancelClicked() { close() }

  func close() {
    guard let p = window else { return }
    window = nil
    occurrence = nil
    confirm = nil
    input?.delegate = nil
    input = nil
    p.delegate = nil
    p.orderOut(nil)
  }
}
