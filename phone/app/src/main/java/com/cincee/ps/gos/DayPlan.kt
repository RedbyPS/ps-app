package com.cincee.ps.gos

import org.json.JSONObject

/**
 * The day countdown's plan from the page (PS 1.70, web src/daycount.ts planOf): times and keys only. Pure, so
 * DayPlanTest checks it on the JVM. DayEnd.kt acts on it.
 *  ask: when "End day now?" is due (ms) and the end of day it is for (ISO key).
 *  rem: when the next "You have X left" is due, the end of day it counts to, and its key.
 *  yes: the end of day already answered Yes (anywhere), remDone: the last reminder acknowledged (anywhere).
 */
data class DayPlan(val on: Boolean, val ask: Ask?, val rem: Rem?, val yes: String?, val remDone: String?, val words: Words) {
    data class Ask(val at: Long, val key: String)
    data class Rem(val at: Long, val end: Long, val key: String)
    data class Words(val ask: String, val yes: String, val snooze: String, val ack: String)

    companion object {
        val WORDS = Words("End day now?", "Yes", "Give me 15 more mins", "Acknowledged")
        val OFF = DayPlan(false, null, null, null, null, WORDS)
        private val KEY = Regex("""^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$""")
        private const val MIN_MS = 1_577_836_800_000L   // 2020
        private const val MAX_MS = 4_102_444_800_000L   // 2100
        fun isKey(s: String?): Boolean = s != null && KEY.matches(s)
        private fun ms(v: Long) = v in MIN_MS..MAX_MS
        private fun word(o: JSONObject?, k: String, def: String): String {
            val s = o?.optString(k, "")?.replace("\n", " ")?.trim().orEmpty()
            return if (s.isEmpty()) def else s.take(60)
        }

        fun from(j: JSONObject): DayPlan {
            if (!j.optBoolean("on", false)) return OFF
            val a = j.optJSONObject("ask")?.let { o ->
                val at = o.optLong("at", 0); val key = o.optString("key", "")
                if (ms(at) && isKey(key)) Ask(at, key) else null
            }
            val r = j.optJSONObject("rem")?.let { o ->
                val at = o.optLong("at", 0); val end = o.optLong("end", 0); val key = o.optString("key", "")
                if (ms(at) && ms(end) && end >= at && isKey(key)) Rem(at, end, key) else null
            }
            val yes = j.optString("yes", "").takeIf { isKey(it) }
            val remDone = j.optString("remDone", "").takeIf { isKey(it) }
            val w = j.optJSONObject("words")
            return DayPlan(true, a, r, yes, remDone, Words(word(w, "ask", WORDS.ask), word(w, "yes", WORDS.yes), word(w, "snooze", WORDS.snooze), word(w, "ack", WORDS.ack)))
        }
        fun parse(s: String?): DayPlan = if (s == null) OFF else runCatching { from(JSONObject(s)) }.getOrDefault(OFF)
        fun toJson(p: DayPlan): JSONObject {
            val o = JSONObject().put("on", p.on)
            p.ask?.let { o.put("ask", JSONObject().put("at", it.at).put("key", it.key)) }
            p.rem?.let { o.put("rem", JSONObject().put("at", it.at).put("end", it.end).put("key", it.key)) }
            p.yes?.let { o.put("yes", it) }
            p.remDone?.let { o.put("remDone", it) }
            o.put("words", JSONObject().put("ask", p.words.ask).put("yes", p.words.yes).put("snooze", p.words.snooze).put("ack", p.words.ack))
            return o
        }
        /** "4h 12m", "3h", "35m", "45s" (the same as the page's leftWords). */
        fun leftWords(ms: Long): String {
            if (ms < 60_000) return "${maxOf(0L, (ms + 999) / 1000)}s"
            val m = (ms + 59_999) / 60_000; val h = m / 60
            return if (h > 0) (if (m % 60 > 0) "${h}h ${m % 60}m" else "${h}h") else "${m}m"
        }
        fun remindTitle(ms: Long) = "You have ${leftWords(ms)} left"
    }
}
