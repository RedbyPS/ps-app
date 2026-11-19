// Offline test for Sources/IslandPlace.swift (V1.44, the island over full screen apps): where the notch is, the menu
// bar height, full screen or not, and where the island's panel goes. Never starts PS, never opens a window.
//   mkdir -p build/islandplace && cp tests/island-place-test.swift build/islandplace/main.swift && swiftc build/islandplace/main.swift Sources/IslandPlace.swift -o build/islandplace/test && build/islandplace/test
import Foundation
import CoreGraphics
import AppKit

var fails = 0, count = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { count += 1; print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty || ok ? "" : " (\(info))")"); if !ok { fails += 1 } }
func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.01 }

// The developer's 15 inch MacBook Air as macOS reports it (9 Nov 2026): 1710 x 1112, the Dock 66 high at the bottom, menu bar 38,
// camera inset 37.5, clear strips 751 wide either side of a 208 point notch.
let redFrame = CGRect(x: 0, y: 0, width: 1710, height: 1112)
let redVisible = CGRect(x: 0, y: 66, width: 1710, height: 1008)
let redL = CGRect(x: 0, y: 1074.5, width: 751, height: 37.5), redR = CGRect(x: 959, y: 1074.5, width: 751, height: 37.5)
let red = IslandGeo.make(frame: redFrame, visible: redVisible, inset: 37.5, left: redL, right: redR)

// MARK: the notch, read from the screen's numbers
check("normal-notch-found", red.notch && near(red.notchW, 208) && near(red.notchH, 37.5))
check("normal-notch-centre", near(red.centerX, 855) && near(red.notchLeft, 751) && near(red.leftW, 751))
check("normal-menu-height", near(red.menuH, 38), "\(red.menuH)")

// Full screen: the menu bar is hidden, the visible frame reaches the top. The menu height stays the notch's (no jump).
let redFull = IslandGeo.make(frame: redFrame, visible: redFrame, inset: 37.5, left: redL, right: redR)
check("fullscreen-menu-height-no-jump", near(redFull.menuH, 38), "\(redFull.menuH)")
check("fullscreen-same-notch", redFull.notch == red.notch && redFull.notchLeft == red.notchLeft && redFull.centerX == red.centerX)

// Menu bar set to hide on a screen without a notch: the usual 24, as before.
let plain = IslandGeo.make(frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 0, width: 1440, height: 900), inset: 0, left: nil, right: nil)
check("menu-hidden-no-notch-24", near(plain.menuH, 24) && !plain.notch && near(plain.centerX, 720))
let plainShown = IslandGeo.make(frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 70, width: 1440, height: 805), inset: 0, left: nil, right: nil)
check("menu-shown-no-notch-25", near(plainShown.menuH, 25))

// Second display: the MacBook placed right of a main 1920 x 1080 display, then left of it. macOS may give the clear
// strips relative to the screen or in global points; both land on the same notch.
for (name, x) in [("right", CGFloat(1920)), ("left", CGFloat(-1710))] {
  let f = redFrame.offsetBy(dx: x, dy: 0), v = redVisible.offsetBy(dx: x, dy: 0)
  let local = IslandGeo.make(frame: f, visible: v, inset: 37.5, left: redL, right: redR)
  let global = IslandGeo.make(frame: f, visible: v, inset: 37.5, left: redL.offsetBy(dx: x, dy: 0), right: redR.offsetBy(dx: x, dy: 0))
  check("second-display-\(name)-local", near(local.notchLeft, x + 751) && near(local.centerX, x + 855), "\(local.notchLeft)")
  check("second-display-\(name)-global", near(global.notchLeft, x + 751) && near(global.centerX, x + 855), "\(global.notchLeft)")
}

