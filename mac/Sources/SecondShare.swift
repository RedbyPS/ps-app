import CoreServices
import Foundation

// Second Computer, shared folders (protocol v1.1 section 15). Each Mac shares ONLY the folders in its own
// setting (the default is ~/PS Shared, made on first run; adding or removing one happens only on that Mac).
// - The index: one signed listing per shared root (t:"idx"), sent to the page as second:idx only when the
//   listing changed (FSEvents, 10 s quiet first), never on a timer. Hidden files are skipped, and so is
//   anything whose real path leaves the root (a symlink out). At most 5000 entries, newest first.
// - A request from the other Mac (t:"get"): its keys exactly as core/second.ts checkGet, the root shared on
//   THIS Mac, the real path of root + path inside it, a regular file of 50 MB or less. Then the bytes go
//   up through the page (second:upload purpose "share"). v1.2: with a page that streams (caps "outbox"), up to
//   1 GB, and a folder or package too, packed; it goes through the outbox (SecondDrop.swift).
// - A file sent INTO a shared folder (sfile purpose "share", root, dir): same path checks, never over an
//   existing file (" 2"), else Downloads, From PS.
// Everything here runs off the main thread except the FSEvents callback, which only schedules.

enum SecondShare {
  struct Root: Equatable { var id: String; var name: String; var path: String }
  static let maxEntries = 5000

  /// A relative path the other Mac may name (core/second.ts sharePathOk).
  static func pathOk(_ p: String) -> Bool {
    guard !p.isEmpty, p.utf16.count <= 1024, !p.hasPrefix("/"), !p.contains("\\"), !p.unicodeScalars.contains(where: { $0.value < 32 }) else { return false }
    return p.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." && !$0.hasPrefix(".") }
  }
  static func rootIdOk(_ s: String) -> Bool { !s.isEmpty && s.count <= 40 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") } }

  /// `root/rel` resolved, only if it stays inside the root (symlinks followed).
  static func inside(_ root: Root, _ rel: String) -> String? {
    let r = SafePath.real(root.path)
    let p = rel.isEmpty ? r : SafePath.real(root.path + "/" + rel)
    return p == r || p.hasPrefix(r + "/") ? p : nil
  }

  static func kind(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp", "svg": return "image"
    case "pdf": return "pdf"
    case "txt", "md", "json", "csv", "log", "swift", "ts", "tsx", "js", "html", "css", "yml", "yaml", "xml", "py", "sh": return "text"
    default: return "other"
    }
  }

