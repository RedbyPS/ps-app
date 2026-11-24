import Foundation

// The island's timers (V1.58): Pomodoro breaks, Stand-up reminders and the next meeting bubble share these rules, so the
// island never shows two takeovers at once. The page sends wall clock times ({type:"island", state:{pomo, stand, meet}},
// web src/island.ts); the island counts by itself from them, every second, with no message in between.
// The SAME rules as web src/core/islandtimers.ts (its tests: tests/pomodoro.test.ts and tests/islandtimers
// .test.ts); this copy's unit test is tests/island-timers-test.sh. Pure: Foundation only, no window, no sound.
//
// Middle (normally the task), most important first: back (a green tick and words, once per break or stand-up), break (a
// Pomodoro break counting down, or Break ready with Start), stand ("Stand up", the little man, the stand time). A
// stand-up whose time comes in a break is dropped (the break counts as standing time).
// Right bubble, only while the middle shows the task: standSoon (the last 15 seconds before a stand-up), then meet.

struct TBack: Equatable { var id: String; var at: Double }
struct TPomo: Equatable {
  var id: String; var phase: String; var endsAt: Double; var left: Double?; var wait: Bool; var clock: Bool; var sound: Bool; var back: TBack?
  var isBreak: Bool { phase != "work" }
}
struct TStand: Equatable { var at: Double; var len: Double; var sound: Bool; var test = false
  /// V1.59: the person has never seen the first stand-up's question (IslandBubbleCore.swift StandAsk).
  var ask = false
}
/// blob: the small blob on the island's end (PS 1.60, settings meetBubble.style, the default), false: the old long pill.
struct TMeet: Equatable { var id: String; var title: String; var start: Double; var end: Double; var from: Double; var link: String?; var blob = true }
struct TimersIn: Equatable {
  var pomo: TPomo?
  var stand: TStand?
  var meet: TMeet?
  var any: Bool { pomo != nil || stand != nil || meet != nil }
}

enum TMiddle: Equatable {
  case task
  case back(id: String, words: String)
  case brk(phase: String, endsAt: Double, left: Double?, ready: Bool)
  case stand(at: Double, endsAt: Double)
  var isTask: Bool { self == .task }
  var isStand: Bool { if case .stand = self { return true }; return false }
  var kind: String {
    switch self { case .task: return "task"; case .back: return "back"; case .brk: return "break"; case .stand: return "stand" }
  }
}
enum TBubble: Equatable {
  case none
  case standSoon(at: Double)
  case meet(mode: String, m: TMeet)      // mode: soon | join | now
  var isNone: Bool { self == .none }
}
struct TShow: Equatable {
  var middle: TMiddle = .task
  var right: TBubble = .none
  static let idle = TShow()
  var active: Bool { !middle.isTask || !right.isNone }
}

enum TimersCore {
  static let backMs: Double = 120_000          // a green tick only in the two minutes after the end (no old ones after a sleep)
  static let backShowMs: Double = 3_200        // how long the green tick shows
  static let standLeadMs: Double = 15_000      // the right tab counts down this long before a stand-up
  static let standMaxMs: Double = 3_600_000
  static let joinMs: Double = 120_000          // the meeting bubble is a Join button in the last 2 minutes (with a link)

  // The words on the island (the page's copies: core/pomodoro.ts POMO_WORDS, core/standup.ts STAND_WORDS, core/meetbubble.ts).
  static let wBack = "Now back to work"
  static let wStandBack = "Back to work"
  static let wStandUp = "Stand up"
  static let wStandIgnore = "Ignore", standIgnorePhrase = "Yes, ignore"
  static let wShort = "Short break", wLong = "Long break", wReady = "Break ready", wLongReady = "Long break ready", wStart = "Start"
  static let wJoin = "Join"
  static let wTimeShort = "Time for a short break", wTimeLong = "Time for a long break", wStandPop = "Time to stand up"
  static func wStandFor(_ min: Int) -> String { "Stand for \(min) minute\(min == 1 ? "" : "s")." }
  static func wIn(_ name: String) -> String { "\(name) in" }
  static func wLeft(_ t: String) -> String { "\(t) left" }

  // ---------- from the page, checked and capped ----------
  static func num(_ v: Any?) -> Double? { (v as? NSNumber).map { $0.doubleValue }.flatMap { $0.isFinite ? $0 : nil } }
  static func str(_ v: Any?, _ n: Int) -> String { String(((v as? String) ?? "").replacingOccurrences(of: "\n", with: " ").prefix(n)) }
  static func from(_ d: [String: Any]) -> TimersIn {
    var t = TimersIn()
    if let p = d["pomo"] as? [String: Any], let phase = p["phase"] as? String, ["work", "short", "long"].contains(phase) {
      let id = str(p["id"], 24)
      var back: TBack?
      if let b = p["back"] as? [String: Any], let at = num(b["at"]) { let bid = str(b["id"], 24); if !bid.isEmpty { back = TBack(id: bid, at: at) } }
      if !id.isEmpty {
        t.pomo = TPomo(id: id, phase: phase, endsAt: num(p["endsAt"]) ?? 0, left: num(p["left"]), wait: (p["wait"] as? Bool) == true,
                       clock: (p["clock"] as? Bool) == true, sound: (p["sound"] as? Bool) == true, back: back)
      }
    }
    if let s = d["stand"] as? [String: Any], let at = num(s["at"]), let len = num(s["len"]), len > 0, len <= standMaxMs {
      t.stand = TStand(at: at, len: len, sound: (s["sound"] as? Bool) == true, test: (s["test"] as? Bool) == true, ask: (s["ask"] as? Bool) == true)
    }
    if let m = d["meet"] as? [String: Any], let start = num(m["start"]), let end = num(m["end"]), let from = num(m["from"]), end > start {
      let title = str(m["title"], 80)
      t.meet = TMeet(id: str(m["id"], 120), title: title.isEmpty ? "Meeting" : title, start: start, end: end, from: from, link: openableLink(m["link"] as? String), blob: (m["style"] as? String) != "pill")
    }
    return t
  }

