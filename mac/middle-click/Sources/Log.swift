import Foundation

// A small local log at ~/Library/Logs/PSMiddleClicker.log (never sent anywhere). Only what the app
// did ("middle click", "tap switched back on"), never what is on screen. Writes happen on a
// background queue, so the tap thread never waits on the disk.
enum Log {
  private static let q = DispatchQueue(label: "psmiddleclicker.log", qos: .utility)
  private static let url = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/\(name).log")
  /// "PSMiddleClicker", or "PS Middle Click" for the helper inside PS: each has its own log.
  private static var name: String { Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "PSMiddleClicker" }
  private static let previous = url.deletingLastPathComponent().appendingPathComponent("\(name).previous.log")
  private static let stamp: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f
  }()

  /// Waits until every line written so far is on disk (at quit, so the last line is not lost).
  static func flush() { q.sync {} }

  static func write(_ s: String) {
    let now = Date()
    q.async {
      let line = "\(stamp.string(from: now))  \(s)\n"
      // Keep it small: past 256 KB the log moves to "PSMiddleClicker.previous.log" (one kept).
      if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 256_000 {
        try? FileManager.default.removeItem(at: previous)
        try? FileManager.default.moveItem(at: url, to: previous)
      }
      if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
      } else {
        try? Data(line.utf8).write(to: url)
      }
    }
  }
}