  /// The listing of one root: [{p, d?, s, m, k?}], newest first, at most 5000.
  static func index(_ root: Root) -> [[String: Any]] {
    let fm = FileManager.default
    let real = SafePath.real(root.path)
    let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
    guard let e = fm.enumerator(at: URL(fileURLWithPath: real, isDirectory: true), includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
    var out: [(Double, [String: Any])] = []
    for case let u as URL in e {
      guard let v = try? u.resourceValues(forKeys: Set(keys)) else { continue }
      let full = u.standardizedFileURL.path
      guard full.hasPrefix(real + "/") else { continue }
      let rel = String(full.dropFirst(real.count + 1))
      guard pathOk(rel) else { e.skipDescendants(); continue }
      var dir = v.isDirectory == true, size = v.fileSize ?? 0, mtime = v.contentModificationDate
      if v.isSymbolicLink == true {
        // A link counts only while its target stays inside the root; links are never walked into.
        let t = SafePath.real(full)
        guard t.hasPrefix(real + "/"), let tv = try? URL(fileURLWithPath: t).resourceValues(forKeys: Set(keys)) else { continue }
        dir = tv.isDirectory == true; size = tv.fileSize ?? 0; mtime = tv.contentModificationDate
      } else if !dir && v.isRegularFile != true { continue }
      let m = ((mtime ?? Date.distantPast).timeIntervalSince1970 * 1000).rounded()
      var entry: [String: Any] = ["p": rel, "s": dir ? 0 : size, "m": m]
      if dir { entry["d"] = true } else { entry["k"] = kind(rel) }
      out.append((m, entry))
    }
    return out.sorted { $0.0 > $1.0 }.prefix(maxEntries).map { $0.1 }
  }

  /// A get request body: nil when it may be served, else the plain reason (core/second.ts checkGet).
  static func check(_ b: [String: Any], roots: [Root]) -> (Root, String)? {
    guard Set(b.keys).isSubset(of: ["v", "t", "id", "from", "to", "at", "root", "path", "as"]), b["t"] as? String == "get",
          let rid = b["root"] as? String, rootIdOk(rid), let path = b["path"] as? String, pathOk(path),
          let a = b["as"] as? String, a == "download" || a == "preview" else { return nil }
    guard let root = roots.first(where: { $0.id == rid }) else { return nil }
    return (root, path)
  }
  /// The file a checked request names, if it is a regular file inside the root, `max` bytes or less (50 MB sent
  /// whole; 1 GB streamed through the outbox). `folders`: a folder or package may be named too (it goes packed).
  static func file(_ root: Root, _ path: String, max: Int = SecondLanding.maxFile, folders: Bool = false) -> Result<String, SecondRefusal> {
    guard let p = inside(root, path), p != SafePath.real(root.path) else { return .failure(SecondRefusal(why: "Not in a shared folder")) }
    guard let a = try? FileManager.default.attributesOfItem(atPath: p) else { return .failure(SecondRefusal(why: "No such file")) }
    if a[.type] as? FileAttributeType == .typeDirectory {
      return folders ? .success(p) : .failure(SecondRefusal(why: "Folders need PS app updated on this Mac"))
    }
    guard a[.type] as? FileAttributeType == .typeRegular else { return .failure(SecondRefusal(why: "No such file")) }
    guard ((a[.size] as? Int) ?? 0) <= max else { return .failure(SecondRefusal(why: max > SecondLanding.maxFile ? "Over 1 GB" : "Over 50 MB")) }
    return .success(p)
  }
  /// Where a file sent into `root`/`dir` goes: that folder (made when missing, inside the root), else nil.
  static func landingDir(_ roots: [Root], root rid: String?, dir: String?) -> String? {
    guard let rid, let root = roots.first(where: { $0.id == rid }) else { return nil }
    let d = dir ?? ""
    guard d.isEmpty || pathOk(d) else { return nil }
    let target = SafePath.real(root.path) + (d.isEmpty ? "" : "/" + d)
    try? FileManager.default.createDirectory(atPath: target, withIntermediateDirectories: true)
    return inside(root, d) == target ? target : nil
  }
}

/// Watches the shared roots and says when one changed (after `quiet` seconds without changes).
final class SecondShareWatch {
  private var stream: FSEventStreamRef?
  private let q: DispatchQueue
  private var pending: DispatchWorkItem?
  private let quiet: Double
  var onChange: () -> Void = {}

  init(queue: DispatchQueue, quiet: Double) { q = queue; self.quiet = quiet }

  func watch(_ paths: [String]) {
    stop()
    guard !paths.isEmpty else { return }
    var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    let cb: FSEventStreamCallback = { _, info, _, _, _, _ in
      guard let info else { return }
      Unmanaged<SecondShareWatch>.fromOpaque(info).takeUnretainedValue().changed()
    }
    guard let s = FSEventStreamCreate(nil, cb, &ctx, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 2.0,
                                      FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer)) else { return }
    FSEventStreamSetDispatchQueue(s, q)
    FSEventStreamStart(s)
    stream = s
  }
  func stop() {
    if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s) }
    stream = nil
  }
  private func changed() {
    pending?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.onChange() }
    pending = w
    q.asyncAfter(deadline: .now() + quiet, execute: w)
  }
}
