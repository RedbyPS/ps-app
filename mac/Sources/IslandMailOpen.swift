import Foundation

// PS 1.61 (the developer: an email count on the island "opens nothing useful"; it opened Gmail in the browser). A click on the
// island's envelope (client emails) or reply arrow (lead replies) now brings the Tab list up on the email panel with the
// newest of those emails open, the same place an email card's Reply goes. The Mac only says which kind was clicked; the
// Tab list page picks the newest email itself (src/core/mailopen.ts), so no email words ever pass through here.
// The counts themselves only come when the page allows the email panel (src/island.ts, the Client emails switch).
// Pure, no window: tests/island-mail-open-test.sh checks it.
enum IslandMailOpen {
  /// The kinds the island has a count for: the envelope is Gmail (client emails), the arrow is Instantly (lead replies).
  static let gmail = "gmail", instantly = "instantly"
  static let kinds: Set<String> = [gmail, instantly]
  /// The message for the Tab list page, or nil for anything that is not one of the two kinds.
  static func json(via: String) -> String? {
    guard kinds.contains(via) else { return nil }
    return #"{"type":"mailOpen","via":"\#(via)"}"#
  }
  /// How long after showing the Tab list the message goes (the same wait as a WhatsApp card's Reply, main.swift).
  static let delay: Double = 0.35
  /// PS 1.68 (Jan, 18 Nov 2026: "it says 20 emails but I have no clue what these 20 emails are"): the words on hover. The page
  /// counts what the email panel lists (src/core/mailopen.ts isOpenReply), so the number and the panel agree.
  /// Words wait for the owner's approval.
  static func hover(via: String, n: Int) -> String {
    let k = max(0, n)
    let one = k == 1
    switch via {
    case gmail: return "\(k) client email\(one ? "" : "s") not dealt with yet. Click to see \(one ? "it" : "them") in the email panel."
    case instantly: return "\(k) lead repl\(one ? "y" : "ies") not dealt with yet. Click to see \(one ? "it" : "them") in the email panel."
    default: return ""
    }
  }
}
