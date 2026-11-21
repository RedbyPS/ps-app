package com.cincee.ps.gos

/**
 * PS 1.73 swipe leak (the developer, 21 Nov 2026: "I had the same problem on the GOS app as well when swiping left and right"). A sideways
 * swipe that starts near a side edge is Android's Back gesture, so swiping between PS's own pages there closed a layer or sent PS
 * to the background. The page (web src/gos/edgeguard.ts, rule in src/core/edgeguard.ts) says where its swipeable pages
 * are while nothing is open over them; this works out the two strips Android is asked to leave to PS
 * (View.setSystemGestureExclusionRects, MainActivity.setEdgeGuard).
 *
 * Pure, unit tested (EdgeGuardTest). Rules:
 *  - one strip per side edge that has a Back gesture (its system gesture inset is above 0; 3 button navigation has none: no strips);
 *  - centred on the page's area, never taller than 200 dp (Android honours no more per edge; the rest of the edge keeps Back);
 *  - the bottom (home) gesture is never part of it;
 *  - area off (top 0, bottom 0), too small, or nonsense: no strips, every edge is Back again.
 * Rects are [left, top, right, bottom] in the WebView's own pixels.
 */
object EdgeGuard {
    const val MAX_DP = 200f
    const val MIN_CSS = 48.0

    fun rects(topCss: Double, bottomCss: Double, density: Float, viewW: Int, viewH: Int, leftInset: Int, rightInset: Int): List<IntArray> {
        if (!topCss.isFinite() || !bottomCss.isFinite() || density <= 0f || viewW <= 0 || viewH <= 0) return emptyList()
        if (bottomCss - topCss < MIN_CSS) return emptyList()
        val top = (topCss * density).toInt().coerceIn(0, viewH)
        val bottom = (bottomCss * density).toInt().coerceIn(0, viewH)
        val max = (MAX_DP * density).toInt()
        val h = minOf(bottom - top, max)
        if (h <= 0) return emptyList()
        val t = top + (bottom - top - h) / 2
        val b = t + h
        val out = ArrayList<IntArray>(2)
        if (leftInset > 0) out.add(intArrayOf(0, t, minOf(leftInset, viewW), b))
        if (rightInset > 0) out.add(intArrayOf(maxOf(0, viewW - rightInset), t, viewW, b))
        return out
    }
}
