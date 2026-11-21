package com.cincee.ps.gos

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The gym reminder's timing on the phone (GymClock.kt): FICTIONAL days, gym at 08:00 Dubai (04:00 UTC). */
class GymClockTest {
    private val day = "2026-11-03"
    private val gym = java.time.Instant.parse("2026-11-03T04:00:00Z").toEpochMilli()
    private val gym2 = gym + 86_400_000L
    private fun hm(h: Int, m: Int, s: Int = 0) = gym + ((h - 8) * 3600 + m * 60 + s) * 1000L
    private fun plan(acked: List<String> = emptyList(), on: Boolean = true) = GymClock.from(JSONObject()
        .put("on", on).put("time", "08:00")
        .put("items", JSONArray().put(JSONObject().put("day", day).put("at", gym)).put(JSONObject().put("day", "2026-11-04").put("at", gym2)))
        .put("acked", JSONArray(acked)).put("before", JSONArray(listOf(120, 60, 30, 10))).put("ring", 16).put("grace", 120_000))

    @Test fun theDaysStepsAndTheRingAtMinus16() {
        val s = GymClock.steps(plan()).filter { it.day == day }
        assertEquals(listOf(120, 60, 30, 16, 10), s.map { it.mins })
        assertEquals(hm(7, 44), s.first { it.ring }.due)
        assertEquals(listOf(false, false, false, true, false), s.map { it.ring })
    }

    @Test fun eachStepFiresOnTimeOnce() {
        val p = plan()
        assertEquals(listOf("$day:120"), GymClock.dueNow(p, hm(6, 0, 5), emptySet()).map { it.id })
        assertEquals(emptyList<String>(), GymClock.dueNow(p, hm(6, 0, 5), setOf("$day:120")).map { it.id })
        val ring = GymClock.dueNow(p, hm(7, 44, 1), setOf("$day:120", "$day:60", "$day:30"))
        assertEquals(listOf("$day:16"), ring.map { it.id })
        assertTrue(ring[0].ring)
    }

    @Test fun theNextAlarmIsTheNextStep() {
        val p = plan()
        assertEquals(hm(6, 0), GymClock.next(p, hm(5, 0), emptySet())!!.due)
        assertEquals(hm(7, 44), GymClock.next(p, hm(7, 31), setOf("$day:120", "$day:60", "$day:30"))!!.due)
        assertEquals(hm(7, 50), GymClock.next(p, hm(7, 45), setOf("$day:120", "$day:60", "$day:30", "$day:16"))!!.due)
    }

    @Test fun aPhoneOffThroughTwoStepsFiresNothingStale() {
        // Off from 05:50 to 07:10: the 06:00 and 07:00 reminders are gone, nothing piles up.
        assertTrue(GymClock.dueNow(plan(), hm(7, 10), emptySet()).isEmpty())
        assertEquals(hm(7, 30), GymClock.next(plan(), hm(7, 10), emptySet())!!.due)
    }

    @Test fun theRingMayStartUpToFiveMinutesLateButNotLater() {
        val f = setOf("$day:120", "$day:60", "$day:30")
        assertEquals(listOf("$day:16"), GymClock.dueNow(plan(), hm(7, 48), f).map { it.id })
        assertTrue(GymClock.dueNow(plan(), hm(7, 49, 30), f).isEmpty())
    }

    @Test fun aNotificationTwoMinutesLateIsSkipped() {
        assertEquals(1, GymClock.dueNow(plan(), hm(7, 1, 30), emptySet()).size)
        assertTrue(GymClock.dueNow(plan(), hm(7, 2, 30), emptySet()).isEmpty())
    }

    @Test fun acknowledgedAnywhereTheDayIsQuiet() {
        assertTrue(GymClock.steps(plan(acked = listOf(day))).none { it.day == day })
        assertTrue(GymClock.steps(plan(), localAcked = setOf(day)).none { it.day == day })
        assertEquals("2026-11-04", GymClock.next(plan(acked = listOf(day)), hm(7, 0), emptySet())!!.day)
    }

