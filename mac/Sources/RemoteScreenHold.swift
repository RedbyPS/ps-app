import Cocoa

// The remote screen's hold key (PS 1.69 part 2): hold it (default §) to see the second Mac, let go to put it away, the same
// way holding Tab brings up the Tab list. It lives inside PS's own keyboard tap (main.swift TabWatch.handleLocked calls
// `tap` first), so it follows every tap rule: its own thread, never waiting on main (the timer and the window go through
// main with async), nothing at all while 1Password or Signal is in front (the tap is off then, and `armed` is false), the
// watchdog sends a held key on if main is stuck. The rules themselves are RSHold (RemoteScreenCore.swift, unit tested).
// A held key is never typed: not here, not on the second Mac (its repeats and its key up are swallowed). A quick press is a
// normal key press, sent on in order with PS's own mark (MAGIC) so the tap lets it through.

final class RSHoldTap {
  static let shared = RSHoldTap()
  enum Answer { case notMine, pass, swallow }

  private let mu = NSLock()
  private var m = RSHold()
  private var held: CGEvent?
  private var work: DispatchWorkItem?
  private var armed = false
  private var up = false
  private let postQ = DispatchQueue(label: "ps.screen.hold.post", qos: .userInteractive)
  /// § is rarely typed, but a little longer than Tab's hold keeps a quick press a plain key press.
  static let holdSeconds = 0.25
  /// Main thread: what the tap should do with the key.
  var onShow: () -> Void = {}
  var onHide: () -> Void = {}
  var onRelease: () -> Void = {}

  /// Main thread, whenever any of it changes (RemoteScreen.armHold).
  func set(armed a: Bool, code: Int64?, up u: Bool) {
    mu.lock(); defer { mu.unlock() }
    armed = a && code != nil
    if let code, m.state == .idle { m.code = code }
    up = u
  }

  /// From the keyboard tap's thread (under its lock). `tabIdle`: the Tab hold is not in the middle of something.
  func tap(_ type: CGEventType, _ e: CGEvent, tabIdle: Bool) -> Answer {
    guard type == .keyDown || type == .keyUp else { return .notMine }
    if e.getIntegerValueField(.eventSourceUserData) == MAGIC { return .notMine }   // one PS sent on itself
    mu.lock(); defer { mu.unlock() }
    let code = e.getIntegerValueField(.keyboardEventKeycode)
    let mods = !e.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
    let o = m.key(code: code, down: type == .keyDown, repeating: e.getIntegerValueField(.keyboardEventAutorepeat) != 0,
                  modifiers: mods, armed: armed && tabIdle && !Protected.front, up: up)
    if o.startTimer {
      held = e.copy()
      work?.cancel()
      let w = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.mu.lock(); let r = self.m.fire(); if r != nil { self.held = nil }; self.mu.unlock()
        if r == .show { self.onShow() } else if r == .hide { self.onHide() }
      }
      work = w
      DispatchQueue.main.asyncAfter(deadline: .now() + RSHoldTap.holdSeconds, execute: w)
    }
    if o.release { DispatchQueue.main.async { [weak self] in self?.onRelease() } }
    switch o.event {
    case .notMine: return .notMine
    case .pass: return .pass
    case .swallow: return .swallow
    case .repostHeldThenThis:
      work?.cancel()
      let list = [held, e.copy()].compactMap { $0 }
      held = nil
      repost(list)
      return .swallow
    }
  }

  /// The tap's watchdog (main stuck over a second): a held key goes out at once, nothing is left waiting.
  func reset() {
    mu.lock(); defer { mu.unlock() }
    work?.cancel()
    if m.reset(), let h = held { repost([h]) }
    held = nil
  }

  private func repost(_ list: [CGEvent]) {
    postQ.async {
      for ev in list { ev.setIntegerValueField(.eventSourceUserData, value: MAGIC); ev.post(tap: .cgSessionEventTap) }
    }
  }
}
