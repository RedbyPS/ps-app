// Offline test for Sources/MailSendCore.swift (Reply from PS, V1.44): the email PS builds, the thread headers, the
// Instantly payload, the queue (schedule, Undo, Cancel, Send now, Edit, retries, restart, a long sleep) and both senders
// against FAKE Gmail and Instantly clients. FICTIONAL people and addresses only. Nothing here can reach the network:
// the only client is FakeHTTP, which answers from a script and records what it was asked.
//   bash tests/mailsend-test.sh
import Foundation

var fails = 0, count = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { count += 1; print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty || ok ? "" : " (\(info))")"); if !ok { fails += 1 } }

final class FakeHTTP: MailHTTP {
  var asked: [URLRequest] = []
  var answers: [(Int, Data?, String?)] = []
  func send(_ req: URLRequest, _ done: @escaping (Int, Data?, String?) -> Void) {
    // Belt and braces: a fake that is ever handed a real send must say so loudly.
    asked.append(req)
    let a = answers.isEmpty ? (500, nil, nil) : answers.removeFirst()
    done(a.0, a.1, a.2)
  }
}
func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }
func body(_ r: URLRequest) -> [String: Any] { (r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:] }
func unb64url(_ s: String) -> String {
  var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"); while b.count % 4 != 0 { b += "=" }
  return String(data: Data(base64Encoded: b) ?? Data(), encoding: .utf8) ?? ""
}

let now = 1_794_000_000_000.0
func page(_ x: [String: Any] = [:]) -> [String: Any] {
  var p: [String: Any] = ["id": "job1", "cardId": "m:rep1", "via": "gmail", "account": "Studio@example.com", "to": "jane@northwind.example", "toName": "Jane Doe",
                          "subject": "Re: Homepage draft", "text": "Hi Jane,\n\nOn it.\n", "html": "<div>Hi Jane,<br><br>On it.</div>", "threadId": "t123", "sendAt": now + 10_000,
                          "draft": ["message": "Hi Jane", "sig": "", "quote": true]]
  for (k, v) in x { p[k] = v }
  return p
}

// MARK: the job from the page
let j = OutJob.from(page(), undo: true, now: now)
check("job-ok", j != nil && j!.account == "studio@example.com" && j!.undo && j!.state == .queued)
check("job-bad-to", OutJob.from(page(["to": "not an email"]), undo: false, now: now) == nil)
check("job-bad-card", OutJob.from(page(["cardId": "x:1"]), undo: false, now: now) == nil)
check("job-empty-text", OutJob.from(page(["text": "  \n "]), undo: false, now: now) == nil)
check("job-gmail-needs-thread", OutJob.from(page(["threadId": ""]), undo: false, now: now) == nil)
check("job-instantly-needs-email", OutJob.from(page(["via": "instantly", "emailId": NSNull()]), undo: false, now: now) == nil)
check("job-too-far", OutJob.from(page(["sendAt": now + 8 * 24 * 3600_000]), undo: false, now: now) == nil)
check("job-past-is-now", OutJob.from(page(["sendAt": now - 99_000]), undo: false, now: now)?.sendAt == now)
check("job-subject-one-line", OutJob.from(page(["subject": "Re: Hi\r\nBcc: evil@x.example"]), undo: false, now: now)?.subject == "Re: Hi Bcc: evil@x.example")
check("job-log-has-no-words", !j!.logLine.contains("On it") && j!.logLine.contains("jane@northwind.example") && j!.logLine.contains("Homepage draft"))
check("job-row-has-no-words", j!.row["text"] == nil && j!.row["html"] == nil && j!.row["draft"] == nil)

// MARK: the email
let mime = MailMime.build(from: "studio@example.com", fromName: "Sam Studio", to: "jane@northwind.example", toName: "Jane Doe", subject: "Re: Café menu",
                          text: "Hi Jane,\nOn it.", html: "<div>Hi</div>", inReplyTo: "<abc@mail.example>", references: "<root@mail.example> <abc@mail.example>",
                          date: Date(timeIntervalSince1970: now / 1000), boundary: "ps-b")