    // The developer, 2 Nov 2026: 1) the 07:44 ring stops by itself after 10 minutes and leaves a missed notification,
    // Acknowledge stops it at any time; 2) it rings through PS Do Not Disturb; 3) Later: 5 minutes, then again.
    private val r0 = GymRing(day, gym, hm(7, 44))

    @Test fun theRingStopsByItselfAfterTenMinutesAsMissed() {
        assertEquals(RingNow.RINGING, GymClock.ringNow(r0, plan(), hm(7, 44, 1), emptySet()))
        assertEquals(RingNow.RINGING, GymClock.ringNow(r0, plan(), hm(7, 53, 59), emptySet()))
        assertEquals(RingNow.MISSED, GymClock.ringNow(r0, plan(), hm(7, 54), emptySet()))
        assertEquals(hm(7, 54), GymClock.ringWake(r0))   // the alarm that ends it, even if the service died
        assertEquals(RingNow.NONE, GymClock.ringNow(null, plan(), hm(7, 54), emptySet()))
    }

    @Test fun acknowledgeStopsItAtAnyTime() {
        for (t in listOf(hm(7, 44, 1), hm(7, 50), hm(7, 53, 59))) {
            assertEquals(RingNow.DONE, GymClock.ringNow(r0, plan(acked = listOf(day)), t, emptySet()))   // the Mac's Acknowledge
            assertEquals(RingNow.DONE, GymClock.ringNow(r0, plan(), t, setOf(day)))                      // this phone's
        }
        val snoozed = GymClock.later(r0, hm(7, 46))
        assertEquals(RingNow.DONE, GymClock.ringNow(snoozed, plan(), hm(7, 48), setOf(day)))             // while Later waits
        assertEquals(RingNow.DONE, GymClock.ringNow(r0, plan(on = false), hm(7, 50), emptySet()))        // switched off
    }

    @Test fun laterIsQuietFiveMinutesThenRingsAgain() {
        val s = GymClock.later(r0, hm(7, 46))
        assertEquals(hm(7, 51), s.snoozeAt)
        assertEquals(RingNow.SNOOZED, GymClock.ringNow(s, plan(), hm(7, 50, 59), emptySet()))
        assertEquals(hm(7, 51), GymClock.ringWake(s))     // armed as an alarm clock
        assertEquals(RingNow.AGAIN, GymClock.ringNow(s, plan(), hm(7, 51), emptySet()))
        val again = GymClock.again(s, hm(7, 51))
        assertEquals(RingNow.RINGING, GymClock.ringNow(again, plan(), hm(7, 51, 1), emptySet()))
        assertEquals(0L, again.snoozeAt)
    }

    @Test fun eachSnoozedRingAlsoStopsAfterTenMinutes() {
        // Later at 07:46, rings again 07:51, ignored: stops at 08:01 as missed. Later twice works the same.
        val again = GymClock.again(GymClock.later(r0, hm(7, 46)), hm(7, 51))
        assertEquals(RingNow.RINGING, GymClock.ringNow(again, plan(), hm(8, 0, 59), emptySet()))
        assertEquals(RingNow.MISSED, GymClock.ringNow(again, plan(), hm(8, 1), emptySet()))
        assertEquals(hm(8, 1), GymClock.ringWake(again))
        val third = GymClock.again(GymClock.later(again, hm(7, 55)), hm(8, 0))
        assertEquals(RingNow.RINGING, GymClock.ringNow(third, plan(), hm(8, 9), emptySet()))
        assertEquals(RingNow.MISSED, GymClock.ringNow(third, plan(), hm(8, 10), emptySet()))
    }

    @Test fun laterSleptThroughIsMissedNotRungLate() {
        val s = GymClock.later(r0, hm(7, 46))   // due 07:51; the phone was off until 08:30
        assertEquals(RingNow.AGAIN, GymClock.ringNow(s, plan(), hm(7, 55), emptySet()))
        assertEquals(RingNow.MISSED, GymClock.ringNow(s, plan(), hm(7, 56), emptySet()))
    }

