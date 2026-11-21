package com.cincee.ps.gos

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** V1.59 the phone's Dynamic island: what it shows and when it wakes (IslandShow.kt), the Mac's order. */
class IslandShowTest {
    private val T = 1_800_000_000_000L
    private fun page(pomo: IslandShow.Pomo? = null, stand: IslandShow.Stand? = null, meet: IslandShow.Meet? = null, working: Boolean = false, priv: Boolean = false) =
        IslandShow.Page(true, priv, working, pomo, stand, meet, null)
    private fun look(p: IslandShow.Page, now: Long = T, pops: List<IslandShow.Pop> = emptyList(), seen: Map<String, Long> = emptyMap()) = IslandShow.look(p, pops, now, seen)

    @Test fun idleWithAndWithoutATask() {
        assertEquals(IslandShow.Look.Idle(false), look(page()))
        assertEquals(IslandShow.Look.Idle(true), look(page(working = true)))
        assertEquals(IslandShow.Look.Idle(false), look(IslandShow.OFF))
    }

    @Test fun breakCountsDownThenTicksGreenThenGoesBack() {
        val p = page(pomo = IslandShow.Pomo("b1", "short", T + 299_000, null, false, false, null, 0))
        val b = look(p) as IslandShow.Look.Compact
        assertEquals("Short break", b.left); assertEquals("4:59", b.right); assertEquals(IslandShow.Tone.GREEN, b.tone); assertTrue(b.tick)
        val back = look(p, T + 300_000) as IslandShow.Look.Compact
        assertEquals("Back to work", back.left); assertEquals("b1", back.backId)
        // Shown for 3.2 s from when it first showed, then the idle pill.
        assertTrue(look(p, T + 302_000, seen = mapOf("b1" to T + 300_000)) is IslandShow.Look.Compact)
        assertEquals(IslandShow.Look.Idle(false), look(p, T + 304_000, seen = mapOf("b1" to T + 300_000)))
    }

    @Test fun pausedAndWaitingBreaks() {
        assertEquals("Paused", (look(page(pomo = IslandShow.Pomo("b", "long", T, 252_000, false, false, null, 0))) as IslandShow.Look.Compact).left)
        val w = look(page(pomo = IslandShow.Pomo("b", "long", T, null, true, false, null, 0))) as IslandShow.Look.Compact
        assertEquals("Long break", w.left); assertEquals("Ready", w.right)
    }

    @Test fun standUpLeadThenStandThenBack() {
        val s = IslandShow.Stand(T + 15_000, 120_000)
        val lead = look(page(stand = s)) as IslandShow.Look.Compact
        assertEquals("Stand up in", lead.left); assertEquals("15", lead.right)
        assertEquals("1:50", (look(page(stand = s), T + 25_000) as IslandShow.Look.Compact).right)
        assertEquals("Back to work", (look(page(stand = s), T + 136_000) as IslandShow.Look.Compact).left)
    }

    @Test fun aBreakBeatsAStandUp() {
        val p = page(pomo = IslandShow.Pomo("b", "short", T + 200_000, null, false, false, null, 0), stand = IslandShow.Stand(T + 10_000, 120_000))
        assertEquals("Short break", (look(p, T + 20_000) as IslandShow.Look.Compact).left)
    }

    @Test fun meetingSoonJoinAndLeft() {
        val m = IslandShow.Meet("Design review", T + 12 * 60_000, T + 42 * 60_000, T - 3 * 60_000, "https://meet.google.com/abc")
        val soon = look(page(meet = m)) as IslandShow.Look.Compact
        assertEquals("Design review", soon.left); assertEquals("12m", soon.right); assertEquals("plan", soon.open)
        val join = look(page(meet = m), T + 11 * 60_000) as IslandShow.Look.Compact
        assertEquals("Join", join.right); assertEquals("url:https://meet.google.com/abc", join.open)
        assertEquals("18m left", (look(page(meet = m), T + 24 * 60_000) as IslandShow.Look.Compact).right)
        assertEquals("Meeting", (look(page(meet = m, priv = true)) as IslandShow.Look.Compact).left)
        assertEquals(IslandShow.Look.Idle(false), look(page(meet = m), T + 43 * 60_000))
    }