// MARK: full screen or not (window list coordinates, top left origin)
let t = IslandPlace.cgRect(redFrame, primaryH: 1112)
check("cg-rect-main", t == CGRect(x: 0, y: 0, width: 1710, height: 1112))
let below = CGRect(x: 0, y: 37.5, width: 1710, height: 1074.5)          // a full screen app below the notch
let whole = CGRect(x: 0, y: 0, width: 1710, height: 1112)               // a browser over the whole screen
let zoomed = CGRect(x: 0, y: 38, width: 1710, height: 1008)             // a big window above the Dock (the developer's Claude)
let tall = CGRect(x: 0, y: 38, width: 1710, height: 1074)               // a big window down to the bottom (no Dock)
let toolbar = CGRect(x: 0, y: 37.5, width: 1710, height: 90)            // a browser's own full screen toolbar window
check("kind-below-notch", IslandPlace.kind([toolbar, below], screen: t, inset: 37.5) == .belowNotch)
check("kind-whole", IslandPlace.kind([toolbar, whole], screen: t, inset: 37.5) == .whole)
check("kind-whole-wins", IslandPlace.kind([below, whole], screen: t, inset: 37.5) == .whole)
check("kind-zoomed-window-not", IslandPlace.kind([zoomed], screen: t, inset: 37.5) == .none)
check("kind-small-window-not", IslandPlace.kind([CGRect(x: 455, y: 242, width: 800, height: 600)], screen: t, inset: 37.5) == .none)
check("kind-no-notch-below-not", IslandPlace.kind([below], screen: t, inset: 0) == .none)
check("kind-tall-looks-like-full", IslandPlace.kind([tall], screen: t, inset: 37.5) == .belowNotch)

// The menu bar decides between a full screen app and a big ordinary window.
let menuShown = IslandPlace.BarWindow(bounds: CGRect(x: 0, y: 0, width: 1710, height: 38), name: "Menubar")
let menuUp = IslandPlace.BarWindow(bounds: CGRect(x: 0, y: -38, width: 1710, height: 38), name: "Menubar")
let backstop = IslandPlace.BarWindow(bounds: CGRect(x: 0, y: 0, width: 1710, height: 38), name: "Backstop Menubar")
let noName = IslandPlace.BarWindow(bounds: CGRect(x: 0, y: 0, width: 1710, height: 38), name: nil)
let otherScreen = IslandPlace.BarWindow(bounds: CGRect(x: 1710, y: 0, width: 1920, height: 25), name: "Menubar")
check("menu-shown", IslandPlace.menuBar([menuShown], screen: t) == .shown)
check("menu-gone-is-hidden", IslandPlace.menuBar([], screen: t) == .hidden)
check("menu-slid-up-is-hidden", IslandPlace.menuBar([menuUp], screen: t) == .hidden)
check("menu-backstop-only-is-hidden", IslandPlace.menuBar([backstop], screen: t) == .hidden)
check("menu-other-display-is-hidden-here", IslandPlace.menuBar([otherScreen], screen: t) == .hidden)
check("menu-no-names-unknown", IslandPlace.menuBar([noName], screen: t) == .unknown)
check("menu-visible-frame-at-top-is-hidden", IslandPlace.menuBar([menuShown], screen: t, visibleReachesTop: true) == .hidden)

check("decide-full-screen", IslandPlace.decide(.belowNotch, menu: .hidden, pointerAtTop: false, previous: .none) == .belowNotch)
check("decide-browser-whole", IslandPlace.decide(.whole, menu: .hidden, pointerAtTop: false, previous: .none) == .whole)
check("decide-big-window-on-desktop", IslandPlace.decide(.belowNotch, menu: .shown, pointerAtTop: false, previous: .none) == .none)
check("decide-big-window-after-full-screen", IslandPlace.decide(.belowNotch, menu: .shown, pointerAtTop: false, previous: .belowNotch) == .none)
check("decide-menu-pulled-down-keeps", IslandPlace.decide(.belowNotch, menu: .shown, pointerAtTop: true, previous: .belowNotch) == .belowNotch)
check("decide-pointer-at-top-on-desktop", IslandPlace.decide(.belowNotch, menu: .shown, pointerAtTop: true, previous: .none) == .none)
check("decide-unknown-trusts-windows", IslandPlace.decide(.belowNotch, menu: .unknown, pointerAtTop: false, previous: .none) == .belowNotch)
check("decide-no-window", IslandPlace.decide(.none, menu: .hidden, pointerAtTop: true, previous: .whole) == .none)

