import AppKit
import Combine
import SwiftUI

// PS Dynamic Island (the developer, 30 Oct 2026): a black shape that grows out of the MacBook notch (or a pill
// just below it, or off: settings.island, the Tab list's gear) and always shows the task he is working
// on (the row that glows white; the next Priority 1 task, dimmed, when none is), with a tick to finish it
// there and then. A mail icon with a count for client emails and a reply arrow with a count for
// Instantly replies sit on its left. A new one lights it up and pops it open for 10 seconds.
// Over a full screen video it stays, dimmed, and lights up for those 10 seconds the same way.
// The main window page works everything out (src/island.ts) and posts {type:"island", state}; this
// file only draws what it was handed: no vault, no network, nothing saved. A tick goes back as
// {type:"islandAction", action:"tick"|"untick", id}. A click on the popped email only
// opens Gmail or Instantly (Toast.openable); since 1.61 a click on a count opens the Tab list's email panel instead
// (IslandMailOpen.swift). Never takes the keyboard, never activates PS, gone while
// 1Password or Signal is in front. Drawn by SwiftUI on Core Animation, so the morph never waits on
// the main thread; the panel is one fixed see-through size and lets every click outside the shape
// through to the app below.
// V1.36 (the developer, 6 Nov 2026: "at the very top in the centre there's like a tiny little grey line in a landscape format
// and if you click that I want the dynamic island to disappear for let's say five seconds just so if you want to
// access like a tab that is behind the dynamic island then you still can"): a short grey grab line at the top centre
// (IslandGrip). A click on it fades and slides the island away, orders its window out (nothing is left on screen to
// catch a click), and brings it back the same way a while later (1 minute by default since V1.40, set in Settings; news brings it back at once).
// G Squad (the developer, 7 Nov 2026: "make it so you can actually move the dynamic island around as well. So you don't have to
// have it at the top, you can move it down"): drag the grab line and the island goes anywhere on the screen as the
// pill (IslandPanel.dragHook, Island.dragEvent). The spot is kept per Mac (UserDefaults island.spot, a fraction of the
// screen, so it means the same on any screen size), clamped so the island and its open view are always fully on screen.
// V1.58 (a friend: "It doesn't let me move it more to the corner than this", and not up into the black strip): the pill
// goes right into the corners and up into the top strip, beside the notch, never on the camera (IslandPlace.clamp). The
// window stays on the screen and the pill moves inside it (IslandModel.anchor), so the open view still fits.
// In the lower half it opens upwards. Dropped near the top centre it snaps home (around the notch again). Reset: Mac
// settings, the Tab list's Edit mode, or the page's {type:"island:reset"}. While the Tab list is in Edit mode
// ({type:"island:edit"}) the island shows even with nothing to show, so it can be found and moved.
final class IslandPanel: NSPanel {
  /// The island's own drag (Island.dragEvent): true when it took the event.
  var dragHook: ((NSEvent) -> Bool)?
  override func sendEvent(_ e: NSEvent) {
    if dragHook?(e) == true { return }
    super.sendEvent(e)
  }
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  /// V1.58: never pushed below the menu bar by AppKit. The island places itself (IslandPlace.layout keeps the window on
  /// its screen) and sits in the top strip on purpose, at a level above the menu bar.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
final class IslandHost<C: View>: NSHostingView<C> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }   // the first click on the island counts
}

struct IslandTask: Equatable { var id: String; var title: String; var dim = false }
/// quiet: Do Not Disturb mutes the pop (src/core/dnd.ts), so the island only lights up for a moment.
struct IslandEvent: Equatable { var id: String; var kind: String; var title: String; var sub: String; var url: String?; var quiet = false }
/// "#rrggbb" from the page, else nil (every colour the island paints is worked out by the page, src/core/islandlook.ts,
/// so the words always read at WCAG AA; this side only paints them).
func islandHex(_ v: Any?) -> Color? {
  guard let s = v as? String, s.count == 7, s.hasPrefix("#"), let n = UInt32(s.dropFirst(), radix: 16) else { return nil }
  return Color(red: Double((n >> 16) & 0xff) / 255, green: Double((n >> 8) & 0xff) / 255, blue: Double(n & 0xff) / 255)
}
/// The grab line's greys (V1.36), the same sum as the page's gripTones (src/core/islandlook.ts): the softest grey,
/// lighter than every backing on a dark island and darker on a light one, that shows at 3.5 to 1 on every backing it
/// can sit on (6 to 1 while the pointer is on it); white or black when no grey gets there. Greys only, so it reads
/// as the same quiet handle on every colour. The self test checks these greys against the page's own table.
enum IslandGrip {
  static let ratio = 3.5, hiRatio = 6.0
  /// How far the black camera notch has faded at the line around the notch with a Background (GRIP_FADE).
  static let fade = 0.4
  typealias RGB = [Double]                       // 0 to 255
  static let black: RGB = [0, 0, 0], white: RGB = [255, 255, 255]
  static func rgb(_ v: Any?) -> RGB? {
    guard let s = v as? String, s.count == 7, s.hasPrefix("#"), let n = UInt32(s.dropFirst(), radix: 16) else { return nil }
    return [Double((n >> 16) & 0xff), Double((n >> 8) & 0xff), Double(n & 0xff)]
  }
  static func lum(_ c: RGB) -> Double {
    let l = c.map { v -> Double in let s = v / 255; return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
  }
  static func contrast(_ a: RGB, _ b: RGB) -> Double { let x = lum(a), y = lum(b); return (max(x, y) + 0.05) / (min(x, y) + 0.05) }
  static func worst(_ c: RGB, _ backs: [RGB]) -> Double { backs.map { contrast(c, $0) }.min() ?? 21 }
  /// a moved toward b by t, rounded like the page's hex colours.
  static func mix(_ a: RGB, _ b: RGB, _ t: Double) -> RGB { zip(a, b).map { max(0, min(255, ($0 + ($1 - $0) * t).rounded())) } }
  static func grey(_ backs: [RGB], _ ratio: Double) -> Int {
    let up = worst(white, backs) >= worst(black, backs)
    let ls = backs.map(lum), hi = ls.max() ?? 0, lo = ls.min() ?? 1
    for i in 0...255 {
      let v = Double(up ? i : 255 - i), c: RGB = [v, v, v], l = lum(c)
      if (up ? l > hi : l < lo) && worst(c, backs) >= ratio { return Int(v) }
    }
    return up ? 255 : 0
  }
  /// (line, hover) as grey levels 0 to 255.
  static func tones(_ backs: [RGB]) -> (Int, Int) { (grey(backs, ratio), grey(backs, hiRatio)) }
  static func color(_ v: Int) -> Color { Color(red: Double(v) / 255, green: Double(v) / 255, blue: Double(v) / 255) }
  static let onBlack = tones([black])
}

/// The pill's look (the developer, 4 Nov 2026). The defaults are the black pill exactly as it always was.
struct PillTones: Equatable {
  var style = "classic"       // classic | glass | solid | gradient | outline | glow
  var compact = false
  var icon = false
  var bg = Color.black, bg2 = Color.black
  var glass = 0.0             // the glass tint's strength (0 = not glass)
  var fg = Color(white: 0.95), dim = Color(white: 0.5), accent = Color(white: 0.75)
  var edge: Color?
  var mail = Color(red: 0.93, green: 0.31, blue: 0.53), lead = Color(red: 0.38, green: 0.65, blue: 0.98)
  var done = Color(red: 0.2, green: 0.83, blue: 0.6), chat = Color(red: 0.85, green: 0.47, blue: 0.34)
  /// The grab line's greys (IslandGrip), 0 to 255: on black unless the look says otherwise.
  var grip = IslandGrip.onBlack.0, gripHi = IslandGrip.onBlack.1
  static func from(_ v: Any?) -> PillTones {
    var t = PillTones()
    guard let d = v as? [String: Any] else { return t }
    let st = d["style"] as? String ?? ""
    t.style = ["classic", "glass", "solid", "gradient", "outline", "glow"].contains(st) ? st : "classic"
    t.compact = (d["size"] as? String) == "compact"
    t.icon = (d["icon"] as? Bool) == true
    if let c = islandHex(d["bg"]) { t.bg = c; t.bg2 = c }
    if let c = islandHex(d["bg2"]) { t.bg2 = c }
    t.glass = t.style == "glass" ? max(0.3, min(1, (d["glass"] as? Double) ?? Double((d["glass"] as? Int) ?? 1))) : 0
    if let c = islandHex(d["fg"]) { t.fg = c }
    if let c = islandHex(d["dim"]) { t.dim = c }
    if let c = islandHex(d["accent"]) { t.accent = c }
    t.edge = ["outline", "glow"].contains(t.style) ? islandHex(d["edge"]) : nil
    if let c = islandHex(d["mail"]) { t.mail = c }
    if let c = islandHex(d["lead"]) { t.lead = c }
    if let c = islandHex(d["done"]) { t.done = c }
    if let c = islandHex(d["chat"]) { t.chat = c }
    // The line sits on the fill: both ends of a gradient, and glass over a black and a white screen alike (the
    // same backings the page reads the words on).
    let bg = IslandGrip.rgb(d["bg"]) ?? IslandGrip.black, bg2 = IslandGrip.rgb(d["bg2"]) ?? bg
    let backs = t.style == "gradient" ? [bg, bg2] : t.glass > 0 ? [IslandGrip.mix(IslandGrip.black, bg, t.glass), IslandGrip.mix(IslandGrip.white, bg, t.glass)] : [bg]
    (t.grip, t.gripHi) = IslandGrip.tones(backs)
    return t
  }
}
/// Around the notch: black like the notch unless a Background is picked (V1.36, the developer 5 Nov 2026: "could you make
/// it so I can actually edit the colour, like the background colour of it too"). Then the drop, the Slim wings
/// and the open island are filled with it, the camera notch itself stays black and blends softly into it, and the
/// words take the colours the page worked out for that fill. No fill: exactly the black look it always was.
struct NotchTones: Equatable {
  var style = "drop"          // drop | slim | halo
  var icon = false
  var tinted = false          // an accent was picked (its rim shows on Drop and Slim)
  var fill: Color?            // the Background (nil: black)
  var fillHex: String?        // the same, for the self test
  var fg = Color(white: 0.95), dim = Color(white: 0.5), accent = Color(white: 0.75), glow = Color(red: 0.54, green: 0.71, blue: 1)
  var mail = Color(red: 0.93, green: 0.31, blue: 0.53), lead = Color(red: 0.38, green: 0.65, blue: 0.98)
  var done = Color(red: 0.2, green: 0.83, blue: 0.6), chat = Color(red: 0.85, green: 0.47, blue: 0.34)
  var grip = IslandGrip.onBlack.0, gripHi = IslandGrip.onBlack.1
  static func from(_ v: Any?) -> NotchTones {
    var t = NotchTones()
    guard let d = v as? [String: Any] else { return t }
    let st = d["style"] as? String ?? ""
    t.style = ["drop", "slim", "halo"].contains(st) ? st : "drop"
    t.icon = (d["icon"] as? Bool) == true
    t.tinted = (d["tinted"] as? Bool) == true
    if let c = islandHex(d["accent"]) { t.accent = c }
    if let c = islandHex(d["glow"]) { t.glow = c }
    if let c = islandHex(d["fill"]) {
      // Only with a Background do the words change: with none they stay exactly as they were.
      t.fill = c; t.fillHex = (d["fill"] as? String)?.lowercased()
      if let c = islandHex(d["fg"]) { t.fg = c }
      if let c = islandHex(d["dim"]) { t.dim = c }
      if let c = islandHex(d["mail"]) { t.mail = c }
      if let c = islandHex(d["lead"]) { t.lead = c }
      if let c = islandHex(d["done"]) { t.done = c }
      if let c = islandHex(d["chat"]) { t.chat = c }
      // The line sits just below the notch, where the black is still fading into the fill.
      if let f = IslandGrip.rgb(d["fill"]) { (t.grip, t.gripHi) = IslandGrip.tones([f, IslandGrip.mix(f, IslandGrip.black, IslandGrip.fade)]) }
    }
    return t
  }
}

struct IslandState: Equatable {
  var mode = "notch"          // notch | pill | off
  var pillLook = PillTones()
  var notchLook = NotchTones()
  var priv = false
  var task: IslandTask?
  var more = 0
  var tasks: [IslandTask] = []
  var mail = 0
  var leads = 0
  var event: IslandEvent?
  /// How long a click on the grab line hides the island (V1.40, the developer: 1 minute by default, his choice in Settings).
  var hide: Double = 60
  /// V1.55: notification cards come out of the island instead of the top right corner (Settings, "Notifications come
  /// from the Dynamic Island", on unless switched off: settings.island.cards, src/core/island.ts).
  var cards = true
  /// The kinds of card the developer sent to the top right instead (NoteDrop.kinds; none by default, settings.island.top).
  var cardsTop: [String] = []
  /// Over a full screen app it glides to the top left black band beside the notch ("Move to the top left in full
  /// screen", on unless switched off: settings.island.fsMove, src/core/island.ts). Off: it stays where it is, dimmed.
  var fsMove = true
  /// Which side of the island the tick circle sits on, the same at rest, open and in the black band ("Tick circle side",
  /// settings.island.tickSide, left unless set). The developer, 12 Nov 2026: "Make it so it's always on the left. Make this
  /// adjustable in the dynamic island settings too".
  var tickLeft = true
  /// V1.58: the calendar events from now to 12 hours ahead, ids and times only (web src/core/islandaway.ts),
  /// for "Disappear for this meeting" in the island's right click menu (IslandAwayCore.swift).
  var meets: [IslandMeet] = []
  /// V1.58: Pomodoro breaks, Stand-up reminders and the next meeting bubble (IslandTimersCore.swift).
  var timers = TimersIn()
  /// PS 1.65 Low power mode (web src/island.ts, LowPowerCore.swift): nil while off; on, the plain names of what is asleep.
  /// The island itself stays fully active: only the leaf and its card are new.
  var lp: [String]?
  /// PS 1.70 the day countdown in the task area and the shown task's Priority 1 timer (DayCountdownCore.swift DayIn).
  var day: DayIn?

  /// A hide time from the page: whole seconds from 5 s to 1 hour, anything else the 1 minute default.
  static func hideTime(_ v: Any?) -> Double {
    guard let n = (v as? NSNumber)?.doubleValue, n.isFinite else { return 60 }
    return min(3600, max(5, n.rounded()))
  }
  /// "5 seconds", "1 minute", "2 minutes 30 seconds", "1 hour".
  static func hideText(_ s: Double) -> String {
    let t = Int(s), h = t / 3600, m = (t % 3600) / 60, x = t % 60
    func one(_ n: Int, _ w: String) -> String { "\(n) \(w)\(n == 1 ? "" : "s")" }
    return [h > 0 ? one(h, "hour") : nil, m > 0 ? one(m, "minute") : nil, x > 0 || t == 0 ? one(x, "second") : nil].compactMap { $0 }.joined(separator: " ")
  }

  /// Everything from the page checked and capped: unknown values fall back, links only to Gmail or Instantly.
  static func from(_ d: [String: Any]) -> IslandState {
    func str(_ v: Any?, _ n: Int) -> String { String(((v as? String) ?? "").replacingOccurrences(of: "\n", with: " ").prefix(n)) }
    func count(_ v: Any?) -> Int { max(0, min(99, (v as? Int) ?? Int((v as? Double) ?? 0))) }
    func task(_ v: Any?) -> IslandTask? {
      guard let t = v as? [String: Any] else { return nil }
      let id = str(t["id"], 64), title = str(t["title"], 200)
      return id.isEmpty || title.isEmpty ? nil : IslandTask(id: id, title: title, dim: (t["dim"] as? Bool) == true)
    }
    var s = IslandState()
    let m = d["mode"] as? String ?? "notch"
    s.mode = ["notch", "pill", "off"].contains(m) ? m : "notch"
    s.priv = (d["private"] as? Bool) == true
    s.pillLook = PillTones.from(d["pill"])
    s.notchLook = NotchTones.from(d["notch"])
    s.task = task(d["task"])
    s.more = count(d["more"])
    s.tasks = ((d["tasks"] as? [Any]) ?? []).prefix(6).compactMap(task)
    s.mail = count(d["mail"]); s.leads = count(d["leads"])
    s.hide = hideTime(d["hide"])
    s.cards = (d["cards"] as? Bool) != false
    s.fsMove = (d["fsMove"] as? Bool) != false
    s.tickLeft = (d["tickSide"] as? String) != "right"
    s.meets = IslandAwayCore.meets(d["meets"])
    s.timers = TimersCore.from(d)   // V1.58 island timers
    s.day = Features.on(DayCore.feature) ? DayIn.from(d["day"]) : nil   // PS 1.70 (web src/daycount.ts dayIsland)
    if Features.on("low-power"), let l = d["lp"] as? [String: Any] {
      s.lp = ((l["names"] as? [Any]) ?? []).prefix(40).compactMap { $0 as? String }.map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(40)) }
    }
    s.cardsTop = ((d["top"] as? [Any]) ?? []).compactMap { $0 as? String }.filter { NoteDrop.kinds.contains($0) }
    if let e = d["event"] as? [String: Any] {
      let id = str(e["id"], 64), kind = e["kind"] as? String ?? "", title = str(e["title"], 160)
      if !id.isEmpty, ["mail", "lead", "chat"].contains(kind), !title.isEmpty {
        s.event = IslandEvent(id: id, kind: kind, title: title, sub: str(e["sub"], 200), url: Toast.openable(e["url"] as? String), quiet: (e["quiet"] as? Bool) == true)
      }
    }
    return s
  }
}

/// The live numbers for IslandGeo (IslandPlace.swift holds the math).
extension IslandGeo {
  /// The last screen pick written to the log (main thread).
  private static var lastPick = ""
  static func read() -> (IslandGeo, NSScreen?) {
    // The screen with the camera if there is one (the built in display), else the main one.
    let s = NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? NSScreen.screens.first
    // V1.47: one line when the screen the island sits on changes (macOS 27.2 notes a known issue where an external
    // display's arrangement can change by itself), so an island that ends up on the wrong screen shows in the log.
    let pick = s.map { "\($0.safeAreaInsets.top > 0 ? "the built in screen (notch)" : "a screen with no notch") \(Int($0.frame.width))x\(Int($0.frame.height)) at \(Int($0.frame.minX)),\(Int($0.frame.minY)), \(NSScreen.screens.count) screen\(NSScreen.screens.count == 1 ? "" : "s")" } ?? "no screen"
    if pick != lastPick { lastPick = pick; psLog("PS island: on \(pick)") }
    guard let s else { return (IslandGeo(), nil) }
    return (IslandGeo.make(frame: s.frame, visible: s.visibleFrame, inset: s.safeAreaInsets.top, left: s.auxiliaryTopLeftArea, right: s.auxiliaryTopRightArea), s)
  }
}

