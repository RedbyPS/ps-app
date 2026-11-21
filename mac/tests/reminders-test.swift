// tests/reminders-test.sh: Sources/RemMath.swift with the numbers of web tests/remind.test.ts.
import Foundation
setvbuf(stdout, nil, _IONBF, 0)
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
let iso = ISO8601DateFormatter()
func tb(_ day: String, _ hm: String) -> Date { iso.date(from: "\(day)T\(hm):00+04:00")! }
func item(_ f: (inout RemMath.Item) -> Void) -> RemMath.Item { var i = RemMath.Item(id: "abc"); i.tz = "Asia/Dubai"; f(&i); return i }
func st(_ i: RemMath.Item, _ d: Date, done: String = "", snooze: Double = 0) -> String { RemMath.status(i, done: done, snoozeUntil: snooze, now: d).rawValue }
let ms = { (d: Date) in d.timeIntervalSince1970 * 1000 }

let old = item { $0.at = "02:00"; $0.until = "06:00" }
ok("02:00 to 06:00 Dubai opens at 02:00 and closes at 06:00",
   st(old, tb("2026-11-10", "01:59")) == "closed" && st(old, tb("2026-11-10", "02:00")) == "show" && st(old, tb("2026-11-10", "05:59")) == "show" && st(old, tb("2026-11-10", "06:00")) == "closed")
ok("cycle day: before the start it is the day before's", RemMath.cycleDay(old, now: tb("2026-11-10", "01:30")) == "2026-11-09" && RemMath.cycleDay(old, now: tb("2026-11-10", "02:00")) == "2026-11-10")
let mon = item { $0.at = "22:00"; $0.until = "02:00"; $0.days = [1] }
ok("past midnight, Monday nights only", RemMath.weekday("2026-11-09") == 1 && st(mon, tb("2026-11-09", "21:59")) == "closed" && st(mon, tb("2026-11-09", "23:00")) == "show"
   && st(mon, tb("2026-11-10", "01:00")) == "show" && st(mon, tb("2026-11-10", "02:00")) == "closed" && st(mon, tb("2026-11-10", "23:00")) == "closed"
   && RemMath.openWindow(mon, now: tb("2026-11-10", "01:00"))?.day == "2026-11-09")
let wk = item { $0.at = "09:00"; $0.until = "21:00"; $0.days = [1, 2, 3, 4, 5] }
ok("weekdays: Saturday quiet, next start Monday 09:00", st(wk, tb("2026-11-14", "12:00")) == "closed" && st(wk, tb("2026-11-13", "12:00")) == "show"
   && RemMath.nextStart(wk, now: tb("2026-11-14", "12:00")) == tb("2026-11-16", "09:00"))
let fixed = item { $0.at = "18:00"; $0.until = "19:00" }
ok("a zone set counts wherever the Mac is", st(fixed, iso.date(from: "2026-11-10T09:30:00-05:00")!) == "show")
let ny = item { $0.tz = "America/New_York"; $0.at = "00:30"; $0.until = "03:00" }
let w = RemMath.window(ny, day: "2026-11-01")
ok("daylight saving: New York's 1 Nov night is 3.5 hours", iso.string(from: w.start) == "2026-11-01T04:30:00Z" && iso.string(from: w.end) == "2026-11-01T08:00:00Z")
ok("off and no days: never", st(item { $0.on = false }, tb("2026-11-10", "12:00")) == "off" && st(item { $0.days = [] }, tb("2026-11-10", "12:00")) == "closed"
   && RemMath.nextStart(item { $0.days = [] }, now: tb("2026-11-10", "12:00")) == nil)
ok("done for that window only", st(old, tb("2026-11-10", "04:00"), done: "2026-11-10") == "done" && st(old, tb("2026-11-11", "01:59"), done: "2026-11-10") == "done"
   && st(old, tb("2026-11-11", "02:00"), done: "2026-11-10") == "show")
