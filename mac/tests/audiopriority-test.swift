// Run: bash tests/audiopriority-test.sh
import CoreAudio
import Foundation

var n = 0, bad = 0
func check(_ name: String, _ ok: Bool) { n += 1; if ok { print("ok -", name) } else { bad += 1; print("FAIL -", name) } }
func wait(_ t: Double) { Thread.sleep(forTimeInterval: t) }
let prot: (String) -> Bool = { Protected.matches($0) }

func dev(_ uid: String, _ name: String, _ k: APKind, alive: Bool = true) -> APDevice { APDevice(uid: uid, name: name, kind: k, alive: alive) }
let mac = dev("BuiltInSpeakerDevice", "MacBook Pro Speakers", .builtIn)
let jack = dev("BuiltInHeadphoneOutputDevice", "External Headphones", .jack)
let pods = dev("A0-B1:output", "Sam’s AirPods Max", .bluetooth)
let jbl = dev("C0-D1:output", "JBL Flip 6", .bluetooth)
let hdmi = dev("display-1", "LG UltraFine", .display)
let tv = dev("airplay-tv", "Living Room", .airplay)
let macMic = dev("BuiltInMicrophoneDevice", "MacBook Pro Microphone", .builtIn)
let usbMic = dev("AppleUSBAudioEngine:Acme:DeskMic:123:1", "Desk Mic", .usb)
let podsMic = dev("A0-B1:input", "Sam’s AirPods Max", .bluetooth)
let phoneMic = dev("iphone-mic", "Sam’s iPhone Microphone", .phone)
let signal = dev("signal-audio", "Signal Audio", .usb)
let uids = { (l: [APEntry]) in l.map(\.uid) }

// ---------- first seen devices: where they go ----------
var s = APCore.merge([], [mac, hdmi, tv, pods, jack], side: .speakers, now: 100, protected: prot)
check("speakers placement: headphones and Bluetooth above a display above the Mac, AirPlay last",
      uids(s) == [pods.uid, jack.uid, hdmi.uid, mac.uid, tv.uid])
var m = APCore.merge([], [podsMic, macMic, usbMic, phoneMic], side: .mics, now: 100, protected: prot)
check("microphones placement: USB above the Mac's own, AirPods below it (phone call quality), iPhone last",
      uids(m) == [usbMic.uid, macMic.uid, podsMic.uid, phoneMic.uid])
check("AirPods are in both lists", s.contains { $0.uid == pods.uid } && m.contains { $0.uid == podsMic.uid })
// The person dragged the Mac speakers above the JBL: a new device lands above the first lower placed one.
let custom = [APEntry(uid: jbl.uid, name: jbl.name, kind: .bluetooth, seen: 1), APEntry(uid: mac.uid, name: mac.name, kind: .builtIn, seen: 1)]
check("a new device keeps the person's own order of the others",
      uids(APCore.merge(custom, [mac, hdmi], side: .speakers, now: 5, protected: prot)) == [jbl.uid, hdmi.uid, mac.uid])
check("1Password and Signal never get in, and are dropped if they ever were",
      !uids(APCore.merge([APEntry(uid: "x-signal", name: "Signal", kind: .usb, seen: 1)], [mac, signal], side: .speakers, now: 1, protected: prot)).contains { $0.contains("signal") })

// ---------- merge keeps by id ----------
let renamed = dev(pods.uid, "AirPods Max", .bluetooth)
s = APCore.merge(s, [renamed], side: .speakers, now: 200, protected: prot)
check("a renamed device keeps its place and gets its new name", s[0].uid == pods.uid && s[0].name == "AirPods Max" && s.count == 5)
s = APCore.merge(s, [dev(mac.uid, mac.name, .builtIn, alive: false)], side: .speakers, now: 300, protected: prot)
check("seen time moves only while connected", s.first { $0.uid == mac.uid }?.seen == 100)
let movedMic = dev("AppleUSBAudioEngine:Acme:DeskMic:123:2", "Desk Mic", .usb)
let m2 = APCore.merge(m, [macMic, movedMic], side: .mics, now: 400, protected: prot)
check("the same USB microphone in another port takes its old place", uids(m2) == [movedMic.uid, macMic.uid, podsMic.uid, phoneMic.uid])
let twin1 = dev("usb-a", "USB Audio", .usb), twin2 = dev("usb-b", "USB Audio", .usb)
let tw = APCore.merge([APEntry(uid: "usb-old", name: "USB Audio", kind: .usb, seen: 1)], [twin1, twin2], side: .speakers, now: 2, protected: prot)
check("two connected devices with one name are never merged into an old one", tw.count == 3)
var big: [APEntry] = (0..<45).map { APEntry(uid: "d\($0)", name: "D\($0)", kind: .usb, seen: Double($0)) }
big = APCore.merge(big, [dev("d0", "D0", .usb)], side: .speakers, now: 1000, protected: prot)
check("at most 40 per list: the longest unseen not connected ones go, a connected one stays", big.count == 40 && big.contains { $0.uid == "d0" } && !big.contains { $0.uid == "d1" })

