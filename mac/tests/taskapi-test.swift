// tests/taskapi-test.sh compiles this with Sources/TaskApiCore.swift.
import Foundation

var passed = 0, failed = 0
func check(_ ok: Bool, _ name: String) { if ok { passed += 1 } else { failed += 1; print("FAIL - \(name)") } }
func req(_ s: String) -> Data { Data(s.replacingOccurrences(of: "\n", with: "\r\n").utf8) }
func ok(_ p: TaskApiCore.Parsed) -> TaskApiCore.Request? { if case .ok(let r) = p { return r }; return nil }
func bad(_ p: TaskApiCore.Parsed) -> Int? { if case .bad(let s, _, _) = p { return s }; return nil }
func incomplete(_ p: TaskApiCore.Parsed) -> Bool { if case .incomplete = p { return true }; return false }
let KEY = "ps_" + String(repeating: "aB3", count: 13) + "x"   // 43 characters
check(TaskApiCore.validKey(KEY), "the test key is well formed")

// ---------- parsing ----------
let get = ok(TaskApiCore.parse(req("GET /v1/tasks?list=inbox&q=email+sam%21 HTTP/1.1\nHost: 127.0.0.1:47836\nAuthorization: Bearer \(KEY)\n\n")))
check(get?.method == "GET" && get?.path == "/v1/tasks", "a GET: method and path, the query apart")
check(get?.query == ["list": "inbox", "q": "email sam!"], "the query is decoded (+ and %)")
check(get?.what == "GET /v1/tasks", "what is logged never has the query")
check(get?.headers["authorization"] == "Bearer \(KEY)", "header names are lower case")
let body = "{\"title\":\"Email Sam\"}"
let post = ok(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost:47836\nContent-Type: application/json\nContent-Length: \(body.utf8.count)\n\n") + Data(body.utf8)))
check(post.map { String(decoding: $0.body, as: UTF8.self) } == body, "a POST: the body by Content-Length")
check(incomplete(TaskApiCore.parse(req("GET /v1 HTTP/1.1\nHost: localhost\n"))), "no blank line yet: incomplete")
check(incomplete(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nContent-Length: 50\n\n") + Data("{\"a\":1}".utf8))), "body not all here: incomplete")
check(bad(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nTransfer-Encoding: chunked\n\n"))) == 400, "chunked bodies are refused")
check(bad(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nContent-Length: 70000\n\n"))) == 413, "over 64 KB: 413")
check(bad(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nContent-Length: -1\n\n"))) == 400, "a negative length: 400")
check(bad(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nContent-Length: 5\nContent-Length: 6\n\n"))) == 400, "two different lengths: 400")
check(bad(TaskApiCore.parse(req("GET /v1 HTTP/1.1\nHost: localhost\nHost: evil.example\n\n"))) == 400, "two Host headers: 400")
check(bad(TaskApiCore.parse(req("HELLO\n\n"))) == 400, "not HTTP: 400")
check(bad(TaskApiCore.parse(req("GET v1 HTTP/1.1\nHost: localhost\n\n"))) == 400, "a path without / : 400")
check(bad(TaskApiCore.parse(req("GET /\(String(repeating: "a", count: 500)) HTTP/1.1\nHost: localhost\n\n"))) == 414, "a very long path: 414")
check(bad(TaskApiCore.parse(Data(repeating: 65, count: 17_000))) == 431, "a head over 16 KB: 431")

// ---------- the gate ----------
func gate(_ extra: String, host: String = "127.0.0.1:47836", method: String = "GET", key: String? = KEY) -> TaskApiCore.Gate {
  let r = ok(TaskApiCore.parse(req("\(method) /v1 HTTP/1.1\nHost: \(host)\n\(extra)\n")))!
  return TaskApiCore.gate(r, key: key, port: 47836)
}
func code(_ g: TaskApiCore.Gate) -> String? { if case .reject(_, let c, _) = g { return c }; return nil }
func status(_ g: TaskApiCore.Gate) -> Int? { if case .reject(let s, _, _) = g { return s }; return nil }
let auth = "Authorization: Bearer \(KEY)\n"
check(gate(auth) == .pass, "the right key from a terminal passes")
check(gate("X-PS-Key: \(KEY)\n") == .pass, "X-PS-Key works too")
check(gate("authorization: bearer \(KEY)\n") == .pass, "bearer in any case")
for h in ["127.0.0.1", "localhost", "LOCALHOST:47836", "localhost:47836"] { check(gate(auth, host: h) == .pass, "Host \(h) passes") }
check(code(gate(auth + "Origin: https://evil.example\n")) == "browser_blocked", "any Origin is a browser: refused")
check(code(gate(auth + "Origin: null\n")) == "browser_blocked", "Origin null too")
check(code(gate(auth + "Sec-Fetch-Site: cross-site\n")) == "browser_blocked", "Sec-Fetch headers are a browser: refused")
check(code(gate(auth + "Sec-Fetch-Mode: no-cors\n")) == "browser_blocked", "Sec-Fetch-Mode too")
for h in ["evil.example", "evil.example:47836", "127.0.0.1:80", "127.0.0.2:47836", "localhost.evil.example:47836", "[::1]:47836", ""] {
  check(code(gate(auth, host: h)) == "bad_host", "Host \(h) refused (DNS rebinding)")
}
let noHost = ok(TaskApiCore.parse(req("GET /v1 HTTP/1.1\n\(auth)\n")))!
check(code(TaskApiCore.gate(noHost, key: KEY)) == "bad_host", "no Host: refused")
check(status(gate("")) == 401, "no key: 401")
check(status(gate("Authorization: Bearer ps_wrong\n")) == 401, "a wrong key: 401")
check(status(gate("Authorization: Basic \(KEY)\n")) == 401, "not Bearer: 401")
check(status(gate("Authorization: Bearer \(KEY)x\n")) == 401, "a longer key: 401")
check(status(gate(auth, key: nil)) == 401, "no key made yet: 401")
check(status(gate(auth, method: "OPTIONS")) == 405, "OPTIONS (a browser's preflight): 405, no CORS")
check(status(gate(auth, method: "TRACE")) == 405, "TRACE: 405")
check(code(gate("Origin: https://evil.example\n")) == "browser_blocked", "a browser is told it is a browser before anything about keys")

// ---------- keys ----------
let k1 = TaskApiCore.newKey()!, k2 = TaskApiCore.newKey()!
check(TaskApiCore.validKey(k1) && TaskApiCore.validKey(k2) && k1 != k2, "new keys: ps_ and 40 letters or digits, never the same")
check(!TaskApiCore.validKey("ps_short") && !TaskApiCore.validKey("xx_" + String(k1.dropFirst(3))) && !TaskApiCore.validKey(String(k1.dropLast()) + "!"), "validKey refuses bad ones")
check(TaskApiCore.sameKey(k1, k1) && !TaskApiCore.sameKey(k1, k2) && !TaskApiCore.sameKey(k1, String(k1.dropLast())) && !TaskApiCore.sameKey("", k1), "sameKey")
check(TaskApiCore.tail(k1).count == 4 && k1.hasSuffix(TaskApiCore.tail(k1)), "the tail is the last 4")
let id = TaskApiCore.newId()
check(id.count == 24 && id.allSatisfy { "0123456789abcdef".contains($0) }, "request ids fit the page's rule")

// ---------- rate limit ----------
var rl = TaskApiCore.RateLimit()
var allowed = 0
for _ in 0..<40 { if rl.take(1000) == nil { allowed += 1 } }
check(allowed == 30, "a burst of 30, then wait (\(allowed))")
check((rl.take(1000) ?? 0) >= 1, "it says how long to wait")
check(rl.take(1001) == nil && rl.take(1001) == nil && rl.take(1001) != nil, "2 a second come back")
var rl2 = TaskApiCore.RateLimit()
for i in 0..<4 { rl2.failed(2000 + Double(i)) }
check(rl2.take(2005) == nil, "4 wrong keys: still open")
rl2.failed(2006)
check((rl2.take(2007) ?? 0) > 50, "5 wrong keys in a minute: shut for a minute")
check(rl2.take(2067) == nil, "open again after the minute")
var rl3 = TaskApiCore.RateLimit()
rl3.failed(0); rl3.failed(10); rl3.failed(20); rl3.failed(30); rl3.failed(100)
check(rl3.take(101) == nil, "wrong keys spread over more than a minute never shut it")

// ---------- the answer ----------
let res = String(decoding: TaskApiCore.response(429, TaskApiCore.errorJSON("rate_limited", "Wait"), retryAfter: 3), as: UTF8.self)
check(res.hasPrefix("HTTP/1.1 429 Too Many Requests\r\n"), "status line")
check(res.contains("Connection: close\r\n") && res.contains("Cache-Control: no-store\r\n") && res.contains("Retry-After: 3\r\n"), "close, never cached, Retry-After")
check(!res.lowercased().contains("access-control"), "no CORS headers at all")
check(res.hasSuffix("{\"error\":{\"code\":\"rate_limited\",\"message\":\"Wait\"}}"), "the error body")
check(String(decoding: TaskApiCore.response(401, Data("{}".utf8)), as: UTF8.self).contains("WWW-Authenticate: Bearer"), "401 names Bearer")
let a = TaskApiCore.answer(["id": "abcdef0123456789", "status": 201, "body": ["task": ["id": "x"]]])
check(a?.status == 201 && a.map { String(decoding: $0.json, as: UTF8.self) } == "{\"task\":{\"id\":\"x\"}}", "the page's answer goes out as it is")
check(TaskApiCore.answer(["id": "abcdef0123456789", "status": 99, "body": [:] as [String: Any]])?.status == 500, "a strange status becomes 500")
check(TaskApiCore.answer(["id": "short", "status": 200]) == nil, "a bad id is ignored")
let fwd = TaskApiCore.forward(id: "abcdef0123456789", post!, body: ["title": "x"], scopes: TaskApiCore.scopeDefaults)
check(fwd["type"] as? String == "api:req" && fwd["path"] as? String == "/v1/tasks" && (fwd["scopes"] as? [String: Bool])?["add"] == true, "what goes to the page")
check(JSONSerialization.isValidJSONObject(TaskApiCore.forward(id: "abcdef0123456789", get!, body: nil, scopes: [:])), "a request with no body is still JSON")

// ---------- bodies, switches, the guide, the log ----------
let notJson = ok(TaskApiCore.parse(req("POST /v1/tasks HTTP/1.1\nHost: localhost\nContent-Length: 5\n\n") + Data("title".utf8)))!
if case .reject(let s, _, _) = TaskApiCore.jsonBody(notJson).1 { check(s == 400, "a body that is not JSON: 400") } else { check(false, "a body that is not JSON: 400") }
check(TaskApiCore.jsonBody(get!).0 == nil, "no body: null")
check((TaskApiCore.jsonBody(post!).0 as? [String: Any])?["title"] as? String == "Email Sam", "a JSON body is read")
check(TaskApiCore.cleanScopes(["lists": true, "delete": "yes", "bogus": true]) == TaskApiCore.scopeDefaults.merging(["lists": true]) { $1 }, "switches: known ones, booleans only")
check(TaskApiCore.cleanScopes(nil)["add"] == true && TaskApiCore.cleanScopes(nil)["delete"] == false, "defaults: add on, delete off")
check(TaskApiCore.fillGuide("Key: {{PS_API_KEY}} and export PS_KEY='{{PS_API_KEY}}'", key: KEY) == "Key: \(KEY) and export PS_KEY='\(KEY)'", "Copy for AI: the key goes in every slot")
check(TaskApiCore.fillGuide("no slot here", key: KEY) == nil, "Copy for AI: a text with no slot is not copied")
check(!TaskApiCore.logLine(get!.what, 200, ms: 4).contains("inbox") && !TaskApiCore.logLine(get!.what, 200, ms: 4).contains(KEY), "the log line has no query and no key")

// ---------- Sentry mode: start only ----------
check(TaskApiCore.scopeDefaults["sentry"] == false && TaskApiCore.cleanScopes(nil)["sentry"] == false, "Start Sentry mode is off unless switched on")
check(TaskApiCore.cleanScopes(["sentry": true])["sentry"] == true, "Start Sentry mode can be switched on")
check(TaskApiCore.scopeDefaults["gym"] == false && TaskApiCore.cleanScopes(nil)["gym"] == false, "the gym switch is off unless switched on (V1.57)")
check(TaskApiCore.cleanScopes(["gym": true])["gym"] == true, "the gym switch can be switched on, so the page hears it")
check(TaskApiCore.scopeDefaults["settings"] == false && TaskApiCore.cleanScopes(["settings": true])["settings"] == true, "the settings switch (Invert swipe): off unless switched on, heard when on")
let sentryReq = ok(TaskApiCore.parse(req("POST /v1/sentry/start HTTP/1.1\nHost: localhost\n\(auth)\n")))!
check(TaskApiCore.answerWait(sentryReq) == 40 && TaskApiCore.answerWait(get!) == 15, "starting Sentry mode may take its checks' time; everything else 15 s")
// ---------- a message from the AI on the island (V1.58) ----------
check(TaskApiCore.scopeDefaults["message"] == false && TaskApiCore.cleanScopes(nil)["message"] == false, "the message switch is off unless switched on")
check(TaskApiCore.cleanScopes(["message": true])["message"] == true, "the message switch can be switched on, so the page hears it")
check(TaskApiCore.scopeIds.contains("message") && TaskApiCore.scopeIds.count == TaskApiCore.scopeDefaults.count, "every switch has a default")
// ---------- the goals Timeline (PS 1.72) ----------
check(TaskApiCore.scopeDefaults["goals"] == false && TaskApiCore.cleanScopes(nil)["goals"] == false, "the goals switch is off unless switched on")
check(TaskApiCore.cleanScopes(["goals": true])["goals"] == true, "the goals switch can be switched on, so the page hears it")
let goalBody = "{\"title\":\"Launch the shop\",\"level\":\"macro\"}"
let goalNoKey = ok(TaskApiCore.parse(req("POST /v1/goals HTTP/1.1\nHost: 127.0.0.1:47836\nContent-Type: application/json\nContent-Length: \(goalBody.utf8.count)\n\n") + Data(goalBody.utf8)))!
check(status(TaskApiCore.gate(goalNoKey, key: KEY)) == 401, "a goal with no key: 401")
let goalOk = ok(TaskApiCore.parse(req("POST /v1/goals HTTP/1.1\nHost: 127.0.0.1:47836\n\(auth)Content-Type: application/json\nContent-Length: \(goalBody.utf8.count)\n\n") + Data(goalBody.utf8)))!
check(TaskApiCore.gate(goalOk, key: KEY) == .pass && (TaskApiCore.jsonBody(goalOk).0 as? [String: Any])?["title"] as? String == "Launch the shop", "a goal with the key reaches the page with its JSON")

let msgBody = "{\"from\":\"Claude Code\",\"text\":\"Fixed the login bug\"}"
let msgNoKey = ok(TaskApiCore.parse(req("POST /v1/island/message HTTP/1.1\nHost: 127.0.0.1:47836\nContent-Type: application/json\nContent-Length: \(msgBody.utf8.count)\n\n") + Data(msgBody.utf8)))!
check(status(TaskApiCore.gate(msgNoKey, key: KEY)) == 401, "a message with no key: 401")
let msgOk = ok(TaskApiCore.parse(req("POST /v1/island/message HTTP/1.1\nHost: 127.0.0.1:47836\n\(auth)Content-Type: application/json\nContent-Length: \(msgBody.utf8.count)\n\n") + Data(msgBody.utf8)))!
check(TaskApiCore.gate(msgOk, key: KEY) == .pass && (TaskApiCore.jsonBody(msgOk).0 as? [String: Any])?["text"] as? String == "Fixed the login bug", "a message with the key reaches the page with its JSON")
check(TaskApiCore.answerWait(msgOk) == 15, "a message is answered within the usual 15 s")
let msgBad = ok(TaskApiCore.parse(req("POST /v1/island/message HTTP/1.1\nHost: localhost\n\(auth)Content-Length: 8\n\n") + Data("{\"text\":".utf8)))!
if case .reject(let s, _, _) = TaskApiCore.jsonBody(msgBad).1 { check(s == 400, "a message that is not JSON: 400") } else { check(false, "a message that is not JSON: 400") }
var msgLimit = TaskApiCore.RateLimit()
var msgWaits = 0
for _ in 0..<40 { if msgLimit.take(1000) != nil { msgWaits += 1 } }
check(msgWaits == 10, "40 messages at once: 30 go, 10 wait (the same limit as every request)")

let src = (try? String(contentsOfFile: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "", encoding: .utf8)) ?? ""
if !src.isEmpty {
  for word in ["sentry:stop", "sentry:end", "sentry:off", "sentry:pause", "sentry:leave", "sentry:unlock", "sentry:disengage"] {
    check(!src.contains("\"\(word)"), "no page message \(word) exists on the Mac")
  }
  // The message card (AiMessageCard.swift) is wired into the card page, and puts words in as text only.
  check(src.contains("AiMessageCard.tone].contains(tone)") && src.contains("\\#(AiMessageCard.css)") && src.contains("\\#(AiMessageCard.js)")
        && src.contains("AiMsg.click(c,t)") && src.contains("AiMsg.made(c)"), "the message card is hooked into the card page")
  check(src.contains("LOOKSEL={done:['.t-done','.t-ai']"), "the message card takes the AI chat cards' colours")
} else { check(false, "the Mac's sources were given to the Sentry check") }
// AiMessageCard's page code never puts anything in as HTML (its icon is a fixed path the page's own svg() draws).
if let r = src.range(of: "enum AiMessageCard {") { check(!src[r.lowerBound...].prefix(6000).contains("innerHTML"), "the message card never writes HTML") }
else { check(false, "AiMessageCard.swift is in the sources") }

print("taskapi: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