  // ---------- the rules ----------
  static func breakNow(_ p: TPomo?, _ now: Double) -> Bool {
    guard let p, p.isBreak else { return false }
    return p.wait || p.left != nil || now < p.endsAt
  }
  static func pomoBackId(_ p: TPomo?, _ now: Double) -> String? {
    guard let p else { return nil }
    if p.isBreak && !p.wait && p.left == nil && now >= p.endsAt && now - p.endsAt < backMs { return p.id }
    if let b = p.back, now >= b.at, now - b.at < backMs { return b.id }
    return nil
  }
  static func standBackId(_ s: TStand?, _ now: Double) -> String? {
    guard let s else { return nil }
    let end = s.at + s.len
    return now >= end && now - end < backMs ? "stand-\(String(Int64(s.at.rounded()), radix: 36))" : nil
  }
  static func show(_ t: TimersIn, _ now: Double, seen: Set<String> = [], dropped: Set<Double> = []) -> TShow {
    let mid = middle(t, now, seen, dropped)
    return TShow(middle: mid, right: mid.isTask ? bubble(t, now, dropped) : .none)
  }
  static func middle(_ t: TimersIn, _ now: Double, _ seen: Set<String>, _ dropped: Set<Double>) -> TMiddle {
    if let pb = pomoBackId(t.pomo, now), !seen.contains(pb) { return .back(id: pb, words: wBack) }
    if let p = t.pomo, breakNow(p, now) { return .brk(phase: p.phase, endsAt: p.endsAt, left: p.left, ready: p.wait) }
    if let s = t.stand, !dropped.contains(s.at) {
      if let sb = standBackId(s, now), !seen.contains(sb) { return .back(id: sb, words: wStandBack) }
      if now >= s.at && now < s.at + s.len { return .stand(at: s.at, endsAt: s.at + s.len) }
    }
    return .task
  }
  static func bubble(_ t: TimersIn, _ now: Double, _ dropped: Set<Double>) -> TBubble {
    if let s = t.stand, !dropped.contains(s.at), now >= s.at - standLeadMs, now < s.at, !breakNow(t.pomo, s.at) { return .standSoon(at: s.at) }
    if let m = t.meet, now >= m.from, now < m.end {
      let mode = now >= m.start ? "now" : (m.link != nil && m.start - now <= joinMs ? "join" : "soon")
      return .meet(mode: mode, m: m)
    }
    return .none
  }
  /// A stand-up whose time comes while a Pomodoro break shows is dropped (the break counts as standing).
  static func dropsStand(_ t: TimersIn, _ now: Double) -> Double? {
    guard let s = t.stand, now >= s.at, now < s.at + s.len, breakNow(t.pomo, now) else { return nil }
    return s.at
  }
  /// The confirmation belongs to the one stand-up that opened it, while that stand-up is still showing.
  static func activeStand(_ middle: TMiddle, at: Double, now: Double) -> Bool {
    guard case .stand(let start, let end) = middle else { return false }
    return start == at && now >= start && now < end
  }
  static func confirmsStandIgnore(_ phrase: String, middle: TMiddle, at: Double, now: Double) -> Bool {
    phrase == standIgnorePhrase && activeStand(middle, at: at, now: now)
  }
  /// The next moment anything above can change (a one shot timer goes off then; nothing ticks in between).
  static func nextChange(_ t: TimersIn, _ now: Double) -> Double? {
    var c: [Double] = []
    if let p = t.pomo {
      if p.left == nil && !p.wait { c.append(p.endsAt); c.append(p.endsAt + backMs) }
      if let b = p.back { c.append(b.at + backMs) }
    }
    if let s = t.stand { c += [s.at - standLeadMs, s.at, s.at + s.len, s.at + s.len + backMs] }
    if let m = t.meet { c += [m.from, m.start - joinMs, m.start, m.end] }
    return c.filter { $0 > now }.min()
  }

  /// A meeting link the island may open: https on the meeting services the meeting cards already open (Toast.openable).
  static func openableLink(_ s: String?) -> String? {
    guard let s, let u = URL(string: s), u.scheme == "https", let h = u.host?.lowercased() else { return nil }
    let ok = ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com"]
    return ok.contains(h) || h.hasSuffix(".zoom.us") ? s : nil
  }

  // ---------- words for times ----------
  /// "25:00", "4:59", "1:02:00". Rounded up, so it never shows 0:00 while time is left.
  static func clock(_ ms: Double) -> String {
    let t = max(0, Int((ms / 1000).rounded(.up))), h = t / 3600, m = (t % 3600) / 60, s = t % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
  }
  /// "12m", "1h 5m", "45s" under a minute.
  static func shortLeft(_ ms: Double) -> String {
    if ms < 60_000 { return "\(max(0, Int((ms / 1000).rounded(.up))))s" }
    let m = Int((ms / 60_000).rounded(.up)), h = m / 60
    return h > 0 ? "\(h)h \(m % 60)m" : "\(m)m"
  }
}
