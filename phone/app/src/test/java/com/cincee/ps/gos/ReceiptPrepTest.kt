package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.tan

class ReceiptPrepTest {
    /** White paper with dark lines of "print" slanted by `deg`, like rows of a receipt. */
    private fun page(w: Int, h: Int, deg: Double, paper: Int = 230): ReceiptPrep.Gray {
        val px = ByteArray(w * h) { paper.toByte() }
        val t = tan(Math.toRadians(deg))
        var row = 40
        while (row < h - 40) {
            for (x in 20 until w - 20) {
                if ((x / 9) % 4 == 3) continue   // gaps between "words"
                for (d in 0 until 5) {
                    val y = (row + d + x * t).roundToInt()
                    if (y in 0 until h) px[y * w + x] = 20
                }
            }
            row += 28
        }
        return ReceiptPrep.Gray(w, h, px)
    }

    @Test fun grayUsesTheBrightestChannelSoARedPenMarkBecomesPaper() {
        val g = ReceiptPrep.gray(intArrayOf(0xFF000000.toInt(), 0xFFE07080.toInt(), 0xFFF0F0F0.toInt()), 3, 1)
        assertEquals(0, g.at(0, 0))
        assertEquals(0xE0, g.at(1, 0))
        assertEquals(0xF0, g.at(2, 0))
    }

    @Test fun smallPicturesAreMadeBiggerAndHugeOnesSmaller() {
        val small = ReceiptPrep.fit(ReceiptPrep.Gray(700, 1000, ByteArray(700 * 1000)))
        assertEquals(ReceiptPrep.MIN_LONG, maxOf(small.w, small.h))
        assertEquals(1960, small.w)
        val big = ReceiptPrep.fit(ReceiptPrep.Gray(3000, 4000, ByteArray(3000 * 4000)))
        assertEquals(ReceiptPrep.MAX_LONG, maxOf(big.w, big.h))
        val ok = ReceiptPrep.Gray(2000, 3000, ByteArray(10))
        assertTrue(ReceiptPrep.fit(ok) === ok)
    }

    @Test fun skewIsFoundAndUndone() {
        for (deg in listOf(-4.0, -1.5, 0.0, 2.0, 5.0)) {
            val g = page(900, 1200, deg)
            val found = ReceiptPrep.skew(g)
            assertTrue("slant $deg read as $found", abs(found - deg) <= 0.3)
            val straight = ReceiptPrep.skew(ReceiptPrep.rotate(g, found))
            assertTrue("slant $deg left $straight after turning", abs(straight) <= 0.3)
        }
    }

    @Test fun thresholdKeepsPrintInAShadow() {
        // The right half is in shadow: paper 120 there, print 10. A plain cut at the middle would make all of it black.
        val w = 400; val h = 200
        val px = ByteArray(w * h) { i -> (if (i % w < 200) 230 else 120).toByte() }
        for (y in 90 until 96) for (x in 30 until 370) if ((x / 7) % 3 != 2) px[y * w + x] = (if (x < 200) 20 else 10).toByte()
        val b = ReceiptPrep.threshold(ReceiptPrep.Gray(w, h, px))
        assertEquals("paper in the light", 255, b.at(100, 30))
        assertEquals("paper in the shadow", 255, b.at(300, 30))
        assertEquals("print in the light", 0, b.at(105, 92))
        assertEquals("print in the shadow", 0, b.at(301, 92))
    }

    @Test fun prepareGivesASizedClearPicture() {
        val p = ReceiptPrep.prepare(page(600, 900, 3.0))
        assertEquals(ReceiptPrep.MIN_LONG, maxOf(p.w, p.h))
        val values = p.px.map { it.toInt() and 0xFF }
        assertTrue(values.count { it == 255 } > values.size / 2)
        assertTrue(values.any { it == 0 })
    }
}
