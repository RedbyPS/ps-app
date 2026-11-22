import Foundation
// Break-it 1.74 round 2: what goes to the main page and must arrive (a card's answer, a Clients save from the Tab list) is
// tried in the order it was sent. main.swift sendCardAction used to give each message its own retry, a second apart from its
// own first try, so two sent while the main page loaded (an update reload, a wake) arrived in the order their timers came
// up: a Clients task added and then renamed ran rename first, which found no task and was dropped, then the add.
// Now one message is tried at a time; the next waits until it arrived or was given up on. Tested in tests/inordersend-test.sh.
final class InOrderSend {
  /// Tries one message; calls back true once it arrived, false when the page is not ready yet.
  typealias Attempt = (_ json: String, _ done: @escaping (Bool) -> Void) -> Void
  /// Runs a job after the wait between two tries (a second in the app).
  typealias Later = (_ job: @escaping () -> Void) -> Void
  private var queue: [String] = []
  private var busy = false
  private var tries = 0
  private let maxTries: Int
  private let attempt: Attempt
  private let later: Later
  init(maxTries: Int = 60, attempt: @escaping Attempt, later: @escaping Later) {
    self.maxTries = maxTries; self.attempt = attempt; self.later = later
  }
  /// Messages waiting, the one being tried included.
  var waiting: Int { queue.count }
  func send(_ json: String) { queue.append(json); pump() }
  private func pump() {
    guard !busy, let head = queue.first else { return }
    busy = true
    attempt(head) { [weak self] ok in
      guard let self else { return }
      if ok || self.tries >= self.maxTries {
        self.queue.removeFirst(); self.tries = 0; self.busy = false; self.pump()
        return
      }
      self.tries += 1
      self.later { [weak self] in self?.busy = false; self?.pump() }
    }
  }
}
