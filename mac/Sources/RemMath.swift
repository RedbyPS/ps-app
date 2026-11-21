// The Annoying 15 min reminders' rules on a Mac, pure (no window, no clock, no storage): the same as web
// src/core/remind.ts (cycleDay, windowOn, openWindow, nextStart, remStatus, remNextWake). tests/reminders-test.sh
// checks them with the same numbers as the page's tests/remind.test.ts.
import Foundation

enum RemMath {
  /// One reminder as the page hands it over (core/remind.ts PlanItem): every word already worked out.
  struct Item: Equatable {
    var id: String
    var on = true
    var pill = "Daily reminder"
    var text = ""
    var at = "02:00", until = "06:00"
    var days = [0, 1, 2, 3, 4, 5, 6]          // the days a window may START on, 0 Sunday to 6 Saturday
    var tz = ""                               // "" = this Mac's zone
    var snooze = 15                           // minutes
    var later = "Remind me in 15 mins"
    var yes = "Yes"
    var word = "Yes"
    var click = false
    var bg = "#28121e", accent = "#ec4e86", ink = "#ffffff"
    var sound = "none"                        // none, soft, alarm, own
    var vol = 0.8
    var done = ""                             // the window day confirmed ("2026-11-10")
    var snoozeUntil = 0.0                     // ms
    var stateAt = 0.0                         // ms of that state's last change
    // V1.55, reminders on tasks ("" on the list's own): the task's id (Open task), the one day of a once reminder,
    // and the third button's words ("Open task").
    var task = ""
    var date = ""
    var open = ""
    // PS 1.65 Checklist reminder (web core/chkremind.ts): a card with a few choices instead of Yes and Remind me in. `sure` is
    // the choice that asks "Are you sure?" and wants `word` typed (-1: none), `ask` is that box's line. Empty `choices` = the usual card.
    var choices: [String] = []
    var sure = -1
    var ask = ""
    // PS 1.73 (web core/duealerts.ts): `one` = only the confirm button (the Priority 1 alarm's "I acknowledge", no snooze);
    // `ring` = its sound loops while the card is up, for Reminders.ringFor at most, like an alarm.
    var one = false
    var ring = false

    var json: [String: Any] {
      ["id": id, "on": on, "pill": pill, "text": text, "at": at, "until": until, "days": days, "tz": tz, "snooze": snooze, "later": later,
       "yes": yes, "word": word, "click": click, "bg": bg, "accent": accent, "ink": ink, "sound": sound, "vol": vol, "done": done,
       "snoozeUntil": snoozeUntil, "stateAt": stateAt, "task": task, "date": date, "open": open, "choices": choices, "sure": sure, "ask": ask, "one": one, "ring": ring]
    }
  }

