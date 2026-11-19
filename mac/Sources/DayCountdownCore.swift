import Foundation

// The day countdown on the Mac (PS 1.70; the rules are web src/core/daycount.ts, the engine src/daycount.ts). Pure values only,
// so tests/daycount-test.sh checks them without a window:
//  - DayIn: the island state's "day" part. The countdown in the island's task area, right of the task name, and the shown task's own
//    Priority 1 timer on its left (Settings, Countdown text: Countdown on the island, Priority 1 timers).
//  - DayCard: the card that comes out of the island ({type:"dayCard"}): "End day now?" with Yes and "Give me 15 more mins", or
//    "You have 4h 12m left" with Acknowledged. Esc is "15 more mins" on the first and Acknowledged on the second.
// Nothing here reads anything about 1Password or Signal.

struct DayIn: Equatable {
  /// When the day countdown reaches zero (ms since 1970), nil when it is not shown on the island.
  var end: Double?
  /// At zero, waiting for an answer.
  var zero = false
  /// The shown task's own Priority 1 timer: when its 24 hours run out (ms since 1970).
  var p1: Double?
  /// Lively near zero (Settings, Countdown text).
  var lively = true
  /// "#rrggbb" picked in Settings, or nil for the island's own colour.
  var color: String?

  static func from(_ v: Any?) -> DayIn? {
    guard let d = v as? [String: Any] else { return nil }
    func ms(_ x: Any?) -> Double? {
      guard let n = (x as? NSNumber)?.doubleValue, n.isFinite, n > 1_577_836_800_000, n < 4_102_444_800_000 else { return nil }   // 2020 to 2100
      return n
    }
    var o = DayIn()
    o.end = ms(d["end"])
    o.p1 = ms(d["p1"])
    o.zero = o.end != nil && (d["zero"] as? Bool) == true
    o.lively = (d["lively"] as? Bool) != false
    if let c = d["color"] as? String, DayCore.isHex(c) { o.color = c.lowercased() }
    return o.end == nil && o.p1 == nil ? nil : o
  }
}

struct DayCard: Equatable {
  enum Kind: String { case end, rem }
  var kind: Kind
  /// The end of day (ISO) for End day now?, the reminder's time (ISO) for a reminder.
  var key: String
  var title: String
  var yes = DayCore.wYes
  var snooze = DayCore.wSnooze
  var ack = DayCore.wAck
  /// A reminder's end of day (ms), so its words keep moving while it is up.
  var end: Double?

  static func from(_ v: Any?) -> DayCard? {
    guard let d = v as? [String: Any], let k = Kind(rawValue: (d["kind"] as? String) ?? "") else { return nil }
    func str(_ x: Any?, _ n: Int, _ def: String) -> String {
      let s = ((x as? String) ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
      return s.isEmpty ? def : String(s.prefix(n))
    }
    let key = str(d["key"], 40, "")
    guard DayCore.isIso(key) else { return nil }
    var c = DayCard(kind: k, key: key, title: str(d["title"], 80, k == .end ? DayCore.wEnd : DayCore.wAck))
    c.yes = str(d["yes"], 30, DayCore.wYes)
    c.snooze = str(d["snooze"], 40, DayCore.wSnooze)
    c.ack = str(d["ack"], 30, DayCore.wAck)
    if let n = (d["end"] as? NSNumber)?.doubleValue, n.isFinite, n > 0 { c.end = n }
    if k == .rem && c.end == nil { return nil }
    return c
  }
  /// The same card (a re-send each minute changes nothing on screen).
  func same(_ o: DayCard?) -> Bool { o != nil && o!.kind == kind && o!.key == key }
}

enum DayCore {
  static let feature = "day-countdown"
  static let wEnd = "End day now?", wYes = "Yes", wSnooze = "Give me 15 more mins", wAck = "Acknowledged", wMissed = "Missed"
  static func isHex(_ s: String) -> Bool { s.count == 7 && s.hasPrefix("#") && s.dropFirst().allSatisfy { $0.isHexDigit } }
  static func isIso(_ s: String) -> Bool {
    s.count >= 20 && s.count <= 30 && s.hasPrefix("20") && s.hasSuffix("Z") && s.allSatisfy { $0.isNumber || "-:.TZ".contains($0) }
  }

  /// "4h 12m", "3h", "35m", "45s" (the same as the page's leftWords).
  static func leftWords(_ ms: Double) -> String {
    if ms < 60_000 { return "\(max(0, Int((ms / 1000).rounded(.up))))s" }
    let m = Int((ms / 60_000).rounded(.up)), h = m / 60
    return h > 0 ? (m % 60 > 0 ? "\(h)h \(m % 60)m" : "\(h)h") : "\(m)m"
  }
  static func remindTitle(_ ms: Double) -> String { "You have \(leftWords(ms)) left" }

  /// How alive the numbers are: 0 calm, 1 a glow (an hour out), 2 warmer (15 minutes), 3 a rumble (3 minutes) and at zero.
  static func stage(_ leftMs: Double, zero: Bool) -> Int {
    if zero || leftMs <= 3 * 60_000 { return 3 }
    if leftMs <= 15 * 60_000 { return 2 }
    if leftMs <= 3_600_000 { return 1 }
    return 0
  }

  /// What goes back to the page (web src/island.ts, islandAction): ("dayEnd", "yes|<key>") or ("dayEnd", "snooze|<key>"), ("dayRem", key).
  static func answer(_ c: DayCard, _ act: String) -> (action: String, id: String)? {
    switch (c.kind, act) {
    case (.end, "yes"): return ("dayEnd", "yes|\(c.key)")
    case (.end, "snooze"), (.end, "esc"): return ("dayEnd", "snooze|\(c.key)")
    case (.rem, "ack"), (.rem, "esc"): return ("dayRem", c.key)
    default: return nil
    }
  }

  /// Held back while Sentry mode or the Sleep mode screen covers the Mac; it shows when they end.
  static func held(sentry: Bool, sleepScreen: Bool) -> Bool { sentry || sleepScreen }

  /// The real island is not on screen (switched off, hidden by its line, sent away, over a full screen app or a protected app): the
  /// card still comes out of an island, drawn for the moment, which goes straight after.
  static func needsStandIn(islandOnScreen: Bool) -> Bool { !islandOnScreen }
  /// The stand-in island: its size, how long it stays once the card is out.
  static let standInW: Double = 128, standInH: Double = 34, standInStays: Double = 0.85
}
