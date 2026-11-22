import Foundation
// Run: bash tests/island-close-test.sh. What the closed Dynamic Island shows (Sources/IslandCloseCore.swift, PS 1.74):
// only the task when closed, everything else on hover.
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
typealias C = IslandCloseCore

// 1. the switch from the page: on unless it says off
ok("the page says nothing (an older page): on", C.taskOnly(nil))
ok("the page says true or false", C.taskOnly(true) && !C.taskOnly(false))
ok("anything odd counts as on (the feature's default)", C.taskOnly("no") && C.taskOnly(0))

// 2. closed with a task: only the task, in the middle
let t = C.closed(taskOnly: true, hasTask: true)
ok("closed, task only: no tick circle", !t.tick)
ok("closed, task only: no email or reply counts", !t.counts)
ok("closed, task only: no +1", !t.more)
ok("closed, task only: no timers", !t.clocks)
ok("closed, task only: no leaf and no target icon", !t.leaf && !t.icon)
ok("closed, task only: the task in the middle with the room to itself", t.centred)
// 3. switched off: everything as before
ok("switched off: the full closed island as before", C.closed(taskOnly: false, hasTask: true) == .all && !C.Closed.all.centred)
// 4. no task at all: the counts still show (an empty island says nothing)
ok("no task: the full row as before", C.closed(taskOnly: true, hasTask: false) == .all && !C.trimmed(taskOnly: true, hasTask: false))

// 5. the timers: which ones count as a timer next to the task
ok("the Pomodoro work clock", C.clocks(work: true, day: false, ticked: false, priv: false))
ok("the day countdown or Priority 1 timer", C.clocks(work: false, day: true, ticked: false, priv: false))
ok("the day clocks hide right after a tick and in private mode, as before", !C.clocks(work: false, day: true, ticked: true, priv: false) && !C.clocks(work: false, day: true, ticked: false, priv: true))
ok("no timer at all", !C.clocks(work: false, day: false, ticked: false, priv: false))

// 6. the open island gets a line for them (and the leaf) only while the closed island is trimmed
ok("open, trimmed, a timer running: the line shows", C.openLine(trimmed: true, clocks: true, leaf: false))
ok("open, trimmed, Low power mode on: the line shows the leaf", C.openLine(trimmed: true, clocks: false, leaf: true))
ok("open, trimmed, nothing to add: no line", !C.openLine(trimmed: true, clocks: false, leaf: false))
ok("switched off: no line (the closed island still has them)", !C.openLine(trimmed: false, clocks: true, leaf: true))
ok("the open island grows by the line and its gap", C.openExtra(trimmed: true, clocks: true, leaf: false) == C.lineH + C.lineGap && C.openExtra(trimmed: false, clocks: true, leaf: true) == 0)

// 7. the island draws it so (Island.swift, read as text: the views need a window to run)
let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let src = (try? String(contentsOfFile: root + "/Sources/Island.swift", encoding: .utf8)) ?? ""
ok("the page's switch reaches the island, with the Mac's feature switch", src.contains("s.taskOnly = IslandCloseCore.taskOnly(d[\"taskOnly\"]) && Features.on(\"island-task-only\")"))
ok("the pill, Drop and the full screen bar each draw only the task when trimmed", src.contains("if m.trimmed { taskOnlyRow(size: pt.compact ? 11.5 : 12.5)") && src.contains("if m.trimmed { taskOnlyRow(size: 12)") && src.contains("} else if m.trimmed {\n        // PS 1.74: only the task when closed"))
// Last check before the 1.74 release: empty wings made Slim a blank strip, so Slim stays as it was in 1.73.
ok("Slim keeps its tick and count when trimmed (never a blank strip)", !src.contains("if m.trimmed { Color.clear.frame(width: IslandModel.slimWing) }") && src.contains("      if m.st.tickLeft { slimTick } else { slimCount }\n      Color.clear.frame(width: m.geo.notchW)\n      if m.st.tickLeft { slimCount } else { slimTick }"))
ok("the remembered rest is never an opened island (an email popped out, the big timer)", src.contains("guard !test, model.fs == .off, !model.editing, model.popping == nil, !model.bigTimer, drag?.moving != true, let r = restShape()"))
ok("the trimmed row leaves the timers out", src.contains("titleText(size: size, clocks: false)"))
ok("the open island shows the timers and the leaf on their own line", src.contains("if m.openLine {") && src.contains("WorkClock(m: m, color: dimC)\n          DayClocks(m: m, color: dimC, size: 12)"))
ok("and is measured for it", src.contains("IslandCloseCore.openExtra(trimmed: trimmed, clocks: clocksAny, leaf: st.lp != nil)"))

// break-it 1.74 round 2: the last task ticked on a trimmed island keeps "Done" until its Undo time ends, never a blank island
ok("Done for its first moment", C.showDone(sinceTick: 0.5, undoable: true, trimmed: false, nextTask: true, priv: false))
ok("untrimmed: Undo after the moment, as before", !C.showDone(sinceTick: 2, undoable: true, trimmed: false, nextTask: false, priv: false))
ok("trimmed with a next task: the next task shows after the moment", !C.showDone(sinceTick: 2, undoable: true, trimmed: true, nextTask: true, priv: false))
ok("trimmed, nothing next: Done stays, never blank", C.showDone(sinceTick: 3, undoable: true, trimmed: true, nextTask: false, priv: false))
ok("trimmed, private mode: its label shows", !C.showDone(sinceTick: 3, undoable: true, trimmed: true, nextTask: false, priv: true))
ok("the title asks the rule", src.contains("IslandCloseCore.showDone(sinceTick: Date().timeIntervalSince(m.tickedAt)"))

print("\(n - bad)/\(n) passed")
exit(bad == 0 ? 0 : 1)
