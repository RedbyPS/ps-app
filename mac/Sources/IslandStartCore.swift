import Foundation
import CoreGraphics

// PS 1.74 (the developer, 22 Nov 2026): the Cake boot animation and the Hatch update scene build the island WHERE THE PERSON
// PUT IT. Before, they built it at the top centre even when it was moved (top left, a corner, the bottom): at a start the
// island has no window yet, Island.swift reads the kept spot (island.spot) only when the page first sends the island's
// state, seconds after the scene starts, so restShape() and hatchSpot() were nil and both scenes fell back to their top
// centre guess. Now Island.startShape() asks these rules, which need neither a window nor the page:
//  1. the last resting shape this Mac saw (UserDefaults island.lastRest), when it was on the same screen and at the same
//     kept spot as now: exactly the island the person last saw, its look and size included;
//  2. else the kept spot read straight from settings, turned into the moved pill's shape with IslandPlace (the pill's size
//     from the last rest when known, else the usual 330 x 34);
//  3. else nil: the island is at home and nothing is known of its shape, so each scene keeps its own guess round the notch.
// And which way the scene's pieces come in from: from the side facing the island, so an island at the bottom or at an edge
// is never built out of pieces that fly in from off the screen. Pure values only (tests/island-start-test.sh).

/// The island at rest as last seen on this Mac: its shape and the screen it was on (bottom left origin, points, as AppKit
/// gives them), the kept spot it sat at (nil at home) and the pill's size.
struct IslandRest: Codable, Equatable {
  var x: Double, y: Double, w: Double, h: Double
  var sx: Double, sy: Double, sw: Double, sh: Double
  var spot: [Double]?
  var pw: Double, ph: Double

  var rect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
  var screen: CGRect { CGRect(x: sx, y: sy, width: sw, height: sh) }
  init(rect r: CGRect, screen s: CGRect, spot p: CGPoint?, pill: CGSize) {
    x = Double(r.minX); y = Double(r.minY); w = Double(r.width); h = Double(r.height)
    sx = Double(s.minX); sy = Double(s.minY); sw = Double(s.width); sh = Double(s.height)
    spot = p.map { [Double($0.x), Double($0.y)] }
    pw = Double(pill.width); ph = Double(pill.height)
  }
}

enum IslandStartCore {
  static let restKey = "island.lastRest"
  /// The usual pill (IslandModel.pillW and pillH without the compact look).
  static let pillDefault = CGSize(width: 330, height: 34)

  /// The kept spot as settings hold it (island.spot: two fractions of the screen), or nil (home, or anything broken).
  static func spot(_ stored: Any?) -> CGPoint? {
    guard let a = stored as? [Any], a.count == 2 else { return nil }
    let n = a.compactMap { ($0 as? NSNumber)?.doubleValue }
    guard n.count == 2, n.allSatisfy({ $0.isFinite }) else { return nil }
    return CGPoint(x: min(1, max(0, n[0])), y: min(1, max(0, n[1])))
  }

  static func encode(_ r: IslandRest) -> Data? { try? JSONEncoder().encode(r) }
  static func decode(_ d: Any?) -> IslandRest? {
    guard let d = d as? Data, let r = try? JSONDecoder().decode(IslandRest.self, from: d) else { return nil }
    let all = [r.x, r.y, r.w, r.h, r.sx, r.sy, r.sw, r.sh, r.pw, r.ph]
    guard all.allSatisfy({ $0.isFinite }), r.w > 0, r.h > 0, r.sw > 0, r.sh > 0, r.pw > 0, r.ph > 0 else { return nil }
    return r
  }

  /// Is the remembered rest still the island's place: the same screen (its frame, to a point) and the same kept spot?
  static func fits(_ r: IslandRest, screen s: CGRect, spot p: CGPoint?) -> Bool {
    let same = abs(r.screen.minX - s.minX) < 1 && abs(r.screen.minY - s.minY) < 1 && abs(r.screen.width - s.width) < 1 && abs(r.screen.height - s.height) < 1
    guard same, s.intersects(r.rect) else { return false }
    switch (r.spot, p) {
    case (nil, nil): return true
    case (let a?, let b?): return a.count == 2 && abs(a[0] - Double(b.x)) < 0.0005 && abs(a[1] - Double(b.y)) < 0.0005
    default: return false
    }
  }

  /// The moved pill's shape on screen for a kept spot (bottom left origin, points), as Island.hatchSpot() works it out
  /// once the island has a window: the panel round the pill (IslandPlace.moved) and the pill inside it.
  static func movedShape(spot p: CGPoint, geo g: IslandGeo, pill: CGSize) -> CGRect {
    let l = IslandPlace.moved(p, g, pillW: pill.width, pillH: pill.height)
    let r = IslandPlace.movedShape(anchor: l.anchor, w: pill.width, h: pill.height, pillW: pill.width, pillH: pill.height, up: IslandPlace.opensUp(p))
    return CGRect(x: l.frame.minX + r.minX, y: l.frame.maxY - r.maxY, width: r.width, height: r.height)
  }

  /// Where the island will be at a start, before it has a window (see the top of this file), or nil (at home, unknown).
  static func start(spot p: CGPoint?, geo g: IslandGeo, last: IslandRest?) -> CGRect? {
    if let r = last, fits(r, screen: g.frame, spot: p) { return r.rect }
    guard let p else { return nil }
    let pill = last.map { CGSize(width: $0.pw, height: $0.ph) } ?? pillDefault
    return movedShape(spot: p, geo: g, pill: pill)
  }

  /// Which way the scene's pieces come in from, from the island's place in the page (top left origin) on a screen of
  /// this size: x from -1 (they come from the left) to 1 (from the right), 0 straight across; y 1 from below (the island
  /// is in the top half: the usual), -1 from above (it is in the lower half). Pieces always come from the screen's
  /// inside, never from beyond the edge the island sits at.
  static func approach(_ t: [String: Double]?, screen: CGSize) -> [String: Double] {
    guard let t, let x = t["x"], let y = t["y"], let w = t["w"], let h = t["h"], screen.width > 0, screen.height > 0 else { return ["x": 0, "y": 1] }
    let cx = (x + w / 2) / Double(screen.width), cy = (y + h / 2) / Double(screen.height)
    // Within the middle third across: straight. Nearer a side: from the other side, more the nearer it is.
    let off = cx - 0.5
    let sx = abs(off) <= 1.0 / 6 ? 0 : (off < 0 ? 1.0 : -1.0) * min(1, (abs(off) - 1.0 / 6) / (1.0 / 3) + 0.5)
    return ["x": (sx * 100).rounded() / 100, "y": cy > 0.5 ? -1 : 1]
  }
}