final class IslandModel: ObservableObject {
  @Published var st = IslandState()
  @Published var geo = IslandGeo()
  @Published var hovering = false
  @Published var popping: IslandEvent?
  @Published var fullScreen = false
  @Published var glowing = false            // Do Not Disturb: news lights the island up for a moment, no pop
  @Published var ticked: IslandTask?      // just ticked: "Done", then Undo for 5 s
  @Published var tickedAt = Date.distantPast
  @Published var gripHover = false          // the pointer is on the grab line: a stronger grey
  @Published var gripTip = false            // and after a moment, "Click hides it, drag moves it"
  @Published var away = false               // hidden by the grab line: faded and slid up (the window is then ordered out)
  @Published var free = false               // moved off the top centre (G Squad): always the pill, anywhere on screen
  @Published var growUp = false             // free in the lower half of the screen: it opens upwards
  /// Moved (V1.58): where the resting pill's centre sits in the panel (top left origin). The panel stays on the screen
  /// and the pill moves inside it, so the pill reaches the screen's edges, corners and top strip (IslandPlace.layout).
  @Published var anchor: CGPoint?
  @Published var editing = false            // the Tab list is in Edit mode: shown even with nothing to show, to be moved
  @Published var dragging = false           // being dragged by its grab line: it stays shut
  /// V1.55: a card just dropped out of the island (1) or went back into it (a smaller gulp): the island swells for a
  /// moment and springs back. Drawn only (a scale of the shape), so the shape the Tab list and the cards hear of never moves.
  @Published var swell: CGFloat = 0
  /// PS 1.67 Hatch (Island.hatchExit, hatchBorn): the real island pinched into a dot or growing out of the blob, and its row
  /// faded out while it does. 1 and 1 at every other time.
  @Published var hatchSX: CGFloat = 1
  @Published var hatchSY: CGFloat = 1
  @Published var hatchRow: Double = 1
  /// The glide to or from the black band over a full screen app: the shape leans into the move for a moment (signed,
  /// below 0 it travels left; IslandPlace.glide), then springs back as it settles. Drawn only, like swell.
  @Published var travel: CGFloat = 0
  /// V1.58 island timers (IslandTimers.swift): what they show, what the page sent, and a meeting opened from its bubble.
  @Published var tshow = TShow.idle
  @Published var tin = TimersIn()
  @Published var meetOpen: TMeet?
  @Published var lpOpen = false             // PS 1.65: the leaf was clicked: what is asleep, and Wake everything
  var lowPowerWake: () -> Void = {}
  var timerOn: Bool { !tshow.middle.isTask || meetOpen != nil }
  var bigTimer: Bool { tshow.middle.isStand || meetOpen != nil }
  /// V1.59 (the developer: "the island grows like Face ID on an iPhone"): a stand-up opens the island into a rounder, taller
  /// shape with the little man big in its middle (IslandTimerLayout.face).
  var faceID: Bool { tshow.middle.isStand && meetOpen == nil }
  /// The open shape's corner radius: rounder for the stand-up.
  var openRadius: CGFloat { faceID ? IslandTimerLayout.faceRadius : 24 }
  /// The cards hang from the island at rest: its hover view opens over them for a moment and is never measured.
  fileprivate var restOnly = false
  /// A full screen app on a screen with a notch (V1.40): the island sits in the black bar left of the notch, one
  /// line, covering nothing of the app; while the menu bar is down over that bar it drops just below it, open.
  @Published var fs: FullScreenPlace = .off
  var inBar: Bool { fs == .bar }
  /// The bar's island: as wide as fits left of the notch, never wider than the pill.
  var barW: CGFloat { IslandPlace.barW(geo) }
  var hide: () -> Void = {}
  var tick: (IslandTask) -> Void = { _ in }
  var untick: () -> Void = {}
  var open: (String?) -> Void = { _ in }
  /// PS 1.61: a click on the envelope or the reply arrow (IslandMailOpen.swift).
  var openMail: (String) -> Void = { _ in }
  /// A click on the private mode label: private mode off, the real task back (the page saves it, src/island.ts).
  var privateOff: () -> Void = {}
  /// Private mode hides the task's name (the page sends "Hidden (private mode)"): the island says so plainly instead,
  /// with a mask, and a click shows the task again. The hiding itself is the page's and unchanged.
  var privateShown: Bool { st.priv && st.task != nil && ticked == nil }

  static let panelW = IslandPlace.panelW, panelH = IslandPlace.panelH
  /// Moved: the gap between the pill and the panel's edge, and the least gap to the screen's edge.
  static let freeGap = IslandPlace.freeGap, screenGap = IslandPlace.screenGap
  /// The Slim look's wings either side of the notch: one tick ring or one count each, nothing wider.
  static let slimWing: CGFloat = 34
  /// How long the pointer rests on the notch looks before they open.
  static let hoverIntent: TimeInterval = 0.2
  /// How far the black camera notch fades into a Background around the notch, below it and beside it (the
  /// editor's preview, NOTCH_BLEND). The words never come this close to the notch.
  static let notchBlend: CGFloat = 6
  /// No notch on this screen (the M1, an external display): "around the notch" shows as the pill, in the pill's look.
  var pill: Bool { st.mode == "pill" || !geo.notch || free || (editing && !hasNews) || fs != .off }
  var notchStyle: String { timerOn ? "drop" : st.notchLook.style }   // V1.58: a timer needs the body below the notch
  /// Up to 4 rows; 3 in private mode, where the private mode line takes the fourth's room (the names read the same).
  var rows: [IslandTask] { st.tasks.isEmpty ? (st.task.map { [$0] } ?? []) : Array(st.tasks.prefix(st.priv ? 3 : 4)) }
  /// Something of its own to show (a task, counts, news); Edit mode shows it anyway, with a hint, so it can be moved.
  var hasNews: Bool { st.task != nil || st.mail > 0 || st.leads > 0 || popping != nil || ticked != nil || glowing || tshow.active || meetOpen != nil || st.lp != nil }
  var hasContent: Bool { hasNews || editing }
  var expanded: Bool { !dragging && fs != .bar && (popping != nil || bigTimer || (lpOpen && st.lp != nil && !restOnly) || (hovering && !restOnly && hasNews && !timerOn) || (fs == .dropped && hasNews)) }
  var undoable: Bool { ticked != nil && Date().timeIntervalSince(tickedAt) < 5 }
  /// PS 1.66 (the developer: the meeting must not disappear when the island opens on hover): the meeting the bubble shows, kept as a
  /// row at the foot of the open island (the bubble steps aside while it is open), which grows by meetRowH for it.
  var hoverMeet: (mode: String, mt: TMeet)? { if meetOpen == nil, case .meet(let mode, let mt) = tshow.right { return (mode, mt) }; return nil }
  static let meetRowH: CGFloat = 38
  /// Dim over a full screen app, unless something just arrived or the pointer is on it.
  var opacity: Double { fullScreen && fs == .off && popping == nil && !hovering && !glowing ? 0.35 : 1 }

  /// The grab line: its size, and the click target round it (a little larger, inside the island's top edge, where no
  /// other control sits: the ticks and counts are at the sides and the words start lower down).
  static let gripW: CGFloat = 32, gripHoverW: CGFloat = 38, gripH: CGFloat = 2.5, gripHitW: CGFloat = 56, gripHitH: CGFloat = 11
  /// The line's centre in the panel (top left origin): the top centre of the pill, or on the body just below the camera
  /// notch. Slim and Halo have no body below the notch until they open, so their line shows once they do.
  func gripCenter() -> CGPoint? {
    guard hasContent, fs == .off else { return nil }   // over a full screen app it neither hides nor moves
    if pill { let r = shapeRect(); return CGPoint(x: r.midX, y: r.minY + (st.pillLook.compact ? 4.25 : 4.75)) }
    guard expanded || notchStyle == "drop" else { return nil }
    return CGPoint(x: IslandModel.panelW / 2, y: geo.notchH + 5)
  }
  func gripHit() -> CGRect? {
    guard let c = gripCenter() else { return nil }
    return CGRect(x: c.x - IslandModel.gripHitW / 2, y: pill ? shapeRect().minY : geo.notchH, width: IslandModel.gripHitW, height: IslandModel.gripHitH)
  }

  var pillW: CGFloat { st.pillLook.compact ? 270 : 330 }
  var pillH: CGFloat { st.pillLook.compact ? 28 : 34 }
  var pillOpenW: CGFloat { st.pillLook.compact ? 380 : 400 }

  /// Around the notch, in two parts: the neck (the notch itself, plus the Slim look's wings) inside the menu
  /// bar, and the body below the menu bar. Only the Slim wings ever sit in the menu bar beside the notch, so
  /// the menus and the status icons stay visible and clickable (the old wide wings covered 128 points of
  /// them on each side: the developer, 4 Nov 2026, "looks awful and does not work").
  func notchParts() -> NotchParts {
    let n = geo.notchW, h = geo.notchH
    let slim = notchStyle == "slim"
    let neck = slim ? n + IslandModel.slimWing * 2 : n
    if expanded { return NotchParts(neckW: neck, neckH: h, bodyW: max(faceID ? IslandTimerLayout.faceW : 400, neck), bodyH: expandedH(), ear: slim ? 7 : 0, radius: openRadius) }
    switch notchStyle {
    case "slim": return NotchParts(neckW: neck, neckH: h, bodyW: neck, bodyH: 0, ear: 7, radius: 11)
    case "halo": return NotchParts(neckW: n, neckH: h, bodyW: n, bodyH: 0, ear: 0, radius: 10)
    default: return NotchParts(neckW: n, neckH: h, bodyW: max(n + 92, 300), bodyH: 30, ear: 0, radius: 15)
    }
  }

  /// The shape's rectangle inside the panel (top left origin, as SwiftUI draws it).
  func shapeRect() -> CGRect {
    let W = IslandModel.panelW
    var w: CGFloat, h: CGFloat, top: CGFloat
    if fs == .bar {
      // Inside the black bar: its height less a small margin, centred in it.
      h = max(16, geo.notchH - 8)
      return CGRect(x: (W - barW) / 2, y: (geo.notchH - h) / 2, width: barW, height: h)
    }
    if pill {
      w = expanded ? (faceID ? IslandTimerLayout.faceW : pillOpenW) : pillW
      h = expanded ? expandedH() : pillH
      if free, fs == .off, let a = anchor { return IslandPlace.movedShape(anchor: a, w: w, h: h, pillW: pillW, pillH: pillH, up: growUp) }
      // Moved: the pill sits at the panel's top edge, or (lower half) its bottom edge, so it opens away from the screen's edge.
      top = !free || fs != .off ? (geo.notch ? geo.notchH : geo.menuH) + 6 : growUp ? IslandModel.panelH - IslandModel.freeGap - h : IslandModel.freeGap
    } else {
      let p = notchParts()
      top = 0
      w = min(max(p.neckW + p.ear * 2, p.bodyW), W - 8)
      h = p.neckH + p.bodyH
    }
    return CGRect(x: (W - w) / 2, y: top, width: w, height: h)
  }
  /// The shape without the hover view (V1.55: where the cards hang from). Main thread, like everything here.
  func restRect() -> CGRect {
    restOnly = true
    defer { restOnly = false }
    return shapeRect()
  }
  func expandedH() -> CGFloat {
    if popping != nil { return 78 }
    if faceID { return pill ? IslandTimerLayout.faceH : IslandTimerLayout.faceBody }   // V1.59: the stand-up's Face ID look
    if bigTimer { return IslandTimerLayout.bigBody }   // V1.58: a meeting opened from its bubble
    if lpOpen, st.lp != nil { return 18 + 28 + 36 + 34 }   // PS 1.65: the leaf's card (title, two lines, the button)
    let badges: CGFloat = st.mail > 0 || st.leads > 0 ? 34 : 0
    let undo: CGFloat = undoable ? 34 : 0
    let rowsH: CGFloat = CGFloat(max(rows.count, 1)) * 42
    let priv: CGFloat = st.priv && !rows.isEmpty ? 42 : 0   // the private mode line on top
    let meet: CGFloat = hoverMeet != nil ? IslandModel.meetRowH + 8 : 0   // PS 1.66: the meeting stays in the open island
    return 18 + badges + priv + rowsH + undo + meet
  }
}

struct NotchParts: Equatable { var neckW: CGFloat; var neckH: CGFloat; var bodyW: CGFloat; var bodyH: CGFloat; var ear: CGFloat; var radius: CGFloat }

/// A rectangle with its own top and bottom corner radii (the pill: round all round).
struct IslandShape: Shape {
  var top: CGFloat
  var bottom: CGFloat
  var animatableData: AnimatablePair<CGFloat, CGFloat> {
    get { AnimatablePair(top, bottom) }
    set { top = newValue.first; bottom = newValue.second }
  }
  func path(in r: CGRect) -> Path {
    let t = min(top, r.height / 2, r.width / 2), b = min(bottom, r.height / 2, r.width / 2)
    var p = Path()
    p.move(to: CGPoint(x: r.minX + t, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX - t, y: r.minY))
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + t), radius: t)
    p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - b))
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX - b, y: r.maxY), radius: b)
    p.addLine(to: CGPoint(x: r.minX + b, y: r.maxY))
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY - b), radius: b)
    p.addLine(to: CGPoint(x: r.minX, y: r.minY + t))
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + t, y: r.minY), radius: t)
    p.closeSubpath()
    return p
  }
}

/// Around the notch: the neck comes straight down out of the notch (small rounded ears where Slim's wings
/// meet the top of the screen), then, when the body is wider, curves out into it below the menu bar like a
/// drop of ink. Every part animates, so the collapsed looks morph into the open island and back.
struct NotchShape: Shape {
  var parts: NotchParts
  var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>>> {
    get { AnimatablePair(AnimatablePair(parts.neckW, parts.neckH), AnimatablePair(AnimatablePair(parts.bodyW, parts.bodyH), AnimatablePair(parts.ear, parts.radius))) }
    set { parts = NotchParts(neckW: newValue.first.first, neckH: newValue.first.second, bodyW: newValue.second.first.first, bodyH: newValue.second.first.second, ear: newValue.second.second.first, radius: newValue.second.second.second) }
  }
  func path(in r: CGRect) -> Path {
    let cx = r.midX, y0 = r.minY
    let nw = min(parts.neckW, r.width), bw = min(parts.bodyW, r.width)
    let nl = cx - nw / 2, nr = cx + nw / 2, bl = cx - bw / 2, br = cx + bw / 2
    let yb = y0 + parts.neckH, ye = yb + max(0, parts.bodyH)
    let e = max(0, min(parts.ear, parts.neckH / 2, (r.width - nw) / 2))
    let side = (bw - nw) / 2
    var p = Path()
    p.move(to: CGPoint(x: nl - e, y: y0))
    if e > 0.5 { p.addArc(tangent1End: CGPoint(x: nl, y: y0), tangent2End: CGPoint(x: nl, y: y0 + e), radius: e) } else { p.addLine(to: CGPoint(x: nl, y: y0)) }
    if parts.bodyH > 0.5 && side > 0.5 {
      let f = min(10, side / 2, parts.neckH / 2)               // the curve out of the notch
      let sh = max(0, min(10, side - f, parts.bodyH / 2))      // the body's shoulder
      let b = max(0, min(parts.radius, parts.bodyH / 2, bw / 2))
      p.addLine(to: CGPoint(x: nl, y: yb - f))
      if f > 0.3 { p.addArc(tangent1End: CGPoint(x: nl, y: yb), tangent2End: CGPoint(x: nl - f, y: yb), radius: f) }
      p.addLine(to: CGPoint(x: bl + sh, y: yb))
      if sh > 0.3 { p.addArc(tangent1End: CGPoint(x: bl, y: yb), tangent2End: CGPoint(x: bl, y: yb + sh), radius: sh) }
      p.addLine(to: CGPoint(x: bl, y: ye - b))
      p.addArc(tangent1End: CGPoint(x: bl, y: ye), tangent2End: CGPoint(x: bl + b, y: ye), radius: b)
      p.addLine(to: CGPoint(x: br - b, y: ye))
      p.addArc(tangent1End: CGPoint(x: br, y: ye), tangent2End: CGPoint(x: br, y: ye - b), radius: b)
      p.addLine(to: CGPoint(x: br, y: yb + sh))
      if sh > 0.3 { p.addArc(tangent1End: CGPoint(x: br, y: yb), tangent2End: CGPoint(x: br - sh, y: yb), radius: sh) }
      p.addLine(to: CGPoint(x: nr + f, y: yb))
      if f > 0.3 { p.addArc(tangent1End: CGPoint(x: nr, y: yb), tangent2End: CGPoint(x: nr, y: yb - f), radius: f) }
    } else {
      let bottom = max(ye, yb)
      let b = max(0, min(parts.radius, (bottom - y0 - e) / 2, nw / 2))
      p.addLine(to: CGPoint(x: nl, y: bottom - b))
      p.addArc(tangent1End: CGPoint(x: nl, y: bottom), tangent2End: CGPoint(x: nl + b, y: bottom), radius: b)
      p.addLine(to: CGPoint(x: nr - b, y: bottom))
      p.addArc(tangent1End: CGPoint(x: nr, y: bottom), tangent2End: CGPoint(x: nr, y: bottom - b), radius: b)
    }
    p.addLine(to: CGPoint(x: nr, y: y0 + e))
    if e > 0.5 { p.addArc(tangent1End: CGPoint(x: nr, y: y0), tangent2End: CGPoint(x: nr + e, y: y0), radius: e) } else { p.addLine(to: CGPoint(x: nr, y: y0)) }
    p.closeSubpath()
    return p
  }
}


/// The camera notch in black over a Background, fading to clear over `f` points below it (its bottom corners
/// rounded like the real notch's, so the colour wraps them) and either side of it (only Slim's wings reach beside
/// it). Plain gradients, so every picture of it (the self test's too) shows it.
struct NotchBlack: View {
  var w: CGFloat, h: CGFloat, f: CGFloat
  static let corner: CGFloat = 12
  var body: some View {
    ZStack(alignment: .top) {
      HStack(spacing: 0) {
        LinearGradient(colors: [.black.opacity(0), .black], startPoint: .leading, endPoint: .trailing).frame(width: f)
        Color.clear.frame(width: w)
        LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .leading, endPoint: .trailing).frame(width: f)
      }
      .frame(height: max(0, h - NotchBlack.corner))
      IslandShape(top: 0, bottom: NotchBlack.corner)
        .fill(LinearGradient(stops: [.init(color: .black, location: h / (h + f)), .init(color: .black.opacity(0), location: 1)], startPoint: .top, endPoint: .bottom))
        .frame(width: w, height: h + f)
    }
  }
}

struct IslandView: View {
  @ObservedObject var m: IslandModel

  // The colours of the look in use (every one worked out by the page so the words read at WCAG AA).
  private var pt: PillTones { m.st.pillLook }
  private var nt: NotchTones { m.st.notchLook }
  /// The pill's tones, or the notch's (also in the black bar over a full screen app).
  private var usePill: Bool { m.pill && !m.inBar }
  private var fg: Color { m.inBar ? .white : usePill ? pt.fg : nt.fg }
  private var dimC: Color { m.inBar ? Color.white.opacity(0.6) : usePill ? pt.dim : nt.dim }
  private var accent: Color { m.inBar ? .white : usePill ? pt.accent : nt.accent }
  private var mailC: Color { usePill ? pt.mail : nt.mail }
  private var leadC: Color { usePill ? pt.lead : nt.lead }
  private var doneC: Color { usePill ? pt.done : nt.done }
  private var chatC: Color { usePill ? pt.chat : nt.chat }
  /// Only the pill's own colour carries the soft shadow of the open island and the Do Not Disturb edge.
  private var edgeC: Color { m.pill && (pt.style == "solid" || pt.style == "gradient" || pt.style == "glass") ? pt.fg : .white }

  var body: some View {
    let r = m.shapeRect()
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    ZStack(alignment: .topLeading) {
      Color.clear
      ZStack(alignment: .topLeading) {
        Group {
          if m.inBar {
            ZStack {
              Capsule().fill(Color.black)
              Capsule().stroke(Color.white.opacity(m.glowing || m.popping != nil ? 0.6 : 0.12), lineWidth: 1)
                .shadow(color: .white.opacity(m.glowing || m.popping != nil ? 0.5 : 0), radius: 6)
              barRow(r).frame(width: r.width, height: r.height).clipShape(Capsule()).opacity(m.hatchRow)
            }
          } else if m.pill {
            let shape = IslandShape(top: m.expanded ? m.openRadius : r.height / 2, bottom: m.expanded ? m.openRadius : r.height / 2)
            ZStack(alignment: .top) {
              pillBack(shape)
              shape.stroke(edgeC.opacity(m.glowing ? 0.75 : 0), lineWidth: 1.4)
                .shadow(color: edgeC.opacity(m.glowing ? 0.65 : 0), radius: 9)
              content(r).frame(width: r.width, height: r.height, alignment: .top).clipShape(shape).opacity(m.hatchRow)
            }
          } else {
            let shape = NotchShape(parts: m.notchParts())
            ZStack(alignment: .top) {
              notchBack(shape)
              shape.stroke(Color.white.opacity(m.glowing ? 0.75 : 0), lineWidth: 1.4)
                .shadow(color: .white.opacity(m.glowing ? 0.65 : 0), radius: 9)
              content(r).frame(width: r.width, height: r.height, alignment: .top).clipShape(shape).opacity(m.hatchRow)
            }
          }
        }
        .frame(width: r.width, height: r.height)
        // PS 1.67 Hatch: pinched into a dot as the update starts, grown out of the blob at the end (Island.hatchExit, hatchBorn).
        .scaleEffect(x: m.hatchSX, y: m.hatchSY, anchor: .center)
        // V1.55: a card drops out of the island (or goes back in): it swells down and a little wider, then springs back.
        .scaleEffect(x: 1 + m.swell * 0.055, y: 1 + m.swell * min(0.24, 9 / max(r.height, 1)), anchor: .top)
        // The glide to or from the black band: wider along the way, pulled from the side it leaves.
        .scaleEffect(x: IslandPlace.leanScale(m.travel).x, y: IslandPlace.leanScale(m.travel).y, anchor: m.travel < 0 ? .trailing : .leading)
        .offset(x: r.minX, y: r.minY)
        .opacity(m.hasContent ? 1 : 0)
        gripLayer
        // The bubble beside the island (a stand-up in 15 seconds, the next meeting) has its own window since V1.59, sized
        // to its words (IslandBubble.swift BubbleWindow), so it is never cut by this window's edge.
      }
      .frame(width: IslandModel.panelW, height: IslandModel.panelH, alignment: .topLeading)
      // Hidden by the grab line: up into the notch (or the menu bar) and gone, and back down the same way.
      .opacity(m.away ? 0 : 1)
      .offset(y: m.away && !calm ? -10 : 0)
      .scaleEffect(m.away && !calm ? 0.97 : 1, anchor: .top)
    }
    .frame(width: IslandModel.panelW, height: IslandModel.panelH, alignment: .topLeading)
    .environment(\.colorScheme, .dark)
  }

