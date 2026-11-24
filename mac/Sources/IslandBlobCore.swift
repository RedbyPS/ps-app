import Foundation
import CoreGraphics
import AppKit   // NSFont only, to measure words the way the island draws them (no window)

// PS 1.60 (item 24 and 25). Pure rules and numbers, no window, no sound: tests/island-blob-test.sh checks every size.
//
// 1. The meeting countdown as a small blob on the end of the island, blended into it. Since 1.61 the blue camera is on
//    the left and the name and a big time are on its right (see BlobFit). It is the island's height, or a little taller
//    when the island is too short for readable words, and its lines always fit inside it. The old long pill (IslandBubbleCore.swift
//    BubbleFit) stays, chosen in Settings (meetBubble.style).
//
// 2. The taller stand-up island (the developer: "the stick man's head and arms run into the 'Stand up 1:53' text"). The man is drawn
//    in a box; his head and raised hands reach about 2.3 points per 30 above that box's top, so the figure needs a clear
//    gap above the box. StandFaceLayout adds it and works out the island's height from the parts, so it can never run
//    into the words again.

enum BlobFit {
  // PS 1.61 (the developer: "the meeting time is TINY I can't read that"). The 1.60 blob stacked three lines (camera, name, time)
  // at 7 to 8 points inside the island's height. Now the camera sits on the left and two lines sit on its right: the
  // meeting's name at 12 points over the time, big and bold at 14 points (the island's own timer size). The type never
  // shrinks to fit: when the island is too short for the two lines, the blob is a little taller than the island, with
  // the same top edge, so it still reads as part of it.

  /// A blob's width stays between these (a short title is not made wider, a long one is shortened with "...").
  static let widthMin: CGFloat = 76, widthMax: CGFloat = 176
  /// An island shorter than this gets the long pill instead.
  static let minHeight: CGFloat = 30
  /// From the island: nearly touching, so it reads as part of it (the pill's gap is 6).
  static let gap: CGFloat = 2
  /// From the screen's side.
  static let edge: CGFloat = 4
  static let padX: CGFloat = 9, padY: CGFloat = 1.5
  /// Between the camera and the two lines.
  static let iconGap: CGFloat = 6
  /// Between the name and the time.
  static let spacing: CGFloat = 0
  /// A line of text is at most this many times its size tall (the system font is about 1.19 to 1.21).
  static let lineFactor: CGFloat = 1.22
  static let slack: CGFloat = 1.5
  /// The smallest the words may ever be (the developer must read them at a glance).
  static let titleMin: CGFloat = 12, timeMin: CGFloat = 14

  struct Sizes: Equatable { var icon: CGFloat; var title: CGFloat; var time: CGFloat }
  /// The type sizes for an island this tall: 14, 12 and 14 at least (the time at the island's own timer size); a taller
  /// island gets bigger type, up to 1.3 times, but only as big as still fits inside the island's height.
  static func sizes(height h: CGFloat) -> Sizes {
    let fits = (h - 2 * padY - spacing) / ((titleMin + timeMin) * lineFactor)
    let k = max(1, min(1.3, fits))
    func f(_ v: CGFloat) -> CGFloat { floor(v * k * 2 + 0.001) / 2 }
    return Sizes(icon: f(14), title: max(titleMin, f(titleMin)), time: max(timeMin, f(timeMin)))
  }
  /// The camera's box (video.fill is wider than it is tall).
  static func iconW(_ s: Sizes) -> CGFloat { ceil(s.icon * 1.35) }
  /// The two lines' total height: the name over the time.
  static func contentHeight(_ s: Sizes) -> CGFloat { (s.title + s.time) * lineFactor + spacing }
  /// The blob's height: the island's own, or a little more when the two lines need it (never cut).
  static func height(island h: CGFloat, sizes s: Sizes) -> CGFloat { max(h, ceil(contentHeight(s) + 2 * padY)) }

  /// What the blob says. title: the meeting's name ("Join" in the last 2 minutes, the name while it is on). time: the
  /// widest the count can show (the pill measures the same way, so a count down never cuts).
  struct Words: Equatable { var title: String; var time: String; var timeWide: String }
  static func words(_ b: TBubble, now: Double) -> Words? {
    guard case .meet(let mode, let m) = b else { return nil }
    switch mode {
    case "join": return Words(title: TimersCore.wJoin, time: TimersCore.shortLeft(max(0, m.start - now)), timeWide: BubbleFit.widestLeft(m.start - now))
    case "now": return Words(title: m.title, time: TimersCore.shortLeft(max(0, m.end - now)) + " " + BubbleFit.wLeftWord, timeWide: BubbleFit.widestLeft(m.end - now) + " " + BubbleFit.wLeftWord)
    default: return Words(title: m.title, time: TimersCore.shortLeft(max(0, m.start - now)), timeWide: BubbleFit.widestLeft(m.start - now))
    }
  }

  struct Layout: Equatable {
    var width: CGFloat
    var height: CGFloat
    var sizes: Sizes
    /// The title's own width when it had to be shortened (nil: shown whole).
    var titleW: CGFloat?
    var radius: CGFloat
  }
  typealias Measure = (_ text: String, _ size: CGFloat, _ bold: Bool, _ digits: Bool) -> CGFloat