check("pointer-at-top", IslandPlace.pointerAtTop(CGPoint(x: 300, y: 1111), screen: redFrame, band: 38))
check("pointer-in-band", IslandPlace.pointerAtTop(CGPoint(x: 300, y: 1080), screen: redFrame, band: 38))
check("pointer-below-band", !IslandPlace.pointerAtTop(CGPoint(x: 300, y: 1000), screen: redFrame, band: 38))
check("pointer-other-display", !IslandPlace.pointerAtTop(CGPoint(x: 2000, y: 1111), screen: redFrame, band: 38))

check("place-bar", IslandPlace.place(.belowNotch, notch: true, menuAlways: false, menuDown: false) == .bar)
check("place-whole-bar", IslandPlace.place(.whole, notch: true, menuAlways: false, menuDown: false) == .bar)
check("place-menu-down-drops", IslandPlace.place(.whole, notch: true, menuAlways: false, menuDown: true) == .dropped)
check("place-no-notch-as-desktop", IslandPlace.place(.whole, notch: false, menuAlways: false, menuDown: false) == .off)
check("place-menu-always-as-desktop", IslandPlace.place(.belowNotch, notch: true, menuAlways: true, menuDown: false) == .off)
check("place-desktop", IslandPlace.place(.none, notch: true, menuAlways: false, menuDown: false) == .off)
check("place-move-off-stays", IslandPlace.place(.whole, notch: true, menuAlways: false, menuDown: false, move: false) == .off)
check("place-move-off-menu-down-stays", IslandPlace.place(.belowNotch, notch: true, menuAlways: false, menuDown: true, move: false) == .off)
check("place-move-on-default", IslandPlace.place(.whole, notch: true, menuAlways: false, menuDown: false, move: true) == .bar)

// MARK: the panel's frame
let W = IslandPlace.panelW, H = IslandPlace.panelH
let home = IslandPlace.frame(.off, red, pos: nil, pillW: 330, pillH: 34)
check("normal-home-top-centre", near(home.midX, 855) && near(home.maxY, 1112) && near(home.width, W) && near(home.height, H))
let bar = IslandPlace.frame(.bar, red, pos: nil, pillW: 330, pillH: 34)
let barW = IslandPlace.barW(red)
check("bar-width", near(barW, 340))
check("fullscreen-bar-left-of-notch", near(bar.midX + barW / 2, red.notchLeft - 10) && bar.midX - barW / 2 >= red.frame.minX && near(bar.maxY, 1112), "\(bar)")
check("fullscreen-bar-covers-no-notch", bar.midX + barW / 2 < red.notchLeft)
let dropped = IslandPlace.frame(.dropped, red, pos: CGPoint(x: 0.1, y: 0.9), pillW: 330, pillH: 34)
check("fullscreen-dropped-under-the-bar", near(dropped.midX, bar.midX) && near(dropped.maxY, 1112) && dropped.minX >= 0, "\(dropped)")
let moved = CGPoint(x: 0.1, y: 0.95)
let spot = IslandPlace.frame(.off, red, pos: moved, pillW: 330, pillH: 34)
check("moved-spot-on-desktop", spot.midX < 855 - 300 && spot.minX >= 0)
check("moved-spot-waits-in-full-screen", IslandPlace.frame(.bar, red, pos: moved, pillW: 330, pillH: 34) == bar)
check("moved-spot-same-when-menu-hides", IslandPlace.frame(.off, redFull, pos: moved, pillW: 330, pillH: 34) == spot)
// Little screen, little left strip: the bar never goes past the screen's left edge or into the notch.
let small = IslandGeo.make(frame: CGRect(x: 0, y: 0, width: 1280, height: 832), visible: CGRect(x: 0, y: 0, width: 1280, height: 795), inset: 32,
                           left: CGRect(x: 0, y: 800, width: 547, height: 32), right: CGRect(x: 733, y: 800, width: 547, height: 32))