let head = mime.components(separatedBy: "\r\n\r\n")[0]
check("mime-from", head.contains("From: \"Sam Studio\" <studio@example.com>"))
check("mime-to", head.contains("To: \"Jane Doe\" <jane@northwind.example>"))
check("mime-subject-encoded", head.contains("Subject: =?UTF-8?B?\(Data("Re: Café menu".utf8).base64EncodedString())?="))
check("mime-in-reply-to", head.contains("In-Reply-To: <abc@mail.example>"))
check("mime-references", head.contains("References: <root@mail.example> <abc@mail.example>"))
check("mime-alternative", mime.contains("multipart/alternative; boundary=\"ps-b\"") && mime.contains("text/plain; charset=\"UTF-8\"") && mime.contains("text/html; charset=\"UTF-8\"") && mime.hasSuffix("--ps-b--\r\n"))
check("mime-crlf-only", !mime.replacingOccurrences(of: "\r\n", with: "").contains("\n"))
check("mime-body-text", mime.contains(Data("Hi Jane,\r\nOn it.".utf8).base64EncodedString()))
let inj = MailMime.build(from: "a@b.example", fromName: "X\r\nBcc: e@x.example", to: "c@d.example", toName: nil, subject: "Hi\nBcc: e@x.example", text: "t", html: "h",
                         inReplyTo: "<a@b>\r\nBcc: e@x.example", references: nil, date: Date(), boundary: "b")
check("mime-no-header-injection", !inj.components(separatedBy: "\r\n\r\n")[0].components(separatedBy: "\r\n").contains { $0.hasPrefix("Bcc:") })

// MARK: threading
let thread: [[String: String]] = [
  ["message-id": "<m1@northwind.example>", "from": "Jane Doe <jane@northwind.example>"],
  ["message-id": "<person8@mail.gmail.com>", "from": "Sam <studio@example.com>", "references": "<m1@northwind.example>"],
  ["message-id": "<m3@northwind.example>", "from": "Jane Doe <jane@northwind.example>", "references": "<m1@northwind.example> <person8@mail.gmail.com>", "reply-to": "Jane <jane.d@northwind.example>"],
  ["message-id": "<person9@mail.gmail.com>", "from": "studio@example.com", "references": "<m1@northwind.example> <person8@mail.gmail.com> <m3@northwind.example>"],
]
let t = MailThreading.pick(thread, own: "Studio@example.com")
check("thread-answers-their-newest", t.inReplyTo == "<m3@northwind.example>", "\(t)")
check("thread-references", t.references == "<m1@northwind.example> <person8@mail.gmail.com> <m3@northwind.example>", "\(String(describing: t.references))")
check("thread-reply-to", t.replyTo == "jane.d@northwind.example")
check("thread-none", MailThreading.pick([], own: "a@b.example").inReplyTo == nil)
check("thread-bad-id", MailThreading.pick([["message-id": "junk", "from": "x@y.example"]], own: "a@b.example").inReplyTo == nil)
let gt: [String: Any] = ["messages": [["payload": ["headers": [["name": "Message-ID", "value": "<q@x>"], ["name": "From", "value": "x@y.example"]]]]]]
check("thread-headers-parse", MailThreading.headers(fromThread: gt).first?["message-id"] == "<q@x>")

// MARK: the queue
var q = Outbox()
let a = OutJob.from(page(["id": "a", "sendAt": now + 10_000]), undo: true, now: now)!
let b = OutJob.from(page(["id": "b", "sendAt": now + 5 * 60_000]), undo: false, now: now)!
check("q-add", q.add(a) && q.add(b) && q.waiting == 2 && q.nextAt == now + 10_000)
check("q-nothing-due-yet", q.due(now: now + 9_000).isEmpty)
check("q-undo-in-time", q.takeBack("a", now: now + 5_000)?.id == "a" && q.job("a")?.state == .cancelled && q.waiting == 1)
check("q-undone-never-due", !q.due(now: now + 60_000).contains { $0.id == "a" })
check("q-due-on-time", q.due(now: now + 5 * 60_000).map(\.id) == ["b"])
check("q-sending", q.markSending("b") && q.job("b")?.state == .sending && q.job("b")?.tries == 1)
check("q-too-late-to-undo", q.takeBack("b", now: now) == nil)
check("q-not-twice", !q.markSending("b"))
check("q-same-id-after-sending-refused", !q.add(b))
q.markSent("b", now: now + 5 * 60_000)
check("q-sent", q.job("b")?.state == .sent && q.waiting == 0)
q.prune(now: now + 5 * 60_000 + Outbox.keepSent + 1)
check("q-prune", q.job("b") == nil && q.job("a") == nil)

