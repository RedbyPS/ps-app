import Foundation

// Is a feature on in this build? (V1.58, multiple developers; design: ps-handover-notes/v158-multidev-design.md section 3.)
// The one question native code asks: Features.on(<the feature id, written out in quotes>).
//
// The page works out every feature's answer (web core/features.ts: the registry, this build's profile, who is
// signed in and their own "From the squad" switches) and sends {type: "features", on: {"<id>": true | false}}
// (src/featuresync.ts) whenever it changes. That answer wins, and is kept on this Mac so it holds from launch on.
// Before the page has said anything: the bundled registry (Resources/ps-build.json "features") and profile decide.
// Made by core or by this build's own person: its default. Made by someone else: on only when the profile's othersShared
// is on (and the feature's default is on), or the profile switches it on. No profile, or an id nobody knows: off.
// Plain values only, so tests/profile-test.swift checks it without the app.
enum Features {
  struct Entry: Equatable {
    let id: String
    let owner: String
    let shared: Bool
    let defaultOn: Bool
  }

  /// Registry entries from the build file's "features" (one file {schema, features}, a list of entries, or a list of files).
  /// Bad entries are left out; a repeated id keeps the first.
  static func registry(from any: Any?) -> [Entry] {
    var out: [Entry] = [], seen = Set<String>()
    func add(_ x: Any) {
      if let file = x as? [String: Any], let list = file["features"] as? [Any] {
        if (file["schema"] as? Int) == 1 { list.forEach(add) }
        return
      }
      if let list = x as? [Any] { list.forEach(add); return }
      guard let f = x as? [String: Any], let id = f["id"] as? String, Profile.isFeatureId(id),
            let owner = f["owner"] as? String, Profile.isName(owner),
            let scope = f["scope"] as? String, scope == "shared" || scope == "private",
            let def = f["default"] as? String, def == "on" || def == "off", !seen.contains(id) else { return }
      seen.insert(id)
      out.append(Entry(id: id, owner: owner, shared: scope == "shared", defaultOn: def == "on"))
    }
    if let any { add(any) }
    return out
  }

  /// The answer from the bundled registry and profile alone (before the page says anything).
  static func bundled(_ id: String, registry: [Entry], profile: Profile?) -> Bool {
    guard let e = registry.first(where: { $0.id == id }) else { return false }
    if e.owner == "core" || e.owner == profile?.name { return profile?.features[id] ?? e.defaultOn }
    guard e.shared, let p = profile else { return false }
    return p.features[id] ?? (p.othersShared && e.defaultOn)
  }

  /// The page's answer first, else the bundled one.
  static func decide(_ id: String, told: [String: Bool]?, registry: [Entry], profile: Profile?) -> Bool {
    if let v = told?[id] { return v }
    return bundled(id, registry: registry, profile: profile)
  }

  /// The page's answers from a message, only feature ids and real true or false, at most 200.
  static func clean(_ any: Any?) -> [String: Bool]? {
    guard let d = any as? [String: Any] else { return nil }
    var o: [String: Bool] = [:]
    for (k, v) in d where Profile.isFeatureId(k) && Profile.isBool(v) {
      if o.count >= 200 { break }
      if let b = v as? Bool { o[k] = b }
    }
    return o
  }

  // ---------- this app ----------
  private static let key = "features.on"
  /// Test copies never read or write the real settings.
  private static let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  private static var testTold: [String: Bool]?
  /// Main thread, after the page's answers changed.
  static var onChange: (() -> Void)?
  /// More listeners (PS 1.65), run after onChange: a part that only wants to hear a switch change adds one here and never
  /// takes the single onChange slot another part may already hold.
  static var observers: [() -> Void] = []

  static let bundledRegistry: [Entry] = {
    guard let url = Bundle.main.url(forResource: "ps-build", withExtension: "json"), let data = try? Data(contentsOf: url),
          let any = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
    return registry(from: any["features"])
  }()

  static var told: [String: Bool]? {
    if test { return testTold }
    guard let data = UserDefaults.standard.data(forKey: key), let any = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return clean(any)
  }

  /// Is this feature on here?
  static func on(_ id: String) -> Bool { decide(id, told: told, registry: bundledRegistry, profile: Profile.current) }

  /// From the page (main thread): {type: "features", on: {...}}. True when the message was this one.
  static func handle(_ type: String, _ msg: [String: Any]) -> Bool {
    guard type == "features" else { return false }
    guard let v = clean(msg["on"]) else { return true }
    if v == told { return true }
    if test { testTold = v }
    else if let data = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) { UserDefaults.standard.set(data, forKey: key) }
    psLog("PS features: \(v.filter { $0.value }.count) of \(v.count) on")
    onChange?()
    observers.forEach { $0() }
    return true
  }
}