// ---------- order, forget, top ----------
let base = APCore.merge([], [pods, jbl, mac], side: .speakers, now: 1, protected: prot)
check("reorder: the named ones first, unknown and repeats ignored, the rest kept",
      uids(APCore.reorder(base, [mac.uid, "nope", mac.uid, pods.uid])) == [mac.uid, pods.uid, jbl.uid])
check("forget: a remembered device goes", uids(APCore.forget(base, jbl.uid, connected: [mac.uid])) == [pods.uid, mac.uid])
check("forget: a connected device cannot be forgotten", APCore.forget(base, mac.uid, connected: [mac.uid]) == base)
check("top: the highest connected one", APCore.top(base, alive: [mac.uid, jbl.uid]) == jbl.uid && APCore.top(base, alive: []) == nil)

// ---------- saved forever: tolerant reading ----------
let json = #"{"speakers":[{"uid":"a","name":"A","kind":"usb","seen":1},{"uid":"a","name":"dup"},{"name":"no uid"},{"uid":"b","kind":"hologram"}],"mics":"broken","extra":1}"#
let dec = try? JSONDecoder().decode(APLists.self, from: Data(json.utf8))
check("a bad entry is dropped, never the whole list; an unknown kind reads as other",
      dec?.speakers.map(\.uid) == ["a", "b"] && dec?.speakers[1].kind == .other && dec?.mics == [])
let round = try? JSONDecoder().decode(APLists.self, from: JSONEncoder().encode(APLists(speakers: base, mics: m)))
check("lists survive a save and a load unchanged", round == APLists(speakers: base, mics: m))

// ---------- moving over from Headphones mode ----------
var hp = HPPrefs()
hp.spkOut = [HPRef(uid: mac.uid, name: mac.name)]; hp.hpOut = [HPRef(uid: pods.uid, name: "AirPods Max"), HPRef(uid: jbl.uid, name: jbl.name)]
hp.spkMic = [HPRef(uid: macMic.uid, name: macMic.name)]; hp.hpMic = [HPRef(uid: usbMic.uid, name: usbMic.name)]
hp.auto = true
var mg = APCore.migrate(hp, mode: "speakers")
check("migration, auto switch on: headphones first, then speakers", uids(mg.speakers) == [pods.uid, jbl.uid, mac.uid] && uids(mg.mics) == [usbMic.uid, macMic.uid])
hp.auto = false
mg = APCore.migrate(hp, mode: "speakers")
check("migration, auto off in Speakers: the Speakers lists first", uids(mg.speakers) == [mac.uid, pods.uid, jbl.uid] && uids(mg.mics) == [macMic.uid, usbMic.uid])
check("migration, auto off in Headphones: the Headphones lists first", uids(APCore.migrate(hp, mode: "headphones").speakers) == [pods.uid, jbl.uid, mac.uid])
check("migration with nothing saved: empty lists", APCore.migrate(nil, mode: nil) == APLists())
let oldJSON = #"{"auto":true,"hpOut":[{"uid":"A0-B1:output","name":"AirPods Max"}],"spkOut":"junk"}"#
check("migration reads the old saved copy even when part of it is broken",
      (try? JSONDecoder().decode(HPPrefs.self, from: Data(oldJSON.utf8))).map { APCore.migrate($0, mode: nil).speakers.map(\.uid) } == [pods.uid])
let mgs = APCore.merge(APCore.migrate(hp, mode: "headphones").speakers, [mac, pods, hdmi], side: .speakers, now: 9, protected: prot)
check("after migration, connected devices get their real kind and new ones are placed", mgs.first { $0.uid == mac.uid }?.kind == .builtIn && mgs.contains { $0.uid == hdmi.uid })

