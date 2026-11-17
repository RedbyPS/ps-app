// Second Computer, Outsource: code jobs (PS 1.65). The rules that need no app: what a sealed "code" job may ask for (the
// owner's outsource body, SecondOutsource.swift SecondOJob.check, hands kind "code" here), the AI tool's own flags and
// sandbox, the git walls against pushing, secrets kept out of logs and results, and the sealed bundle's file format.
// Foundation and CryptoKit only, so mac/tests/secondcode-test.sh compiles it alone with SecondCodeRunner.swift.
// The envelope (signature, sealing, expiry, replays) is the owner's protocol and was checked before anything here runs.
import CryptoKit
import Foundation

/// A code job as the sealed outsource body carries it: {kind: "code", title, prompt, repo, base, tool, model?, minutes?, shots?}.
struct SecondCodeJob: Equatable {
  var id: String
  var title: String
  var repo: String          // a folder name the other Mac has (its Projects folder or Second Computer's own copy), or a git URL
  var base: String          // a commit (or a branch name there)
  var prompt: String
  var tool: String          // "claude" or "codex"
  var model: String?        // claude only: opus or sonnet
  var minutes: Int
  var shots: Bool

  static let maxPrompt = 20_000, defaultMinutes = 30, maxMinutes = 240
  static let keys: Set<String> = ["kind", "title", "prompt", "repo", "base", "tool", "model", "minutes", "shots"]

  /// The job, or the plain reason it may not run. `id` is the envelope's own job id.
  static func check(_ p: [String: Any], id: String) -> (SecondCodeJob?, String?) {
    func no(_ w: String) -> (SecondCodeJob?, String?) { (nil, w) }
    guard p["kind"] as? String == "code", Set(p.keys).isSubset(of: keys) else { return no("Bad arguments") }
    guard OutSafe.idOk(id) else { return no("Bad arguments") }
    guard let title = p["title"] as? String, !title.trimmingCharacters(in: .whitespaces).isEmpty, title.count <= 80, !title.contains("\n") else { return no("Bad arguments") }
    guard let prompt = p["prompt"] as? String, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.count <= maxPrompt else { return no("Bad arguments") }
    guard let repo = p["repo"] as? String, OutSafe.repoOk(repo) else { return no("The repo must be a folder name or a git link without a name or password") }
    guard let base = p["base"] as? String, OutSafe.baseOk(base) else { return no("Bad arguments") }
    let tool = (p["tool"] as? String) ?? "claude"
    guard tool == "claude" || tool == "codex" else { return no("Bad arguments") }
    var model: String?
    if let m = p["model"] { guard tool == "claude", let m = m as? String, ["opus", "sonnet"].contains(m) else { return no("Bad arguments") }; model = m }
    var minutes = defaultMinutes
    if let m = p["minutes"] {
      guard let n = m as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(), n.intValue >= 5, n.intValue <= maxMinutes else { return no("Bad arguments") }
      minutes = n.intValue
    }
    var shots = false
    if let s = p["shots"] { guard let n = s as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return no("Bad arguments") }; shots = n.boolValue }
    if OutSecrets.looksSecret(prompt) || OutSecrets.looksSecret(title) || OutSecrets.looksSecret(repo) { return no("It looks like it holds a secret. Nothing secret may go to the other Mac.") }
    return (SecondCodeJob(id: id, title: title, repo: repo, base: base, prompt: prompt, tool: tool, model: model, minutes: minutes, shots: shots), nil)
  }
}

