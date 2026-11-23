import Foundation
import CoreGraphics

// PS 1.77 progress check-ins and task timers on the Dynamic Island (the developer, 23 Nov 2026). The SAME rules as the page's
// web src/core/islandprogress.ts (its own test, tests/islandprogress.test.ts); this copy is what the Mac runs, because the
// Mac counts by itself from wall clock times the page sends (never a ticking number). Pure values only: no windows, no clock of
// its own, no sound (tests/island-progress-test.sh). IslandProgress.swift draws it.
//
//  - Check-ins: every 30 minutes of work on a task (Settings, and per task), even with no time set on it, the island buzzes:
//    it shakes, comes to the middle of the screen, opens into a card and goes back. NO sound, ever. Reduce motion: a calm card
//    under the island, no flying and no shaking. Esc closes it at once.
//  - Timers: a task with an expected time the person set gets one of four looks beside or under its name (ring, sand timer,
//    the time left, a line) that runs down to nothing; when the time is up the island buzzes.
//  - Opt in: off until the person says yes. The first would-be buzz is the question (Turn on, Not now), sent back to the page,
//    which keeps the answer. Esc or no answer: asked again at a would-be buzz at least 20 hours later (UserDefaults, this Mac).
//  - Never while the island is off or away (Disappear for...), not on screen (a full screen app where it does not show, a
//    protected app), during a meeting, in Do Not Disturb, with nobody at the Mac, or while another island moment or card holds it.
//    A check-in missed by more than 5 minutes is skipped, never caught up.

/** The page's words ({t} is a length of time). The defaults are the page's own, for an older page that sends none. */
struct ProgressWords: Equatable {
  var working = "You've been working on this for {t}"
  var left = "{t} left"
  var up = "Time's up"
  var over = "{t} over"
  var ask = "Want a check-in like this every {t}?"
  var turnOn = "Turn on"
  var notNow = "Not now"
  var askNote = "You can change this any time in Settings, Dynamic Island."
}

/** What the page sends as the island state's `progress` (src/island.ts progressPart). Times in seconds since 1970. */
struct ProgressIn: Equatable {
  var id: String
  var title: String
  var since: Double
  /** The round's start as the page sent it (ms), for the buzz keys. */
  var roundMs: Double
  var every: Int
  var est: Int
  var look: String
  var on: Bool
  var ask: Bool
  var quiet: Bool
  var words = ProgressWords()
}

enum IslandProgressCore {
  static let feature = "island-progress"
  static let looks = ["ring", "sand", "text", "line"]
  /** A check-in missed by more than this is skipped. */
  static let grace: Double = 5 * 60
  /** The question again after Esc or no answer, at the soonest. */
  static let offerAgain: Double = 20 * 3600
  /** Nobody at the Mac: no key or mouse for this long. */
  static let idle: Double = 5 * 60
  /** How long a card stays out before the island goes back (a click or Esc sooner); the question waits longer. */
  static let showFor: Double = 7, askShowFor: Double = 45
  /** How often the Mac looks whether a buzz is due. */
  static let poll: Double = 5

  // ---------- the page's part, checked ----------
  static func from(_ v: Any?) -> ProgressIn? {
    guard let d = v as? [String: Any], let id = d["id"] as? String, !id.isEmpty, id.count <= 64,
          let since = (d["since"] as? NSNumber)?.doubleValue, since.isFinite, since > 0 else { return nil }
    func int(_ x: Any?, _ hi: Int) -> Int { max(0, min(hi, (x as? NSNumber)?.intValue ?? 0)) }
    let title = String(((d["title"] as? String) ?? "").replacingOccurrences(of: "\n", with: " ").prefix(200))
    let round = (d["round"] as? NSNumber)?.doubleValue ?? since
    let look = d["look"] as? String ?? "ring"
    var w = ProgressWords()
    if let o = d["words"] as? [String: Any] {
      func s(_ k: String, _ def: String) -> String { let x = (o[k] as? String) ?? ""; return x.isEmpty ? def : String(x.prefix(160)) }
      w = ProgressWords(working: s("working", w.working), left: s("left", w.left), up: s("up", w.up), over: s("over", w.over),
                        ask: s("ask", w.ask), turnOn: s("turnOn", w.turnOn), notNow: s("notNow", w.notNow), askNote: s("askNote", w.askNote))
    }
    let p = ProgressIn(id: id, title: title, since: since / 1000, roundMs: round.isFinite ? round : since, every: int(d["every"], 240), est: int(d["est"], 1440),
                       look: looks.contains(look) ? look : "ring", on: (d["on"] as? Bool) == true, ask: (d["ask"] as? Bool) == true,
                       quiet: (d["quiet"] as? Bool) == true, words: w)
    return p.every == 0 && p.est == 0 ? nil : p
  }