// ---------- who changed the default ----------
check("who: PS asked for it", APCore.who(newDefault: "a", expected: ("a", 10), devicesChanged: true, previousGone: false, now: 5) == .ps)
check("who: macOS, devices came or went", APCore.who(newDefault: "a", expected: nil, devicesChanged: true, previousGone: false, now: 5) == .system)
check("who: macOS, the old default went away", APCore.who(newDefault: "a", expected: nil, devicesChanged: false, previousGone: true, now: 5) == .system)
check("who: the person, nothing else happened", APCore.who(newDefault: "a", expected: ("b", 10), devicesChanged: false, previousGone: false, now: 5) == .person)
check("who: an old expectation does not count", APCore.who(newDefault: "a", expected: ("a", 4), devicesChanged: false, previousGone: false, now: 5) == .person)

// ---------- the manual change rule ----------
let order = APCore.merge([], [jbl, pods, hdmi, mac], side: .speakers, now: 1, protected: prot)   // jbl, pods, hdmi, mac
let all: Set<String> = [jbl.uid, pods.uid, hdmi.uid, mac.uid]
func d(_ alive: Set<String>, cur: String?, hold: APHold? = nil, newly: Set<String> = [], why: APWhy = .devices, call: Bool = false, now: Double = 1000, foreign: Bool = false) -> APDecision {
  APCore.decide(order, alive: alive, current: cur, foreign: foreign, hold: hold, newly: newly, why: why, inCall: call, now: now)
}
check("no pick: the top connected one", d(all, cur: mac.uid) == .set(jbl.uid))
check("already there: nothing", { if case .stay = d(all, cur: jbl.uid) { return true }; return false }())
let pick = APHold(uid: mac.uid, at: 1000)
check("a pick in macOS: never fought in the same minute, even when a higher device connects",
      { if case .stay = d(all, cur: mac.uid, hold: pick, newly: [jbl.uid], now: 1059) { return true }; return false }())
check("after the minute: a device that just connected above the pick takes over", d(all, cur: mac.uid, hold: pick, newly: [pods.uid], now: 1061) == .set(pods.uid))
check("after the minute: the highest of the new ones above the pick", d(all, cur: mac.uid, hold: pick, newly: [hdmi.uid, pods.uid], now: 1061) == .set(pods.uid))
let midPick = APHold(uid: pods.uid, at: 1000)
check("after the minute: a device that connected BELOW the pick changes nothing",
      { if case .stay = d(all, cur: pods.uid, hold: midPick, newly: [hdmi.uid], now: 2000) { return true }; return false }())
check("after the minute: devices already there when the person picked change nothing",
      { if case .stay = d(all, cur: mac.uid, hold: pick, newly: [], now: 5000) { return true }; return false }())
check("the picked device went away: the order rules again", d([jbl.uid, hdmi.uid], cur: hdmi.uid, hold: pick, now: 1010) == .set(jbl.uid))
check("a new order from the person wins over a pick, at once", d(all, cur: mac.uid, hold: pick, why: .order, now: 1001) == .set(jbl.uid))
check("in a call: wait", d(all, cur: mac.uid, call: true) == .wait)
check("in a call, the person's new order still applies", d(all, cur: mac.uid, why: .order, call: true) == .set(jbl.uid))
check("a virtual or combined default is left alone", { if case .stay = d(all, cur: "blackhole", foreign: true) { return true }; return false }())
check("nothing in the list connected: nothing", { if case .stay = d([], cur: nil) { return true }; return false }())
check("a call is a microphone in use", APCore.isCall(micRunning: true, runningSince: 0, now: 3600))
check("a microphone open more than 3 hours is not a call", !APCore.isCall(micRunning: true, runningSince: 0, now: 3 * 3600 + 1))
check("no microphone, no call", !APCore.isCall(micRunning: false, runningSince: nil, now: 1))

// ---------- the engine on a fake Mac ----------
let dir = NSTemporaryDirectory() + "ap-test-\(UUID().uuidString)"
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(atPath: dir) }
// Headphones mode had AirPods first (auto on): the start of the new order.
try? #"{"auto":true,"hpOut":[{"uid":"A0-B1:output","name":"AirPods Max"}],"spkOut":[{"uid":"BuiltInSpeakerDevice","name":"MacBook Pro Speakers"}]}"#.data(using: .utf8)!
  .write(to: URL(fileURLWithPath: dir + "/hpmode.json"))
