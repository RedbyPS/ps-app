// This Mac's own Calendar for the Meetings panel (7 Nov 2026). The developer's meetings come from his Google calendar
// through his own server; everyone else who uses the public PS gets theirs from the Calendar app on this Mac,
// through EventKit, read only. The main page asks ({type:"localCal", op:"read", ask}) when it is not the developer's
// account; this file answers with today's and the next 7 days' events ({type:"localCal", status, events}).
// The page puts them in that person's own encrypted vault (the calendar record, only when something changed);
// nothing else leaves the Mac. Never a note's text: notes and the location are only searched for a call link.
// macOS asks for Calendar access once, only when the person switches Meetings from your Calendar on (the page sends
// ask:true only then, G Squad); refused, the page says so in plain
// words with a button to System Settings. Never on the developer's PS (Owner.red), never in a self test copy (no prompt
// may ever reach the developer's screen from a test), never on the main thread (the read runs on its own queue).
import AppKit
import EventKit

final class LocalCalendar {
  static let shared = LocalCalendar()

  /// Sends one JSON message to the main page (main.swift sets it).
  var toMain: ((String) -> Void)?

  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  private let queue = DispatchQueue(label: "com.cincee.ps.localcal", qos: .utility)
  private lazy var store = EKEventStore()   // making one never asks; only requestFullAccessToEvents does
  private var watching = false
  private var watchToken: NSObjectProtocol?
  private var changeTimer: DispatchWorkItem?
  private var reading = false
  /// Set when PS asks macOS (for the log and older builds only). A "Don't Allow" is never asked again: macOS keeps it as
  /// "denied" and the button opens System Settings instead (CalAccessCore.swift).
  private let askedKey = "localCal.asked"

  static let days = 8                        // today plus the next 7 days
  static let maxEvents = 200

  /// From the page (main thread). op "read" (ask: may show macOS's question once), "settings" (opens the
  /// Calendars pane of Privacy & Security).
  func handle(_ msg: [String: Any]) {
    let op = msg["op"] as? String ?? ""
    if op == "settings" {
      guard !test, let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") else { return }
      NSWorkspace.shared.open(u)
      return
    }
    // The Calendar switch went off (G Squad): stop watching the Calendar app, so nothing is read again until the page
    // asks after it is switched back on. macOS is never asked from here; only a read with ask:true does that.
    if op == "off" { unwatch(); return }
    guard op == "read" else { return }
    if test { reply(["status": "test"]); return }             // a test copy never touches EventKit
    if Owner.red { reply(["status": "red"]); return }         // The developer's meetings come from his Google calendar
    read(ask: msg["ask"] as? Bool == true)
  }

