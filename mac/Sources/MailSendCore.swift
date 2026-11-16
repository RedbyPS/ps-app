// Reply from PS (V1.44), the parts with no AppKit and no network of their own, so tests/mailsend-test.swift runs them
// with fake Gmail and Instantly clients and never sends anything. The app's half is MailSend.swift.
//
// The developer's permission (8 Nov 2026): "I give PS permission to send emails for me", ONLY for replies he types and sends or
// schedules himself in PS. So nothing here can start a send: a job exists only because the compose window handed one
// over after his click on Send or Schedule (web src/views/ReplyWindow.tsx). There are no auto replies.
// A send that may or may not have gone out (PS stopped half way) is never sent again by itself: it waits for the developer.
import Foundation

// MARK: - the job

/// One reply waiting to go (or gone). The same fields as web src/core/mailreply.ts ReplyJob, plus its state.
struct OutJob: Codable, Equatable {
  enum State: String, Codable { case queued, sending, sent, failed, cancelled }
  var id: String
  var cardId: String
  var via: String            // "gmail" or "instantly"
  var account: String        // From
  var to: String
  var toName: String?
  var subject: String
  var text: String
  var html: String
  var threadId: String?
  var emailId: String?       // Instantly: reply_to_uuid
  var sendAt: Double         // ms since 1970
  var createdAt: Double
  var draft: String          // the compose screen's own state (JSON), for Edit and Undo; never logged
  var undo: Bool = false     // Send with the Undo window (not a scheduled send)
  var state: State = .queued
  var tries: Int = 0
  var error: String?
  var doneAt: Double?
  /// Gmail: a send-as address of `account` to put in From (the email came to it). Nil: From the account.
  var replyFrom: String? = nil

  /// The address in From: the send-as address when the page gave a plain valid one, else the account.
  var fromAddress: String { OutJob.cleanReplyFrom(replyFrom, account: account) ?? account }
  /// A plain valid address that is not the account itself, lower case; anything else is nil.
  static func cleanReplyFrom(_ v: String?, account: String) -> String? {
    guard let a = v?.trimmingCharacters(in: .whitespaces).lowercased(), a.count <= 254, MailMime.validEmail(a), a != account.lowercased() else { return nil }
    return a
  }

