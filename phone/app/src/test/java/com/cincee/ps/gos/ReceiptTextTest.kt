package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Test

class ReceiptTextTest {
    @Test fun squeezesSpacesAndDropsEmptyLines() {
        val t = ReceiptText.compose(listOf(ReceiptText.Line("  Nikora   Market ", 90f), ReceiptText.Line("   ", 80f), ReceiptText.Line("Milk 3.20", 88f)))
        assertEquals("Nikora Market\nMilk 3.20", t)
    }
    @Test fun keepsGeorgianAndDropsNoise() {
        val t = ReceiptText.compose(listOf(ReceiptText.Line("სულ 12.50", 70f), ReceiptText.Line("-- ~", 5f)))
        assertEquals("სულ 12.50", t)
    }
    @Test fun confidenceIsTheAverageOfRealLines() {
        assertEquals(80f, ReceiptText.confidence(listOf(ReceiptText.Line("a1", 70f), ReceiptText.Line("b2", 90f), ReceiptText.Line("--", 0f))), 0.01f)
        assertEquals(0f, ReceiptText.confidence(emptyList()), 0.01f)
    }
}

class ReceiptWordsTest {
    private fun w(t: String, x: Int, start: Boolean, conf: Float = 80f) = ReceiptText.Word(t, conf, x, 10, x + 40, 30, start)

    @Test fun wordsAreGroupedIntoLinesWithTheirBoxes() {
        val lines = ReceiptText.lines(listOf(w("ო/", 10, true), w("180გრ", 60, false), w("6.45", 400, false), w("15.96", 700, false),
            w("  ", 10, true), w("~", 10, true, 3f), w("სულ", 10, true), w("27.99", 700, false)))
        assertEquals(listOf("ო/ 180გრ 6.45 15.96", "სულ 27.99"), lines.map { l -> l.joinToString(" ") { it.text } })
        val json = ReceiptText.layoutJson(lines)
        assertEquals(2, json.length())
        assertEquals("[\"15.96\",700,10,740,30]", json.getJSONArray(0).getJSONArray(3).toString())
    }
}