let sbar = IslandPlace.frame(.bar, small, pos: nil, pillW: 330, pillH: 34)
check("small-bar-left-of-notch", sbar.midX + IslandPlace.barW(small) / 2 <= small.notchLeft - 10 + 0.01 && sbar.midX - IslandPlace.barW(small) / 2 >= 0)
// Second display (MacBook left of the main one): the bar sits on the MacBook, left of its notch.
let leftMac = IslandGeo.make(frame: redFrame.offsetBy(dx: -1710, dy: 0), visible: redVisible.offsetBy(dx: -1710, dy: 0), inset: 37.5, left: redL, right: redR)
let lbar = IslandPlace.frame(.bar, leftMac, pos: nil, pillW: 330, pillH: 34)
check("second-display-bar-on-the-macbook", lbar.midX - barW / 2 >= -1710 && lbar.midX + barW / 2 <= -1710 + 751)
check("second-display-cg-rect", IslandPlace.cgRect(CGRect(x: 1920, y: -200, width: 1710, height: 1112), primaryH: 1080) == CGRect(x: 1920, y: 168, width: 1710, height: 1112))

// MARK: the moved spot round trip (V1.58: fractions of the screen)
let c = IslandPlace.center(moved, red, pillW: 330, pillH: 34)
check("spot-round-trip", IslandPlace.spot(c, red, pillW: 330, pillH: 34) == moved)
check("spot-clamped", IslandPlace.spot(CGPoint(x: -5000, y: 99999), red, pillW: 330, pillH: 34) == CGPoint(x: 0.0988, y: 0.9829), "\(IslandPlace.spot(CGPoint(x: -5000, y: 99999), red, pillW: 330, pillH: 34))")

