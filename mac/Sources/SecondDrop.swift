import AppKit
import CryptoKit
import UniformTypeIdentifiers
import WebKit

// Second Computer drag and drop (the developer, 2 Nov 2026: "make it so it can actually drag and drop files as well. yeah,
// make it very compatible"). protocol v1.2, section 18 in the lead's notes.
// - Drag in: the Second Computer window and the Tab list's Second panel take drops NATIVELY, so whatever macOS
//   can drag works: Finder and Desktop files, whole folders and packages (.app, .pages), Mail attachments and
//   Photos (file promises), the screenshot thumbnail, pictures and links from a browser, plain text. The page
//   only says what is under the pointer (window.__psSecondDrag), so it can highlight that place.
// - The outbox: every dropped item is staged here first (an APFS clone of a file, a folder packed by ditto with
//   its names, dates, permissions and resource forks), with its SHA-256, so a transfer survives sleep, a lost
//   connection or a restart of PS. The main page reads it 4 MB at a time (second:read) and streams it up.
// - Drag out: a file in the other Mac's list drags to Finder as a file promise; PS asks the other Mac for it and
//   writes it where the developer dropped it, with Finder's own progress on it.
// - Landing a packed folder: SecondZip checks every name in it first (no "..", no absolute paths, nothing written
//   through a link it carries), then ditto unpacks it. The outbox and SecondZip live in SecondFiles.swift.
// Nothing here runs on the main thread except the drag callbacks, which only read the pasteboard and schedule.

// MARK: what a drag carries

/// The parts of a drag PS can send, read from the pasteboard while the drop happens (the pasteboard is not
/// kept): file URLs, file promises (Mail, Photos, the screenshot thumbnail, some browsers), a picture's bytes,
/// a web link with its title, plain text.
struct SecondDragLoad {
  var files: [URL] = []
  var promises: [NSFilePromiseReceiver] = []
  var image: Data?
  var link: URL?
  var linkName: String?
  var text: String?
  var isEmpty: Bool { files.isEmpty && promises.isEmpty && image == nil && link == nil && (text ?? "").isEmpty }

  static let types: [NSPasteboard.PasteboardType] = [.fileURL, .URL, .png, .tiff, .string, NSPasteboard.PasteboardType(UTType.image.identifier)]
    + NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }

  /// Whether a drag has anything PS can send (cheap: types only).
  static func can(_ pb: NSPasteboard) -> Bool { pb.availableType(from: types) != nil }

  static func read(_ pb: NSPasteboard) -> SecondDragLoad {
    var l = SecondDragLoad()
    l.files = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    if l.files.isEmpty { l.promises = (pb.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver]) ?? [] }
    if l.files.isEmpty && l.promises.isEmpty {
      if let png = pb.data(forType: .png) { l.image = png }
      else if let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) { l.image = rep.representation(using: .png, properties: [:]) }
      if let u = (pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL])?.first, !u.isFileURL, ["http", "https"].contains(u.scheme?.lowercased() ?? "") { l.link = u }
      l.linkName = pb.string(forType: NSPasteboard.PasteboardType("public.url-name"))
      if l.image == nil && l.link == nil { l.text = pb.string(forType: .string) }
    }
    return l
  }

  /// A name for a dragged picture or link: the page title, else the last part of the address, else a plain word.
  static func name(for u: URL?, title: String?, ext: String, fallback: String) -> String {
    var s = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty, let u { s = u.deletingPathExtension().lastPathComponent }
    if s.isEmpty || s == "/" { s = u?.host ?? fallback }
    s = String(SecondLanding.clean(s).prefix(80))
    return s.lowercased().hasSuffix("." + ext) ? s : s + "." + ext
  }

  /// A .webloc file: what Finder makes when a link is dragged to the Desktop.
  static func webloc(_ u: URL) -> Data? {
    try? PropertyListSerialization.data(fromPropertyList: ["URL": u.absoluteString], format: .xml, options: 0)
  }
}

// MARK: drag in, for a web view that shows Second Computer