  /// The grab line (V1.36) at the top centre, and its click target, above everything else in the island so a click
  /// there always hides it (for the time set in Settings, 1 minute by default). A stronger grey while the pointer is on
  /// it, then a small tip beside it.
  @ViewBuilder var gripLayer: some View {
    if let c = m.gripCenter(), let hit = m.gripHit() {
      let g = m.pill ? (pt.grip, pt.gripHi) : (nt.grip, nt.gripHi)
      let w = m.gripHover ? IslandModel.gripHoverW : IslandModel.gripW
      Button(action: { m.hide() }) {
        ZStack(alignment: .topLeading) {
          Color.clear
          Capsule().fill(IslandGrip.color(m.gripHover ? g.1 : g.0))
            .frame(width: w, height: IslandModel.gripH)
            .offset(x: (hit.width - w) / 2, y: c.y - hit.minY - IslandModel.gripH / 2)
        }
        .frame(width: hit.width, height: hit.height)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Hide for \(IslandState.hideText(m.st.hide)), or drag to move the island")
      .offset(x: hit.minX, y: hit.minY)
      .opacity(m.opacity)
      .transition(.opacity)
      if m.gripTip {
        // Beside the line, never up under the camera notch. Moved into the right edge (V1.58) there is no room on the
        // right, so it sits on the line's left instead, its right end by the line.
        let tipW: CGFloat = 170, left = c.x + IslandModel.gripHoverW / 2 + 5 + tipW > IslandModel.panelW
        Text(m.editing ? "Drag to move" : "Click hides it, drag moves it")
          .font(.system(size: 10, weight: .medium)).foregroundColor(Color(white: 0.93)).fixedSize()
          .padding(.horizontal, 7).padding(.vertical, 3)
          .background(Capsule().fill(Color(white: 0.13).opacity(0.94)))
          .overlay(Capsule().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
          .shadow(color: .black.opacity(0.3), radius: 4, y: 1)
          .frame(width: tipW, alignment: left ? .trailing : .leading)
          .offset(x: left ? c.x - IslandModel.gripHoverW / 2 - 5 - tipW : c.x + IslandModel.gripHoverW / 2 + 5, y: max(c.y - 9, (m.geo.notch ? m.geo.notchH : 0) + 1))
          .allowsHitTesting(false)
          .transition(.opacity)
      }
    }
  }

  /// The pill's fill in its look. Classic is the plain black it always was.
  @ViewBuilder func pillBack(_ shape: IslandShape) -> some View {
    let o = m.opacity
    let shadow = Color.black.opacity(m.expanded ? 0.45 : 0)
    switch pt.style {
    case "glass":
      ZStack {
        shape.fill(.ultraThinMaterial)
        shape.fill(pt.bg.opacity(pt.glass))
        shape.fill(LinearGradient(colors: [.white.opacity(0.16), .white.opacity(0)], startPoint: .top, endPoint: .center))
        shape.stroke(Color.white.opacity(0.24), lineWidth: 0.8)
      }
      .opacity(o).shadow(color: shadow, radius: 18, y: 8)
    case "gradient":
      shape.fill(LinearGradient(colors: [pt.bg, pt.bg2], startPoint: .leading, endPoint: .trailing))
        .opacity(o).shadow(color: shadow, radius: 18, y: 8)
    case "outline":
      ZStack { shape.fill(pt.bg); shape.stroke(pt.edge ?? .white, lineWidth: 1.5) }
        .opacity(o).shadow(color: shadow, radius: 18, y: 8)
    case "glow":
      ZStack {
        shape.fill(pt.bg).shadow(color: (pt.edge ?? .white).opacity(0.85), radius: m.expanded ? 14 : 9)
        shape.stroke((pt.edge ?? .white).opacity(0.65), lineWidth: 1)
      }
      .opacity(o)
    case "solid":
      shape.fill(pt.bg).opacity(o).shadow(color: shadow, radius: 18, y: 8)
    default:
      // Classic: black, or the Background picked for it (the page sends black when none is).
      shape.fill(pt.bg.opacity(o)).shadow(color: shadow, radius: 18, y: 8)
    }
  }

  /// Around the notch is black like the notch, or filled with the Background picked for it: then the camera
  /// notch stays black and fades into the colour over a few points below it and beside it (NotchBlack), so the
  /// shape still flows out of it (the words start further down, so they only ever sit on the fill). Halo: a soft
  /// glow round the notch in the accent colour, brighter while a task is in progress. Drop and Slim with an
  /// accent: a fine rim.
  @ViewBuilder func notchBack(_ shape: NotchShape) -> some View {
    let o = m.opacity
    ZStack {
      if let fill = nt.fill {
        let r = m.shapeRect()
        shape.fill(fill.opacity(o)).shadow(color: .black.opacity(m.expanded ? 0.45 : 0), radius: 18, y: 8)
        ZStack(alignment: .top) {
          Color.clear
          NotchBlack(w: m.geo.notchW, h: m.geo.notchH, f: IslandModel.notchBlend)
        }
        .frame(width: r.width, height: r.height)
        .clipShape(shape)
        .opacity(o)
        .allowsHitTesting(false)
      } else {
        shape.fill(Color.black.opacity(o)).shadow(color: .black.opacity(m.expanded ? 0.45 : 0), radius: 18, y: 8)
      }
      if nt.style == "halo" {
        let lit: Double = m.expanded ? 0 : (m.st.task?.dim == false ? 0.95 : 0.45)
        shape.stroke(nt.glow.opacity(lit * o), lineWidth: 1.6)
          .shadow(color: nt.glow.opacity(lit * o), radius: 7)
          .shadow(color: nt.glow.opacity(lit * o * 0.6), radius: 14)
      } else if nt.tinted {
        shape.stroke(nt.accent.opacity(0.55 * o), lineWidth: 1.1)
      }
    }
  }

  @ViewBuilder func content(_ r: CGRect) -> some View {
    if let e = m.popping { eventView(e).transition(.opacity) }
    else if m.timerOn { TimerMiddle(m: m, fg: fg, dim: dimC, accent: accent, start: { Island.shared.onAction?("pomoBegin", "") }, open: { IslandTimers.shared.openLink($0) }) }   // V1.58
    else if m.expanded { expandedView.transition(.opacity) }
    else if m.editing && !m.hasNews { editRow.transition(.opacity) }
    else if m.pill { pillRow.transition(.opacity) }
    else if nt.style == "slim" { slimRow.transition(.opacity) }
    else if nt.style == "halo" { Color.clear }
    else { dropRow.transition(.opacity) }
  }

  // ---------- collapsed ----------
  /// In the black bar beside the notch over a full screen app (V1.40): one line sized to the bar, the news if any.
  func barRow(_ r: CGRect) -> some View {
    let size = min(13, max(10, r.height * 0.48)), tick = min(16, max(11, r.height - 8)), left = m.st.tickLeft
    return HStack(spacing: 7) {
      if let e = m.popping {
        Image(systemName: e.kind == "mail" ? "envelope.fill" : e.kind == "lead" ? "arrowshape.turn.up.left.fill" : "checkmark.bubble.fill")
          .font(.system(size: size - 1, weight: .bold)).foregroundColor(e.kind == "mail" ? mailC : e.kind == "lead" ? leadC : chatC)
        Text(e.title).font(.system(size: size, weight: .semibold)).foregroundColor(.white).lineLimit(1).truncationMode(.tail)
        Spacer(minLength: 2)
      } else {
        if left { tickOrUndo(size: tick, short: true) }
        titleText(size: size)
        Spacer(minLength: 2)
        badges(small: true)
        moreText
        if !left { tickOrUndo(size: tick, short: true) }
      }
    }
    .padding(.horizontal, 9)
    .frame(height: r.height)
  }
  /// Drop: the task hangs in the body below the notch, the counts and the tick on its right.
  var dropRow: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: m.geo.notchH)
      HStack(spacing: 7) {
        if m.st.tickLeft { tickOrUndo(size: 18).opacity(m.opacity) }
        Group { iconMark(size: 11); titleText(size: 12) }.opacity(m.opacity)
        Spacer(minLength: 4)
        Group {
          badges(small: true)
          if m.st.mail == 0 || m.st.leads == 0 { moreText }
          if !m.st.tickLeft { tickOrUndo(size: 18) }
        }.opacity(m.opacity)
      }
      .padding(.horizontal, 12)
      .frame(height: 30)
    }
  }
  /// Slim: the tick on the left wing, one count on the right; the task shows on hover.
  var slimRow: some View {
    HStack(spacing: 0) {
      if m.st.tickLeft { slimTick } else { slimCount }
      Color.clear.frame(width: m.geo.notchW)
      if m.st.tickLeft { slimCount } else { slimTick }
    }
    .frame(height: m.geo.notchH)
  }
  /// Slim's tick wing and count wing (the tick on the side set in Settings, the count on the other).
  var slimTick: some View {
    HStack { tickOrUndo(size: 16, short: true) }.opacity(m.opacity)
      .frame(width: IslandModel.slimWing, alignment: .center)
  }
  var slimCount: some View {
    HStack(spacing: 0) {
      if m.st.mail > 0 { badge("envelope.fill", m.st.mail, mailC, small: true, via: IslandMailOpen.gmail).opacity(m.opacity) }
      else if m.st.leads > 0 { badge("arrowshape.turn.up.left.fill", m.st.leads, leadC, small: true, via: IslandMailOpen.instantly).opacity(m.opacity) }
      else if m.st.more > 0 { moreText.opacity(m.opacity) }
      else if m.st.lp != nil { leafMark(small: true).opacity(m.opacity) }
    }
    .frame(width: IslandModel.slimWing, alignment: .center)
  }
  /// Edit mode with nothing else to show: where it is, and how to move it.
  var editRow: some View {
    HStack(spacing: 6) {
      Image(systemName: "hand.draw").font(.system(size: pt.compact ? 10 : 11.5, weight: .semibold)).foregroundColor(accent)
      Text("Drag the line to move the island").font(.system(size: pt.compact ? 11.5 : 12.5, weight: .semibold)).foregroundColor(fg).lineLimit(1)
    }
    .padding(.horizontal, pt.compact ? 10 : 12)
    .frame(maxWidth: .infinity)
    .frame(height: m.pillH)
  }
  var pillRow: some View {
    HStack(spacing: pt.compact ? 6 : 8) {
      if m.st.tickLeft { tickOrUndo(size: pt.compact ? 17 : 20).opacity(m.opacity) }
      Group { badges(small: true); iconMark(size: pt.compact ? 10 : 11.5); titleText(size: pt.compact ? 11.5 : 12.5) }.opacity(m.opacity)
      Spacer(minLength: 4)
      Group { moreText; if !m.st.tickLeft { tickOrUndo(size: pt.compact ? 17 : 20) } }.opacity(m.opacity)
    }
    .padding(.horizontal, pt.compact ? 10 : 12)
    .frame(height: m.pillH)
  }
  /// The optional icon before the task: a small target, in the accent colour.
  @ViewBuilder func iconMark(size: CGFloat) -> some View {
    if (m.pill ? pt.icon : nt.icon), let t = m.st.task, m.ticked == nil {
      Image(systemName: "scope").font(.system(size: size, weight: .bold)).foregroundColor(t.dim ? dimC : accent)
    }
  }
  @ViewBuilder var moreText: some View {
    if m.st.more > 0 && m.ticked == nil { Text("+\(m.st.more)").font(.system(size: 11, weight: .bold)).foregroundColor(dimC) }
  }
  @ViewBuilder func titleText(size: CGFloat) -> some View {
    if m.ticked != nil, !m.undoable || Date().timeIntervalSince(m.tickedAt) < 1.4 {
      Text("Done").font(.system(size: size, weight: .semibold)).foregroundColor(doneC)
    } else if m.privateShown {
      privateLabel(size: size)
    } else if let t = m.st.task {
      HStack(spacing: 6) {
        Text(t.title).font(.system(size: size, weight: .semibold)).foregroundColor(t.dim ? dimC : fg).lineLimit(1).truncationMode(.tail)
        WorkClock(m: m, color: dimC)   // V1.58: Pomodoro time left, only with its setting on
        DayClocks(m: m, color: dimC, size: max(10, size - 1))   // PS 1.70: the task's Priority 1 timer, then the day countdown (DayCountdown.swift)
      }
    }
  }
  /// Private mode on (a friend saw "Hidden (private mode)" and took it for a task): a mask, "Private mode" and a small
  /// Show. A click anywhere on it turns private mode off, and the real task comes back at once.
  func privateLabel(size: CGFloat) -> some View {
    Button(action: { m.privateOff() }) {
      HStack(spacing: 5) {
        Image(systemName: "theatermasks.fill").font(.system(size: size - 1, weight: .bold)).foregroundColor(accent)
        Text("Private mode").font(.system(size: size, weight: .semibold)).foregroundColor(fg).lineLimit(1).fixedSize()
        Text("Show").font(.system(size: max(9.5, size - 2), weight: .bold)).foregroundColor(fg)
          .padding(.horizontal, 6).padding(.vertical, 1.5).background(fg.opacity(0.16)).clipShape(Capsule()).fixedSize()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Private mode is on, so task names are hidden. Click to turn it off and show your task.")
    .accessibilityLabel("Private mode is on. Click to turn it off and show your task")
  }
  /// The open island while private mode is on: one plain line on top, the whole line a button.
  var privateBanner: some View {
    Button(action: { m.privateOff() }) {
      HStack(spacing: 8) {
        Image(systemName: "theatermasks.fill").font(.system(size: 13, weight: .bold)).foregroundColor(accent)
        VStack(alignment: .leading, spacing: 1) {
          Text("Private mode is on").font(.system(size: 13, weight: .bold)).foregroundColor(fg).lineLimit(1)
          Text("Task names are hidden").font(.system(size: 11, weight: .medium)).foregroundColor(dimC).lineLimit(1)
        }
        Spacer(minLength: 4)
        Text("Show tasks").font(.system(size: 12, weight: .bold)).padding(.horizontal, 11).padding(.vertical, 4)
          .background(fg.opacity(0.14)).clipShape(Capsule()).foregroundColor(fg)
      }
      .frame(height: 34)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Private mode is on, task names are hidden. Click to turn it off and show your tasks")
  }
  /// short: the Slim wing has room for the tick only, so Undo shows as an arrow there.
  @ViewBuilder func tickOrUndo(size: CGFloat, short: Bool = false) -> some View {
    if m.undoable, Date().timeIntervalSince(m.tickedAt) >= 1.4 {
      Button(action: { m.untick() }) {
        if short { Image(systemName: "arrow.uturn.backward").font(.system(size: 11, weight: .bold)).foregroundColor(fg) }
        else { Text("Undo").font(.system(size: 11, weight: .bold)).foregroundColor(fg) }
      }.buttonStyle(.plain)
    } else if let t = m.ticked ?? m.st.task {
      tickButton(t, size: size)
    }
  }
  func tickButton(_ t: IslandTask, size: CGFloat) -> some View {
    let done = m.ticked?.id == t.id
    return Button(action: { if !done { m.tick(t) } }) {
      ZStack {
        Circle().stroke(t.dim ? dimC : accent, lineWidth: 1.6)
        Circle().fill(doneC).scaleEffect(done ? 1 : 0.01).opacity(done ? 1 : 0)
        Image(systemName: "checkmark").font(.system(size: size * 0.5, weight: .heavy)).foregroundColor(.black).opacity(done ? 1 : 0)
      }
      .frame(width: size, height: size)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
  }
  @ViewBuilder func badges(small: Bool) -> some View {
    if m.st.lp != nil { leafMark(small: small) }
    if m.st.mail > 0 { badge("envelope.fill", m.st.mail, mailC, small: small, via: IslandMailOpen.gmail) }
    if m.st.leads > 0 { badge("arrowshape.turn.up.left.fill", m.st.leads, leadC, small: small, via: IslandMailOpen.instantly) }
  }
  /// A count on the island (PS 1.61): a click brings the Tab list up on the email panel with the newest email open.
  func badge(_ icon: String, _ n: Int, _ c: Color, small: Bool, via: String) -> some View {
    Button(action: { m.openMail(via) }) {
      HStack(spacing: 3) {
        Image(systemName: icon).font(.system(size: small ? 10 : 12, weight: .bold))
        Text("\(n)").font(.system(size: small ? 10.5 : 12, weight: .heavy)).monospacedDigit()
      }
      .fixedSize()
      .foregroundColor(c)
      .padding(.horizontal, small ? 0 : 9).padding(.vertical, small ? 0 : 5)
      .background(small ? Color.clear : c.opacity(0.16))
      .clipShape(Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .help(IslandMailOpen.hover(via: via, n: n))   // PS 1.68: what the number counts, in plain words
  }

  // ---------- PS 1.65 Low power mode: the leaf and its card ----------
  private var leafC: Color { Color(red: 0.37, green: 0.75, blue: 0.48) }
  /// A small calm leaf: a click opens the card (what is asleep, Wake everything); a second click closes it.
  func leafMark(small: Bool) -> some View {
    Button(action: {
      withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { m.lpOpen.toggle() }
      // It closes by itself after 10 s (and on a click on its title, Wake everything, or when Low power mode ends).
      if m.lpOpen { DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak m] in if m?.lpOpen == true { withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { m?.lpOpen = false } } } }
    }) {
      Image(systemName: "leaf.fill").font(.system(size: small ? 10 : 12, weight: .semibold)).foregroundColor(leafC)
        .padding(.horizontal, small ? 0 : 6).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Low power mode is on")
  }
  func lowPowerCard(_ names: [String]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if !m.pill { Color.clear.frame(height: m.geo.notchH - 8) }
      Button(action: { withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { m.lpOpen = false } }) {
        HStack(spacing: 8) {
          Image(systemName: "leaf.fill").font(.system(size: 13, weight: .semibold)).foregroundColor(leafC)
          Text("Low power mode").font(.system(size: 13.5, weight: .bold)).foregroundColor(fg)
          Spacer(minLength: 0)
        }
        .frame(height: 22).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      Text(LowPowerState.line(names, max: 4)).font(.system(size: 12, weight: .medium)).foregroundColor(dimC).lineLimit(2)
        .frame(maxWidth: .infinity, minHeight: 30, alignment: .topLeading)
      Button(action: { withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { m.lpOpen = false }; m.lowPowerWake() }) {
        Text("Wake everything").font(.system(size: 12, weight: .bold)).padding(.horizontal, 12).padding(.vertical, 5)
          .background(leafC.opacity(0.2)).clipShape(Capsule()).foregroundColor(fg)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 10)
  }

  // ---------- open (hover) ----------
  @ViewBuilder var expandedView: some View {
    if m.lpOpen, let n = m.st.lp { lowPowerCard(n) } else { tasksExpanded }
  }
  var tasksExpanded: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !m.pill { Color.clear.frame(height: m.geo.notchH - 8) }
      if m.st.mail > 0 || m.st.leads > 0 {
        HStack(spacing: 8) {
          if m.st.mail > 0 { badge("envelope.fill", m.st.mail, mailC, small: false, via: IslandMailOpen.gmail) }
          if m.st.leads > 0 { badge("arrowshape.turn.up.left.fill", m.st.leads, leadC, small: false, via: IslandMailOpen.instantly) }
        }
      }
      if m.st.priv && !m.rows.isEmpty { privateBanner }
      if m.rows.isEmpty && m.ticked == nil {
        Text("Nothing marked as working").font(.system(size: 13, weight: .medium)).foregroundColor(dimC).frame(height: 34)
      }
      ForEach(m.rows, id: \.id) { t in
        HStack(spacing: 11) {
          if m.st.tickLeft { tickButton(t, size: 24) }
          VStack(alignment: .leading, spacing: 1) {
            if t.dim { Text("NEXT UP").font(.system(size: 9.5, weight: .heavy)).kerning(0.8).foregroundColor(dimC) }
            Text(t.title).font(.system(size: 13.5, weight: .semibold)).foregroundColor(t.dim ? dimC : fg).lineLimit(2)
          }
          Spacer(minLength: 0)
          if !m.st.tickLeft { tickButton(t, size: 24) }
        }
        .frame(height: 34)
      }
      if let hm = m.hoverMeet { meetRow(hm.mode, hm.mt) }
      if m.undoable, let t = m.ticked {
        HStack(spacing: 8) {
          if m.st.tickLeft { Image(systemName: "checkmark.circle.fill").foregroundColor(doneC) } else { undoChip }
          Text(t.title).font(.system(size: 12.5, weight: .medium)).foregroundColor(dimC).lineLimit(1).strikethrough()
          Spacer(minLength: 4)
          if m.st.tickLeft { undoChip } else { Image(systemName: "checkmark.circle.fill").foregroundColor(doneC) }
        }
        .frame(height: 26)
      }
    }
    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 10)
  }

  /// PS 1.66: the meeting kept in the open island: the camera, its name, "in 12m" (or "12m left"), Join when it has a link.
  /// Right click: Hide this meeting.
  func meetRow(_ mode: String, _ mt: TMeet) -> some View {
    let blue = Color(red: 0.38, green: 0.65, blue: 0.98)
    return HStack(spacing: 11) {
      ZStack { Circle().fill(blue.opacity(0.22)); Image(systemName: "video.fill").font(.system(size: 10.5, weight: .bold)).foregroundColor(blue) }
        .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        Text(mt.title).font(.system(size: 13, weight: .semibold)).foregroundColor(fg).lineLimit(1).truncationMode(.tail)
        HStack(alignment: .firstTextBaseline, spacing: 3) {
          if mode == "now" {
            IslandCountdown(endsAt: mt.end, short: true, size: 11.5, color: dimC)
            Text(BubbleFit.wLeftWord).font(.system(size: 11, weight: .semibold)).foregroundColor(dimC).fixedSize()
          } else {
            Text(BubbleFit.wInWord).font(.system(size: 11, weight: .semibold)).foregroundColor(dimC).fixedSize()
            IslandCountdown(endsAt: mt.start, short: true, size: 11.5, color: dimC)
          }
        }
      }
      Spacer(minLength: 4)
      if let l = mt.link {
        Button(action: { IslandTimers.shared.openLink(l) }) {
          Text(TimersCore.wJoin).font(.system(size: 12, weight: .bold)).padding(.horizontal, 12).padding(.vertical, 4)
            .background(blue).foregroundColor(.black).clipShape(Capsule())
        }.buttonStyle(.plain)
      }
    }
    .frame(height: IslandModel.meetRowH)
    .overlay(alignment: .top) { Rectangle().fill(fg.opacity(0.1)).frame(height: 1).offset(y: -4) }
    .contentShape(Rectangle())
    .contextMenu { Button(BubbleFit.wHide) { IslandTimers.shared.hideMeeting(mt) } }
    .transition(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
    .accessibilityElement(children: .combine)
  }

  var undoChip: some View {
    Button(action: { m.untick() }) {
      Text("Undo").font(.system(size: 12, weight: .bold)).padding(.horizontal, 11).padding(.vertical, 4)
        .background(fg.opacity(0.14)).clipShape(Capsule()).foregroundColor(fg)
    }.buttonStyle(.plain)
  }

  // ---------- a new email, reply or chat: 10 seconds ----------
  func eventView(_ e: IslandEvent) -> some View {
    let c = e.kind == "lead" ? leadC : e.kind == "chat" ? chatC : mailC
    let icon = e.kind == "lead" ? "arrowshape.turn.up.left.fill" : e.kind == "chat" ? "checkmark" : "envelope.fill"
    return Button(action: { m.open(e.url) }) {
      VStack(spacing: 0) {
        if !m.pill { Color.clear.frame(height: m.geo.notchH) }
        HStack(spacing: 12) {
          ZStack { Circle().fill(c.opacity(0.22)); Image(systemName: icon).font(.system(size: 15, weight: .bold)).foregroundColor(c) }
            .frame(width: 38, height: 38)
          VStack(alignment: .leading, spacing: 2) {
            Text(e.title).font(.system(size: 14, weight: .bold)).foregroundColor(fg).lineLimit(1)
            if !e.sub.isEmpty { Text(e.sub).font(.system(size: 12, weight: .medium)).foregroundColor(dimC).lineLimit(2) }
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

final class Island {
  static let shared = Island()
  private var panel: IslandPanel?
  let model = IslandModel()
  /// A tick or an Undo, back to the main window: (action, task id).
  var onAction: ((String, String) -> Void)?
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  private var seen: [String] = []                      // events already shown (newest last)
  var popSeconds = 10.0
  private var popTimer: Timer?
  /// Full screen checks pending after a space or app change (a full screen app settles a moment after the switch).
  private var fsGen = 0
  /// What the full screen check found: none, an app over the whole screen, or one below the notch's black bar.
  private var fsKind: FsKind = .none
  /// Over a full screen app right now (PS 1.60: Welcome back and the workout summary never show then).
  var fullScreenNow: Bool { fsKind != .none }
  typealias FsKind = IslandPlace.Kind
  /// The menu bar is down over the black bar (the pointer went to the top of the screen).
  private var menuDown = false
  /// In the Dock as always, or out of it while a full screen app is in front (IslandPlace.presence says why).
  private(set) var presence: IslandPlace.Presence = .dock
  private var hoverTimer: Timer?
  private var leaveAt: Date?
  private var enterAt: Date?
  private var gripAt: Date?
  /// Hidden by the grab line until then (V1.36): the window is ordered out, so every click reaches what is behind.
  private(set) var hiddenUntil: Date?
  /// How long the grab line hides it: the page's setting (IslandState.hide), or the self test's own.
  var testHide: Double?
  var hideSeconds: Double { testHide ?? model.st.hide }
  private var hideTimer: Timer?
  /// Back under a resting pointer: it opens again only once the pointer has left it (it never springs open over
  /// whatever was just clicked behind it).
  private var waitLeave = false
  /// Self test: when it went and when it came back.
  private(set) var hidAt: Date?, backAt: Date?
  private var monitors: [Any] = []
  private var screen: NSScreen?
  /// Self test: links the island asked to open (never opened in a test copy).
  private(set) var testOpened: [String] = []
  /// Self test: act as if a full screen app were in front.
  var testFullScreen: Bool?

  private var anim: Animation {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .easeInOut(duration: 0.18) : .spring(response: 0.38, dampingFraction: 0.74)
  }

  private func setUp() {
    guard panel == nil else { return }
    let p = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: IslandModel.panelW, height: IslandModel.panelH), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 2)   // above the menu bar, so the wings sit in it
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces           // every desktop and full screen app (IslandPlace.spaces)
    p.ignoresMouseEvents = true
    let host = IslandHost(rootView: IslandView(m: model))
    host.frame = NSRect(x: 0, y: 0, width: IslandModel.panelW, height: IslandModel.panelH)
    p.contentView = host
    if test { p.alphaValue = 0 }
    panel = p
    model.tick = { [weak self] t in self?.tick(t) }
    model.untick = { [weak self] in self?.untick() }
    model.open = { [weak self] u in self?.open(u) }
    model.openMail = { [weak self] via in self?.openMail(via) }
    model.privateOff = { [weak self] in self?.onAction?("privateOff", "") }
    model.lowPowerWake = { [weak self] in self?.onAction?("lowPowerWake", "") }   // PS 1.65 (web src/island.ts)
    model.hide = { [weak self] in self?.hideForAWhile() }
    p.dragHook = { [weak self] e in self?.dragEvent(e) ?? false }
    // V1.56 hang fix: many model changes in a row now make one check, not one each (a spring, a glow and a swell
    // together used to queue a check apiece, and each check re-placed every card window).
    shapeWatch = model.objectWillChange.sink { [weak self] _ in
      guard let self, !self.shapePending else { return }
      self.shapePending = true
      DispatchQueue.main.async { [weak self] in self?.shapePending = false; self?.shapeChanged() }
    }
    loadPos()
    loadAway()
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      self?.place(); self?.fullScreenSoon()
    }
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.followSpace("desktop change"); self?.fullScreenSoon()
    }
    ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in self?.appActivated(n) }
    // V1.58 the island away: a Mac asleep counts no seconds, so the clock is looked at again on wake.
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.checkAway("wake") }
    NotificationCenter.default.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { [weak self] _ in self?.checkAway("clock change") }
  }

  /// From the main window page. While the self test feeds its own states, the page's wait.
  private var testing = false
  private(set) var pageStates = 0
  func fromPage(_ d: [String: Any]) { pageStates += 1; if !testing { update(d); WelcomeBack.shared.fromPage(d) } }

  /// The state ({type:"island"}). Nothing changes on screen when nothing changed (the page re-sends each minute).
  func update(_ d: [String: Any]) {
    let s = IslandState.from(d)
    if s.lp == nil && model.lpOpen { model.lpOpen = false }   // Low power mode ended: its card goes with it
    IslandTimers.shared.update(s.timers, islandOn: s.mode != "off")   // V1.58: also with the island off (pop-up cards then)
    if s.mode == "off" && panel == nil { return }
    setUp()
    var pop = s.event.flatMap { e -> IslandEvent? in seen.contains(e.id) ? nil : e }
    if let e = s.event, !seen.contains(e.id) { seen.append(e.id); if seen.count > 64 { seen.removeFirst(seen.count - 64) } }
    if let p = pop, p.quiet { pop = nil; glow() }   // Do Not Disturb: light up, never open
    let cardsWas = model.st.cards, topWas = model.st.cardsTop, moveWas = model.st.fsMove
    // V1.55: with the cards coming out of the island, the card is the news. The island waits a breath for it: a card
    // that drops out of it (now or just before) means it only glows; no card (muted, or switched off) and it opens as
    // it always did.
    var waitPop: IslandEvent?
    if let p = pop, s.cards, s.mode != "off" { waitPop = p; pop = nil }
    if s != model.st || pop != nil {
      withAnimation(anim) {
        model.st = s
        if let t = model.ticked, s.task?.id != t.id, !model.undoable { model.ticked = nil }
        if let pop { model.popping = pop }
      }
    }
    // News brings a hidden island back at once (V1.40), but never one sent away from its right click menu (V1.58): that
    // stays away until its time or its meeting ends.
    if pop != nil || waitPop != nil, hiddenUntil != nil, away == nil { comeBack() }
    if s.mode != "off" { pageSpoke = true }
    checkAway(nil)
    if let w = waitPop { popOrGlow(w, s) }
    if s.cards != cardsWas || s.cardsTop != topWas { DispatchQueue.main.async { Toast.shared.islandChanged() } }
    if s.fsMove != moveWas { applyFullScreen() }    // switched in Settings while over a full screen app: it glides now
    if pop != nil {
      popTimer?.invalidate()
      popTimer = Timer.scheduledTimer(withTimeInterval: popSeconds, repeats: false) { [weak self] _ in
        guard let self else { return }
        withAnimation(self.anim) { self.model.popping = nil }
        self.refreshMouse()
      }
    }
    place()
  }

  // ---------- notifications out of the island (V1.55, NoteDropCore.swift) ----------
  /// When a card last dropped out of the island.
  private var bornAt = Date.distantPast
  private var popWait: DispatchWorkItem?
  /// News, with the cards coming from the island: a card born in the last 2 s, or within the next 0.7 s, is the news
  /// (the island only glows). Otherwise it opens for its 10 seconds exactly as before.
  private func popOrGlow(_ e: IslandEvent, _ s: IslandState) {
    popWait?.cancel()
    if Date().timeIntervalSince(bornAt) < 2 { glow(); return }
    let w = DispatchWorkItem { [weak self] in
      guard let self else { return }
      if Date().timeIntervalSince(self.bornAt) < 2.7 { self.glow(); return }
      withAnimation(self.anim) { self.model.popping = e }
      self.popTimer?.invalidate()
      self.popTimer = Timer.scheduledTimer(withTimeInterval: self.popSeconds, repeats: false) { [weak self] _ in
        guard let self else { return }
        withAnimation(self.anim) { self.model.popping = nil }
        self.refreshMouse()
      }
      self.place()
    }
    popWait = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: w)
  }
  /// A card dropped out of the island (big) or went back into it. With "Island moments" on (PS 1.60), the island first
  /// squeezes in a tiny bit and then bounces out with the card (IslandMotionCore has the timing); off, the V1.55 swell
  /// as it was. Nothing under reduced motion (the card just fades there), nothing while it is not on screen.
  func swell(_ big: Bool) {
    if big { bornAt = Date() }
    guard let p = panel, p.isVisible, !model.away, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    if Features.on("island-moments") { moment(big ? .cardOut : .cardBack); return }
    let amount: CGFloat = big ? 1 : 0.45
    withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { model.swell = amount }
    DispatchQueue.main.asyncAfter(deadline: .now() + (big ? 0.16 : 0.12)) { [weak self] in
      withAnimation(.spring(response: 0.46, dampingFraction: 0.5)) { self?.model.swell = 0 }
    }
  }
  /// Plays one island moment's springs (IslandMotionCore.steps). A newer moment replaces an older one that is still
  /// playing, so two never fight over the same shape. Drawn only: the island's real size is never changed.
  private var momentToken = 0
  func moment(_ m: IslandMoment) {
    let steps = IslandMotionCore.steps(m, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    guard !steps.isEmpty, let p = panel, p.isVisible, !model.away else { return }
    momentToken += 1
    let token = momentToken
    for st in steps {
      let go = { [weak self] in
        guard let self, self.momentToken == token else { return }
        withAnimation(.spring(response: st.response, dampingFraction: st.damping)) { self.model.swell = CGFloat(st.to) }
      }
      if st.at <= 0 { go() } else { DispatchQueue.main.asyncAfter(deadline: .now() + st.at, execute: go) }
    }
  }
  /// An update finished installing: the island's own short moment (squeeze, two pops), a chime, and the words
  /// "Updated to V1.60" in the little setup island panel (SetupIsland.swift, the same black and the same tick).
  func updateDone(version: String?) {
    guard Features.on("island-moments") else { return }
    moment(.updateDone)
    SetupIsland.shared.say(IslandMotionCore.updatedWords(version: version), moment: .updateDone)
  }

  /// Where the cards hang from: the island's resting shape (never its hover view) and its screen, or nil when the cards
  /// go to the top right as always (the setting off, the island not on screen, hidden by its grab line, over a full
  /// screen app). While it is dragged, the spot it had (the cards follow once it lands).
  private var lastAnchor: NoteDrop.Anchor?
  func noteAnchor() -> NoteDrop.Anchor? {
    if drag?.moving == true { return lastAnchor }
    // Over a full screen app too: in the black band at the top left the cards drop out of it there (the full screen glide).
    guard model.st.cards, model.st.mode != "off", let p = panel, p.isVisible, hiddenUntil == nil, !model.away,
          let vis = screen?.visibleFrame else { lastAnchor = nil; return nil }
    let f = frameFor(model.geo), r = model.restRect()
    let a = NoteDrop.Anchor(island: NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height), visible: vis)
    lastAnchor = a
    return a
  }

  /// A soft white edge for a moment (Do Not Disturb's stand-in for the pop), fading in and out.
  private var glowTimer: Timer?
  var glowSeconds = 2.4
  private func glow() {
    withAnimation(.easeInOut(duration: 0.45)) { model.glowing = true }
    glowTimer?.invalidate()
    glowTimer = Timer.scheduledTimer(withTimeInterval: glowSeconds, repeats: false) { [weak self] _ in
      withAnimation(.easeInOut(duration: 0.9)) { self?.model.glowing = false }
    }
  }

  private var shown: Bool { panel?.isVisible == true }
  /// On screen only when switched on and with something to show. Over 1Password or Signal it follows the build's
  /// rule (BuildRules.now, PS 1.71): shown in the G Squad build for every account, hidden in the developer's own build.
  private func place() {
    guard let p = panel else { return }
    let (g, s) = IslandGeo.read()
    screen = s
    if g != model.geo { model.geo = g }
    syncAnchor()
    let want = model.st.mode != "off" && IslandRules.show(protectedFront: Protected.front, rules: BuildRules.now)
      && model.hasContent && hiddenUntil == nil && !hatchHeld
    if !want {
      if p.isVisible { p.orderOut(nil) }
      setPresence(.dock, "the island is not showing")   // out of the Dock only while the island shows over full screen
      stopWatching()
      shapeChanged()
      return
    }
    if drag?.moving == true { if !p.isVisible { p.orderFrontRegardless() }; return }   // the pointer places it while dragged
    let f = frameFor(g)
    if p.frame != f, Date() >= glideEnds { p.setFrame(f, display: true) }   // mid glide the glide lands it
    if !p.isVisible {
      p.orderFrontRegardless()
      // Back on screen (switched on, news, back from hiding, 1Password or Signal gone): the full screen check only
      // runs while it shows, so whatever came to the front meanwhile is looked at now (it glides to its place).
      if !test { DispatchQueue.main.async { [weak self] in self?.fullScreenSoon() } }
    }
    followSpace("placed")
    startWatching()
    shapeChanged()
  }
  /// 1Password or Signal came to the front or went. Where the island shows over them (the G Squad build) nothing
  /// about it depends on that, so nothing runs at all: no window is looked at and no line is written at that moment.
  func protectedChanged() { SquadIsland.shared.protectedChanged(); if !BuildRules.now.islandOverProtected { place(); BigIslandWindow.shared.protectedChanged() } }
  /// Who is signed in changed (Owner.onChange): the rule over 1Password and Signal may be another one now.
  func rulesChanged() { place() }
  /// V1.58 island timers (IslandTimers.swift): something to show came or went.
  func timersChanged() { place() }
  /// On screen now (switched on, showing, not hidden by its grab line).
  var onScreen: Bool { panel?.isVisible == true && hiddenUntil == nil && !model.away }

  // ---------- every desktop (the developer, 12 Nov 2026: "it doesn't follow me around my desktop anymore") ----------
  /// A drag on the grab line can leave the island on the one desktop it was dropped on (IslandPlace.spaces says why).
  /// This puts it back on every desktop: the behaviour is cleared and set again, so AppKit really tells macOS (setting
  /// the same value again does nothing). Then, if it shows but is not on the desktop in front, it is ordered out and
  /// straight back in there. Same window, same size and level; it never becomes key and PS never activates.
  private func joinAllSpaces(_ why: String) {
    guard let p = panel else { return }
    p.collectionBehavior = []
    p.collectionBehavior = IslandPlace.spaces
    guard IslandPlace.rejoin(visible: p.isVisible, onActiveSpace: p.isOnActiveSpace, dragging: drag?.moving == true) else { return }
    p.orderOut(nil)
    p.orderFrontRegardless()
    psLog("PS island: was missing from this desktop (\(why)), back on every desktop")
  }
  // ---------- PS 1.67 Hatch (Hatch.swift): the island is born by the update and start scenes ----------
  /// While the scene plays the island is off screen: the scene draws its own, takes it away, and gives birth to it at its
  /// place. Let go, it fades in where the scene's own island settled (never over 1Password or Signal: place() decides).
  private(set) var hatchHeld = false
  private var hatchExiting = false
  func hatchHold(_ on: Bool) {
    guard on != hatchHeld else { return }
    hatchHeld = on
    if !on { hatchPlain() }
    guard let p = panel else { return }
    if on || test || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { place(); return }
    p.alphaValue = 0
    place()
    if p.isVisible { NSAnimationContext.runAnimationGroup({ c in c.duration = 0.28; p.animator().alphaValue = 1 }, completionHandler: { p.alphaValue = 1 }) }
    else { p.alphaValue = 1 }
  }
  /// The scale and the row back to normal at once (no animation): after a pinch, or a scene that ended early.
  private func hatchPlain() {
    var t = Transaction(); t.disablesAnimations = true
    withTransaction(t) { model.hatchSX = 1; model.hatchSY = 1; model.hatchRow = 1 }
  }
  /// The scene starts: the REAL island leaves. Its row fades, it pinches into a dot of its own black (its real shape,
  /// looks and colours), then it is held off; the scene page carries the dot down from there. Off screen already: held at once.
  func hatchExit() {
    guard !hatchHeld, !hatchExiting else { return }
    guard let p = panel, p.isVisible, hiddenUntil == nil, !model.away, !test else { hatchHold(true); return }
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      hatchExiting = true
      NSAnimationContext.runAnimationGroup({ c in c.duration = 0.25; p.animator().alphaValue = 0 }, completionHandler: { [weak self] in
        self?.hatchExiting = false; self?.hatchHold(true); p.alphaValue = 1 })
      return
    }
    let r = model.shapeRect()
    hatchExiting = true
    withAnimation(.easeOut(duration: 0.12)) { model.hatchRow = 0 }
    withAnimation(.easeIn(duration: 0.28)) { model.hatchSX = max(0.04, r.height * 0.45 / max(1, r.width)); model.hatchSY = 0.45 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self else { return }
      self.hatchExiting = false
      self.hatchHold(true)
      self.hatchPlain()                                 // ordered out by now: ready to come back at full size
    }
  }
  /// The scene's blob reached the island's place: the REAL island is born out of it, from the blob's size, with a spring
  /// that overshoots a little, then its row (the task, the tick on its side) fades in once it has settled. False when it
  /// is not coming on screen (switched off, nothing to show, 1Password or Signal in front): the scene pops the blob instead.
  @discardableResult func hatchBorn(blob: CGFloat) -> Bool {
    guard hatchHeld else { return onScreen }
    let r = model.shapeRect()
    var t = Transaction(); t.disablesAnimations = true
    withTransaction(t) { model.hatchSX = max(0.04, blob / max(1, r.width)); model.hatchSY = max(0.04, blob / max(1, r.height)); model.hatchRow = 0 }
    hatchHeld = false
    place()
    guard let p = panel, p.isVisible, !test else { hatchPlain(); return false }
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      hatchPlain(); p.alphaValue = 0
      NSAnimationContext.runAnimationGroup({ c in c.duration = 0.3; p.animator().alphaValue = 1 }, completionHandler: { p.alphaValue = 1 })
      return true
    }
    withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) { model.hatchSX = 1; model.hatchSY = 1 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in
      withAnimation(.easeOut(duration: 0.35)) { self?.model.hatchRow = 1 }
    }
    return true
  }
  /// Where the island will rest (bottom left origin, points) while the scene holds it off, or nil when it would not
  /// show (switched off, nothing to show, hidden by its line or sent away).
  func restShape() -> NSRect? {
    guard panel != nil, model.st.mode != "off", model.hasContent, hiddenUntil == nil, away == nil else { return nil }
    let (g, _) = IslandGeo.read()
    let f = frameFor(g), r = model.restRect()
    return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
  }
  /// PS 1.69: where the island sits when it is moved (V1.58 kept spot), whether or not it has anything to show or is hidden
  /// for a while (bottom left origin, points). Just after a relaunch the page has not told the island what to show yet, so
  /// restShape() is nil then and the update scene used to aim at the top: this one needs nothing from the page. Nil at home
  /// (the scene's own guess round the notch fits there), switched off, or while the full screen bar holds the spot.
  func hatchSpot() -> NSRect? {
    guard panel != nil, model.st.mode != "off", model.fs == .off, let p = pos else { return nil }
    let (g, _) = IslandGeo.read()
    let l = IslandPlace.moved(p, g, pillW: model.pillW, pillH: model.pillH)
    let r = IslandPlace.movedShape(anchor: l.anchor, w: model.pillW, h: model.pillH, pillW: model.pillW, pillH: model.pillH, up: IslandPlace.opensUp(p))
    return NSRect(x: l.frame.minX + r.minX, y: l.frame.maxY - r.maxY, width: r.width, height: r.height)
  }
  /// Cheap check (one property read): only when it shows but is missing from the desktop in front does it rejoin.
  private func followSpace(_ why: String) {
    guard let p = panel, IslandPlace.rejoin(visible: p.isVisible, onActiveSpace: p.isOnActiveSpace, dragging: drag?.moving == true) else { return }
    joinAllSpaces(why)
  }
  /// After a drag, a put back or Edit mode: on every desktop again now, and once more when macOS has finished with
  /// the drag (it can settle the window's desktop a moment after the button is let go).
  private func rejoinAfterMove(_ why: String) {
    joinAllSpaces(why)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
      guard let self, self.drag?.moving != true else { return }
      self.joinAllSpaces(why)
    }
  }

  // ---------- island clearance (V1.53, the developer 12 Nov 2026: "the dynamic island is STILL over the top two buttons") ----------
  /// The Tab list slides Keep overlay and Hover mode out of the island's way (the page's src/core/islandclear.ts), so
  /// it is told where the shape is each time that changes: it grows, shrinks, opens, closes, hides behind its grab
  /// line, comes back, is moved, or goes (main.swift pushIsland). Never while it is being dragged (only where it lands).
  var onShape: (() -> Void)?
  private var lastShape = ""
  private var lastFollow = ""
  private var shapePending = false
  private var shapeWatch: AnyCancellable?
  /// The shape on screen (bottom left origin, points) where its current animation ends, or nil when it is not on
  /// screen (off, nothing to show, hidden by its grab line, over 1Password or Signal).
  func shapeOnScreen() -> NSRect? {
    guard let p = panel, p.isVisible, hiddenUntil == nil, !model.away else { return nil }
    let f = drag?.moving == true ? p.frame : frameFor(model.geo)
    let r = model.shapeRect()
    return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
  }
  /// V1.59: where the timer bubble and the first stand-up's question hang from: the island's shape on screen, the
  /// bubble's bottom (centred on the pill, or on the menu bar's height beside the notch), the screen, and the window
  /// they belong to (IslandBubble.swift BubbleWindow and StandAskWindow). Nil while the island is not on screen.
  func timerAnchor() -> (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow)? {
    guard let p = panel, let r = shapeOnScreen() else { return nil }
    let band = model.pill ? model.pillH : model.geo.notchH
    let y = model.pill ? r.maxY - (band + BubbleFit.h) / 2 : frameFor(model.geo).maxY - (band + BubbleFit.h) / 2
    return (r, y, (screen ?? NSScreen.main)?.frame ?? r, p)
  }
  private func shapeChanged() {
    IslandTimers.shared.syncBubble()   // V1.59: the bubble and the stand-up question follow the island
    DayCardWindow.shared.follow()      // PS 1.70: and the day countdown's card
    BigIslandWindow.shared.follow()    // PS 1.60: so does an open Welcome back or workout panel
    SquadIsland.shared.follow()        // PS 1.63: and a G Squad message card
    ScreenRecIsland.shared.syncPart()  // PS 1.60 (12b): the recording part follows the island
    guard drag?.moving != true else { return }
    let k = shapeOnScreen().map { "\(Int($0.minX.rounded())),\(Int($0.minY.rounded())),\(Int($0.width.rounded())),\(Int($0.height.rounded()))" } ?? "none"
    // V1.55: the cards follow the island (they ignore the hover view themselves). V1.56 hang fix: only when their spot,
    // screen or top right choices really changed, never for a swell, a glow or the hover view (NoteDrop.followKey).
    let follow = NoteDrop.followKey(noteAnchor(), top: model.st.cardsTop)
    if follow != lastFollow { lastFollow = follow; Toast.shared.islandChanged() }
    guard k != lastShape else { return }
    lastShape = k
    onShape?()
  }

  // ---------- moved anywhere (G Squad) ----------
  /// Where the island was moved to on this Mac: the collapsed pill's centre as a fraction of the screen (0 left or
  /// bottom, 1 right or top), or nil at home (the top centre, around the notch). Kept as fractions so it means the same
  /// spot on any screen size; the pill is always clamped on screen, off the camera (IslandPlace.clamp).
  /// V1.58: island.spot (fractions of the screen). V1.57's island.pos (fractions of a smaller room) is carried over once.
  private(set) var pos: CGPoint?
  static let posKey = "island.spot", legacyPosKey = "island.pos"
  /// A self test copy keeps the spot in memory only (never in the developer's PS settings).
  private var testStore: [Double]?
  private func readPos() -> [Double]? { test ? testStore : UserDefaults.standard.array(forKey: Island.posKey) as? [Double] }
  private func writePos(_ v: [Double]?) {
    if test { testStore = v } else if let v { UserDefaults.standard.set(v, forKey: Island.posKey) } else { UserDefaults.standard.removeObject(forKey: Island.posKey) }
  }
  var moved: Bool { pos != nil }
  private func loadPos() {
    if let a = readPos(), a.count == 2, a.allSatisfy({ $0.isFinite }) {
      pos = CGPoint(x: min(1, max(0, a[0])), y: min(1, max(0, a[1])))
    } else if !test, let a = UserDefaults.standard.array(forKey: Island.legacyPosKey) as? [Double], a.count == 2, a.allSatisfy({ $0.isFinite }) {
      // The V1.57 spot, turned into the same place on screen, so nobody's island moves on the update.
      let (g, _) = IslandGeo.read()
      pos = IslandPlace.fromLegacy(CGPoint(x: a[0], y: a[1]), g, pillW: model.pillW, pillH: model.pillH)
      writePos(pos.map { [Double($0.x), Double($0.y)] })
      UserDefaults.standard.removeObject(forKey: Island.legacyPosKey)
      psLog("PS island: moved spot carried over from V1.57")
    } else { pos = nil }
    applyFree()
  }
  private func savePos() {
    writePos(pos.map { [Double($0.x), Double($0.y)] })
    onMoved?()
  }
  /// PS > Settings shows whether it is moved (main.swift sendSettings).
  var onMoved: (() -> Void)?
  private func applyFree() {
    let free = pos != nil && model.fs == .off, up = pos.map(IslandPlace.opensUp) ?? false   // over a full screen app: the bar, not the spot
    let a = movedAnchor()
    if model.free != free || model.growUp != up || model.anchor != a { withAnimation(anim) { model.free = free; model.growUp = up; model.anchor = a } }
  }
  /// Where the moved pill sits in its panel for the kept spot on this screen (nil at home).
  private func movedAnchor() -> CGPoint? { pos.map { IslandPlace.moved($0, model.geo, pillW: model.pillW, pillH: model.pillH).anchor } }
  /// The anchor follows the screen and the pill's size (a screen change, the compact look) at once, never animated.
  private func syncAnchor() {
    guard drag?.moving != true, let a = movedAnchor(), model.anchor != a else { return }
    var t = Transaction(); t.disablesAnimations = true
    withTransaction(t) { model.anchor = a }
  }
  /// The moved pill's room, centre and kept spot, and the panel's frame: IslandPlace.swift.
  func frameFor(_ g: IslandGeo) -> NSRect { IslandPlace.frame(model.fs, g, pos: pos, pillW: model.pillW, pillH: model.pillH) }
  /// Back to the top centre (Mac settings, the Tab list's Edit mode).
  func resetPos() {
    rejoinAfterMove("put back")                     // also when it is already home: put back always mends this
    guard pos != nil else { onMoved?(); return }
    pos = nil
    savePos()
    applyFree()
    animatePlace()
  }
  /// The Tab list entered or left Edit mode.
  func setEditing(_ on: Bool) {
    guard model.editing != on else { return }
    if on { setUp() }
    if on, hiddenUntil != nil { if away != nil { endAway("edit mode") } else { comeBack() } }   // Edit mode shows it to be moved
    withAnimation(anim) { model.editing = on }
    place()
    rejoinAfterMove(on ? "edit mode" : "edit mode done")
  }
  private func animatePlace() {
    guard let p = panel, p.isVisible else { place(); return }
    let f = frameFor(model.geo)
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.28
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
      p.animator().setFrame(f, display: true)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { [weak self] in self?.place(); self?.refreshMouse() }
  }

  /// A drag that started on the grab line. While it moves the pill follows the pointer (the window server moves the
  /// window, nothing is redrawn); let go and it settles: home when dropped near the top centre, else where it is.
  private struct Drag { var mouse0: NSPoint; var center0: CGPoint; var moving = false; var center: CGPoint }
  private var drag: Drag?
  private var dragEndedAt = Date.distantPast
  /// How far the pointer must move before a press on the line is a drag (less is a click: it hides).
  static let dragStart: CGFloat = 4
  /// Dropped this close to the top centre, it goes home.
  static let homeSnap: CGFloat = 70
  /// The pill's centre lines up with the screen's middle when this close.
  static let centreSnap: CGFloat = 14
  /// Self test: feeds its own pointer positions instead of the real mouse.
  var testMouse: NSPoint?
  private var mouseNow: NSPoint { testMouse ?? NSEvent.mouseLocation }
  func dragEvent(_ e: NSEvent) -> Bool {
    guard let p = panel else { return false }
    switch e.type {
    case .rightMouseDown:
      // V1.58: right click the grey bar (or just round it) for the island's menu.
      guard let h = model.gripHit(), hiddenUntil == nil, drag?.moving != true else { return false }
      let at = e.locationInWindow, inPanel = CGPoint(x: at.x, y: IslandModel.panelH - at.y)
      guard h.insetBy(dx: -6, dy: -6).contains(inPanel) else { return false }
      showMenu(e)
      return true
    case .leftMouseDown:
      drag = nil
      guard let h = model.gripHit(), hiddenUntil == nil else { return false }
      let at = e.locationInWindow, inPanel = CGPoint(x: at.x, y: IslandModel.panelH - at.y)
      guard h.insetBy(dx: -4, dy: -4).contains(inPanel) else { return false }
      let r = model.shapeRect()
      let f = Island.unparked(p.frame)
      let c = CGPoint(x: f.minX + r.midX, y: f.maxY - r.minY - (model.pill ? model.pillH / 2 : r.height / 2))
      drag = Drag(mouse0: mouseNow, center0: c, center: c)
      return false                                   // the line's button still hears the press (a click hides)
    case .leftMouseDragged:
      guard var d = drag else { return false }
      let m = mouseNow, dx = m.x - d.mouse0.x, dy = m.y - d.mouse0.y
      if !d.moving {
        guard hypot(dx, dy) >= Island.dragStart else { return true }
        d.moving = true
        hoverTimer?.invalidate(); hoverTimer = nil; enterAt = nil; leaveAt = nil; gripAt = nil
        withAnimation(.easeOut(duration: 0.15)) { model.dragging = true; model.hovering = false; model.gripTip = false; model.popping = nil }
        if !model.free || model.growUp { model.free = true; model.growUp = false }   // the pill, its top edge under the line
      }
      // V1.58: anywhere on the screen up to a small edge, into the corners and the top strip, never on the camera.
      let g = model.geo, pw = model.pillW, ph = model.pillH
      var c = IslandPlace.clamp(CGPoint(x: d.center0.x + dx, y: d.center0.y + dy), g, pillW: pw, pillH: ph)
      if abs(c.x - g.frame.midX) < Island.centreSnap {
        let mid = IslandPlace.clamp(CGPoint(x: g.frame.midX, y: c.y), g, pillW: pw, pillH: ph)
        if mid.y == c.y { c = mid }
      }
      d.center = c
      drag = d
      // The panel stays on the screen; near an edge the pill moves inside it (redrawn only when that changes).
      let l = IslandPlace.layout(c, g, pillH: ph, up: false)
      if model.anchor != l.anchor { var t = Transaction(); t.disablesAnimations = true; withTransaction(t) { model.anchor = l.anchor } }
      p.setFrameOrigin(l.frame.origin)
      return true
    case .leftMouseUp:
      guard let d = drag else { return false }
      drag = nil
      guard d.moving else { return false }            // a click: the line's button hides the island
      dragEndedAt = Date()
      drop(d.center)
      // The line's button had the press: it gets its release far away, so it lets go without hiding the island.
      if let up = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: -10_000, y: -10_000), modifierFlags: [], timestamp: e.timestamp,
                                     windowNumber: p.windowNumber, context: nil, eventNumber: e.eventNumber, clickCount: 1, pressure: 0) { p.sendEvent(up) }
      return true
    default:
      return false
    }
  }
  /// A self test copy parks every window far to the left (ScreenGuard): its frame as it would be on screen.
  static func unparked(_ r: NSRect) -> NSRect { r.minX < ScreenGuard.parkX / 2 ? r.offsetBy(dx: -ScreenGuard.parkX, dy: 0) : r }
  /// Where a drag let go (the collapsed pill's centre on screen): home near the top centre, else kept there.
  func drop(_ c: CGPoint) {
    let g = model.geo
    let home = CGPoint(x: g.centerX, y: g.frame.maxY - (g.notch ? g.notchH : g.menuH) - 6 - model.pillH / 2)
    if hypot(c.x - home.x, c.y - home.y) < Island.homeSnap {
      // Home: it glides back up and takes the notch again.
      pos = nil
      savePos()
      withAnimation(anim) { model.dragging = false }
      applyFree()
      animatePlace()
      rejoinAfterMove("drag home")
      return
    }
    // Kept where it was let go. In the lower half the pill moves to the window's bottom edge (so it opens upwards) in
    // the same moment the window moves down by as much: on screen it does not move at all.
    pos = IslandPlace.spot(c, g, pillW: model.pillW, pillH: model.pillH)
    savePos()
    model.dragging = false
    let free = true, up = pos.map(IslandPlace.opensUp) ?? false
    var t = Transaction(); t.disablesAnimations = true
    withTransaction(t) { model.free = free; model.growUp = up; model.anchor = movedAnchor() }
    if let p = panel { p.setFrame(frameFor(g), display: true) }
    place()
    rejoinAfterMove("drag")
  }
  /// The grab line's click hides it, unless that press was the end of a drag.
  private var justDragged: Bool { Date().timeIntervalSince(dragEndedAt) < 0.4 }

  // ---------- the grab line: gone for a while (V1.36; V1.40: 1 minute by default, set in Settings) ----------
  private var outAnim: Animation { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .easeInOut(duration: 0.18) : .easeIn(duration: 0.22) }
  private var inAnim: Animation { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .easeInOut(duration: 0.18) : .spring(response: 0.36, dampingFraction: 0.86) }
  /// Fades and slides the island away, then orders its window out: from the click on, the window takes no clicks
  /// (they go straight through to the tab or app behind it), and once it has faded nothing of it is left on screen.
  /// It comes back the same way after hideSeconds. A new state or a tick in the meantime waits for it; a pop (a new
  /// client email, lead reply or finished chat, not muted by Do Not Disturb) or Edit mode brings it back at once.
  func hideForAWhile() {
    guard let p = panel, p.isVisible, hiddenUntil == nil, !model.away, !justDragged, drag?.moving != true else { return }
    fadeAway(p, until: Date().addingTimeInterval(0.25 + hideSeconds))
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 0.25 + hideSeconds, repeats: false) { [weak self] _ in self?.comeBack() }
  }
  /// Fades and slides the island away and orders its window out (the grab line's click, and the right click menu).
  private func fadeAway(_ p: IslandPanel, until: Date) {
    p.ignoresMouseEvents = true
    hoverTimer?.invalidate(); hoverTimer = nil; enterAt = nil; leaveAt = nil; gripAt = nil
    hiddenUntil = until
    hidAt = Date(); backAt = nil
    withAnimation(outAnim) { model.away = true; model.gripHover = false; model.gripTip = false }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self, self.hiddenUntil != nil else { return }
      self.place()                                  // ordered out, the pointer watchers off
      self.model.hovering = false                   // closed behind the scenes, so it comes back as it rests
    }
  }
  private func comeBack() {
    hideTimer?.invalidate(); hideTimer = nil
    guard hiddenUntil != nil else { return }
    hiddenUntil = nil
    waitLeave = true
    place()                                         // ordered in still faded (never over 1Password or Signal, never when off)
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      withAnimation(self.inAnim) { self.model.away = false }
      self.backAt = Date()
      self.refreshMouse()
    }
  }

  // ---------- away from the right click menu (V1.58, IslandAwayCore.swift) ----------
  // Right click the grey bar: Settings, Disappear for this meeting (only while one is on), Disappear for a time. Away
  // until a wall clock time kept in UserDefaults (island.away), so sleep and a restart change nothing; the clock is
  // looked at on a timer (at most every 30 s), on wake, and on every state from the page (which also follows a moved or
  // longer meeting). Back early: Show it now in the island settings or Settings, Dynamic Island ({type:"island:show"}),
  // or Edit mode. News does not bring it back.
  private(set) var away: IslandAway?
  static let awayKey = "island.away", awayMinutesKey = "island.awayMinutes"
  /// Settings in the menu: the island settings window in the Tab list (web views/IslandSettings.tsx), or the
  /// usual Settings on a page from before it.
  static let openSettingsJS = "(window.__psOpenIslandSettings && window.__psOpenIslandSettings()) || (window.__psOpenSettings && window.__psOpenSettings())"
  /// PS > Settings shows that it is away and until when (main.swift sendSettings).
  var onAway: (() -> Void)?
  /// Settings in the right click menu: the Tab list shows with the island settings window open (main.swift).
  var onSettings: (() -> Void)?
  private var awayTimer: Timer?
  /// A state from the unlocked page has come since PS started: until then a meeting's end is the kept one.
  private var pageSpoke = false
  /// The time in the menu: the last one chosen, 30 minutes the first time.
  var awayMinutes: Int {
    get { let m = UserDefaults.standard.integer(forKey: Island.awayMinutesKey); return m > 0 ? IslandAwayCore.clampMinutes(m) : IslandAwayCore.defaultMinutes }
    set { if !test { UserDefaults.standard.set(IslandAwayCore.clampMinutes(newValue), forKey: Island.awayMinutesKey) } }
  }
  private var nowSecs: Double { Date().timeIntervalSince1970 }
  private func saveAway() {
    guard !test else { return }
    if let d = IslandAwayCore.encode(away) { UserDefaults.standard.set(d, forKey: Island.awayKey) } else { UserDefaults.standard.removeObject(forKey: Island.awayKey) }
  }
  /// A kept away from before a restart: still away until its time (never shown in between).
  private func loadAway() {
    guard !test, let a = IslandAwayCore.decode(UserDefaults.standard.data(forKey: Island.awayKey), now: nowSecs) else {
      if !test { UserDefaults.standard.removeObject(forKey: Island.awayKey) }
      return
    }
    away = a
    hiddenUntil = Date(timeIntervalSince1970: a.until)
    model.away = true
    psLog("PS island: still away after a restart (\(a.kind.rawValue)), back at \(Island.clock(a.until))")
    armAway()
    onAway?()
  }
  static func clock(_ t: Double) -> String { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: Date(timeIntervalSince1970: t)) }
  /// Sent away from the right click menu.
  func goAway(_ a: IslandAway) {
    guard let p = panel, drag?.moving != true else { return }
    hideTimer?.invalidate(); hideTimer = nil
    away = a
    saveAway()
    if p.isVisible, hiddenUntil == nil, !model.away { fadeAway(p, until: Date(timeIntervalSince1970: a.until)) }
    else { hiddenUntil = Date(timeIntervalSince1970: a.until); place() }
    psLog("PS island: away (\(a.kind.rawValue)) until \(Island.clock(a.until))")
    armAway()
    onAway?()
  }
  /// The clock looked at again: still away (its meeting's end followed), or back.
  func checkAway(_ why: String?) {
    guard let a = away else { return }
    switch IslandAwayCore.step(a, now: nowSecs, meets: pageSpoke ? model.st.meets : nil) {
    case .stay(let n):
      if n != a {
        away = n; saveAway(); hiddenUntil = Date(timeIntervalSince1970: n.until)
        psLog("PS island: its meeting moved, away until \(Island.clock(n.until))")
        onAway?()
      }
      armAway()
    case .back: endAway(why ?? (a.kind == .meeting ? "the meeting ended" : "time is up"))
    }
  }
  private func armAway() {
    awayTimer?.invalidate()
    guard let a = away else { awayTimer = nil; return }
    let wait = max(0.5, min(30, a.until - nowSecs))
    awayTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in self?.checkAway(nil) }
    awayTimer?.tolerance = 0.5
  }
  /// Back from the right click menu's away (its time, its meeting, Show it now, Edit mode).
  private func endAway(_ why: String) {
    guard away != nil else { return }
    away = nil
    saveAway()
    awayTimer?.invalidate(); awayTimer = nil
    psLog("PS island: back (\(why))")
    if hiddenUntil == nil { hiddenUntil = Date() }
    comeBack()
    onAway?()
  }
  /// Show it now (the island settings, Settings, Dynamic Island): back from any hide at once.
  func showNow() {
    if away != nil { endAway("Show it now") } else if hiddenUntil != nil { comeBack() }
  }

  /// The right click menu on the grey bar. Its words wait for the developer's approval (v158-island-move.md).
  private var menuTarget: IslandMenuTarget?
  private func showMenu(_ e: NSEvent) {
    guard let p = panel, let view = p.contentView else { return }
    let t = IslandMenuTarget()
    menuTarget = t
    let menu = NSMenu()
    menu.autoenablesItems = false
    let settings = NSMenuItem(title: "Settings", action: #selector(IslandMenuTarget.run(_:)), keyEquivalent: "")
    settings.target = t
    t.actions[settings] = { [weak self] in self?.onSettings?() }
    menu.addItem(settings)
    menu.addItem(.separator())
    if pageSpoke, let m = IslandAwayCore.current(model.st.meets, now: nowSecs) {
      let meet = NSMenuItem(title: "Disappear for this meeting", action: #selector(IslandMenuTarget.run(_:)), keyEquivalent: "")
      meet.target = t
      t.actions[meet] = { [weak self] in
        guard let self, let a = IslandAwayCore.forMeeting(m, now: self.nowSecs) else { return }
        self.goAway(a)
      }
      menu.addItem(meet)
    }
    if let rec = ScreenRecIsland.shared.menuAction() {   // PS 1.60 (12b): "Start recording", only while screen recording is on
      let it = NSMenuItem(title: rec.title, action: #selector(IslandMenuTarget.run(_:)), keyEquivalent: "")
      it.target = t
      t.actions[it] = rec.run
      menu.addItem(it)
    }
    let time = NSMenuItem()
    let v = IslandMinutesView(minutes: awayMinutes) { [weak self] minutes in
      guard let self else { return }
      self.awayMinutes = minutes
      self.goAway(IslandAwayCore.forMinutes(minutes, now: self.nowSecs))
    }
    time.view = v
    menu.addItem(time)
    withAnimation(anim) { model.hovering = false }
    NSMenu.popUpContextMenu(menu, with: e, for: view)
    menuTarget = nil
  }

  // ---------- the pointer: clicks only count on the shape ----------
  /// The shape on screen (bottom left origin), a little larger so the edge is easy to hit. Around the notch
  /// it is the notch part and the body part on their own, never the box round both, so the menus and status
  /// icons beside the notch keep every click.
  private func hitRects() -> [NSRect] {
    guard let p = panel else { return [] }
    let screen = { (r: CGRect) in NSRect(x: p.frame.minX + r.minX, y: p.frame.maxY - r.maxY, width: r.width, height: r.height) }
    let r = model.shapeRect()
    if model.pill { return [screen(r).insetBy(dx: -4, dy: -4)] }
    let n = model.notchParts(), W = IslandModel.panelW
    var out = [screen(CGRect(x: (W - n.neckW) / 2 - n.ear, y: 0, width: n.neckW + n.ear * 2, height: n.neckH)).insetBy(dx: -2, dy: 0)]
    if n.bodyH > 0.5 { out.append(screen(CGRect(x: (W - n.bodyW) / 2, y: n.neckH, width: n.bodyW, height: n.bodyH)).insetBy(dx: -4, dy: -4)) }
    return out
  }
  private func startWatching() {
    guard monitors.isEmpty, !test else { return }
    let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
    if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in self?.refreshMouse() }) { monitors.append(g) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.refreshMouse(); return e }) { monitors.append(l) }
    checkFullScreen()                               // then on space and app changes only (no timer, V1.40)
  }
  private func stopWatching() {
    monitors.forEach(NSEvent.removeMonitor); monitors = []
    hoverTimer?.invalidate(); hoverTimer = nil; enterAt = nil; gripAt = nil
    if model.hovering { model.hovering = false }
    if model.gripHover { model.gripHover = false }
    if model.gripTip { model.gripTip = false }
  }
  /// A few comparisons per mouse move. While the pointer is on the island a light timer notices it leave
  /// (the global monitor hears nothing while the island itself takes the events).
  private func refreshMouse() {
    guard let p = panel, p.isVisible, !test, hiddenUntil == nil, drag?.moving != true else { return }
    let at = NSEvent.mouseLocation
    let inside = hitRects().contains { $0.contains(at) }   // V1.59: the timer bubble has its own window, which takes its clicks
    trackMenuBar(at, onIsland: inside)
    if p.ignoresMouseEvents == inside { p.ignoresMouseEvents = !inside }
    gripPointer(inside ? at : nil)
    if inside {
      leaveAt = nil
      if hoverTimer == nil {
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in self?.refreshMouse() }
      }
      // Around the notch opens only when the pointer rests on it a moment, so sweeping along the menu bar
      // to a menu or a status icon never throws the island open in its way. The pill opens at once, as before.
      // Just back from hiding under the pointer: it waits for the pointer to leave first.
      if !model.hovering && !waitLeave {
        let t = enterAt ?? Date(); enterAt = t
        if model.pill || Date().timeIntervalSince(t) >= IslandModel.hoverIntent { enterAt = nil; withAnimation(anim) { model.hovering = true } }
      }
    } else if waitLeave {
      waitLeave = false; enterAt = nil; hoverTimer?.invalidate(); hoverTimer = nil
    } else if !model.hovering, enterAt != nil {
      enterAt = nil; hoverTimer?.invalidate(); hoverTimer = nil
    } else if model.hovering {
      // A short grace, so a pointer that slips off the edge for a moment does not close it.
      let t = leaveAt ?? Date(); leaveAt = t
      if Date().timeIntervalSince(t) > 0.3 {
        withAnimation(anim) { model.hovering = false }
        hoverTimer?.invalidate(); hoverTimer = nil; leaveAt = nil
      }
    } else { hoverTimer?.invalidate(); hoverTimer = nil }
  }
  /// The pointer on the grab line: a stronger grey at once, the tip after half a second.
  private func gripPointer(_ at: NSPoint?) {
    var on = false
    if let at, let p = panel, let h = model.gripHit() {
      on = NSRect(x: p.frame.minX + h.minX, y: p.frame.maxY - h.maxY, width: h.width, height: h.height).contains(at)
    }
    if on != model.gripHover { withAnimation(.easeOut(duration: 0.15)) { model.gripHover = on } }
    if on {
      let t = gripAt ?? Date(); gripAt = t
      if !model.gripTip && Date().timeIntervalSince(t) >= 0.5 { withAnimation(.easeOut(duration: 0.18)) { model.gripTip = true } }
    } else {
      gripAt = nil
      if model.gripTip { withAnimation(.easeOut(duration: 0.12)) { model.gripTip = false } }
    }
  }

  // ---------- full screen: dim, light up for news; beside the notch on a notched screen (V1.40) ----------
  /// A space or app change, the island coming back, or a screen change: check now, and again as a full screen app
  /// finishes sliding in (a browser's own full screen animation can take a few seconds). No polling.
  private func fullScreenSoon() {
    fsGen += 1
    let gen = fsGen
    checkFullScreen()
    for d in [0.7, 1.6, 3.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + d) { [weak self] in if self?.fsGen == gen { self?.checkFullScreen() } }
    }
  }
  /// PS itself came to the front (the Tab list, Settings): the space did not change, so the island stays where it is.
  private func appActivated(_ n: Notification) {
    let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    if app?.processIdentifier == ProcessInfo.processInfo.processIdentifier { return }
    fullScreenSoon()
  }
  /// Window bounds, owner and layer only (never names or pictures; the only names read are those of the menu bar's
  /// own windows at the main menu level), worked out off the main thread. A full screen app covers the whole screen,
  /// or on a screen with a notch everything below the notch's black bar, AND the menu bar is hidden on that screen:
  /// a big ordinary window under a showing menu bar is not full screen (IslandPlace.decide).
  private func checkFullScreen() {
    if let t = testFullScreen { setFullScreen(t ? .whole : .none); return }
    // V1.58: the island may now show over 1Password or Signal (everyone except the developer). The full screen check reads window
    // bounds and logs, so it never runs while one of them is in front: the island keeps the look it had.
    if !IslandRules.lookAtWindows(protectedFront: Protected.front) { return }
    guard shown, let s = screen, let frontApp = NSWorkspace.shared.frontmostApplication else { return }
    let front = frontApp.processIdentifier
    if front == ProcessInfo.processInfo.processIdentifier {           // PS in front: no change of space
      // ...unless PS stepped out of the Dock for a full screen app and is now in front on a desktop (menu bar showing):
      // then its Dock icon and menus come back at once.
      let menuHere = !menuAlwaysInFullScreen && s.frame.maxY - s.visibleFrame.maxY > 4
      setPresence(IslandPlace.presence(fullScreen: fsKind != .none, islandOn: model.st.mode != "off", psFront: true, menuBarHere: menuHere, now: presence), "PS in front on a desktop")
      return
    }
    let primaryH = NSScreen.screens.first?.frame.height ?? s.frame.height
    let target = IslandPlace.cgRect(s.frame, primaryH: primaryH)
    let inset = s.safeAreaInsets.top
    let reachesTop = s.frame.maxY - s.visibleFrame.maxY <= 4
    let atTop = IslandPlace.pointerAtTop(mouseNow, screen: s.frame, band: max(model.geo.notchH, model.geo.menuH, 24))
    let previous = fsKind
    let menuLevel = Int(CGWindowLevelForKey(.mainMenuWindow))
    let me = ProcessInfo.processInfo.processIdentifier
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
      var all: [(pid: Int32, r: CGRect)] = [], bars: [IslandPlace.BarWindow] = []
      for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if layer == menuLevel { bars.append(IslandPlace.BarWindow(bounds: r, name: w[kCGWindowName as String] as? String)); continue }
        guard layer == 0, let pid = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
        all.append((pid, r))
      }
      // The app in front on the island's own screen (the list runs front to back): with a second display, the app the
      // user clicked on the other screen is not the one in full screen under the island. Else the front app, as before.
      let here = all.first { $0.pid != me && $0.r.width > 40 && $0.r.height > 40 && $0.r.intersection(target).width * $0.r.intersection(target).height > $0.r.width * $0.r.height / 2 }?.pid ?? front
      let wins = all.filter { $0.pid == here }.map(\.r)
      let shape = IslandPlace.kind(wins, screen: target, inset: inset)
      let menu = IslandPlace.menuBar(bars, screen: target, visibleReachesTop: reachesTop)
      let kind = IslandPlace.decide(shape, menu: menu, pointerAtTop: atTop, previous: previous)
      DispatchQueue.main.async {
        guard let self else { return }
        if kind != self.fsKind { psLog("PS island: full screen \(kind) (window \(shape), menu bar \(menu))") }
        self.setFullScreen(kind)
      }
    }
  }
  /// Self test: the dim over a full screen app as on a screen without a notch (the bar is checked on its own).
  var testNoBar = false
  private func setFullScreen(_ k: FsKind) {
    fsKind = k
    let on = k != .none
    if !on { menuDown = false }
    if model.fullScreen != on { withAnimation(.easeInOut(duration: 0.4)) { model.fullScreen = on } }
    // The root cause of the island vanishing over full screen apps (IslandPlace.swift): out of the Dock while one is in
    // front, so macOS draws the island there at all. Just arrived: it fades in where it was, then glides.
    let arrived = setPresence(IslandPlace.presence(fullScreen: on, islandOn: model.st.mode != "off", psFront: false, menuBarHere: false, now: presence),
                              on ? "a full screen app is in front" : "full screen ended")
    if arrived { DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.applyFullScreen() } }
    else { applyFullScreen() }
  }

  /// In the Dock or out of it. Out: the island is put on the full screen Space at once (cleared and set behaviour,
  /// ordered out and straight back in, never key, PS never activates) and fades in where it was. Back in: the Dock
  /// icon and menus return; the island is on the desktop already. True when it just went over a full screen app.
  /// Never in a self test copy (always a background app, ScreenGuard).
  @discardableResult private func setPresence(_ want: IslandPlace.Presence, _ why: String) -> Bool {
    guard want != presence, !test else { return false }
    presence = want
    switch want {
    case .overFullScreen:
      NSApp.setActivationPolicy(.accessory)
      psLog("PS island: out of the Dock while \(why), so it shows over it")
      guard let p = panel, p.isVisible else { return false }
      let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      p.alphaValue = 0
      p.collectionBehavior = []
      p.collectionBehavior = IslandPlace.spaces
      p.orderOut(nil)
      p.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = calm ? 0.15 : 0.32
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        p.animator().alphaValue = 1
      }
      DispatchQueue.main.async { Toast.shared.islandChanged() }   // the cards come from it here too
      return true
    case .dock:
      NSApp.setActivationPolicy(.regular)
      psLog("PS island: back in the Dock (\(why))")
      if let p = panel, p.alphaValue < 1 { p.alphaValue = 1 }
      followSpace("back in the Dock")
      return false
    }
  }
  /// The macOS setting that keeps the menu bar showing in full screen: then the black bar is the menu bar itself,
  /// so the island stays as it was (below it, dimmed).
  private var menuAlwaysInFullScreen: Bool {
    UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleMenuBarVisibleInFullscreen"] as? Bool == true
  }
  /// In the bar, dropped below the menu bar, or as before. Outside full screen, and on screens without a notch, as before
  /// (the moved spot included). Since V1.44 an app over the whole screen goes to the bar too, not just one below it.
  private var lastBarWhyNot = ""
  private func applyFullScreen() {
    let notch = model.geo.notch && !testNoBar, always = menuAlwaysInFullScreen
    let want = IslandPlace.place(fsKind, notch: notch, menuAlways: always, menuDown: menuDown, move: model.st.fsMove)
    // V1.58: one line saying why it is not in the top bar over a full screen app, so a report like "it sits just below
    // the black strip" shows the reason in ps.log.
    let why = IslandPlace.barWhyNot(fsKind, notch: notch, menuAlways: always, move: model.st.fsMove) ?? ""
    if why != lastBarWhyNot { lastBarWhyNot = why; if !why.isEmpty { psLog("PS island: full screen, not in the top bar: \(why)") } }
    guard model.fs != want else { return }
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    // The shape morphs (the notch or pill into the bar's capsule and back) on a soft spring while the window glides.
    withAnimation(calm ? .easeInOut(duration: 0.18) : .spring(response: 0.55, dampingFraction: 0.82)) {
      model.fs = want; if want != .off { model.hovering = false }
    }
    applyFree()
    glidePlace()
  }
  /// The developer: "make it so the dynamic island does a fancy animation so it moves itself up to the top left of the screen
  /// instead". The window glides on a long, soft ease out (fast away, a slow settle) while the shape leans into the
  /// move, wider and a touch flatter, then springs back with a little wobble as it lands. Back the same way when full
  /// screen ends, to its place or its moved spot. Reduce motion: a quick fade across, no travel.
  private var glideEnds = Date.distantPast
  private func glidePlace() {
    guard let p = panel, p.isVisible, drag?.moving != true else { place(); return }
    let f = frameFor(model.geo)
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let g = IslandPlace.glide(from: p.frame, to: f, reduceMotion: calm)
    glideEnds = Date().addingTimeInterval(g.duration)
    if calm {
      NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = g.duration / 2; p.animator().alphaValue = 0 }, completionHandler: {
        p.setFrame(f, display: true)
        NSAnimationContext.runAnimationGroup { ctx in ctx.duration = g.duration / 2; p.animator().alphaValue = 1 }
      })
    } else {
      if g.stretch != 0 { withAnimation(.easeOut(duration: 0.16)) { model.travel = g.stretch } }
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = g.duration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: g.curve[0], g.curve[1], g.curve[2], g.curve[3])
        p.animator().setFrame(f, display: true)
      }
      if g.stretch != 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + g.duration * 0.42) { [weak self] in
          withAnimation(.spring(response: 0.42, dampingFraction: 0.55)) { self?.model.travel = 0 }
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + g.duration + 0.05) { [weak self] in self?.place(); self?.refreshMouse() }
  }
  /// The menu bar slides down over the black bar when the pointer reaches the top of the screen, and back up once the
  /// pointer leaves it. Read from the pointer, which the island already watches (no window list, no timer).
  private func trackMenuBar(_ at: NSPoint, onIsland: Bool) {
    guard fsKind != .none, let s = screen else { return }
    let across = at.x >= s.frame.minX && at.x <= s.frame.maxX
    let down: Bool
    if !menuDown { down = across && at.y >= s.frame.maxY - 1 }
    else { down = onIsland || (across && at.y >= s.frame.maxY - max(model.geo.notchH, 24) - 2) }
    if down != menuDown { menuDown = down; applyFullScreen() }
  }

  // ---------- answers ----------
  private func tick(_ t: IslandTask) {
    withAnimation(anim) { model.ticked = t; model.tickedAt = Date() }
    if !test { NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now) }
    onAction?("tick", t.id)
    // "Done" for a moment, then Undo until 5 s have passed, then gone.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.45) { [weak self] in self?.model.objectWillChange.send() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5.05) { [weak self] in
      guard let self, self.model.ticked?.id == t.id else { return }
      withAnimation(self.anim) { self.model.ticked = nil }
      self.place()
    }
  }
  private func untick() {
    guard let t = model.ticked, model.undoable else { return }
    onAction?("untick", t.id)
    withAnimation(anim) { model.ticked = nil }
  }
  /// PS 1.61: set by main.swift; brings the Tab list up and tells its page which email panel row to open.
  var onOpenMail: ((String) -> Void)?
  private func openMail(_ via: String) {
    guard IslandMailOpen.kinds.contains(via) else { return }
    if test { testOpened.append("ps:mail:" + via) } else { onOpenMail?(via) }
    if model.popping != nil { popTimer?.invalidate(); withAnimation(anim) { model.popping = nil } }
  }
  private func open(_ u: String?) {
    guard let s = Toast.openable(u), let url = URL(string: s) else { return }
    if test { testOpened.append(s) } else { NSWorkspace.shared.open(url) }
    if model.popping != nil { popTimer?.invalidate(); withAnimation(anim) { model.popping = nil } }
  }

  // ---------- self test (fictional tasks and mail only) ----------
  /// Feeds states straight in, checks what the island does, and saves pictures of its looks.
  func selfTest(_ dir: String, _ done: @escaping () -> Void) {
    var r: [(String, Bool)] = []
    var got: [String] = []
    let keep = onAction
    testing = true
    testHide = 5                                    // the grip checks time a 5 second hide; the page's own time is checked below
    onAction = { a, id in got.append("\(a):\(id)") }
    popSeconds = 1.2
    func later(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
    func base(_ x: [String: Any] = [:]) -> [String: Any] {
      var d: [String: Any] = ["mode": "notch", "private": false, "task": ["id": "t1", "title": "Send Lumi Botanics the homepage draft", "dim": false],
                              "more": 1, "tasks": [["id": "t1", "title": "Send Lumi Botanics the homepage draft"], ["id": "t2", "title": "Invoice Northwind Silk for October"]],
                              "mail": 2, "leads": 1, "event": NSNull()]
      x.forEach { d[$0.key] = $0.value }
      return d
    }
    let realGeo = IslandGeo.read().0
    var notchGeo = realGeo
    if !notchGeo.notch { notchGeo.notch = true; notchGeo.notchW = 185; notchGeo.notchH = 32; notchGeo.centerX = notchGeo.frame.midX }
    @discardableResult func picture(_ name: String, notch: Bool) -> NSBitmapImageRep? {
      let m = IslandModel()
      m.st = model.st; m.hovering = model.hovering; m.popping = model.popping; m.ticked = model.ticked; m.tickedAt = model.tickedAt; m.fullScreen = model.fullScreen; m.fs = model.fs; m.glowing = model.glowing
      m.gripHover = model.gripHover; m.gripTip = model.gripTip; m.free = model.free; m.growUp = model.growUp; m.editing = model.editing
      m.geo = notch ? notchGeo : { var g = notchGeo; g.notch = false; return g }()
      let side = (IslandModel.panelW - m.geo.notchW) / 2
      let v = ZStack(alignment: .top) {
        LinearGradient(colors: [Color(red: 0.36, green: 0.55, blue: 0.86), Color(red: 0.93, green: 0.62, blue: 0.48)], startPoint: .topLeading, endPoint: .bottomTrailing)
        Color(white: 0.96).frame(height: m.geo.notchH)                            // the menu bar
        // Fictional menus and status icons right up to the notch, to show what each look leaves visible.
        HStack(spacing: 0) {
          Text("Edit   View   Window   Help").font(.system(size: 13, weight: .medium)).foregroundColor(.black.opacity(0.85)).lineLimit(1).fixedSize()
            .frame(width: side - 10, alignment: .trailing)
          Color.clear.frame(width: m.geo.notchW + 20)
          Text("●  ◐  ▲  Wed 4 Nov  21:30").font(.system(size: 12.5, weight: .medium)).foregroundColor(.black.opacity(0.85)).lineLimit(1).fixedSize()
            .frame(width: side - 10, alignment: .leading)
        }.frame(height: m.geo.notchH)
        if notch { IslandShape(top: 0, bottom: 10).fill(Color.black).frame(width: m.geo.notchW, height: m.geo.notchH) }   // the camera
        IslandView(m: m)
      }.frame(width: IslandModel.panelW, height: IslandModel.panelH)
      // Drawn in a parked test window of its own (ImageRenderer opens a window of its own that the screen check catches).
      let pw = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: IslandModel.panelW, height: IslandModel.panelH), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      pw.alphaValue = 0
      let host = NSHostingView(rootView: v)
      host.frame = NSRect(x: 0, y: 0, width: IslandModel.panelW, height: IslandModel.panelH)
      pw.contentView = host
      host.layoutSubtreeIfNeeded()
      let rep0 = host.bitmapImageRepForCachingDisplay(in: host.bounds)
      if let rep0 { host.cacheDisplay(in: host.bounds, to: rep0) }
      pw.contentView = nil
      if let rep = rep0, let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: "\(dir)/\(name).png")); print("saved", "\(dir)/\(name).png")
      } else { print("island picture failed", name) }
      return rep0
    }
    /// The colour at a point of a picture (top left origin, in points), as 0 to 255 sRGB. The raw pixel is read in
    /// the picture's own colour space (the screen's, Display P3 on the M4) and converted from that: colorAt alone
    /// converted it wrongly (a lighter colour than was painted).
    func pixel(_ rep: NSBitmapImageRep?, _ x: CGFloat, _ y: CGFloat) -> [Int]? {
      guard let rep, rep.samplesPerPixel >= 3, rep.bitsPerSample == 8 else { return nil }
      var raw = [Int](repeating: 0, count: max(4, rep.samplesPerPixel))
      rep.getPixel(&raw, atX: Int(x * CGFloat(rep.pixelsWide) / IslandModel.panelW), y: Int(y * CGFloat(rep.pixelsHigh) / IslandModel.panelH))
      var comps: [CGFloat] = raw.prefix(3).map { CGFloat($0) / 255 } + [1]
      guard let c = NSColor(colorSpace: rep.colorSpace, components: &comps, count: 4).usingColorSpace(.sRGB) else { return nil }
      return [c.redComponent, c.greenComponent, c.blueComponent].map { Int(($0 * 255).rounded()) }
    }
    func near(_ a: [Int]?, _ hex: String, _ tol: Int = 10) -> Bool {
      guard let a, hex.count == 7, let n = Int(hex.dropFirst(), radix: 16) else { return false }
      return zip(a, [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]).allSatisfy { abs($0 - $1) <= tol }
    }

    update(base(["mail": 0, "leads": 0, "task": NSNull(), "tasks": [], "more": 0, "mode": "notch"]))
    r.append(("empty-hides", panel?.isVisible != true))
    update(base())
    r.append(("shows-task", panel?.isVisible == true && model.st.task?.title == "Send Lumi Botanics the homepage draft" && model.st.mail == 2 && model.st.leads == 1))
    r.append(("never-key", panel?.isKeyWindow == false && panel?.canBecomeKey == false && !NSApp.isActive))
    picture("island-notch-idle", notch: true)
    model.hovering = true
    picture("island-notch-open", notch: true)
    model.hovering = false
    // Checks on what comes in: counts capped, links only to Gmail or Instantly, long titles cut.
    let bad = IslandState.from(base(["mail": 500, "leads": -3, "task": ["id": "t9", "title": String(repeating: "x", count: 900)],
                                     "event": ["id": "e0", "kind": "mail", "title": "Fictional", "sub": "", "url": "https://evil.example/x"]]))
    r.append(("validates", bad.mail == 99 && bad.leads == 0 && bad.task?.title.count == 200 && bad.event?.url == nil))
    // The hide time from Settings (V1.40): 1 minute unless set, kept within 5 s and 1 hour, whole seconds.
    let hideIn: [Any?] = [nil, 30, 300, 2, 99999, 12.6, "x"]
    let hides = hideIn.map { v -> Double in IslandState.from(base(v.map { ["hide": $0] } ?? [:])).hide }
    r.append(("hide-time-from-settings", hides == [60, 30, 300, 5, 3600, 13, 60] && IslandState.hideText(60) == "1 minute" && IslandState.hideText(150) == "2 minutes 30 seconds"))
    update(base(["event": ["id": "e1", "kind": "mail", "title": "Jane just sent an email", "sub": "Northwind Silk · Homepage draft", "url": "https://mail.google.com/mail/?authuser=test#all/abc"]]))
    let popped = model.popping?.id == "e1" && model.expanded
    picture("island-notch-email", notch: true)
    later(1.6) {
      let closed = self.model.popping == nil
      self.update(base(["event": ["id": "e1", "kind": "mail", "title": "Jane just sent an email", "sub": "Again", "url": "https://mail.google.com/"]]))
      r.append(("event-pops-then-closes", popped && closed))
      r.append(("same-event-no-pop", self.model.popping == nil))
      // A full screen app: dim, a new reply lights it up and pops it, then dim again.
      self.testNoBar = true; self.testFullScreen = true; self.checkFullScreen()
      let dim = self.model.opacity < 0.5
      self.update(base(["event": ["id": "e2", "kind": "lead", "title": "Lena replied in Instantly", "sub": "example.com · Quick question", "url": "https://app.instantly.ai/app/unibox"]]))
      let lit = self.model.opacity == 1 && self.model.popping?.kind == "lead"
      picture("island-notch-reply", notch: true)
      self.open(self.model.popping?.url)
      r.append(("click-opens-instantly-only", self.testOpened == ["https://app.instantly.ai/app/unibox"] && self.model.popping == nil))
      later(1.5) {
        r.append(("fullscreen-dims-news-lights-up", dim && lit && self.model.opacity < 0.5))
        self.testFullScreen = false; self.checkFullScreen(); self.testNoBar = false
        // Tick, then Undo inside 5 s.
        self.tick(IslandTask(id: "t1", title: "Send Lumi Botanics the homepage draft"))
        picture("island-notch-done", notch: true)
        self.untick()
        r.append(("tick-and-undo", got == ["tick:t1", "untick:t1"]))
        // Nothing working: the next Priority 1 task, dimmed.
        self.update(base(["task": ["id": "p1", "title": "Renew the domain", "dim": true], "tasks": [], "more": 0]))
        r.append(("next-p1-dimmed", self.model.st.task?.dim == true))
        picture("island-notch-nextup", notch: true)
        // Private mode: only what the page sends ("Working"), counts without names.
        self.update(base(["private": true, "task": ["id": "t1", "title": "Working"], "tasks": [["id": "t1", "title": "Working"]], "more": 0]))
        r.append(("private-shows-only-given", self.model.st.task?.title == "Working"))
        // The pill below the notch, and no notch at all.
        self.update(base(["mode": "pill"]))
        r.append(("pill-mode", self.model.pill && self.panel?.isVisible == true))
        picture("island-pill-idle", notch: true)
        self.model.hovering = true
        picture("island-pill-open", notch: true)
        self.model.hovering = false
        picture("island-nonotch", notch: false)
        // The looks (the developer, 4 Nov 2026): every pill look and every around the notch look, collapsed and open.
        let looksOk = IslandState.from(["mode": "pill", "pill": ["style": "solid", "bg": "#1d2b53", "fg": "#ffffff", "glass": 0.7, "edge": "#ff0000"],
                                        "notch": ["style": "wings", "accent": "url(x)"]])
        r.append(("looks-parsed", looksOk.pillLook.style == "solid" && looksOk.pillLook.glass == 0 && looksOk.pillLook.edge == nil
                  && looksOk.notchLook.style == "drop" && looksOk.notchLook.accent == NotchTones().accent && IslandState.from([:]).pillLook == PillTones()))
        for (name, t) in IslandLookFixtures.list("pill") {
          self.update(base(["mode": "pill", "pill": t]))
          picture("look-pill-\(name)", notch: true)
          if name.hasPrefix("classic") || name.hasPrefix("solid-yellow") || name.hasPrefix("glass-blue") || name.hasPrefix("compact-solid") {
            self.model.hovering = true; picture("look-pill-\(name)-open", notch: true); self.model.hovering = false
          }
        }
        // Around the notch stays clear of the menus: in the menu bar it is no wider than the notch (Slim: its two small wings).
        var clear = true
        for (name, t) in IslandLookFixtures.list("notch") {
          self.update(base(["mode": "notch", "notch": t]))
          let m2 = IslandModel(); m2.st = self.model.st; m2.geo = notchGeo
          let p = m2.notchParts(), inBar = p.neckW + p.ear * 2
          clear = clear && inBar <= notchGeo.notchW + (m2.notchStyle == "slim" ? IslandModel.slimWing * 2 + 14 : 0.5) && m2.shapeRect().minY == 0
          picture("look-notch-\(name)", notch: true)
          self.model.hovering = true; picture("look-notch-\(name)-open", notch: true); self.model.hovering = false
        }
        r.append(("notch-looks-clear-of-menus", clear))
        // A Background around the notch (V1.36): the drop's body is painted in the chosen colour, the camera notch
        // stays black and fades into it just below the notch (darker than the fill 3 points down, the fill itself
        // 8 points down), and with no Background the body is black exactly as before.
        var fillOk = true, fillInfo: [String] = []
        for (name, t) in IslandLookFixtures.list("notch") where name.hasPrefix("drop") {
          self.update(base(["mode": "notch", "notch": t]))
          let m2 = IslandModel(); m2.st = self.model.st; m2.geo = notchGeo
          let rect = m2.shapeRect(), body = m2.notchParts()
          let rep = picture("fill-\(name)", notch: true)
          // In the body beside the notch, below the menu bar, clear of the words (they start 12 points in) and the curve.
          let side = pixel(rep, (IslandModel.panelW - body.bodyW) / 2 + 5, rect.minY + body.neckH + body.bodyH - 6)
          let cam = pixel(rep, IslandModel.panelW / 2, notchGeo.notchH / 2)
          let want = (t["fill"] as? String) ?? "#000000"
          let fade = pixel(rep, IslandModel.panelW / 2, notchGeo.notchH + 3), past = pixel(rep, IslandModel.panelW / 2, notchGeo.notchH + IslandModel.notchBlend + 2)
          let blends = t["fill"] is String ? (fade.map { $0.reduce(0, +) } ?? 999) < (past.map { $0.reduce(0, +) } ?? 0) - 12 && near(past, want) : near(fade, "#000000", 6)
          let ok = near(side, want) && near(cam, "#000000", 6) && blends && (t["fill"] == nil || t["fill"] is NSNull || self.model.st.notchLook.fillHex == want)
          fillOk = fillOk && ok
          fillInfo.append("\(name):\(side.map { $0.map(String.init).joined(separator: ",") } ?? "none")")
        }
        r.append(("notch-fill-painted", fillOk))
        print("ISLAND FILL:", fillInfo.joined(separator: " "))
        // No notch (the M1): around the notch shows as the pill, in the pill's own look, under the menu bar.
        self.update(base(["mode": "notch", "notch": ["style": "slim"], "pill": IslandLookFixtures.list("pill").first { $0.0 == "glow-pink" }?.1 ?? [:]]))
        let m3 = IslandModel(); m3.st = self.model.st; m3.geo = { var g = notchGeo; g.notch = false; return g }()
        r.append(("nonotch-uses-pill-look", m3.pill && m3.st.pillLook.style == "glow" && m3.shapeRect().minY == m3.geo.menuH + 6))
        picture("look-nonotch-glow", notch: false)
        func rest() { self.moveCheck(base, picture: { picture($0, notch: true) }) { got in r += got; restOn() } }
        func restOn() {
        // 1Password or Signal in front (V1.58, BuildRules.swift): the developer's account, gone; everyone else's, it stays.
        // Off: gone.
        self.update(base())
        let wasAccount = BuildRules.testAccount
        BuildRules.testAccount = true
        Protected.simulate(front: true, signal: false)
        let hid = self.panel?.isVisible != true
        Protected.simulate(front: false, signal: false)
        r.append(("red:protected-hides", hid && self.panel?.isVisible == true))
        BuildRules.testAccount = false
        self.rulesChanged()
        Protected.simulate(front: true, signal: true)
        let stays = self.panel?.isVisible == true
        Protected.simulate(front: false, signal: false)
        r.append(("public:protected-stays", stays && self.panel?.isVisible == true))
        BuildRules.testAccount = wasAccount
        self.rulesChanged()
        self.update(base(["mode": "off"]))
        r.append(("off-hides", self.panel?.isVisible != true))
        r.append(("still-not-key", self.panel?.isKeyWindow == false && !NSApp.isActive))
        print("ISLAND CHECK:", r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "),
              "notch=\(realGeo.notch ? "\(Int(realGeo.notchW))x\(Int(realGeo.notchH))" : "none")", "page-states=\(self.pageStates) (info)")
        self.onAction = keep
        self.testing = false
        self.testHide = nil
        self.testFullScreen = nil
        self.popSeconds = 10
        done()
        }
        // ---------- the grab line (V1.36, the developer 6 Nov 2026): a grey line at the top centre; a click hides the island
        // and its window for 5 seconds, then it comes back ----------
        // The same greys as the page (tests/islandlook.test.ts, "the grab line's greys match the Mac's table").
        func gp(_ t: [String: Any]) -> String { let x = PillTones.from(t); return "\(x.grip),\(x.gripHi)" }
        func gn(_ fill: String?) -> String { let x = NotchTones.from(["style": "drop", "fill": fill.map { $0 as Any } ?? NSNull()]); return "\(x.grip),\(x.gripHi)" }
        let table = [gp(["style": "classic", "bg": "#000000", "bg2": "#000000"]) == "100,137",
                     gp(["style": "solid", "bg": "#f4f1ea", "bg2": "#f4f1ea"]) == "128,91",
                     gp(["style": "solid", "bg": "#ff2e3e", "bg2": "#ff2e3e"]) == "49,0",
                     gp(["style": "glass", "bg": "#254a99", "bg2": "#254a99", "glass": 0.8]) == "216,255",
                     gp(["style": "gradient", "bg": "#376fe6", "bg2": "#204085"]) == "225,255",
                     gn(nil) == "100,137", gn("#f4f1ea") == "59,16", gn("#5b1a2e") == "134,177"]
        r.append(("grip-tones-match-page", !table.contains(false)))
        // Painted at the top centre, in its grey, standing out from the island right beside it, with a clear gap below
        // it before anything else (the words start lower down).
        var gripOk = true, gripInfo: [String] = []
        let cases: [(String, [String: Any], Bool, Int)] = [
          ("notch-drop", ["mode": "notch"], true, 100),
          ("notch-drop-cream", ["mode": "notch", "notch": ["style": "drop", "fill": "#f4f1ea", "fg": "#121216", "dim": "#55555a"]], true, 59),
          ("pill-classic", ["mode": "pill"], true, 100),
          ("pill-solid-cream", ["mode": "pill", "pill": ["style": "solid", "bg": "#f4f1ea", "bg2": "#f4f1ea", "fg": "#121216", "dim": "#55555a"]], true, 128),
          ("pill-compact-red", ["mode": "pill", "pill": ["style": "solid", "size": "compact", "bg": "#ff2e3e", "bg2": "#ff2e3e", "fg": "#121216", "dim": "#3a0a10"]], true, 49),
          ("nonotch-classic", ["mode": "notch"], false, 100)]
        for (name, st, notch, grey) in cases {
          self.update(base(st))
          let m2 = IslandModel(); m2.st = self.model.st; m2.geo = notch ? notchGeo : { var g = notchGeo; g.notch = false; return g }()
          guard let c = m2.gripCenter() else { gripOk = false; gripInfo.append("\(name):none"); continue }
          let top = m2.pill ? m2.shapeRect().minY : m2.geo.notchH
          let placed = abs(c.x - IslandModel.panelW / 2) < 0.5 && c.y - top >= 3 && c.y - top <= 6
          let rep = picture("grip-\(name)", notch: notch)
          let line = pixel(rep, c.x, c.y), beside = pixel(rep, c.x - 24, c.y)
          let below = pixel(rep, c.x, c.y + 2.5), belowSide = pixel(rep, c.x - 24, c.y + 2.5)
          let hex = String(format: "#%02x%02x%02x", grey, grey, grey)
          let shows = near(line, hex, 12) && (line.flatMap { l in beside.map { b in IslandGrip.contrast(l.map(Double.init), b.map(Double.init)) } } ?? 0) >= 3
          let gap = zip(below ?? [], belowSide ?? [999, 999, 999]).allSatisfy { abs($0 - $1) <= 14 }
          let ok = placed && shows && gap
          gripOk = gripOk && ok
          gripInfo.append("\(name):\(ok ? "ok" : "FAIL") line=\(line.map { $0.map(String.init).joined(separator: ",") } ?? "none") beside=\(beside.map { $0.map(String.init).joined(separator: ",") } ?? "none") at=\(Int(c.y - top))")
        }
        r.append(("grip-painted-top-centre", gripOk))
        print("ISLAND GRIP:", gripInfo.joined(separator: " "))
        // Slim and Halo have no body under the notch until they open: the line shows once they do.
        var slimOk = true
        for style in ["slim", "halo"] {
          self.update(base(["mode": "notch", "notch": ["style": style]]))
          let m2 = IslandModel(); m2.st = self.model.st; m2.geo = notchGeo
          let shut = m2.gripCenter() == nil
          m2.hovering = true
          slimOk = slimOk && shut && m2.gripCenter() != nil
        }
        r.append(("grip-slim-halo-when-open", slimOk))
        self.update(base(["mode": "notch"]))
        self.model.hovering = true; self.model.gripHover = true; self.model.gripTip = true
        picture("island-grip-hover", notch: true)
        self.model.hovering = false; self.model.gripHover = false; self.model.gripTip = false
        // Real clicks through the island's own window (parked off screen in a test copy), where the pointer would
        // put them: the tick still ticks (the line takes nothing from it), the line hides the island.
        self.update(base())
        func click(_ at: CGPoint, _ f: @escaping () -> Void) {
          guard let p = self.panel else { f(); return }
          p.ignoresMouseEvents = false                // as with the pointer on the island
          let inWin = NSPoint(x: at.x, y: IslandModel.panelH - at.y)
          func ev(_ t: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(with: t, location: inWin, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: p.windowNumber,
                               context: nil, eventNumber: 61, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1)
          }
          // Both go through the app's own event queue, so a button that tracks the mouse after the press still gets its release.
          if let d = ev(.leftMouseDown), let u = ev(.leftMouseUp) { NSApp.postEvent(d, atStart: false); NSApp.postEvent(u, atStart: false) }
          later(0.2) { f() }
        }
        /// The island's window in the window server's list of windows on screen, if it is there (alpha, layer, bounds).
        func listing() -> String? {
          guard let n = self.panel?.windowNumber else { return nil }
          let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
          return list.first { ($0[kCGWindowNumber as String] as? Int) == n }.map { w in
            "alpha=\(w[kCGWindowAlpha as String] ?? "?") layer=\(w[kCGWindowLayer as String] ?? "?") bounds=\((w[kCGWindowBounds as String] as? [String: Any]).map { "\($0["X"] ?? 0),\($0["Y"] ?? 0) \($0["Width"] ?? 0)x\($0["Height"] ?? 0)" } ?? "?")"
          }
        }
        func listed() -> Bool { listing() != nil }
        let tickAt: CGPoint = {
          let rr = self.model.shapeRect()
          if self.model.pill { return CGPoint(x: rr.maxX - 12 - self.model.pillH * 0.3, y: rr.minY + self.model.pillH / 2) }
          return CGPoint(x: (IslandModel.panelW + self.model.notchParts().bodyW) / 2 - 12 - 9, y: self.model.geo.notchH + 15)
        }()
        let before = got.count
        click(tickAt) {
          let ticked = got.count == before + 1 && got.last == "tick:t1" && self.hiddenUntil == nil
          self.untick()
          r.append(("grip-leaves-tick", ticked))
          let wasListed = listed() && self.panel?.isVisible == true
          guard let gc = self.model.gripCenter() else { r.append(("grip-click-hides", false)); r.append(("grip-back-after-5s", false)); rest(); return }
          let sent = got.count
          click(gc) {
            let going = self.hiddenUntil != nil && self.model.away && self.panel?.ignoresMouseEvents == true && got.count == sent
            later(0.45) {
              let out = self.panel?.isVisible != true, early = listing(), deaf = self.panel?.ignoresMouseEvents == true
              // A new state while it is away does not bring it back early.
              self.update(base(["more": 3]))
              let stays = self.panel?.isVisible != true
              later(1.5) {
                // By now the window server has it off its list of windows on screen too (nothing left to catch a click).
                let late = listing()
                let gone = out && late == nil && deaf && self.panel?.isVisible != true
                print("ISLAND GRIP AWAY: ordered-out=\(out) takes-no-clicks=\(deaf) listed-at-0.65s=\(early ?? "no") listed-at-2.15s=\(late ?? "no") hidden-for=\(self.hiddenUntil.map { String(format: "%.2f", $0.timeIntervalSinceNow) } ?? "none")")
                r.append(("grip-click-hides", wasListed && going && gone && stays))
                print("ISLAND GRIP CLICK: listed-before=\(wasListed) going=\(going) gone=\(gone) stays-away=\(stays)")
              }
              later(self.hideSeconds + 0.25) {
                let secs = self.backAt.flatMap { b in self.hidAt.map { b.timeIntervalSince($0) } } ?? -1
                let back = self.panel?.isVisible == true && listed() && self.hiddenUntil == nil && !self.model.away && secs >= 5 && secs <= 6
                r.append(("grip-back-after-5s", back))
                print(String(format: "ISLAND GRIP BACK: after %.2f s, shown=%@", secs, back ? "yes" : "no"))
                rest()
              }
            }
          }
        }
      }
    }
  }
}