var r = Outbox()
let c = OutJob.from(page(["id": "c", "sendAt": now]), undo: false, now: now)!
_ = r.add(c); _ = r.markSending("c")
r.markFailed("c", error: "offline: no network", retry: true, now: now)
check("q-retry-later", r.job("c")?.state == .queued && r.job("c")?.sendAt == now + Outbox.retryWaits[0])
for i in 0..<Outbox.retryWaits.count { _ = r.sendNow("c", now: now); _ = r.markSending("c"); r.markFailed("c", error: "offline", retry: true, now: now + Double(i)) }
check("q-gives-up", r.job("c")?.state == .failed, "\(String(describing: r.job("c")))")
check("q-send-now-after-fail", r.sendNow("c", now: now) && r.job("c")?.state == .queued && r.job("c")?.error == nil)
_ = r.markSending("c"); r.markFailed("c", error: "Gmail refused this email.", retry: false, now: now)
check("q-refused-waits-for-red", r.job("c")?.state == .failed)

var s = Outbox()
let d = OutJob.from(page(["id": "d", "sendAt": now + 60_000]), undo: false, now: now)!
_ = s.add(d); _ = s.markSending("d")
s.afterRestart(now: now + 70_000)
check("q-restart-never-resends", s.job("d")?.state == .failed && (s.job("d")?.error ?? "").contains("Sent folder") && s.due(now: now + 99_000_000).isEmpty)
var u = Outbox()
_ = u.add(OutJob.from(page(["id": "e", "sendAt": now + 10_000]), undo: true, now: now)!)
u.afterRestart(now: now + 20_000)
check("q-restart-keeps-a-send", u.job("e")?.state == .queued && u.job("e")?.undo == false && u.due(now: now + 20_000).map(\.id) == ["e"])

var w = Outbox()
_ = w.add(OutJob.from(page(["id": "f", "sendAt": now + 3 * 60_000]), undo: false, now: now)!)
check("q-short-sleep-sends-on-wake", w.due(now: now + 3 * 60_000 + 20 * 60_000).map(\.id) == ["f"])
var x = Outbox()
_ = x.add(OutJob.from(page(["id": "g", "sendAt": now + 3 * 60_000]), undo: false, now: now)!)
check("q-long-sleep-held", x.due(now: now + 3 * 60_000 + Outbox.lateLimit + 1).isEmpty && x.job("g")?.state == .failed && (x.job("g")?.error ?? "").hasPrefix("Missed"))
var ed = Outbox()
_ = ed.add(OutJob.from(page(["id": "h", "sendAt": now + 30 * 60_000]), undo: false, now: now)!)
let back = ed.takeBack("h", now: now)
var again = back!; again.sendAt = now + 15 * 60_000; again.state = .queued
check("q-edit-replaces", back != nil && ed.add(again) && ed.job("h")?.sendAt == now + 15 * 60_000 && ed.waiting == 1)
// A random time from Send (picked once by the page): the queue keeps it through early and late wakes and a restart.
var rnd = Outbox()
let picked = now + 9 * 60_000 + 17_000
_ = rnd.add(OutJob.from(page(["id": "r", "sendAt": picked]), undo: false, now: now)!)
_ = rnd.due(now: now + 60_000); rnd.afterRestart(now: now + 120_000); rnd.prune(now: now + 180_000)
check("q-random-time-never-picked-again", rnd.job("r")?.sendAt == picked && rnd.nextAt == picked && rnd.due(now: picked - 1).isEmpty && rnd.due(now: picked).map(\.id) == ["r"])
let qrow = rnd.rows.first ?? [:]
check("q-row-says-where", qrow["account"] as? String == "studio@example.com" && qrow["to"] as? String == "jane@northwind.example" && qrow["subject"] as? String == "Re: Homepage draft" && qrow["toName"] as? String == "Jane Doe")
check("q-codable", (try? JSONDecoder().decode(Outbox.self, from: JSONEncoder().encode(ed))) == ed)

// MARK: Gmail against a fake
let fakeG = FakeHTTP()
fakeG.answers = [(200, json(["messages": [["payload": ["headers": [["name": "Message-ID", "value": "<m9@northwind.example>"], ["name": "From", "value": "Jane <jane@northwind.example>"]]]]]]), nil),
                 (200, json(["id": "sent1", "threadId": "t123"]), nil)]
