import Foundation
import CoreGraphics
import AppKit
// Run: bash tests/island-blob-test.sh
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
// A fixed measure (no fonts): 5 points a letter at size 8.5, scaled with size; digits a little wider when bold.
let fake: BlobFit.Measure = { t, size, bold, digits in CGFloat(t.count) * size * (digits ? 0.62 : 0.55) }
let T = 1_763_024_400_000.0
func meet(_ title: String, in ms: Double, len: Double = 1_800_000, blob: Bool = true) -> TMeet {
  TMeet(id: "m1", title: title, start: T + ms, end: T + ms + len, from: T + ms - 900_000, link: nil, blob: blob)
}
let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)

let wMid0 = BlobFit.words(.meet(mode: "soon", m: meet("Weekly sync", in: 600_000)), now: T)!
// ---------- readable at a glance (PS 1.61: "the meeting time is TINY") ----------
for h in [30.0, 31, 32, 34, 37, 40, 48] {
  let w = BlobFit.words(.meet(mode: "soon", m: meet("Weekly sync with the team", in: 600_000)), now: T)!
  let l = BlobFit.layout(height: CGFloat(h), words: w, measure: fake)
  ok("height \(h): the name is at least 12 points and the time at least 14", l.sizes.title >= 12 && l.sizes.time >= 14 && l.sizes.time > l.sizes.title)
  ok("height \(h): never shorter than the island", l.height >= CGFloat(h))
  ok("height \(h): the two lines fit inside it, never cut", BlobFit.contentHeight(l.sizes) + 2 * BlobFit.padY <= l.height + 0.01)
  ok("height \(h): at most a few points taller than the island, so it still reads as joined", l.height - CGFloat(h) <= 5)
}
ok("the reference island (34) uses 14, 12 and 14 (the island timer's size for the time)", BlobFit.sizes(height: 34) == BlobFit.Sizes(icon: 14, title: 12, time: 14))
ok("the 1.60 sizes (7.5 and 8) are gone: never under 12 and 14, even on a tiny island", BlobFit.sizes(height: 12).title == 12 && BlobFit.sizes(height: 12).time == 14)
ok("a taller island gets bigger type, never smaller", BlobFit.sizes(height: 40).title >= BlobFit.sizes(height: 34).title && BlobFit.sizes(height: 40).time > BlobFit.sizes(height: 34).time)
ok("type stops growing at 1.3 times", BlobFit.sizes(height: 200) == BlobFit.sizes(height: 300) && BlobFit.sizes(height: 300).time == 18 && BlobFit.sizes(height: 300).title == 15.5)
for h in [36.0, 37, 40, 44, 48] { ok("island \(h): tall enough for the two lines, the blob is exactly its height", BlobFit.layout(height: CGFloat(h), words: wMid0, measure: fake).height == CGFloat(h)) }
ok("an island tall enough for the two lines: the blob is exactly its height", BlobFit.layout(height: 37, words: BlobFit.words(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T)!, measure: fake).height == 37)
ok("the resting pill (34): only 1 point taller", BlobFit.layout(height: 34, words: BlobFit.words(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T)!, measure: fake).height == 35)

// ---------- width ----------
let wMid = BlobFit.words(.meet(mode: "soon", m: meet("Weekly sync", in: 600_000)), now: T)!
let blobMid = BlobFit.layout(height: 34, words: wMid, measure: fake)
ok("the blob's width stays between its limits", blobMid.width >= BlobFit.widthMin && blobMid.width <= BlobFit.widthMax)
ok("the camera, the gap and the words fit across", 2 * BlobFit.padX + BlobFit.iconW(blobMid.sizes) + BlobFit.iconGap + max(ceil(fake("Weekly sync", 12, false, false)), ceil(fake(wMid.timeWide, 14, true, true))) <= blobMid.width)
let wLong = BlobFit.words(.meet(mode: "soon", m: meet("A very long meeting name about the quarterly planning of everything", in: 600_000)), now: T)!
let blobLong = BlobFit.layout(height: 34, words: wLong, measure: fake)
ok("a long name is shortened, the blob never grows past its maximum", blobLong.width == BlobFit.widthMax && blobLong.titleW != nil && blobLong.titleW! == BlobFit.textRoom(blobLong))
ok("a short name is shown whole", blobMid.titleW == nil)
let wTiny = BlobFit.words(.meet(mode: "soon", m: meet("1:1", in: 60_000)), now: T)!
ok("a tiny name does not make it thinner than the minimum", BlobFit.layout(height: 34, words: wTiny, measure: fake).width == BlobFit.widthMin)
ok("little room on the screen's side: never wider than the room (but the minimum holds)", BlobFit.layout(height: 34, words: wLong, room: 100, measure: fake).width == 100 && BlobFit.layout(height: 34, words: wLong, room: 10, measure: fake).width == BlobFit.widthMin)
ok("even at the minimum width the time fits beside the camera", BlobFit.textRoom(BlobFit.layout(height: 34, words: wTiny, measure: BlobFit.measure)) >= BlobFit.measure(wTiny.timeWide, 14, true, true))
ok("the corner is rounded in proportion to the height, never more than half the width", blobMid.radius == blobMid.height / 2.6 && BlobFit.layout(height: 12, words: wTiny, measure: fake).radius <= BlobFit.layout(height: 12, words: wTiny, measure: fake).width / 2)

