import CryptoKit
import Foundation
import Security

// Second Computer: who may start work on this Mac (protocol v1, sections 1 to 3). Each Mac has its own
// P-256 signing key and a random device id, kept only in this Mac's Keychain (this device only, never
// synced, never in the vault or the page). The trust store (the other Macs the developer paired by clicking a
// native alert) is in the Keychain too. Every envelope from the vault is checked here: signed by a
// trusted device, from that device, to this one, version 1, not from the future, not too old, never
// seen before (the seen set is kept 30 days). Keychain calls are never made on the main thread.
// Test copies keep the key, trust and seen set in files in their test folder, never the Keychain.

struct SecondEnv { var body: String; var sig: String; var by: String
  var json: [String: Any] { ["body": body, "sig": sig, "by": by] }
  init(body: String, sig: String, by: String) { self.body = body; self.sig = sig; self.by = by }
  init?(_ d: Any?) {
    guard let d = d as? [String: Any], let b = d["body"] as? String, let s = d["sig"] as? String, let y = d["by"] as? String,
          b.utf8.count <= 256 * 1024, s.count <= 200, !y.isEmpty, y.count <= 64 else { return nil }
    self.init(body: b, sig: s, by: y)
  }
}

struct SecondPeer: Equatable { var device: String; var name: String; var pub: String; var role: String; var at: Double
  var json: [String: Any] { ["device": device, "name": name, "pub": pub, "role": role, "at": at] }
}

/// Where the key, trust and seen set live: the Keychain (live) or a test folder.
protocol SecondStore: AnyObject {
  func read(_ account: String) -> Data?
  func write(_ account: String, _ data: Data) -> Bool
  /// The item and the Keychain's status. errSecItemNotFound ONLY when it was never there: any other failure (a
  /// Deny, the Mac locked, no permission yet for a new build) must never be taken for "never paired".
  func readStatus(_ account: String) -> (Data?, OSStatus)
}
extension SecondStore {
  func readStatus(_ account: String) -> (Data?, OSStatus) { let d = read(account); return (d, d == nil ? errSecItemNotFound : errSecSuccess) }
}

/// The raw Second Computer items in the login Keychain (service com.cincee.ps.second, one item per account), or a
/// fake in the unit test. `get(ask: false)` and the writes never let macOS ask; `get(ask: true)` only after the developer's Allow.
protocol SecondRaw: AnyObject {
  func get(_ account: String, ask: Bool) -> (Data?, OSStatus)
  /// Changes the item in place, or adds it. Never asks.
  func put(_ account: String, _ data: Data) -> Bool
  /// Deletes the item and adds it again as THIS build's own (so the next launch reads it without a question). Never asks.
  func replace(_ account: String, _ data: Data) -> Bool
}

