import CryptoKit
import Foundation
import Security

// Second Computer outsourcing, the sealing and the keys (the developer, 2 Nov 2026: "Yes, build it"; protocol v1.3, section 19
// in the lead's notes). Every outsourced job and every result is SEALED to the other Mac and SIGNED by the sender,
// on top of the vault's own encryption, so even the vault key alone cannot read a task or a report.
// - Sealing: HPKE with X-Wing (ML-KEM-768 + X25519, hybrid post-quantum), SHA-256, AES-256-GCM, from CryptoKit on
//   macOS 26 and later ("xwing"). A Mac on an older macOS publishes only a P-256 key, and then the suite is an
//   ephemeral P-256 ECDH with HKDF-SHA256 and AES-256-GCM ("p256"). Either way a fresh ephemeral key per message, so
//   each job has its own one-time key; the receiving keys are replaced every 7 days (the previous one is kept 2 days
//   for messages on their way). The header (who, when, nonce) is the AAD, so nothing in it can be swapped.
// - Signing: a P-256 key in the Secure Enclave (never leaves it, no prompt), else in the Keychain where there is no
//   Secure Enclave, and in a test copy a file in its test folder. Each Mac publishes its keys in its hello, which its
//   paired device key signs, so a new key (rotation, re-pairing) is trusted exactly as far as the pairing is.
// - Checks on receipt (SecondOutsource.accept): signed by the paired Mac's published job key, for this Mac, at most
//   10 minutes old, its id and nonce never seen before, opened with a key this Mac holds, an allowlisted job.
// Pure apart from the key store: the unit test (tests/second-outsource-test.swift) runs it without the app.

enum SecondSeal {
  static let info = Data("ps-second-outsource-v1".utf8)
  static var xwingHere: Bool { if #available(macOS 26, *) { return true }; return false }
  struct Failure: Error { var why: String }

  struct Sealed {
    var suite: String; var kid: String; var enc: Data; var ct: Data
    var json: [String: Any] { ["suite": suite, "kid": kid, "enc": enc.base64EncodedString(), "ct": ct.base64EncodedString()] }
    init(suite: String, kid: String, enc: Data, ct: Data) { self.suite = suite; self.kid = kid; self.enc = enc; self.ct = ct }
    init?(_ v: Any?) {
      guard let d = v as? [String: Any], let s = d["suite"] as? String, ["xwing", "p256"].contains(s), let k = d["kid"] as? String, k.count <= 32,
            let e = (d["enc"] as? String).flatMap({ Data(base64Encoded: $0) }), e.count <= 2048,
            let c = (d["ct"] as? String).flatMap({ Data(base64Encoded: $0) }), c.count <= 8 << 20 else { return nil }
      self.init(suite: s, kid: k, enc: e, ct: c)
    }
  }

  /// Seals for the other Mac's published keys: X-Wing when both Macs have it, else P-256.
  static func seal(_ pt: Data, aad: Data, to k: SecondKeys.Public, allowXWing: Bool = true) throws -> Sealed {
    if allowXWing, let xw = k.xwing, #available(macOS 26, *) {
      let pub = try XWingMLKEM768X25519.PublicKey(rawRepresentation: xw)
      var s = try HPKE.Sender(recipientKey: pub, ciphersuite: .XWingMLKEM768X25519_SHA256_AES_GCM_256, info: info)
      let ct = try s.seal(pt, authenticating: aad)
      return Sealed(suite: "xwing", kid: k.kid, enc: s.encapsulatedKey, ct: ct)
    }
    let rcpt = try P256.KeyAgreement.PublicKey(x963Representation: k.p256)
    let eph = P256.KeyAgreement.PrivateKey()
    let key = p256Key(try eph.sharedSecretFromKeyAgreement(with: rcpt), eph: eph.publicKey.x963Representation, rcpt: k.p256)
    guard let ct = try AES.GCM.seal(pt, using: key, authenticating: aad).combined else { throw Failure(why: "Could not seal") }
    return Sealed(suite: "p256", kid: k.kid, enc: eph.publicKey.x963Representation, ct: ct)
  }

  static func open(_ x: Sealed, aad: Data, with mine: SecondKeys.Private) throws -> Data {
    switch x.suite {
    case "xwing":
      guard #available(macOS 26, *), let raw = mine.xwing else { throw Failure(why: "This Mac cannot open X-Wing") }
      let k = try XWingMLKEM768X25519.PrivateKey(integrityCheckedRepresentation: raw)
      var r = try HPKE.Recipient(privateKey: k, ciphersuite: .XWingMLKEM768X25519_SHA256_AES_GCM_256, info: info, encapsulatedKey: x.enc)
      return try r.open(x.ct, authenticating: aad)
    case "p256":
      let k = try P256.KeyAgreement.PrivateKey(rawRepresentation: mine.p256)
      let e = try P256.KeyAgreement.PublicKey(x963Representation: x.enc)
      let key = p256Key(try k.sharedSecretFromKeyAgreement(with: e), eph: x.enc, rcpt: k.publicKey.x963Representation)
      return try AES.GCM.open(AES.GCM.SealedBox(combined: x.ct), using: key, authenticating: aad)
    default: throw Failure(why: "Unknown suite")
    }
  }

