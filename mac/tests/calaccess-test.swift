// Offline test for Sources/CalAccessCore.swift (PS 1.72, Jan: "Calendar access is off" while it was on). Plain numbers for
// EKAuthorizationStatus (0 not decided, 1 restricted, 2 denied, 3 full access / authorized, 4 add only). No EventKit, no
// app, no permission prompt.
//   bash tests/calaccess-test.sh
import Foundation

var fails = 0, count = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { count += 1; print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty || ok ? "" : " (\(info))")"); if !ok { fails += 1 } }
typealias D = CalAccessCore.Decision
let decide = CalAccessCore.decide

// Full access (macOS 14 fullAccess, and authorized before it: the same number) reads, asked or not.
check("full-reads", decide(3, false) == D.read && decide(3, true) == D.read)
// Really off: denied, restricted, add only. The only ones that say "denied" (Calendar access is off, Open settings).
for raw in [1, 2, 4] {
  check("off-\(raw)", decide(raw, false) == D.off && decide(raw, true) == D.off && CalAccessCore.reply(D.off) == "denied")
}
// Jan's case: not decided (a new signature or a privacy reset) is never "off", even after PS asked once before.
check("undecided-quiet", decide(0, false) == D.notAsked && CalAccessCore.reply(D.notAsked) == "ask")
check("undecided-click-asks", decide(0, true) == D.askMacOS && CalAccessCore.reply(D.askMacOS) == nil)
// A status a newer macOS adds: never "off", and never a read that could empty the meetings.
check("unknown-quiet", decide(9, false) == D.notAsked && decide(-1, true) == D.notAsked)
check("read-no-reply", CalAccessCore.reply(D.read) == nil)
// Nothing but 1, 2 and 4 can ever say "denied".
let saysOff = (-2...12).filter { CalAccessCore.reply(decide($0, false)) == "denied" || CalAccessCore.reply(decide($0, true)) == "denied" }
check("only-real-off", saysOff == [1, 2, 4], "\(saysOff)")

print("calaccess: \(count - fails) of \(count) ok")
exit(fails == 0 ? 0 : 1)
