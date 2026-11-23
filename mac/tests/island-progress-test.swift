import Foundation
import CoreGraphics
// Run: bash tests/island-progress-test.sh. Progress check-ins and task timers on the island (Sources/IslandProgressCore.swift,
// PS 1.77). The page's copy of the same rules is web src/core/islandprogress.ts (tests/islandprogress.test.ts).
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
typealias C = IslandProgressCore
let T0 = 1_795_000_000.0          // seconds
let M = 60.0
func page(_ o: [String: Any] = [:]) -> [String: Any] {
  var d: [String: Any] = ["id": "t1", "title": "Write the pitch deck", "since": T0 * 1000, "round": T0 * 1000, "every": 30, "est": 0, "look": "ring", "on": true, "ask": false, "quiet": false]
  for (k, v) in o { d[k] = v }
  return d
}
func P(_ o: [String: Any] = [:]) -> ProgressIn { C.from(page(o))! }

// 1. the page's part
let p0 = P()
ok("read from the page: seconds, its interval, look and switch", p0.since == T0 && p0.every == 30 && p0.est == 0 && p0.look == "ring" && p0.on && !p0.ask && p0.title == "Write the pitch deck")
ok("nothing, no id or no start: nil", C.from(nil) == nil && C.from(page(["id": ""])) == nil && C.from(page(["since": "soon"])) == nil)
ok("nothing to count (no check-ins and no expected time): nil", C.from(page(["every": 0, "est": 0])) == nil)
ok("an odd look is the ring; numbers kept in range", P(["look": "spiral"]).look == "ring" && P(["every": 999]).every == 240 && P(["est": -5]).est == 0)
ok("the page's words, or the same defaults", P(["words": ["up": "Done for now"]]).words.up == "Done for now" && P().words.up == "Time's up" && P().words.turnOn == "Turn on")
ok("a newline in the title never breaks the card", !P(["title": "a\nb"]).title.contains("\n"))

// 2. when it buzzes
ok("every 30 minutes of work, even with no time set", C.due(p0, now: T0 + 29 * M) == nil && C.due(p0, now: T0 + 30 * M)?.kind == .check && C.due(p0, now: T0 + 30 * M)?.minutes == 30)
let b1 = C.due(p0, now: T0 + 30 * M)!
ok("once each", C.due(p0, now: T0 + 31 * M, done: Set(b1.keys)) == nil && C.due(p0, now: T0 + 60 * M, done: Set(b1.keys))?.keys == [C.key(p0, "2")])
ok("missed by more than 5 minutes: skipped, never caught up", C.due(p0, now: T0 + 34 * M) != nil && C.due(p0, now: T0 + 36 * M) == nil)
ok("the task's own interval", C.due(P(["every": 15]), now: T0 + 15 * M)?.kind == .check)
let pu = P(["est": 30])
let bu = C.due(pu, now: T0 + 30 * M)!
ok("the time up, and a check-in at the same moment is the same buzz", bu.kind == .up && bu.keys.count == 2 && C.due(pu, now: T0 + 31 * M, done: Set(bu.keys)) == nil)
let p20 = P(["est": 20])
ok("after the time up the check-ins go on", C.due(p20, now: T0 + 20 * M)?.kind == .up && C.due(p20, now: T0 + 30 * M, done: [C.key(p20, "up")])?.kind == .check)
ok("a new round keys its buzzes again", C.key(p0, "1") != C.key(P(["round": (T0 + 3 * 3600) * 1000]), "1"))
ok("the keys are the page's: id, round in base 36, what", C.key(p0, "up") == "t1.\(String(Int64(T0 * 1000), radix: 36)).up")
let pa = P(["on": false, "ask": true])
ok("never answered: the first would-be buzz is the question", C.due(pa, now: T0 + 30 * M)?.kind == .offer && C.due(P(["on": false, "ask": true, "est": 10]), now: T0 + 10 * M)?.kind == .offer)
ok("off and not due: never", C.due(P(["on": false, "ask": false]), now: T0 + 30 * M) == nil)
ok("before it began: nothing", C.due(p0, now: T0 - M) == nil && C.due(p0, now: T0) == nil)

// 3. what keeps it from buzzing
ok("free: nothing", C.blocked(C.Block()) == nil)
var each = true
for k in ["islandOff", "away", "hidden", "meeting", "quiet", "idle", "takeover", "busy"] {
  var b = C.Block()
  switch k { case "islandOff": b.islandOff = true; case "away": b.away = true; case "hidden": b.hidden = true; case "meeting": b.meeting = true
  case "quiet": b.quiet = true; case "idle": b.idle = true; case "takeover": b.takeover = true; default: b.busy = true }
  if C.blocked(b) != k { each = false }
}
ok("each reason: the island off or away, not on screen, a meeting, Do Not Disturb, nobody at the Mac, a takeover, a card", each)
ok("the strongest reason first", C.blocked(C.Block(meeting: true, busy: true)) == "meeting")
ok("the question again a day later at the soonest", C.askAgain(lastShown: nil, now: T0) && !C.askAgain(lastShown: T0, now: T0 + 19 * 3600) && C.askAgain(lastShown: T0, now: T0 + 20 * 3600))

