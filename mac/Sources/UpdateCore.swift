// PS's own installer and updater, the plain parts (the developer, 27 Oct 2026: "one download file in my Drive,
// and PS on any of my Macs offers Download and install").
// One channel for everyone (public PS, 27 Oct 2026): a release puts a small signed manifest and the
// update files in one place (UpdateChannel below). Since V1.57 that place is the public PS repo's newest
// GitHub release, not cincee.com (the developer, 13 Nov 2026: "Remove the IP address part so I can't see their IP
// address when [PS] asks Cincee for updates"). Where the files come from does not matter to the checks:
// PS reads the manifest, checks its signature, then downloads what it names into its own
// folder, checks every hash and goes on exactly as it did from the Drive folder before. The developer's Macs
// use the same channel as everyone else, so he is always the first to meet any update. (Builds before
// this one read your sync folder; releases still write there so they move on to this.)
//  - The manifest is signed with Ed25519 (CryptoKit). The private key lives only in ps-mac/signing/
//    (never in git); the public key is built in here. Each file it names has its SHA-256 in it.
//  - An app update must also be signed with the developer's own "PS Local Signing" certificate (codesign),
//    is unpacked without the quarantine flag, and goes in with one atomic swap (renamex_np).
//  - A web-only update installs web files only: the app is not touched, so no Little Snitch
//    prompt and no sign in.
// The flow and its card are in Updater.swift, the hand over of the sign in in UpdateHandoff.swift,
// the first install from the DMG in Installer.swift.
import CryptoKit
import Foundation
import Security

/// The update signing key's public half (the private half: ps-mac/signing/update-ed25519.key).
let UPDATE_PUBLIC_KEY = "Pc6Z49PnFmrf7frRS7d+W2RzpI/bR756v10J8b44/eU="
/// V1.58 (multiple developers): the G Squad channel's own update key, public half (the private half lives only in the
/// G Squad release workflow's secrets). Empty until it is made: then only the developer's key opens a G Squad note, as before.
/// A build that follows the G Squad channel trusts both, so friends' apps move from the developer's releases to the G Squad
/// ones by themselves; a build on a private channel trusts only its own key (UpdateRoute.keys).
let UPDATE_GSQUAD_PUBLIC_KEY = "caMPQq7AM4+Ol5Ynh9na7pO/BwTsutaFhLuCu9R3bWE="
/// The developer's own signing certificate ("PS Local Signing"), its root's SHA-1.
let PS_CERT_ROOT_RED = "b278d9d09dfed336675cfb367b2f8a3b51896689"
/// V1.58: the G Squad build's signing certificate root (SHA-1, 40 hex). Empty until it is made.
let PS_CERT_ROOT_GSQUAD = "c0e302f2ce304d062a50d6ebdaff97d5f7d4b6e6"
/// What may be installed, and who may be handed the sign in: PS signed with the developer's own certificate, and on the G Squad
/// channel also PS signed with the G Squad certificate once there is one (UpdateRoute.requirement). A PS that is itself
/// signed with the developer's certificate only ever takes the developer's certificate (V1.69, UpdateRoute.pinnedToRed).
let PS_REQUIREMENT = UpdateRoute.current.requirement

struct UpdateError: Error, CustomStringConvertible {
  let description: String
  init(_ s: String) { description = s }
}

// MARK: - Where things are (test copies get their own folders, never the developer's)

enum UpdatePaths {
  static let env = ProcessInfo.processInfo.environment
  static let test = env["PS_SELFTEST"] != nil
  static let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)

  /// The Applications folder PS is installed in. A test copy only ever gets a folder it was given
  /// (and never /Applications itself); without one its updater stays off.
  static let apps: URL? = {
    if test {
      guard let a = env["PS_SELFTEST_APPS"], !a.isEmpty else { return nil }
      let u = URL(fileURLWithPath: a, isDirectory: true).standardizedFileURL
      return u.path == "/Applications" ? nil : u
    }
    return URL(fileURLWithPath: "/Applications", isDirectory: true)
  }()
  /// The installed app an update replaces (V1.36: people may rename it, AppName.swift). It follows the folder
  /// this copy really runs from when that sits straight in `apps`, so an update keeps the name. A test copy
  /// run from elsewhere finds the installed one in its fake folder by bundle id; otherwise PS.app as before.
  static var target: URL? {
    guard let apps else { return nil }
    if let me = AppName.inside(apps: apps, bundle: Bundle.main.bundleURL) { return me }
    if test, let other = AppName.installed(in: apps) { return other }
    return apps.appendingPathComponent("PS.app", isDirectory: true)
  }

  /// PS's own Application Support folder (web files, backgrounds, update work).
  static let support: URL = {
    if test, let t = env["PS_SELFTEST"] { return URL(fileURLWithPath: t, isDirectory: true).appendingPathComponent("support", isDirectory: true) }
    return home.appendingPathComponent("Library/Application Support/PS", isDirectory: true)
  }()
  static var work: URL { support.appendingPathComponent("update", isDirectory: true) }
  static var journal: URL { work.appendingPathComponent("journal.json") }
  /// Where the web files PS runs are installed (webRoot() in main.swift reads the same place).
  static var web: URL {
    if test, let w = env["PS_SELFTEST_WEB"] { return URL(fileURLWithPath: w, isDirectory: true) }
    return support.appendingPathComponent("web", isDirectory: true)
  }
  static var backgrounds: URL { test ? URL(fileURLWithPath: env["PS_SELFTEST"]!, isDirectory: true).appendingPathComponent("backgrounds", isDirectory: true) : support.appendingPathComponent("backgrounds", isDirectory: true) }

  /// A local folder holding the manifest and its files, for test copies only (PS_SELFTEST_DRIVE,
  /// never the developer's Drive). Everyone else gets the channel (UpdateChannel), mirrored into `mirror`.
  static func drive() -> URL? {
    if test { return env["PS_SELFTEST_DRIVE"].map { URL(fileURLWithPath: $0, isDirectory: true) } }
    return nil
  }
  /// Where the channel's manifest and files are downloaded to before they are offered.
  static var mirror: URL { work.appendingPathComponent("channel", isDirectory: true) }
  static var publicKey: String { test ? (env["PS_SELFTEST_UPDATE_PUBKEY"] ?? UPDATE_PUBLIC_KEY) : UPDATE_PUBLIC_KEY }
  /// V1.58: every key a note on this build's channel may be signed with (a test copy: its test key only).
  static var publicKeys: [String] { test ? [publicKey] : UpdateRoute.current.keys }
}

