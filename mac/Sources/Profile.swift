import Foundation

// This build's profile (V1.58, multiple developers; design: ps-handover-notes/v158-multidev-design.md section 2).
// One small settings file per build, bundled by build.sh as PS.app/Contents/Resources/profile.json: core's
// profiles/gsquad.json for the G Squad build, a person's own profile.json in their layer (the developer's: web
// ps-layer/profile.json). It says whose build this is (name), which updates it follows (channel), whether other people's
// shared features start on (othersShared), per build feature overrides (features) and the rules that differ per person.
//
// No file (every build made the V1.57 way, a self test copy): `current` is nil. PS 1.71: a private tree's build (the developer's)
// then still carries its layer's rules alone (Resources/build-rules.json, `layerRules`); with neither, every rule keeps
// its per account answer (protected-158's BuildRules) exactly as in V1.57. Never a gsquad default.
// Plain values only, so tests/profile-test.swift checks it without the app.
struct Profile: Equatable {
  enum Channel: Equatable { case gsquad, local, url(String) }

  /// The rules that differ per person (the same names as the web's core/profile.ts RULES).
  static let ruleNames = ["tabOverProtectedApps", "islandOverProtectedApps"]

  /// "gsquad" for the shared build, else the person's private release name ("red", "jan").
  let name: String
  let display: String
  let channel: Channel
  /// Shared features made by OTHER people start on ("on" in gsquad, "off" in every person's own profile).
  let othersShared: Bool
  /// Overrides of the registry default for this build, by feature id.
  let features: [String: Bool]
  let rules: [String: Bool]

  /// What the profile says about a rule, or nil when it does not say.
  func rule(_ r: String) -> Bool? { rules[r] }

  static func isName(_ s: String) -> Bool {
    guard let f = s.unicodeScalars.first, s.unicodeScalars.count <= 32, ("a"..."z").contains(Character(f)) else { return false }
    return s.unicodeScalars.allSatisfy { ("a"..."z").contains(Character($0)) || ("0"..."9").contains(Character($0)) }
  }
  static func isFeatureId(_ s: String) -> Bool {
    guard !s.isEmpty, s.count <= 48, !s.hasPrefix("-"), !s.hasSuffix("-"), !s.contains("--"),
          let f = s.unicodeScalars.first, ("a"..."z").contains(Character(f)) else { return false }
    return s.unicodeScalars.allSatisfy { ("a"..."z").contains(Character($0)) || ("0"..."9").contains(Character($0)) || $0 == "-" }
  }

  /// A profile from its JSON object, or nil when it is not one (a wrong file never half applies).
  static func from(_ any: Any?) -> Profile? {
    guard let p = any as? [String: Any], (p["schema"] as? Int) == 1,
          let name = p["name"] as? String, isName(name),
          let ch = p["channel"] as? [String: Any], let kind = ch["kind"] as? String,
          let others = p["othersShared"] as? String, others == "on" || others == "off" else { return nil }
    let channel: Channel
    switch kind {
    case "gsquad": channel = .gsquad
    case "local": channel = .local
    case "url":
      guard let u = ch["url"] as? String, u.hasPrefix("https://"), !u.contains(" "), u.count > 8 else { return nil }
      channel = .url(u)
    default: return nil
    }
    var features: [String: Bool] = [:]
    for (k, v) in (p["features"] as? [String: Any]) ?? [:] where isFeatureId(k) { if let b = v as? Bool, isBool(v) { features[k] = b } }
    var rules: [String: Bool] = [:]
    let r = (p["rules"] as? [String: Any]) ?? [:]
    for k in ruleNames { if let v = r[k], isBool(v), let b = v as? Bool { rules[k] = b } }
    let d = ((p["display"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
    return Profile(name: name, display: d.isEmpty ? name : String(d.prefix(60)), channel: channel,
                   othersShared: others == "on", features: features, rules: rules)
  }
  /// JSONSerialization gives numbers and booleans as NSNumber: only a real true or false counts.
  static func isBool(_ v: Any) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
  }

  static func load(_ url: URL?) -> Profile? {
    guard let url, let data = try? Data(contentsOf: url), let any = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return from(any)
  }

  /// This app's bundled profile, nil when it has none. Read once.
  static let current: Profile? = load(Bundle.main.url(forResource: "profile", withExtension: "json"))

  /// PS 1.71: the rules alone, from a rules object ({"tabOverProtectedApps": false, ...}). Only known names with a real
  /// true or false count; nil when none does (a wrong file never half applies, and an empty one says nothing).
  static func rulesFrom(_ any: Any?) -> [String: Bool]? {
    guard let r = any as? [String: Any] else { return nil }
    var out: [String: Bool] = [:]
    for k in ruleNames { if let v = r[k], isBool(v), let b = v as? Bool { out[k] = b } }
    return out.isEmpty ? nil : out
  }
  static func loadRules(_ url: URL?) -> [String: Bool]? {
    guard let url, let data = try? Data(contentsOf: url), let any = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return rulesFrom(any)
  }
  /// PS 1.71: a build made from a private tree has no profile.json (build.sh gives it only its own update channel), so
  /// build.sh writes the layer profile's rules alone as Resources/build-rules.json (the developer's: both false). nil without one.
  static let layerRules: [String: Bool]? = loadRules(Bundle.main.url(forResource: "build-rules", withExtension: "json"))

  /// A rule's answer for this build. PS 1.71 (the developer, 13 Nov 2026, again on 19 Nov: "it's just turned off again"): the
  /// Tab list and the island over 1Password and Signal are two rules per BUILD, never one shared switch. On in the G
  /// Squad build, off in the developer's own build, whoever is signed in. So the build decides whenever it says: its bundled
  /// profile (the G Squad build: true), else its layer's rules (the developer's private build: false). Before 1.71 the profile
  /// was ANDed with the per account answer, so the G Squad build signed in with the developer's account was off.
  /// A build that says nothing (core built without a profile, an open source copy) keeps the per account answer, as
  /// in V1.57.
  static func allows(_ rule: String, account: Bool, profile: Profile? = current, layer: [String: Bool]? = layerRules) -> Bool {
    if let v = profile?.rule(rule) { return v }
    if let v = layer?[rule] { return v }
    return account
  }
}

// protected-158's one place for the per account rules (BuildRules.swift). The design called this
// call ProtectedRules.fromProfile; protected-158 named its place BuildRules, so it lives on BuildRules.
extension BuildRules {
  /// The rules for this build (PS 1.71): what the build says (its profile, else its layer's rules) decides; the per
  /// account rules only where the build says nothing (every build made the V1.57 way: exactly the per account rules).
  static func fromProfile(_ account: Rules, profile: Profile? = Profile.current, layer: [String: Bool]? = Profile.layerRules) -> Rules {
    Rules(tabOverProtected: Profile.allows("tabOverProtectedApps", account: account.tabOverProtected, profile: profile, layer: layer),
          islandOverProtected: Profile.allows("islandOverProtectedApps", account: account.islandOverProtected, profile: profile, layer: layer))
  }
}