let sz = ms(tb("2026-11-10", "03:15"))
ok("snooze: away, then back; past the window it does not come back", st(old, tb("2026-11-10", "03:14"), snooze: sz) == "snoozed" && st(old, tb("2026-11-10", "03:15"), snooze: sz) == "show"
   && st(old, tb("2026-11-10", "06:05"), snooze: ms(tb("2026-11-10", "06:10"))) == "closed")
ok("next wake: start, window end, snooze end", RemMath.nextWake(old, snoozeUntil: 0, now: tb("2026-11-10", "01:00")) == tb("2026-11-10", "02:00")
   && RemMath.nextWake(old, snoozeUntil: 0, now: tb("2026-11-10", "03:00")) == tb("2026-11-10", "06:00")
   && RemMath.nextWake(old, snoozeUntil: sz, now: tb("2026-11-10", "03:00")) == tb("2026-11-10", "03:15")
   && RemMath.nextWake(old, snoozeUntil: 0, now: tb("2026-11-10", "07:00")) == tb("2026-11-11", "02:00"))
ok("confirm: the word in any case, or one click", RemMath.confirms(item { $0.word = "Yes" }, "  yES ") && !RemMath.confirms(item { $0.word = "Yes" }, "yes please")
   && RemMath.confirms(item { $0.word = "I promise" }, "I PROMISE") && RemMath.confirms(item { $0.click = true }, ""))
let plan: [String: Any] = ["v": 1, "items": [["id": "a", "text": "Hi\u{7}", "at": "25:00", "until": "21:00", "days": [1, 1, 9], "snooze": 999, "vol": 3, "bg": "red", "accent": "#ABCDEF", "sound": "boom"],
                                             ["id": "a"], ["id": "BAD"], ["id": "b", "done": "2026-11-10", "snoozeUntil": 5, "stateAt": 7]]]
let its = RemMath.items(plan)
ok("plan: broken fields fall back, no id twice, bad ids left out", its.map(\.id) == ["a", "b"] && its[0].text == "Hi" && its[0].at == "09:00" && its[0].until == "21:00"
   && its[0].days == [1] && its[0].snooze == 240 && its[0].vol == 1 && its[0].bg == "#28121e" && its[0].accent == "#abcdef" && its[0].sound == "none"
   && its[1].done == "2026-11-10" && its[1].snoozeUntil == 5 && its[1].stateAt == 7)
// 1.60: the built in daily reminder (id "fu") is gone for everyone; ones people made themselves stay.
let withFu = RemMath.items(["v": 1, "items": [["id": "fu", "text": "OLD", "at": "02:00", "until": "06:00"], ["id": "mine", "text": "STRETCH?", "at": "09:00", "until": "21:00"]]])
ok("retired: a plan that still carries fu never shows it, a reminder of your own stays", withFu.map(\.id) == ["mine"] && RemMath.retiredId == "fu")
ok("retired: a plan of only fu is an empty list", RemMath.items(["v": 1, "items": [["id": "fu"]]]).isEmpty)
// ---------- V1.55: reminders on tasks (web tests/taskremind.test.ts) ----------
let once = item { $0.at = "09:00"; $0.until = "12:00"; $0.date = "2026-11-12"; $0.task = "0b7e6c1a-1111"; $0.days = [] }
ok("once: only on its day, never the week after", st(once, tb("2026-11-12", "10:00")) == "show" && st(once, tb("2026-11-19", "10:00")) == "closed"
   && RemMath.nextStart(once, now: tb("2026-11-12", "08:00")) == tb("2026-11-12", "09:00") && RemMath.nextStart(once, now: tb("2026-11-12", "10:00")) == nil)