    @Test fun theRingRingsThroughPsDoNotDisturb() {
        // PS DND lives in Notifier.kt (Dnd). The ring and its notices never ask it: it is an alarm. The code
        // (comments out) of Gym.kt must not mention Dnd, and the ring plays on the alarm stream.
        val src = java.io.File("src/main/java/com/cincee/ps/gos/Gym.kt").readText()
        val code = src.replace(Regex("""/\*[\s\S]*?\*/"""), "").replace(Regex("""//.*"""), "")
        assertFalse(code.contains("Dnd"))
        assertTrue(code.contains("AudioAttributes.USAGE_ALARM"))
        assertTrue(code.contains("Notification.CATEGORY_ALARM"))
    }

    @Test fun offMeansNothing() {
        assertTrue(GymClock.steps(plan(on = false)).isEmpty())
        assertNull(GymClock.next(plan(on = false), hm(5, 0), emptySet()))
    }

    @Test fun brokenPlansAreSafe() {
        assertNull(GymClock.parse("not json"))
        assertNull(GymClock.parse(null))
        val p = GymClock.from(JSONObject().put("on", true).put("time", "99:99").put("items", JSONArray().put(JSONObject().put("day", "x").put("at", 5))))
        assertEquals("08:00", p.time)
        assertTrue(p.items.isEmpty())
        assertEquals(listOf(120, 60, 30, 10), p.before)
    }

    @Test fun roundTrip() {
        val p = plan(acked = listOf("2026-11-02"))
        assertEquals(p, GymClock.from(GymClock.toJson(p)))
    }

    @Test fun firedIdsArePruned() {
        assertEquals(setOf("2026-11-02:10", "$day:120"), GymClock.prune(setOf("2026-11-01:60", "2026-11-02:10", "$day:120"), day))
    }

    @Test fun titles() {
        assertEquals("Gym in 2 h", GymClock.title(gym, hm(6, 0)))
        assertEquals("Gym in 16 min", GymClock.title(gym, hm(7, 44)))
        assertEquals("Gym in 1 h 20 min", GymClock.title(gym, hm(6, 40)))
        assertEquals("Gym time", GymClock.title(gym, hm(8, 1)))
    }

    // ---------- V1.57: nag mode, the ring time, a gym across midnight, alarms ----------
    // The developer's: nag from 10:00 every 15 min, gym 23:00 to 01:00, ring at 22:55, all on 3 Nov (Dubai, UTC+4).
    private fun t(hhmm: String, d: String = day) = java.time.OffsetDateTime.parse("${d}T${hhmm}:00+04:00").toInstant().toEpochMilli()
    private fun night(acked: List<String> = emptyList(), alarms: JSONArray = JSONArray()) = GymClock.from(JSONObject()
        .put("on", true).put("time", "23:00")
        .put("items", JSONArray().put(JSONObject().put("day", day).put("at", t("23:00")).put("end", t("01:00", "2026-11-04"))
            .put("ring", t("22:55")).put("from", t("10:00")).put("every", 15 * 60_000L)))
        .put("acked", JSONArray(acked)).put("before", JSONArray(listOf(120, 60, 30, 10))).put("ring", 16).put("grace", 120_000)
        .put("alarms", alarms))
    private fun alarm(id: String, at: Long, d: String = day) = JSONObject().put("id", id).put("day", d).put("at", at)
        .put("title", "Wake").put("text", "Time to go").put("yes", "I'm up").put("later", "Later").put("bg", "#0f1b2d").put("accent", "#3b82f6").put("ink", "#ffffff")

    @Test fun nagStepsEveryFifteenMinutesUntilTheGymEnds() {
        val s = GymClock.steps(night()).filter { !it.ring }
        assertEquals(t("10:00"), s.first().due)
        assertEquals(t("10:15"), s[1].due)
        assertEquals(t("00:45", "2026-11-04"), s.last().due)
        assertEquals(60, s.size)
        assertTrue(s.all { it.nag && it.day == day && it.id.startsWith("$day:n") })
    }

    @Test fun theRingAtItsOwnTimeNotMinus16() {
        val ring = GymClock.steps(night()).single { it.ring }
        assertEquals(t("22:55"), ring.due)
        assertEquals("$day:r", ring.id)
        assertEquals(listOf("$day:r"), GymClock.dueNow(night(), t("22:55") + 1000, emptySet()).filter { it.ring }.map { it.id })
    }