  // ---------- when it buzzes ----------
  enum Kind: String { case check, up, offer }
  struct Buzz: Equatable { var kind: Kind; var keys: [String]; var minutes: Int; var left: Double? }
  static func key(_ p: ProgressIn, _ what: String) -> String { "\(p.id).\(String(Int64(p.roundMs.rounded()), radix: 36)).\(what)" }

  /** The buzz due now, or nil. `done`: the keys already buzzed or skipped. A check-in at the moment the time is up is the same buzz. */
  static func due(_ p: ProgressIn, now: Double, done: Set<String> = []) -> Buzz? {
    let el = now - p.since
    guard el > 0 else { return nil }
    var keys: [String] = [], up = false
    if p.est > 0 {
      let at = Double(p.est) * 60, k = key(p, "up")
      if el >= at && el - at < grace && !done.contains(k) { keys.append(k); up = true }
    }
    if p.every > 0 {
      let step = Double(p.every) * 60, n = Int((el / step).rounded(.down)), k = key(p, String(n))
      if n >= 1 && el - Double(n) * step < grace && !done.contains(k) { keys.append(k) }
    }
    guard !keys.isEmpty else { return nil }
    let left: Double? = p.est > 0 ? Double(p.est) * 60 - el : nil
    let mins = Int((el / 60).rounded(.down))
    if !p.on { return p.ask ? Buzz(kind: .offer, keys: keys, minutes: mins, left: left) : nil }
    return Buzz(kind: up ? .up : .check, keys: keys, minutes: mins, left: left)
  }

  struct Block: Equatable {
    var islandOff = false, away = false, hidden = false, meeting = false, quiet = false, idle = false, takeover = false, busy = false
  }
  /** The first reason it cannot buzz now (tried again a moment later, until the grace has passed), or nil. */
  static func blocked(_ b: Block) -> String? {
    let order: [(String, Bool)] = [("islandOff", b.islandOff), ("away", b.away), ("hidden", b.hidden), ("meeting", b.meeting),
                                   ("quiet", b.quiet), ("idle", b.idle), ("takeover", b.takeover), ("busy", b.busy)]
    return order.first { $0.1 }?.0
  }
  static func askAgain(lastShown: Double?, now: Double) -> Bool { lastShown.map { now - $0 >= offerAgain } ?? true }

  // ---------- the timer ----------
  static func left(_ p: ProgressIn, now: Double) -> Double? { p.est > 0 ? max(0, Double(p.est) * 60 - (now - p.since)) : nil }
  /** 1 at the start, 0 when the time is up (the ring, the sand and the line). */
  static func frac(_ p: ProgressIn, now: Double) -> Double {
    guard let l = left(p, now: now) else { return 0 }
    return min(1, l / (Double(p.est) * 60))
  }
  static func timerShows(_ p: ProgressIn?, now: Double) -> Bool {
    guard let p, p.on, p.est > 0 else { return false }
    return (left(p, now: now) ?? 0) > 0
  }
  /** The hourglass is upside down for the first 2 seconds of the timer, then turns over (once: it is the clock, not a redraw). */
  static func turnsOver(_ p: ProgressIn, now: Double) -> Bool { now - p.since < 2 }