// ---------- the words ----------
ok("soon: the name and the time to start", BlobFit.words(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T) == BlobFit.Words(title: "Sync", time: "10m", timeWide: BubbleFit.widestLeft(600_000)))
ok("join: Join and the time to start", BlobFit.words(.meet(mode: "join", m: meet("Sync", in: 90_000)), now: T)?.title == "Join" && BlobFit.words(.meet(mode: "join", m: meet("Sync", in: 90_000)), now: T)?.time == "2m")
ok("now: the name and the time left", BlobFit.words(.meet(mode: "now", m: meet("Sync", in: -600_000)), now: T)?.time == "20m left")
ok("the count down is measured at its widest so it never cuts", { let w = BlobFit.words(.meet(mode: "soon", m: meet("Sync", in: 3_000_000)), now: T)!; return BubbleFit.shapeW(w.timeWide) >= BubbleFit.shapeW(w.time) }())
ok("a stand-up count down or nothing is not a blob", BlobFit.words(.standSoon(at: T + 10_000), now: T) == nil && BlobFit.words(.none, now: T) == nil)

// ---------- where it goes ----------
let island = CGRect(x: 656, y: 982 - 37, width: 200, height: 37)   // Cocoa coordinates, at the top centre
let spotR = BlobFit.place(width: 70, island: island, screen: screen)
ok("it sits on the island's right end, the same bottom and top, so exactly its height", spotR.side == .right && spotR.frame.minY == island.minY && spotR.frame.maxY == island.maxY && spotR.frame.height == island.height)
ok("it nearly touches the island (blended in)", spotR.frame.minX - island.maxX == BlobFit.gap && BlobFit.gap < BubbleFit.gap)
let nearRight = CGRect(x: 1330, y: 982 - 37, width: 200, height: 37)
let spotL = BlobFit.place(width: 70, island: nearRight, screen: screen)
ok("no room on the right: the left end", spotL.side == .left && spotL.frame.maxX == nearRight.minX - BlobFit.gap && spotL.frame.minY == nearRight.minY)
let tiny = CGRect(x: 0, y: 0, width: 220, height: 400)
let spotB = BlobFit.place(width: 120, island: CGRect(x: 40, y: 360, width: 150, height: 34), screen: tiny)
ok("a tiny screen: just below the island, on screen, still the island's height", spotB.side == .below && spotB.frame.height == 34 && spotB.frame.minX >= tiny.minX + BlobFit.edge && spotB.frame.maxX <= tiny.maxX - BlobFit.edge)
ok("room is the bigger side", BlobFit.room(island: island, screen: screen) == screen.maxX - BlobFit.edge - (island.maxX + BlobFit.gap) || BlobFit.room(island: island, screen: screen) == island.minX - BlobFit.gap - (screen.minX + BlobFit.edge))
let f = BlobFit.fit(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T, island: island, screen: screen, measure: fake)
ok("fit: a blob meeting gets a layout and a spot of the island's height", f != nil && f!.0.height == island.height && f!.1.frame.height == island.height && f!.0.width == f!.1.frame.width)
let pillIsland = CGRect(x: 656, y: 982 - 6 - 34, width: 200, height: 34)
let f34 = BlobFit.fit(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T, island: pillIsland, screen: screen, measure: fake)!
ok("fit on the 34 point pill: a little taller, hanging from the island's top edge, beside it, never over it", f34.1.frame.height == f34.0.height && f34.1.frame.maxY == pillIsland.maxY && f34.1.frame.minY < pillIsland.minY && f34.1.frame.minX >= pillIsland.maxX && !f34.1.frame.intersects(pillIsland))
ok("fit on the 34 point pill: still on screen", screen.contains(f34.1.frame))
let spotTall = BlobFit.place(width: 70, height: 36, island: CGRect(x: 40, y: 360, width: 150, height: 34), screen: tiny)
ok("a taller blob below the island on a tiny screen: under it, never over it", spotTall.side == .below && spotTall.frame.maxY <= 360 && spotTall.frame.height == 36)
ok("fit: the long pill choice is left to the old pill", BlobFit.fit(.meet(mode: "soon", m: meet("Sync", in: 600_000, blob: false)), now: T, island: island, screen: screen, measure: fake) == nil)
ok("fit: not for a stand-up count down", BlobFit.fit(.standSoon(at: T + 10_000), now: T, island: island, screen: screen, measure: fake) == nil)
ok("fit: an island too small to read is left to the old pill", BlobFit.fit(.meet(mode: "soon", m: meet("Sync", in: 600_000)), now: T, island: CGRect(x: 0, y: 0, width: 100, height: 20), screen: screen, measure: fake) == nil)
// the real font measure runs and gives sensible widths
let real = BlobFit.measure("Weekly sync", 12, false, false)
ok("the real font measure gives a width", real > 40 && real < 120)
for (size, bold) in [(12.0, false), (14.0, true), (15.5, false), (18.0, true)] {
  let f = bold ? NSFont.monospacedDigitSystemFont(ofSize: CGFloat(size), weight: .bold) : NSFont.systemFont(ofSize: CGFloat(size), weight: .semibold)
  ok("the real \(size) point line is no taller than the room given to it", f.ascender - f.descender + f.leading <= CGFloat(size) * BlobFit.lineFactor + 0.01)
}
let realFit = BlobFit.layout(height: 34, words: wMid, measure: BlobFit.measure)
ok("with real fonts the name and the time fit beside the camera", realFit.width <= BlobFit.widthMax && BlobFit.measure(wMid.timeWide, realFit.sizes.time, true, true) <= BlobFit.textRoom(realFit) + 0.01 && realFit.titleW == nil)

