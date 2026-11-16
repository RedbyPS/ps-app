import CryptoKit
import Foundation
import UniformTypeIdentifiers

// Second Computer drag and drop, the parts without a window (protocol v1.2): the outbox that stages dropped files
// and folders, and the check and unpacking of a packed folder. SecondDrop.swift has the drag itself; the unit test
// (tests/second-test.swift) compiles this file without the app.

/// One staged item, as its manifest (outbox/<id>/m.json) and as the page sees it in second:outbox.
enum SecondOutbox {
  static let maxFile = 1 << 30            // 1 GB a file or packed folder (core/second.ts STREAM_MAX)
  static let maxItems = 200
  static let chunk = 4 << 20

  static func dir(_ places: SecondPlaces) -> String { places.root + "/outbox" }

  /// Every staged item, oldest first (any thread).
  static func list(_ places: SecondPlaces) -> [[String: Any]] {
    let d = dir(places), fm = FileManager.default
    let ids = (try? fm.contentsOfDirectory(atPath: d)) ?? []
    let all = ids.compactMap { id -> [String: Any]? in
      guard SecondJobs.isId(id), let data = fm.contents(atPath: d + "/" + id + "/m.json"),
            let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any], fm.fileExists(atPath: d + "/" + id + "/data") else { return nil }
      return m
    }
    return all.sorted { (($0["at"] as? NSNumber)?.doubleValue ?? 0) < (($1["at"] as? NSNumber)?.doubleValue ?? 0) }
  }

  static func write(_ m: [String: Any], _ places: SecondPlaces) {
    guard let id = m["id"] as? String, let data = try? JSONSerialization.data(withJSONObject: m) else { return }
    let path = dir(places) + "/" + id + "/m.json", tmp = path + ".tmp"
    FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600])
    _ = rename(tmp, path)
  }

  /// Bytes `i * chunk ..< (i + 1) * chunk` of a staged item.
  static func read(_ places: SecondPlaces, _ id: String, _ i: Int) -> Data? {
    guard SecondJobs.isId(id), i >= 0, let h = FileHandle(forReadingAtPath: dir(places) + "/" + id + "/data") else { return nil }
    defer { try? h.close() }
    do { try h.seek(toOffset: UInt64(i) * UInt64(chunk)); return try h.read(upToCount: chunk) ?? Data() } catch { return nil }
  }

  static func remove(_ places: SecondPlaces, _ id: String) {
    guard SecondJobs.isId(id) else { return }
    try? FileManager.default.removeItem(atPath: dir(places) + "/" + id)
  }

  /// A failed landing ("did not arrive whole"): the same bytes again under a new id, once.
  static func retry(_ places: SecondPlaces, _ id: String) -> String? {
    guard SecondJobs.isId(id), var m = list(places).first(where: { $0["id"] as? String == id }), m["retried"] == nil else { return nil }
    let nid = UUID().uuidString.lowercased(), fm = FileManager.default
    guard (try? fm.moveItem(atPath: dir(places) + "/" + id, toPath: dir(places) + "/" + nid)) != nil else { return nil }
    m["id"] = nid; m["retried"] = true; m["at"] = (Date().timeIntervalSince1970 * 1000).rounded()
    write(m, places)
    return nid
  }

  struct Staged { var items: [[String: Any]]; var problems: [String] }

  /// Stages files and folders (on a background queue). `target`: where it goes ({kind:"files", root?, dir?},
  /// {kind:"msg"} held until the note is sent, or {kind:"get", get, to} for a file the other Mac asked for).
  static func stage(_ urls: [URL], target: [String: Any], places: SecondPlaces, ditto: String = "/usr/bin/ditto") -> Staged {
    var out = Staged(items: [], problems: [])
    let fm = FileManager.default
    try? fm.createDirectory(atPath: dir(places), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let have = list(places).count
    for (k, raw) in urls.enumerated() {
      let src = raw.resolvingSymlinksInPath()
      let name = SecondLanding.clean(raw.lastPathComponent)
      if have + k >= maxItems { out.problems.append("\(name): too many files waiting to go (\(maxItems) at most)."); continue }
      guard let v = try? src.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .fileSizeKey, .contentModificationDateKey, .isReadableKey]), v.isReadable != false else {
        out.problems.append("\(name): PS app cannot read it."); continue
      }
      let id = UUID().uuidString.lowercased(), folder = dir(places) + "/" + id, data = folder + "/data"
      try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      var m: [String: Any] = ["id": id, "name": name, "target": target, "at": (Date().timeIntervalSince1970 * 1000).rounded()]
      if target["kind"] as? String == "msg" { m["hold"] = true }
      if let d = v.contentModificationDate { m["m"] = (d.timeIntervalSince1970 * 1000).rounded() }
      if v.isDirectory == true {
        // A folder or a package: one zip that keeps names, dates, permissions and resource forks.
        let need = folderSize(src)
        if need > maxFile * 2 { try? fm.removeItem(atPath: folder); out.problems.append("\(name): too big (\(fmt(need))). The limit is 1 GB a folder."); continue }
        guard freeBytes(folder) > Int64(need) + (1 << 30) else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): not enough free space on this Mac to pack it."); continue }
        let r = SecondGit.run(ditto, ["-c", "-k", "--sequesterRsrc", "--keepParent", src.path, data])
        guard r.0 == 0 else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): could not pack that folder."); continue }
        m["pack"] = "zip"; m["mime"] = "application/zip"
      } else if v.isRegularFile == true {
        let size = v.fileSize ?? 0
        if size == 0 { try? fm.removeItem(atPath: folder); out.problems.append("\(name): that file is empty."); continue }
        if size > maxFile { try? fm.removeItem(atPath: folder); out.problems.append("\(name): too big (\(fmt(size))). The limit is 1 GB a file."); continue }
        guard freeBytes(folder) > Int64(size) + (1 << 30) else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): not enough free space on this Mac."); continue }
        // On the same disk this is an APFS clone: instant, and no extra space until one of them changes.
        guard (try? fm.copyItem(atPath: src.path, toPath: data)) != nil else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): PS app cannot read it."); continue }
        m["mime"] = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
      } else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): not a file or a folder."); continue }
      let size = ((try? fm.attributesOfItem(atPath: data))?[.size] as? Int) ?? 0
      if size > maxFile { try? fm.removeItem(atPath: folder); out.problems.append("\(name): too big once packed (\(fmt(size))). The limit is 1 GB."); continue }
      guard let sum = sha256(data) else { try? fm.removeItem(atPath: folder); out.problems.append("\(name): PS app cannot read it."); continue }
      m["size"] = size; m["sha256"] = sum
      write(m, places)
      out.items.append(m)
    }
    return out
  }

  /// Raw bytes from a drag (a picture, a link, text), staged as one file named `name`.
  static func stage(data: Data, name: String, target: [String: Any], places: SecondPlaces) -> Staged {
    let tmp = places.root + "/drop-tmp/" + UUID().uuidString.lowercased()
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let p = tmp + "/" + SecondLanding.clean(name)
    guard (try? data.write(to: URL(fileURLWithPath: p))) != nil else { return Staged(items: [], problems: ["\(name): PS app could not keep it."]) }
    return stage([URL(fileURLWithPath: p)], target: target, places: places)
  }

  static func sha256(_ path: String) -> String? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    var s = SHA256()
    while true {
      let d: Data
      do { d = try h.read(upToCount: 1 << 22) ?? Data() } catch { return nil }   // nil at the end of the file
      if d.isEmpty { break }
      s.update(data: d)
    }
    return s.finalize().map { String(format: "%02x", $0) }.joined()
  }
  static func folderSize(_ u: URL) -> Int {
    guard let e = FileManager.default.enumerator(at: u, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
    var n = 0
    for case let f as URL in e { n += (try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0; if n > maxFile * 4 { break } }
    return n
  }
  static func freeBytes(_ path: String) -> Int64 {
    (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage ?? 0
  }
  static func fmt(_ n: Int) -> String {
    n >= 1 << 30 ? String(format: "%.1f GB", Double(n) / Double(1 << 30)) : n >= 1 << 20 ? "\(n >> 20) MB" : "\(max(1, n >> 10)) KB"
  }
}

// MARK: packed folders

/// Reads a zip's central directory and refuses one that could write outside the folder it unpacks into: an
/// absolute name, a ".." part, or a name under a link the same zip makes. Also counts the unpacked size.
enum SecondZip {
  struct Info { var entries: Int; var bytes: Int; var tops: Set<String> }

  static func check(_ path: String) -> Result<Info, SecondRefusal> {
    func no(_ w: String) -> Result<Info, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard let h = FileHandle(forReadingAtPath: path) else { return no("Could not read the folder") }
    defer { try? h.close() }
    guard let end = try? h.seekToEnd(), end >= 22 else { return no("Not a packed folder") }
    let tailLen = min(end, 65_557)
    try? h.seek(toOffset: end - tailLen)
    guard let tail = try? h.read(upToCount: Int(tailLen)) else { return no("Not a packed folder") }
    let t = [UInt8](tail)
    func u16(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 }
    func u32(_ b: [UInt8], _ o: Int) -> Int { u16(b, o) | u16(b, o + 2) << 16 }
    func u64(_ b: [UInt8], _ o: Int) -> Int { u32(b, o) | u32(b, o + 4) << 32 }
    guard let eo = stride(from: t.count - 22, through: 0, by: -1).first(where: { t[$0] == 0x50 && t[$0 + 1] == 0x4b && t[$0 + 2] == 5 && t[$0 + 3] == 6 }) else { return no("Not a packed folder") }
    var count = u16(t, eo + 10), cdSize = u32(t, eo + 12), cdOff = u32(t, eo + 16)
    if count == 0xFFFF || cdSize == 0xFFFF_FFFF || cdOff == 0xFFFF_FFFF {
      // zip64: the locator sits just before the end record and points at the zip64 end record.
      guard eo >= 20, u32(t, eo - 20) == 0x0706_4b50 else { return no("Not a packed folder") }
      let z = u64(t, eo - 20 + 8)
      try? h.seek(toOffset: UInt64(z))
      guard let r = try? h.read(upToCount: 56), r.count == 56, u32([UInt8](r), 0) == 0x0606_4b50 else { return no("Not a packed folder") }
      let b = [UInt8](r)
      count = u64(b, 32); cdSize = u64(b, 40); cdOff = u64(b, 48)
    }
    guard count <= 200_000, cdSize <= 64 << 20, cdOff >= 0, cdOff + cdSize <= Int(end) else { return no("Too many files in that folder") }
    try? h.seek(toOffset: UInt64(cdOff))
    guard let cdData = try? h.read(upToCount: cdSize), cdData.count == cdSize else { return no("Not a packed folder") }
    let cd = [UInt8](cdData)
    var o = 0, total = 0, links: [String] = [], names: [String] = [], tops = Set<String>()
    for _ in 0..<count {
      guard o + 46 <= cd.count, u32(cd, o) == 0x0201_4b50 else { return no("Not a packed folder") }
      let nl = u16(cd, o + 28), xl = u16(cd, o + 30), cl = u16(cd, o + 32)
      var size = u32(cd, o + 24)
      let attrs = u32(cd, o + 38)
      guard o + 46 + nl + xl + cl <= cd.count else { return no("Not a packed folder") }
      let name = String(decoding: cd[(o + 46)..<(o + 46 + nl)], as: UTF8.self)
      if size == 0xFFFF_FFFF {   // zip64 sizes in the extra field 0x0001: uncompressed size first
        var x = o + 46 + nl
        while x + 4 <= o + 46 + nl + xl {
          let id = u16(cd, x), len = u16(cd, x + 2)
          if id == 1, len >= 8, x + 12 <= cd.count { size = u64(cd, x + 4); break }
          x += 4 + len
        }
      }
      o += 46 + nl + xl + cl
      let parts = name.split(separator: "/", omittingEmptySubsequences: true)
      guard !name.hasPrefix("/"), !name.contains("\\"), !parts.contains(where: { $0 == ".." || $0 == "." }), !name.unicodeScalars.contains(where: { $0.value == 0 }) else { return no("A name in that folder is not safe") }
      total += size
      guard total <= 4 << 30 else { return no("Over 4 GB once unpacked") }
      let clean = parts.joined(separator: "/")
      if !clean.hasPrefix("__MACOSX"), let top = parts.first { tops.insert(String(top)) }
      if (attrs >> 16) & 0o170000 == 0o120000 { links.append(clean) }
      names.append(clean)
    }
    for l in links where names.contains(where: { $0.hasPrefix(l + "/") }) { return no("A name in that folder is not safe") }
    return .success(Info(entries: count, bytes: total, tops: tops))
  }

  /// Unpacks a checked zip into `folder` under a free name (or exactly at `exact`). Returns the path it made.
  static func unpack(_ zip: String, into folder: String, name: String, exact: String?, ditto: String = "/usr/bin/ditto") -> Result<String, SecondRefusal> {
    let info: Info
    switch check(zip) { case .failure(let w): return .failure(w); case .success(let i): info = i }
    let fm = FileManager.default
    guard SecondOutbox.freeBytes(folder) > Int64(info.bytes) + (1 << 30) else { return .failure(SecondRefusal(why: "Not enough free space on this Mac")) }
    let tmp = (zip as NSString).deletingLastPathComponent + "/" + UUID().uuidString.lowercased() + ".d"
    try? fm.createDirectory(atPath: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(atPath: tmp) }
    guard SecondGit.run(ditto, ["-x", "-k", zip, tmp]).0 == 0 else { return .failure(SecondRefusal(why: "Could not unpack the folder")) }
    // One folder inside (how PS packs): that folder itself. Anything else: the whole lot in a folder of its own.
    let from = info.tops.count == 1 ? tmp + "/" + info.tops.first! : tmp
    let base = SecondLanding.clean(info.tops.count == 1 ? info.tops.first! : (name as NSString).deletingPathExtension)
    try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true)
    let dest = exact ?? SecondLanding.free(folder, base)
    guard (try? fm.moveItem(atPath: from, toPath: dest)) != nil else { return .failure(SecondRefusal(why: "Could not write the folder")) }
    SecondLanding.quarantine(dest)
    if let e = fm.enumerator(atPath: dest) { for case let p as String in e { SecondLanding.quarantine(dest + "/" + p) } }
    return .success(dest)
  }
}

