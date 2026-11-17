import Foundation
import CoreGraphics
import AppKit   // NSFont only, to measure words the way the island draws them (no window)

// V1.59, two island asks from the developer. Pure rules only (Foundation, CoreGraphics, NSFont to measure), no window, no sound, so
// tests/island-bubble-test.sh can check every number while someone uses the Mac.
//
// 1. The meeting bubble beside the island showed "16m le" (the developer, 14 Nov 2026: "The meeting time attached to the dynamic
//    island is cut off a bit. Fix it."). It was drawn inside the island's own 480 point window, which leaves about 65
//    points beside a centred pill, and the words were wider than that. Now the bubble has its own small window, as wide
//    as its words measure (BubbleFit.size), on the side of the island that has room (BubbleFit.place). The time is
//    measured at the widest it can get before the bubble changes ("1m" becomes "59s"), so a count down never cuts. Only
//    a long meeting name is ever shortened, and then with "..." at its end: " in", the time and "left" always show whole.
//
// 2. Stand-up reminders: the first stand-up ever asks once whether to keep them (StandAsk). Seen is kept in the person's
//    synced settings (web settings.standAsk); the page sends stand.ask while it is not set.

enum BubbleFit {
  enum Weight: Equatable { case semibold, bold, heavy }
  /// One piece of the bubble's words. digits: drawn with monospaced digits (the counting time). squeeze: the meeting's
  /// name, the only piece that may be shortened.
  struct Piece: Equatable {
    var text: String; var size: CGFloat; var weight: Weight; var digits = false; var squeeze = false
  }
  /// Measures one piece the way the island draws it (Island: NSFont.systemFont, monospaced digits for the time).
  typealias Measure = (Piece) -> CGFloat

  static let h: CGFloat = 24                // the bubble's height (IslandTimerLayout.bubbleH)
  static let padX: CGFloat = 9              // inside the capsule, each side
  static let spacing: CGFloat = 5           // between pieces
  static let iconW: CGFloat = 13            // the camera or standing figure, in a fixed box
  static let slack: CGFloat = 2             // per piece, so rounding never cuts a letter
  static let gap: CGFloat = 6               // from the island
  static let edge: CGFloat = 4              // from the screen's side
  static let maxW: CGFloat = 260            // the longest a bubble gets (a long name is shortened to fit)
  static let minName: CGFloat = 28          // a name never squeezed below this; with less room it goes

  /// What the bubble says, piece by piece, for the time now (ms since 1970). The time pieces hold the widest the count
  /// down can show while this bubble lasts (widestLeft), so the measured width holds until the bubble changes.
  static func pieces(_ b: TBubble, now: Double) -> [Piece] {
    switch b {
    case .none: return []
    case .standSoon(let at):
      return [Piece(text: wider(String(max(0, Int(((at - now) / 1000).rounded(.up)))), "15"), size: 12, weight: .heavy, digits: true)]
    case .meet(let mode, let m):
      if mode == "join" {
        return [Piece(text: TimersCore.wJoin, size: 11.5, weight: .heavy), Piece(text: widestLeft(m.start - now), size: 11, weight: .bold, digits: true)]
      }
      if mode == "now" {
        return [Piece(text: widestLeft(m.end - now), size: 11.5, weight: .bold, digits: true), Piece(text: wLeftWord, size: 11, weight: .semibold)]
      }
      return [Piece(text: m.title, size: 11, weight: .semibold, squeeze: true), Piece(text: wInWord, size: 11, weight: .semibold),
              Piece(text: widestLeft(m.start - now), size: 11.5, weight: .bold, digits: true)]
    }
  }
  static let wLeftWord = "left", wInWord = "in"
  /// PS 1.66: the meeting's right click menu (the bubble, and its row in the open island): this meeting only goes away.
  static let wHide = "Hide this meeting"

  /// The widest TimersCore.shortLeft can show from `ms` down to zero. Digits are monospaced, so the width only depends
  /// on the shape: "59s" is wider than "1m", "59m" wider than "5m", "1h 59m" wider than "1h 5m".
  static func widestLeft(_ ms: Double) -> String {
    let now = TimersCore.shortLeft(max(0, ms))
    var c = [now]
    if ms > 1_000 { c.append("59s") }
    if ms > 60_000 { c.append(ms > 600_000 ? "59m" : "9m") }
    let m = Int((ms / 60_000).rounded(.up))
    if m >= 60 { c.append("\(m / 60)h 59m") }
    return c.max { shapeW($0) < shapeW($1) } ?? now
  }
  /// The wider of two counts by shape (letters, digits as one width).
  private static func wider(_ a: String, _ b: String) -> String { shapeW(a) >= shapeW(b) ? a : b }
  /// A rough width by shape only, to pick the widest candidate: every digit the same, a space narrower.
  static func shapeW(_ s: String) -> Int { s.reduce(0) { $0 + ($1.isNumber ? 10 : $1 == " " ? 4 : 11) } }

