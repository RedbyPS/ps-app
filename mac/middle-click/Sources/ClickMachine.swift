import Foundation

// The whole click logic, with no macOS calls in it, so it can be tested with made up event
// sequences (Tests/main.swift). Tap.swift feeds it the real events and does what it says.
//
// How a press is handled:
// 1. Left button goes down: hold that event back for a moment (nothing reaches the app yet).
// 2. The press gets firm enough (Force Click, stage 2) before the finger lifts: drop the held
//    left click and send a middle button down instead. Drags become middle drags, and the
//    finger lifting becomes the middle button up (same timing as the real press).
// 3. Anything else gives the held left click back untouched, in its original order:
//    the finger lifts (a plain click), the cursor moves (a drag or text selection),
//    or the hold time runs out (a long press).

/// How firm the press must be. Normal is the Mac's own Force Click point (the second, deeper
/// click you feel). Light fires a little before it, Firm needs a bit more after it.
enum Firmness: String, CaseIterable {
  case light, normal, firm

  var title: String {
    switch self {
    case .light: return "Light"
    case .normal: return "Normal"
    case .firm: return "Firm"
    }
  }
  var detail: String {
    switch self {
    case .light: return "Just before the deep click"
    case .normal: return "At the deep click (recommended)"
    case .firm: return "Press a little past the deep click"
    }
  }

  /// stage: 0 none, 1 normal click, 2 deep click. pressure: 0...1 within the stage.
  /// transition: how far the press is towards the next stage (0...1, below 0 going back).
  func reached(stage: Int, pressure: Double, transition: Double) -> Bool {
    switch self {
    case .light: return stage >= 2 || (stage == 1 && transition >= 0.5)
    case .normal: return stage >= 2
    case .firm: return stage >= 2 && pressure >= 0.3
    }
  }
}

struct ClickMachine {
  enum Input: Equatable {
    /// holdable: the window under the pointer can take a middle click (a browser window).
    /// Anywhere else (Mission Control, the Dock, the menu bar, other apps) the press passes
    /// straight through, untouched and undelayed.
    case leftDown(x: Double, y: Double, holdable: Bool = true)
    case leftDragged(x: Double, y: Double)
    case leftUp
    case pressure(stage: Int, pressure: Double, transition: Double)
    case quickLook
    /// An event this app posted came back through the tap.
    case ownEvent
    /// The hold timer.
    case tick
  }
  /// What to send. current: the event that came in, as it is. held: the left down held back.
  /// heldUp: a left up where the held down was (closing a click the tap could not see end).
  /// middleDrag / middleUp: the current event turned into the middle button.
  /// middleUpSynth: a new middle up at the cursor (closing a middle press cut short).
  enum Out: Equatable { case current, held, heldUp, middleDown, middleDrag, middleUp, middleUpSynth }
  /// pass: let the event through. drop: swallow it.
  /// post: swallow it and post these, in this order, behind anything already posted.
  enum Verdict: Equatable { case pass, drop, post([Out]) }
  enum State: Equatable { case idle, holding, passthrough, middle }

  var firmness: Firmness = .normal
  /// A press held still this long without getting firm is a normal long press.
  var holdLimit = 0.6
  /// Moving further than this (points) while held is a drag.
  var slop = 4.0
  /// Posted events not yet back after this long are taken as lost.
  var flightLimit = 0.5

  private(set) var state = State.idle
  private(set) var inFlight = 0
  private(set) var downAt: (x: Double, y: Double, t: Double) = (0, 0, 0)
  private var lastPost = 0.0

  mutating func handle(_ input: Input, at t: Double) -> Verdict {
    if inFlight > 0 && t - lastPost > flightLimit { inFlight = 0 }
    switch input {
    case .ownEvent:
      if inFlight > 0 { inFlight -= 1 }
      return .pass
    case .tick:
      if state == .holding && t - downAt.t >= holdLimit {
        state = .passthrough
        return posted([.held], t)
      }
      return .pass
    default:
      break
    }
    var v = decide(input, t)
    // Something we posted is still on its way: a mouse event let straight through now would
    // overtake it (an up before its own down). So it gets posted too, and lines up behind.
    if inFlight > 0 && input.isMouse {
      if v == .pass { v = .post([.current]) }
    }
    if case .post(let outs) = v { return posted(outs, t) }
    return v
  }

  /// Steps aside at once (switched off, 1Password or Signal in front, app stuck, tap paused).
  /// Returns what to post so nothing is lost and no button is left down. buttonDown: whether
  /// the real button is down right now. Still down: the held down goes out and the real up
  /// follows later. Already up (the tap was paused and the up went past it): a whole click.
  mutating func flush(buttonDown: Bool) -> [Out] {
    defer { state = .idle; inFlight = 0 }
    switch state {
    case .holding: return buttonDown ? [.held] : [.held, .heldUp]
    case .middle: return [.middleUpSynth]
    case .idle, .passthrough: return []
    }
  }

