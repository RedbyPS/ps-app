package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mark done on an AI message's notification (MarkDone.kt, PS 1.74). Fictional card ids only. */
class MarkDoneTest {
    @Test fun onlyAiMessagesThatSaySo() {
        assertTrue(MarkDone.shows("c:msg-abc123def456", true))
        assertFalse(MarkDone.shows("c:msg-abc123def456", false))
        assertFalse(MarkDone.shows("c:43eece02-c43a", true))   // a plain finished chat
        assertFalse(MarkDone.shows("m:mail1", true))
        assertFalse(MarkDone.shows("n:lead1", true))
    }
    @Test fun theWordsMatchThePage() {
        assertEquals("Mark done", MarkDone.LABEL)
        assertEquals("done", MarkDone.ACTION)
    }
    @Test fun tapsKeptWhileAsleepOncePerCardAndCapped() {
        assertEquals(setOf("c:msg-a"), MarkDone.keep(setOf("c:msg-a"), "c:msg-a"))
        assertEquals(setOf("c:msg-a", "c:msg-b"), MarkDone.keep(setOf("c:msg-a"), "c:msg-b"))
        var s = emptySet<String>()
        for (i in 0 until 30) s = MarkDone.keep(s, "c:msg-$i")
        assertEquals(20, s.size)
        assertTrue("c:msg-29" in s)
    }
}