// MARK: V1.58 into the top strip and the corners (a friend, 13 Nov 2026: "It doesn't let me move it more to the corner
// than this" and "I can't move it up there in the black empty space")
func pillRect(_ s: CGPoint, _ g: IslandGeo, w: CGFloat = 330, h: CGFloat = 34) -> CGRect {
  let l = IslandPlace.moved(s, g, pillW: w, pillH: h)
  let r = IslandPlace.movedShape(anchor: l.anchor, w: w, h: h, pillW: w, pillH: h, up: IslandPlace.opensUp(s))
  return CGRect(x: l.frame.minX + r.minX, y: l.frame.maxY - r.maxY, width: r.width, height: r.height)
}
func inside(_ a: CGRect, _ b: CGRect) -> Bool { a.minX >= b.minX - 0.01 && a.maxX <= b.maxX + 0.01 && a.minY >= b.minY - 0.01 && a.maxY <= b.maxY + 0.01 }
let eg = IslandPlace.edgeGap, tg = IslandPlace.topGap
// No notch (an external display, the M1): every corner, right up to the edge, the top one over the menu bar's strip.
let tl = pillRect(CGPoint(x: 0, y: 1), plainShown), tr = pillRect(CGPoint(x: 1, y: 1), plainShown)
let bl = pillRect(CGPoint(x: 0, y: 0), plainShown), br = pillRect(CGPoint(x: 1, y: 0), plainShown)
check("corner-top-left", near(tl.minX, eg) && near(tl.maxY, 900 - tg), "\(tl)")
check("corner-top-right", near(tr.maxX, 1440 - eg) && near(tr.maxY, 900 - tg), "\(tr)")
check("corner-bottom-left", near(bl.minX, eg) && near(bl.minY, eg), "\(bl)")
check("corner-bottom-right", near(br.maxX, 1440 - eg) && near(br.minY, eg), "\(br)")
check("top-strip-over-menu-bar", tl.minY > plainShown.frame.maxY - plainShown.menuH - 34 && tl.maxY > plainShown.frame.maxY - plainShown.menuH, "\(tl)")
// The V1.57 limits are gone: 75 points in from the side, 8 below the menu bar.
let old = IslandPlace.legacyRoom(plainShown, pillH: 34)
check("further-than-v157-side", tl.minX < old.minX - 165 - 60)
check("further-than-v157-top", tl.maxY > old.maxY + 17 + 30)
// The panel always fully on screen, and the island open inside it from every corner (it opens inwards).
var panelsOk = true, openOk = true
for g in [plainShown, red, redFull, small] {
  for s in [CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 1), CGPoint(x: 0.5, y: 0.5), CGPoint(x: 0.02, y: 0.6)] {
    for (w, h) in [(CGFloat(330), CGFloat(34)), (270, 28)] {
      let l = IslandPlace.moved(s, g, pillW: w, pillH: h)
      if !inside(l.frame, g.frame) || l.frame.width != W || l.frame.height != H { panelsOk = false }
      let o = IslandPlace.movedShape(anchor: l.anchor, w: w + 70, h: 254, pillW: w, pillH: h, up: IslandPlace.opensUp(s))
      if !inside(o, CGRect(x: 0, y: 0, width: W, height: H)) { openOk = false }
      if !inside(pillRect(s, g, w: w, h: h), g.frame) { panelsOk = false }
    }
  }
}
check("moved-panel-always-on-screen", panelsOk)
check("moved-open-view-fits", openOk)
// The open view from the top left corner starts at the pill's left edge (it grows to the right, inwards).
let tlL = IslandPlace.moved(CGPoint(x: 0, y: 1), red, pillW: 330, pillH: 34)
let tlOpen = IslandPlace.movedShape(anchor: tlL.anchor, w: 400, h: 200, pillW: 330, pillH: 34, up: false)
check("corner-opens-inwards", near(tlL.frame.minX + tlOpen.minX, eg) && near(tlL.frame.maxY - tlOpen.minY, red.frame.maxY - tg), "\(tlOpen)")
// A notch: beside it the pill goes right up into the black strip; over it, it stays below the camera.
let besideNotch = IslandPlace.clamp(CGPoint(x: 300, y: 2000), red, pillW: 330, pillH: 34)
check("notch-strip-beside", near(besideNotch.y + 17, 1112 - tg) && besideNotch.x + 165 < red.notchLeft, "\(besideNotch)")
let overNotch = IslandPlace.clamp(CGPoint(x: 855, y: 2000), red, pillW: 330, pillH: 34)
check("notch-never-on-camera", overNotch.y + 17 <= 1112 - red.notchH - IslandPlace.notchGap + 0.01, "\(overNotch)")
let edgeNotch = IslandPlace.clamp(CGPoint(x: red.notchLeft - 165, y: 2000), red, pillW: 330, pillH: 34)
check("notch-touching-edge-stays-below", edgeNotch.y + 17 <= 1112 - red.notchH, "\(edgeNotch)")
let rightOfNotch = IslandPlace.clamp(CGPoint(x: 1710, y: 2000), red, pillW: 330, pillH: 34)
check("notch-strip-right-side", near(rightOfNotch.y + 17, 1112 - tg) && near(rightOfNotch.x + 165, 1710 - eg), "\(rightOfNotch)")
// Full screen (menu bar hidden) or not: the same spot, the same place.
check("moved-same-in-full-screen", IslandPlace.moved(CGPoint(x: 0, y: 1), red, pillW: 330, pillH: 34) == IslandPlace.moved(CGPoint(x: 0, y: 1), redFull, pillW: 330, pillH: 34))
// A second display left of the main one: the corners of that screen.
let lc = pillRect(CGPoint(x: 0, y: 1), leftMac)
check("second-display-corner", near(lc.minX, -1710 + eg) && near(lc.maxY, 1112 - tg), "\(lc)")
// The V1.57 spot (fractions of its smaller room) lands on the same place on screen.
for s0 in [CGPoint(x: 0, y: 1), CGPoint(x: 0.3, y: 0.2), CGPoint(x: 1, y: 0), CGPoint(x: 0.5, y: 0.5)] {
  let r0 = IslandPlace.legacyRoom(red, pillH: 34)
  let was = CGPoint(x: r0.minX + s0.x * r0.width, y: r0.minY + s0.y * r0.height)
  let now = IslandPlace.center(IslandPlace.fromLegacy(s0, red, pillW: 330, pillH: 34), red, pillW: 330, pillH: 34)
  check("legacy-spot-\(s0.x)-\(s0.y)-same-place", abs(now.x - was.x) < 0.5 && abs(now.y - was.y) < 0.5, "\(was) \(now)")
}
check("legacy-spot-bad-numbers-clamped", IslandPlace.fromLegacy(CGPoint(x: -3, y: 7), red, pillW: 330, pillH: 34) == IslandPlace.fromLegacy(CGPoint(x: 0, y: 1), red, pillW: 330, pillH: 34))
check("opens-up-lower-half", IslandPlace.opensUp(CGPoint(x: 0.5, y: 0.2)) && !IslandPlace.opensUp(CGPoint(x: 0.5, y: 0.9)))

