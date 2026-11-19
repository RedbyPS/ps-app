package com.cincee.ps.gos

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The day countdown's plan on the phone (DayPlan.kt, PS 1.70). Fictional times only. */
class DayPlanTest {
    private val end = java.time.Instant.parse("2026-11-19T08:00:00Z").toEpochMilli()
    private val key = "2026-11-19T08:00:00.000Z"
    private val remKey = "2026-11-19T05:00:00.000Z"
    private fun plan() = JSONObject().put("on", true)
        .put("ask", JSONObject().put("at", end).put("key", key))
        .put("rem", JSONObject().put("at", end - 3 * 3_600_000L).put("end", end).put("key", remKey))
        .put("words", JSONObject().put("ask", "End day now?").put("yes", "Yes").put("snooze", "Give me 15 more mins").put("ack", "Acknowledged"))

    @Test fun readsTheAskAndTheReminder() {
        val p = DayPlan.from(plan())
        assertTrue(p.on)
        assertEquals(DayPlan.Ask(end, key), p.ask)
        assertEquals(DayPlan.Rem(end - 3 * 3_600_000L, end, remKey), p.rem)
        assertEquals("Give me 15 more mins", p.words.snooze)
    }
    @Test fun offOrBrokenIsNothing() {
        assertFalse(DayPlan.from(JSONObject().put("on", false)).on)
        assertFalse(DayPlan.parse("not json").on)
        assertFalse(DayPlan.parse(null).on)
        assertNull(DayPlan.from(JSONObject().put("on", true).put("ask", JSONObject().put("at", 5).put("key", key))).ask)
        assertNull(DayPlan.from(JSONObject().put("on", true).put("ask", JSONObject().put("at", end).put("key", "javascript:1"))).ask)
        assertNull(DayPlan.from(JSONObject().put("on", true).put("rem", JSONObject().put("at", end).put("end", end - 1).put("key", remKey))).rem)
    }
    @Test fun missingWordsTakeTheDefaults() {
        val p = DayPlan.from(JSONObject().put("on", true))
        assertEquals("End day now?", p.words.ask); assertEquals("Yes", p.words.yes); assertEquals("Acknowledged", p.words.ack)
    }
    @Test fun answersAreKept() {
        val p = DayPlan.from(plan().put("yes", key).put("remDone", remKey))
        assertEquals(key, p.yes); assertEquals(remKey, p.remDone)
        assertEquals(p, DayPlan.parse(DayPlan.toJson(p).toString()))
    }
    @Test fun theReminderWords() {
        assertEquals("You have 4h 12m left", DayPlan.remindTitle(4 * 3_600_000L + 12 * 60_000L))
        assertEquals("3h", DayPlan.leftWords(3 * 3_600_000L))
        assertEquals("35m", DayPlan.leftWords(35 * 60_000L))
        assertEquals("45s", DayPlan.leftWords(45_000L))
    }
}