    @Test fun aPhoneOffThroughNagStepsShowsOneNotAPile() {
        val due = GymClock.dueNow(night(), t("13:07"), setOf("$day:n0"))
        assertEquals(listOf("$day:n12"), due.map { it.id })     // the 13:00 one only
        assertTrue(GymClock.dueNow(night(), t("13:08"), setOf("$day:n0", "$day:n12")).isEmpty())
        assertEquals(t("13:15"), GymClock.next(night(), t("13:08"), setOf("$day:n12"))!!.due)
    }

    @Test fun yesStopsEveryNagAndTheRing() {
        assertTrue(GymClock.steps(night(acked = listOf(day))).isEmpty())
        assertTrue(GymClock.steps(night(), localAcked = setOf(day)).isEmpty())
        val r = GymRing(day, t("23:00"), t("22:55"))
        assertEquals(RingNow.RINGING, GymClock.ringNow(r, night(), t("22:57"), emptySet()))
        assertEquals(RingNow.DONE, GymClock.ringNow(r, night(acked = listOf(day)), t("22:57"), emptySet()))
    }

    @Test fun acrossMidnightTheDayIsTheDayTheNaggingStarted() {
        val d = GymClock.dueNow(night(), t("00:30", "2026-11-04") + 1000, emptySet())
        assertEquals(day, d.single().day)
        assertTrue(GymClock.dueNow(night(), t("01:01", "2026-11-04"), emptySet()).isEmpty())
    }

    @Test fun anOldPlanStillRingsAtMinus16() {
        // A page older than V1.57 (no end, ring, from, every): the old steps and ids.
        assertEquals(listOf(120, 60, 30, 16, 10), GymClock.steps(plan()).filter { it.day == day }.map { it.mins })
        assertEquals("$day:16", GymClock.steps(plan()).first { it.ring && it.day == day }.id)
    }

    @Test fun theNewPlanRoundTrips() {
        val p = night(alarms = JSONArray().put(alarm("al1", t("07:44"))))
        assertEquals(p, GymClock.from(GymClock.toJson(p)))
    }

    // ---------- PS 1.73: the Priority 1 alarm (web core/duealerts.ts): one button, the task's name and time left ----------
    @Test fun thePriorityOneAlarmHasOneButtonAndRingsLikeTheOthers() {
        val words = "1 hour left: " + "Send the invoice to the client before the call ".repeat(3).trim()
        val p1 = JSONObject().put("id", "pabcdefghijk").put("day", day).put("at", t("19:30")).put("title", "Priority 1").put("text", words)
            .put("yes", "I acknowledge").put("later", "Later").put("bg", "#2a0d0d").put("accent", "#ef4444").put("ink", "#ffffff").put("one", true).put("word", "yes")
        val p = night(alarms = JSONArray().put(p1).put(alarm("al1", t("07:44"))))
        val a = p.alarms.single { it.id == "pabcdefghijk" }
        assertTrue(a.one)
        assertEquals("I acknowledge", a.yes)
        // The developer: a tap alone never stops it, only "yes" typed (any case); your own alarms stay one tap
        assertEquals("yes", a.word)
        assertFalse(GymClock.confirms(a, "")); assertFalse(GymClock.confirms(a, null)); assertFalse(GymClock.confirms(a, "I acknowledge"))
        assertTrue(GymClock.confirms(a, "yes")); assertTrue(GymClock.confirms(a, " YES "))
        assertTrue(GymClock.confirms(p.alarms.single { it.id == "al1" }, ""))
        assertEquals(words.take(160), a.text)                                  // longer words than an alarm of your own
        assertFalse(p.alarms.single { it.id == "al1" }.one)                    // your own alarms keep Later
        assertEquals(p, GymClock.from(GymClock.toJson(p)))                     // one survives the saved plan
        assertEquals(listOf("pabcdefghijk"), GymClock.alarmsDue(p, t("19:30") + 1000, emptySet()).map { it.id })
        // I acknowledge on the Mac: the page's next plan no longer has it, so a ring going here stops
        val r = GymRing(day, t("19:30"), t("19:30"), 0, "a:pabcdefghijk")
        assertEquals(RingNow.RINGING, GymClock.ringNow(r, p, t("19:31"), emptySet()))
        assertEquals(RingNow.DONE, GymClock.ringNow(r, night(alarms = JSONArray().put(alarm("al1", t("07:44")))), t("19:31"), emptySet()))
    }