// MARK: why not in the top bar (the log line)
check("why-not-none", IslandPlace.barWhyNot(.none, notch: true, menuAlways: false, move: true) == nil)
check("why-not-in-bar", IslandPlace.barWhyNot(.whole, notch: true, menuAlways: false, move: true) == nil)
check("why-not-setting", IslandPlace.barWhyNot(.whole, notch: true, menuAlways: false, move: false)?.contains("sit in the top bar") == true)
check("why-not-no-notch", IslandPlace.barWhyNot(.whole, notch: false, menuAlways: false, move: true)?.contains("no notch") == true)
check("why-not-menu-always", IslandPlace.barWhyNot(.belowNotch, notch: true, menuAlways: true, move: true)?.contains("menu bar") == true)

// MARK: every desktop (the developer, 12 Nov 2026: the island stopped following him across desktops after a drag)
let sp = IslandPlace.spaces
check("spaces-every-desktop", sp.contains(.canJoinAllSpaces))
check("spaces-over-full-screen", sp.contains(.fullScreenAuxiliary))
check("spaces-mission-control-leaves-it", sp.contains(.stationary) && sp.contains(.ignoresCycle))
check("spaces-never-move-to-active", !sp.contains(.moveToActiveSpace) && !sp.contains(.transient) && !sp.contains(.managed))
check("spaces-every-apps-space", sp.contains(.canJoinAllApplications))
check("rejoin-when-missing-here", IslandPlace.rejoin(visible: true, onActiveSpace: false, dragging: false))
check("rejoin-not-when-here", !IslandPlace.rejoin(visible: true, onActiveSpace: true, dragging: false))
check("rejoin-not-while-dragged", !IslandPlace.rejoin(visible: true, onActiveSpace: false, dragging: true))
check("rejoin-not-when-away", !IslandPlace.rejoin(visible: false, onActiveSpace: false, dragging: false))

// MARK: over full screen apps at all (12 Nov 2026: a friend's island vanished in full screen; a Dock app's windows are never
// drawn over another app's full screen Space, so PS steps out of the Dock while one is in front, and back after)
typealias P = IslandPlace.Presence
check("presence-out-for-full-screen", IslandPlace.presence(fullScreen: true, islandOn: true, psFront: false, menuBarHere: false, now: .dock) == .overFullScreen)
check("presence-back-when-it-ends", IslandPlace.presence(fullScreen: false, islandOn: true, psFront: false, menuBarHere: true, now: .overFullScreen) == .dock)
check("presence-dock-on-desktop", IslandPlace.presence(fullScreen: false, islandOn: true, psFront: false, menuBarHere: true, now: .dock) == .dock)
check("presence-island-off-stays-in-dock", IslandPlace.presence(fullScreen: true, islandOn: false, psFront: false, menuBarHere: false, now: .dock) == .dock)
check("presence-island-off-goes-back", IslandPlace.presence(fullScreen: true, islandOn: false, psFront: false, menuBarHere: false, now: .overFullScreen) == .dock)
check("presence-ps-front-over-full-screen-stays", IslandPlace.presence(fullScreen: true, islandOn: true, psFront: true, menuBarHere: false, now: .overFullScreen) == .overFullScreen)
check("presence-ps-front-on-desktop-back", IslandPlace.presence(fullScreen: true, islandOn: true, psFront: true, menuBarHere: true, now: .overFullScreen) == .dock)
check("presence-ps-front-never-leaves-dock", IslandPlace.presence(fullScreen: true, islandOn: true, psFront: true, menuBarHere: false, now: .dock) == .dock)