  // PS 1.72 (Jan): the rules are in CalAccessCore.swift. "Not decided" is never "Calendar access is off" any more:
  // macOS says it only when it has no answer for this copy of PS (a new signature, a privacy reset), and then a click
  // on the Calendar switch or the refresh icon asks again. A real "Don't Allow" is macOS's "denied", never asked again.
  private func read(ask: Bool) {
    let raw = EKEventStore.authorizationStatus(for: .event).rawValue
    let d = CalAccessCore.decide(status: raw, ask: ask)
    switch d {
    case .read:
      fetch()
    case .askMacOS:
      UserDefaults.standard.set(true, forKey: askedKey)
      psLog("PS calendar: asking macOS for Calendar access (Meetings panel)")
      let done: (Bool, Error?) -> Void = { [weak self] ok, _ in
        DispatchQueue.main.async {
          psLog("PS calendar: Calendar access \(ok ? "allowed" : "refused")")
          if ok { self?.fetch() } else { self?.reply(["status": "denied"]) }
        }
      }
      if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: done) }
      else { store.requestAccess(to: .event, completion: done) }
    case .off, .notAsked:
      if d == .off { psLog("PS calendar: Calendar access is off in macOS (status \(raw))") }
      reply(["status": CalAccessCore.reply(d) ?? "ask"])
    }
  }

  /// Reads the events on PS's own queue and hands the answer to the page on main.
  private func fetch() {
    watch()
    guard !reading else { return }
    reading = true
    queue.async { [weak self] in
      guard let self else { return }
      let cal = Calendar.current
      let from = cal.startOfDay(for: Date())
      let to = cal.date(byAdding: .day, value: Self.days, to: from) ?? from.addingTimeInterval(Double(Self.days) * 86400)
      let pred = self.store.predicateForEvents(withStart: from, end: to, calendars: nil)
      let list = self.store.events(matching: pred).sorted { $0.startDate < $1.startDate }.prefix(Self.maxEvents)
      let events = list.map { Self.row($0) }
      // The calendars themselves (identifier, name, colour, account: nothing else), so the page can offer Meetings, Show only or Off for each
      // (web/src/core/calpick.ts). Read on this same queue; a calendar with no events in the next days is listed too.
      let cals = CalPickCore.list(self.store.calendars(for: .event).compactMap { Self.calInfo($0) })
      let iso = ISO8601DateFormatter()
      let msg: [String: Any] = ["status": "ok", "at": iso.string(from: Date()), "from": iso.string(from: from), "to": iso.string(from: to), "events": events, "cals": cals]
      DispatchQueue.main.async {
        self.reading = false
        self.reply(msg)
      }
    }
  }

  /// One event in the same shape as the Google copy (core/model.ts CalEvent). No notes; its calendar only by identifier, name and colour.
  /// V1.55 (Edit mode overview): the ACCOUNT it comes from (the Calendar app's account name, for example "iCloud" or a
  /// Google address), so each Meetings panel can show one account. It goes only into this person's own vault.
  static func row(_ e: EKEvent) -> [String: Any] {
    let iso = ISO8601DateFormatter()
    let start = e.startDate.map { iso.string(from: $0) }
    // A repeating event's occurrences share one identifier: the start makes each one its own.
    let id = "mac:\(e.calendarItemIdentifier)@\(start ?? "")"
    var out: [String: Any] = ["id": String(id.prefix(300)), "title": String((e.title ?? "").prefix(300)), "allDay": e.isAllDay,
                              "start": start ?? NSNull(), "end": e.endDate.map { iso.string(from: $0) } ?? NSNull()]
    out["link"] = callLink(url: e.url?.absoluteString, location: e.location, notes: e.notes) ?? NSNull()
    out["place"] = e.location.map { String($0.prefix(300)) } ?? NSNull()
    let acct: String? = e.calendar?.source?.title
    out["acct"] = acct.map { String($0.prefix(80)) } ?? NSNull()
    // The calendar it is in (identifier, title, colour), for the "which calendars" choice (CalPickCore.swift).
    out.merge(CalPickCore.eventFields(id: e.calendar?.calendarIdentifier, name: e.calendar?.title, color: e.calendar.flatMap { colorHex($0) })) { a, _ in a }
    let organizer = e.organizer?.url.absoluteString.lowercased()
    out["attendees"] = (e.attendees ?? []).prefix(60).compactMap { p -> [String: Any]? in
      let u = p.url.absoluteString
      guard u.lowercased().hasPrefix("mailto:") else { return nil }
      let email = String(u.dropFirst(7)).removingPercentEncoding ?? String(u.dropFirst(7))
      guard email.contains("@") else { return nil }
      return ["email": String(email.prefix(200)), "name": p.name.map { String($0.prefix(120)) } ?? NSNull(), "rsvp": rsvp(p.participantStatus),
              "self": p.isCurrentUser, "organizer": organizer == u.lowercased()]
    }
    return out
  }

  /// One calendar for the page's list: its identifier, name, colour and account.
  static func calInfo(_ c: EKCalendar) -> [String: Any]? {
    CalPickCore.info(id: c.calendarIdentifier, name: c.title, color: colorHex(c), acct: c.source?.title)
  }
  /// A calendar's colour as "#rrggbb" (nil when it has none that can be read).
  static func colorHex(_ c: EKCalendar) -> String? {
    guard let cg = c.cgColor, let ns = NSColor(cgColor: cg)?.usingColorSpace(.sRGB) else { return nil }
    return CalPickCore.hex(r: Double(ns.redComponent), g: Double(ns.greenComponent), b: Double(ns.blueComponent))
  }

  /// Google's words for an answer, so the meeting alerts read both copies the same way.
  static func rsvp(_ s: EKParticipantStatus) -> String {
    switch s {
    case .accepted, .completed, .delegated, .inProcess: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    default: return "needsAction"
    }
  }

  /// The call's link: the event's own URL when it is one, else the first video call link in the location or notes.
  static func callLink(url: String?, location: String?, notes: String?) -> String? {
    if let u = url, u.hasPrefix("https://") { return String(u.prefix(500)) }
    let hay = [location, notes].compactMap { $0 }.joined(separator: "\n")
    guard !hay.isEmpty, let re = try? NSRegularExpression(pattern: #"https://[A-Za-z0-9.-]*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|facetime\.apple\.com|webex\.com)[^\s<>"')]*"#) else { return nil }
    let r = NSRange(hay.startIndex..., in: hay)
    guard let m = re.firstMatch(in: hay, range: r), let rr = Range(m.range, in: hay) else { return nil }
    return String(hay[rr].prefix(500))
  }

  /// Once allowed: a change in the Calendar app (a new, moved or cancelled event) reads again, 2 s after the last one.
  private func watch() {
    guard !watching else { return }
    watching = true
    watchToken = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
      guard let self, !Owner.red else { return }
      self.changeTimer?.cancel()
      let w = DispatchWorkItem { [weak self] in self?.read(ask: false) }
      self.changeTimer = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: w)
    }
  }

  private func unwatch() {
    changeTimer?.cancel(); changeTimer = nil
    if let t = watchToken { NotificationCenter.default.removeObserver(t) }
    watchToken = nil
    watching = false
    psLog("PS calendar: switched off, no longer watching the Calendar app")
  }

  private func reply(_ m: [String: Any]) {
    var msg = m
    msg["type"] = "localCal"
    guard let d = try? JSONSerialization.data(withJSONObject: msg), let j = String(data: d, encoding: .utf8) else { return }
    toMain?(j)
  }
}
