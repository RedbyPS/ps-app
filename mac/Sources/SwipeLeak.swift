import AppKit

/// PS 1.73 swipe leak, the AppKit side (the rules are SwipeLeakCore.swift). Everything here is local to PS: local
/// event monitors on PS's own windows, and one scroll event handed from PS's card window to PS's own Tab list window.
/// No event tap, nothing posted to the system, no other app or window touched.
enum SwipeLeak {
  static func wheel(_ e: NSEvent) -> SwipeLeakCore.Wheel {
    .init(phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue, dx: Double(e.scrollingDeltaX), dy: Double(e.scrollingDeltaY),
          t: e.timestamp, precise: e.hasPreciseScrollingDeltas)
  }
  /// The Tab list's own trackpad gestures (fed by PageSwipe.swift, the cards' hand over and the hold below).
  static var glide = SwipeLeakCore.GlideWatch()
  static var now: Double { ProcessInfo.processInfo.systemUptime }   // the same clock as NSEvent.timestamp
}

/// Rule 2: Tab was let go while a sideways swipe or its glide was running. The list is already invisible; this keeps
/// its window catching scroll (and dropping it, so the hidden page does not move either) until the gesture ends, the
/// fingers start a new gesture, a click comes, or `SwipeLeakCore.cap` runs out. Then `done` makes it click through.
final class GlideHold {
  private var monitor: Any?
  private var timer: Timer?
  private var done: (() -> Void)?
  private var startedAt = 0.0
  var active: Bool { monitor != nil }

  func start(_ window: NSWindow, for secs: Double, done: @escaping () -> Void) {
    stop()
    self.done = done
    startedAt = SwipeLeak.now
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self, weak window] e in
      guard let self, let window, e.window === window else { return e }
      if e.type == .scrollWheel {
        let w = SwipeLeak.wheel(e)
        if SwipeLeakCore.starts(w) { self.finish(); return nil }   // a new gesture: the hold is over
        SwipeLeak.glide.feed(w)
        if !SwipeLeak.glide.live(w.t) { self.finish() }
        return nil
      }
      // A click while the invisible list still holds the glide: the hold ends; the click never reaches the hidden page.
      self.finish()
      return nil
    }
    // Fingers lifted with no glide sends nothing more: look every 50 ms, and never past the cap.
    timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
      guard let self else { return }
      let t = SwipeLeak.now
      if !SwipeLeak.glide.live(t) || t - self.startedAt >= secs { self.finish() }
    }
  }

  /// The hold ends: the window goes click through (`done`).
  func finish() {
    let d = done
    stop()
    d?()
  }

  /// Cancelled without `done` (the list is coming back up).
  func stop() {
    if let m = monitor { NSEvent.removeMonitor(m) }
    monitor = nil
    timer?.invalidate()
    timer = nil
    done = nil
  }
}
