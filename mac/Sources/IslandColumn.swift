import AppKit

// Pop ups with windows of their own out of the Dynamic Island (V1.55, the developer 12 Nov 2026: "Actually yes. But make it so
// you can change it all in settings"). The 15 min and task reminders (Reminders.swift), the update card (UpdateUI.swift),
// the restart helper alert (HelperAlert.swift), the meeting notes card (NotesCard.swift) and the Soundboard card
// (Soundboard.swift) each ask here where to go. While the island is there for cards and the developer left that kind on Island
// (Settings, the Dynamic Island's own list), the answer is a place under the island: they settle one under the other in
// the order they came, each keeping its own size, buttons and rules, and the card stack (Toast.swift) starts under the
// last of them. Otherwise the answer is nil and the window goes to its usual place, exactly as before.
// Arriving under the island, a window slides down from behind it (the island is drawn above every one of these windows)
// while it fades in, and the island swells as for a card. Only the window's place and its alpha change: nothing inside
// is redrawn or scaled, so each keeps its own look. Never takes the keyboard, never touches 1Password or Signal (every
// one of these windows already hides over them, and the island is gone then, so they would be in their usual place).
// A self test copy keeps every window in its usual place.
final class IslandColumn {
  static let shared = IslandColumn()

  /// `arrived`: the window made its entrance and has stayed in the column since; `target`: where it was last sent.
  private struct Entry { var id: String; var kind: String; weak var window: NSWindow?; var size: CGSize; var replace: () -> Void
    var arrived = false; var target: NSRect? = nil; var alpha: CGFloat = 1 }
  /// The windows under the island now, in the order they came (the first is next to the island).
  private var entries: [Entry] = []
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  /// A self test copy keeps every window in its usual place unless a test asks for the island.
  var testIsland = false

  /// Does this kind come out of the island right now?
  func wants(_ kind: String) -> Bool {
    if Toast.testCopy && !testIsland { return false }
    return NoteDrop.route(kind: kind, island: Island.shared.noteAnchor() != nil, top: Island.shared.model.st.cardsTop)
  }

  /// How urgent each kind of pop up is when several want the island at once (IslandQueueCore: one at a time).
  static func priority(_ kind: String) -> IslandPriority {
    switch kind {
    case "reminders", "helper", "tabblocked": return .high   // PS 1.70: the Tab blocked card (TabBlocked.swift)
    case "update", "notes": return .normal
    default: return .low
    }
  }

  /// Where this window goes under the island, or nil for its usual place (the caller then does what it always did).
  /// `replace`: how the window places itself again (the island moved, a window before it came or went).
  /// PS 1.60: one pop up at a time (IslandQueue.swift). A window that is not first in line is kept out of sight and gets
  /// the same place when its turn comes (put() does nothing for it until then), so none is ever drawn over another.
  func frame(id: String, kind: String, size: CGSize, window: NSWindow, replace: @escaping () -> Void) -> NSRect? {
    guard wants(kind), let a = Island.shared.noteAnchor() else { leave(id); return nil }
    if let i = entries.firstIndex(where: { $0.id == id }) {
      let grew = abs(entries[i].size.height - size.height) > 0.5
      entries[i].size = size; entries[i].window = window; entries[i].replace = replace
      if grew && IslandQueue.shared.isActive(id) { DispatchQueue.main.async { Toast.shared.islandChanged() } }
    } else {
      entries.append(Entry(id: id, kind: kind, window: window, size: size, replace: replace))
    }
    // Not known to the queue yet (a new window), or let go of it (its window was gone too long): ask for the island.
    if !IslandQueue.shared.isActive(id) && !IslandQueue.shared.isWaiting(id) {
      let o = IslandQueue.shared.enqueue(id: id, kind: kind, priority: IslandColumn.priority(kind),
                                         show: { [weak self] in self?.turn(id) },
                                         visible: { [weak self] in self?.entries.first { $0.id == id }?.window?.isVisible == true })
      if o == .showNow { DispatchQueue.main.async { Toast.shared.islandChanged() } }   // the card stack makes room under it
    }
    if !IslandQueue.shared.isActive(id), window.isVisible { window.orderOut(nil) }
    return NoteDrop.columnFrame(a, size: size, offset: 0)
  }

  /// Its turn has come: the window goes to its place under the island and arrives as always.
  private func turn(_ id: String) {
    guard let i = entries.firstIndex(where: { $0.id == id }), entries[i].window != nil, let a = Island.shared.noteAnchor(),
          let f = NoteDrop.columnFrame(a, size: entries[i].size, offset: 0) else {
      entries.removeAll { $0.id == id }
      IslandQueue.shared.finish(id)
      return
    }
    put(entries[i].window!, f, alpha: entries[i].alpha)
    DispatchQueue.main.async { Toast.shared.islandChanged() }
  }