// MARK: - Which channel this build follows (V1.58, multiple developers)

/// The channel comes from the build's own profile (Contents/Resources/profile.json, put there by build.sh from the
/// G Squad profile or the person's layer), nothing else. The profile is inside the signed app, so it cannot be changed
/// without breaking the app's signature.
///   {"name": "gsquad", "channel": {"kind": "gsquad"}}        the G Squad channel (the public PS repo's GitHub releases)
///   {"name": "jan", "channel": {"kind": "url", "url": "https://.../", "key": "<Ed25519 public key, base64>",
///                               "certRoot": "<40 hex>"}}       that person's own channel, their own keys
///   {"name": "jan", "channel": {"kind": "local"}}             no update channel (they install their own builds)
/// No profile (every build before V1.58, and builds made the V1.57 way) or anything not understood: the G Squad channel,
/// which is today's channel, so nothing changes for anyone until their build says otherwise.
/// Every note says which channel it was made for ("channel": "gsquad" or the person's name); a note for another
/// channel is refused next to the signature check. Notes from before V1.58 say nothing and are taken as before.
/// V1.69 (the developer, 18 Nov 2026, after the G Squad's V1.68 reached his Mac: "The developer's Mac must get only the developer's own releases"):
///  - A build from a person's private tree has no profile, so it may carry Contents/Resources/channel.json instead: the
///    channel part alone, in the same shape ({"name": "red", "channel": {"kind": "url", "url": "https://.../"}}), written
///    by build.sh from the person's layer profile. Nothing else of the profile comes with it, so every other answer
///    stays exactly as with no profile. A profile.json, when there is one, wins.
///  - A PS that is itself signed with the developer's certificate trusts only the developer's update key and the developer's certificate, whatever
///    its channel says (pinnedToRed). So even a build of the developer's that lost its channel file can never take a G Squad
///    note or install an app signed with another certificate (macOS would drop Accessibility and Input Monitoring,
///    and the private features would be gone). G Squad builds are signed with the G Squad certificate: unchanged.
struct UpdateRoute: Equatable {
  enum Kind: String { case gsquad, url, local }
  let kind: Kind
  /// The channel's name: "gsquad", or the person's profile name for their own channel.
  let id: String
  /// Where the notes are (nil: no channel).
  let base: URL?
  /// The update keys this channel's notes may be signed with.
  let keys: [String]
  /// The certificate roots an installed app may be signed with.
  let certRoots: [String]

  static let gsquad = UpdateRoute(kind: .gsquad, id: "gsquad", base: URL(string: UPDATE_CHANNEL),
                                  keys: [UPDATE_PUBLIC_KEY, UPDATE_GSQUAD_PUBLIC_KEY].filter { !$0.isEmpty },
                                  certRoots: [PS_CERT_ROOT_RED, PS_CERT_ROOT_GSQUAD].filter { !$0.isEmpty })