  static func p256Key(_ s: SharedSecret, eph: Data, rcpt: Data) -> SymmetricKey {
    s.hkdfDerivedSymmetricKey(using: SHA256.self, salt: eph + rcpt, sharedInfo: info, outputByteCount: 32)
  }

  /// "xwing" reads "X-Wing (ML-KEM-768 + X25519, post-quantum)" for the developer.
  static func words(_ suite: String) -> String {
    suite == "xwing" ? "X-Wing (ML-KEM-768 + X25519, post-quantum)" : suite == "p256" ? "P-256 ECDH + AES-256-GCM (not post-quantum)" : suite
  }
}

/// This Mac's outsourcing keys (receiving keys and the job signing key) and the other Macs' published ones.
final class SecondKeys {
  struct Public: Equatable {
    var kid: String; var xwing: Data?; var p256: Data; var sign: Data; var store: String
    var json: [String: Any] {
      var d: [String: Any] = ["kid": kid, "p256": p256.base64EncodedString(), "sign": sign.base64EncodedString(), "store": store]
      if let xwing { d["xwing"] = xwing.base64EncodedString() }
      return d
    }
    init(kid: String, xwing: Data?, p256: Data, sign: Data, store: String) { self.kid = kid; self.xwing = xwing; self.p256 = p256; self.sign = sign; self.store = store }
    init?(_ v: Any?) {
      guard let d = v as? [String: Any], let k = d["kid"] as? String, k.count <= 32,
            let p = (d["p256"] as? String).flatMap({ Data(base64Encoded: $0) }), p.count == 65,
            let s = (d["sign"] as? String).flatMap({ Data(base64Encoded: $0) }), s.count == 65 else { return nil }
      let x = (d["xwing"] as? String).flatMap { Data(base64Encoded: $0) }
      if let x, x.count != 1216 { return nil }
      self.init(kid: k, xwing: x, p256: p, sign: s, store: (d["store"] as? String).map { String($0.prefix(20)) } ?? "?")
    }
  }
  struct Private { var kid: String; var xwing: Data?; var p256: Data; var at: Double
    var json: [String: Any] { var d: [String: Any] = ["kid": kid, "p256": p256.base64EncodedString(), "at": at]; if let xwing { d["xwing"] = xwing.base64EncodedString() }; return d }
    init(kid: String, xwing: Data?, p256: Data, at: Double) { self.kid = kid; self.xwing = xwing; self.p256 = p256; self.at = at }
    init?(_ v: Any?) {
      guard let d = v as? [String: Any], let k = d["kid"] as? String, let p = (d["p256"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return nil }
      self.init(kid: k, xwing: (d["xwing"] as? String).flatMap { Data(base64Encoded: $0) }, p256: p, at: (d["at"] as? NSNumber)?.doubleValue ?? 0)
    }
  }

  static let rotateAfter: Double = 7 * 86_400_000, keepPrev: Double = 2 * 86_400_000
  private let lock = NSLock()
  private let store: SecondStore
  private var cur: Private?, prev: Private?
  private var seKey: SecureEnclave.P256.Signing.PrivateKey?
  private var softKey: P256.Signing.PrivateKey?
  private(set) var signStore = "none"
  /// Its items exist but could not be read: no new keys are made (SecondIdentity.blocked says why).
  private(set) var blocked = false
  private var peers: [String: Public] = [:]
  var now: () -> Date = { Date() }
  /// Unit tests: no X-Wing key even where the Mac could make one (the P-256 fallback).
  var noXWing = false