// 4. the timer
let p40 = P(["est": 40])
ok("time left counts down and stops at 0", C.left(p40, now: T0) == 40 * M && C.left(p40, now: T0 + 30 * M) == 10 * M && C.left(p40, now: T0 + 50 * M) == 0 && C.left(p0, now: T0) == nil)
ok("full to empty", C.frac(p40, now: T0) == 1 && C.frac(p40, now: T0 + 10 * M) == 0.75 && C.frac(p40, now: T0 + 60 * M) == 0)
ok("shows only while on with time left: gone when the time is up", C.timerShows(p40, now: T0 + M) && !C.timerShows(p40, now: T0 + 40 * M) && !C.timerShows(p0, now: T0) && !C.timerShows(P(["est": 40, "on": false, "ask": true]), now: T0 + M) && !C.timerShows(nil, now: T0))
ok("the sand timer is upside down only at the very start, then turns over once", C.turnsOver(p40, now: T0 + 1) && !C.turnsOver(p40, now: T0 + 3) && !C.turnsOver(p40, now: T0 + 60))
ok("the Text look: like 16m", C.leftShort(15.5 * M) == "16m" && C.leftShort(30) == "1m" && C.leftShort(60 * M) == "1h" && C.leftShort(65 * M) == "1h 5m" && C.leftShort(0) == "0m")

// 5. the words
ok("lengths of time, the same as the page's", C.durWords(1) == "1 minute" && C.durWords(30) == "30 minutes" && C.durWords(60) == "1 hour" && C.durWords(65) == "1 hour 5 minutes" && C.durWords(61) == "1 hour 1 minute" && C.durWords(120) == "2 hours")
let p45 = P(["est": 45])
ok("the card: how long, then the time left", C.lines(p45, C.due(p45, now: T0 + 30 * M)!) == C.Lines(main: "You've been working on this for 30 minutes", sub: "15 minutes left", ask: nil))
ok("the card: Time's up", C.lines(p45, C.due(p45, now: T0 + 45 * M)!).sub == "Time's up")
ok("the card: over", C.lines(p20, C.due(p20, now: T0 + 30 * M, done: [C.key(p20, "up")])!).sub == "10 minutes over")
ok("no time set: only how long", C.lines(p0, C.due(p0, now: T0 + 60 * M)!) == C.Lines(main: "You've been working on this for 1 hour", sub: nil, ask: nil))
ok("the question", C.lines(pa, C.due(pa, now: T0 + 30 * M)!).ask == "Want a check-in like this every 30 minutes?")
let w = ProgressWords()
ok("no em or en dashes in the words", ![w.working, w.left, w.up, w.over, w.ask, w.turnOn, w.notNow, w.askNote].joined().contains { $0 == "\u{2013}" || $0 == "\u{2014}" })

// 6. the motion
let full = C.plan(reduceMotion: false), calm = C.plan(reduceMotion: true)
ok("full motion: it shakes, flies, opens and flies home", full.shake > 0 && full.fly > 0 && full.open > 0 && full.home > 0)
ok("Reduce motion: no shake and no flight", calm.shake == 0 && calm.fly == 0 && calm.home == 0 && calm.open == 0)
ok("the shake swings both ways and dies away", C.shakeX(0) == 0 && abs(C.shakeX(1)) < 0.001 && (0...40).map { C.shakeX(Double($0) / 40) }.contains { $0 > 2 } && (0...40).map { C.shakeX(Double($0) / 40) }.contains { $0 < -2 })
let scr = CGRect(x: 0, y: 0, width: 1512, height: 982)
let mid = C.middle(of: scr, size: C.cardSize(kind: .check))
ok("it opens in the middle of the screen, a little above the centre", abs(mid.midX - scr.midX) < 1 && mid.midY > scr.midY && mid.maxY < scr.maxY)
ok("the question's card is bigger", C.cardSize(kind: .offer).height > C.cardSize(kind: .check).height)
let isl = CGRect(x: 640, y: 940, width: 232, height: 38)
let u = C.under(isl, screen: scr, size: C.cardSize(kind: .check))
ok("Reduce motion: just under the island, on its screen", u.maxY < isl.minY && abs(u.midX - isl.midX) < 1 && C.under(CGRect(x: 1400, y: 940, width: 100, height: 38), screen: scr, size: C.cardSize(kind: .check)).maxX <= scr.maxX)

// 7. the island draws it (read as text: the views need a window to run)
let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let island = (try? String(contentsOfFile: root + "/Sources/Island.swift", encoding: .utf8)) ?? ""
let view = (try? String(contentsOfFile: root + "/Sources/IslandProgress.swift", encoding: .utf8)) ?? ""
let mainSwift = (try? String(contentsOfFile: root + "/Sources/main.swift", encoding: .utf8)) ?? ""
ok("the state carries it, behind its feature", island.contains("s.progress = Features.on(\"island-progress\") ? IslandProgressCore.from(d[\"progress\"]) : nil"))
ok("the island hands it to the buzz", island.contains("IslandProgress.shared.update(s.mode == \"off\" ? nil : s.progress)"))
ok("the timer sits beside the task's name", island.contains("ProgressMark(m: m"))
ok("the real island hides while its copy is out", island.contains("m.buzzOut ? 0 : 1"))
ok("no sound anywhere in the buzz", !view.contains("Sfx") && !view.contains("AVAudio") && !view.contains("NSSound") && !view.contains("play("))
ok("Esc closes it (keyCode 53), in PS and in any app", view.contains("keyCode == 53") && view.contains("addGlobalMonitorForEvents") && view.contains("addLocalMonitorForEvents"))
ok("Reduce motion is read", view.contains("accessibilityDisplayShouldReduceMotion"))
ok("it uses the shared island queue", view.contains("IslandQueue.shared.enqueue"))
ok("the answer goes back to the page", view.contains("onAction?(\"progressAsk\""))
ok("Show me from Settings reaches it", mainSwift.contains("case \"islandProgressTest\""))

print("\n\(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