let ap = AudioPriority.shared
var skew = 0.0
ap.now = { Date().timeIntervalSince1970 + skew }
ap.debounce = 0.05; ap.settle = 0.1; ap.verifyDelays = [0.05, 0.1, 0.15]; ap.wakeDelay = 0.05
var featureOn = true
ap.isOn = { featureOn }
let f = FakeAP()
f.outs = [mac, pods]; f.ins = [macMic, podsMic]; f.out = mac.uid; f.mic = podsMic.uid
ap.start(testDir: dir, backend: f)
wait(0.5); ap.syncForTest()
check("launch: moved over Headphones mode's order", uids(ap.listsNow.speakers).prefix(2) == [pods.uid, mac.uid])
check("launch: the top connected speaker and microphone become the defaults", f.out == pods.uid && f.mic == macMic.uid)
check("launch: the order is saved", FileManager.default.fileExists(atPath: dir + "/audiopriority.json"))

// The JBL connects: placed above the Mac, below the AirPods (both Bluetooth: the earlier one stays first).
f.outs = [mac, pods, jbl]; f.fire(); wait(0.5); ap.syncForTest()
check("a connect: placed by kind, the order decides (AirPods stay)", uids(ap.listsNow.speakers) == [pods.uid, jbl.uid, mac.uid] && f.out == pods.uid)
// The person drags the JBL to the top: it applies at once.
ap.handle(["op": "order", "side": "speakers", "order": [jbl.uid, pods.uid, mac.uid]]); wait(0.5); ap.syncForTest()
check("a new order applies at once", f.out == jbl.uid)
// The person picks the Mac speakers in the sound menu (nothing else happens): PS leaves it.
skew += 5
f.out = mac.uid; f.fire(.defaults); wait(0.5); ap.syncForTest()
check("a pick in macOS is never fought", f.out == mac.uid && ap.holdNow(.speakers)?.uid == mac.uid)
// In the same minute a higher device reconnects: still left alone.
f.outs = [mac, pods]; f.fire(); wait(0.4); f.outs = [mac, pods, jbl]; f.fire(); wait(0.5); ap.syncForTest()
check("the same minute: a higher device connecting changes nothing", f.out == mac.uid)
// A minute later the JBL reconnects: it is above the pick and just connected, so it takes over.
skew += 61
f.outs = [mac, pods]; f.fire(); wait(0.4); ap.syncForTest()
check("after the minute, a device going away below nothing changes nothing", f.out == mac.uid)
f.outs = [mac, pods, jbl]; f.fire(); wait(0.5); ap.syncForTest()
check("after the minute, a device connecting above the pick takes over", f.out == jbl.uid && ap.holdNow(.speakers) == nil)
// The JBL goes away: macOS falls back to the Mac speakers; PS picks the next in the order (AirPods).
f.outs = [mac, pods]; f.out = mac.uid; f.fire(); wait(0.5); ap.syncForTest()
check("a disconnect: the next connected one in the order", f.out == pods.uid)

// AirPods reconnect and macOS moves BOTH defaults to them a moment later (two separate changes).
f.outs = [mac]; f.ins = [macMic]; f.out = mac.uid; f.fire(); wait(0.4); ap.syncForTest()
skew += 5
f.outs = [mac, pods]; f.ins = [macMic, podsMic]; f.fire(); wait(0.3)
f.out = pods.uid; f.mic = podsMic.uid; f.fire(.defaults); wait(0.6); ap.syncForTest()
check("macOS moving onto new AirPods is not a pick: the speaker stays AirPods, the microphone goes back to the Mac's",
      f.out == pods.uid && f.mic == macMic.uid && ap.holdNow(.mics) == nil)

// A call: the microphone is in use; a higher microphone connects; PS waits until the call ends.
skew += 70
f.micOn = true; f.fire(.mic); wait(0.3)
f.ins = [macMic, podsMic, usbMic]; f.fire(); wait(0.5); ap.syncForTest()
check("in a call: the microphone is not switched", f.mic == macMic.uid && ap.waitingNow.contains(.mics))
f.micOn = false; f.fire(.mic); wait(0.5); ap.syncForTest()
check("the call ends: switched then", f.mic == usbMic.uid && ap.waitingNow.isEmpty)
// The person asks for AirPods' microphone first, during a call: asked, so it applies.
f.micOn = true; f.fire(.mic); wait(0.3)
ap.handle(["op": "order", "side": "mics", "order": [podsMic.uid, usbMic.uid, macMic.uid]]); wait(0.5); ap.syncForTest()
check("in a call, a new order from the person applies at once", f.mic == podsMic.uid)
f.micOn = false; f.fire(.mic); wait(0.3)