var tokenAsked: [String] = []
let gs = GmailSender(http: fakeG, fromName: { _ in "Sam Studio" }) { acct, done in tokenAsked.append(acct); done(.success("fake-token")) }
var got: SendResult?
gs.send(j!) { got = $0 }
check("gmail-sent", got == .sent("sent1"), "\(String(describing: got))")
check("gmail-token-for-the-account", tokenAsked == ["studio@example.com"])
check("gmail-thread-first", fakeG.asked.count == 2 && fakeG.asked[0].httpMethod == "GET" && fakeG.asked[0].url!.absoluteString.contains("/threads/t123?format=metadata"))
let sb = body(fakeG.asked[1])
let raw = unb64url(sb["raw"] as? String ?? "")
check("gmail-send-same-thread", fakeG.asked[1].url == MailEndpoints.gmailSend && sb["threadId"] as? String == "t123")
check("gmail-headers", raw.contains("In-Reply-To: <m9@northwind.example>") && raw.contains("References: <m9@northwind.example>") && raw.contains("From: \"Sam Studio\" <studio@example.com>") && raw.contains("Subject: Re: Homepage draft"))
check("gmail-bearer", fakeG.asked[1].value(forHTTPHeaderField: "Authorization") == "Bearer fake-token")
let fakeG2 = FakeHTTP(); fakeG2.answers = [(200, json(["messages": []]), nil), (503, nil, nil)]
var got2: SendResult?
GmailSender(http: fakeG2) { _, d in d(.success("t")) }.send(j!) { got2 = $0 }
check("gmail-5xx-retries", got2 == .failed("Gmail did not take it (503).", retry: true), "\(String(describing: got2))")
let fakeG3 = FakeHTTP(); fakeG3.answers = [(200, json(["messages": []]), nil), (0, nil, "timeout: the answer never came")]
var got3: SendResult?
GmailSender(http: fakeG3) { _, d in d(.success("t")) }.send(j!) { got3 = $0 }
check("gmail-lost-answer-waits-for-red", got3 == .failed("timeout: the answer never came", retry: false))
let fakeG4 = FakeHTTP()
var got4: SendResult?
GmailSender(http: fakeG4) { _, d in d(.failure(MailTokenError(text: "Sign in again", retry: false))) }.send(j!) { got4 = $0 }
check("gmail-no-sign-in-no-request", got4 == .failed("Sign in again", retry: false) && fakeG4.asked.isEmpty)

// MARK: send-as address (From the address the email came to)
let ja = OutJob.from(page(["replyFrom": "Work@Example.com"]), undo: false, now: now)!
check("alias-kept-lower", ja.replyFrom == "work@example.com" && ja.fromAddress == "work@example.com")
check("alias-same-as-account-is-none", OutJob.from(page(["replyFrom": "studio@example.com"]), undo: false, now: now)?.replyFrom == nil)
check("alias-junk-is-none", OutJob.from(page(["replyFrom": "x@y.example\r\nBcc: e@x.example"]), undo: false, now: now)?.replyFrom == nil)
check("alias-not-an-address-is-none", OutJob.from(page(["replyFrom": "not an email"]), undo: false, now: now)?.fromAddress == "studio@example.com")
check("alias-instantly-ignored", OutJob.from(page(["via": "instantly", "emailId": "e1", "replyFrom": "work@example.com"]), undo: false, now: now)?.replyFrom == nil)
check("alias-old-job-decodes", (try? JSONDecoder().decode(OutJob.self, from: JSONEncoder().encode(j!)))?.fromAddress == "studio@example.com")
check("alias-codable", (try? JSONDecoder().decode(OutJob.self, from: JSONEncoder().encode(ja)))?.replyFrom == "work@example.com")
let fakeA = FakeHTTP()
fakeA.answers = [(200, json(["messages": [["payload": ["headers": [["name": "Message-ID", "value": "<m9@northwind.example>"], ["name": "From", "value": "Jane <jane@northwind.example>"]]]]]]), nil), (200, json(["id": "sentA"]), nil)]
var gotA: SendResult?
GmailSender(http: fakeA, fromName: { _ in "Sam Studio" }) { _, d in d(.success("t")) }.send(ja) { gotA = $0 }
let rawA = unb64url(body(fakeA.asked[1])["raw"] as? String ?? "")
check("alias-from-header", gotA == .sent("sentA") && rawA.contains("From: \"Sam Studio\" <work@example.com>") && !rawA.contains("studio@example.com"))
// Gmail refuses the alias (400): never re-sent From the account (a client reply must come from the address they wrote to).
let fakeB = FakeHTTP()
fakeB.answers = [(200, json(["messages": []]), nil), (400, nil, nil), (200, json(["id": "sentB"]), nil)]
var gotB: SendResult?
GmailSender(http: fakeB) { _, d in d(.success("t")) }.send(ja) { gotB = $0 }
if case .failed(let m, let r)? = gotB { check("alias-400-stops-no-account-resend", fakeB.asked.count == 2 && !r && m.contains("Send mail as") && m.contains(ja.fromAddress), m) } else { check("alias-400-stops-no-account-resend", false, "\(String(describing: gotB))") }
let fakeD = FakeHTTP(); fakeD.answers = [(200, json(["messages": []]), nil), (400, nil, nil)]
var gotD: SendResult?
GmailSender(http: fakeD) { _, d in d(.success("t")) }.send(j!) { gotD = $0 }
check("no-alias-400-no-second-try", gotD == .failed("Gmail refused this email.", retry: false) && fakeD.asked.count == 2)
// Threading: the developer's own earlier reply from the alias is not the email answered.
let pk = MailThreading.pick([["message-id": "<a@n.example>", "from": "Jane <jane@northwind.example>"], ["message-id": "<b@e.example>", "from": "Sam <work@example.com>"]], own: "studio@example.com", alsoOwn: "work@example.com")
check("pick-skips-own-alias-reply", pk.inReplyTo == "<a@n.example>")

