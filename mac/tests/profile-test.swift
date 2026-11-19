// Offline test for Sources/Profile.swift and Sources/Features.swift (V1.58, multiple developers): the profile file, the
// 1Password and Signal rules (PS 1.71: per BUILD, the G Squad build on for every account, the developer's build off for every
// account, the per account answer only for a build that says nothing), the registry and Features.on's answers.
// No app, no self test: tests/profile-test.sh compiles these two files with this one.
import Foundation

var fails = 0, count = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { count += 1; print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty || ok ? "" : " (\(info))")"); if !ok { fails += 1 } }
func psLog(_ s: String) {}
func json(_ s: String) -> Any { try! JSONSerialization.jsonObject(with: s.data(using: .utf8)!) }

let gsquadJSON = CommandLine.arguments.count > 1 ? try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8) : ""
let gsquad = Profile.from(json(gsquadJSON))
let red = Profile.from(json(#"{"schema":1,"name":"red","display":"Owner","channel":{"kind":"url","url":"https://example.com/x/ps-update.json"},"othersShared":"off","features":{},"rules":{"tabOverProtectedApps":false,"islandOverProtectedApps":false}}"#))

// MARK: the profile file
check("gsquad-file-reads", gsquad != nil && gsquad?.name == "gsquad" && gsquad?.channel == .gsquad && gsquad?.othersShared == true)
check("gsquad-rules-on", gsquad?.rule("tabOverProtectedApps") == true && gsquad?.rule("islandOverProtectedApps") == true)
check("red-reads", red?.name == "red" && red?.othersShared == false && red?.channel == .url("https://example.com/x/ps-update.json"))
check("red-rules-off", red?.rule("tabOverProtectedApps") == false && red?.rule("islandOverProtectedApps") == false)
check("unknown-rule-nil", gsquad?.rule("somethingElse") == nil)
check("bad-schema", Profile.from(json(#"{"schema":2,"name":"red","channel":{"kind":"local"},"othersShared":"off"}"#)) == nil)
check("bad-name", Profile.from(json(#"{"schema":1,"name":"The developer!","channel":{"kind":"local"},"othersShared":"off"}"#)) == nil)
check("bad-channel", Profile.from(json(#"{"schema":1,"name":"jan","channel":{"kind":"url","url":"http://x"},"othersShared":"off"}"#)) == nil)
check("bad-others", Profile.from(json(#"{"schema":1,"name":"jan","channel":{"kind":"local"},"othersShared":"yes"}"#)) == nil)
check("number-is-not-a-bool", Profile.from(json(#"{"schema":1,"name":"jan","channel":{"kind":"local"},"othersShared":"off","rules":{"tabOverProtectedApps":1},"features":{"x-y":0}}"#)).map { $0.rules.isEmpty && $0.features.isEmpty } == true)
check("display-falls-back", Profile.from(json(#"{"schema":1,"name":"jan","channel":{"kind":"local"},"othersShared":"off"}"#))?.display == "jan")
check("no-file-nil", Profile.load(URL(fileURLWithPath: "/nonexistent/profile.json")) == nil)
check("ids", Profile.isFeatureId("island-menu-strip") && !Profile.isFeatureId("Island") && !Profile.isFeatureId("a--b") && !Profile.isFeatureId("-a") && !Profile.isFeatureId("a-"))

// MARK: the 1Password and Signal rules, per BUILD (PS 1.71, the developer: two rules per build, never one shared switch)
// The layer's rules alone (Resources/build-rules.json, written by build.sh for a private tree such as the developer's).
let redLayer = Profile.rulesFrom(json(#"{"tabOverProtectedApps":false,"islandOverProtectedApps":false}"#))
check("layer-rules-read", redLayer == ["tabOverProtectedApps": false, "islandOverProtectedApps": false])
check("layer-rules-empty-says-nothing", Profile.rulesFrom(json("{}")) == nil)
check("layer-rules-not-an-object", Profile.rulesFrom(json("[false]")) == nil)
check("layer-rules-number-is-not-a-bool", Profile.rulesFrom(json(#"{"tabOverProtectedApps":0,"islandOverProtectedApps":"false"}"#)) == nil)
check("layer-rules-unknown-names-dropped", Profile.rulesFrom(json(#"{"tabOverProtectedApps":true,"other":false}"#)) == ["tabOverProtectedApps": true])
check("layer-rules-no-file", Profile.loadRules(URL(fileURLWithPath: "/nonexistent/build-rules.json")) == nil)
// The developer's real file: tests/profile-test.sh runs build.sh's own line on web ps-layer/profile.json.
let realLayer = CommandLine.arguments.count > 3 ? Profile.loadRules(URL(fileURLWithPath: CommandLine.arguments[3])) : nil
check("red-real-layer-rules-off", realLayer == ["tabOverProtectedApps": false, "islandOverProtectedApps": false], "\(String(describing: realLayer))")

// The 2x2 (plus the others): which build x who is signed in. The developer's account's per account answer is false, a friend's
// true, and nobody signed in yet (a fresh install, or after Sign out of this Mac) counts as public, true.
let accounts: [(String, Bool)] = [("red-account", false), ("friend-account", true), ("nobody-signed-in-yet", true)]
let builds: [(String, Profile?, [String: Bool]?, Bool)] = [
  ("gsquad-build", gsquad, nil, true),               // core's profiles/gsquad.json, bundled as Resources/profile.json
  ("red-private-build", nil, realLayer, false),      // build.sh: no profile.json, the layer's rules alone
  ("red-private-build-fixture", nil, redLayer, false),
  ("red-assembled-build", red, nil, false),          // a red build made with tools/assemble.mjs (the full profile)
]
for (b, prof, layer, on) in builds {
  for (a, acct) in accounts {
    for rule in Profile.ruleNames {
      check("\(b)-\(a)-\(rule)-\(on ? "on" : "off")", Profile.allows(rule, account: acct, profile: prof, layer: layer) == on)
    }
  }
}
// A build that says nothing keeps the per account answer exactly as in V1.57.
for (a, acct) in accounts { for rule in Profile.ruleNames {
  check("no-build-rules-\(a)-\(rule)-per-account", Profile.allows(rule, account: acct, profile: nil, layer: nil) == acct)
} }
let janNoRules = Profile.from(json(#"{"schema":1,"name":"jan","channel":{"kind":"local"},"othersShared":"off"}"#))
check("profile-without-rules-falls-to-layer", !Profile.allows("tabOverProtectedApps", account: true, profile: janNoRules, layer: redLayer))
check("profile-without-rules-falls-to-account", Profile.allows("tabOverProtectedApps", account: true, profile: janNoRules, layer: nil)
  && !Profile.allows("tabOverProtectedApps", account: false, profile: janNoRules, layer: nil))
check("profile-wins-over-layer", Profile.allows("islandOverProtectedApps", account: false, profile: gsquad, layer: redLayer))
// The bug the developer saw on 19 Nov: the G Squad build signed in with his account was off (the old join ANDed them).
check("bug-19-nov-gsquad-on-red-account-now-on", Profile.allows("tabOverProtectedApps", account: false, profile: gsquad, layer: nil)
  && Profile.allows("islandOverProtectedApps", account: false, profile: gsquad, layer: nil))

// MARK: the registry
let reg = Features.registry(from: json(#"""
[{"schema":1,"features":[
  {"id":"campaigns","name":"x","owner":"core","scope":"shared","since":"1.55","parts":["web"],"default":"off"},
  {"id":"island-menu-strip","name":"x","owner":"red","scope":"shared","since":"1.58","parts":["mac"],"default":"on"},
  {"id":"jan-thing","name":"x","owner":"jan","scope":"shared","since":"1.59","parts":["mac"],"default":"on"},
  {"id":"jan-off","name":"x","owner":"jan","scope":"shared","since":"1.59","parts":["mac"],"default":"off"},
  {"id":"Bad","name":"x","owner":"jan","scope":"shared","since":"1.59","parts":["mac"],"default":"on"},
  {"id":"jan-thing","name":"again","owner":"red","scope":"shared","since":"1.59","parts":["mac"],"default":"off"}]},
 {"schema":1,"features":[{"id":"second-computer","name":"x","owner":"red","scope":"private","since":"1.57","parts":["mac"],"default":"on"}]},
 {"schema":9,"features":[{"id":"future","name":"x","owner":"red","scope":"shared","since":"1.60","parts":["mac"],"default":"on"}]}]
"""#))
check("registry-reads", reg.map(\.id) == ["campaigns", "island-menu-strip", "jan-thing", "jan-off", "second-computer"], "\(reg.map(\.id))")
check("registry-first-wins", reg.first { $0.id == "jan-thing" }?.owner == "jan")
check("registry-empty", Features.registry(from: nil).isEmpty && Features.registry(from: "nonsense").isEmpty)

// MARK: Features.on before the page says anything
func b(_ id: String, _ p: Profile?) -> Bool { Features.bundled(id, registry: reg, profile: p) }
check("core-default", !b("campaigns", gsquad) && !b("campaigns", red) && !b("campaigns", nil))
check("own-feature-on", b("island-menu-strip", red))
check("others-on-in-gsquad", b("island-menu-strip", gsquad) && b("jan-thing", gsquad))
check("others-default-off-stays-off-in-gsquad", !b("jan-off", gsquad))
check("others-off-for-red", !b("jan-thing", red))
check("no-profile-others-off", !b("jan-thing", nil) && !b("island-menu-strip", nil))
check("private-of-own", b("second-computer", red) && !b("second-computer", gsquad))
check("unknown-id-off", !b("nobody-knows", gsquad))
let redOn = Profile(name: "red", display: "Owner", channel: .local, othersShared: false, features: ["jan-thing": true], rules: [:])
check("profile-override", b("jan-thing", redOn))

// MARK: the page's answers win
check("told-wins", Features.decide("jan-thing", told: ["jan-thing": true], registry: reg, profile: red))
check("told-off-wins", !Features.decide("island-menu-strip", told: ["island-menu-strip": false], registry: reg, profile: red))
check("told-other-id-falls-back", Features.decide("island-menu-strip", told: ["jan-thing": true], registry: reg, profile: red))
check("clean", Features.clean(json(#"{"a-b":true,"Bad":true,"c":1,"d":false}"#)) == ["a-b": true, "d": false])
check("clean-not-a-dict", Features.clean(json(#"[1]"#)) == nil)
check("handle-other-type", !Features.handle("looks", [:]))

// MARK: V1.61 the page's answers reach the app (main.swift routes {type: "features"} to Features.handle)
// tests/profile-test.sh runs this with PS_SELFTEST set, so handle keeps the answers in memory, never in the real settings.
check("selftest-env", ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil)
check("handle-features", Features.handle("features", ["on": ["island-moments": true, "client-emails": true, "whatsapp": false]]))
check("told-kept", Features.told == ["island-moments": true, "client-emails": true, "whatsapp": false], "\(String(describing: Features.told))")
check("on-follows-page", Features.on("island-moments") && Features.on("client-emails") && !Features.on("whatsapp"))
check("handle-bad-answers-ignored", Features.handle("features", ["on": "nonsense"]) && Features.told?["island-moments"] == true)
check("handle-page-switches-off", Features.handle("features", ["on": ["island-moments": false]]) && !Features.on("island-moments"))

// MARK: V1.61 the bundled registry of a build made the old way (tools/bundle-features.mjs, from core's features.json)
let bundledJSON = CommandLine.arguments.count > 2 ? try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) : "{}"
let bundledFile = json(bundledJSON) as? [String: Any] ?? [:]
let coreReg = Features.registry(from: bundledFile["features"])
let janIds = ["remind-ring", "remind-push", "gym-scan-better", "fitness-island", "island-moments", "welcome-back", "workout-summary",
              "client-emails", "whatsapp", "gsquad-newlook", "gsquad-notify", "gsquad-island-reply", "feature-intros", "screen-recording"]
check("bundle-no-profile", bundledFile["profile"] is NSNull, "a build made the old way is one app for everyone")
check("bundle-has-core-list", coreReg.contains { $0.id == "campaigns" } && janIds.allSatisfy { id in coreReg.contains { $0.id == id } }, "\(coreReg.map(\.id))")
check("bundle-before-page-core-default", !Features.decide("campaigns", told: nil, registry: coreReg, profile: nil))
check("bundle-before-page-friends-off", janIds.allSatisfy { !Features.decide($0, told: nil, registry: coreReg, profile: nil) })
let redAnswers = Dictionary(uniqueKeysWithValues: janIds.map { ($0, $0 != "whatsapp") })
check("bundle-after-page-follows", janIds.allSatisfy { Features.decide($0, told: redAnswers, registry: coreReg, profile: nil) == ($0 != "whatsapp") })
// Client emails is on by default since 1.62 (registry "default": "on"), so the G Squad build starts with both on.
check("gsquad-bundle-before-page", Features.decide("island-moments", told: nil, registry: coreReg, profile: gsquad) && Features.decide("client-emails", told: nil, registry: coreReg, profile: gsquad))

// BuildRules.fromProfile (protected-158's place, fed from the build: PS 1.71, the build decides when it says)
let pub = BuildRules.rules(red: false), redAcct = BuildRules.rules(red: true)
let allOn = BuildRules.Rules(tabOverProtected: true, islandOverProtected: true)
let allOff = BuildRules.Rules(tabOverProtected: false, islandOverProtected: false)
check("buildrules-no-build-rules-public", BuildRules.fromProfile(pub, profile: nil, layer: nil) == pub)
check("buildrules-no-build-rules-red", BuildRules.fromProfile(redAcct, profile: nil, layer: nil) == redAcct)
check("buildrules-gsquad-friend-on", BuildRules.fromProfile(pub, profile: gsquad, layer: nil) == allOn)
check("buildrules-gsquad-red-account-on", BuildRules.fromProfile(redAcct, profile: gsquad, layer: nil) == allOn)
check("buildrules-red-private-red-account-off", BuildRules.fromProfile(redAcct, profile: nil, layer: realLayer) == allOff)
check("buildrules-red-private-friend-off", BuildRules.fromProfile(pub, profile: nil, layer: realLayer) == allOff)
check("buildrules-red-profile-friend-off", BuildRules.fromProfile(pub, profile: red, layer: nil) == allOff)
check("buildrules-red-profile-red-account-off", BuildRules.fromProfile(redAcct, profile: red, layer: nil) == allOff)
// The defaults, as the app has them: a command line binary's bundle is its own folder, and tests/profile-test.sh writes
// build-rules.json next to it (as build.sh does in the developer's PS.app/Contents/Resources) and no profile.json. So this binary
// is "The developer's private build": it finds the file by itself and is off for every account.
check("bundle-finds-layer-rules", Profile.current == nil && Profile.layerRules == realLayer && realLayer != nil)
check("bundle-defaults-red-private-off", BuildRules.fromProfile(pub) == allOff && BuildRules.fromProfile(redAcct) == allOff
  && !Profile.allows("tabOverProtectedApps", account: true) && !Profile.allows("islandOverProtectedApps", account: true))

print("\(count - fails)/\(count) ok")
exit(fails == 0 ? 0 : 1)