// MARK: the glide (the developer: "a fancy animation")
let toBar = IslandPlace.glide(from: home, to: bar, reduceMotion: false)
check("glide-to-bar-leans-left", toBar.stretch < 0 && toBar.stretch >= -1, "\(toBar)")
check("glide-to-bar-length", toBar.duration >= 0.42 && toBar.duration <= 0.75, "\(toBar)")
check("glide-soft-ease-out", toBar.curve == IslandPlace.glideCurve && toBar.curve.count == 4)
let back = IslandPlace.glide(from: bar, to: home, reduceMotion: false)
check("glide-back-leans-right", back.stretch > 0 && back.duration == toBar.duration && abs(back.stretch) == abs(toBar.stretch))
let toSpot = IslandPlace.glide(from: bar, to: spot, reduceMotion: false)
check("glide-back-to-moved-spot", toSpot.duration >= 0.42 && toSpot.duration <= 0.75 && toSpot.stretch != 0)
let far = IslandPlace.glide(from: CGRect(x: 0, y: 0, width: 480, height: 270), to: CGRect(x: 5000, y: 0, width: 480, height: 270), reduceMotion: false)
check("glide-long-trip-capped", far.duration == 0.75 && far.stretch == 1)
let still = IslandPlace.glide(from: bar, to: bar, reduceMotion: false)
check("glide-no-trip-no-lean", still.stretch == 0)
let calm = IslandPlace.glide(from: home, to: bar, reduceMotion: true)
check("glide-reduce-motion-no-travel", calm.stretch == 0 && calm.duration <= 0.2)
let lean = IslandPlace.leanScale(-1), none = IslandPlace.leanScale(0)
check("glide-lean-shape", lean.x > 1 && lean.x <= 1.15 && lean.y < 1 && lean.y >= 0.9 && none == (1, 1))
check("glide-dropped-only-drops", IslandPlace.glide(from: bar, to: dropped, reduceMotion: false).stretch == 0)

// PS 1.69 Hatch: where the update animation aims at a kept spot (Island.hatchSpot: the resting pill on screen), bottom left origin.
func spotRect(_ s: CGPoint) -> CGRect {
  let l = IslandPlace.moved(s, red, pillW: 330, pillH: 34)
  let r = IslandPlace.movedShape(anchor: l.anchor, w: 330, h: 34, pillW: 330, pillH: 34, up: IslandPlace.opensUp(s))
  return CGRect(x: l.frame.minX + r.minX, y: l.frame.maxY - r.maxY, width: r.width, height: r.height)
}
let spotBottom = spotRect(CGPoint(x: 0.5, y: 0.04)), spotCorner = spotRect(CGPoint(x: 0, y: 0)), spotTop = spotRect(CGPoint(x: 0.9, y: 1))
check("hatch-spot-bottom-is-low-and-on-screen", spotBottom.midY < redFrame.midY && redFrame.contains(spotBottom) && near(spotBottom.width, 330) && near(spotBottom.height, 34), "\(spotBottom)")
check("hatch-spot-bottom-corner-reaches-the-corner", redFrame.contains(spotCorner) && spotCorner.minX < 12 && spotCorner.minY < 12, "\(spotCorner)")
check("hatch-spot-top-is-high-and-off-the-camera", spotTop.midY > redFrame.midY && redFrame.contains(spotTop) && spotTop.minX > red.notchLeft + red.notchW, "\(spotTop)")

print("ISLAND PLACE: \(count - fails) of \(count) ok")
exit(fails == 0 ? 0 : 1)
