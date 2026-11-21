import Foundation

/// PS 1.73 swipe leak (the developer, 21 Nov 2026: on Jan's Mac a two finger swipe left to right "was dismissing an Apple
/// notification on the top right of his screen ... I need it to ignore swipes when he's using the PS app").
/// Pure rules, unit tested in tests/swipeleak-test.sh. The AppKit side is SwipeLeak.swift.
///
/// Two rules, nothing else:
///  1. Card route. While the Tab list is up, PS's own top right cards (Toast.swift) sit above it, and a sideways two
///     finger swipe over a card used to dismiss the card instead of moving the list's page. Now a gesture whose first
///     real move is sideways goes to the list, whole, while the list is up. Up or down first stays with the cards (the
///     stack scrolls, "Remind me in" changes). With the list hidden nothing changes: the cards keep every gesture.
///  2. Glide watch. Letting go of Tab while a sideways swipe or its glide is still running used to make the list click
///     through at once, so the rest of the glide went to whatever sat under the pointer (a banner, or Back in a
///     browser). Now the list stays catching scroll, invisible, until that gesture ends, never longer than `cap`.
enum SwipeLeakCore {
  /// One scroll event as the rules see it: its two phases (NSEvent.Phase raw values) and its move.
  struct Wheel: Equatable {
    var phase: UInt = 0        // NSEvent.Phase rawValue (began 1, stationary 2, changed 4, ended 8, cancelled 16, mayBegin 32)
    var momentum: UInt = 0     // momentumPhase rawValue (same bits)
    var dx: Double = 0
    var dy: Double = 0
    var t: Double = 0          // seconds, any clock that only goes forward
    var precise = true         // a trackpad or Magic Mouse (hasPreciseScrollingDeltas); false: a plain mouse wheel
  }
  static let began: UInt = 1, changed: UInt = 4, ended: UInt = 8, cancelled: UInt = 16, mayBegin: UInt = 32

  /// A plain mouse wheel has no phases: a pause this long ends its "gesture" (the cards' own page uses 180 ms too).
  static let wheelRest = 0.18
  /// The longest the list keeps catching a glide after Tab is let go.
  static let cap = 1.2
  /// Fingers lifted and no glide yet: macOS starts the glide within a frame or two, so wait this long for it.
  static let liftGrace = 0.15
  /// A running gesture sends an event every frame or so: none for this long and it counts as over (fingers resting
  /// still, or a gesture that ended out of sight), so a stale state never holds the list later.
  static let stale = 0.25

  static func starts(_ w: Wheel) -> Bool { w.phase & (began | mayBegin) != 0 }
  static func hasMove(_ w: Wheel) -> Bool { w.dx != 0 || w.dy != 0 }
  /// Sideways: clearly more across than up or down (the same test as the list's own page rule, "well more across").
  static func sideways(_ w: Wheel) -> Bool { abs(w.dx) > abs(w.dy) }

  // MARK: 1. card route

  enum Owner: Equatable { case cards, list }
  enum Send: Equatable {
    /// Only the cards get it (as always).
    case cards
    /// Only the list gets it (the cards never see it).
    case list
    /// Both: the gesture's start before anything moved, or its end, so neither side is left with half a gesture.
    case both
  }

  /// Decides, per gesture, who gets each scroll event that lands on a card window.
  struct CardRoute {
    private(set) var owner: Owner?
    private var last: Double = -1

    /// `listUp`: the Tab list is showing right now.
    mutating func route(_ w: Wheel, listUp: Bool) -> Send {
      // A new gesture: fingers touch (trackpad), or a plain wheel after a rest.
      if starts(w) || (!w.precise && (last < 0 || w.t - last > SwipeLeakCore.wheelRest)) { owner = nil }
      last = w.t
      guard listUp else { owner = nil; return .cards }   // the list is not up: exactly as before 1.73
      if owner == nil, hasMove(w) { owner = sideways(w) ? .list : .cards }
      switch owner {
      case nil:
        // Nothing has moved yet (fingers down): both hear the start, so whichever side gets the gesture has its start.
        return .both
      case .cards?:
        // The list heard the start: it also hears the fingers lift, with no move in between (nothing happens there).
        if !hasMove(w), w.phase & (ended | cancelled) != 0 { return .both }
        return .cards
      case .list?:
        return .list
      }
    }
  }

  // MARK: 2. glide watch

  /// Follows the Tab list's own trackpad gestures (and the ones handed over from the cards).
  struct GlideWatch {
    enum State: Equatable { case idle, fingers, lifted(Double), gliding }
    private(set) var state: State = .idle
    /// Whether the gesture running now started sideways (only those are held).
    private(set) var across = false
    private var decided = false
    private var lastT = -1.0

    mutating func feed(_ w: Wheel) {
      guard w.precise else { return }   // a plain mouse wheel has no glide
      lastT = w.t
      if starts(w) { state = .fingers; decided = false; across = false }
      if !decided, hasMove(w) { decided = true; across = sideways(w) }
      if w.phase & changed != 0, state == .idle { state = .fingers }
      if w.phase & (ended | cancelled) != 0 { state = .lifted(w.t) }
      if w.momentum & (began | changed) != 0 { state = .gliding }
      if w.momentum & (ended | cancelled) != 0 { state = .idle }
    }

    /// A sideways gesture or its glide is still running at `t`.
    func live(_ t: Double) -> Bool {
      guard across, lastT >= 0, t - lastT < SwipeLeakCore.stale else { return false }
      switch state {
      case .idle: return false
      case .fingers, .gliding: return true
      case .lifted(let at): return t - at < SwipeLeakCore.liftGrace
      }
    }

    /// The list is going away at `t`: how long it must keep catching scroll, or nil to go click through at once.
    func holdOnHide(_ t: Double) -> Double? { live(t) ? SwipeLeakCore.cap : nil }
  }
}