final class SecondKeychainRaw: SecondRaw {
  private func base(_ a: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SecondKeychain.service, kSecAttrAccount as String: a] }
  private func adding(_ a: String, _ d: Data) -> [String: Any] {
    var q = base(a)
    q[kSecValueData as String] = d
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    q[kSecAttrSynchronizable as String] = false
    q[kSecAttrLabel as String] = "PS Second Computer (this Mac only)"
    return q
  }
  func get(_ account: String, ask: Bool) -> (Data?, OSStatus) {
    var q = base(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = ask ? KeychainQuiet.asking { SecItemCopyMatching(KeychainQuiet.allowing(q) as CFDictionary, &out) }
                 : KeychainQuiet.run { SecItemCopyMatching(KeychainQuiet.never(q) as CFDictionary, &out) }
    return (st == errSecSuccess ? out as? Data : nil, st)
  }
  func put(_ account: String, _ data: Data) -> Bool {
    KeychainQuiet.run {
      if SecItemUpdate(KeychainQuiet.never(base(account)) as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess { return true }
      return SecItemAdd(adding(account, data) as CFDictionary, nil) == errSecSuccess
    }
  }
  func replace(_ account: String, _ data: Data) -> Bool {
    KeychainQuiet.run {
      SecItemDelete(base(account) as CFDictionary)
      return SecItemAdd(adding(account, data) as CFDictionary, nil) == errSecSuccess
    }
  }
}

/// Second Computer's secrets in the Keychain (V1.44). The developer only: on anyone else's PS nothing here reads, writes,
/// deletes or hands over a single item (`gate`, which fails closed), so no Keychain question can come from Second
/// Computer there, at launch, at an update or ever.
/// On the developer's PS the six secrets live in ONE item ("all"), read once when Second Computer loads and kept in memory, so
/// a build that must ask (an update whose hand over failed) asks ONCE after the developer's Allow, not once per item. Builds
/// before V1.44 kept one item per secret: those are read when "all" does not exist yet (once), and every write still
/// updates them too, quietly, so a roll back to such a build stays paired.
final class SecondKeychain: SecondStore {
  static let service = "com.cincee.ps.second"
  /// Every item Second Computer keeps (device key and id, pairing list, outsourcing keys): what an update hands over.
  static let accounts = ["key", "device", "trust", "okeys", "osign", "opeers"]
  /// The one item that holds them all (V1.44).
  static let bundle = "all"
  /// Who may touch these items at all: main.swift sets it to Owner.red (the developer's own account on his own project) before
  /// anything else runs. Until then, and on everyone else's PS, nothing is touched.
  static var gate: () -> Bool = { false }
  static var mayTouch: Bool { gate() }
  /// What a refused read says (never reached in practice: Second Computer itself starts only on the developer's PS).
  static let notHere = errSecNotAvailable

  /// False (the default): a read never shows the Keychain's question; it fails instead (errSecInteractionNotAllowed),
  /// so PS never asks at launch or while the Mac is locked. True only after the developer's own click on Allow.
  var allowUI = false
  private let raw: SecondRaw
  private let lock = NSLock()
  private var loaded = false
  private var cache: [String: Data] = [:]
  private var status: [String: OSStatus] = [:]
  /// Where the read came from: "all" (V1.44), "items" (an older build's one by one), "off" (not the developer's PS).
  private(set) var source = ""
  /// The read happened after the developer's Allow: reownAllowed saves it back as this build's own.
  private var wasAllowed = false

  init(raw: SecondRaw = SecondKeychainRaw()) { self.raw = raw }

  /// The single read (under lock). An item that exists but cannot be read is never taken for "not there".
  private func load() {
    guard !loaded else { return }
    loaded = true
    guard SecondKeychain.mayTouch else { source = "off"; for a in SecondKeychain.accounts { status[a] = SecondKeychain.notHere }; return }
    let (b, bs) = raw.get(SecondKeychain.bundle, ask: allowUI)
    if bs == errSecSuccess {
      source = SecondKeychain.bundle
      guard let b, let all = SecondKeychain.decode(b) else { for a in SecondKeychain.accounts { status[a] = errSecDecode }; return }
      for a in SecondKeychain.accounts { if let d = all[a] { cache[a] = d; status[a] = errSecSuccess } else { status[a] = errSecItemNotFound } }
      wasAllowed = allowUI
      return
    }
    if bs != errSecItemNotFound { source = SecondKeychain.bundle; for a in SecondKeychain.accounts { status[a] = bs }; return }   // there, not readable yet: one Allow
    // No "all" yet: a build before V1.44 kept them one by one.
    source = "items"
    for a in SecondKeychain.accounts {
      let (d, st) = raw.get(a, ask: allowUI)
      status[a] = st
      if st == errSecSuccess, let d { cache[a] = d }
    }
    if allowUI { wasAllowed = !cache.isEmpty; return }   // reownAllowed saves them as "all"
    // Every one read without a question: from now on they live in one item (saved quietly, never asking).
    if !cache.isEmpty && !blockedLocked { _ = raw.put(SecondKeychain.bundle, SecondKeychain.encode(cache)) }
  }
  private var blockedLocked: Bool { status.values.contains { $0 != errSecSuccess && $0 != errSecItemNotFound } }

  func read(_ account: String) -> Data? { readStatus(account).0 }
  func readStatus(_ account: String) -> (Data?, OSStatus) {
    lock.lock(); defer { lock.unlock() }
    load()
    return (cache[account], status[account] ?? errSecItemNotFound)
  }

  /// After the developer's Allow: what was read is saved again as THIS build's own (deleted and added, never asking), so the next
  /// launch reads it quietly and the next update can hand it over. Returns (saved, tried).
  func reownAllowed() -> (Int, Int) {
    lock.lock(); defer { lock.unlock() }
    guard wasAllowed, SecondKeychain.mayTouch else { return (0, 0) }
    wasAllowed = false
    let n = cache.count
    let one = SecondKeychain.encode(cache)
    // Deleted but not added (should never happen): the same bytes are written once more.
    guard raw.replace(SecondKeychain.bundle, one) || raw.put(SecondKeychain.bundle, one) else { return (0, n) }
    for (a, d) in cache { _ = raw.replace(a, d) || raw.put(a, d) }   // a roll back to a build before V1.44 stays paired
    return (n, n)
  }

  /// The hand over at an update (UpdateHandoff): the previous build's items, saved as THIS build's own, never asking.
  /// Returns how many were saved (0 if the one item could not be written).
  func takeOver(_ items: [String: Data]) -> Int {
    lock.lock(); defer { lock.unlock() }
    guard SecondKeychain.mayTouch, !items.isEmpty else { return 0 }
    let one = SecondKeychain.encode(items)
    guard raw.replace(SecondKeychain.bundle, one) || raw.put(SecondKeychain.bundle, one) else { return 0 }
    for (a, d) in items { _ = raw.replace(a, d) }
    loaded = true; source = SecondKeychain.bundle; cache = items; status = [:]
    for a in SecondKeychain.accounts { status[a] = items[a] == nil ? errSecItemNotFound : errSecSuccess }
    return items.count
  }

  func write(_ account: String, _ data: Data) -> Bool {
    lock.lock(); defer { lock.unlock() }
    load()
    // Never written over what could not be read (a Deny, a locked Mac, a build not allowed yet).
    guard SecondKeychain.mayTouch, !blockedLocked else { return false }
    var next = cache; next[account] = data
    guard raw.put(SecondKeychain.bundle, SecondKeychain.encode(next)) else { return false }
    cache = next; status[account] = errSecSuccess
    _ = raw.put(account, data)   // the one by one item too, quietly, for a roll back to a build before V1.44
    return true
  }

  static func encode(_ items: [String: Data]) -> Data {
    let o = items.filter { accounts.contains($0.key) }.mapValues { $0.base64EncodedString() }
    return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)
  }
  static func decode(_ d: Data) -> [String: Data]? {
    guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return nil }
    var out: [String: Data] = [:]
    for (k, v) in o where accounts.contains(k) { guard let x = Data(base64Encoded: v) else { return nil }; out[k] = x }
    return out
  }
}