    @Test fun aPopBeatsEverythingForItsFewSeconds() {
        val pop = IslandShow.Pop("rem:1", IslandShow.Tone.AMBER, "Drink water", "Confirm with Yes", "list", T + 10_000)
        val p = page(pomo = IslandShow.Pomo("b", "short", T + 200_000, null, false, false, null, 0))
        assertEquals("Drink water", (look(p, pops = listOf(pop)) as IslandShow.Look.Big).title)
        assertTrue(look(p, T + 11_000, pops = listOf(pop)) is IslandShow.Look.Compact)
    }

    @Test fun workClockOnlyWhenAsked() {
        assertEquals(IslandShow.Look.Idle(false), look(page(pomo = IslandShow.Pomo("w", "work", T + 60_000, null, false, false, null, 0))))
        assertEquals("1:00", (look(page(pomo = IslandShow.Pomo("w", "work", T + 60_000, null, false, true, null, 0))) as IslandShow.Look.Compact).right)
    }

    @Test fun clockAndMinutes() {
        assertEquals("0:00", IslandShow.clock(0)); assertEquals("0:01", IslandShow.clock(1)); assertEquals("25:00", IslandShow.clock(1_500_000))
        assertEquals("1:00:00", IslandShow.clock(3_600_000)); assertEquals("1m", IslandShow.mins(1)); assertEquals("1h 5m", IslandShow.mins(65 * 60_000))
    }

    @Test fun wakesOnlyAtTheNextChange() {
        val m = IslandShow.Meet("A", T + 20 * 60_000, T + 50 * 60_000, T + 5 * 60_000, null)
        assertEquals(T + 5 * 60_000, IslandShow.wakeAt(page(meet = m), emptyList(), T, 0))
        assertNull(IslandShow.wakeAt(page(), emptyList(), T, 0))
        assertEquals(T + 30 * 60_000, IslandShow.wakeAt(page(), emptyList(), T, T + 30 * 60_000))
    }

    @Test fun readsThePagesMessage() {
        val st = JSONObject("""{"mode":"on","private":false,"task":{"id":"t","title":"Write","dim":false},
            "pomo":{"id":"p1","phase":"short","endsAt":${T + 60_000},"left":null,"wait":false,"clock":false,"sound":true,"back":null},
            "stand":{"at":${T + 600_000},"len":120000,"sound":true},
            "meet":{"id":"m","title":"Call‮ with Jo","start":${T + 900_000},"end":${T + 2_700_000},"from":${T},"link":"javascript:alert(1)"},
            "event":{"id":"c:msg-1","kind":"chat","title":"Fixed the login bug","sub":"Claude Code","url":"","privTitle":"A message from an AI"}}""")
        val p = IslandShow.page(st, T)
        assertTrue(p.on); assertTrue(p.working)
        assertEquals("short", p.pomo!!.phase); assertNull(p.pomo!!.left)
        assertEquals(120_000L, p.stand!!.len)
        assertNull(p.meet!!.link)                         // only https links
        assertEquals("Call  with Jo", p.meet!!.title)      // bidi marks taken out
        assertEquals("Fixed the login bug", p.event!!.title); assertEquals(IslandShow.Tone.BLUE, p.event!!.tone)
        val priv = IslandShow.page(JSONObject(st.toString()).put("private", true), T)
        assertEquals("A message from an AI", priv.event!!.title); assertEquals("", priv.event!!.sub)
        assertTrue(!IslandShow.page(JSONObject("""{"mode":"off"}"""), T).on)
    }

    /** PS 1.72: a tap on a reminder's pop opens PS on the island's card for that reminder (web GosLayer "rem:"). */
    @Test fun aReminderPopOpensItsCard() {
        assertEquals("rem:ab12", IslandShow.remOpen("ab12"))
        val pop = IslandShow.Pop("rem:ab12", IslandShow.Tone.AMBER, "Daily reminder", "Drink water", IslandShow.remOpen("ab12"), T + 10_000)
        val big = IslandShow.look(page(working = true), listOf(pop), T, emptyMap()) as IslandShow.Look.Big
        assertEquals("rem:ab12", big.open)
    }
}
