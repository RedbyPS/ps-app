// The Task API (the developer's friend: "api so that my claude code can add tasks into the ps app"), the rules on the Mac's
// side. Pure: no sockets, no Keychain, no windows, so tests/taskapi-test.sh runs every check on its own.
// - parse: one small HTTP/1.1 request (head up to 16 KB, a JSON body up to 64 KB by Content-Length, never chunked).
// - gate: what keeps everyone but an app on this Mac with the key out:
//     any Origin or Sec-Fetch-* header means a browser sent it (no web page can reach it, so no CSRF);
//     the Host must be 127.0.0.1 or localhost (no DNS rebinding);
//     the key, compared in constant time (Authorization: Bearer <key> or X-PS-Key: <key>; never in the URL).
// - RateLimit: 2 requests a second with bursts of 30, and 5 wrong keys in a minute shut it for a minute.
// - The answer is JSON, Connection: close, never cached, no CORS headers at all.
// The endpoints themselves, the switches and the vault work are in the web layer (web core/taskapi.ts).
// Nothing here ever logs a request's body or a key.
import Foundation
import Security

enum TaskApiCore {
  static let port: UInt16 = 47836
  static let maxHead = 16 * 1024
  static let maxBody = 64 * 1024
  static let maxPath = 400
  static let methods: Set<String> = ["GET", "POST", "PATCH", "PUT", "DELETE"]

  // MARK: the switches (the same ids and defaults as core/taskapi.ts SCOPES)
  // "gym" (V1.57): read and change the gym reminder's times (GET and PATCH /v1/gym). Off unless switched on; it can never say Yes.
  // "settings" (V1.57): GET and PATCH /v1/settings (Invert swipe). Off unless switched on.
  // "message" (V1.58): POST /v1/island/message, a message from the AI on the island (AiMessageCard.swift). Off unless switched on.
  // "goals" (PS 1.72): the goals Timeline (GET, POST, PATCH and DELETE /v1/goals; the rules are in the page). Off unless switched on.
  // "focus" (PS 1.74): GET and PUT /v1/focus, the task being worked on (the one the island shows). Off unless switched on.
  static let scopeIds = ["inbox", "lists", "goals", "rename", "read", "add", "edit", "done", "delete", "remind", "focus", "sentry", "gym", "settings", "message"]
  static let scopeDefaults: [String: Bool] = ["inbox": true, "lists": false, "goals": false, "rename": false, "read": true, "add": true, "edit": false, "done": false, "delete": false, "remind": false, "focus": false, "sentry": false, "gym": false, "settings": false, "message": false]
  /// Known switches only; a missing one takes its default.
  static func cleanScopes(_ v: Any?) -> [String: Bool] {
    var out = scopeDefaults
    if let d = v as? [String: Any] { for id in scopeIds { if let b = d[id] as? Bool { out[id] = b } } }
    return out
  }

