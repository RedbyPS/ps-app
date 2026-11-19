// Run: bash tests/daycount-test.sh
import Foundation

var pass = 0, fail = 0
func ok(_ name: String, _ cond: Bool) { if cond { pass += 1 } else { fail += 1; print("FAIL \(name)") } }

let end: Double = 1_795_000_000_000
// the island state's day part
ok("day: end, zero, p1, lively, colour", DayIn.from(["end": end, "zero": true, "p1": end + 5, "lively": false, "color": "#ABCDEF"]) == DayIn(end: end, zero: true, p1: end + 5, lively: false, color: "#abcdef"))
ok("day: nothing to show is nil", DayIn.from(["end": NSNull(), "p1": NSNull()]) == nil && DayIn.from(nil) == nil)
ok("day: nonsense times are dropped", DayIn.from(["end": 12, "p1": end]) == DayIn(end: nil, zero: false, p1: end, lively: true, color: nil))
ok("day: zero without an end is not zero", DayIn.from(["zero": true, "p1": end])?.zero == false)
ok("day: a bad colour is the island's own", DayIn.from(["end": end, "color": "red"])?.color == nil)

// the cards
let key = "2026-11-19T08:00:00.000Z"
let e = DayCard.from(["kind": "end", "key": key, "title": "End day now?", "yes": "Yes", "snooze": "Give me 15 more mins"])
ok("card: End day now?", e?.kind == .end && e?.title == "End day now?" && e?.snooze == "Give me 15 more mins")
ok("card: a reminder needs its end", DayCard.from(["kind": "rem", "key": key, "title": "You have 3h left"]) == nil)
ok("card: a reminder", DayCard.from(["kind": "rem", "key": key, "title": "x", "end": end, "ack": "Acknowledged"])?.end == end)
ok("card: a bad key or kind is no card", DayCard.from(["kind": "end", "key": "javascript:1"]) == nil && DayCard.from(["kind": "x", "key": key]) == nil)
ok("card: missing words take the defaults", DayCard.from(["kind": "end", "key": key])?.yes == "Yes" && DayCard.from(["kind": "end", "key": key])?.title == "End day now?")
ok("card: the same card again changes nothing", e!.same(DayCard.from(["kind": "end", "key": key, "title": "other"])))

// answers
ok("answer: Yes", DayCore.answer(e!, "yes")! == ("dayEnd", "yes|\(key)"))
ok("answer: 15 more mins", DayCore.answer(e!, "snooze")! == ("dayEnd", "snooze|\(key)"))
ok("answer: Esc on End day now? is 15 more mins", DayCore.answer(e!, "esc")! == ("dayEnd", "snooze|\(key)"))
let r = DayCard.from(["kind": "rem", "key": key, "title": "x", "end": end])!
ok("answer: Acknowledged and Esc on a reminder", DayCore.answer(r, "ack")! == ("dayRem", key) && DayCore.answer(r, "esc")! == ("dayRem", key))
ok("answer: Yes is not a reminder's", DayCore.answer(r, "yes") == nil)

// words, stages, holds
ok("words: 4h 12m, 3h, 35m, 45s", DayCore.leftWords(4 * 3_600_000 + 12 * 60_000) == "4h 12m" && DayCore.leftWords(3 * 3_600_000) == "3h" && DayCore.leftWords(35 * 60_000) == "35m" && DayCore.leftWords(45_000) == "45s")
ok("words: You have 2h 50m left", DayCore.remindTitle(2 * 3_600_000 + 50 * 60_000) == "You have 2h 50m left")
ok("stages", DayCore.stage(2 * 3_600_000, zero: false) == 0 && DayCore.stage(3_600_000, zero: false) == 1 && DayCore.stage(15 * 60_000, zero: false) == 2 && DayCore.stage(3 * 60_000, zero: false) == 3 && DayCore.stage(9e9, zero: true) == 3)
ok("held under Sentry mode or the Sleep mode screen", DayCore.held(sentry: true, sleepScreen: false) && DayCore.held(sentry: false, sleepScreen: true) && !DayCore.held(sentry: false, sleepScreen: false))
ok("island off: a stand-in island", DayCore.needsStandIn(islandOnScreen: false) && !DayCore.needsStandIn(islandOnScreen: true))
ok("no dashes in the words", ![DayCore.wEnd, DayCore.wYes, DayCore.wSnooze, DayCore.wAck, DayCore.wMissed].contains { $0.contains("\u{2013}") || $0.contains("\u{2014}") })

print("daycount: \(pass) passed, \(fail) failed")
exit(fail == 0 ? 0 : 1)