/// The window's and the Tab list's web views call these from their NSDraggingDestination methods. The page says
/// what is under the pointer (`window.__psSecondDrag.over(x, y)`, null outside a Second Computer drop place);
/// only then does PS take the drop itself, and anything else goes to the page as before.
final class SecondDropZone {
  private weak var view: WKWebView?
  private var ok = false
  private var asked = Date.distantPast
  private var lastPoint = CGPoint(x: -1, y: -1)
  /// The drop: what it carried and the page's target there.
  var onDrop: (SecondDragLoad, [String: Any]) -> Void = { l, t in Second.shared.dropped(l, target: t) }
  /// V1.47: whether the Second Computer places take drops here (the developer's PS); the alarm playlist always does.
  var allowSecond: () -> Bool = { true }
  /// A target this web view takes: the alarm playlist, or a Second place when those are allowed.
  private func takes(_ t: Any?) -> Bool {
    guard let t = t as? [String: Any] else { return false }
    return t["kind"] as? String == "alarm" ? SecondDropZone.targetOk(t) : allowSecond()
  }

  init(_ v: WKWebView) { view = v }

  /// The pointer in page coordinates (CSS pixels from the top left).
  private func point(_ info: NSDraggingInfo) -> CGPoint? {
    guard let v = view else { return nil }
    let p = v.convert(info.draggingLocation, from: nil), z = max(0.1, v.pageZoom)
    return CGPoint(x: p.x / z, y: (v.isFlipped ? p.y : v.bounds.height - p.y) / z)
  }

  /// nil: not ours (the caller asks the page as before). The answer lags the pointer by one look at the page.
  func updated(_ info: NSDraggingInfo) -> NSDragOperation? {
    guard SecondDragLoad.can(info.draggingPasteboard), let v = view, let p = point(info) else { ok = false; return nil }
    let now = Date()
    if hypot(p.x - lastPoint.x, p.y - lastPoint.y) > 2 || now.timeIntervalSince(asked) > 0.15 {
      lastPoint = p; asked = now
      v.callAsyncJavaScript("return window.__psSecondDrag ? window.__psSecondDrag.over(x, y) : null", arguments: ["x": p.x, "y": p.y], in: nil, in: .page) { [weak self] r in
        if case .success(let t) = r { self?.ok = self?.takes(t) == true } else { self?.ok = false }
      }
    }
    return ok ? .copy : nil
  }

  func exited() {
    ok = false; lastPoint = CGPoint(x: -1, y: -1)
    view?.callAsyncJavaScript("window.__psSecondDrag && window.__psSecondDrag.leave()", arguments: [:], in: nil, in: .page, completionHandler: nil)
  }

  var taking: Bool { ok }

  /// True: PS took the drop (the page never sees it). The pasteboard is read now; the target is asked once more.
  func perform(_ info: NSDraggingInfo) -> Bool {
    guard ok, let v = view, let p = point(info) else { return false }
    ok = false
    let load = SecondDragLoad.read(info.draggingPasteboard)
    guard !load.isEmpty else { exited(); return false }
    v.callAsyncJavaScript("return window.__psSecondDrag ? window.__psSecondDrag.drop(x, y) : null", arguments: ["x": p.x, "y": p.y], in: nil, in: .page) { [weak self] r in
      guard case .success(let t) = r, let target = t as? [String: Any], SecondDropZone.targetOk(target), self?.takes(target) == true else { self?.exited(); return }
      if target["kind"] as? String == "alarm" {   // V1.47: audio files for the alarm playlist (AlarmList.swift)
        AlarmListStore.shared.add(load.files)
        return
      }
      if target["kind"] as? String == "msg", load.files.isEmpty, load.promises.isEmpty, load.image == nil {
        // A link or text dropped on Messages goes into the note being written.
        let t = load.link?.absoluteString ?? load.text ?? ""
        if !t.isEmpty { self?.view?.callAsyncJavaScript("window.__psSecondDrag && window.__psSecondDrag.text(t)", arguments: ["t": String(t.prefix(4000))], in: nil, in: .page, completionHandler: nil) }
        return
      }
      self?.onDrop(load, target)
    }
    return true
  }