  /// The route a profile gives (nil data: no profile).
  static func from(profile data: Data?) -> UpdateRoute {
    guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ch = o["channel"] as? [String: Any], let kind = Kind(rawValue: ch["kind"] as? String ?? "") else { return gsquad }
    if kind == .gsquad { return gsquad }
    guard let name = o["name"] as? String, name.range(of: #"^[a-z][a-z0-9-]{0,30}$"#, options: .regularExpression) != nil, name != "gsquad" else { return gsquad }
    // Their own key and certificate when the profile names them, else the developer's (the developer's own profile names neither).
    let key = (ch["key"] as? String).flatMap { k in Data(base64Encoded: k).flatMap { (try? Curve25519.Signing.PublicKey(rawRepresentation: $0)) != nil ? k : nil } } ?? UPDATE_PUBLIC_KEY
    let root = (ch["certRoot"] as? String).flatMap { $0.range(of: #"^[0-9a-f]{40}$"#, options: .regularExpression) != nil ? $0 : nil } ?? PS_CERT_ROOT_RED
    if kind == .local { return UpdateRoute(kind: .local, id: name, base: nil, keys: [key], certRoots: [root]) }
    // A private channel must be https and a folder ("…/"), else the profile is not used at all.
    guard let s = ch["url"] as? String, let u = URL(string: s), u.scheme == "https", u.host != nil, s.hasSuffix("/") else { return gsquad }
    return UpdateRoute(kind: .url, id: name, base: u, keys: [key], certRoots: [root])
  }
  /// V1.69: the route for a build's bundled files. `profile` (Resources/profile.json) wins; else `channel`
  /// (Resources/channel.json); neither: the G Squad channel. `signedByRed`: this PS itself carries the developer's certificate.
  static func resolve(profile: Data?, channel: Data?, signedByRed: Bool) -> UpdateRoute {
    let r = from(profile: profile ?? channel)
    return signedByRed ? r.pinnedToRed : r
  }
  /// The same channel, but only the developer's update key and only the developer's certificate.
  var pinnedToRed: UpdateRoute { UpdateRoute(kind: kind, id: id, base: base, keys: [UPDATE_PUBLIC_KEY], certRoots: [PS_CERT_ROOT_RED]) }
  static let current: UpdateRoute = resolve(profile: bundled("profile"), channel: bundled("channel"), signedByRed: selfSignedByRed)
  private static func bundled(_ name: String) -> Data? {
    Bundle.main.url(forResource: name, withExtension: "json").flatMap { try? Data(contentsOf: $0) }
  }
  /// Is this running PS signed with the developer's own certificate? (A test copy or an unsigned build: no.)
  static let selfSignedByRed: Bool = {
    var me: SecCode?, req: SecRequirement?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
          SecRequirementCreateWithString(#"certificate root = H""# + PS_CERT_ROOT_RED + #"""# as CFString, [], &req) == errSecSuccess, let req
    else { return false }
    return SecCodeCheckValidity(me, [], req) == errSecSuccess
  }()

  /// The code requirement for an installed or handed over PS on this channel.
  var requirement: String {
    let roots = certRoots.map { #"certificate root = H""# + $0 + #"""# }
    return #"identifier "com.cincee.ps" and "# + (roots.count == 1 ? roots[0] : "(" + roots.joined(separator: " or ") + ")")
  }
  /// May a note made for `channel` be taken here? A note that names no channel (before V1.58) always may.
  func takes(_ channel: String?) -> Bool { channel == nil || channel == id }
}

// MARK: - The channel (the public PS repo's newest GitHub release)

/// Where every PS since V1.57 asks for updates: the newest release of the public PS repo on GitHub. GitHub sends
/// the request on to the release's files; the developer sees a download count there and no addresses. PS V1.56 and older
/// still ask https://cincee.com/client/ps/, which releases keep filling so they can move on to this one.
/// No other place is tried when GitHub cannot be reached (no fallback to cincee.com): the check just fails and
/// is tried again later.
let UPDATE_CHANNEL = "https://github.com/RedbyPS/ps/releases/latest/download/"

/// Brings the signed manifest and the files an update needs from the channel into `UpdatePaths.mirror`,
/// which the updater then reads like the old Drive folder. Runs on the updater's queue, never main.
/// Order: the manifest is downloaded and its signature checked first (a bad one is thrown away);
/// only then the files it names that this Mac needs, each checked against its size and SHA-256
/// before it is kept; the manifest goes into the mirror last. Nothing newer: nothing is downloaded.
/// Test copies: only PS_SELFTEST_CHANNEL, and only a file:// address (a test copy never goes online).
enum UpdateChannel {
  static let base: URL? = {
    if UpdatePaths.test {
      guard let s = UpdatePaths.env["PS_SELFTEST_CHANNEL"], let u = URL(string: s), u.isFileURL else { return nil }
      return u
    }
    return UpdateRoute.current.base
  }()
  /// Who answers, for the messages PS shows when a look fails.
  static var who: String { base?.isFileURL == false ? (base?.host == "github.com" ? "GitHub" : (base?.host ?? "the update server")) : "the update folder" }
  /// The address of a file the signed note names ("updates/PS-app-N.zip"). A release on GitHub holds its files
  /// side by side with no folders, so there only the last part of the name is asked for; a test folder keeps
  /// the folder, and so does a person's own channel on their own web server (V1.69: publish.sh stages it with its
  /// updates/ folder). The name was already checked (UpdateManifest.safeFile) and the file is checked against the
  /// signed size and SHA-256 after the download, wherever it came from.
  static func remote(_ file: String, base: URL) -> URL {
    base.isFileURL || base.host != "github.com" ? base.appendingPathComponent(file) : base.appendingPathComponent((file as NSString).lastPathComponent)
  }
  static let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 30
    c.timeoutIntervalForResource = 30 * 60
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.httpCookieStorage = nil; c.urlCache = nil
    c.httpAdditionalHeaders = ["User-Agent": "PS"]
    return URLSession(configuration: c)
  }()
  /// Files that failed their check this run: not downloaded again until PS restarts.
  private static var bad = Set<String>()

  /// The mirror folder once it holds a signed manifest and every file it would offer (nil: no channel).
  /// `fresh` (V1.51, the Update now click): the note is read whole, with no ETag and no cache anywhere on the way,
  /// so the click always sees the newest release (Updater.freshLook, UpdateLatest.swift).
  static func sync(myBuild: Int, web: (src: String, built: String)?, fresh freshRead: Bool = false) throws -> URL? {
    guard let base else { return nil }
    let fm = FileManager.default, dir = UpdatePaths.mirror
    try fm.createDirectory(at: dir.appendingPathComponent("updates", isDirectory: true), withIntermediateDirectories: true)
    // Change only (31 Oct 2026): the note is asked for with the ETag of the one already mirrored, so an
    // unchanged release costs one tiny "304 Not Modified" and nothing is read or hashed again. The mirror
    // only ever holds a note once every file it needed was checked (the note goes in last).
    let noteURL = dir.appendingPathComponent("ps-update.json"), tagURL = dir.appendingPathComponent("ps-update.etag")
    let held = try? Data(contentsOf: noteURL)
    let (fresh, tag) = try getNote(base.appendingPathComponent("ps-update.json"), etag: held == nil || freshRead ? nil : (try? String(contentsOf: tagURL, encoding: .utf8)), noCache: freshRead)
    if fresh == nil, let held, let m = try? UpdateManifest.open(held, publicKeys: UpdatePaths.publicKeys), UpdateRoute.current.takes(m.channel),
       files(UpdatePlan.decide(m, myBuild: myBuild, web: web)).allSatisfy({ size(of: dir.appendingPathComponent($0.0)) == $0.1 }) {
      return dir
    }
    let raw = try fresh ?? get(base.appendingPathComponent("ps-update.json"), max: 64 << 10)
    let m = try UpdateManifest.open(raw, publicKeys: UpdatePaths.publicKeys)
    guard UpdateRoute.current.takes(m.channel) else { throw UpdateError("the update note is for another PS build") }
    let want = files(UpdatePlan.decide(m, myBuild: myBuild, web: web))
    for (file, size, sha) in want {
      let to = dir.appendingPathComponent(file)
      if (try? fm.attributesOfItem(atPath: to.path)[.size] as? NSNumber)?.int64Value == size, (try? sha256(of: to)) == sha { continue }
      guard !bad.contains(sha) else { throw UpdateError("\(file) did not match its signed note before") }
      let tmp = try download(remote(file, base: base))
      defer { try? fm.removeItem(at: tmp) }
      let got = (try? fm.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? -1
      guard got == size, try sha256(of: tmp) == sha else { bad.insert(sha); throw UpdateError("\(file) does not match its signed note") }
      try? fm.removeItem(at: to)
      try fm.moveItem(at: tmp, to: to)
      try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: to.path)
    }
    // Old downloads go: only what this manifest names stays.
    let names = Set(want.map { $0.0 }).union([m.app?.file, m.web.file].compactMap { $0 })
    for n in (try? fm.contentsOfDirectory(atPath: dir.appendingPathComponent("updates").path)) ?? [] where !names.contains("updates/" + n) {
      try? fm.removeItem(at: dir.appendingPathComponent("updates").appendingPathComponent(n))
    }
    try raw.write(to: noteURL, options: .atomic)
    if let tag, fresh != nil { try? tag.write(to: tagURL, atomically: true, encoding: .utf8) } else { try? fm.removeItem(at: tagURL) }
    return dir
  }

  /// The files a plan needs: (name, size, SHA-256).
  static func files(_ p: UpdatePlan) -> [(String, Int64, String)] {
    switch p {
    case .none: return []
    case .web(let w): return [(w.file, w.size, w.sha256)]
    case .app(let a, let w): return [(a.file, a.size, a.sha256), (w.file, w.size, w.sha256)]
    }
  }
  static func size(of u: URL) -> Int64 { ((try? FileManager.default.attributesOfItem(atPath: u.path)[.size]) as? NSNumber)?.int64Value ?? -1 }
  /// The note, only when it changed: nil data for "304 Not Modified" (a file:// test folder is always read).
  /// `noCache`: also asks every cache on the way for the origin's copy, with a short wait.
  /// V1.69 hotfix: a web server that answers a missing file with its web page (status 200, text/html; the website's
  /// page fallback did this for the first look right after the developer's 1.69, before the deploy was live) has no update file
  /// there yet. Said plainly, and never taken as a file: a zip that is really a web page would otherwise fail its
  /// hash and be refused until PS restarts.
  static func isWebPage(_ contentType: String?) -> Bool {
    (contentType ?? "").lowercased().trimmingCharacters(in: .whitespaces).hasPrefix("text/html")
  }
  static let notThereYet = "has no update note there yet (it sent a web page)"
  static func getNote(_ u: URL, etag: String?, noCache: Bool = false) throws -> (Data?, String?) {
    if u.isFileURL { return (try get(u, max: 64 << 10), nil) }
    var req = URLRequest(url: u)
    if let etag, !etag.isEmpty, etag.count < 200 { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
    if noCache {
      req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      req.setValue("no-cache", forHTTPHeaderField: "Cache-Control"); req.setValue("no-cache", forHTTPHeaderField: "Pragma")
      req.timeoutInterval = 15
    }
    var out: Result<(Data?, String?), Error> = .failure(UpdateError("no answer from \(who)"))
    let done = DispatchSemaphore(value: 0)
    session.dataTask(with: req) { d, r, e in
      defer { done.signal() }
      if let e { out = .failure(UpdateError("could not reach \(who) (\(e.localizedDescription))")); return }
      guard let h = r as? HTTPURLResponse else { out = .failure(UpdateError("\(who) said nothing")); return }
      if h.statusCode == 304 { out = .success((nil, etag)); return }
      guard h.statusCode == 200, let d else { out = .failure(UpdateError("\(who) said \(h.statusCode)")); return }
      if isWebPage(h.value(forHTTPHeaderField: "Content-Type")) { out = .failure(UpdateError("\(who) \(notThereYet)")); return }
      out = d.count <= 64 << 10 ? .success((d, h.value(forHTTPHeaderField: "ETag"))) : .failure(UpdateError("the update note is too big"))
    }.resume()
    done.wait()
    return try out.get()
  }

  /// A small file, whole (the manifest).
  static func get(_ u: URL, max: Int) throws -> Data {
    if u.isFileURL { let d = try Data(contentsOf: u); guard d.count <= max else { throw UpdateError("the update note is too big") }; return d }
    var out: Result<Data, Error> = .failure(UpdateError("no answer from \(who)"))
    let done = DispatchSemaphore(value: 0)
    session.dataTask(with: u) { d, r, e in
      defer { done.signal() }
      if let e { out = .failure(UpdateError("could not reach \(who) (\(e.localizedDescription))")); return }
      guard let h = r as? HTTPURLResponse, h.statusCode == 200, let d else { out = .failure(UpdateError("\(who) said \((r as? HTTPURLResponse)?.statusCode ?? 0)")); return }
      if isWebPage(h.value(forHTTPHeaderField: "Content-Type")) { out = .failure(UpdateError("\(who) \(notThereYet)")); return }
      out = d.count <= max ? .success(d) : .failure(UpdateError("the update note is too big"))
    }.resume()
    done.wait()
    return try out.get()
  }
  /// A big file, to a temporary file in the work folder.
  static func download(_ u: URL) throws -> URL {
    let to = UpdatePaths.work.appendingPathComponent(".dl-\(UUID().uuidString)")
    if u.isFileURL { try FileManager.default.copyItem(at: u, to: to); return to }
    var err: Error?
    let done = DispatchSemaphore(value: 0)
    session.downloadTask(with: u) { tmp, r, e in
      defer { done.signal() }
      if let e { err = UpdateError("the download stopped (\(e.localizedDescription))"); return }
      guard let h = r as? HTTPURLResponse, h.statusCode == 200, let tmp else { err = UpdateError("\(who) said \((r as? HTTPURLResponse)?.statusCode ?? 0)"); return }
      if isWebPage(h.value(forHTTPHeaderField: "Content-Type")) { err = UpdateError("\(who) has no such update file yet (it sent a web page)"); return }
      do { try FileManager.default.moveItem(at: tmp, to: to) } catch { err = error }
    }.resume()
    done.wait()
    if let err { try? FileManager.default.removeItem(at: to); throw err }
    return to
  }
  static func sha256(of u: URL) throws -> String {
    guard let h = FileHandle(forReadingAtPath: u.path) else { throw UpdateError("could not read the download") }
    defer { try? h.close() }
    var sha = SHA256()
    while let d = try h.read(upToCount: 1 << 20), !d.isEmpty { sha.update(data: d) }
    return sha.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - Versions

enum PSVersion {
  /// This build's number (CFBundleVersion, stamped by build.sh as yymmddHHMM in UTC).
  static var mine: Int {
    if UpdatePaths.test, let b = UpdatePaths.env["PS_SELFTEST_MYBUILD"].flatMap(Int.init) { return b }
    return build(of: Bundle.main.bundleURL) ?? 0
  }
  static func build(of app: URL) -> Int? {
    guard let d = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) else { return nil }
    return (d["CFBundleVersion"] as? String).flatMap { Int($0) }
  }
  /// The version the developer sees, one for the Mac and the phone: "V1.07 · Wisdom". The newer of this app's
  /// (CFBundleShortVersionString, PSKeyword) and the web files' ps-version.json (a web-only release
  /// moves it on without touching the app).
  static var name: String {
    let v = [short(of: Bundle.main.bundleURL), webName()].compactMap { $0 }.max { hundredths($0.0) < hundredths($1.0) }
    return v.map { show($0.0, $0.1) } ?? label(mine)
  }
  /// This app's own version only (after a roll back the web files may be the newer ones).
  static var appName: String { short(of: Bundle.main.bundleURL).map { show($0.0, $0.1) } ?? label(mine) }
  /// "V1.07 · Wisdom" ("V1.07" alone when there is no keyword). V1.58: with who made it, "V1.59 by Jan · Harmony".
  static func show(_ version: String, _ keyword: String?, by: String? = nil) -> String {
    let v = (version.hasPrefix("V") ? version : "V" + version) + (byLine(by).map { " " + $0 } ?? "")
    return keyword.map { "\(v) · \($0)" } ?? v
  }
  /// V1.58: a maker's profile name as people read it: "gsquad" is "the G Squad", "jan" is "Jan" (nil: not a name).
  static func byName(_ by: Any?) -> String? {
    guard let s = by as? String, s.range(of: #"^[a-z][a-z0-9-]{0,30}$"#, options: .regularExpression) != nil else { return nil }
    if s == "gsquad" { return "the G Squad" }
    return s.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: "-")
  }
  /// "by Jan" (nil for releases from before V1.58).
  static func byLine(_ by: Any?) -> String? { byName(by).map { "by \($0)" } }
  static func short(of app: URL) -> (String, String?)? {
    guard let d = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
          let s = d["CFBundleShortVersionString"] as? String, hundredths(s) > 0 else { return nil }
    return (s, keyword(d["PSKeyword"]))
  }
  static func webName(at dir: URL = UpdatePaths.web) -> (String, String?)? {
    guard let d = FileManager.default.contents(atPath: dir.appendingPathComponent("ps-version.json").path),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let v = o["version"] as? String, hundredths(v) > 0 else { return nil }
    return (v, keyword(o["keyword"]))
  }
  /// One plain word ("Wisdom"), nothing else.
  static func keyword(_ x: Any?) -> String? {
    guard let s = x as? String, s.range(of: #"^[A-Za-z]{1,20}$"#, options: .regularExpression) != nil else { return nil }
    return s
  }
  /// "1.02" as 102 (0 when it is not like that).
  static func hundredths(_ s: String) -> Int {
    guard s.range(of: #"^[0-9]+\.[0-9]{2}$"#, options: .regularExpression) != nil else { return 0 }
    return Int(s.replacingOccurrences(of: ".", with: "")) ?? 0
  }
  /// "27 Oct 15:30" for a build number (UTC in the number, shown in this Mac's time).
  static func label(_ b: Int) -> String {
    let f = DateFormatter(); f.dateFormat = "yyMMddHHmm"; f.timeZone = TimeZone(identifier: "UTC")
    guard b > 1_000_000_000, let d = f.date(from: String(b)) else { return "build \(b)" }
    let o = DateFormatter(); o.dateFormat = "d MMM HH:mm"
    return o.string(from: d)
  }
  /// The web build installed (version.json next to index.html).
  static func web(at dir: URL = UpdatePaths.web) -> (src: String, built: String)? {
    guard let d = FileManager.default.contents(atPath: dir.appendingPathComponent("version.json").path),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let s = o["src"] as? String, let b = o["built"] as? String else { return nil }
    return (s, b)
  }
}

// MARK: - The signed manifest

/// One earlier version's approved notes (V1.52): shown with the newest when a Mac updates across several versions.
struct NoteBlock: Equatable {
  let version: String        // "1.50"
  let keyword: String
  let notes: [String]
  var by: String? = nil      // V1.58: who made it ("jan", "gsquad"); none before V1.58
  /// "V1.50 · Curiosity", "V1.59 by Jan · Harmony"
  var title: String { PSVersion.show(version, keyword.isEmpty ? nil : keyword, by: by) }
}

struct UpdateManifest: Equatable {
  struct App: Equatable { let build: Int; let file: String; let size: Int64; let sha256: String }
  struct Web: Equatable { let src: String; let built: String; let file: String; let size: Int64; let sha256: String }
  let kind: String            // what the last release changed: "app" or "web"
  let made: String
  let app: App?
  let web: Web
  var name: String? = nil     // "V1.07 · Wisdom", what the developer sees (notes before 28 Oct 2026 have none)
  var version: String? = nil  // "V1.07" and "Wisdom" apart, for the gear menu (31 Oct 2026)
  var keyword: String? = nil
  var notes: [String] = []    // The developer's approved patch notes, plain lines (none until he approved them)
  var history: [NoteBlock] = []   // V1.52: the approved notes of the earlier versions, newest first (none in older notes)
  var by: String? = nil          // V1.58: who made this release ("jan", "gsquad"); none in older notes
  var shared: Bool? = nil        // V1.58: true when everyone's G Squad build got it
  var channel: String? = nil     // V1.58: the channel the note was made for ("gsquad" or a person's name)

  /// Checks the Ed25519 signature first and reads only the signed bytes.
  static func open(_ raw: Data, publicKey: String) throws -> UpdateManifest { try open(raw, publicKeys: [publicKey]) }
  /// V1.58: the note may be signed by any one of `publicKeys` (the channel's keys, UpdateRoute.keys).
  static func open(_ raw: Data, publicKeys: [String]) throws -> UpdateManifest {
    guard let o = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let signed = (o["signed"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let sig = (o["sig"] as? String).flatMap({ Data(base64Encoded: $0) }) else { throw UpdateError("the update note is unreadable") }
    guard publicKeys.contains(where: { k in
      guard let pub = Data(base64Encoded: k), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
      return key.isValidSignature(sig, for: signed)
    }) else { throw UpdateError("the update note's signature is wrong") }
    guard let p = try? JSONSerialization.jsonObject(with: signed) as? [String: Any], (p["format"] as? Int) == 1,
          let w = p["web"] as? [String: Any], let web = Web(w) else { throw UpdateError("the update note is not one PS app knows") }
    var app: App?
    if let a = p["app"] as? [String: Any] { guard let x = App(a) else { throw UpdateError("the update note is not one PS app knows") }; app = x }
    let version = (p["name"] as? String).flatMap { $0.hasPrefix("V") && PSVersion.hundredths(String($0.dropFirst())) > 0 ? $0 : nil }
    let keyword = version == nil ? nil : PSVersion.keyword(p["keyword"])
    // V1.58: who made it ("V1.59 by Jan · Harmony") and which channel it is for. A "channel" that is there but is not a
    // plain name is refused (never read as "no channel", which every build would take).
    let by = PSVersion.byName(p["by"]) == nil ? nil : p["by"] as? String
    let name = version.map { PSVersion.show($0, keyword, by: by) }
    var channel: String?
    if let c = p["channel"] {
      guard let s = c as? String, s.range(of: #"^[a-z][a-z0-9-]{0,30}$"#, options: .regularExpression) != nil else { throw UpdateError("the update note is not one PS app knows") }
      channel = s
    }
    return UpdateManifest(kind: p["kind"] as? String ?? "web", made: p["made"] as? String ?? "", app: app, web: web, name: name,
                          version: version, keyword: keyword, notes: cleanNotes(p["notes"]), history: cleanHistory(p["history"]),
                          by: by, shared: by == nil ? nil : (p["shared"] as? Bool) ?? true, channel: channel)
  }
  /// The earlier versions' notes (V1.52): a real version, plain short lines, no long dash or HTML. A bad block is
  /// left out whole; one per version, newest first, at most 20, and at most 6 lines of 220 characters each.
  static func cleanHistory(_ x: Any?) -> [NoteBlock] {
    var seen = Set<String>(), out: [NoteBlock] = []
    for e in ((x as? [Any]) ?? []) {
      guard let o = e as? [String: Any], let v = o["version"] as? String,
            PSVersion.hundredths(v) > 0, !seen.contains(v) else { continue }
      let lines = ((o["notes"] as? [Any]) ?? []).compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
      let bad = CharacterSet(charactersIn: "\u{2013}\u{2014}<>")
      guard !lines.isEmpty, lines.count == ((o["notes"] as? [Any]) ?? []).count,
            !lines.contains(where: { $0.count > 220 || $0.rangeOfCharacter(from: bad) != nil }) else { continue }
      let kw = (o["keyword"] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
      guard kw.rangeOfCharacter(from: bad) == nil else { continue }
      seen.insert(v)
      out.append(NoteBlock(version: v, keyword: String(kw.prefix(30)), notes: Array(lines.prefix(6)), by: PSVersion.byName(o["by"]) == nil ? nil : o["by"] as? String))
    }
    return Array(out.sorted { PSVersion.hundredths($0.version) > PSVersion.hundredths($1.version) }.prefix(20))
  }
  /// What an update across versions shows: this update's own notes first, then every earlier version newer than the
  /// one running (V1.52). `installed` is "V1.49" or "1.49"; with none known only the newest shows.
  func catchUp(installed: String?) -> [NoteBlock] {
    var blocks: [NoteBlock] = []
    if let v = version, !notes.isEmpty { blocks.append(NoteBlock(version: String(v.dropFirst()), keyword: keyword ?? "", notes: notes, by: by)) }
    guard let inst = installed.map({ $0.hasPrefix("V") ? String($0.dropFirst()) : $0 }), PSVersion.hundredths(inst) > 0 else { return blocks }
    let top = version.map { PSVersion.hundredths(String($0.dropFirst())) } ?? Int.max
    for h in history where PSVersion.hundredths(h.version) > PSVersion.hundredths(inst) && PSVersion.hundredths(h.version) < top
      && !blocks.contains(where: { $0.version == h.version }) { blocks.append(h) }
    return blocks.sorted { PSVersion.hundredths($0.version) > PSVersion.hundredths($1.version) }
  }
  /// Patch notes as the gear menu shows them: plain lines, at most 6 of 220 characters (text, never HTML).
  static func cleanNotes(_ x: Any?) -> [String] {
    ((x as? [Any]) ?? []).compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }.prefix(6).map { String($0.prefix(220)) }
  }
  /// File names inside the Drive folder only: no "..", no absolute paths.
  static func safeFile(_ f: String) -> Bool {
    f.range(of: #"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$"#, options: .regularExpression) != nil && !f.contains("..")
  }
}
extension UpdateManifest.App {
  init?(_ a: [String: Any]) {
    guard let b = a["build"] as? Int, let f = a["file"] as? String, UpdateManifest.safeFile(f),
          let s = (a["size"] as? NSNumber)?.int64Value, s > 0, let h = a["sha256"] as? String, h.count == 64 else { return nil }
    self.init(build: b, file: f, size: s, sha256: h.lowercased())
  }
}
extension UpdateManifest.Web {
  init?(_ w: [String: Any]) {
    guard let src = w["src"] as? String, let built = w["built"] as? String, let f = w["file"] as? String, UpdateManifest.safeFile(f),
          let s = (w["size"] as? NSNumber)?.int64Value, s > 0, let h = w["sha256"] as? String, h.count == 64 else { return nil }
    self.init(src: src, built: built, file: f, size: s, sha256: h.lowercased())
  }
}

enum UpdatePlan: Equatable {
  case none
  case web(UpdateManifest.Web)
  case app(UpdateManifest.App, UpdateManifest.Web)

  /// A newer app build wins (it carries the web files too). Otherwise a newer web build alone,
  /// which never touches the app. Never backwards: an older note (even a signed one) is ignored.
  static func decide(_ m: UpdateManifest, myBuild: Int, web: (src: String, built: String)?) -> UpdatePlan {
    if let a = m.app, a.build > myBuild { return .app(a, m.web) }
    if let w = web, w.src == m.web.src || m.web.built <= w.built { return .none }
    return .web(m.web)
  }
  var bytes: Int64 {
    switch self { case .none: return 0; case .web(let w): return w.size; case .app(let a, let w): return a.size + w.size }
  }
}

// MARK: - Reading a file out of the Drive folder, with real progress

/// What the copy has done so far (read by the card about 20 times a second).
final class FetchProgress {
  private let mu = NSLock()
  private var _bytes: Int64 = 0, _waiting = false
  var bytes: Int64 { mu.lock(); defer { mu.unlock() }; return _bytes }
  /// The file is still in the cloud and Drive is fetching it (the first read waits for Drive).
  var waitingOnDrive: Bool { mu.lock(); defer { mu.unlock() }; return _waiting }
  func set(_ b: Int64, waiting: Bool) { mu.lock(); _bytes = b; _waiting = waiting; mu.unlock() }
  var cancelled = false
}

enum UpdateFiles {
  static let SF_DATALESS: UInt32 = 0x4000_0000
  /// Only the stub is on this Mac: reading it makes Drive download it first.
  static func inCloudOnly(_ u: URL) -> Bool {
    var st = stat()
    return stat(u.path, &st) == 0 && (st.st_flags & SF_DATALESS) != 0
  }

  /// Copies `src` to `dst` in 1 MB reads (each read is counted), checking the size and SHA-256.
  /// Runs on a background queue. A file only in the cloud is fetched by Drive on the first read;
  /// until bytes flow the card says so instead of showing a made up number.
  static func fetch(_ src: URL, to dst: URL, size: Int64, sha256: String, progress p: FetchProgress, base: Int64 = 0) throws {
    let fm = FileManager.default
    try? fm.removeItem(at: dst)
    try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard fm.createFile(atPath: dst.path, contents: nil, attributes: [.posixPermissions: 0o600]),
          let out = FileHandle(forWritingAtPath: dst.path) else { throw UpdateError("could not write the update to this Mac") }
    defer { try? out.close() }
    p.set(base, waiting: inCloudOnly(src))
    if inCloudOnly(src) { try? fm.startDownloadingUbiquitousItem(at: src) }   // Drive starts fetching now
    guard let h = FileHandle(forReadingAtPath: src.path) else { throw UpdateError("the update file is missing from the Drive folder") }
    defer { try? h.close() }
    // Test copies only: a slow Drive (PS_SELFTEST_DRIVEWAIT seconds before the first byte, then
    // PS_SELFTEST_SLOWREAD bytes a second), so the card's animations can be measured.
    let env = UpdatePaths.env
    let slow = UpdatePaths.test ? env["PS_SELFTEST_SLOWREAD"].flatMap(Double.init) : nil
    if UpdatePaths.test, base == 0, let w = env["PS_SELFTEST_DRIVEWAIT"].flatMap(Double.init) { p.set(base, waiting: true); Thread.sleep(forTimeInterval: w) }
    var sha = SHA256(), n: Int64 = 0
    while true {
      if p.cancelled { throw UpdateError("stopped") }
      guard let d = try h.read(upToCount: slow == nil ? 1 << 20 : 1 << 17), !d.isEmpty else { break }
      sha.update(data: d)
      try out.write(contentsOf: d)
      n += Int64(d.count)
      p.set(base + n, waiting: false)
      if let slow { Thread.sleep(forTimeInterval: Double(d.count) / slow) }
      if n > size { throw UpdateError("the update file is bigger than its note says") }
    }
    guard n == size else { throw UpdateError(n == 0 ? "Google Drive has not synced the update file yet" : "the update file is not complete yet (Drive still syncing)") }
    let hex = sha.finalize().map { String(format: "%02x", $0) }.joined()
    guard hex == sha256 else { throw UpdateError("the update file does not match its signed note") }
  }

  /// Unpacks a zip made by `ditto -c -k` (quarantine information is never copied over).
  static func unzip(_ zip: URL, into dir: URL) throws {
    let fm = FileManager.default
    try? fm.removeItem(at: dir)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    try run("/usr/bin/ditto", ["-x", "-k", "--noqtn", zip.path, dir.path])
    try stripQuarantine(dir)
  }
  @discardableResult
  static func run(_ tool: String, _ args: [String]) throws -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
    try p.run()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw UpdateError("\((tool as NSString).lastPathComponent) failed: \(out.prefix(200))") }
    return out
  }
  /// No file of an update may carry the quarantine flag (it would bring back Gatekeeper's prompt).
  static func stripQuarantine(_ root: URL) throws {
    let name = "com.apple.quarantine"
    var paths = [root.path]
    if let e = FileManager.default.enumerator(atPath: root.path) { for case let rel as String in e { paths.append(root.appendingPathComponent(rel).path) } }
    for p in paths { removexattr(p, name, XATTR_NOFOLLOW) }
    let left = paths.filter { getxattr($0, name, nil, 0, 0, XATTR_NOFOLLOW) >= 0 }
    if !left.isEmpty { throw UpdateError("\(left.count) files kept the quarantine flag") }
  }
  static func quarantined(_ root: URL) -> Int {
    var n = getxattr(root.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0 ? 1 : 0
    if let e = FileManager.default.enumerator(atPath: root.path) {
      for case let rel as String in e where getxattr(root.appendingPathComponent(rel).path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0 { n += 1 }
    }
    return n
  }

  /// The app's code signature: whole and sealed, and signed with the developer's own certificate (nil = good).
  static func signatureProblem(_ app: URL) -> String? {
    var code: SecStaticCode?, req: SecRequirement?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return "no code signature" }
    guard SecRequirementCreateWithString(PS_REQUIREMENT as CFString, [], &req) == errSecSuccess, let req else { return "bad requirement" }
    var err: Unmanaged<CFError>?
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
    let st = SecStaticCodeCheckValidityWithErrors(code, flags, req, &err)
    if st == errSecSuccess { return nil }
    let why = err.map { CFErrorCopyDescription($0.takeRetainedValue()) as String } ?? "status \(st)"
    return st == errSecCSReqFailed ? "not signed by PS Local Signing" : "code signature broken (\(why.prefix(120)))"
  }

  /// Two folders trade places in one step (APFS): there is never a moment without a PS.app.
  /// If `b` does not exist yet, `a` simply moves there.
  static func swap(_ a: URL, _ b: URL) throws {
    if !FileManager.default.fileExists(atPath: b.path) {
      guard rename(a.path, b.path) == 0 else { throw UpdateError("could not move PS app into place (\(String(cString: strerror(errno))))") }
      return
    }
    guard renamex_np(a.path, b.path, UInt32(RENAME_SWAP)) == 0 else {
      // macOS's App Management protection says no: the developer allows PS once in System Settings.
      if errno == EPERM || errno == EACCES { throw UpdateError("macOS did not let PS app replace itself. Turn PS app on in System Settings > Privacy & Security > App Management, then try again") }
      throw UpdateError("could not swap PS app (\(String(cString: strerror(errno))))")
    }
  }
  static func sameVolume(_ a: URL, _ b: URL) -> Bool {
    var x = stat(), y = stat()
    return stat(a.path, &x) == 0 && stat(b.path, &y) == 0 && x.st_dev == y.st_dev
  }

  /// Installs a web build like install-web.sh: every file but index.html first (old hashed files
  /// stay so an open page never breaks), then index.html in one rename.
  static func installWeb(from src: URL, to dest: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
    guard fm.fileExists(atPath: src.appendingPathComponent("index.html").path) else { throw UpdateError("the web update has no index.html") }
    let e = fm.enumerator(at: src, includingPropertiesForKeys: [.isDirectoryKey])
    while let u = e?.nextObject() as? URL {
      let rel = String(u.standardizedFileURL.path.dropFirst(src.standardizedFileURL.path.count + 1))
      if rel == "index.html" { continue }
      let to = dest.appendingPathComponent(rel)
      if (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { try fm.createDirectory(at: to, withIntermediateDirectories: true); continue }
      let tmp = to.deletingLastPathComponent().appendingPathComponent(".\(to.lastPathComponent).new")
      try? fm.removeItem(at: tmp)
      try fm.copyItem(at: u, to: tmp)
      guard rename(tmp.path, to.path) == 0 else { throw UpdateError("could not place \(rel)") }
    }
    let tmp = dest.appendingPathComponent("index.html.new")
    try? fm.removeItem(at: tmp)
    try fm.copyItem(at: src.appendingPathComponent("index.html"), to: tmp)
    guard rename(tmp.path, dest.appendingPathComponent("index.html").path) == 0 else { throw UpdateError("could not place index.html") }
    try? stripQuarantine(dest)
  }
}

// MARK: - The journal: what an app update is in the middle of (survives a restart of the Mac)

struct UpdateJournal: Codable {
  var phase: String          // "swapped" (new build starting), "ok", "rolledBack"
  var from: Int
  var to: Int
  var target: String         // the installed PS.app
  var previous: String       // the build it replaced (kept for a roll back)
  var failed: String         // where a build that did not start is put
  var socket: String         // the hand over (UpdateHandoff.swift)
  var attempts: Int
  var at: Double
  var shown: Bool            // the "Updated" or "did not start" card has been shown
  var test: Bool

  static func read(_ url: URL = UpdatePaths.journal) -> UpdateJournal? {
    FileManager.default.contents(atPath: url.path).flatMap { try? JSONDecoder().decode(UpdateJournal.self, from: $0) }
  }
  func write(_ url: URL = UpdatePaths.journal) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let d = try? JSONEncoder().encode(self) { try? d.write(to: url, options: .atomic) }
  }
}