  /// Checks a job the page handed over. Nil when anything is off (it crossed from a web page).
  static func from(_ o: [String: Any], undo: Bool, now: Double) -> OutJob? {
    func s(_ k: String, _ max: Int) -> String? { (o[k] as? String).map { String($0.prefix(max)) } }
    guard let id = s("id", 40), id.range(of: #"^[\w-]{1,40}$"#, options: .regularExpression) != nil,
          let cardId = s("cardId", 40), cardId.range(of: #"^[mn]:[\w-]{1,38}$"#, options: .regularExpression) != nil,
          let via = s("via", 10), via == "gmail" || via == "instantly",
          let account = s("account", 254).map({ $0.lowercased() }), MailMime.validEmail(account),
          let to = s("to", 254)?.trimmingCharacters(in: .whitespaces), MailMime.validEmail(to),
          let subject = s("subject", 300), let text = s("text", 60_000), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let html = s("html", 200_000), let sendAt = (o["sendAt"] as? NSNumber)?.doubleValue, sendAt.isFinite else { return nil }
    let threadId = s("threadId", 120).flatMap { $0.isEmpty ? nil : $0 }, emailId = s("emailId", 120).flatMap { $0.isEmpty ? nil : $0 }
    if via == "gmail" && threadId == nil { return nil }
    if via == "instantly" && emailId == nil { return nil }
    // 7 days ahead at most (the page's limit too); a time in the past means now.
    guard sendAt <= now + 7 * 24 * 3600_000 + 60_000 else { return nil }
    let draft = (o["draft"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return OutJob(id: id, cardId: cardId, via: via, account: account, to: to, toName: s("toName", 120).map { MailMime.oneLine($0) },
                  subject: MailMime.oneLine(subject), text: text, html: html, threadId: threadId, emailId: emailId,
                  sendAt: max(now, sendAt), createdAt: now, draft: draft.count <= 400_000 ? draft : "{}", undo: undo,
                  replyFrom: via == "gmail" ? cleanReplyFrom(s("replyFrom", 254), account: account) : nil)
  }

  /// What the page shows in the pill and the queue (never the words of the reply).
  var row: [String: Any] {
    var r: [String: Any] = ["id": id, "cardId": cardId, "via": via, "account": account, "to": to, "subject": subject, "sendAt": sendAt, "state": state.rawValue, "undo": undo]
    if let toName { r["toName"] = toName }
    if let error { r["error"] = error }
    return r
  }
  /// The job as the compose window opens it again (Edit, Undo): the page's own fields and its draft.
  var page: [String: Any] {
    var p: [String: Any] = ["id": id, "cardId": cardId, "via": via, "account": account, "to": to, "subject": subject, "text": text, "html": html,
                            "sendAt": sendAt, "createdAt": createdAt]
    if let toName { p["toName"] = toName }
    if let threadId { p["threadId"] = threadId }
    if let emailId { p["emailId"] = emailId }
    if let d = draft.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) { p["draft"] = o }
    return p
  }
  /// One line for PS's log: time (the log adds it), account, to, subject. Never the words of the reply.
  var logLine: String { "via \(via) from \(account) to \(to) subject \"\(subject.prefix(120))\"" }
}

// MARK: - the queue (one per Mac, kept in the Keychain by MailSend.swift)

/// The queue's rules: when a job is due, Undo, Cancel, Send now, Edit, retries, what a restart does, what is kept.
struct Outbox: Codable, Equatable {
  private(set) var jobs: [OutJob] = []

  static let maxJobs = 50
  /// A send that failed on the way (no network yet after a wake, Google busy) is tried again after these waits.
  static let retryWaits: [Double] = [20_000, 60_000, 180_000, 600_000]
  /// The Mac asleep longer than this past the time: it does not go by itself; the developer sees it and can Send now.
  static let lateLimit: Double = 6 * 3600_000
  /// Kept in the list after they are done, so the pill can say Sent (and a failure stays until the developer sees it).
  static let keepSent: Double = 10 * 60_000, keepFailed: Double = 3 * 24 * 3600_000

  /// A new job (from Send or Schedule). An Edit or Undo hands the same id back: it replaces the old one.
  mutating func add(_ j: OutJob) -> Bool {
    if let i = jobs.firstIndex(where: { $0.id == j.id }) {
      guard jobs[i].state != .sending && jobs[i].state != .sent else { return false }   // gone already: never twice
      jobs[i] = j; return true
    }
    guard jobs.filter({ $0.state == .queued || $0.state == .sending }).count < Outbox.maxJobs else { return false }
    jobs.append(j); return true
  }
  /// Undo, Cancel or Edit: taken off the schedule if it has not started going. The job, for the page to open again.
  mutating func takeBack(_ id: String, now: Double) -> OutJob? {
    guard let i = jobs.firstIndex(where: { $0.id == id }), jobs[i].state == .queued || jobs[i].state == .failed else { return nil }
    let j = jobs[i]
    jobs[i].state = .cancelled; jobs[i].doneAt = now
    return j
  }
  /// Send now: due at once (a failed one too, which is the developer's own "try again").
  mutating func sendNow(_ id: String, now: Double) -> Bool {
    guard let i = jobs.firstIndex(where: { $0.id == id }), jobs[i].state == .queued || jobs[i].state == .failed else { return false }
    jobs[i].sendAt = now; jobs[i].state = .queued; jobs[i].error = nil; jobs[i].undo = false
    return true
  }
  /// The jobs to send now, oldest time first. Long overdue ones (the Mac slept through) are held for the developer instead.
  mutating func due(now: Double) -> [OutJob] {
    var out: [OutJob] = []
    for i in jobs.indices where jobs[i].state == .queued && jobs[i].sendAt <= now {
      if now - jobs[i].sendAt > Outbox.lateLimit && jobs[i].tries == 0 {
        jobs[i].state = .failed; jobs[i].doneAt = now
        jobs[i].error = "Missed: the Mac was off or asleep at \(MailMime.hhmm(jobs[i].sendAt)). Send now if it still fits."
        continue
      }
      out.append(jobs[i])
    }
    return out.sorted { $0.sendAt < $1.sendAt }
  }
  /// Marked before anything leaves, and saved: a PS that stops half way never sends it a second time by itself.
  mutating func markSending(_ id: String) -> Bool {
    guard let i = jobs.firstIndex(where: { $0.id == id }), jobs[i].state == .queued else { return false }
    jobs[i].state = .sending; jobs[i].tries += 1
    return true
  }
  mutating func markSent(_ id: String, now: Double) {
    guard let i = jobs.firstIndex(where: { $0.id == id }) else { return }
    jobs[i].state = .sent; jobs[i].doneAt = now; jobs[i].error = nil
  }
  /// A send that did not go. `retry`: it surely did not reach Google or Instantly (no network, a 5xx, a 429), so it is
  /// tried again later by itself. Otherwise (refused, signed out) it waits for the developer.
  mutating func markFailed(_ id: String, error: String, retry: Bool, now: Double) {
    guard let i = jobs.firstIndex(where: { $0.id == id }) else { return }
    let n = jobs[i].tries
    if retry && n <= Outbox.retryWaits.count {
      jobs[i].state = .queued; jobs[i].sendAt = now + Outbox.retryWaits[max(0, n - 1)]; jobs[i].error = error; jobs[i].undo = false
    } else {
      jobs[i].state = .failed; jobs[i].error = error; jobs[i].doneAt = now
    }
  }
  /// After PS starts again: a job caught half way may have gone. It is never sent again by itself.
  mutating func afterRestart(now: Double) {
    for i in jobs.indices where jobs[i].state == .sending {
      jobs[i].state = .failed; jobs[i].doneAt = now
      jobs[i].error = "PS app stopped while sending. Look in your Sent folder before you send it again."
    }
    // An Undo window that ran out while PS was not running: it was the developer's Send, so it goes now (within lateLimit).
    for i in jobs.indices where jobs[i].state == .queued && jobs[i].undo { jobs[i].undo = false }
  }
  /// Old done ones go.
  mutating func prune(now: Double) {
    jobs.removeAll { j in
      guard let d = j.doneAt else { return false }
      switch j.state {
      case .sent, .cancelled: return now - d > Outbox.keepSent
      case .failed: return now - d > Outbox.keepFailed
      default: return false
      }
    }
  }
  mutating func dismiss(_ id: String) { jobs.removeAll { $0.id == id && ($0.state == .failed || $0.state == .sent || $0.state == .cancelled) } }

  func job(_ id: String) -> OutJob? { jobs.first { $0.id == id } }
  /// When the next job is due (ms), or nil.
  var nextAt: Double? { jobs.filter { $0.state == .queued }.map(\.sendAt).min() }
  var waiting: Int { jobs.filter { $0.state == .queued || $0.state == .sending }.count }
  var rows: [[String: Any]] { jobs.filter { $0.state != .cancelled }.map(\.row) }
}

// MARK: - the email itself

enum MailMime {
  static func validEmail(_ s: String) -> Bool {
    s.count <= 254 && s.range(of: #"^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$"#, options: .regularExpression) != nil
  }
  /// One line, no control characters: a header can never be split in two (no header injection).
  static func oneLine(_ s: String) -> String {
    let cleaned = s.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
    return cleaned.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
  }
  static func hhmm(_ ms: Double) -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm"; f.locale = Locale(identifier: "en_GB")
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
  }
  /// RFC 2047 for a header word with anything past plain ASCII.
  static func word(_ s: String) -> String {
    let t = oneLine(s)
    if t.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value < 127 }) { return t }
    return "=?UTF-8?B?\(Data(t.utf8).base64EncodedString())?="
  }
  /// "Jane Doe <person6@x.com>", the name quoted (or encoded) as needed.
  static func address(_ email: String, name: String?) -> String {
    let e = oneLine(email)
    guard let n = name.map(oneLine), !n.isEmpty, !n.contains("@") else { return e }
    let w = word(n.replacingOccurrences(of: "\"", with: "'"))
    return w.hasPrefix("=?") ? "\(w) <\(e)>" : "\"\(w)\" <\(e)>"
  }
  static func b64lines(_ s: String) -> String {
    let b = Data(s.utf8).base64EncodedString()
    var out = "", i = b.startIndex
    while i < b.endIndex { let j = b.index(i, offsetBy: 76, limitedBy: b.endIndex) ?? b.endIndex; out += b[i..<j] + "\r\n"; i = j }
    return out
  }
  static func base64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// The whole email (RFC 5322, CRLF), plain text and HTML, in reply to `inReplyTo` with the thread's References.
  static func build(from: String, fromName: String?, to: String, toName: String?, subject: String, text: String, html: String,
                    inReplyTo: String?, references: String?, date: Date, boundary: String) -> String {
    let df = DateFormatter(); df.locale = Locale(identifier: "en_US_POSIX"); df.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
    var h: [String] = [
      "From: \(address(from, name: fromName))",
      "To: \(address(to, name: toName))",
      "Subject: \(word(subject))",
      "Date: \(df.string(from: date))",
      "MIME-Version: 1.0",
    ]
    if let r = inReplyTo.map(oneLine), !r.isEmpty { h.append("In-Reply-To: \(r)") }
    if let r = references.map(oneLine), !r.isEmpty { h.append("References: \(r)") }
    h.append("Content-Type: multipart/alternative; boundary=\"\(boundary)\"")
    let crlf = { (s: String) in s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r\n") }
    return h.joined(separator: "\r\n") + "\r\n\r\n" +
      "--\(boundary)\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n\(b64lines(crlf(text)))" +
      "--\(boundary)\r\nContent-Type: text/html; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n\(b64lines(html))" +
      "--\(boundary)--\r\n"
  }
}

// MARK: - threading

enum MailThreading {
  /// The message being answered, from the thread's messages (oldest first, each one's headers, names lower case):
  /// the newest one NOT from the sending account (their email, not the developer's own last reply). Its Message-ID becomes
  /// In-Reply-To, and its References plus that id become References, so the reply sits in the same thread for
  /// them too. Reply-To, when they set one, is where the reply should go.
  static func pick(_ messages: [[String: String]], own: String, alsoOwn: String? = nil) -> (inReplyTo: String?, references: String?, replyTo: String?) {
    let mine = [own.lowercased()] + (alsoOwn.map { [$0.lowercased()] } ?? [])   // the account and its send-as address
    let theirs = messages.last { m in !mine.contains { (m["from"] ?? "").lowercased().contains($0) } } ?? messages.last
    guard let m = theirs, let id = m["message-id"].map(MailMime.oneLine), id.hasPrefix("<"), id.hasSuffix(">") else { return (nil, nil, nil) }
    let refs = (m["references"].map(MailMime.oneLine) ?? "").split(separator: " ").map(String.init).filter { $0.hasPrefix("<") && $0.hasSuffix(">") }
    var all = refs.filter { $0 != id } + [id]
    if all.count > 20 { all = [all[0]] + all.suffix(19) }   // a very long thread: the first and the newest ones
    let replyTo = m["reply-to"].flatMap { r -> String? in
      let a = r.range(of: #"[^\s<>,;"]+@[^\s<>,;"]+"#, options: .regularExpression).map { String(r[$0]) }
      return a.flatMap { MailMime.validEmail($0) ? $0 : nil }
    }
    return (id, all.joined(separator: " "), replyTo)
  }
  /// Gmail's threads.get answer (format=metadata) -> each message's headers, names lower case.
  static func headers(fromThread json: [String: Any]) -> [[String: String]] {
    let msgs = json["messages"] as? [[String: Any]] ?? []
    return msgs.map { m in
      var h: [String: String] = [:]
      for x in ((m["payload"] as? [String: Any])?["headers"] as? [[String: Any]] ?? []) {
        if let n = x["name"] as? String, let v = x["value"] as? String { h[n.lowercased()] = v }
      }
      return h
    }
  }
}

// MARK: - talking to Gmail and Instantly (through a client the tests replace)

/// One HTTPS request. The app's client is URLSession (MailSend.swift); the tests' is a fake that records it.
protocol MailHTTP: AnyObject {
  func send(_ req: URLRequest, _ done: @escaping (_ status: Int, _ body: Data?, _ error: String?) -> Void)
}

/// What a finished send says: sent, or why not and whether trying again later can help.
enum SendResult: Equatable { case sent(String?), failed(String, retry: Bool) }

enum MailEndpoints {
  static let gmailSend = URL(string: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")!
  static func gmailThread(_ id: String) -> URL? {
    guard id.range(of: #"^[\w-]{1,120}$"#, options: .regularExpression) != nil else { return nil }
    return URL(string: "https://gmail.googleapis.com/gmail/v1/users/me/threads/\(id)?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject")
  }
  static let instantlyReply = URL(string: "https://api.instantly.ai/api/v2/emails/reply")!
}

/// Sends one Gmail reply: the thread's headers first (to thread it), then messages.send with the thread id.
/// `token` gives an access token for the account (the app refreshes it from the Keychain's sign in).
final class GmailSender {
  let http: MailHTTP
  let token: (_ account: String, _ done: @escaping (Result<String, MailTokenError>) -> Void) -> Void
  let fromName: (String) -> String?
  var now: () -> Date = { Date() }
  init(http: MailHTTP, fromName: @escaping (String) -> String? = { _ in nil }, token: @escaping (String, @escaping (Result<String, MailTokenError>) -> Void) -> Void) {
    self.http = http; self.token = token; self.fromName = fromName
  }

  func send(_ j: OutJob, _ done: @escaping (SendResult) -> Void) {
    token(j.account) { [self] t in
      switch t {
      case .failure(let e): done(.failed(e.text, retry: e.retry))
      case .success(let tok):
        guard let tid = j.threadId, let url = MailEndpoints.gmailThread(tid) else { done(.failed("PS app does not know the Gmail thread.", retry: false)); return }
        var r = URLRequest(url: url); r.httpMethod = "GET"; r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
        http.send(r) { [self] st, body, err in
          if let err { done(.failed(err, retry: true)); return }
          guard st == 200, let b = body, let json = (try? JSONSerialization.jsonObject(with: b)) as? [String: Any] else {
            done(.failed(st == 404 ? "Gmail cannot find this thread in \(j.account)." : st == 401 || st == 403 ? "Gmail said no (sign in again in Settings, Reply from PS app)." : "Gmail did not answer (\(st)).",
                         retry: st >= 500 || st == 429)); return
          }
          let th = MailThreading.pick(MailThreading.headers(fromThread: json), own: j.account, alsoOwn: j.replyFrom)
          // Google's docs do not say what Gmail does with a From that is not a verified send-as address of the signed in
          // account (it may rewrite it to the account's own address, or refuse with 400). A 400 with a send-as From is NOT
          // retried From the account: a reply to a client must come from the address they wrote to (the developer, 16 Nov
          // 2026), so it stops and says how to fix it (a 400 means nothing was sent).
          func attempt(_ from: String) {
            let mime = MailMime.build(from: from, fromName: fromName(j.account), to: j.to, toName: j.toName, subject: j.subject, text: j.text, html: j.html,
                                      inReplyTo: th.inReplyTo, references: th.references, date: now(), boundary: "ps-\(j.id.prefix(24))")
            guard let payload = try? JSONSerialization.data(withJSONObject: ["raw": MailMime.base64url(Data(mime.utf8)), "threadId": tid]) else { done(.failed("PS app could not build the email.", retry: false)); return }
            var s = URLRequest(url: MailEndpoints.gmailSend); s.httpMethod = "POST"; s.httpBody = payload
            s.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization"); s.setValue("application/json", forHTTPHeaderField: "Content-Type")
            http.send(s) { st2, body2, err2 in
              if let err2 { done(.failed(err2, retry: Self.unsentNetworkError(err2))); return }
              if (200..<300).contains(st2) {
                let id = (body2.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["id"] as? String
                done(.sent(id)); return
              }
              if st2 == 400 && from != j.account { done(.failed("Gmail would not send from \(from). Add it in Gmail, Settings, Accounts and Import, Send mail as, then try again.", retry: false)); return }
              done(.failed(st2 == 401 || st2 == 403 ? "Gmail said no (sign in again in Settings, Reply from PS app)." : st2 == 400 ? "Gmail refused this email." : "Gmail did not take it (\(st2)).",
                           retry: st2 >= 500 || st2 == 429))
            }
          }
          attempt(j.fromAddress)
        }
      }
    }
  }
  /// A network error from before the request reached Google (no connection, no DNS) is safe to try again; a lost
  /// answer after sending (a timeout) is not: it may have gone, so the developer decides.
  static func unsentNetworkError(_ e: String) -> Bool { e.hasPrefix("offline:") }
}

/// Sends one Instantly reply: POST /api/v2/emails/reply from the inbox the lead wrote to, to the email answered.
final class InstantlySender {
  let http: MailHTTP
  let key: () -> String?
  init(http: MailHTTP, key: @escaping () -> String?) { self.http = http; self.key = key }

  static func payload(_ j: OutJob) -> [String: Any] {
    ["eaccount": j.account, "reply_to_uuid": j.emailId ?? "", "subject": j.subject, "body": ["text": j.text, "html": j.html]]
  }
  func send(_ j: OutJob, _ done: @escaping (SendResult) -> Void) {
    guard let k = key(), !k.isEmpty else { done(.failed("Add your Instantly API key in Settings, Reply from PS app.", retry: false)); return }
    guard j.emailId != nil, let body = try? JSONSerialization.data(withJSONObject: Self.payload(j)) else { done(.failed("PS app does not know which Instantly email this answers.", retry: false)); return }
    var r = URLRequest(url: MailEndpoints.instantlyReply); r.httpMethod = "POST"; r.httpBody = body
    r.setValue("Bearer \(k)", forHTTPHeaderField: "Authorization"); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    http.send(r) { st, b, err in
      if let err { done(.failed(err, retry: GmailSender.unsentNetworkError(err))); return }
      if (200..<300).contains(st) { done(.sent((b.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["id"] as? String)); return }
      done(.failed(st == 401 || st == 403 ? "Instantly said no to the key (it may need the right to send)." : st == 404 ? "Instantly cannot find that email any more." : st == 400 ? "Instantly refused this reply." : "Instantly did not take it (\(st)).",
                   retry: st >= 500 || st == 429))
    }
  }
}

struct MailTokenError: Error, Equatable { var text: String; var retry: Bool }

// MARK: - the sign ins (kept in the Keychain by MailSend.swift; never logged, never in a page)

struct GmailCred: Codable, Equatable {
  var clientId: String
  var clientSecret: String
  var refresh: String
  var name: String?          // the account's own name from Google (for From), when it gave one
}
struct MailSecrets: Codable, Equatable {
  var gmail: [String: GmailCred] = [:]     // by account address (lower case)
  var clients: [String: [String: String]] = [:]   // Google OAuth client (id, secret) per account, from the developer's own file
  var instantly: String?
}

enum GmailOAuth {
  static let scopes = "openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata"
  /// Google's consent page (loopback, PKCE), for that account.
  static func authURL(clientId: String, redirect: String, challenge: String, state: String, account: String) -> URL? {
    var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    c.queryItems = [.init(name: "client_id", value: clientId), .init(name: "redirect_uri", value: redirect), .init(name: "response_type", value: "code"),
                    .init(name: "scope", value: scopes), .init(name: "code_challenge", value: challenge), .init(name: "code_challenge_method", value: "S256"),
                    .init(name: "state", value: state), .init(name: "access_type", value: "offline"), .init(name: "prompt", value: "consent"),
                    .init(name: "login_hint", value: account)]
    return c.url
  }
  /// The client id and secret in a Google Cloud OAuth client file ({"installed": {...}} or {"web": {...}}).
  static func client(fromFile d: Data) -> (id: String, secret: String)? {
    guard let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let c = (j["installed"] ?? j["web"]) as? [String: Any],
          let id = c["client_id"] as? String, id.hasSuffix(".apps.googleusercontent.com"), id.count < 200,
          let sec = c["client_secret"] as? String, !sec.isEmpty, sec.count < 200 else { return nil }
    return (id, sec)
  }
  /// The email and name inside Google's id_token (straight from Google's token endpoint over TLS, so not re-checked).
  static func identity(idToken: String) -> (email: String, name: String?)? {
    let parts = idToken.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var b = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b.count % 4 != 0 { b += "=" }
    guard let d = Data(base64Encoded: b), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let e = j["email"] as? String, MailMime.validEmail(e), (j["email_verified"] as? Bool) != false else { return nil }
    return (e.lowercased(), (j["name"] as? String).map(MailMime.oneLine))
  }
}