// ---------- the page's style reaches the Mac ----------
let dict: [String: Any] = ["id": "a", "title": "Sync", "start": T + 600_000, "end": T + 2_400_000, "from": T]
func parse(_ style: Any?) -> TMeet? { var d = dict; if let style { d["style"] = style }; return TimersCore.from(["meet": d]).meet }
ok("style blob or missing: a blob", parse("blob")?.blob == true && parse(nil)?.blob == true && parse(7)?.blob == true)
ok("style pill: the old long pill", parse("pill")?.blob == false)

// ---------- the taller stand-up island ----------
ok("the figure's highest point is at least 8 points under the words", StandFaceLayout.clearance() >= 8 && StandFaceLayout.minClear >= 8)
ok("the old layout ran into the words (2 points of space, 5 of overshoot): the check would have caught it", (2 + 0 - StandFaceLayout.overshoot(70)) < StandFaceLayout.minClear)
ok("taller than before: 124 for the pill, 112 below the notch", StandFaceLayout.height(pill: true) > 124 && StandFaceLayout.height(pill: false) > 112)
ok("the pill is a little taller than the notch body, as before", StandFaceLayout.height(pill: true) - StandFaceLayout.height(pill: false) == StandFaceLayout.topPad(pill: true) - StandFaceLayout.topPad(pill: false))
ok("the whole stack includes the Ignore button", StandFaceLayout.height(pill: true) == 12 + 14 + 2 + StandFaceLayout.lift + 2 + 78 + 2 + StandFaceLayout.ignoreH + 14)
ok("the overshoot follows the man's size", StandFaceLayout.overshoot(70) == 6 && StandFaceLayout.overshoot(30) == 3 && StandFaceLayout.overshoot(100) == 8)
ok("his feet stay inside the island with room", StandFaceLayout.feetClear(pill: true) >= 10 && StandFaceLayout.feetClear(pill: false) >= 10)
ok("it is still narrower than the open island, rounder", StandFaceLayout.faceW == 236 && StandFaceLayout.radius == 36)
print(bad == 0 ? "ALL \(n) PASSED" : "\(bad) of \(n) FAILED")
exit(bad == 0 ? 0 : 1)