enum OutSafe {
  /// Letters, digits, dash, underscore, 4 to 64. The id becomes a folder and a branch name.
  static func idOk(_ s: String) -> Bool {
    s.count >= 4 && s.count <= 64 && s.unicodeScalars.allSatisfy { ($0.value < 128) && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_") }
  }
  /// A folder name (no slash, no dots only) or a git URL without credentials. Never file:// or ext:: (git runs commands for ext::).
  static func repoOk(_ s: String) -> Bool {
    guard !s.isEmpty, s.count <= 300, !s.contains(" "), !s.contains("\n"), s.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }) else { return false }
    if folderName(s) { return true }
    if s.hasPrefix("https://") {
      guard let u = URL(string: s), let h = u.host, !h.isEmpty, u.user == nil, u.password == nil, u.query == nil else { return false }
      return !s.contains("@")
    }
    if s.hasPrefix("ssh://git@") { return !s.dropFirst(10).contains("@") }
    if s.hasPrefix("git@") { return s.dropFirst(4).contains(":") && !s.dropFirst(4).contains("@") && !s.contains("::") }
    return false
  }
  static func folderName(_ s: String) -> Bool {
    !s.isEmpty && s.count <= 100 && !s.hasPrefix(".") && !s.hasPrefix("-") && !s.contains("..") &&
      s.unicodeScalars.allSatisfy { $0.value < 128 && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" || $0 == ".") }
  }
  /// A commit hash (4 to 40 hex) or a branch name of safe characters. Never starts with a dash.
  static func baseOk(_ s: String) -> Bool {
    guard !s.isEmpty, s.count <= 100, !s.hasPrefix("-"), !s.hasPrefix("/"), !s.contains(".."), !s.hasSuffix("/"), !s.hasSuffix(".lock") else { return false }
    return s.unicodeScalars.allSatisfy { $0.value < 128 && (CharacterSet.alphanumerics.contains($0) || "-_./".unicodeScalars.contains($0)) }
  }
  /// The folder name a repo gets in Second Computer's own copies.
  static func cloneName(_ repo: String) -> String {
    if folderName(repo) { return repo }
    var last = repo.split(whereSeparator: { $0 == "/" || $0 == ":" }).last.map(String.init) ?? "repo"
    if last.hasSuffix(".git") { last.removeLast(4) }
    let clean = String(last.unicodeScalars.filter { $0.value < 128 && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" || $0 == ".") }.map(Character.init))
    var h: UInt32 = 5381
    for b in repo.utf8 { h = (h &* 33) &+ UInt32(b) }   // two repos with one last name stay apart
    return (clean.isEmpty || clean.hasPrefix(".") ? "repo" : clean) + "-" + String(h, radix: 16)
  }
}

enum OutSecrets {
  private static let patterns: [String] = [
    #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"#,
    #"\bsk-[A-Za-z0-9_-]{16,}"#, #"\bsb_secret_[A-Za-z0-9_-]{8,}"#, #"\bghp_[A-Za-z0-9]{20,}"#, #"\bgithub_pat_[A-Za-z0-9_]{20,}"#,
    #"\bgh[osu]_[A-Za-z0-9]{20,}"#, #"\bAKIA[0-9A-Z]{12,}"#, #"\bxox[abprs]-[A-Za-z0-9-]{10,}"#,
    #"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.?[A-Za-z0-9_-]*"#,
    #"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"#,
    #"(?i)\b[A-Za-z0-9_]*(password|passwd|secret|token|api[_-]?key|apikey|auth)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"',;]{6,}"#,
    #"(?i)https?://[^\s/:@]+:[^\s/@]+@"#,
  ]
  private static let regexes: [NSRegularExpression] = patterns.compactMap { try? NSRegularExpression(pattern: $0) }

  /// Only the unmistakable ones (keys, tokens, private key blocks): used on a whole diff, where a test's "password: x" is normal.
  private static let strong: [NSRegularExpression] = Array(regexes.prefix(9))
  static func looksStrongSecret(_ s: String) -> Bool {
    let r = NSRange(s.startIndex..., in: s)
    return strong.contains { $0.firstMatch(in: s, range: r) != nil }
  }
  static func looksSecret(_ s: String) -> Bool {
    let r = NSRange(s.startIndex..., in: s)
    return regexes.contains { $0.firstMatch(in: s, range: r) != nil }
  }
  /// Every secret looking piece replaced; the rest stays. Also the home folder name, so a log never carries a person's name.
  static func strip(_ s: String, home: String? = NSHomeDirectory()) -> String {
    var out = s
    for re in regexes { out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "[removed]") }
    if let h = home, h.count > 3 { out = out.replacingOccurrences(of: h, with: "~") }
    return out
  }
  /// The last `n` characters, cut at a line start, then stripped.
  static func tail(_ s: String, _ n: Int = 6000, home: String? = NSHomeDirectory()) -> String {
    var t = s
    if t.count > n {
      t = String(t.suffix(n))
      if let i = t.firstIndex(of: "\n") { t = String(t[t.index(after: i)...]) }
    }
    return strip(t, home: home)
  }
}

/// What the AI tool may and may not do. Four walls, each enough on its own for the usual case:
///  1. the CLI's own rules: Claude Code with --strict-mcp-config (no MCP servers), --safe-mode where it has it (none of the
///     person's hooks, plugins or CLAUDE.md), its sandbox (writes only in the job folder, no network but package registries,
///     no way out) and deny rules for push, deploy and send tools; Codex `workspace-write` with the network off and no MCP servers;
///  2. git itself: no transport at all (GIT_ALLOW_PROTOCOL names none), no system or global config (no saved passwords), ssh
///     replaced by a stand in that refuses, a push URL that goes nowhere, push.default nothing;
///  3. a pre-push hook that always refuses;
///  4. refusing stand ins for gh and deploy tools first on PATH, and tokens dropped from the environment.
/// The result is checked too: a bundle that adds a secret looking file or a key or token line stays on the other Mac.
enum OutPolicy {
  static let denyBash = ["git push", "git remote", "git config", "git credential", "gh", "hub", "vercel", "netlify", "wrangler", "firebase", "fly", "flyctl", "heroku",
                         "railway", "supabase", "aws", "gcloud", "az", "kubectl", "terraform", "pulumi", "scp", "rsync", "sftp",
                         "curl", "wget", "ssh", "sudo", "npm publish", "pnpm publish", "yarn publish", "twine", "docker push", "cargo publish", "gem push",
                         "security", "osascript", "open", "mail", "sendmail", "say"]
  /// Names a refusing stand in is made for (they sit first on the PATH the AI runs with).
  static let shimmed = ["gh", "hub", "vercel", "netlify", "wrangler", "firebase", "fly", "flyctl", "heroku", "railway", "supabase",
                        "aws", "gcloud", "kubectl", "terraform", "pulumi", "scp", "sftp", "ssh", "sudo", "security", "osascript", "twine", "sendmail", "mail"]
  static let envDrop = ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                        "AWS_SESSION_TOKEN", "VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN", "FLY_API_TOKEN", "SSH_AUTH_SOCK",
                        "SUPABASE_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "HEROKU_API_KEY", "DOCKER_CONFIG", "GIT_ASKPASS", "SSH_ASKPASS",
                        "TWINE_PASSWORD", "CARGO_REGISTRY_TOKEN", "PYPI_TOKEN", "SENTRY_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
  /// The package registries a job may still download from (builds and tests need them). Publishing needs a token, and none is passed.
  static let registries = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"]
  /// Files the AI may not even read.
  static let noRead = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.docker/**", "~/.kube/**", "~/.config/gh/**",
                       "~/.git-credentials", "~/Library/Keychains/**", "~/Library/Application Support/PS/**", "~/Library/Group Containers/**"]
  /// The Claude Code flags the runner looks for in `claude --help` (the owner's research runner reads them the same way).
  static let flagNames = ["--allowedTools", "--disallowedTools", "--strict-mcp-config", "--safe-mode", "--setting-sources", "--settings", "--permission-mode", "--output-format", "--model"]

  /// Claude Code's own settings for the run (passed with --settings).
  static func claudeSettings() -> String {
    var deny = noRead.map { "Read(\($0))" } + noRead.map { "Edit(\($0))" }
    deny += denyBash.map { "Bash(\($0):*)" } + ["WebSearch"]
    let o: [String: Any] = [
      "sandbox": ["enabled": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false],
      "permissions": ["deny": deny, "allow": registries.map { "WebFetch(domain:\($0))" }, "disableBypassPermissionsMode": "disable"],
      "disableAllHooks": true, "enableAllProjectMcpServers": false,
    ]
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)
    return String(data: d, encoding: .utf8) ?? "{}"
  }
  /// Claude Code's arguments (the prompt goes on stdin). nil: this Claude Code is too old to be held this tightly.
  static func claudeArgs(flags f: Set<String>, model: String?) -> [String]? {
    guard f.contains("--strict-mcp-config"), f.contains("--allowedTools"), f.contains("--disallowedTools"), f.contains("--settings") else { return nil }
    var a = ["-p", "--permission-mode", "acceptEdits", "--output-format", "text", "--settings", claudeSettings(),
             "--strict-mcp-config", "--mcp-config", #"{"mcpServers":{}}"#]
    if f.contains("--safe-mode") { a.append("--safe-mode") } else if f.contains("--setting-sources") { a += ["--setting-sources", "local"] }
    if let model, f.contains("--model") { a += ["--model", model] }
    a += ["--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash", "--disallowedTools"]
    a += denyBash.map { "Bash(\($0):*)" } + ["WebSearch"]
    return a
  }
  /// Codex: workspace-write keeps the writes inside the folder; the network is off for its commands; no MCP servers; never full access.
  static func codexArgs(prompt: String, dir: String, lastMessage: String) -> [String] {
    ["exec", "-C", dir, "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-c", "mcp_servers={}",
     "-c", "approval_policy=\"never\"", "-o", lastMessage, prompt]
  }
  static let prePushHook = "#!/bin/sh\necho \"PS: pushing is refused on this computer (outsourced work never pushes).\" >&2\nexit 1\n"
  static func shim(_ name: String) -> String { "#!/bin/sh\necho \"PS: \(name) is refused on this computer (outsourced work only edits and tests).\" >&2\nexit 126\n" }
  static let noPushURL = "refused://this-computer-never-pushes"
  static let author = "PS outsourced job", authorEmail = "ps-outsource@localhost"

  /// The environment the AI runs with: this computer's own, minus tokens, with the stand ins first on PATH and git kept local.
  static func env(base: [String: String], shimDir: String, hooksDir: String, home: String) -> [String: String] {
    var e = base
    for k in envDrop { e.removeValue(forKey: k) }
    for k in e.keys where k.hasPrefix("GIT_") { e.removeValue(forKey: k) }
    for k in e.keys where k.hasSuffix("_TOKEN") || k.hasSuffix("_SECRET") || k.hasSuffix("_PASSWORD") || k.hasSuffix("_API_KEY") { e.removeValue(forKey: k) }
    let path = e["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    e["PATH"] = shimDir + ":" + path
    e["HOME"] = home
    e["GIT_TERMINAL_PROMPT"] = "0"
    e["GIT_CONFIG_NOSYSTEM"] = "1"                // no system config: no saved password helper
    e["GIT_CONFIG_GLOBAL"] = "/dev/null"          // nor the person's own
    e["GIT_ALLOW_PROTOCOL"] = "ps-none"           // no transport at all, not even a folder: the AI commits, it never pushes or fetches
    e["GIT_SSH_COMMAND"] = shimDir + "/ssh"
    e["GIT_AUTHOR_NAME"] = author; e["GIT_COMMITTER_NAME"] = author
    e["GIT_AUTHOR_EMAIL"] = authorEmail; e["GIT_COMMITTER_EMAIL"] = authorEmail
    e["GIT_CONFIG_COUNT"] = "2"
    e["GIT_CONFIG_KEY_0"] = "core.hooksPath"; e["GIT_CONFIG_VALUE_0"] = hooksDir
    e["GIT_CONFIG_KEY_1"] = "push.default"; e["GIT_CONFIG_VALUE_1"] = "nothing"
    e["CI"] = "1"
    e["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    return e
  }

  /// The prompt the tool gets: the job's own, then the house rules (it cannot push) and where to put screenshots.
  static func fullPrompt(_ j: SecondCodeJob) -> String {
    var p = "Task: \(j.title)\n\n" + j.prompt + "\n\n---\nRules of this computer: work only inside this folder, commit your work on the current branch with clear messages, never push, deploy or send anything, and finish with a short summary of what you changed and which tests you ran."
    if j.shots { p += " Save any screenshots as PNG files in .ps-outsource/shots/ (three at most, small)." }
    return p
  }
}

/// Changed files that look like they hold secrets: a bundle that carries one is not sent back.
enum OutSecretPaths {
  private static let re = try? NSRegularExpression(pattern: #"(^|/)(\.env(\..*)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|id_(rsa|ed25519|ecdsa)[^/]*|credentials(\.json)?|secrets?(\.[a-z]+)?|keychains?)(/|$)|\.(pem|p12|pfx|key|keystore|kdbx)$"#, options: [.caseInsensitive])
  static func isSecret(_ path: String) -> Bool {
    guard let re else { return true }
    return re.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
  }
}

/// SHA-256 of a file or bytes.
enum OutHash {
  static func sha256(_ path: String) -> String? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while true {
      let d: Data?
      do { d = try h.read(upToCount: 1 << 20) } catch { return nil }
      guard let d, !d.isEmpty else { break }
      hasher.update(data: d)
    }
    return hex(hasher.finalize())
  }
  static func sha256(_ d: Data) -> String { hex(SHA256.hash(data: d)) }
  private static func hex<D: Sequence>(_ d: D) -> String where D.Element == UInt8 { d.map { String(format: "%02x", $0) }.joined() }
}

/// What a code job made, as the sealed result carries it (the owner's ores body: state, report, summary, files, plus "code").
struct SecondCodeReport {
  var state: String          // done, failed, cancelled, timeout
  var tool: String
  var repo: String
  var branch: String
  var base: String
  var head: String
  var commits: Int
  var files: [String]        // "path | 3 +-" lines from git diff --stat, short
  var summary: String        // the AI's own words, stripped
  var log: String            // the tail of what it printed, stripped
  var exit: Int32
  var seconds: Int
  var note: String

  /// The fields that go into the sealed result under "code".
  var json: [String: Any] {
    ["tool": tool, "repo": repo, "branch": branch, "base": base, "head": head, "commits": commits, "files": Array(files.prefix(30)), "exit": Int(exit), "seconds": seconds]
  }
  /// The report.md the main Mac keeps beside the bundle.
  func markdown(title: String) -> String {
    var s = "# \(title)\n\n"
    s += "- State: \(state)\n- Tool: \(tool)\n- Repo: \(repo)\n"
    if !branch.isEmpty { s += "- Branch in the bundle: \(branch)\n- Base: \(base)\n- Head: \(head)\n- Commits: \(commits)\n" }
    s += "- Took: \(seconds) s\n"
    if !note.isEmpty { s += "\n\(note)\n" }
    if !files.isEmpty { s += "\n## Files changed\n\n```\n" + files.joined(separator: "\n") + "\n```\n" }
    if !summary.isEmpty { s += "\n## What the AI said\n\n" + summary + "\n" }
    if !log.isEmpty && log != summary { s += "\n## The end of its log\n\n```\n" + log + "\n```\n" }
    return s
  }
}

/// The bundle travels sealed, as one file through the owner's file stream (purpose "result"): a header line with the
/// seal's suite, key id and encapsulated key, then the sealed bytes. The AAD ties it to its job and its file id, and the
/// sealed result names its SHA-256, so a swapped, cut or replayed file is refused on the main Mac.
enum SecondCodeBundle {
  static let maxBundle = 24 * 1024 * 1024
  static let magic = "PSCODE1"
  static func aad(job: String, file: String) -> Data { Data("ps-code-bundle|\(job)|\(file)".utf8) }

  static func pack(suite: String, kid: String, enc: Data, ct: Data) -> Data {
    var d = Data((magic + " " + suite + " " + kid + " " + enc.base64EncodedString() + "\n").utf8)
    d.append(ct)
    return d
  }
  /// suite, kid, enc, ct; nil when it is not one of ours.
  static func unpack(_ d: Data) -> (suite: String, kid: String, enc: Data, ct: Data)? {
    guard let nl = d.prefix(4096).firstIndex(of: 0x0A) else { return nil }
    let head = String(decoding: d[d.startIndex..<nl], as: UTF8.self).split(separator: " ").map(String.init)
    guard head.count == 4, head[0] == magic, ["xwing", "p256"].contains(head[1]), head[2].count <= 32, let enc = Data(base64Encoded: head[3]), enc.count <= 2048 else { return nil }
    return (head[1], head[2], enc, Data(d[d.index(after: nl)...]))
  }
  /// The line the person (or their AI) runs in their own copy to look at the result. Nothing merges by itself.
  static func fetchLine(bundle: String, branch: String, job: String) -> String {
    let q = "'" + bundle.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return "git fetch \(q) \(branch):review/\(job.prefix(8))"
  }
}
