import Foundation
// Run: bash tests/island-timers-test.sh. The same cases as web tests/islandtimers.test.ts.
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
let MIN = 60_000.0, T0 = 1_763_024_400_000.0

// Pomodoro
let work = TPomo(id: "wabc", phase: "work", endsAt: T0 + 25 * MIN, left: nil, wait: false, clock: false, sound: true, back: nil)
let brk = TPomo(id: "sabc", phase: "short", endsAt: T0 + 30 * MIN, left: nil, wait: false, clock: false, sound: true, back: nil)
ok("work shows the task", TimersCore.show(TimersIn(pomo: work), T0).middle == .task)
ok("a break swaps the task for its countdown", TimersCore.show(TimersIn(pomo: brk), T0 + 26 * MIN).middle == .brk(phase: "short", endsAt: T0 + 30 * MIN, left: nil, ready: false))
var waitB = brk; waitB.wait = true; waitB.left = 5 * MIN; waitB.endsAt = 0
ok("a waiting break shows ready", TimersCore.show(TimersIn(pomo: waitB), T0).middle == .brk(phase: "short", endsAt: 0, left: 5 * MIN, ready: true))
ok("the island counts by itself: at the end, Now back to work", TimersCore.show(TimersIn(pomo: brk), T0 + 30 * MIN).middle == .back(id: "sabc", words: "Now back to work"))
ok("once only", TimersCore.show(TimersIn(pomo: brk), T0 + 30 * MIN, seen: ["sabc"]).middle == .task)
var after = work; after.back = TBack(id: "sabc", at: T0 + 30 * MIN)
ok("the next state carries the same break: the same moment", TimersCore.show(TimersIn(pomo: after), T0 + 30 * MIN + 400).middle == .back(id: "sabc", words: "Now back to work"))
ok("no old tick after a long sleep", TimersCore.show(TimersIn(pomo: after), T0 + 40 * MIN).middle == .task)

// Stand-up
let st = TStand(at: T0 + 10 * MIN, len: 2 * MIN, sound: true)
ok("nothing before the last 15 seconds", TimersCore.show(TimersIn(stand: st), T0 + 10 * MIN - 16_000) == TShow.idle)
ok("the last 15 seconds: the right tab", TimersCore.show(TimersIn(stand: st), T0 + 10 * MIN - 15_000).right == .standSoon(at: T0 + 10 * MIN))
ok("then Stand up takes the middle", TimersCore.show(TimersIn(stand: st), T0 + 10 * MIN).middle == .stand(at: T0 + 10 * MIN, endsAt: T0 + 12 * MIN))
let sid = TimersCore.standBackId(st, T0 + 12 * MIN)!
ok("then the green tick, Back to work", TimersCore.show(TimersIn(stand: st), T0 + 12 * MIN).middle == .back(id: sid, words: "Back to work"))
ok("then the task", TimersCore.show(TimersIn(stand: st), T0 + 12 * MIN + 100, seen: [sid]).middle == .task)
let active = TimersCore.show(TimersIn(stand: st), st.at).middle
ok("ignoring needs the exact phrase", TimersCore.confirmsStandIgnore("Yes, ignore", middle: active, at: st.at, now: st.at) &&
   ["Yes", "yes, ignore", "Yes ignore", "Yes, ignore "].allSatisfy { !TimersCore.confirmsStandIgnore($0, middle: active, at: st.at, now: st.at) })
ok("a stale confirmation cannot dismiss a different reminder", !TimersCore.confirmsStandIgnore("Yes, ignore", middle: active, at: st.at - MIN, now: st.at))
ok("confirmation expires when the countdown ends", !TimersCore.confirmsStandIgnore("Yes, ignore", middle: active, at: st.at, now: st.at + st.len))
ok("an ignored stand-up stays out of the island and skips its completion tick", [st.at, st.at + st.len].allSatisfy {
  TimersCore.show(TimersIn(stand: st), $0, dropped: [st.at]) == .idle
})
var nextSt = st; nextSt.at += 30 * MIN
ok("the next stand-up still shows", TimersCore.show(TimersIn(stand: nextSt), nextSt.at, dropped: [st.at]).middle.isStand)