let onceNight = item { $0.at = "23:00"; $0.until = "01:00"; $0.date = "2026-11-12"; $0.task = "t" }
ok("once past midnight: still that day's window after midnight", st(onceNight, tb("2026-11-13", "00:30")) == "show" && st(onceNight, tb("2026-11-13", "23:30")) == "closed")
ok("once and done for its day", st(once, tb("2026-11-12", "10:00"), done: "2026-11-12") == "done")
let tp = RemMath.items(["items": [
  ["id": "t1", "at": "09:00", "until": "12:00", "task": "0b7e6c1a-1111-4c2d", "date": "2026-11-12", "open": "Open task", "text": "Water the plants"],
  ["id": "t2", "at": "09:00", "until": "12:00", "task": "bad id!", "date": "2026-11-12", "open": "Open task"],
  ["id": "t3", "at": "09:00", "until": "12:00", "date": "2026-11-12"],
]])
ok("plan: a task's id, its day and Open task kept; a bad task id or a day without a task dropped",
   tp[0].task == "0b7e6c1a-1111-4c2d" && tp[0].date == "2026-11-12" && tp[0].open == "Open task"
   && tp[1].task == "" && tp[1].date == "" && tp[1].open == "" && tp[2].date == "")
ok("plan: room for the list's 20 and 60 on tasks", RemMath.items(["items": (0..<100).map { ["id": "x\($0)", "at": "09:00", "until": "10:00"] }]).count == 80)
ok("the json a Mac keeps carries the new fields back", RemMath.item(tp[0].json) == tp[0])

// ---------- V1.58: the words' colour reads on the card (web tests/remind-ink.test.ts) ----------
let presets: [(String, String)] = [("#28121e", "#ffffff"), ("#0f1b2d", "#ffffff"), ("#0f2418", "#ffffff"), ("#2a1a08", "#ffffff"), ("#1c1230", "#ffffff"),
                                   ("#2a0d0d", "#ffffff"), ("#18181b", "#ffffff"), ("#f6f3ee", "#17121a")]
ok("ink: the same as the page on every theme", presets.allSatisfy { RemMath.inkFor($0.0) == $0.1 })
ok("ink: dark words on white, cream and a light grey, all at 4.5 to 1",
   ["#ffffff", "#fff8e1", "#e5e7eb", "#b0b0b0", "#9a9a9a", "#ec4e86"].allSatisfy { RemMath.inkFor($0) != "#ffffff" && RemMath.contrast(RemMath.inkFor($0), $0) >= 4.5 })
var sweepOk = true
for r in stride(from: 0, to: 256, by: 16) { for g in stride(from: 0, to: 256, by: 16) { for b in stride(from: 0, to: 256, by: 16) {
  let bg = String(format: "#%02x%02x%02x", r, g, b)
  if RemMath.contrast(RemMath.inkFor(bg), bg) < 4.5 { sweepOk = false }
} } }
ok("ink reads at 4.5 to 1 on any background (every 16th step)", sweepOk)
let paperNoInk = RemMath.item(["id": "p", "bg": "#f6f3ee", "accent": "#e0457b"])!
ok("a plan without ink on Paper: near black words, not the old white", paperNoInk.ink == "#17121a")
let paperWhite = RemMath.item(["id": "p", "bg": "#f6f3ee", "accent": "#e0457b", "ink": "#ffffff"])!
ok("an old plan with white words on Paper: worked out again from the background", paperWhite.ink == "#17121a")
let greyOld = RemMath.item(["id": "g", "bg": "#b0b0b0", "ink": "#ffffff"])!
ok("an older page's white on a light grey: dark words now", greyOld.ink != "#ffffff" && RemMath.contrast(greyOld.ink, "#b0b0b0") >= 4.5)
ok("a readable ink from the plan is kept", RemMath.item(["id": "k", "bg": "#28121e", "ink": "#ffffff"])!.ink == "#ffffff"
   && RemMath.item(["id": "k", "bg": "#ffffff", "ink": "#17121a"])!.ink == "#17121a")
ok("the default pink card keeps white words", RemMath.item(["id": "d"])!.ink == "#ffffff")