  /// Off the main thread (the Keychain and the Secure Enclave may take a moment). `secure`: use the Secure Enclave
  /// when there is one (never in a test copy, whose keys stay in its folder).
  init(store: SecondStore, secure: Bool, noXWing: Bool = false) {
    self.store = store; self.noXWing = noXWing
    // A key that exists but cannot be read now (a Keychain Deny, a locked Mac) is never replaced: outsourcing waits.
    for a in ["okeys", "osign", "opeers"] {
      let st = store.readStatus(a).1
      if st != errSecSuccess && st != errSecItemNotFound { blocked = true; return }
    }
    if let d = store.read("okeys"), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
      cur = Private(j["cur"]); prev = Private(j["prev"])
    }
    if let d = store.read("osign"), let j = try? JSONSerialization.jsonObject(with: d) as? [String: String] {
      if let h = j["se"].flatMap({ Data(base64Encoded: $0) }), let k = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: h) { seKey = k; signStore = "secure enclave" }
      else if let r = j["soft"].flatMap({ Data(base64Encoded: $0) }), let k = try? P256.Signing.PrivateKey(rawRepresentation: r) { softKey = k; signStore = secure ? "keychain" : "test" }
    }
    if seKey == nil && softKey == nil {
      if secure && SecureEnclave.isAvailable, let k = try? SecureEnclave.P256.Signing.PrivateKey() {
        if store.write("osign", (try? JSONSerialization.data(withJSONObject: ["se": k.dataRepresentation.base64EncodedString()])) ?? Data()) { seKey = k; signStore = "secure enclave" }
      } else {
        let k = P256.Signing.PrivateKey()
        if store.write("osign", (try? JSONSerialization.data(withJSONObject: ["soft": k.rawRepresentation.base64EncodedString()])) ?? Data()) { softKey = k; signStore = secure ? "keychain" : "test" }
      }
    }
    if let d = store.read("opeers"), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
      for (dev, v) in j { if let p = Public(v) { peers[dev] = p } }
    }
    rotateIfDue()
  }

  var ready: Bool { lock.lock(); defer { lock.unlock() }; return cur != nil && (seKey != nil || softKey != nil) }

  /// Makes new receiving keys when there are none or they are a week old (the old ones open late messages 2 days).
  @discardableResult
  func rotateIfDue(force: Bool = false) -> Bool {
    let t = now().timeIntervalSince1970 * 1000
    lock.lock()
    let due = force || cur == nil || t - (cur?.at ?? 0) > SecondKeys.rotateAfter
    if !due { if let p = prev, t - p.at > SecondKeys.rotateAfter + SecondKeys.keepPrev { prev = nil }; lock.unlock(); return false }
    var xw: Data?, xwPub = Data()
    if !noXWing, #available(macOS 26, *), let k = try? XWingMLKEM768X25519.PrivateKey.generate() { xw = k.integrityCheckedRepresentation; xwPub = k.publicKey.rawRepresentation }
    let p = P256.KeyAgreement.PrivateKey()
    let kid = SHA256.hash(data: xwPub + p.publicKey.x963Representation).prefix(8).map { String(format: "%02x", $0) }.joined()
    prev = cur
    cur = Private(kid: kid, xwing: xw, p256: p.rawRepresentation, at: t)
    let all: [String: Any] = ["cur": cur!.json, "prev": prev?.json ?? NSNull()]
    lock.unlock()
    if let d = try? JSONSerialization.data(withJSONObject: all) { _ = store.write("okeys", d) }
    return true
  }

  /// What this Mac publishes in its hello (signed there by its paired device key).
  var pub: Public? {
    lock.lock(); defer { lock.unlock() }
    guard let c = cur, let sign = seKey?.publicKey.x963Representation ?? softKey?.publicKey.x963Representation,
          let p = try? P256.KeyAgreement.PrivateKey(rawRepresentation: c.p256) else { return nil }
    var xw: Data?
    if let raw = c.xwing, #available(macOS 26, *) { xw = (try? XWingMLKEM768X25519.PrivateKey(integrityCheckedRepresentation: raw))?.publicKey.rawRepresentation }
    return Public(kid: c.kid, xwing: xw, p256: p.publicKey.x963Representation, sign: sign, store: signStore)
  }

  func privateFor(_ kid: String) -> Private? {
    lock.lock(); defer { lock.unlock() }
    if cur?.kid == kid { return cur }
    if let p = prev, p.kid == kid, now().timeIntervalSince1970 * 1000 - p.at < SecondKeys.rotateAfter + SecondKeys.keepPrev { return p }
    return nil
  }

  /// A raw P-256 signature over `data` with the job signing key.
  func sign(_ data: Data) -> Data? {
    lock.lock(); let se = seKey, soft = softKey; lock.unlock()
    if let se { return try? se.signature(for: data).rawRepresentation }
    return try? soft?.signature(for: data).rawRepresentation
  }
  static func verify(_ sig: Data, _ data: Data, key: Data) -> Bool {
    guard let k = try? P256.Signing.PublicKey(x963Representation: key), let s = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else { return false }
    return k.isValidSignature(s, for: data)
  }

  func peer(_ device: String) -> Public? { lock.lock(); defer { lock.unlock() }; return peers[device] }
  /// The other Mac's keys from its hello, AFTER the caller checked that hello against the paired device key.
  func setPeer(_ device: String, _ p: Public?) {
    lock.lock()
    if peers[device] == p { lock.unlock(); return }
    peers[device] = p
    var j: [String: Any] = [:]
    for (k, v) in peers { j[k] = v.json }
    lock.unlock()
    if let d = try? JSONSerialization.data(withJSONObject: j) { _ = store.write("opeers", d) }
  }
}