// A click on a connected device: used now, and the order leaves it be.
ap.handle(["op": "use", "side": "speakers", "uid": mac.uid]); wait(0.4); ap.syncForTest()
check("a click uses a device now and holds it", f.out == mac.uid && ap.holdNow(.speakers)?.uid == mac.uid)
f.fire(); wait(0.4); ap.syncForTest()
check("the held click is not taken back", f.out == mac.uid)
ap.handle(["op": "use", "side": "speakers", "uid": jbl.uid]); wait(0.3); ap.syncForTest()
check("a click on a device that is not connected does nothing", f.out == mac.uid)

// Forget.
ap.handle(["op": "forget", "side": "speakers", "uid": jbl.uid]); ap.syncForTest(); wait(0.05); ap.syncForTest()
check("forget a remembered device", !ap.listsNow.speakers.contains { $0.uid == jbl.uid })
ap.handle(["op": "forget", "side": "speakers", "uid": mac.uid]); ap.syncForTest(); wait(0.05); ap.syncForTest()
check("a connected device cannot be forgotten", ap.listsNow.speakers.contains { $0.uid == mac.uid })
ap.handle(["op": "order", "side": "bogus", "order": [1, nil as Any? as Any]]); ap.handle(["op": "use", "side": "mics", "uid": String(repeating: "x", count: 999)]); ap.syncForTest()
check("bad messages are ignored", f.mic == podsMic.uid)

// Wake: the order decides again.
ap.wakeForTest(); wait(0.4); ap.syncForTest()
check("after wake, the top connected one again", f.out == pods.uid)

// A virtual device the person chose (BlackHole) is left alone.
skew += 5
f.virtual = ["blackhole"]; f.out = "blackhole"; f.fire(.defaults); wait(0.4); skew += 70; f.outs = [mac, pods, hdmi]; f.fire(); wait(0.5); ap.syncForTest()
check("a virtual default is never moved", f.out == "blackhole")
f.virtual = []; f.out = mac.uid; f.outs = [mac, pods]; f.fire(); wait(0.5); ap.syncForTest()

// macOS says yes but keeps the old one: tried again.
f.outs = [mac]; f.out = mac.uid; f.fire(); wait(0.4); ap.syncForTest()
f.ignoreSets = 1; f.clearSets(); f.outs = [mac, pods]; f.fire(); wait(0.7); ap.syncForTest()
check("macOS keeps the old one: tried again until it takes", f.out == pods.uid && f.sets.filter { $0.0 == .speakers }.count >= 2)

// Signal is never listed.
f.outs = [mac, pods, signal]; f.fire(); wait(0.4); ap.syncForTest()
check("Signal is never in the lists", !ap.listsNow.speakers.contains { $0.uid == signal.uid })

// The switch: off, nothing is switched; on again, the order applies.
featureOn = false; ap.featuresChangedForTest()
f.out = mac.uid; f.fire(.defaults); skew += 70; f.fire(); wait(0.5); ap.syncForTest()
check("switched off: PS never changes the defaults", f.out == mac.uid)
check("switched off: claims nothing for the developer's AirPods routing", HeadphonesMode.shared.claims(uid: pods.uid, name: "AirPods").out == false)
featureOn = true; ap.featuresChangedForTest(); wait(0.6); ap.syncForTest()
check("switched on again: the order applies", f.out == pods.uid && HeadphonesMode.shared.claims(uid: pods.uid, name: "AirPods") == (true, true))

// Saved forever: a restart reads the same order.
let saved = ap.listsNow
ap.resetForTest()
let f2 = FakeAP(); f2.outs = [mac]; f2.ins = [macMic]; f2.out = mac.uid; f2.mic = macMic.uid
ap.start(testDir: dir, backend: f2); wait(0.4); ap.syncForTest()
check("a restart keeps the order and the remembered devices", uids(ap.listsNow.speakers) == uids(saved.speakers) && uids(ap.listsNow.mics) == uids(saved.mics))

print("audiopriority: \(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
