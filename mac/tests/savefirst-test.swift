// Tests for Sources/SaveFirstCore.swift (PS 1.74). Pure values only: no window, no page, no sound.
import Foundation

var failed = 0, passed = 0
func check(_ ok: Bool, _ name: String) { if ok { passed += 1; print("ok -", name) } else { failed += 1; print("FAIL -", name) } }

do {
  var n = 0
  let o = SaveFirstOnce { n += 1 }
  o.fire(); o.fire(); o.fire()
  check(n == 1 && o.done, "the job runs once, whoever calls first (the pages or the time limit)")
}
do {
  var n = 0
  let all = SaveFirstAll(["pages", "recording"]) { n += 1 }
  all.finished("pages")
  check(n == 0 && !all.done, "waits for every part: the pages saved, the recording not yet ended")
  all.finished("pages")
  check(n == 0, "the same part twice counts once")
  all.finished("recording")
  check(n == 1, "runs when the last part finishes")
  all.giveUp(); all.finished("recording")
  check(n == 1, "and never again")
}
do {
  var n = 0
  let all = SaveFirstAll(["pages", "recording"]) { n += 1 }
  all.finished("pages")
  all.giveUp()
  check(n == 1, "the time limit runs it with a part still left (a page that never answers never keeps PS open)")
  all.finished("recording")
  check(n == 1, "a late answer after the limit changes nothing")
}
do {
  var n = 0
  _ = SaveFirstAll([]) { n += 1 }
  check(n == 1, "nothing to wait for: runs at once")
}
check(SaveFirstCore.order == ["overlay", "main"], "the Tab list saves first: its saves travel to the main page, which holds the vault")
check(SaveFirstCore.js.contains("__psSaveNow") && SaveFirstCore.js.contains("await") && SaveFirstCore.js.hasPrefix("return "), "each page runs window.__psSaveNow and is waited for")
check(SaveFirstCore.limit > 3 && SaveFirstCore.limit <= 6, "the limit covers the page's own 3 seconds and stays inside Quit's 6")

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
