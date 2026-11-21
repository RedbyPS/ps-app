// What PS does with macOS's answer about Calendar access (PS 1.72, Jan 21 Nov 2026: "Calendar access is off" with Open
// settings, although Calendar access is on in macOS settings and PS shows his calendar items). Pure, no EventKit, so
// tests/calaccess-test.swift runs it with plain numbers (EKAuthorizationStatus raw values).
//
// The cause: PS remembered that it had asked macOS once ("localCal.asked") and, from then on, read macOS's "not decided"
// as a refusal. But macOS only says "not decided" when it has NO answer for this copy of PS: the first time, after the
// privacy settings were reset, or after PS was signed with another key (a G Squad, own or the developer build replacing the other,
// as on Jan's Mac). A real "Don't Allow" is "denied" (2), which macOS keeps by itself and never asks again for, so PS's
// own memory was never needed. Now:
// - full access (3; "authorized" before macOS 14 is the same number): read.
// - denied (2), restricted (1), add only (4, macOS 14: may write, cannot read): access is really off. Only these show
//   "Calendar access is off" with the button to System Settings.
// - not decided (0): never "off". A click on the Calendar switch or the refresh icon asks macOS (it shows its question
//   only because it has no answer); anything else says "ask" and keeps the copy PS already has.
// - a number this PS does not know (a newer macOS): never "off" either, and no read (a read without access finds no
//   events, which would empty the meetings PS already shows); it says "ask", like not decided.
enum CalAccessCore {
  enum Decision: Equatable { case read, off, askMacOS, notAsked }

  static func decide(status raw: Int, ask: Bool) -> Decision {
    switch raw {
    case 3: return .read
    case 1, 2, 4: return .off
    case 0: return ask ? .askMacOS : .notAsked
    default: return .notAsked
    }
  }

  /// The status word the page gets for a decision that answers at once (core/localcal.ts LocalCalStatus).
  static func reply(_ d: Decision) -> String? {
    switch d {
    case .off: return "denied"
    case .notAsked: return "ask"
    case .read, .askMacOS: return nil
    }
  }
}
