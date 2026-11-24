// The Task API, the part that runs on the Mac (rules: TaskApiCore.swift; endpoints and the vault work: web
// core/taskapi.ts and src/taskapi.ts; Settings: views/TaskApi.tsx). For everyone, the public PS too. Off until switched
// on in Settings, AI task API.
// - Listens on 127.0.0.1 port 47836 only (a loopback socket: no other computer can reach it, and nothing goes out to
//   the internet, so the VPN rules are untouched), only while it is on and PS runs. A self test copy never listens.
// - Each connection: one request read on its own queue (5 s at most), checked by TaskApiCore (browser, Host, key, rate),
//   then handed to the main page with this Mac's switches ({type:"api:req"}). The page answers {type:"api:res"}; the
//   answer goes back and the connection closes. No answer in 15 s (40 s for starting Sentry mode): 503.
// - The key: made with the system's secure random source, kept in this Mac's Keychain only (this build's item, handed to
//   the next build on an update, UpdateHandoff.swift), never logged, never in a page except for 30 seconds after Show.
//   Copy and Copy for AI put it on the clipboard from here, marked as concealed for clipboard managers.
// - On or off and the switches are this Mac's own (UserDefaults), like the key.
// Keychain and socket work never runs on the main thread. A log line per request: method, path, status, time. No text.
import AppKit
import Foundation
import Security

/// This build's Keychain item for the key (named after the build like the sign in; the update hands it over).
enum TaskApiKeychain {
  static let service = "com.cincee.ps.taskapi"
  static var account: String { "key-\(Remember.account)" }
  private static var base: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] }
  static func read() -> String? {
    var q = base; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard KeychainQuiet.run({ SecItemCopyMatching(q as CFDictionary, &out) }) == errSecSuccess, let d = out as? Data,
          let s = String(data: d, encoding: .utf8), TaskApiCore.validKey(s) else { return nil }
    return s
  }
  @discardableResult static func write(_ key: String) -> Bool {
    guard TaskApiCore.validKey(key) else { return false }
    let d = Data(key.utf8)
    if KeychainQuiet.run({ SecItemUpdate(base as CFDictionary, [kSecValueData as String: d] as CFDictionary) }) == errSecSuccess { return true }
    var q = base
    q[kSecValueData as String] = d
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    q[kSecAttrSynchronizable as String] = false
    q[kSecAttrLabel as String] = "PS AI task API key (this Mac only)"
    return KeychainQuiet.run { SecItemAdd(q as CFDictionary, nil) } == errSecSuccess
  }
}

final class TaskApi {
  static let shared = TaskApi()
  weak var app: App?

  private let test = IS_TEST_COPY
  private let port = TaskApiCore.port
  private let q = DispatchQueue(label: "ps.taskapi", qos: .utility)                       // the key, the listener
  private let connQ = DispatchQueue(label: "ps.taskapi.conn", qos: .utility, attributes: .concurrent)
  private let mu = NSLock()            // key, limiter, active (read from the connection queue)
  private var key: String?
  private var limiter = TaskApiCore.RateLimit()
  private var active = 0
  // q only.
  private var loaded = false
  private var listenFd: Int32 = -1
  private var source: DispatchSourceRead?
  // Main thread.
  private(set) var on = false
  private var scopes = TaskApiCore.scopeDefaults
  private var running = false
  private var error: String?
  private var keyTail: String?
  private var last: [String: Any]?
  private var count = 0
  private var pending: [String: (fd: Int32, t0: Date, what: String)] = [:]
  private var settingsSoon = false

  private static let onKey = "taskApi.on", scopesKey = "taskApi.scopes"

  func start() {
    let d = UserDefaults.standard
    scopes = TaskApiCore.cleanScopes((d.data(forKey: Self.scopesKey)).flatMap { try? JSONSerialization.jsonObject(with: $0) })
    on = d.bool(forKey: Self.onKey)
    if on { switchOn() }
  }