  static let hhmm = #"^([01][0-9]|2[0-3]):[0-5][0-9]$"#
  static let maxItems = 80                    // the list's 20 and 60 on tasks (core/remind.ts REM_ALL_MAX)
  static let dayPattern = #"^\d{4}-\d{2}-\d{2}$"#
  static let taskPattern = "^[A-Za-z0-9-]{1,64}$"
  static func okTime(_ v: Any?) -> String? { (v as? String).flatMap { $0.range(of: hhmm, options: .regularExpression) != nil ? $0 : nil } }
  static func okHex(_ v: Any?, _ def: String) -> String {
    guard let s = (v as? String)?.lowercased(), s.range(of: "^#[0-9a-f]{6}$", options: .regularExpression) != nil else { return def }
    return s
  }
  // ---------- readable words on any background (V1.58, the same as web core/remind.ts inkFor) ----------
  static let minContrast = 4.5
  static func rgb(_ hex: String) -> (Double, Double, Double) {
    let n = Int(okHex(hex, "#000000").dropFirst(), radix: 16) ?? 0
    return (Double((n >> 16) & 255), Double((n >> 8) & 255), Double(n & 255))
  }
  /// Relative luminance 0 (black) to 1 (white).
  static func luma(_ hex: String) -> Double {
    func f(_ c: Double) -> Double { let s = c / 255; return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4) }
    let (r, g, b) = rgb(hex)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  /// WCAG contrast ratio, 1 to 21.
  static func contrast(_ a: String, _ b: String) -> Double {
    let x = luma(a), y = luma(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
  }
  /// White or near black, whichever reads better on the background; pure black or white on a middle tone.
  static func inkFor(_ bg: String) -> String {
    let w = contrast("#ffffff", bg), d = contrast("#17121a", bg)
    if max(w, d) >= minContrast { return w > d ? "#ffffff" : "#17121a" }
    return contrast("#000000", bg) > w ? "#000000" : "#ffffff"
  }
  /// One line, no control characters, trimmed, at most `max` characters (the page cleaned it already; checked again).
  static func line(_ v: Any?, _ max: Int, _ def: String = "") -> String {
    guard let s = v as? String else { return def }
    let one = String(String.UnicodeScalarView(String(s.prefix(400)).unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
    let t = String(one.trimmingCharacters(in: .whitespacesAndNewlines).prefix(max)).trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? def : t
  }
  static func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

  /// One item checked field by field; nil when it has no usable id.
  static func item(_ v: Any?) -> Item? {
    guard let o = v as? [String: Any], let id = o["id"] as? String, id.range(of: "^[a-z0-9]{1,16}$", options: .regularExpression) != nil else { return nil }
    var i = Item(id: id)
    i.on = o["on"] as? Bool ?? true
    i.pill = line(o["pill"], 30, "Daily reminder")
    i.text = line(o["text"], 80, "HAVE YOU DONE IT YET?")
    i.at = okTime(o["at"]) ?? "09:00"
    i.until = okTime(o["until"]) ?? "21:00"
    if i.until == i.at { i.until = i.at == "21:00" ? "09:00" : "21:00" }
    if let d = o["days"] as? [Any] { i.days = Array(Set(d.compactMap { ($0 as? NSNumber)?.intValue }.filter { (0...6).contains($0) })).sorted() }
    if let z = o["tz"] as? String, z.count <= 64, TimeZone(identifier: z) != nil { i.tz = z }
    i.snooze = max(1, min(240, Int((num(o["snooze"]) ?? 15).rounded())))
    i.yes = line(o["yes"], 30, "Yes")
    i.word = line(o["word"], 30, i.yes)
    i.later = line(o["later"], 40, "Remind me in \(i.snooze) mins")
    i.click = o["click"] as? Bool ?? false
    i.bg = okHex(o["bg"], "#28121e"); i.accent = okHex(o["accent"], "#ec4e86")
    // V1.58: the words' colour comes from the background when the plan has none, or one that does not read on it (an
    // old plan, a cached list, an older page's rule): never white on a light card.
    let ink = okHex(o["ink"], "")
    i.ink = !ink.isEmpty && contrast(ink, i.bg) >= minContrast ? ink : inkFor(i.bg)
    i.sound = ["none", "soft", "alarm", "own"].contains(o["sound"] as? String ?? "") ? o["sound"] as! String : "none"
    i.vol = max(0.1, min(1, num(o["vol"]) ?? 0.8))
    if let d = o["done"] as? String, d.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil { i.done = d }
    i.snoozeUntil = max(0, num(o["snoozeUntil"]) ?? 0)
    i.stateAt = max(0, num(o["stateAt"]) ?? 0)
    if let t = o["task"] as? String, t.range(of: taskPattern, options: .regularExpression) != nil {
      i.task = t
      if let d = o["date"] as? String, d.range(of: dayPattern, options: .regularExpression) != nil { i.date = d }
      i.open = line(o["open"], 30)
    }
    // PS 1.73: the nags and the Priority 1 alarm are once items on their task (web core/duealerts.ts), so they keep their one day.
    i.one = o["one"] as? Bool ?? false
    i.ring = o["ring"] as? Bool ?? false
    if let c = o["choices"] as? [Any] {
      i.choices = Array(c.prefix(3)).compactMap { x -> String? in let t = line(x, 60); return t.isEmpty ? nil : t }
      if let n = (o["sure"] as? NSNumber)?.intValue, (0..<i.choices.count).contains(n) { i.sure = n }
      i.ask = line(o["ask"], 60)
    }
    return i
  }
  /// The plan's items (`{v: 1, items: [...]}`), the broken ones left out, no id twice, at most 20.
  static func items(_ plan: Any?) -> [Item] {
    guard let p = plan as? [String: Any], let list = p["items"] as? [Any] else { return [] }
    var out: [Item] = []
    for x in list { if let i = item(x), i.id != retiredId, !out.contains(where: { $0.id == i.id }), out.count < maxItems { out.append(i) } }
    return out
  }

  // ---------- the schedule ----------
  static func zone(_ tz: String) -> TimeZone { tz.isEmpty ? .current : (TimeZone(identifier: tz) ?? .current) }
  static func cal(_ z: TimeZone) -> Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = z; return c }
  static func minutes(_ hm: String) -> Int {
    let p = hm.split(separator: ":").compactMap { Int($0) }
    return p.count == 2 ? p[0] * 60 + p[1] : 0
  }
  static func key(_ y: Int, _ m: Int, _ d: Int) -> String { String(format: "%04d-%02d-%02d", y, m, d) }
  static func parts(_ day: String) -> (Int, Int, Int) {
    let p = day.split(separator: "-").compactMap { Int($0) }
    return p.count == 3 ? (p[0], p[1], p[2]) : (1970, 1, 1)
  }
  static func addDays(_ day: String, _ n: Int) -> String {
    let (y, m, d) = parts(day)
    let c = cal(TimeZone(identifier: "UTC")!)
    let t = c.date(byAdding: .day, value: n, to: c.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!)!
    let x = c.dateComponents([.year, .month, .day], from: t)
    return key(x.year!, x.month!, x.day!)
  }
  static func weekday(_ day: String) -> Int {
    let (y, m, d) = parts(day)
    let c = cal(TimeZone(identifier: "UTC")!)
    return c.component(.weekday, from: c.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!) - 1
  }
  /// A wall clock time on a day in a zone to the real moment (a time skipped by a clock change moves on, like the page).
  static func moment(_ day: String, _ hm: String, _ z: TimeZone) -> Date {
    let (y, m, d) = parts(day)
    let mins = minutes(hm)
    return cal(z).date(from: DateComponents(year: y, month: m, day: d, hour: mins / 60, minute: mins % 60)) ?? Date(timeIntervalSince1970: 0)
  }
  static func today(_ now: Date, _ z: TimeZone) -> (String, Int) {
    let c = cal(z).dateComponents([.year, .month, .day, .hour, .minute], from: now)
    return (key(c.year!, c.month!, c.day!), c.hour! * 60 + c.minute!)
  }
  /// The window a moment belongs to: from the start time on it is that day's, before it the day before's.
  static func cycleDay(_ i: Item, now: Date) -> String {
    let (d, m) = today(now, zone(i.tz))
    return m < minutes(i.at) ? addDays(d, -1) : d
  }
  static func window(_ i: Item, day: String) -> (start: Date, end: Date) {
    let z = zone(i.tz)
    let over = minutes(i.until) <= minutes(i.at)
    return (moment(day, i.at, z), moment(over ? addDays(day, 1) : day, i.until, z))
  }
  /// May a window start on this day? A once reminder (V1.55): that one day. Else: one of the days picked.
  static func startsOn(_ i: Item, _ day: String) -> Bool { i.date.isEmpty ? i.days.contains(weekday(day)) : day == i.date }
  /// The window open right now on a picked day.
  static func openWindow(_ i: Item, now: Date) -> (day: String, start: Date, end: Date)? {
    guard i.on, !i.days.isEmpty || !i.date.isEmpty else { return nil }
    let day = cycleDay(i, now: now), w = window(i, day: day)
    return startsOn(i, day) && now >= w.start && now < w.end ? (day, w.start, w.end) : nil
  }
  static func nextStart(_ i: Item, now: Date) -> Date? {
    guard i.on, !i.days.isEmpty || !i.date.isEmpty else { return nil }
    if !i.date.isEmpty { let s = window(i, day: i.date).start; return s > now ? s : nil }
    let (d, _) = today(now, zone(i.tz))
    for n in -1...8 {
      let day = addDays(d, n)
      guard startsOn(i, day) else { continue }
      let s = window(i, day: day).start
      if s > now { return s }
    }
    return nil
  }
  enum Status: String { case off, done, closed, snoozed, show }
  /// `done` and `snoozeUntil`: the state that counts (the plan's, or this Mac's own newer answer).
  static func status(_ i: Item, done: String, snoozeUntil: Double, now: Date) -> Status {
    if !i.on { return .off }
    if !done.isEmpty && done == cycleDay(i, now: now) { return .done }
    if openWindow(i, now: now) == nil { return .closed }
    if snoozeUntil > now.timeIntervalSince1970 * 1000 { return .snoozed }
    return .show
  }
  static func nextWake(_ i: Item, snoozeUntil: Double, now: Date) -> Date? {
    var t: [Date] = []
    if let n = nextStart(i, now: now) { t.append(n) }
    if let w = openWindow(i, now: now) { t.append(w.end) }
    let s = Date(timeIntervalSince1970: snoozeUntil / 1000)
    if snoozeUntil > 0, s > now { t.append(s) }
    return t.min()
  }
  /// Does what was typed clear it? Any case, spaces at the ends trimmed; one click when `click`.
  /// PS 1.65 Checklist reminder: what its card tells the page. "away" is a card dropped before it came up; the page must hear it too, or
  /// it waits on a card that is not there and the reminder never comes again.
  static let chkOutcomes: Set<String> = ["rethink", "forgot", "sure", "esc", "away"]
  static func confirms(_ i: Item, _ typed: String) -> Bool {
    i.click || typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == i.word.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  // ---------- the retired built in reminder (1.60) ----------
  /// The old built in daily reminder (id "fu", the follow up question) is gone for everyone. A plan or a stored list
  /// that still carries it never shows it: reminders people made themselves have other ids and stay.
  static let retiredId = "fu"
}
