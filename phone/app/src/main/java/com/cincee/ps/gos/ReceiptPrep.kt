package com.cincee.ps.gos

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tan

/*
 * Receipt scan picture work (receipt accuracy fix, after 1.66): what the photo goes through before Tesseract reads it. Pure (no
 * Android classes), so it is tested on the JVM (ReceiptPrepTest). All of it runs on the ps-receipt thread, never the main one.
 *
 * 1. Grey from the brightest colour channel: black print stays black, while a red or blue pen mark across the paper (the developer's test
 *    receipt had a red stripe through the card slip) turns as light as the paper and stops breaking the letters under it.
 * 2. Scaled so the long side is 2800 to 3600 pixels: small print from a far photo is made bigger (Tesseract reads letters best
 *    at about 30 pixels high), a huge photo is made smaller so the read stays quick.
 * 3. Straightened: the slant of the printed lines is found on a small copy (the angle where the dark pixels pile up on the fewest
 *    rows) and the picture is turned back by it, so a line of the table stays one line.
 * 4. A soft adaptive threshold: every pixel is compared with the mean of its own neighbourhood, so a shadow over half the receipt
 *    does not swallow the print. Soft means a short ramp instead of a hard cut, which keeps faint thermal print readable.
 */
object ReceiptPrep {
    /** A grey picture: one byte per pixel, 0 is black, 255 is white. */
    class Gray(val w: Int, val h: Int, val px: ByteArray) {
        fun at(x: Int, y: Int): Int = px[y * w + x].toInt() and 0xFF
    }

    const val MIN_LONG = 2800
    const val MAX_LONG = 3600

    /** One row of ARGB pixels into grey (the brightest channel). */
    fun grayRow(argb: IntArray, out: ByteArray, off: Int, n: Int) {
        for (i in 0 until n) {
            val c = argb[i]
            val r = (c shr 16) and 0xFF; val g = (c shr 8) and 0xFF; val b = c and 0xFF
            out[off + i] = max(r, max(g, b)).toByte()
        }
    }

    fun gray(argb: IntArray, w: Int, h: Int): Gray {
        val px = ByteArray(w * h)
        val row = IntArray(w)
        for (y in 0 until h) { System.arraycopy(argb, y * w, row, 0, w); grayRow(row, px, y * w, w) }
        return Gray(w, h, px)
    }

    /** Scaled (bilinear) so the long side is between minLong and maxLong; unchanged when it already is. */
    fun fit(g: Gray, minLong: Int = MIN_LONG, maxLong: Int = MAX_LONG): Gray {
        val long = max(g.w, g.h)
        val k = when { long < minLong -> minLong.toDouble() / long; long > maxLong -> maxLong.toDouble() / long; else -> return g }
        return scale(g, max(1, (g.w * k).roundToInt()), max(1, (g.h * k).roundToInt()))
    }

    fun scale(g: Gray, nw: Int, nh: Int): Gray {
        val out = ByteArray(nw * nh)
        val sx = g.w.toDouble() / nw; val sy = g.h.toDouble() / nh
        for (y in 0 until nh) {
            val fy = ((y + 0.5) * sy - 0.5).coerceIn(0.0, (g.h - 1).toDouble())
            val y0 = floor(fy).toInt(); val y1 = min(y0 + 1, g.h - 1); val dy = fy - y0
            for (x in 0 until nw) {
                val fx = ((x + 0.5) * sx - 0.5).coerceIn(0.0, (g.w - 1).toDouble())
                val x0 = floor(fx).toInt(); val x1 = min(x0 + 1, g.w - 1); val dx = fx - x0
                val top = g.at(x0, y0) * (1 - dx) + g.at(x1, y0) * dx
                val bot = g.at(x0, y1) * (1 - dx) + g.at(x1, y1) * dx
                out[y * nw + x] = (top * (1 - dy) + bot * dy).roundToInt().coerceIn(0, 255).toByte()
            }
        }
        return Gray(nw, nh, out)
    }

