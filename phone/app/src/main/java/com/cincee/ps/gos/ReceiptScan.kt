package com.cincee.ps.gos

import android.content.Context
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.HandlerThread
import com.googlecode.tesseract.android.TessBaseAPI
import org.json.JSONArray
import org.json.JSONObject

/*
 * Receipt scan (PS 1.65, the developer, 17 Nov 2026: "scan receipts, mostly Georgian, nothing leaves my devices"). The page
 * (web src/views/ReceiptScan.tsx, src/gos/receiptscan.ts) takes one still from its own camera view and sends it here as a data
 * URL. The same offline Tesseract as the gym scan reads it with the Georgian (kat) and English (eng) "fast" models bundled in
 * assets/tessdata (pinned by SHA-256 in app/build.gradle.kts, checkTessdata), and the text goes back to the page, which finds the
 * shop, the date, the total and the items (web src/core/receiptparse.ts, tested there).
 *
 * Receipt accuracy fix (after 1.66, the developer: "VERY inaccurate" on a Georgian SPAR receipt): the picture is now cleaned first
 * (ReceiptPrep.kt: grey, sized, straightened, adaptive threshold) and the answer carries every word with its box, so the page can
 * read the receipt as the table it is (each number under its own column heading) instead of guessing from plain lines.
 *
 * Privacy: the picture is decoded in memory, read and dropped. It is never written to a file and never sent anywhere; this file
 * has no network code. The log says how many characters were read and how long it took, never what. The reader works on its own thread and lets its
 * memory go after 90 s without a scan.
 */
object ReceiptScan {
    private const val LANGS = "kat+eng"
    private const val IDLE_MS = 90_000L
    private val thread = HandlerThread("ps-receipt").apply { start() }
    private val h = Handler(thread.looper)
    private var tess: TessBaseAPI? = null   // only touched on the ps-receipt thread
    @Volatile private var busy = false
    private val idle = Runnable { release() }
    private val ID = Regex("^[A-Za-z0-9_-]{1,40}$")

    /** True when the message was a Receipt scan one. Called on the bridge thread; the work goes to the ps-receipt thread. */
    fun handle(c: Context, type: String, m: JSONObject, post: (JSONObject) -> Unit): Boolean {
        when (type) {
            "receiptscan:warm" -> h.post { runCatching { api(c) }; later() }
            "receiptscan:read" -> {
                val id = m.optString("id")
                if (!ID.matches(id)) return true
                if (busy) { post(answer(id).put("error", "busy")); return true }
                busy = true
                val img = m.optString("img")
                h.post {
                    val out = try { read(c, id, img) } catch (e: Throwable) {
                        Plog.i("receiptscan: failed (${e.javaClass.simpleName})"); answer(id).put("error", "failed")
                    }
                    busy = false
                    later()
                    post(out)
                }
            }
            else -> return false
        }
        return true
    }

    private fun answer(id: String) = JSONObject().put("type", "receiptscan").put("id", id)

    private fun read(c: Context, id: String, img: String): JSONObject {
        val bytes = ScanText.bytes(img) ?: return answer(id).put("error", "image")
        val g = decodeGray(bytes) ?: return answer(id).put("error", "image")
        val t0 = System.currentTimeMillis()
        val t = api(c) ?: return answer(id).put("error", "model")
        // The picture work (ReceiptPrep.kt): grey from the brightest channel, the right size, straightened, adaptive threshold.
        val p = ReceiptPrep.prepare(g)
        val t1 = System.currentTimeMillis()
        // One column: a receipt is a list, and the automatic layout often reads the prices as a second block after all the
        // names, which breaks "name ... price" apart. Single column keeps each printed line whole; the word boxes below then
        // let the page put every number under its own column heading.
        t.setPageSegMode(TessBaseAPI.PageSegMode.PSM_SINGLE_COLUMN)
        t.setVariable("preserve_interword_spaces", "1")
        t.setImage(p.px, p.w, p.h, 1, p.w)
        val words = ArrayList<ReceiptText.Word>()
        try {
            t.getUTF8Text()   // runs the reader
            val it = t.getResultIterator()
            if (it != null) {
                try {
                    it.begin()
                    do {
                        val text = it.getUTF8Text(TessBaseAPI.PageIteratorLevel.RIL_WORD) ?: continue
                        val b = it.getBoundingBox(TessBaseAPI.PageIteratorLevel.RIL_WORD) ?: continue
                        if (b.size < 4) continue
                        words += ReceiptText.Word(text, it.confidence(TessBaseAPI.PageIteratorLevel.RIL_WORD), b[0], b[1], b[2], b[3],
                            it.isAtBeginningOf(TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE))
                    } while (it.next(TessBaseAPI.PageIteratorLevel.RIL_WORD))
                } finally {
                    it.delete()
                }
            }
        } finally {
            t.clear()
        }
        val lines = ReceiptText.lines(words)
        val tl = lines.map { l -> ReceiptText.Line(l.joinToString(" ") { w -> w.text }, l.map { w -> w.conf }.average().toFloat()) }
        val text = ReceiptText.compose(tl)
        Plog.i("receiptscan: ${text.length} characters, ${p.w}x${p.h}, picture ${t1 - t0} ms, read ${System.currentTimeMillis() - t1} ms")
        return answer(id).put("text", text).put("conf", ReceiptText.confidence(tl))
            .put("words", ReceiptText.layoutJson(lines)).put("w", p.w).put("h", p.h)
    }