  /// A target the page named: files (optionally into a shared folder of the other Mac) or a note's attachments.
  static func targetOk(_ t: [String: Any]) -> Bool {
    switch t["kind"] as? String {
    case "msg", "alarm": return Set(t.keys) == ["kind"]
    case "files":
      guard Set(t.keys).isSubset(of: ["kind", "root", "dir"]) else { return false }
      if let r = t["root"] { guard let r = r as? String, SecondShare.rootIdOk(r) else { return false } }
      if let d = t["dir"] { guard let d = d as? String, d.isEmpty || SecondShare.pathOk(d) else { return false } }
      return true
    default: return false
    }
  }
}

// MARK: drag out, to Finder

/// A file of the other Mac's shared folder dragged out of the window: a file promise Finder fulfils by asking PS.
/// A file of THIS Mac's shared folder drags as the file itself.
final class SecondDragOut: NSObject, NSDraggingSource, NSFilePromiseProviderDelegate {
  static let shared = SecondDragOut()
  private let q: OperationQueue = { let q = OperationQueue(); q.name = "ps.second.dragout"; q.qualityOfService = .userInitiated; return q }()

  /// An item the page armed on mouse down: {device, root, path, name, dir, size, mine}.
  static func itemOk(_ m: [String: Any]) -> Bool {
    guard let d = m["device"] as? String, SecondJobs.isId(d) || d.count <= 64, let r = m["root"] as? String, SecondShare.rootIdOk(r),
          let p = m["path"] as? String, SecondShare.pathOk(p) else { return false }
    return true
  }

  func begin(from v: NSView, event: NSEvent, item: [String: Any]) {
    guard SecondDragOut.itemOk(item), let path = item["path"] as? String else { return }
    let name = (path as NSString).lastPathComponent, isDir = item["dir"] as? Bool == true
    let writer: NSPasteboardWriting
    if item["mine"] as? Bool == true {
      guard let local = Second.shared.localShared(root: item["root"] as? String ?? "", path: path) else { return }
      writer = URL(fileURLWithPath: local) as NSURL
    } else {
      let type = isDir ? ((name as NSString).pathExtension.isEmpty ? UTType.folder : UTType(filenameExtension: (name as NSString).pathExtension) ?? .folder)
        : UTType(filenameExtension: (name as NSString).pathExtension) ?? .data
      let p = NSFilePromiseProvider(fileType: type.identifier, delegate: self)
      p.userInfo = item
      writer = p
    }
    let di = NSDraggingItem(pasteboardWriter: writer)
    let icon = isDir ? NSWorkspace.shared.icon(for: .folder) : NSWorkspace.shared.icon(for: UTType(filenameExtension: (name as NSString).pathExtension) ?? .data)
    let at = v.convert(event.locationInWindow, from: nil)
    di.setDraggingFrame(NSRect(x: at.x - 24, y: at.y - 24, width: 48, height: 48), contents: icon)
    v.beginDraggingSession(with: [di], event: event, source: self)
    psLog("PS second: a file is being dragged out of the Second Computer window")
  }

  func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor c: NSDraggingContext) -> NSDragOperation { c == .outsideApplication ? .copy : [] }

  func filePromiseProvider(_ p: NSFilePromiseProvider, fileNameForType fileType: String) -> String {
    let path = (p.userInfo as? [String: Any])?["path"] as? String ?? "file"
    return SecondLanding.clean((path as NSString).lastPathComponent)
  }
  func operationQueue(for p: NSFilePromiseProvider) -> OperationQueue { q }
  func filePromiseProvider(_ p: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) {
    guard let item = p.userInfo as? [String: Any] else { completionHandler(SecondDragOut.err("Nothing to fetch")); return }
    DispatchQueue.main.async { Second.shared.fetchTo(item, dest: url, done: completionHandler) }
  }

  static func err(_ s: String) -> NSError { NSError(domain: "PS.Second", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }
}

// MARK: the web views

