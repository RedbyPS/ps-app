import Foundation
import CoreGraphics
// Run: bash tests/island-start-test.sh. Where the Cake and Hatch scenes build the island before it has a window
// (Sources/IslandStartCore.swift, PS 1.74).
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool, _ info: String = "") { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)\(info.isEmpty ? "" : " (\(info))")") } }
func inside(_ r: CGRect, _ s: CGRect) -> Bool { s.insetBy(dx: -0.5, dy: -0.5).contains(r) }

// A 15 inch MacBook Air with its notch (as IslandPlace's own test), and a plain external screen to its right.
let air = IslandGeo.make(frame: CGRect(x: 0, y: 0, width: 1710, height: 1112), visible: CGRect(x: 0, y: 66, width: 1710, height: 1008),
                         inset: 37.5, left: CGRect(x: 0, y: 1074.5, width: 751, height: 37.5), right: CGRect(x: 959, y: 1074.5, width: 751, height: 37.5))
let ext = IslandGeo.make(frame: CGRect(x: 1710, y: -200, width: 2560, height: 1440), visible: CGRect(x: 1710, y: -200, width: 2560, height: 1415),
                         inset: 0, left: nil, right: nil)
let left = IslandGeo.make(frame: CGRect(x: -1920, y: 0, width: 1920, height: 1080), visible: CGRect(x: -1920, y: 0, width: 1920, height: 1055),
                          inset: 0, left: nil, right: nil)
let pill = IslandStartCore.pillDefault

// 1. the kept spot as settings hold it
ok("spot: two fractions", IslandStartCore.spot([0.1, 0.9]) == CGPoint(x: 0.1, y: 0.9))
ok("spot: numbers of any kind, clamped to the screen", IslandStartCore.spot([NSNumber(value: -2), NSNumber(value: 1)]) == CGPoint(x: 0, y: 1) && IslandStartCore.spot([2, 0.5]) == CGPoint(x: 1, y: 0.5))
ok("spot: home (none) and broken values are nil", [nil, [], [0.5], [0.1, 0.2, 0.3], ["a", "b"], [Double.nan, 0.5], [0.5, Double.infinity], "0.5,0.5"].allSatisfy { IslandStartCore.spot($0) == nil })

// 2. home with nothing remembered: nil, so each scene keeps its own guess round the notch (as before)
ok("home, nothing remembered: nil", IslandStartCore.start(spot: nil, geo: air, last: nil) == nil)

// 3. every moved spot: the pill on the right screen, at the right corner or edge, the same shape Island.hatchSpot gives
struct Spot { var name: String; var p: CGPoint; var check: (CGRect, CGRect) -> Bool }
let spots: [Spot] = [
  Spot(name: "top left", p: CGPoint(x: 0, y: 1), check: { r, s in r.minX <= s.minX + 6 && r.maxY >= s.maxY - 4 }),
  Spot(name: "top right", p: CGPoint(x: 1, y: 1), check: { r, s in r.maxX >= s.maxX - 6 && r.maxY >= s.maxY - 4 }),
  Spot(name: "bottom left corner", p: CGPoint(x: 0, y: 0), check: { r, s in r.minX <= s.minX + 6 && r.minY <= s.minY + 6 }),
  Spot(name: "bottom right corner", p: CGPoint(x: 1, y: 0), check: { r, s in r.maxX >= s.maxX - 6 && r.minY <= s.minY + 6 }),
  Spot(name: "left edge", p: CGPoint(x: 0, y: 0.5), check: { r, s in r.minX <= s.minX + 6 && abs(r.midY - s.midY) < 2 }),
  Spot(name: "right edge", p: CGPoint(x: 1, y: 0.5), check: { r, s in r.maxX >= s.maxX - 6 && abs(r.midY - s.midY) < 2 }),
  Spot(name: "bottom centre", p: CGPoint(x: 0.5, y: 0), check: { r, s in abs(r.midX - s.midX) < 2 && r.minY <= s.minY + 6 }),
  Spot(name: "middle of the screen", p: CGPoint(x: 0.5, y: 0.5), check: { r, s in abs(r.midX - s.midX) < 2 && abs(r.midY - s.midY) < 2 }),
]
for (gname, g) in [("the notch screen", air), ("a second screen on the right", ext), ("a second screen on the left", left)] {
  for sp in spots {
    let r = IslandStartCore.start(spot: sp.p, geo: g, last: nil)
    ok("\(sp.name) on \(gname): built there", r.map { inside($0, g.frame) && sp.check($0, g.frame) && $0.size == pill } ?? false, "\(String(describing: r))")
  }
}
// top centre spot on the notch screen: below the camera, never on it (IslandPlace.clamp)
if let r = IslandStartCore.start(spot: CGPoint(x: 0.5, y: 1), geo: air, last: nil) {
  ok("moved to the top centre on a notch screen: just below the camera", r.maxY <= air.frame.maxY - air.notchH - 3 && abs(r.midX - air.centerX) < 2)
} else { ok("moved to the top centre on a notch screen", false) }
// The same as IslandPlace gives once the island has its window (Island.hatchSpot's sum), spot by spot
let p = CGPoint(x: 0.12, y: 0.9)
let l = IslandPlace.moved(p, air, pillW: 330, pillH: 34)
let inner = IslandPlace.movedShape(anchor: l.anchor, w: 330, h: 34, pillW: 330, pillH: 34, up: false)
ok("the same shape Island.hatchSpot works out", IslandStartCore.start(spot: p, geo: air, last: nil) == CGRect(x: l.frame.minX + inner.minX, y: l.frame.maxY - inner.maxY, width: 330, height: 34))