final class SecondFileStore: SecondStore {
  let dir: String
  /// Tests: reads of items that exist fail with this status (a Deny, a locked Mac), as the Keychain's would.
  var failing: OSStatus?
  init(dir: String) { self.dir = dir; try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
  func read(_ account: String) -> Data? { readStatus(account).0 }
  func readStatus(_ account: String) -> (Data?, OSStatus) {
    guard let d = FileManager.default.contents(atPath: dir + "/" + account) else { return (nil, errSecItemNotFound) }
    if let f = failing { return (nil, f) }
    return (d, errSecSuccess)
  }
  func write(_ account: String, _ data: Data) -> Bool { (try? data.write(to: URL(fileURLWithPath: dir + "/" + account), options: .atomic)) != nil }
}

final class SecondIdentity {
  private let lock = NSLock()
  private let store: SecondStore
  private let seenPath: String
  private(set) var device = ""
  /// Set when the key, id or pairing list exist but could not be read (a Keychain Deny, the Mac locked, a new build
  /// not allowed yet). Second Computer then stays off and asks the developer to Allow; it NEVER makes a new key or drops pairing.
  private(set) var blocked: OSStatus?
  private var key: P256.Signing.PrivateKey?
  private var trusted: [SecondPeer] = []
  private var seen: [String: Double] = [:]
  var now: () -> Date = { Date() }