  /// A page message starting with "api:". True when it was one of ours.
  func handle(_ type: String, _ msg: [String: Any], fromMain: Bool, fromOverlay: Bool) -> Bool {
    guard type.hasPrefix("api:") else { return false }
    switch type {
    case "api:res" where fromMain: answer(msg)
    case "api:set" where fromMain || fromOverlay:
      if let s = msg["scopes"] { scopes = TaskApiCore.cleanScopes(s); saveScopes() }
      if let o = msg["on"] as? Bool, o != on {
        on = o
        UserDefaults.standard.set(o, forKey: Self.onKey)
        psLog("PS task api: switched \(o ? "on" : "off")")
        if o { switchOn() } else { switchOff() }
      }
      app?.sendSettings()
    case "api:regen" where fromMain || fromOverlay: regen()
    case "api:copyKey" where fromMain || fromOverlay: withKey { [weak self] k in self?.copy(k); psLog("PS task api: key copied") }
    case "api:show" where fromOverlay:
      withKey { [weak self] k in self?.tellOverlay(["type": "api:key", "key": k]) }
    case "api:copyGuide" where fromMain || fromOverlay:
      guard let text = msg["text"] as? String else { break }
      withKey { [weak self] k in
        guard let full = TaskApiCore.fillGuide(text, key: k) else { NSSound.beep(); return }
        self?.copy(full); psLog("PS task api: instructions for an AI copied")
      }
    default: break
    }
    return true
  }

  /// Settings, AI task API (main.swift sendSettings): never the key, only its last 4 characters.
  func settingsJSON() -> [String: Any] {
    ["on": on, "running": running, "port": Int(port), "error": error ?? NSNull(), "scopes": scopes, "keyTail": keyTail ?? NSNull(), "last": last ?? NSNull(), "count": count]
  }

  // MARK: on and off
  private func saveScopes() {
    if let d = try? JSONSerialization.data(withJSONObject: scopes) { UserDefaults.standard.set(d, forKey: Self.scopesKey) }
  }
  private func switchOn() {
    if test { error = "A test copy never opens the API."; app?.sendSettings(); return }
    q.async { [self] in
      let k = loadOrMakeKey()
      var problem: String? = k == nil ? "This Mac's Keychain did not give PS a key. Try again." : nil
      if k != nil && listenFd < 0 { problem = listen() }
      let ok = problem == nil && listenFd >= 0
      DispatchQueue.main.async { [self] in
        // Switched off again while this ran: close what was opened.
        if !on { q.async { [self] in closeListener() }; return }
        running = ok; error = problem; keyTail = k.map(TaskApiCore.tail)
        psLog("PS task api: \(ok ? "listening on 127.0.0.1:\(port)" : "not listening (\(problem ?? "unknown"))")")
        app?.sendSettings()
      }
    }
  }
  private func switchOff() {
    running = false; error = nil
    for (id, p) in pending { pending[id] = nil; reply(p.fd, 503, TaskApiCore.errorJSON("not_ready", "The AI task API was switched off.")) }
    q.async { [self] in closeListener() }
  }