// MARK: Instantly against a fake
let lead = OutJob.from(page(["id": "l1", "cardId": "n:email-9", "via": "instantly", "account": "ann@outreach.example", "threadId": NSNull(), "emailId": "email-9"]), undo: false, now: now)!
let fakeI = FakeHTTP(); fakeI.answers = [(200, json(["id": "r-1"]), nil)]
var gotI: SendResult?
InstantlySender(http: fakeI) { "fake-key" }.send(lead) { gotI = $0 }
let ib = body(fakeI.asked.first ?? URLRequest(url: URL(string: "about:blank")!))
check("instantly-sent", gotI == .sent("r-1"))
check("instantly-endpoint", fakeI.asked.first?.url == MailEndpoints.instantlyReply && fakeI.asked.first?.httpMethod == "POST")
check("instantly-payload", ib["eaccount"] as? String == "ann@outreach.example" && ib["reply_to_uuid"] as? String == "email-9" && ib["subject"] as? String == "Re: Homepage draft"
      && (ib["body"] as? [String: Any])?["text"] as? String == "Hi Jane,\n\nOn it.\n")
check("instantly-bearer", fakeI.asked.first?.value(forHTTPHeaderField: "Authorization") == "Bearer fake-key")
let fakeI2 = FakeHTTP()
var gotI2: SendResult?
InstantlySender(http: fakeI2) { nil }.send(lead) { gotI2 = $0 }
check("instantly-no-key-no-request", fakeI2.asked.isEmpty && gotI2 == .failed("Add your Instantly API key in Settings, Reply from PS app.", retry: false))
let fakeI3 = FakeHTTP(); fakeI3.answers = [(401, nil, nil)]
var gotI3: SendResult?
InstantlySender(http: fakeI3) { "k" }.send(lead) { gotI3 = $0 }
check("instantly-401", gotI3 == .failed("Instantly said no to the key (it may need the right to send).", retry: false))

// MARK: Google sign in pieces
let file = json(["installed": ["client_id": "123-abc.apps.googleusercontent.com", "client_secret": "fake-secret"]])
check("oauth-client-file", GmailOAuth.client(fromFile: file)?.id == "123-abc.apps.googleusercontent.com")
check("oauth-client-bad", GmailOAuth.client(fromFile: json(["x": 1])) == nil)
let u2 = GmailOAuth.authURL(clientId: "cid", redirect: "http://127.0.0.1:5555/cb", challenge: "ch", state: "st", account: "studio@example.com")!.absoluteString
check("oauth-url", u2.hasPrefix("https://accounts.google.com/o/oauth2/v2/auth?") && u2.contains("gmail.send") && u2.contains("gmail.metadata") && u2.contains("code_challenge_method=S256")
      && u2.contains("login_hint=studio@example.com") && u2.contains("access_type=offline") && !u2.contains("gmail.readonly") && !u2.contains("mail.google.com"))
let payload = MailMime.base64url(json(["email": "Studio@example.com", "email_verified": true, "name": "Sam Studio"]))
check("oauth-identity", GmailOAuth.identity(idToken: "h.\(payload).s")?.email == "studio@example.com" && GmailOAuth.identity(idToken: "h.\(payload).s")?.name == "Sam Studio")
check("oauth-identity-bad", GmailOAuth.identity(idToken: "nonsense") == nil)
let sec = MailSecrets(gmail: ["a@b.example": GmailCred(clientId: "c", clientSecret: "s", refresh: "r", name: nil)], clients: [:], instantly: "k")
check("secrets-codable", (try? JSONDecoder().decode(MailSecrets.self, from: JSONEncoder().encode(sec))) == sec)

print("\n\(count - fails) of \(count) ok")
exit(fails == 0 ? 0 : 1)