  /// Call off the main thread (the Keychain may take a moment).
  init(store: SecondStore, seenPath: String) {
    self.store = store; self.seenPath = seenPath
    let (kd, ks) = store.readStatus("key"), (dd, ds) = store.readStatus("device"), (td, ts) = store.readStatus("trust")
    for st in [ks, ds, ts] where st != errSecSuccess && st != errSecItemNotFound { blocked = st; break }
    if blocked == nil && ((ks == errSecSuccess) != (ds == errSecSuccess)) { blocked = errSecDecode }   // half there: never replaced
    if blocked != nil { return }
    if let d = kd, let k = try? P256.Signing.PrivateKey(rawRepresentation: d), let i = dd.flatMap({ String(data: $0, encoding: .utf8) }), !i.isEmpty {
      key = k; device = i
    } else if ks == errSecItemNotFound && ds == errSecItemNotFound {
      // Truly the first time on this Mac: a new key and id.
      let k = P256.Signing.PrivateKey(), i = UUID().uuidString.lowercased()
      if store.write("key", k.rawRepresentation) && store.write("device", Data(i.utf8)) { key = k; device = i }
    } else { blocked = errSecDecode; return }
    if let d = td, let a = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
      trusted = a.compactMap { p in
        guard let dv = p["device"] as? String, let pub = p["pub"] as? String else { return nil }
        return SecondPeer(device: dv, name: p["name"] as? String ?? "Mac", pub: pub, role: p["role"] as? String ?? "", at: p["at"] as? Double ?? 0)
      }
    }
    if let d = FileManager.default.contents(atPath: seenPath), let s = try? JSONSerialization.jsonObject(with: d) as? [String: Double] { seen = s }
  }

  var ready: Bool { lock.lock(); defer { lock.unlock() }; return key != nil }
  var pub: String { lock.lock(); defer { lock.unlock() }; return key?.publicKey.x963Representation.base64EncodedString() ?? "" }
  var peers: [SecondPeer] { lock.lock(); defer { lock.unlock() }; return trusted }
  func peer(_ device: String) -> SecondPeer? { peers.first { $0.device == device } }

  func trust(_ p: SecondPeer) {
    lock.lock(); trusted.removeAll { $0.device == p.device }; trusted.append(p); let all = trusted; lock.unlock()
    saveTrust(all)
  }
  func untrust(_ device: String) {
    lock.lock(); trusted.removeAll { $0.device == device }; let all = trusted; lock.unlock()
    saveTrust(all)
  }
  private func saveTrust(_ all: [SecondPeer]) {
    if let d = try? JSONSerialization.data(withJSONObject: all.map { $0.json }) { _ = store.write("trust", d) }
  }

  /// Signs a body (JSON text exactly as it will be sent).
  func sign(_ body: [String: Any]) -> SecondEnv? {
    lock.lock(); let k = key; lock.unlock()
    guard let k, let d = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
          let text = String(data: d, encoding: .utf8), let sig = try? k.signature(for: d) else { return nil }
    return SecondEnv(body: text, sig: sig.rawRepresentation.base64EncodedString(), by: device)
  }