    /** The picture as grey bytes, read one row at a time so a big photo never needs a second full copy in colour. */
    private fun decodeGray(bytes: ByteArray): ReceiptPrep.Gray? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        var sample = 1
        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= ReceiptPrep.MAX_LONG) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        try {
            val w = bmp.width; val h = bmp.height
            val px = ByteArray(w * h)
            val row = IntArray(w)
            for (y in 0 until h) { bmp.getPixels(row, 0, w, 0, y, w, 1); ReceiptPrep.grayRow(row, px, y * w, w) }
            return ReceiptPrep.Gray(w, h, px)
        } finally {
            bmp.recycle()
        }
    }

    /** The reader, made once: the models are copied out of the APK the first time (OcrModels, shared with the gym scan). */
    private fun api(c: Context): TessBaseAPI? {
        tess?.let { return it }
        val root = OcrModels.root(c, LANGS, "receipt") ?: return null
        val t = TessBaseAPI()
        if (!t.init(root.absolutePath, LANGS, TessBaseAPI.OEM_LSTM_ONLY)) { t.recycle(); Plog.i("receiptscan: the reader did not start"); return null }
        t.setVariable("user_defined_dpi", "300")
        tess = t
        return t
    }

    private fun later() { h.removeCallbacks(idle); h.postDelayed(idle, IDLE_MS) }
    private fun release() { tess?.recycle(); tess = null }
}

/** The pure part of Receipt scan (ReceiptTextTest on the JVM): the lines the reader found, tidied, one per line. */
object ReceiptText {
    /** One line the reader found and how sure it is of it (0 to 100). */
    data class Line(val text: String, val conf: Float)
    /** One word the reader found, its box in the prepared picture, and whether it starts a printed line. */
    data class Word(val text: String, val conf: Float, val x0: Int, val y0: Int, val x1: Int, val y1: Int, val lineStart: Boolean)

    private const val MAX_LINES = 400
    private const val MAX_WORDS = 60

    /** Spaces squeezed, empty lines gone, and a line the reader is nearly blind to (under 15) with no digit and no letter dropped. */
    fun compose(lines: List<Line>): String =
        lines.map { it.copy(text = it.text.replace(Regex("[ \\t\\u00A0]+"), " ").trim()) }
            .filter { it.text.isNotEmpty() && (it.conf >= 15f || it.text.any { c -> c.isLetterOrDigit() }) }
            .joinToString("\n") { it.text }

    /** The average sureness of the lines with something in them, 0 when there are none. */
    fun confidence(lines: List<Line>): Float {
        val l = lines.filter { it.text.any { c -> c.isLetterOrDigit() } }
        return if (l.isEmpty()) 0f else l.map { it.conf }.average().toFloat()
    }

    /** The words grouped into printed lines, empty words and noise lines (no letter, no digit, under 15 sure) left out. */
    fun lines(words: List<Word>): List<List<Word>> {
        val out = ArrayList<MutableList<Word>>()
        for (w in words) {
            val t = w.text.replace(Regex("[ \\t\\u00A0]+"), " ").trim()
            if (w.lineStart || out.isEmpty()) out += ArrayList<Word>()
            if (t.isNotEmpty() && out.last().size < MAX_WORDS) out.last() += w.copy(text = t)
        }
        return out.filter { l -> l.isNotEmpty() && (l.map { it.conf }.average() >= 15f || l.any { w -> w.text.any { c -> c.isLetterOrDigit() } }) }.take(MAX_LINES)
    }

    /** The lines for the page: [[text, x0, y0, x1, y1], ...] per line. Only positions and the words, nothing else. */
    fun layoutJson(lines: List<List<Word>>): JSONArray {
        val a = JSONArray()
        for (l in lines) {
            val la = JSONArray()
            for (w in l) la.put(JSONArray().put(w.text).put(w.x0).put(w.y0).put(w.x1).put(w.y1))
            a.put(la)
        }
        return a
    }
}