// ---------- self test: moved anywhere (G Squad, the developer 7 Nov 2026) ----------
// A real drag on the grab line through the island's own window (the drag hook sees the test copy's own pointer
// positions, never the developer's mouse): it goes down the screen as the pill, opens upwards there, a press that ends a drag
// never hides it, and the spot is kept. Then: on screen at every corner of three screen sizes and (V1.58) right in each
// corner, let go at the top left it sits in the top strip in the corner, dropped near the top
// centre it goes home, Reset puts it home, the Tab list's Edit mode shows it with nothing to show, and the window
// stays its one small size (no invisible window over the screen). Pictures: island-moved.png, island-edit.png.
extension Island {
  func moveCheck(_ base: @escaping ([String: Any]) -> [String: Any], picture: @escaping (String) -> Void, _ done: @escaping ([(String, Bool)]) -> Void) {
    var r: [(String, Bool)] = []
    func later(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
    resetPos()
    update(base(["mode": "notch"]))
    guard let p = panel else { done([("move-panel", false)]); return }
    let home = frameFor(model.geo)
    r.append(("move-starts-home", !moved && Island.unparked(p.frame) == home))
    // The line: hovered open first where the look has no line until open (Slim, Halo), as the pointer would.
    if model.gripCenter() == nil { model.hovering = true }
    guard let gc = model.gripCenter() else { done(r + [("move-grip", false)]); return }
    let start = NSPoint(x: Island.unparked(p.frame).minX + gc.x, y: Island.unparked(p.frame).maxY - gc.y)
    let g = model.geo
    let target = NSPoint(x: g.frame.minX + g.frame.width * 0.25, y: g.frame.minY + g.frame.height * 0.22)
    var n = 900
    func post(_ t: NSEvent.EventType, _ screen: NSPoint) {
      testMouse = screen
      n += 1
      let pf = Island.unparked(p.frame), inWin = NSPoint(x: screen.x - pf.minX, y: screen.y - pf.minY)
      if let e = NSEvent.mouseEvent(with: t, location: inWin, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: p.windowNumber,
                                    context: nil, eventNumber: n, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1) { NSApp.postEvent(e, atStart: false) }
    }
    p.ignoresMouseEvents = false
    let steps = 12
    post(.leftMouseDown, start)
    func step(_ i: Int) {
      if i > steps { post(.leftMouseUp, target); later(0.6) { afterDrop() }; return }
      let t = CGFloat(i) / CGFloat(steps)
      post(.leftMouseDragged, NSPoint(x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t))
      later(0.03) { step(i + 1) }
    }
    later(0.08) { step(1) }
    func inside(_ f: NSRect, _ s: NSRect) -> Bool { f.minX >= s.minX - 0.5 && f.maxX <= s.maxX + 0.5 && f.minY >= s.minY - 0.5 && f.maxY <= s.maxY + 0.5 }
    func afterDrop() {
      testMouse = nil
      let f = Island.unparked(p.frame), kept = readPos()
      r.append(("move-drag-moves", moved && model.free && model.pill && f.minY < home.minY - 200 && f.size == home.size))
      r.append(("move-drag-never-hides", hiddenUntil == nil && !model.away && p.isVisible))
      r.append(("move-lower-half-opens-up", model.growUp && (pos?.y ?? 1) < 0.5 && model.shapeRect().maxY > IslandModel.panelH - 2 * IslandModel.freeGap - model.pillH))
      r.append(("move-kept", kept?.count == 2 && abs(CGFloat(kept![0]) - pos!.x) < 0.0001))
      r.append(("move-on-screen", inside(f, g.frame)))
      // The pill sits where it was let go (the pointer was on the line, a few points into the pill).
      let r0 = model.shapeRect(), pillC = CGPoint(x: f.minX + r0.midX, y: f.maxY - r0.minY - model.pillH / 2)
      r.append(("move-where-dropped", abs(pillC.x - target.x) < 3 && abs(pillC.y - target.y) < model.pillH))
      model.hovering = true
      picture("island-moved")
      r.append(("move-open-on-screen", inside(NSRect(x: f.minX + model.shapeRect().minX, y: f.maxY - model.shapeRect().maxY, width: model.shapeRect().width, height: model.shapeRect().height), g.frame)))
      model.hovering = false
      print("ISLAND MOVED: spot=\(pos.map { "\($0.x),\($0.y)" } ?? "home") frame=\(Int(f.minX)),\(Int(f.minY)) growUp=\(model.growUp)")
      // Reloaded (a restart): the same spot.
      let was = pos
      pos = nil; loadPos()
      r.append(("move-survives-restart", pos == was && model.free))
      // Every corner of three screen sizes: the window, and the island open inside it, fully on screen, and (V1.58) the
      // pill right into each corner, a small edge from the sides and the top (IslandPlace.edgeGap, topGap).
      var ok = true, corners = true
      let pw = model.pillW, ph = model.pillH, eg = IslandPlace.edgeGap, tg = IslandPlace.topGap
      for size in [CGSize(width: 1280, height: 800), CGSize(width: 1512, height: 982), CGSize(width: 3440, height: 1440)] {
        var fake = g; fake.frame = NSRect(origin: .zero, size: size); fake.centerX = size.width / 2; fake.notch = false
        for spot in [CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 1), CGPoint(x: 0.5, y: 0.5)] {
          let keep = pos
          pos = spot; applyFree()
          let fr = frameFor(fake), l = IslandPlace.moved(spot, fake, pillW: pw, pillH: ph), up = IslandPlace.opensUp(spot)
          if !inside(fr, fake.frame) || fr != l.frame { ok = false; print("ISLAND OFF SCREEN:", size, spot, fr) }
          let pill = IslandPlace.movedShape(anchor: l.anchor, w: pw, h: ph, pillW: pw, pillH: ph, up: up)
          let open = IslandPlace.movedShape(anchor: l.anchor, w: model.pillOpenW, h: 220, pillW: pw, pillH: ph, up: up)
          let ps = NSRect(x: fr.minX + pill.minX, y: fr.maxY - pill.maxY, width: pill.width, height: pill.height)
          if !inside(NSRect(x: fr.minX + open.minX, y: fr.maxY - open.maxY, width: open.width, height: open.height), fake.frame) { ok = false }
          if spot != CGPoint(x: 0.5, y: 0.5) {
            let sideGap = spot.x == 0 ? ps.minX - fake.frame.minX : fake.frame.maxX - ps.maxX
            let endGap = spot.y == 0 ? ps.minY - fake.frame.minY : fake.frame.maxY - ps.maxY
            if abs(sideGap - eg) > 0.5 || abs(endGap - (spot.y == 0 ? eg : tg)) > 0.5 { corners = false; print("ISLAND NOT IN THE CORNER:", size, spot, ps) }
          }
          // The fraction gives back the same spot.
          let c = IslandPlace.center(spot, fake, pillW: pw, pillH: ph), back = IslandPlace.spot(c, fake, pillW: pw, pillH: ph)
          if abs((c.x - fake.frame.minX) / size.width - back.x) > 0.001 || abs((c.y - fake.frame.minY) / size.height - back.y) > 0.001 { ok = false }
          pos = keep; applyFree()
        }
      }
      r.append(("move-into-every-corner", corners))
      r.append(("move-any-screen-size", ok))
      // V1.58: let go at the very top left, it sits in the top strip in the corner (beside the notch, never on it).
      drop(CGPoint(x: g.frame.minX, y: g.frame.maxY))
      do {
        let f = Island.unparked(p.frame), sr = model.shapeRect()
        let ps = NSRect(x: f.minX + sr.minX, y: f.maxY - sr.maxY, width: sr.width, height: sr.height)
        r.append(("move-top-left-corner", moved && abs(ps.minX - g.frame.minX - IslandPlace.edgeGap) < 0.6 && abs(g.frame.maxY - ps.maxY - IslandPlace.topGap) < 0.6 && inside(f, g.frame)))
      }
      // Near the top centre: home again (around the notch).
      let homeC = CGPoint(x: g.centerX, y: g.frame.maxY - (g.notch ? g.notchH : g.menuH) - 6 - model.pillH / 2)
      drop(CGPoint(x: homeC.x + 20, y: homeC.y - 30))
      r.append(("move-snaps-home", !moved && !model.free && readPos() == nil))
      // Reset (Settings, Edit mode).
      drop(CGPoint(x: g.frame.maxX - 300, y: g.frame.midY + 100))
      let away = moved && !model.growUp
      var told = false
      let tell = onMoved
      onMoved = { told = true }
      resetPos()
      onMoved = tell
      later(0.45) {
        r.append(("move-reset", away && !self.moved && !self.model.free && self.readPos() == nil && told && self.panel.map { Island.unparked($0.frame) } == self.frameFor(self.model.geo)))
        // Edit mode with nothing to show: it shows (as the pill, with its hint), and goes again after.
        self.update(base(["mail": 0, "leads": 0, "task": NSNull(), "tasks": [], "more": 0]))
        let hidden = self.panel?.isVisible != true
        self.setEditing(true)
        let shown = self.panel?.isVisible == true && self.model.pill && self.model.gripCenter() != nil
        picture("island-edit")
        self.setEditing(false)
        r.append(("move-edit-mode-shows", hidden && shown && self.panel?.isVisible != true))
        r.append(("move-window-small", self.panel.map { $0.frame.width <= IslandModel.panelW && $0.frame.height <= IslandModel.panelH } ?? false))
        self.update(base([:]))
        r += self.fullScreenBarChecks()
        r += self.awayChecks()
        done(r)
      }
    }
  }
  /// Over a full screen app on a screen with a notch (V1.40): in the black bar left of the notch, one line; dropped
  /// below the menu bar while it is down; as before once the app leaves full screen. Needs a notched screen.
  /// V1.58 the right click menu's away (IslandAwayCore.swift has the full rules offline): away for a meeting, its new
  /// end followed, back when it is gone; away for minutes; Show it now. A test copy keeps nothing in UserDefaults.
  func awayChecks() -> [(String, Bool)] {
    var r: [(String, Bool)] = []
    let was = pageSpoke, meetsWas = model.st.meets, now = nowSecs
    pageSpoke = true
    model.st.meets = [IslandMeet(id: "selftest", start: now - 60, end: now + 600, real: true)]
    r.append(("away-menu-offers-meeting", IslandAwayCore.current(model.st.meets, now: now)?.id == "selftest"))
    if let a = IslandAwayCore.forMeeting(model.st.meets[0], now: now) { goAway(a) }
    r.append(("away-meeting-hidden", away?.kind == .meeting && hiddenUntil != nil && model.away))
    model.st.meets = [IslandMeet(id: "selftest", start: now - 60, end: now + 1200, real: true)]
    checkAway(nil)
    r.append(("away-meeting-follows-new-end", abs((away?.until ?? 0) - (now + 1200)) < 1))
    model.st.meets = []
    checkAway(nil)
    r.append(("away-meeting-gone-back", away == nil && hiddenUntil == nil))
    goAway(IslandAwayCore.forMinutes(30, now: nowSecs))
    r.append(("away-minutes-hidden", away?.kind == .minutes && hiddenUntil != nil))
    showNow()
    r.append(("away-show-now", away == nil && hiddenUntil == nil))
    model.st.meets = meetsWas
    pageSpoke = was
    return r
  }
  func fullScreenBarChecks() -> [(String, Bool)] {
    guard model.geo.notch, !menuAlwaysInFullScreen else { print("ISLAND FULL SCREEN BAR: skipped (no notch here)"); return [] }
    var r: [(String, Bool)] = []
    let g = model.geo
    setFullScreen(.belowNotch)
    let f = frameFor(g), sr = model.shapeRect()
    let barRight = f.minX + sr.maxX
    r.append(("fullscreen-in-bar", model.fs == .bar && model.inBar && !model.expanded && model.opacity == 1))
    r.append(("fullscreen-bar-left-of-notch", barRight <= g.notchLeft - 8 && f.minX + sr.minX >= g.frame.minX && sr.minY >= 0 && sr.maxY <= g.notchH))
    r.append(("fullscreen-bar-no-grip", model.gripCenter() == nil))
    trackMenuBar(NSPoint(x: g.frame.midX - 300, y: g.frame.maxY), onIsland: false)
    r.append(("fullscreen-menu-drops-it", model.fs == .dropped && model.pill && model.expanded && model.shapeRect().minY >= g.notchH))
    trackMenuBar(NSPoint(x: g.frame.midX - 300, y: g.frame.maxY - 20), onIsland: false)
    let stays = model.fs == .dropped
    trackMenuBar(NSPoint(x: g.frame.midX, y: g.frame.maxY - 300), onIsland: false)
    r.append(("fullscreen-menu-up-back-in-bar", stays && model.fs == .bar))
    // A browser in full screen can cover the whole screen, not just below the notch (V1.44): the bar too.
    setFullScreen(.none)
    setFullScreen(.whole)
    r.append(("fullscreen-whole-in-bar", model.fs == .bar && frameFor(g) == f))
    setFullScreen(.none)
    r.append(("fullscreen-off-as-before", model.fs == .off && model.free == moved && frameFor(g) == frameFor(model.geo)))
    // "Move to the top left in full screen" off: it stays where it is, dimmed.
    model.st.fsMove = false
    setFullScreen(.whole)
    r.append(("fullscreen-move-off-stays", model.fs == .off && model.opacity < 1))
    setFullScreen(.none)
    model.st.fsMove = true
    print("ISLAND FULL SCREEN BAR: bar=\(Int(f.minX + sr.minX))...\(Int(barRight)) notchLeft=\(Int(g.notchLeft)) h=\(Int(sr.height)) of \(Int(g.notchH))")
    return r
  }
}