  struct Size: Equatable {
    var width: CGFloat
    /// The meeting name's own width when it had to be shortened (nil: shown whole, or no name).
    var nameW: CGFloat?
    /// The name left out entirely (too little room even for a short "...").
    var noName = false
  }
  /// The bubble's width for its pieces, never over `room` (the name gives way first; the rest always shows whole).
  static func size(_ ps: [Piece], room: CGFloat = maxW, measure: Measure) -> Size {
    guard !ps.isEmpty else { return Size(width: 0) }
    let room = min(room, maxW)
    let ws = ps.map { ceil(measure($0)) + slack }
    let fixed = 2 * padX + iconW + spacing * CGFloat(ps.count) + zip(ps, ws).filter { !$0.0.squeeze }.reduce(0) { $0 + $1.1 }
    guard let i = ps.firstIndex(where: { $0.squeeze }) else { return Size(width: fixed) }
    let name = ws[i]
    if fixed + name <= room { return Size(width: fixed + name) }
    let left = room - fixed
    if left >= minName { return Size(width: room, nameW: left) }
    return Size(width: fixed - spacing, noName: true)   // no name: one gap fewer
  }

  enum Side: Equatable { case right, left, below }
  struct Spot: Equatable { var frame: CGRect; var side: Side }
  /// Where the bubble goes on screen (Cocoa coordinates, bottom left origin): beside the island's right side when it
  /// fits there, else its left side, else (a tiny screen) just below the island, lined up with its right end and kept
  /// on screen. `island` is the island's shape on screen, `y` the bubble's bottom beside it.
  static func place(width: CGFloat, island: CGRect, y: CGFloat, screen: CGRect) -> Spot {
    let right = screen.maxX - edge - (island.maxX + gap), left = island.minX - gap - (screen.minX + edge)
    if width <= right { return Spot(frame: CGRect(x: island.maxX + gap, y: y, width: width, height: h), side: .right) }
    if width <= left { return Spot(frame: CGRect(x: island.minX - gap - width, y: y, width: width, height: h), side: .left) }
    let x = max(screen.minX + edge, min(island.maxX - width, screen.maxX - edge - width))
    return Spot(frame: CGRect(x: x, y: island.minY - gap - h, width: width, height: h), side: .below)
  }
  /// The room on the side that has more of it (the width to size against when neither side fits the whole).
  static func room(island: CGRect, screen: CGRect) -> CGFloat {
    max(screen.maxX - edge - (island.maxX + gap), island.minX - gap - (screen.minX + edge))
  }
  /// The island's own measure: the system font at the piece's size and weight, monospaced digits for the time.
  static func measure(_ p: Piece) -> CGFloat {
    let w: NSFont.Weight = p.weight == .heavy ? .heavy : p.weight == .bold ? .bold : .semibold
    let f = p.digits ? NSFont.monospacedDigitSystemFont(ofSize: p.size, weight: w) : NSFont.systemFont(ofSize: p.size, weight: w)
    return (p.text as NSString).size(withAttributes: [.font: f]).width
  }
  /// Everything above in one go: the size for the room there is, and its spot.
  static func fit(_ b: TBubble, now: Double, island: CGRect, y: CGFloat, screen: CGRect, measure: Measure) -> (Size, Spot)? {
    let ps = pieces(b, now: now)
    guard !ps.isEmpty else { return nil }
    var s = size(ps, measure: measure)
    let r = room(island: island, screen: screen)
    if s.width > r {
      let squeezed = size(ps, room: r, measure: measure)
      // Shortened only when that makes it fit beside the island; otherwise it goes below, as wide as the screen allows.
      s = squeezed.width <= r ? squeezed : size(ps, room: screen.width - 2 * edge, measure: measure)
    }
    return (s, place(width: s.width, island: island, y: y, screen: screen))
  }
}

// ---------- the first stand-up asks once ----------
enum StandAsk {
  static let title = "Do you want to turn stand-up reminders off?"
  static let turnOff = "Turn off", seeSettings = "See settings", keep = "Keep them on"
  /// How long after the island has grown for the stand-up the question comes out of it.
  static let delay: Double = 1.4
  enum Answer: String { case seen, off, settings, keep }
  /// See settings: the Tab list's Settings on the Stand-up reminders tab (web views/SettingsScreen.tsx
  /// __psOpenSettings takes the tab since V1.59; an older page opens its usual Settings).
  static let settingsJS = "(window.__psOpenSettings && window.__psOpenSettings('standup'))"
  /// Ask now? Only during a real stand-up (never Try it now), while the person has never seen it (the page says so with
  /// stand.ask), the island is on screen, and it has not been asked since PS started (the page's answer may still be
  /// on its way).
  static func due(_ t: TimersIn, middle: TMiddle, onScreen: Bool, askedThisRun: Bool) -> Bool {
    guard let s = t.stand, s.ask, !s.test, !askedThisRun, onScreen, case .stand(let at, _) = middle else { return false }
    return at == s.at
  }
  /// Close it by itself? When the stand-up is over (it then counts as seen, it was on screen).
  static func over(middle: TMiddle) -> Bool { !middle.isStand }
}