  // ---------- the words ----------
  static func durWords(_ min: Int) -> String {
    let n = max(0, min), h = n / 60, m = n % 60
    func one(_ x: Int, _ w: String) -> String { "\(x) \(w)\(x == 1 ? "" : "s")" }
    if h == 0 { return one(m, "minute") }
    return m == 0 ? one(h, "hour") : "\(one(h, "hour")) \(one(m, "minute"))"
  }
  /** "16m", "1h", "1h 5m" (minutes rounded up). */
  static func leftShort(_ s: Double) -> String {
    let n = max(0, Int((s / 60).rounded(.up))), h = n / 60, m = n % 60
    return h == 0 ? "\(m)m" : m == 0 ? "\(h)h" : "\(h)h \(m)m"
  }
  static func fill(_ w: String, _ t: String) -> String {
    guard let r = w.range(of: "{t}") else { return w }
    return w.replacingCharacters(in: r, with: t)
  }
  struct Lines: Equatable { var main: String; var sub: String?; var ask: String? }
  /** The card under the headline (the task) and its line: how long, then the time left, over, or Time's up; and the question. */
  static func lines(_ p: ProgressIn, _ b: Buzz) -> Lines {
    let w = p.words
    let main = fill(w.working, durWords(max(1, b.minutes)))
    var sub: String?
    if b.kind == .up { sub = w.up }
    else if p.est > 0, let l = b.left {
      sub = l > 0 ? fill(w.left, durWords(Int((l / 60).rounded(.up)))) : fill(w.over, durWords(max(1, Int((-l / 60).rounded(.down)))))
    }
    let ask = b.kind == .offer ? fill(w.ask, durWords(p.every > 0 ? p.every : 30)) : nil
    return Lines(main: main, sub: sub, ask: ask)
  }

  // ---------- the buzz's motion (IslandProgress.swift plays it) ----------
  /** The steps, in seconds from the start. Reduce motion: no shake and no flight, the card fades in under the island and out. */
  struct Plan: Equatable {
    var shake: Double, fly: Double, open: Double, words: Double
    /** After the hold: the words go, the card shrinks back to the island's size, flies home, and the real island shows again. */
    var shrink: Double, home: Double, land: Double
  }
  static let shakeFor = 0.42, shakes = 4.0, shakeAmp: CGFloat = 7, flyFor = 0.55, openFor = 0.45, homeFor = 0.5
  static func plan(reduceMotion: Bool) -> Plan {
    if reduceMotion { return Plan(shake: 0, fly: 0, open: 0, words: 0.05, shrink: 0, home: 0, land: 0.22) }
    return Plan(shake: shakeFor, fly: flyFor, open: openFor, words: 0.2, shrink: 0.28, home: homeFor, land: 0.15)
  }
  /** The sideways wobble of the shake at t (0 to 1): four quick swings that die away. */
  static func shakeX(_ t: Double) -> CGFloat {
    let c = min(1, max(0, t))
    return shakeAmp * CGFloat(sin(c * .pi * 2 * shakes) * (1 - c))
  }
  /** The card's size: wider and taller with the question. */
  static func cardSize(kind: Kind) -> CGSize { kind == .offer ? CGSize(width: 400, height: 228) : CGSize(width: 380, height: 150) }
  /** Where the card opens: the middle of the island's screen, a little above the centre (where the eye rests). */
  static func middle(of screen: CGRect, size: CGSize) -> CGRect {
    CGRect(x: (screen.midX - size.width / 2).rounded(), y: (screen.midY - size.height / 2 + screen.height * 0.08).rounded(), width: size.width, height: size.height)
  }
  /** Reduce motion: just under the island, centred on it, kept on its screen. */
  static func under(_ island: CGRect, screen: CGRect, size: CGSize) -> CGRect {
    var x = island.midX - size.width / 2
    x = max(screen.minX + 8, min(x, screen.maxX - size.width - 8))
    return CGRect(x: x.rounded(), y: (island.minY - 10 - size.height).rounded(), width: size.width, height: size.height)
  }
}