  static func verify(_ env: SecondEnv, pub: String) -> Bool {
    guard let kd = Data(base64Encoded: pub), let k = try? P256.Signing.PublicKey(x963Representation: kd),
          let sd = Data(base64Encoded: env.sig), let s = try? P256.Signing.ECDSASignature(rawRepresentation: sd) else { return false }
    return k.isValidSignature(s, for: Data(env.body.utf8))
  }

  /// The six digit pairing code both Macs show (protocol section 2), as "123 456".
  static func pairCode(primaryPub: String, secondaryPub: String) -> String {
    let h = Array(SHA256.hash(data: Data("ps-second-pair-v1\n\(primaryPub)\n\(secondaryPub)".utf8)))
    let n = (UInt32(h[0]) << 24) | (UInt32(h[1]) << 16) | (UInt32(h[2]) << 8) | UInt32(h[3])
    let s = String(format: "%06u", n % 1_000_000)
    return String(s.prefix(3)) + " " + String(s.suffix(3))
  }

  /// A machine command's own rules after open() (core/second.ts acceptCmd): the signer a trusted primary or phone,
  /// a known action, a life of 2 minutes at most and not over, no other keys. nil: it may run.
  /// The machine commands there are: restart, shut down, lock, cancel, postpone (V1.28), and set:<mode>:<minutes>
  /// (V1.28, the developer: his main Mac chooses this Mac's auto reboot, mode off, watch or active, 10 minutes to 72 hours).
  static func cmdAction(_ a: String) -> Bool {
    if ["restart", "shutdown", "lock", "cancel", "postpone"].contains(a) { return true }
    return autoRebootSet(a) != nil
  }
  /// "set:active:1080" as (mode, minutes), or nil for anything else (10 to 4320, no leading zero).
  static func autoRebootSet(_ a: String) -> (mode: String, minutes: Int)? {
    let p = a.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard p.count == 3, p[0] == "set", ["off", "watch", "active"].contains(p[1]), p[2].count <= 4, p[2].allSatisfy({ $0.isASCII && $0.isNumber }),
          !p[2].hasPrefix("0"), let n = Int(p[2]), (10...4320).contains(n) else { return nil }
    return (p[1], n)
  }

  static func checkCmd(_ b: [String: Any], signerRole: String?, now: Date = Date()) -> String? {
    guard signerRole == "primary" || signerRole == "phone" else { return "Not signed by your primary" }
    guard let a = b["action"] as? String, cmdAction(a) else { return "Unknown command" }
    // Only the main Mac chooses this Mac's auto reboot; the phone may restart, shut down, lock and postpone.
    if autoRebootSet(a) != nil && signerRole != "primary" { return "Not signed by your primary" }
    let nowMs = now.timeIntervalSince1970 * 1000
    guard let exp = (b["exp"] as? NSNumber)?.doubleValue, let at = (b["at"] as? NSNumber)?.doubleValue, exp >= nowMs, exp - at <= 121_000 else { return "Too old" }
    guard Set(b.keys).isSubset(of: ["v", "t", "id", "from", "to", "at", "exp", "action"]) else { return "Bad arguments" }
    return nil
  }

