import Foundation
// Fake clock: jobs run in time order. Fake page: ready from `readyAt` seconds on.
var nowT = 0.0
var jobs: [(at: Double, n: Int, job: () -> Void)] = []
var seq = 0
func at(_ t: Double, _ job: @escaping () -> Void) { seq += 1; jobs.append((t, seq, job)) }
func runClock() {
  while !jobs.isEmpty {
    jobs.sort { $0.at == $1.at ? $0.n < $1.n : $0.at < $1.at }
    let j = jobs.removeFirst(); nowT = j.at; j.job()
  }
}
var failed = 0, passed = 0
func check(_ name: String, _ ok: Bool) { if ok { passed += 1; print("ok", name) } else { failed += 1; print("FAIL", name) } }
func page(readyAt: Double, maxTries: Int = 60, applied: @escaping (String) -> Void) -> InOrderSend {
  InOrderSend(maxTries: maxTries, attempt: { json, done in
    if nowT >= readyAt { applied(json); done(true) } else { done(false) }
  }, later: { job in at(nowT + 1, job) })
}

do {   // add at 0, rename at 0.5, the page is ready at 1.2: the add still runs first
  nowT = 0; jobs = []
  var got: [String] = []
  let s = page(readyAt: 1.2) { got.append($0) }
  at(0) { s.send("add") }
  at(0.5) { s.send("rename") }
  at(0.7) { s.send("tick") }
  runClock()
  check("messages sent while the page loads arrive in the order they were sent", got == ["add", "rename", "tick"])
  check("nothing is left waiting", s.waiting == 0)
}
do {   // the page is ready: every message goes at once, each exactly once
  nowT = 0; jobs = []
  var got: [String] = []
  let s = page(readyAt: 0) { got.append($0) }
  s.send("a"); s.send("b")
  runClock()
  check("a ready page gets each message at once, once", got == ["a", "b"] && nowT == 0)
}
do {   // a page that never loads: each message is given up after its tries, nothing hangs
  nowT = 0; jobs = []
  var got: [String] = []
  let s = page(readyAt: .infinity, maxTries: 3) { got.append($0) }
  s.send("a"); s.send("b")
  runClock()
  check("a page that never loads: given up after the tries, the queue empties", got.isEmpty && s.waiting == 0 && nowT == 6)
}
do {   // the page answers later (callAsyncJavaScript's answer comes after the call): the next waits for it
  nowT = 0; jobs = []
  var got: [String] = []
  let s = InOrderSend(attempt: { json, done in got.append("try " + json); at(nowT + 0.3) { done(true) } }, later: { job in at(nowT + 1, job) })
  s.send("a"); s.send("b")
  runClock()
  check("one message at a time: the second is tried only after the first answered", got == ["try a", "try b"] && abs(nowT - 0.6) < 0.0001)
}
print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
