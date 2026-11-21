package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** PS 1.73 swipe leak: the edge strips PS asks Android to leave to its own page swipes (EdgeGuard.kt). */
class EdgeGuardTest {
    // A Pixel sized screen: 1080 x 2400 px, density 2.625, gesture insets 63 px each side.
    private val d = 2.625f
    private fun r(top: Double, bottom: Double, l: Int = 63, rt: Int = 63) = EdgeGuard.rects(top, bottom, d, 1080, 2400, l, rt)

    @Test fun offMeansNoStripsSoBackOwnsEveryEdge() {
        assertTrue(r(0.0, 0.0).isEmpty())
        assertTrue(r(100.0, 120.0).isEmpty())   // smaller than 48 css px
        assertTrue(r(Double.NaN, 500.0).isEmpty())
        assertTrue(EdgeGuard.rects(100.0, 700.0, d, 0, 2400, 63, 63).isEmpty())
    }

    @Test fun oneStripPerSideEdgeCentredAndNeverOver200dp() {
        val s = r(100.0, 800.0)
        assertEquals(2, s.size)
        val max = (200 * d).toInt()
        for (x in s) assertEquals(max, x[3] - x[1])
        val mid = ((100.0 * d).toInt() + (800.0 * d).toInt()) / 2
        assertTrue(kotlin.math.abs((s[0][1] + s[0][3]) / 2 - mid) <= 1)
        assertEquals(listOf(0, 63), listOf(s[0][0], s[0][2]))          // the left edge's own gesture width
        assertEquals(listOf(1080 - 63, 1080), listOf(s[1][0], s[1][2]))  // the right edge's
    }

    @Test fun aSmallAreaIsGuardedOnlyWhereItIs() {
        val s = r(300.0, 400.0)
        assertEquals((300 * d).toInt(), s[0][1])
        assertEquals((400 * d).toInt(), s[0][3])
    }

    @Test fun neverPastTheViewSoTheBottomHomeGestureIsUntouched() {
        val s = r(-50.0, 5000.0)
        for (x in s) { assertTrue(x[1] >= 0); assertTrue(x[3] <= 2400) }
        // A strip is at most 200 dp, centred: it ends far above the bottom edge of a tall screen.
        assertTrue(s[0][3] < 2400 - 300)
    }

    @Test fun noBackGestureOnAnEdgeNoStripThere() {
        assertTrue(r(100.0, 800.0, 0, 0).isEmpty())          // 3 button navigation
        assertEquals(1, r(100.0, 800.0, 63, 0).size)
    }

    // Source checks: what Back does is unchanged, and the strips are only set from the page's message.
    private fun src(name: String): String {
        for (base in listOf("src/main/java/com/cincee/ps/gos", "app/src/main/java/com/cincee/ps/gos")) {
            val f = File(base, name)
            if (f.exists()) return f.readText()
        }
        error("source $name not found")
    }

    @Test fun backStillDoesWhatItDid() {
        val main = src("MainActivity.kt")
        assertTrue(main.contains("override fun handleOnBackPressed() { WebHost.post(JSONObject().put(\"type\", \"back\")) }"))
        assertTrue(src("WebHost.kt").contains("\"back:none\" -> activity?.moveTaskToBack(true)"))
    }

    @Test fun stripsOnlyFromThePageAndOnlyOnTheWebView() {
        val main = src("MainActivity.kt")
        assertTrue(src("WebHost.kt").contains("\"edgeGuard\" -> activity?.setEdgeGuard("))
        assertEquals(1, Regex("systemGestureExclusionRects").findAll(main).count())
        assertTrue(main.contains("WindowInsetsCompat.Type.systemGestures()"))
        assertTrue(!main.contains("mandatorySystemGestures"))
    }
}
