import AppKit
import WebKit

/// Several to-do lists as pages in the Tab list (V1.55, web views/ListPager.tsx). A two finger trackpad
/// swipe reaches the page as sideways wheel events, but a web page cannot tell when the fingers lift, so the slide
/// could not let go at the right moment (it would ride the glide that follows). This tells the page, for PS's own
/// Tab list window only: "b" the fingers touched the trackpad, "e" they lifted (or macOS cancelled the gesture),
/// "m" the glide after them began. Nothing else: no deltas, no positions, no other window, no other app.
///
/// One local monitor (PS's own events, on the main thread, which it already is): it never blocks, never changes or
/// swallows an event (it returns each one as it came), and only sends a few bytes when a phase changes. The page
/// answers to `window.__psPageSwipe(p)`; a page without it ignores the call.
enum PageSwipe {
  private static var monitor: Any?

  static func install(_ web: WKWebView) {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak web] e in
      guard let web, let w = web.window, e.window === w, e.hasPreciseScrollingDeltas else { return e }
      heard(e, web)
      return e
    }
  }

  /// One of the list's own trackpad events, or one handed over from PS's cards while the list is up (PS 1.73,
  /// SwipeLeak.swift): the glide watch follows it, and the page hears a phase change.
  static func heard(_ e: NSEvent, _ web: WKWebView) {
    SwipeLeak.glide.feed(SwipeLeak.wheel(e))
    if let p = phase(e) { web.evaluateJavaScript("window.__psPageSwipe&&window.__psPageSwipe('\(p)')", completionHandler: nil) }
  }

  /// The one letter for a phase change, or nil for every other event (the moves in between say nothing).
  static func phase(_ e: NSEvent) -> String? { phaseLetter(e.phase, e.momentumPhase) }

  static func phaseLetter(_ phase: NSEvent.Phase, _ momentum: NSEvent.Phase) -> String? {
    if phase.contains(.began) || phase.contains(.mayBegin) { return "b" }
    if phase.contains(.ended) || phase.contains(.cancelled) { return "e" }
    if momentum.contains(.began) { return "m" }
    return nil
  }
}