  /// The checks on receipt (protocol section 3). `pub` given: check against that key (a pair body,
  /// before it is trusted). Returns the parsed body, or the plain reason it was refused.
  func open(_ env: SecondEnv, expect types: Set<String>, pub given: String? = nil, remember: Bool = true) -> Result<[String: Any], SecondRefusal> {
    func no(_ w: String) -> Result<[String: Any], SecondRefusal> { .failure(SecondRefusal(why: w)) }
    let signer = given == nil ? peer(env.by) : nil
    let pub = given ?? signer?.pub
    guard let pub else { return no("Not signed by your primary") }
    guard SecondIdentity.verify(env, pub: pub) else { return no("Not signed by your primary") }
    guard let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any] else { return no("Bad arguments") }
    guard (b["v"] as? NSNumber)?.intValue == 1, let t = b["t"] as? String, types.contains(t) else { return no("Unknown job type") }
    // A phone key may only restart, shut down or lock (protocol section 13): never a job, a file, a request or a pairing.
    if signer?.role == "phone" && t != "cmd" { return no("Not signed by your primary") }
    guard b["from"] as? String == env.by else { return no("Not signed by your primary") }
    let to = b["to"] as? String
    guard to == device || (to == "all" && t != "job") else { return no("Not for this Mac") }
    guard let at = (b["at"] as? NSNumber)?.doubleValue, let id = b["id"] as? String, !id.isEmpty, id.count <= 64 else { return no("Bad arguments") }
    let nowMs = now().timeIntervalSince1970 * 1000
    if at > nowMs + 5 * 60_000 { return no("Too old") }
    // Hours: jobs 24, files 48, machine commands 2 minutes; the rest 30 days (the seen set's memory).
    let maxAge: Double = t == "file" ? 48 : t == "job" ? 24 : t == "cmd" ? 2.0 / 60 : 24 * 30
    if at < nowMs - maxAge * 3_600_000 { return no("Too old") }
    if t == "job", let exp = (b["exp"] as? NSNumber)?.doubleValue, exp < nowMs { return no("Too old") }
    if remember {
      lock.lock()
      if seen[t + ":" + id] != nil { lock.unlock(); return no("Seen before") }
      seen[t + ":" + id] = nowMs
      let cut = nowMs - 30 * 86_400_000
      seen = seen.filter { $0.value > cut }
      let copy = seen
      lock.unlock()
      if let d = try? JSONSerialization.data(withJSONObject: copy) { try? d.write(to: URL(fileURLWithPath: seenPath), options: .atomic) }
    }
    return .success(b)
  }

  /// Remembers `key` (a sealed job's id or nonce, protocol v1.3) and says whether it was new. Kept 30 days, as above.
  func once(_ key: String) -> Bool {
    let nowMs = now().timeIntervalSince1970 * 1000
    lock.lock()
    if seen[key] != nil { lock.unlock(); return false }
    seen[key] = nowMs
    let cut = nowMs - 30 * 86_400_000
    seen = seen.filter { $0.value > cut }
    let copy = seen
    lock.unlock()
    if let d = try? JSONSerialization.data(withJSONObject: copy) { try? d.write(to: URL(fileURLWithPath: seenPath), options: .atomic) }
    return true
  }
}


/// Second Computer's Keychain items across an app update (UpdateHandoff.swift). PS is signed without an Apple team, so
/// macOS ties each item to the build that made it and a new build may read it only after the developer answers a Keychain
/// question; with the Mac locked or asleep at the swap the read failed and PS came up unpaired (the M1, 2 Nov 2026,
/// 03:44). So the OLD build, which reads its own items, hands them to the new one with the sign in, and the new build
/// saves them as its own: no question, no new key, no re-pairing.
enum SecondHandoff {
  /// The old build: every item it has (base64), read without ever asking.
  static func collect(_ store: SecondStore) -> [String: String] {
    var out: [String: String] = [:]
    for a in SecondKeychain.accounts { if case (let d?, errSecSuccess) = store.readStatus(a) { out[a] = d.base64EncodedString() } }
    return out
  }
  /// The new build: the items as its own. Only known accounts, only sane sizes. Returns how many were saved.
  @discardableResult
  static func save(_ items: [String: String], into store: SecondStore) -> Int {
    var good: [String: Data] = [:]
    for a in SecondKeychain.accounts {
      guard let d = items[a].flatMap({ Data(base64Encoded: $0) }), !d.isEmpty, d.count <= 256 * 1024 else { continue }
      good[a] = d
    }
    if let k = store as? SecondKeychain { return k.takeOver(good) }   // one item, as this build's own
    var n = 0
    for (a, d) in good where store.write(a, d) { n += 1 }
    return n
  }
}