  /// Whether pressure matters right now: only while a press is held or is a middle press.
  /// The rest of the time the tap does not even look at pressure events.
  var wantsPressure: Bool { state == .holding || state == .middle }

  private mutating func posted(_ outs: [Out], _ t: Double) -> Verdict {
    inFlight += outs.count
    lastPost = t
    return .post(outs)
  }

  private mutating func decide(_ input: Input, _ t: Double) -> Verdict {
    switch state {
    case .idle:
      if case .leftDown(let x, let y, let ok) = input, ok { hold(x, y, t); return .drop }
      return .pass

    case .holding:
      switch input {
      case .pressure(let s, let p, let tr):
        if firmness.reached(stage: s, pressure: p, transition: tr) { state = .middle; return .post([.middleDown]) }
        return .drop   // no pressure to the app while held, so it starts no Look Up preview
      case .quickLook:
        return .drop
      case .leftDragged(let x, let y):
        if hypot(x - downAt.x, y - downAt.y) > slop { state = .passthrough; return .post([.held, .current]) }
        return .drop
      case .leftUp:
        state = .idle
        return .post([.held, .current])
      case .leftDown:
        // A second down with no up (another device): give both back.
        state = .passthrough
        return .post([.held, .current])
      case .ownEvent, .tick:
        return .pass
      }

    case .passthrough:
      switch input {
      case .leftUp: state = .idle; return .pass
      // A down with no up between means an up was missed: this is a new press.
      case .leftDown(let x, let y, let ok):
        if !ok { return .pass }
        hold(x, y, t); return .drop
      default: return .pass
      }

    case .middle:
      switch input {
      // Posted as new events (not changed in place), so macOS routes them as the middle button.
      case .leftDragged: return .post([.middleDrag])
      case .leftUp: state = .idle; return .post([.middleUp])
      case .pressure, .quickLook: return .drop   // no Look Up on top of the middle click
      case .leftDown(let x, let y, let ok):
        if !ok { state = .passthrough; return .post([.middleUpSynth, .current]) }
        hold(x, y, t)
        return .post([.middleUpSynth])
      case .ownEvent, .tick: return .pass
      }
    }
  }

  private mutating func hold(_ x: Double, _ y: Double, _ t: Double) {
    state = .holding
    downAt = (x, y, t)
  }
}

extension ClickMachine.Input {
  var isMouse: Bool {
    switch self {
    case .leftDown, .leftDragged, .leftUp: return true
    default: return false
    }
  }
}

/// When to tear the taps down and make them again (pure, so it is unit tested).
/// 1 Nov 2026 on the developer's M4: after macOS paused the taps (user input) and they were switched back on,
/// the pressure tap kept saying it was on but delivered nothing, so every firm press was a normal
/// click. A fresh tap fixes that. Two triggers:
/// - macOS paused a tap (timeout or user input): rebuild soon. Both taps send the notice, so the
///   second joins the first; at most one rebuild every 5 s, and a later one is never dropped.
/// - Pressure went quiet: 3 browser clicks in a row with no pressure at all, after presses used to
///   carry it. Then 30 s apart at the least, doubling while it stays quiet (tap to click and a
///   switched off Force Click send no pressure either, so it never loops), back to 30 s once
///   pressure is seen again.
struct TapHealth {
  static let dryLimit = 3
  static let minGap = 5.0
  static let dryGap = 30.0
  static let dryGapMax = 600.0

  private(set) var pending = false
  private(set) var seenPressure = false
  private(set) var dry = 0
  private(set) var dryGap = TapHealth.dryGap
  private var lastRebuild = -Double.infinity
  private var lastDryRebuild = -Double.infinity

  /// macOS paused a tap. Returns how long to wait before rebuilding, nil if one is already coming.
  mutating func paused(at t: Double) -> Double? {
    guard !pending else { return nil }
    pending = true
    return max(0.3, lastRebuild + TapHealth.minGap - t)
  }

  /// A browser click ended (it was held for a firm press). pressures: how many pressure events it
  /// had. True means rebuild now.
  mutating func pressEnded(pressures: Int, at t: Double) -> Bool {
    if pressures > 0 { seenPressure = true; dry = 0; dryGap = TapHealth.dryGap; return false }
    guard seenPressure else { return false }   // never seen any: nothing to say it broke
    dry += 1
    guard !pending, dry >= TapHealth.dryLimit, t - lastDryRebuild >= dryGap else { return false }
    if lastDryRebuild > -Double.infinity { dryGap = min(dryGap * 2, TapHealth.dryGapMax) }
    lastDryRebuild = t
    pending = true
    return true
  }

  /// The taps were just made again.
  mutating func rebuilt(at t: Double) {
    pending = false
    lastRebuild = t
    dry = 0
  }
}
