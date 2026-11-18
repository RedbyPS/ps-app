import Foundation
// Run: bash tests/island-mail-open-test.sh
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
func parse(_ s: String?) -> [String: String]? { s.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String] } }
ok("the envelope asks for the newest client email", parse(IslandMailOpen.json(via: "gmail")) == ["type": "mailOpen", "via": "gmail"])
ok("the reply arrow asks for the newest lead reply", parse(IslandMailOpen.json(via: "instantly")) == ["type": "mailOpen", "via": "instantly"])
ok("anything else asks for nothing", IslandMailOpen.json(via: "") == nil && IslandMailOpen.json(via: "x\"}") == nil && IslandMailOpen.json(via: "Gmail") == nil)
ok("the two kinds", IslandMailOpen.kinds == ["gmail", "instantly"])
// The island's counts no longer open the browser: no badge carries a Gmail or Instantly link any more.
let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let src = (try? String(contentsOf: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : here.appendingPathComponent("Sources/Island.swift").path), encoding: .utf8)) ?? ""
let badgeLines = src.split(separator: "\n").filter { $0.contains("badge(\"") }
ok("Island.swift read", !src.isEmpty && badgeLines.count >= 6)
ok("every count on the island opens the email panel, none a web link", badgeLines.allSatisfy { $0.contains("via: IslandMailOpen.") && !$0.contains("url:") && !$0.contains("https://") })
ok("the envelope is Gmail and the arrow Instantly everywhere", badgeLines.allSatisfy { ($0.contains("envelope.fill") && $0.contains("IslandMailOpen.gmail")) || ($0.contains("arrowshape") && $0.contains("IslandMailOpen.instantly")) })
// PS 1.68: the hover words say what the number counts and what a click does.
ok("one client email", IslandMailOpen.hover(via: "gmail", n: 1) == "1 client email not dealt with yet. Click to see it in the email panel.")
ok("many client emails", IslandMailOpen.hover(via: "gmail", n: 20) == "20 client emails not dealt with yet. Click to see them in the email panel.")
ok("lead replies", IslandMailOpen.hover(via: "instantly", n: 3) == "3 lead replies not dealt with yet. Click to see them in the email panel."
  && IslandMailOpen.hover(via: "instantly", n: 1) == "1 lead reply not dealt with yet. Click to see it in the email panel.")
ok("anything else has no words, and no negative counts", IslandMailOpen.hover(via: "x", n: 2) == "" && IslandMailOpen.hover(via: "gmail", n: -4).hasPrefix("0 client emails"))
ok("every count on the island has its hover words", src.contains(".help(IslandMailOpen.hover(via: via, n: n))"))
print(bad == 0 ? "ALL \(n) PASSED" : "\(bad) of \(n) FAILED")
exit(bad == 0 ? 0 : 1)
