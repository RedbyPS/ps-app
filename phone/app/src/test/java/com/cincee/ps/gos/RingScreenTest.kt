package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** PS 1.72: how every call style ring reaches the screen (RingScreen.kt), and the one time notice. */
class RingScreenTest {
    @Test fun everyWayAndroidAllows() {
        assertEquals(RingScreen.Way.BOTH, RingScreen.way(fullScreen = true, overlay = true))
        assertEquals(RingScreen.Way.FULL_SCREEN, RingScreen.way(fullScreen = true, overlay = false))
        assertEquals(RingScreen.Way.DIRECT, RingScreen.way(fullScreen = false, overlay = true))
        assertEquals(RingScreen.Way.HEADS_UP, RingScreen.way(fullScreen = false, overlay = false))
    }
    @Test fun toldOnceWhileOffAndAgainOnlyAfterItWasOn() {
        assertTrue(RingScreen.tellNow(fullScreen = false, told = false))
        assertFalse(RingScreen.tellNow(fullScreen = false, told = true))    // the next rings: quiet
        assertFalse(RingScreen.tellNow(fullScreen = true, told = false))
        assertFalse(RingScreen.toldAfter(fullScreen = true, told = true))   // switched on: forgotten
        assertTrue(RingScreen.toldAfter(fullScreen = false, told = true))
        assertTrue(RingScreen.tellNow(fullScreen = false, told = RingScreen.toldAfter(fullScreen = true, told = true)))   // off again: told again
    }
    @Test fun aRingChannelMustBeHigh() {
        assertTrue(RingScreen.channelOk(4))     // IMPORTANCE_HIGH
        assertTrue(RingScreen.channelOk(5))
        assertFalse(RingScreen.channelOk(3))    // DEFAULT: never full screen
        assertTrue(RingScreen.channelOk(null))  // not made yet: made HIGH
    }
    @Test fun theNoticeUsesThePermissionRowsWordsWithNoDashes() {
        assertEquals("Gym alarm on the lock screen", RingScreen.TELL_TITLE)
        assertFalse(RingScreen.TELL_TEXT.any { it.code == 0x2014 || it.code == 0x2013 })
    }
}
