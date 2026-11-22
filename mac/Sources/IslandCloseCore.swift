import Foundation
import CoreGraphics

// PS 1.74 (the developer, 22 Nov 2026): "I should ONLY be able to see the task at hand on the dynamic island." With both timers
// running the closed island was full: the tick circle, the email and reply counts, the task cut to "Get b...", two timers
// and "+1". Now the closed island shows only the task being worked on, with room to read it (in the middle of the island).
// The tick circle, the counts, the timers, the leaf, the target icon and "+1" show on hover, inside the open island, which
// gets a line for the timers and the leaf. Feature "island-task-only" (web core/island.ts TASK_ONLY_FEATURE), on for
// everyone; its switch is in Settings, Dynamic Island. The page sends it as taskOnly; off, the closed island is as before.
// What stays: a moment on the island (a new email popping it open, a Pomodoro break, a stand-up) still takes the island for
// its few seconds, "Done" still shows after a tick, private mode still shows its label in the task's place, and with no
// task at all the counts still show (an empty island would say nothing). Pure values only (tests/island-close-test.sh).

enum IslandCloseCore {
  static let feature = "island-task-only"

  /// What the closed island shows besides the task's words.
  struct Closed: Equatable {
    var tick = true, counts = true, more = true, icon = true, clocks = true, leaf = true
    /// The task's words in the middle of the island, with the whole width to themselves.
    var centred = false
    static let all = Closed()
    static let taskOnly = Closed(tick: false, counts: false, more: false, icon: false, clocks: false, leaf: false, centred: true)
  }

  /// The page's switch: on unless it says off (an older page that does not send it: on, the feature's default).
  static func taskOnly(_ v: Any?) -> Bool { (v as? Bool) != false }

  /// Trimmed to the task: the switch on and something in the task's place (a task, "Done" after a tick, or the private
  /// mode label). With nothing there, the counts still show as before.
  static func trimmed(taskOnly: Bool, hasTask: Bool) -> Bool { taskOnly && hasTask }
  static func closed(taskOnly: Bool, hasTask: Bool) -> Closed { trimmed(taskOnly: taskOnly, hasTask: hasTask) ? .taskOnly : .all }

  /// Is a timer counting next to the task: the Pomodoro work time (its clock shown, not waiting), or the day countdown or
  /// the task's Priority 1 timer (never right after a tick or in private mode, as before).
  static func clocks(work: Bool, day: Bool, ticked: Bool, priv: Bool) -> Bool { work || (day && !ticked && !priv) }

  /// The open island's line for what the closed island no longer shows (the timers and the leaf): only while trimmed.
  static func openLine(trimmed: Bool, clocks: Bool, leaf: Bool) -> Bool { trimmed && (clocks || leaf) }
  /// Its height, and what it adds to the open island (the line and the gap above it).
  static let lineH: CGFloat = 22, lineGap: CGFloat = 8
  /// "Done" after a tick: for its moment, once Undo has passed, and (trimmed to the task) for as long as the tick lasts when
  /// no task comes next, so the closed island is never blank while its Undo waits on hover (break-it 1.74 round 2).
  static func showDone(sinceTick: Double, undoable: Bool, trimmed: Bool, nextTask: Bool, priv: Bool) -> Bool {
    !undoable || sinceTick < 1.4 || (trimmed && !nextTask && !priv)
  }
  static func openExtra(trimmed: Bool, clocks: Bool, leaf: Bool) -> CGFloat { openLine(trimmed: trimmed, clocks: clocks, leaf: leaf) ? lineH + lineGap : 0 }
}