    /**
     * The slant of the printed lines in degrees (positive: the lines go down to the right), between -8 and 8, found on a copy
     * about 700 pixels wide. 0 when there is too little print to tell.
     */
    fun skew(g: Gray): Double {
        val k = min(1.0, 700.0 / g.w)
        val s = if (k < 1.0) scale(g, max(1, (g.w * k).roundToInt()), max(1, (g.h * k).roundToInt())) else g
        val b = threshold(s, window(s), soft = false)
        val xs = ArrayList<Int>(); val ys = ArrayList<Int>()
        for (y in 0 until b.h) for (x in 0 until b.w) if (b.at(x, y) < 128) { xs += x; ys += y }
        if (xs.size < 200) return 0.0
        // Thin out a very dark picture: the score only needs a fair sample of the print.
        val step = max(1, xs.size / 80_000)
        fun score(deg: Double): Double {
            val t = tan(Math.toRadians(deg))
            val off = (abs(t) * b.w).toInt() + 2
            val bins = IntArray(b.h + 2 * off)
            var i = 0
            while (i < xs.size) { val r = (ys[i] - xs[i] * t).roundToInt() + off; if (r in bins.indices) bins[r]++; i += step }
            var sum = 0.0
            for (c in bins) sum += c.toDouble() * c
            return sum
        }
        var best = 0.0; var bestScore = score(0.0)
        var a = -8.0
        while (a <= 8.0) { val sc = score(a); if (sc > bestScore * 1.0001) { best = a; bestScore = sc }; a += 0.25 }
        val centre = best
        a = centre - 0.25
        while (a <= centre + 0.25) { val sc = score(a); if (sc > bestScore * 1.0001) { best = a; bestScore = sc }; a += 0.05 }
        return (best * 100).roundToInt() / 100.0
    }

    /** Turned by `deg` around the centre so lines slanted by `deg` come out level. Corners that come in from outside are white. */
    fun rotate(g: Gray, deg: Double): Gray {
        val r = Math.toRadians(deg)
        val c = cos(r); val s = sin(r)
        val cx = (g.w - 1) / 2.0; val cy = (g.h - 1) / 2.0
        val out = ByteArray(g.w * g.h)
        for (y in 0 until g.h) {
            val ry = y - cy
            for (x in 0 until g.w) {
                val rx = x - cx
                val fx = cx + rx * c - ry * s
                val fy = cy + rx * s + ry * c
                val x0 = floor(fx).toInt(); val y0 = floor(fy).toInt()
                val v = if (x0 < 0 || y0 < 0 || x0 >= g.w - 1 || y0 >= g.h - 1) 255 else {
                    val dx = fx - x0; val dy = fy - y0
                    val top = g.at(x0, y0) * (1 - dx) + g.at(x0 + 1, y0) * dx
                    val bot = g.at(x0, y0 + 1) * (1 - dx) + g.at(x0 + 1, y0 + 1) * dx
                    (top * (1 - dy) + bot * dy).roundToInt()
                }
                out[y * g.w + x] = v.coerceIn(0, 255).toByte()
            }
        }
        return Gray(g.w, g.h, out)
    }

    /** The neighbourhood for the threshold: about a 45th of the long side, odd, at least 15 pixels. */
    fun window(g: Gray): Int { val n = max(15, max(g.w, g.h) / 45); return if (n % 2 == 0) n + 1 else n }

    /**
     * Adaptive threshold (Bradley): a pixel darker than its neighbourhood mean by more than `t` is print. With `soft` a ramp of
     * a few percent of the mean either side of the cut keeps the edges of thin strokes grey instead of breaking them.
     * Memory is one sum per column: the window slides down the picture row by row.
     */
    fun threshold(g: Gray, win: Int = window(g), t: Double = 0.15, soft: Boolean = true): Gray {
        val w = g.w; val h = g.h; val r = win / 2
        val out = ByteArray(w * h)
        val colSum = LongArray(w)
        val pre = LongArray(w + 1)
        fun addRow(y: Int, sign: Int) {
            pre[0] = 0
            for (x in 0 until w) pre[x + 1] = pre[x] + (g.px[y * w + x].toInt() and 0xFF)
            for (x in 0 until w) { val a = max(0, x - r); val b = min(w - 1, x + r); colSum[x] += sign * (pre[b + 1] - pre[a]) }
        }
        var top = 0; var bottom = -1   // rows inside the window now
        for (y in 0 until h) {
            val want0 = max(0, y - r); val want1 = min(h - 1, y + r)
            while (bottom < want1) { bottom++; addRow(bottom, 1) }
            while (top < want0) { addRow(top, -1); top++ }
            val rows = bottom - top + 1
            for (x in 0 until w) {
                val cols = min(w - 1, x + r) - max(0, x - r) + 1
                val mean = colSum[x].toDouble() / (rows * cols)
                val v = g.px[y * w + x].toInt() and 0xFF
                val cut = mean * (1 - t)
                val o = if (!soft) { if (v < cut) 0 else 255 } else {
                    val ramp = max(4.0, mean * 0.06)
                    when { v <= cut - ramp -> 0; v >= cut + ramp -> 255; else -> ((v - (cut - ramp)) / (2 * ramp) * 255).roundToInt() }
                }
                out[y * w + x] = o.coerceIn(0, 255).toByte()
            }
        }
        return Gray(w, h, out)
    }

    /** Everything above in order. The skew is only undone when it is big enough to matter (a quarter of a degree). */
    fun prepare(g: Gray): Gray {
        var p = fit(g)
        val a = skew(p)
        if (abs(a) >= 0.25) p = rotate(p, a)
        return threshold(p)
    }
}