    @Test fun alarmsRingOnTimeOnceAndNotLate() {
        val p = night(alarms = JSONArray().put(alarm("al1", t("07:44"))).put(alarm("al2", t("13:00"))))
        assertEquals(2, p.alarms.size)
        assertEquals("Wake", p.alarms[0].title)
        assertEquals(listOf("al1"), GymClock.alarmsDue(p, t("07:44") + 1000, emptySet()).map { it.id })
        assertTrue(GymClock.alarmsDue(p, t("07:44") + 1000, setOf("a:al1:$day")).isEmpty())
        assertTrue(GymClock.alarmsDue(p, t("07:50"), emptySet()).isEmpty())                       // over 5 minutes late
        assertTrue(GymClock.alarmsDue(p, t("07:44") + 1000, emptySet(), setOf("al1:$day")).isEmpty())   // acknowledged here
        assertEquals("al2", GymClock.nextAlarm(p, t("08:00"), setOf("a:al1:$day"))!!.id)
        assertEquals("al1", GymClock.nextAlarm(p, t("07:00"), emptySet())!!.id)
    }

    @Test fun anAlarmRingLastsTenMinutesLaterFiveAndAcknowledgeEndsIt() {
        val p = night(alarms = JSONArray().put(alarm("al1", t("07:44"))))
        val r = GymRing(day, t("07:44"), t("07:44"), 0, "a:al1")
        assertEquals("al1", r.alarmId)
        assertEquals(RingNow.RINGING, GymClock.ringNow(r, p, t("07:50"), emptySet()))
        assertEquals(RingNow.MISSED, GymClock.ringNow(r, p, t("07:55"), emptySet()))
        val later = GymClock.later(r, t("07:46"))
        assertEquals(RingNow.SNOOZED, GymClock.ringNow(later, p, t("07:50"), emptySet()))
        assertEquals(RingNow.AGAIN, GymClock.ringNow(later, p, t("07:51") + 1000, emptySet()))
        // Acknowledged here, or on the Mac (the page's plan no longer has it), or the alarm removed: done.
        assertEquals(RingNow.DONE, GymClock.ringNow(r, p, t("07:50"), emptySet(), setOf("al1:$day")))
        assertEquals(RingNow.DONE, GymClock.ringNow(r, night(), t("07:50"), emptySet()))
        // A Yes to the gym does not stop an alarm, and an alarm's Acknowledge does not say Yes to the gym.
        assertEquals(RingNow.RINGING, GymClock.ringNow(r, night(acked = listOf(day), alarms = JSONArray().put(alarm("al1", t("07:44")))), t("07:50"), setOf(day)))
    }

    @Test fun badAlarmsAreLeftOutAndWordsAreTrimmed() {
        val bad = JSONArray().put(JSONObject().put("id", "BAD ID").put("day", day).put("at", 5))
            .put(JSONObject().put("id", "ok1").put("day", "nope").put("at", 5))
            .put(JSONObject().put("id", "ok2").put("day", day).put("at", t("09:00")).put("title", "x".repeat(99)).put("bg", "red"))
        val p = night(alarms = bad)
        assertEquals(listOf("ok2"), p.alarms.map { it.id })
        assertEquals(30, p.alarms[0].title.length)
        assertEquals("#2a1a08", p.alarms[0].bg)
        assertEquals("Acknowledge", p.alarms[0].yes)
    }

    @Test fun alarmRingIdsArePrunedByTheirDay() {
        assertEquals(setOf("a:al1:2026-11-02", "$day:n3"), GymClock.prune(setOf("a:al1:2026-11-01", "a:al1:2026-11-02", "$day:n3"), day))
    }