// 4. the remembered rest: used only on the same screen at the same spot
let homeShape = CGRect(x: 705, y: 1044.5, width: 300, height: 67.5)
let homeRest = IslandRest(rect: homeShape, screen: air.frame, spot: nil, pill: pill)
ok("home, remembered on this screen: exactly the island last seen", IslandStartCore.start(spot: nil, geo: air, last: homeRest) == homeShape)
ok("home, remembered on another screen: nil (the scene's guess)", IslandStartCore.start(spot: nil, geo: ext, last: homeRest) == nil)
let movedShape = IslandStartCore.movedShape(spot: CGPoint(x: 0, y: 1), geo: air, pill: CGSize(width: 270, height: 28))
let movedRest = IslandRest(rect: movedShape, screen: air.frame, spot: CGPoint(x: 0, y: 1), pill: CGSize(width: 270, height: 28))
ok("moved, remembered at the same spot: exactly that (the compact pill)", IslandStartCore.start(spot: CGPoint(x: 0, y: 1), geo: air, last: movedRest) == movedShape)
ok("moved somewhere else since: the kept spot wins, in the remembered pill size", IslandStartCore.start(spot: CGPoint(x: 1, y: 0), geo: air, last: movedRest).map { $0.size == CGSize(width: 270, height: 28) && $0.maxX >= air.frame.maxX - 6 && $0.minY <= 6 } ?? false)
ok("moved, remembered at home: the kept spot wins", IslandStartCore.start(spot: CGPoint(x: 0, y: 0), geo: air, last: homeRest).map { $0.minX <= 6 && $0.minY <= 6 } ?? false)
ok("put back home since: the old moved rest is not used", IslandStartCore.start(spot: nil, geo: air, last: movedRest) == nil)
ok("moved, the island now on a second screen: the spot on that screen", IslandStartCore.start(spot: CGPoint(x: 0, y: 1), geo: ext, last: movedRest).map { inside($0, ext.frame) && $0.minX <= ext.frame.minX + 6 } ?? false)
ok("a tiny spot change (rounding) still counts as the same spot", IslandStartCore.fits(movedRest, screen: air.frame, spot: CGPoint(x: 0.0001, y: 0.9999)))
ok("a rest that is not on the screen any more is not used", !IslandStartCore.fits(IslandRest(rect: CGRect(x: 5000, y: 5000, width: 10, height: 10), screen: air.frame, spot: nil, pill: pill), screen: air.frame, spot: nil))
// saved and read back; anything broken is nil
let d = IslandStartCore.encode(movedRest)
ok("the rest is kept and read back", IslandStartCore.decode(d) == movedRest)
ok("nothing kept, or broken bytes: nil", IslandStartCore.decode(nil) == nil && IslandStartCore.decode(Data("{}".utf8)) == nil && IslandStartCore.decode("text") == nil)
var zero = movedRest; zero.w = 0
ok("a rest with no size: nil", IslandStartCore.decode(IslandStartCore.encode(zero)) == nil)

// 5. the side the pieces come in from, for every spot, in the page's own coordinates (HatchCore.pageRect)
func from(_ r: CGRect?, _ g: IslandGeo) -> [String: Double] { IslandStartCore.approach(HatchCore.pageRect(r, screen: g.frame), screen: g.frame.size) }
ok("home: straight up from below", from(homeShape, air) == ["x": 0, "y": 1])
ok("nothing known: straight up from below", IslandStartCore.approach(nil, screen: CGSize(width: 1710, height: 1112)) == ["x": 0, "y": 1])
for (gname, g) in [("the notch screen", air), ("a second screen", ext)] {
  let at = { (x: Double, y: Double) in from(IslandStartCore.start(spot: CGPoint(x: x, y: y), geo: g, last: nil), g) }
  let tl = at(0, 1), tr = at(1, 1), bl = at(0, 0), br = at(1, 0), le = at(0, 0.6), re = at(1, 0.6), bc = at(0.5, 0)
  ok("top left on \(gname): from the right, from below", tl["x"]! >= 0.9 && tl["y"] == 1, "\(tl)")
  ok("top right on \(gname): from the left, from below", tr["x"]! <= -0.9 && tr["y"] == 1, "\(tr)")
  ok("bottom left on \(gname): from the right, from above", bl["x"]! >= 0.9 && bl["y"] == -1, "\(bl)")
  ok("bottom right on \(gname): from the left, from above", br["x"]! <= -0.9 && br["y"] == -1, "\(br)")
  ok("left edge on \(gname): from the right", le["x"]! >= 0.9, "\(le)")
  ok("right edge on \(gname): from the left", re["x"]! <= -0.9, "\(re)")
  ok("bottom centre on \(gname): straight down from above", bc == ["x": 0, "y": -1], "\(bc)")
}
let mid = IslandStartCore.approach(["x": 400, "y": 10, "w": 330, "h": 34], screen: CGSize(width: 1710, height: 1112))
ok("a little left of the middle: from the right, gently", mid["x"]! > 0 && mid["x"]! < 1 && mid["y"] == 1, "\(mid)")
ok("broken page values: the usual", IslandStartCore.approach(["x": 1], screen: CGSize(width: 1710, height: 1112)) == ["x": 0, "y": 1] && IslandStartCore.approach(["x": 1, "y": 1, "w": 1, "h": 1], screen: .zero) == ["x": 0, "y": 1])
// the outline's shape: the notch shape only at the top edge
ok("the notch shape at home, a pill when moved", CakeCore.notchShaped(HatchCore.pageRect(homeShape, screen: air.frame)) && !CakeCore.notchShaped(HatchCore.pageRect(IslandStartCore.start(spot: CGPoint(x: 0, y: 1), geo: air, last: nil), screen: air.frame)))

print("\(n - bad)/\(n) passed")
exit(bad == 0 ? 0 : 1)