/// A web view that may show a Second Computer drop place (the window, the Tab list). Until `takeSecondDrops()` it
/// behaves exactly as a plain WKWebView.
/// V1.47 Soundboard (Soundboard.swift): after `takeSoundboardDrops()` (the Tab list, everyone's PS), files and folders
/// dragged over it while its page says the Soundboard is open (`sb:open`) are the Soundboard's: the page never sees that
/// drag (only `drag` on and off) and Second Computer does not get it. With the Soundboard closed, nothing changes.
class SecondDropWebView: WKWebView {
  private var zone: SecondDropZone?
  private var handled = false
  private var soundboard = false
  private var sbDrag = false

  func takeSoundboardDrops() {
    soundboard = true
    registerForDraggedTypes(Array(Set(registeredDraggedTypes + [.fileURL])))
  }
  /// A drag that is the Soundboard's: decided once, when it comes in.
  private func sbWants(_ s: NSDraggingInfo) -> Bool {
    soundboard && Soundboard.shared.isOpen(self) && Soundboard.canTake(s.draggingPasteboard)
  }
  /// Drag out: the file the page armed on mouse down (second:dragArm), and where the press began.
  var dragItem: [String: Any]?
  private var downAt: NSPoint?

  func takeSecondDrops() { secondOk = true; takeDrops() }
  /// V1.47: audio files dropped on the alarm playlist in Settings (everyone's PS; the Second places only while Second Computer is on).
  func takeAlarmDrops() { takeDrops() }
  private var secondOk = false
  private func takeDrops() {
    guard zone == nil else { return }
    let z = SecondDropZone(self)
    z.allowSecond = { [weak self] in self?.secondOk == true && Second.shared.isOn }   // PS 1.65: only while its switch is on
    zone = z
    registerForDraggedTypes(Array(Set(registeredDraggedTypes + SecondDragLoad.types)))
  }

  override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
    if sbWants(s) { sbDrag = true; Soundboard.shared.dragging(true, web: self); return .copy }
    sbDrag = false
    let op = super.draggingEntered(s)
    return zone?.updated(s) ?? op
  }
  override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation {
    if sbDrag { return .copy }
    if let op = zone?.updated(s) { return op }
    return super.draggingUpdated(s)
  }
  override func draggingExited(_ s: NSDraggingInfo?) {
    if sbDrag { sbDrag = false; Soundboard.shared.dragging(false, web: self); return }
    zone?.exited()
    super.draggingExited(s)
  }
  override func prepareForDragOperation(_ s: NSDraggingInfo) -> Bool {
    sbDrag || zone?.taking == true || super.prepareForDragOperation(s)
  }
  override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
    if sbDrag {
      sbDrag = false
      Soundboard.shared.dragging(false, web: self)
      Soundboard.shared.dropped(Soundboard.dropURLs(s.draggingPasteboard), from: self)
      handled = true
      return true
    }
    guard let zone, zone.taking else { return super.performDragOperation(s) }
    super.draggingExited(s)   // WebKit forgets the drag; the page never gets this drop
    handled = zone.perform(s)
    return handled
  }
  override func concludeDragOperation(_ s: NSDraggingInfo?) {
    if handled { handled = false; return }
    super.concludeDragOperation(s)
  }

  override func mouseDown(with e: NSEvent) { downAt = e.locationInWindow; super.mouseDown(with: e) }
  override func mouseUp(with e: NSEvent) { dragItem = nil; downAt = nil; super.mouseUp(with: e) }
  override func mouseDragged(with e: NSEvent) {
    if let item = dragItem, let d = downAt, hypot(e.locationInWindow.x - d.x, e.locationInWindow.y - d.y) > 4 {
      dragItem = nil; downAt = nil
      // The page gets its mouse up now, so it does not think the button is still held when the drag ends.
      if let up = NSEvent.mouseEvent(with: .leftMouseUp, location: e.locationInWindow, modifierFlags: [], timestamp: e.timestamp, windowNumber: e.windowNumber,
                                     context: nil, eventNumber: 0, clickCount: 1, pressure: 0) { super.mouseUp(with: up) }
      SecondDragOut.shared.begin(from: self, event: e, item: item)
      return
    }
    super.mouseDragged(with: e)
  }
}