// Together
let both = TimersIn(pomo: brk, stand: TStand(at: T0 + 27 * MIN, len: 2 * MIN, sound: true))
ok("a stand-up in a break: no tab, no takeover, the break shows", TimersCore.show(both, T0 + 27 * MIN - 10_000).right == .none && TimersCore.show(both, T0 + 27 * MIN).middle.kind == "break")
ok("and it is dropped for good", TimersCore.dropsStand(both, T0 + 27 * MIN) == T0 + 27 * MIN && TimersCore.show(both, T0 + 31 * MIN, seen: ["sabc"], dropped: [T0 + 27 * MIN]).middle == .task)
let meet = TMeet(id: "m1", title: "Design review", start: T0 + 20 * MIN, end: T0 + 50 * MIN, from: T0 + 5 * MIN, link: "https://meet.google.com/abc-defg-hij")
ok("the meeting bubble from its lead time", TimersCore.show(TimersIn(meet: meet), T0 + 5 * MIN).right == .meet(mode: "soon", m: meet) && TimersCore.show(TimersIn(meet: meet), T0 + 4 * MIN).right == .none)
ok("Join in the last 2 minutes", TimersCore.show(TimersIn(meet: meet), T0 + 18 * MIN).right == .meet(mode: "join", m: meet))
var noLink = meet; noLink.link = nil
ok("no link, no Join", TimersCore.show(TimersIn(meet: noLink), T0 + 19 * MIN).right == .meet(mode: "soon", m: noLink))
ok("time left during it, gone at its end", TimersCore.show(TimersIn(meet: meet), T0 + 21 * MIN).right == .meet(mode: "now", m: meet) && TimersCore.show(TimersIn(meet: meet), T0 + 50 * MIN).right == .none)
ok("a takeover hides the bubble; it comes back after", TimersCore.show(TimersIn(pomo: brk, meet: meet), T0 + 26 * MIN).right == .none && TimersCore.show(TimersIn(pomo: work, meet: meet), T0 + 6 * MIN).right != .none)
ok("the stand tab wins over the meeting bubble", TimersCore.show(TimersIn(stand: st, meet: meet), T0 + 10 * MIN - 5_000).right == .standSoon(at: T0 + 10 * MIN))

// Times and links
ok("clock", TimersCore.clock(25 * MIN) == "25:00" && TimersCore.clock(1) == "0:01" && TimersCore.clock(62 * MIN) == "1:02:00")
ok("short left", TimersCore.shortLeft(12 * MIN) == "12m" && TimersCore.shortLeft(30_000) == "30s" && TimersCore.shortLeft(65 * MIN) == "1h 5m" && TimersCore.shortLeft(11 * MIN + 1) == "12m")
ok("only meeting links open", TimersCore.openableLink("https://meet.google.com/x") != nil && TimersCore.openableLink("https://evil.example/x") == nil && TimersCore.openableLink("http://zoom.us/j/1") == nil)
let parsed = TimersCore.from(["pomo": ["id": "sabc", "phase": "short", "endsAt": T0, "left": NSNull(), "wait": false, "sound": true], "stand": ["at": T0, "len": 120000, "sound": true], "meet": ["id": "m", "title": "A\nB", "start": T0, "end": T0 + 1, "from": T0 - 1, "link": "https://bad.example"]])
ok("from the page: checked", parsed.pomo?.phase == "short" && parsed.pomo?.left == nil && parsed.stand?.len == 120000 && parsed.meet?.title == "A B" && parsed.meet?.link == nil)
ok("next change: the earliest boundary still to come", TimersCore.nextChange(TimersIn(stand: st), T0) == T0 + 10 * MIN - 15_000)

print("\(n - bad) of \(n) passed")
if bad > 0 { exit(1) }