// PS 1.65 Checklist reminder: a card with three choices
let chk = RemMath.item(["id": "chk", "text": "DO YOUR CHECKLIST", "choices": ["One", "Two", "Three", "Four"], "sure": 1, "ask": "Are you sure?", "word": "yes"])!
ok("a checklist card keeps three choices, the typed one and its question", chk.choices == ["One", "Two", "Three"] && chk.sure == 1 && chk.ask == "Are you sure?" && chk.word == "yes")
ok("a normal reminder has no choices", RemMath.item(["id": "n"])!.choices.isEmpty && RemMath.item(["id": "n"])!.sure == -1)
ok("a typed choice that is not in the list is dropped", RemMath.item(["id": "n", "choices": ["A", "B"], "sure": 5])!.sure == -1)
ok("blank choices are left out", RemMath.item(["id": "n", "choices": ["A", "  ", "C"]])!.choices == ["A", "C"])
ok("the page hears every checklist outcome, a dropped card (away) too", RemMath.chkOutcomes == ["rethink", "forgot", "sure", "esc", "away"] && !RemMath.chkOutcomes.contains("done"))
ok("the typed yes is checked in any case", RemMath.confirms(chk, " YES ") && !RemMath.confirms(chk, "y") && !RemMath.confirms(chk, "yes please"))

// PS 1.73: the nag for tasks due today and the Priority 1 alarm (web core/duealerts.ts, the numbers of tests/duealerts.test.ts)
let nag = RemMath.item(["id": "nabcdefghijk", "task": "t1", "date": "2026-11-21", "at": "09:00", "until": "12:00", "tz": "Asia/Dubai", "snooze": 15, "open": "Open task"])!
ok("a nag: 09:00 to 12:00 on its day only (the developer's day ends 12:00)", st(nag, tb("2026-11-21", "08:59")) == "closed" && st(nag, tb("2026-11-21", "09:00")) == "show"
   && st(nag, tb("2026-11-21", "11:59")) == "show" && st(nag, tb("2026-11-21", "12:00")) == "closed" && st(nag, tb("2026-11-22", "10:00")) == "closed")
ok("a nag snoozed 15 minutes comes back", st(nag, tb("2026-11-21", "09:10"), snooze: ms(tb("2026-11-21", "09:15"))) == "snoozed" && st(nag, tb("2026-11-21", "09:15"), snooze: ms(tb("2026-11-21", "09:15"))) == "show")
let p1 = RemMath.item(["id": "pabcdefghijk", "task": "t2", "date": "2026-11-21", "at": "19:30", "until": "20:30", "tz": "Asia/Dubai", "yes": "I acknowledge", "word": "yes", "click": false, "one": true, "ring": true])!
ok("the P1 alarm: one button and a ring", p1.one && p1.ring && p1.yes == "I acknowledge" && p1.open.isEmpty)
ok("the P1 alarm: a click alone never clears it, only yes typed", !p1.click && p1.word == "yes" && !RemMath.confirms(p1, "") && !RemMath.confirms(p1, "I acknowledge")
   && RemMath.confirms(p1, "yes") && RemMath.confirms(p1, " YES "))
ok("the P1 alarm shows from 19:30 until the 24 hours run out, once", st(p1, tb("2026-11-21", "19:29")) == "closed" && st(p1, tb("2026-11-21", "19:30")) == "show"
   && st(p1, tb("2026-11-21", "20:29")) == "show" && st(p1, tb("2026-11-21", "20:30")) == "closed" && st(p1, tb("2026-11-22", "19:30")) == "closed")
ok("I acknowledge from the phone (done for its day) closes it here", st(p1, tb("2026-11-21", "19:31"), done: "2026-11-21") == "done")
ok("older plans: no one, no ring", !RemMath.item(["id": "x"])!.one && !RemMath.item(["id": "x"])!.ring)
ok("one and ring go round the saved plan", RemMath.item(p1.json) == p1)

print("\n\(n - bad) of \(n) passed")
if bad > 0 { exit(1) }