  // MARK: the key
  /// q only.
  private func loadOrMakeKey() -> String? {
    if !loaded {
      loaded = true
      let k = TaskApiKeychain.read()
      mu.lock(); key = k; mu.unlock()
    }
    mu.lock(); let have = key; mu.unlock()
    if let have { return have }
    guard let k = TaskApiCore.newKey() else { return nil }
    let saved = TaskApiKeychain.write(k)
    psLog("PS task api: a new key made (\(saved ? "kept in the Keychain" : "kept for this run only, the Keychain said no"))")
    mu.lock(); key = k; mu.unlock()
    return k
  }
  private func withKey(_ f: @escaping (String) -> Void) {
    if test { return }
    q.async { [self] in
      guard let k = loadOrMakeKey() else { return }
      DispatchQueue.main.async { f(k) }
    }
  }
  private func regen() {
    if test { return }
    q.async { [self] in
      guard let k = TaskApiCore.newKey() else { return }
      let saved = TaskApiKeychain.write(k)
      loaded = true
      mu.lock(); key = k; limiter = TaskApiCore.RateLimit(); mu.unlock()
      psLog("PS task api: new key (\(saved ? "kept in the Keychain" : "kept for this run only")); the old one no longer works")
      DispatchQueue.main.async { [self] in keyTail = TaskApiCore.tail(k); app?.sendSettings() }
    }
  }
  private func copy(_ s: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")], owner: nil)
    pb.setString(s, forType: .string)
    pb.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))   // clipboard managers: do not keep this
  }
  private func tellOverlay(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let json = String(data: d, encoding: .utf8) else { return }
    app?.sendToOverlay(json)
  }

  // MARK: the socket (q only)
  /// nil when listening, else why not.
  private func listen() -> String? {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    guard s >= 0 else { return "PS could not open a socket." }
    var yes: Int32 = 1
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")   // loopback only: never another computer
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    if bound != 0 {
      let e = errno
      close(s)
      return e == EADDRINUSE ? "Port \(port) is used by another app on this Mac." : "PS could not listen on port \(port) (error \(e))."
    }
    guard Darwin.listen(s, 16) == 0 else { close(s); return "PS could not listen on port \(port)." }
    _ = fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK)
    let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: q)
    src.setEventHandler { [weak self] in self?.acceptAll(s) }
    src.setCancelHandler { close(s) }
    src.resume()
    listenFd = s; source = src
    return nil
  }
  private func closeListener() {
    source?.cancel(); source = nil; listenFd = -1
  }
  private func acceptAll(_ s: Int32) {
    while true {
      var peer = sockaddr_in(), len = socklen_t(MemoryLayout<sockaddr_in>.size)
      let c = withUnsafeMutablePointer(to: &peer) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(s, $0, &len) } }
      if c < 0 { return }
      var yes: Int32 = 1
      setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(c, F_SETFL, fcntl(c, F_GETFL) & ~O_NONBLOCK)
      var tv = timeval(tv_sec: 5, tv_usec: 0)
      setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
      setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
      // Bound to 127.0.0.1, so only this Mac can connect; checked again all the same.
      guard peer.sin_addr.s_addr == inet_addr("127.0.0.1") else { close(c); continue }
      mu.lock(); let busy = active >= 8; if !busy { active += 1 }; mu.unlock()
      if busy { connQ.async { [self] in send(c, TaskApiCore.response(503, TaskApiCore.errorJSON("not_ready", "PS is busy with other requests. Try again in a moment."))); close(c) }; continue }
      connQ.async { [weak self] in self?.serve(c) }
    }
  }

  // MARK: one connection (connQ)
  private func serve(_ c: Int32) {
    let t0 = Date()
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    var parsed: TaskApiCore.Parsed = .incomplete
    while case .incomplete = parsed {
      let n = recv(c, &chunk, chunk.count, 0)
      if n <= 0 { break }
      buf.append(contentsOf: chunk[0..<n])
      parsed = TaskApiCore.parse(buf)
      if buf.count > TaskApiCore.maxHead + TaskApiCore.maxCrmBody + 1024 { parsed = .bad(413, "too_large", "The request is too big."); break }
    }
    // Any thread: the socket work goes to the connection queue, never the main thread.
    let done = { (status: Int, json: Data, retry: Int?, what: String) in
      self.connQ.async {
        self.send(c, TaskApiCore.response(status, json, retryAfter: retry)); close(c)
        self.mu.lock(); self.active -= 1; self.mu.unlock()
      }
      let ms = Int(Date().timeIntervalSince(t0) * 1000)
      DispatchQueue.main.async { self.note(what, status, ms) }
    }
    let r: TaskApiCore.Request
    switch parsed {
    case .incomplete:
      if buf.isEmpty { close(c); mu.lock(); active -= 1; mu.unlock(); return }   // opened and closed: nothing to answer
      done(408, TaskApiCore.errorJSON("bad_request", "The request did not arrive in time."), nil, "(incomplete)"); return
    case .bad(let s, let code, let m): done(s, TaskApiCore.errorJSON(code, m), nil, "(unreadable)"); return
    case .ok(let x): r = x
    }
    let now = Date().timeIntervalSince1970
    mu.lock(); let k = key; let wait = limiter.take(now); mu.unlock()
    if let wait { done(429, TaskApiCore.errorJSON("rate_limited", "Too many requests. Wait \(wait) s and try again.", ["retryAfter": wait]), wait, r.what); return }
    if case .reject(let s, let code, let m) = TaskApiCore.gate(r, key: k, port: port) {
      if s == 401 { mu.lock(); limiter.failed(now); mu.unlock() }
      done(s, TaskApiCore.errorJSON(code, m), nil, r.what); return
    }
    let (body, ok) = TaskApiCore.jsonBody(r)
    if case .reject(let s, let code, let m) = ok { done(s, TaskApiCore.errorJSON(code, m), nil, r.what); return }
    let id = TaskApiCore.newId()
    DispatchQueue.main.async { [self] in
      guard on, running else { done(503, TaskApiCore.errorJSON("not_ready", "The AI task API is switched off in PS."), nil, r.what); return }
      let allowed = scopes
      pending[id] = (c, t0, r.what)
      connQ.async { [self] in
        let fwd = TaskApiCore.forward(id: id, r, body: body, scopes: allowed)
        let json = (try? JSONSerialization.data(withJSONObject: fwd)).flatMap { String(data: $0, encoding: .utf8) }
        DispatchQueue.main.async { [self] in
          guard pending[id] != nil else { return }
          guard let json, let main = app?.main else {
            finish(id, 503, TaskApiCore.errorJSON("not_ready", "PS is starting. Try again in a few seconds."))
            return
          }
          main.callAsyncJavaScript("if (!window.__ps) return false; window.__ps.apply(JSON.parse(m)); return true", arguments: ["m": json], in: nil, in: .page) { [weak self] res in
            if case .success(let v) = res, (v as? Bool) == true { return }
            self?.finish(id, 503, TaskApiCore.errorJSON("not_ready", "PS is starting. Try again in a few seconds."))
          }
        }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + TaskApiCore.answerWait(r)) { [weak self] in
        self?.finish(id, 503, TaskApiCore.errorJSON("not_ready", "PS did not answer in time. Read the item before retrying."))
      }
    }
  }
  private func answer(_ msg: [String: Any]) {
    connQ.async { [weak self] in
      guard let a = TaskApiCore.answer(msg) else { return }
      DispatchQueue.main.async { [weak self] in self?.finish(a.id, a.status, a.json) }
    }
  }
  /// Main thread: the one answer for a request still waiting (later ones are ignored).
  private func finish(_ id: String, _ status: Int, _ json: Data) {
    guard let p = pending.removeValue(forKey: id) else { return }
    let ms = Int(Date().timeIntervalSince(p.t0) * 1000)
    connQ.async { [self] in
      send(p.fd, TaskApiCore.response(status, json)); close(p.fd)
      mu.lock(); active -= 1; mu.unlock()
    }
    note(p.what, status, ms)
  }
  private func reply(_ fd: Int32, _ status: Int, _ json: Data) {
    connQ.async { [self] in send(fd, TaskApiCore.response(status, json)); close(fd); mu.lock(); active -= 1; mu.unlock() }
  }
  private func send(_ fd: Int32, _ d: Data) {
    d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
      var off = 0
      while off < p.count {
        let n = Darwin.send(fd, p.baseAddress! + off, p.count - off, 0)
        if n <= 0 { return }
        off += n
      }
    }
  }
  /// Main thread: the log line and Settings' "Last request" (at most one Settings update every 3 s).
  private func note(_ what: String, _ status: Int, _ ms: Int) {
    psLog(TaskApiCore.logLine(what, status, ms: ms))
    last = ["at": Int(Date().timeIntervalSince1970 * 1000), "what": String(what.prefix(90)), "status": status]
    count += 1
    if !settingsSoon {
      settingsSoon = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.settingsSoon = false; self?.app?.sendSettings() }
    }
  }

  // MARK: the update hands the key to the new build (UpdateHandoff.swift)
  static func handoffCollect() -> String? { TaskApiKeychain.read() }
  @discardableResult static func handoffSave(_ k: String?) -> Bool { guard let k, TaskApiCore.validKey(k) else { return false }; return TaskApiKeychain.write(k) }
}