  /// The blob for an island `height` tall: as wide as its words, within widthMin and widthMax (but never wider than `room`).
  static func layout(height: CGFloat, words w: Words, room: CGFloat = widthMax, measure: Measure) -> Layout {
    let s = sizes(height: height)
    let maxW = min(widthMax, max(widthMin, room))
    let titleW = ceil(measure(w.title, s.title, false, false)) + slack
    let timeW = ceil(measure(w.timeWide, s.time, true, true)) + slack
    let fixed = 2 * padX + iconW(s) + iconGap
    let width = min(maxW, max(widthMin, fixed + max(titleW, timeW)))
    let avail = width - fixed
    let h = self.height(island: height, sizes: s)
    return Layout(width: width, height: h, sizes: s, titleW: titleW > avail ? avail : nil, radius: min(h / 2.6, width / 2))
  }
  /// Room for the words beside the camera in a blob this wide.
  static func textRoom(_ l: Layout) -> CGFloat { l.width - 2 * padX - iconW(l.sizes) - iconGap }

  struct Spot: Equatable { var frame: CGRect; var side: BubbleFit.Side }
  /// On the island's end, with the island's top edge (so it hangs from the same line, a little lower when it is taller),
  /// on the side that has room (right first), else just below it on a tiny screen. Cocoa coordinates.
  static func place(width: CGFloat, height: CGFloat? = nil, island: CGRect, screen: CGRect) -> Spot {
    let h = max(island.height, height ?? island.height)
    let top = island.maxY - h
    let right = screen.maxX - edge - (island.maxX + gap), left = island.minX - gap - (screen.minX + edge)
    if width <= right { return Spot(frame: CGRect(x: island.maxX + gap, y: top, width: width, height: h), side: .right) }
    if width <= left { return Spot(frame: CGRect(x: island.minX - gap - width, y: top, width: width, height: h), side: .left) }
    let x = max(screen.minX + edge, min(island.maxX - width, screen.maxX - edge - width))
    return Spot(frame: CGRect(x: x, y: island.minY - gap - h, width: width, height: h), side: .below)
  }
  static func room(island: CGRect, screen: CGRect) -> CGFloat {
    max(screen.maxX - edge - (island.maxX + gap), island.minX - gap - (screen.minX + edge))
  }
  static func measure(_ text: String, _ size: CGFloat, _ bold: Bool, _ digits: Bool) -> CGFloat {
    let w: NSFont.Weight = bold ? .bold : .semibold
    let f = digits ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: w) : NSFont.systemFont(ofSize: size, weight: w)
    return (text as NSString).size(withAttributes: [.font: f]).width
  }
  /// Everything in one go for a meeting bubble: nil for anything else (the long pill and the stand-up count down keep BubbleFit).
  static func fit(_ b: TBubble, now: Double, island: CGRect, screen: CGRect, measure: Measure) -> (Layout, Spot)? {
    guard case .meet(_, let m) = b, m.blob, let w = words(b, now: now), island.height >= minHeight else { return nil }
    let l = layout(height: island.height, words: w, room: max(widthMin, room(island: island, screen: screen)), measure: measure)
    return (l, place(width: l.width, height: l.height, island: island, screen: screen))
  }
}

enum StandFaceLayout {
  static let faceW: CGFloat = 236, radius: CGFloat = 36, man: CGFloat = 70
  /// The words "Stand up 1:53" on top: their height, and the space under them.
  static let textH: CGFloat = 14, textSpacing: CGFloat = 2
  /// The little man's box: his size plus 4 above and below (the glow's room).
  static let manBox: CGFloat = man + 8
  /// Clear space, at least, between the words and the highest point of the figure (his head, or his hands when raised).
  static let minClear: CGFloat = 8
  static let ignoreH: CGFloat = 24, bottomPad: CGFloat = 14
  /// How far the head and raised hands reach above the figure's box (StandMan.draw: the hands reach 2.28 units above its
  /// top, the head 2.2, a unit being a thirtieth of the man's size). Rounded up.
  static func overshoot(_ man: CGFloat) -> CGFloat { ceil(man * 2.3 / 30) }
  static func topPad(pill: Bool) -> CGFloat { pill ? 12 : 6 }
  /// The empty space put between the words and the box, so the figure's highest point is `minClear` under the words.
  static var lift: CGFloat { minClear + overshoot(man) }
  /// The island's height for the stand-up: the whole pill, or the part below the notch.
  static func height(pill: Bool) -> CGFloat { topPad(pill: pill) + textH + textSpacing + lift + textSpacing + manBox + textSpacing + ignoreH + bottomPad }
  /// The distance from the bottom of the words to the figure's highest point.
  static func clearance() -> CGFloat { 2 * textSpacing + lift - overshoot(man) }
  /// The figure's lowest point (his feet) above the island's bottom edge.
  static func feetClear(pill: Bool) -> CGFloat { textSpacing + ignoreH + bottomPad + 4 }
}