    // ---------- 1.60: the phone only follows the saved gym settings ----------
    /** The saved gym moved from 08:00 to 23:00 (Dubai: 19:00 UTC). The old morning plan is replaced by this one. */
    private val nightAt = java.time.Instant.parse("2026-11-03T19:00:00Z").toEpochMilli()
    private fun nightPlan() = GymClock.from(JSONObject().put("on", true).put("time", "23:00")
        .put("items", JSONArray().put(JSONObject().put("day", day).put("at", nightAt)))
        .put("acked", JSONArray()).put("before", JSONArray(listOf(120, 60, 30, 10))).put("ring", 16).put("grace", 120_000))

    @Test fun aMorningRingFromAnOlderPlanEndsWhenTheGymIsAtNight() {
        val morning = GymRing(day, gym, hm(7, 44, 1))
        assertEquals(RingNow.RINGING, GymClock.ringNow(morning, plan(), hm(7, 45), emptySet()))
        assertEquals(RingNow.DONE, GymClock.ringNow(morning, nightPlan(), hm(7, 45), emptySet()))   // no morning ring for a night gym
    }

    @Test fun theNightGymHasNoMorningStepsAtAll() {
        val steps = GymClock.steps(nightPlan())
        assertTrue(steps.none { it.due < nightAt - 130 * 60_000L })               // the earliest is the 2 h notice at 21:00
        assertEquals(nightAt - 120 * 60_000L, steps.first().due)
        assertTrue(GymClock.dueNow(nightPlan(), hm(7, 44, 1), emptySet()).isEmpty())   // 07:44 Dubai: nothing is due
        assertTrue(GymClock.next(nightPlan(), hm(5, 0), emptySet())!!.due > hm(20, 0))
    }

    @Test fun planHasMatchesTheDayAndTheTimeNotJustTheDay() {
        assertTrue(GymClock.planHas(plan(), day, gym))
        assertFalse(GymClock.planHas(plan(), day, nightAt))        // same day, another time: the old reminder is stale
        assertFalse(GymClock.planHas(null, day, gym))
        assertFalse(GymClock.planHas(plan(on = false).copy(items = emptyList()), day, gym))
    }

    @Test fun aPlanSwitchedOffRingsNothingAndAnEmptyPlanHasNoNextAlarm() {
        val off = plan(on = false)
        assertTrue(GymClock.steps(off).isEmpty())
        assertNull(GymClock.next(off, hm(5, 0), emptySet()))
        assertEquals(RingNow.DONE, GymClock.ringNow(GymRing(day, gym, hm(7, 44, 1)), off, hm(7, 45), emptySet()))
    }

    @Test fun aGymMovedLaterTheSameDayRingsAgainAfterTheFirstRingFired() {
        val fired = setOf("$day:16", "$day:120", "a:abc:$day", "2026-11-04:16")
        val moved = GymClock.forgetMoved(plan(), nightPlan(), fired)
        assertEquals(setOf("a:abc:$day", "2026-11-04:16"), moved)             // that day's gym steps are forgotten, alarms and other days kept
        assertEquals(fired, GymClock.forgetMoved(plan(), plan(), fired))       // same time: nothing forgotten
        assertEquals(fired, GymClock.forgetMoved(null, nightPlan(), fired))    // no older plan: nothing to compare
    }
    /** PS 1.72: a gym reminder never saved now reaches the phone as an empty, switched off plan (web core/gym.ts).
     *  It replaces the old 08:00 one: nothing rings at 07:44 any more, and a 07:44 ring already going stops. */
    @Test fun aSwitchedOffPlanStopsTheMorningRing() {
        val off = GymClock.from(JSONObject().put("on", false).put("time", "08:00").put("items", JSONArray()))
        assertTrue(GymClock.steps(off).isEmpty())
        assertTrue(GymClock.dueNow(off, hm(7, 44), emptySet()).isEmpty())
        assertNull(GymClock.next(off, hm(6, 0), emptySet()))
        val r = GymRing(day, gym, hm(7, 44))
        assertEquals(RingNow.RINGING, GymClock.ringNow(r, plan(), hm(7, 45), emptySet()))
        assertEquals(RingNow.DONE, GymClock.ringNow(r, off, hm(7, 45), emptySet()))
    }
}
