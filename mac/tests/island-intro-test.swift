import Foundation
// Run: bash tests/island-intro-test.sh. The Mac's part of the feature intros (Sources/IslandIntroCore.swift, IslandMotionCore.swift, IslandQueueCore.swift).
// The web half (the clock, Later, a day apart, only before linking) is web/tests/featureintro.test.ts.
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
let T0 = Date(timeIntervalSince1970: 1_763_024_400)
func at(_ s: Double) -> Date { T0.addingTimeInterval(s) }

// never in the quiet moments
ok("a calm Mac: it may show", IslandIntroCore.blocked(IslandIntroFacts()) == nil)
ok("Sentry mode blocks", IslandIntroCore.blocked(IslandIntroFacts(sentry: true)) == "sentry")
ok("Sleep mode blocks", IslandIntroCore.blocked(IslandIntroFacts(sleep: true)) == "sleep")
ok("screen sharing blocks", IslandIntroCore.blocked(IslandIntroFacts(sharing: true)) == "sharing")
ok("a full screen app blocks", IslandIntroCore.blocked(IslandIntroFacts(fullScreen: true)) == "fullScreen")
ok("the feature off blocks", IslandIntroCore.blocked(IslandIntroFacts(featureOn: false)) == "off")
ok("two at once still block", IslandIntroCore.blocked(IslandIntroFacts(sentry: true, sleep: true, sharing: true, fullScreen: true)) != nil)
ok("every word is one the page understands", Set(["off", "sentry", "sleep", "sharing", "fullScreen"]) ==
   Set([IslandIntroFacts(featureOn: false), IslandIntroFacts(sentry: true), IslandIntroFacts(sleep: true), IslandIntroFacts(sharing: true), IslandIntroFacts(fullScreen: true)].compactMap { IslandIntroCore.blocked($0) }))

// screen sharing: names only
ok("Zoom's share helper is sharing", IslandIntroCore.isSharing(processNames: ["Finder", "CptHost"]))
ok("macOS Screen Sharing is sharing", IslandIntroCore.isSharing(processNames: ["screensharingd"]) && IslandIntroCore.isSharing(processNames: ["ScreensharingAgent"]))
ok("ordinary programs are not", !IslandIntroCore.isSharing(processNames: ["Finder", "Safari", "zoom.us", "1Password", "Signal"]))
ok("the 16 letter system name still counts", IslandIntroCore.isSharing(processNames: ["ScreensharingAge"]))
ok("no programs is not sharing", !IslandIntroCore.isSharing(processNames: []))

// the island draws it only when it can; otherwise a plain card (never no intro)
ok("hangs from the island when everything is on", IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: false, momentsOn: true, islandOnScreen: true))
ok("Reduce Motion: plain card", !IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: true, momentsOn: true, islandOnScreen: true))
ok("island off: plain card", !IslandIntroCore.hangsFromIsland(islandOff: true, reduceMotion: false, momentsOn: true, islandOnScreen: true))
ok("island moments off: plain card", !IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: false, momentsOn: false, islandOnScreen: true))
ok("island kept in the lower half: plain card in the middle (PS 1.69)", !IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: false, momentsOn: true, islandOnScreen: true, islandLow: true))
ok("island in the upper half or at home: hangs from it as before", IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: false, momentsOn: true, islandOnScreen: true, islandLow: false))
ok("island not on screen: plain card", !IslandIntroCore.hangsFromIsland(islandOff: false, reduceMotion: false, momentsOn: true, islandOnScreen: false))

// the squeeze and the chime
let steps = IslandMotionCore.steps(.featureIntro, reduceMotion: false)
ok("it squeezes in first, then springs out to full, then settles", steps.count == 3 && steps[0].to < 0 && steps[1].to >= 1 && steps[2].to == 0)
ok("Reduce Motion: no springs", IslandMotionCore.steps(.featureIntro, reduceMotion: true).isEmpty)
ok("a soft chime", IslandMotionCore.chimes(.featureIntro, soundOn: true, dndMutesSounds: false))
ok("the Island sounds switch silences it", !IslandMotionCore.chimes(.featureIntro, soundOn: false, dndMutesSounds: false))
ok("Do Not Disturb silences it", !IslandMotionCore.chimes(.featureIntro, soundOn: true, dndMutesSounds: true))
ok("the card comes out after the squeeze and the bounce start", IslandMotionCore.introLead > IslandMotionCore.squeezeFor && IslandMotionCore.introLead < 1)

// never over another card: it goes through the shared queue, at the lowest priority
var q = IslandQueueCore()
ok("a free island: it shows now", q.enqueue(id: "intro:whatsapp", kind: "intro", priority: .low, ttl: IslandIntroCore.queueTTL, now: at(0)) == .showNow)
var busy = IslandQueueCore()
_ = busy.enqueue(id: "remind", kind: "reminders", priority: .high, now: at(0))
ok("a reminder on the island: the intro waits", busy.enqueue(id: "intro:whatsapp", kind: "intro", priority: .low, ttl: IslandIntroCore.queueTTL, now: at(1)) == .wait(position: 1))
_ = busy.enqueue(id: "whatsnew", kind: "whatsnew", priority: .normal, now: at(2))
ok("What's new, Welcome back, a meeting: all go before it", busy.waiting.map { $0.id } == ["whatsnew", "intro:whatsapp"])
_ = busy.enqueue(id: "welcome", kind: "welcome", priority: .normal, now: at(3))
ok("a newer normal card still goes before it", busy.waiting.map { $0.id } == ["whatsnew", "welcome", "intro:whatsapp"])
ok("it never interrupts the card on screen", busy.active?.id == "remind")
var late = IslandQueueCore()
_ = late.enqueue(id: "remind", kind: "reminders", priority: .high, now: at(0))
_ = late.enqueue(id: "intro:whatsapp", kind: "intro", priority: .low, ttl: IslandIntroCore.queueTTL, now: at(1))
let rr = late.step(now: at(IslandIntroCore.queueTTL + 5), activeIsVisible: true)
ok("an intro that waited too long is dropped, never shown stale", rr.dropped.contains { $0.id == "intro:whatsapp" } && !late.isWaiting("intro:whatsapp"))
ok("the hold cap is shorter than a day and longer than the guide", IslandIntroCore.holdCap >= 600 && IslandIntroCore.holdCap <= 7200)

print("\(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