  /// The window went (closed, answered, hidden): the next pop up takes its place, and the card stack moves up.
  func leave(_ id: String) {
    guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
    entries.remove(at: i)
    IslandQueue.shared.finish(id)
    DispatchQueue.main.async { Toast.shared.islandChanged() }
  }

  /// A window under the island goes away as a card shrinks back into it (PS 1.60): it slides up toward the island while it
  /// fades, the island gulps it in (a soft bulge), and then the next pop up may come. False when the window is not under
  /// the island (the caller fades it out as it always did). Under Reduce Motion a short fade only.
  @discardableResult
  func retire(_ w: NSWindow, id: String, completion: @escaping () -> Void) -> Bool {
    guard Features.on("island-moments"), !Toast.testCopy || testIsland, entries.contains(where: { $0.id == id && $0.window === w }),
          IslandQueue.shared.isActive(id), w.isVisible else { return false }
    let calm = reduceMotion
    let side = Island.shared.noteAnchor().map { NoteDrop.spot($0, cap: $0.visible.height).side } ?? .below
    let tuck = calm ? 0 : min(36, w.frame.height * CGFloat(IslandMotionCore.backTuck))
    let to = w.frame.offsetBy(dx: 0, dy: side == .below ? tuck : -tuck)
    Island.shared.swell(false)
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = IslandMotionCore.backDuration(reduceMotion: calm)
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0.3)
      w.animator().setFrame(to, display: true)
      w.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      completion()
      // A new card for the same id may have taken this entry over while the old one shrank: it stays.
      if let self, self.entries.first(where: { $0.id == id })?.window === w { self.leave(id) }
    })
    return true
  }

  /// How far the column reaches from the island (the card stack starts past it): the one pop up on screen. Windows that
  /// went away on their own (closed without a leave) no longer count.
  var height: CGFloat {
    guard let id = IslandQueue.shared.activeId, let e = entries.first(where: { $0.id == id }), e.window?.isVisible == true else { return 0 }
    return NoteDrop.columnHeight([e.size.height])
  }

  /// The island moved, hid, came back, or a choice changed: every window places itself again (some go back to their
  /// usual place, which takes them out of the column).
  func islandChanged() {
    let all = entries.map { $0.replace }
    all.forEach { $0() }
  }
  /// Puts a window at its place under the island: a window already showing glides there; a new one slides down from
  /// behind the island while it fades in, and the island swells. `alpha`: what the window shows at (0 in a test copy).
  /// V1.56 hang fix: a window that already arrived only glides from now on, even while it is still fading in (in V1.55
  /// its arrival started again on every island change and each arrival swelled the island: an endless main thread loop).
  func put(_ w: NSWindow, _ f: NSRect, alpha: CGFloat = 1) {
    let i = entries.firstIndex { $0.window === w }
    if let i {
      entries[i].alpha = alpha
      // Not its turn yet: it waits out of sight (IslandQueue.swift), never on top of the one showing.
      if !IslandQueue.shared.isActive(entries[i].id) { if w.isVisible { w.orderOut(nil) }; return }
    }
    let step = NoteDrop.putStep(arrived: i.map { entries[$0].arrived } ?? false, visible: w.isVisible, alpha: w.alphaValue,
                                current: w.frame, target: i.flatMap { entries[$0].target }, to: f)
    if let i { entries[i].arrived = true; entries[i].target = f }
    if step == .stay { return }
    if step == .glide {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = reduceMotion ? 0 : 0.3
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
        w.animator().setFrame(f, display: true)
      }
      return
    }
    let calm = reduceMotion || Toast.testCopy
    let side = Island.shared.noteAnchor().map { NoteDrop.spot($0, cap: $0.visible.height).side } ?? .below
    // From behind the island: up to 36 points nearer to it, so its edge starts tucked under the island's.
    let tuck = calm ? 0 : min(36, f.height * 0.5)
    let from = f.offsetBy(dx: 0, dy: side == .below ? tuck : -tuck)
    w.setFrame(from, display: false)
    w.alphaValue = 0
    w.orderFrontRegardless()
    Island.shared.swell(true)
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = calm ? 0.2 : 0.5
      ctx.timingFunction = calm ? CAMediaTimingFunction(name: .easeOut) : CAMediaTimingFunction(controlPoints: 0.22, 1.12, 0.36, 1)
      w.animator().setFrame(f, display: true)
      w.animator().alphaValue = alpha
    }
  }

  /// Self test and the note's checks: which windows are under the island, in order.
  var ids: [String] { entries.map { $0.id } }
}