  // MARK: the key
  static let keySlot = "{{PS_API_KEY}}"
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".utf8)
  /// "ps_" and 40 random letters and digits (about 238 bits), from the system's secure random source.
  static func newKey() -> String? {
    var out: [UInt8] = []
    while out.count < 40 {
      var b = [UInt8](repeating: 0, count: 64)
      guard SecRandomCopyBytes(kSecRandomDefault, b.count, &b) == errSecSuccess else { return nil }
      for x in b where x < 248 && out.count < 40 { out.append(alphabet[Int(x) % 62]) }   // 248 = 4 * 62: no bias
    }
    return "ps_" + String(decoding: out, as: UTF8.self)
  }
  static func validKey(_ s: String) -> Bool {
    s.count == 43 && s.hasPrefix("ps_") && s.utf8.dropFirst(3).allSatisfy { alphabet.contains($0) }
  }
  /// Equal in constant time for keys of the same length (the time never says how much of a guess was right).
  static func sameKey(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    var diff: UInt8 = x.count == y.count ? 0 : 1
    for i in 0..<max(x.count, y.count) { diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0) }
    return diff == 0
  }
  static func tail(_ key: String) -> String { String(key.suffix(4)) }
  /// The request id the page answers with (web src/taskapi.ts: [a-z0-9]{8,40}).
  static func newId() -> String {
    var b = [UInt8](repeating: 0, count: 12)
    _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
    return b.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: parsing one request
  struct Request {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String]   // lower case names
    var body: Data
    var what: String { "\(method) \(path)" }
  }
  enum Parsed { case incomplete, bad(Int, String, String), ok(Request) }

  static func parse(_ buf: Data) -> Parsed {
    let sep = Data("\r\n\r\n".utf8)
    guard let end = buf.range(of: sep) else {
      return buf.count > maxHead ? .bad(431, "too_large", "The request head is over 16 KB.") : .incomplete
    }
    if end.lowerBound > maxHead { return .bad(431, "too_large", "The request head is over 16 KB.") }
    guard let head = String(data: buf[buf.startIndex..<end.lowerBound], encoding: .utf8) else { return .bad(400, "bad_request", "The request head is not text.") }
    var lines = head.components(separatedBy: "\r\n")
    let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: false)
    guard first.count == 3, first[2].hasPrefix("HTTP/1.") else { return .bad(400, "bad_request", "Not an HTTP/1.1 request.") }
    let method = String(first[0])
    let target = String(first[1])
    guard target.hasPrefix("/") else { return .bad(400, "bad_request", "The path must start with /.") }
    guard target.utf8.count <= maxPath else { return .bad(414, "too_large", "The path is too long.") }
    var headers: [String: String] = [:]
    for l in lines {
      guard let c = l.firstIndex(of: ":") else { return .bad(400, "bad_request", "A header line is broken.") }
      let name = l[l.startIndex..<c].trimmingCharacters(in: .whitespaces).lowercased()
      let value = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty, !name.contains(" ") else { return .bad(400, "bad_request", "A header name is broken.") }
      if name == "host" && headers["host"] != nil { return .bad(400, "bad_request", "Two Host headers.") }
      if name == "content-length", let have = headers[name], have != value { return .bad(400, "bad_request", "Two different Content-Length headers.") }
      headers[name] = value
    }
    if headers["transfer-encoding"] != nil { return .bad(400, "bad_request", "Send the body with Content-Length, not chunked.") }
    var length = 0
    if let cl = headers["content-length"] {
      guard !cl.isEmpty, cl.utf8.count <= 9, cl.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(cl) else { return .bad(400, "bad_request", "Content-Length is not a number.") }
      length = n
    }
    if length > maxBody { return .bad(413, "too_large", "The body is over 64 KB.") }
    let bodyStart = end.upperBound
    if buf.distance(from: bodyStart, to: buf.endIndex) < length { return .incomplete }
    let body = Data(buf[bodyStart..<buf.index(bodyStart, offsetBy: length)])
    let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let path = String(parts[0])
    var query: [String: String] = [:]
    if parts.count > 1 {
      for pair in parts[1].split(separator: "&") where !pair.isEmpty {
        let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let dec = { (s: Substring) -> String? in s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding }
        guard let k = dec(kv[0]), let v = kv.count > 1 ? dec(kv[1]) : "" else { return .bad(400, "bad_request", "The query is not valid.") }
        if query.count < 20 { query[k] = v }
      }
    }
    return .ok(Request(method: method, path: path, query: query, headers: headers, body: body))
  }

  // MARK: the checks before anything reaches PS
  enum Gate: Equatable { case pass, reject(Int, String, String) }
  static func hostOK(_ host: String?, port: UInt16) -> Bool {
    guard let h = host?.lowercased() else { return false }
    return ["127.0.0.1", "localhost", "127.0.0.1:\(port)", "localhost:\(port)"].contains(h)
  }
  /// The key sent, if any: Authorization: Bearer <key>, or X-PS-Key: <key>.
  static func sentKey(_ r: Request) -> String? {
    if let a = r.headers["authorization"] {
      let p = a.split(separator: " ", maxSplits: 1)
      if p.count == 2, p[0].lowercased() == "bearer" { return p[1].trimmingCharacters(in: .whitespaces) }
    }
    return r.headers["x-ps-key"]
  }
  static func gate(_ r: Request, key: String?, port: UInt16 = port) -> Gate {
    if r.headers["origin"] != nil || r.headers.keys.contains(where: { $0.hasPrefix("sec-fetch-") }) {
      return .reject(403, "browser_blocked", "Requests from web browsers are refused. Call the API from a terminal or an app on this Mac.")
    }
    if !hostOK(r.headers["host"], port: port) { return .reject(403, "bad_host", "The Host must be 127.0.0.1 or localhost.") }
    if !methods.contains(r.method) { return .reject(405, "method_not_allowed", "Use GET, POST, PATCH, PUT or DELETE.") }
    guard let key, let sent = sentKey(r), !sent.isEmpty else {
      return .reject(401, "unauthorized", "Send the key: Authorization: Bearer <key>. It is in PS, Settings, AI task API.")
    }
    if !sameKey(sent, key) { return .reject(401, "unauthorized", "That key is not right. Copy it again from PS, Settings, AI task API (it may have been changed).") }
    return .pass
  }
  /// The body as JSON (empty: null). nil with an error when it is not JSON.
  static func jsonBody(_ r: Request) -> (Any?, Gate) {
    if r.body.isEmpty || r.body.allSatisfy({ $0 == 0x20 || $0 == 0x0a || $0 == 0x0d || $0 == 0x09 }) { return (nil, .pass) }
    guard let v = try? JSONSerialization.jsonObject(with: r.body, options: []) else {
      return (nil, .reject(400, "bad_request", "The body is not valid JSON. Send Content-Type: application/json and a JSON object."))
    }
    return (v, .pass)
  }

  // MARK: rate limit
  struct RateLimit {
    var cap = 30.0, perSec = 2.0
    var tokens = 30.0
    var last: TimeInterval = 0
    var fails: [TimeInterval] = []
    var shutUntil: TimeInterval = 0
    /// nil: go ahead. A number: wait that many seconds.
    mutating func take(_ now: TimeInterval) -> Int? {
      if now < shutUntil { return Int((shutUntil - now).rounded(.up)) }
      if last > 0 { tokens = min(cap, tokens + (now - last) * perSec) }
      last = now
      if tokens < 1 { return max(1, Int(((1 - tokens) / perSec).rounded(.up))) }
      tokens -= 1
      return nil
    }
    /// A wrong or missing key: 5 in a minute shut it for a minute.
    mutating func failed(_ now: TimeInterval) {
      fails = fails.filter { now - $0 < 60 } + [now]
      if fails.count >= 5 { shutUntil = now + 60; fails = [] }
    }
  }

  // MARK: the answer
  static func errorJSON(_ code: String, _ message: String, _ extra: [String: Any] = [:]) -> Data {
    var e: [String: Any] = ["code": code, "message": message]
    for (k, v) in extra { e[k] = v }
    return (try? JSONSerialization.data(withJSONObject: ["error": e], options: [.sortedKeys])) ?? Data("{}".utf8)
  }
  static func reason(_ s: Int) -> String {
    [200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
     408: "Request Timeout", 409: "Conflict", 413: "Payload Too Large", 414: "URI Too Long", 423: "Locked", 429: "Too Many Requests",
     431: "Request Header Fields Too Large", 500: "Internal Server Error", 503: "Service Unavailable"][s] ?? "Status"
  }
  static func response(_ status: Int, _ json: Data, retryAfter: Int? = nil) -> Data {
    var h = "HTTP/1.1 \(status) \(reason(status))\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(json.count)\r\n"
    h += "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
    if status == 401 { h += "WWW-Authenticate: Bearer\r\n" }
    if let retryAfter { h += "Retry-After: \(retryAfter)\r\n" }
    var d = Data((h + "\r\n").utf8)
    d.append(json)
    return d
  }
  /// How long PS may take to answer, seconds. Starting Sentry mode runs the AI button's own checks first (the restart
  /// helper, up to 10 s, and the lid keep awake, up to 12 s, at once) and then waits for the Mac to engage (8 s).
  /// There is no route that stops Sentry mode: the API can only start it (web core/taskapi.ts).
  static func answerWait(_ r: Request) -> Double { r.method == "POST" && r.path.hasPrefix("/v1/sentry/start") ? 40 : 15 }
  /// What goes to the main page for one checked request.
  static func forward(id: String, _ r: Request, body: Any?, scopes: [String: Bool]) -> [String: Any] {
    ["type": "api:req", "id": id, "method": r.method, "path": r.path, "query": r.query, "body": body ?? NSNull(), "scopes": scopes]
  }
  /// The page's answer: the id, a sane status and the body as JSON.
  static func answer(_ msg: [String: Any]) -> (id: String, status: Int, json: Data)? {
    guard let id = msg["id"] as? String, id.count >= 8, id.count <= 40 else { return nil }
    let s = (msg["status"] as? Int) ?? 500
    let status = (200...599).contains(s) ? s : 500
    let body = msg["body"] ?? NSNull()
    let json = (JSONSerialization.isValidJSONObject(body) ? try? JSONSerialization.data(withJSONObject: body, options: []) : nil) ?? errorJSON("internal", "PS could not answer.")
    return (id, status, json)
  }
  /// The Copy for AI text with the key in it (the page only ever has the slot).
  static func fillGuide(_ text: String, key: String) -> String? {
    guard text.utf8.count <= 64 * 1024, text.contains(keySlot) else { return nil }
    return text.replacingOccurrences(of: keySlot, with: key)
  }
  /// One log line: never a body, never a query (it can hold words), never a key.
  static func logLine(_ what: String, _ status: Int, ms: Int) -> String {
    "PS task api: \(String(what.prefix(90))) \(status) \(ms) ms"
  }
}
