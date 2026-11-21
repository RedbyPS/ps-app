package com.cincee.ps.gos

import org.json.JSONObject

/**
 * The phone's Dynamic Island (V1.59): what it shows, worked out from the page's island state (web src/island.ts
 * sends the same {type:"island", state} as to the Mac) and the phone's own reminders. Pure, so IslandShowTest checks it on
 * the JVM. The order is the Mac's (web core/islandtimers.ts, ps-mac IslandTimersCore.swift), one thing at a
 * time on a phone: a pop (an AI message, a client email, a reminder) first, then the green tick, a Pomodoro
 * break, a stand-up, the stand-up countdown, the next meeting, the work countdown, and last the quiet idle pill.
 */
object IslandShow {
    const val BACK_MS = 120_000L          // core/pomodoro.ts POMO_BACK_MS: a tick only in the two minutes after
    const val BACK_SHOW_MS = 3_200L       // POMO_BACK_SHOW_MS: how long "Back to work" holds
    const val STAND_LEAD_MS = 15_000L     // core/standup.ts
    const val MEET_JOIN_MS = 120_000L     // core/meetbubble.ts
    const val EVENT_MS = 8_000L           // a pop on the phone (the Mac's is 12 s; a phone's heads up says it too)
    const val REMINDER_MS = 10_000L
    /** PS 1.72 (the developer, 21 Nov 2026: a tap on the reminder did nothing useful): a tap on a reminder's pop opens PS on the
     *  island's card for that reminder, with its real buttons (web gos/PhoneIsland.tsx, GosLayer "rem:"). */
    fun remOpen(id: String): String = "rem:$id"
    const val REST_OVER_MS = 3_000L       // web core/fitisland.ts REST_OVER_MS: "Rest over" holds this long

    enum class Tone { PINK, GREEN, AMBER, BLUE, CORAL }

    data class Pomo(val id: String, val phase: String, val endsAt: Long, val left: Long?, val wait: Boolean, val clock: Boolean, val backId: String?, val backAt: Long)
    data class Stand(val at: Long, val len: Long)
    data class Meet(val title: String, val start: Long, val end: Long, val from: Long, val link: String?)
    data class Pop(val id: String, val tone: Tone, val title: String, val sub: String, val open: String, val until: Long)
    /** V1.60 Fitness (web core/fitisland.ts): one moment (Scanning, Found, Not found, Workout added, a progress hint, a nudge) and the rest. */
    data class Fit(val id: String, val kind: String, val at: Long, val until: Long, val title: String, val sub: String, val fig: IslandFig.Fig?, val sound: Boolean)
    data class FitRest(val endsAt: Long, val exercise: String, val set: Int, val of: Int, val over: Boolean, val overAt: Long)
    data class Page(val on: Boolean, val private: Boolean, val working: Boolean, val pomo: Pomo?, val stand: Stand?, val meet: Meet?, val event: Pop?,
                    val fit: Fit? = null, val rest: FitRest? = null)

    val OFF = Page(false, false, false, null, null, null, null)

    sealed class Look {
        /** The black pill hugging the camera, nothing in it (a small dot while a task is in progress). Not touchable. */
        data class Idle(val dot: Boolean) : Look()
        /** A short line and its value (a countdown, "Join"), just below the status bar. tick: counts each second. */
        data class Compact(val tone: Tone, val left: String, val right: String, val tick: Boolean, val open: String, val backId: String? = null,
                           /** V1.60: a spinner where the value goes (Scanning). */ val spin: Boolean = false) : Look()
        /** V1.60 Found: the island grows to the exercise's name and its little figure, a tick on the right. `id` tells two founds apart. */
        data class Found(val id: String, val name: String, val fig: IslandFig.Fig?, val open: String = "list") : Look()
        /** V1.60 Workout added: the Face ID style square, a big tick, the figure and "Workout added". */
        data class Added(val id: String, val title: String, val name: String, val fig: IslandFig.Fig?, val open: String = "list") : Look()
        /** Opens downwards: a title and a line, for a few seconds. */
        data class Big(val tone: Tone, val title: String, val sub: String, val open: String) : Look()
    }

    private fun isBreak(p: String) = p == "short" || p == "long"
    private fun breakNow(p: Pomo?, now: Long) = p != null && isBreak(p.phase) && (p.wait || p.left != null || now < p.endsAt)

    fun pomoBackId(p: Pomo?, now: Long): String? {
        p ?: return null
        if (isBreak(p.phase) && !p.wait && p.left == null && now >= p.endsAt && now - p.endsAt < BACK_MS) return p.id
        if (p.backId != null && now >= p.backAt && now - p.backAt < BACK_MS) return p.backId
        return null
    }
    fun standBackId(s: Stand?, now: Long): String? {
        s ?: return null
        val end = s.at + s.len
        return if (now >= end && now - end < BACK_MS) "stand-${java.lang.Long.toString(s.at, 36)}" else null
    }

    /** m:ss, or h:mm:ss from an hour. */
    fun clock(ms: Long): String {
        val s = ((ms.coerceAtLeast(0) + 999) / 1000)
        val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, sec) else String.format("%d:%02d", m, sec)
    }
    /** Whole minutes, rounded up, as the Mac's bubble ("12m", "1h 5m"). */
    fun mins(ms: Long): String {
        val m = ((ms.coerceAtLeast(0) + 59_999) / 60_000)
        return if (m >= 60) "${m / 60}h ${m % 60}m" else "${m}m"
    }

    /** seen: the green ticks already showing, with when each first showed (the caller adds one as it starts showing it). */
    fun look(p: Page, pops: List<Pop>, now: Long, seen: Map<String, Long>): Look {
        // 1. A pop: the newest one still on (the phone's own reminders and the page's event).
        val pop = (pops + listOfNotNull(p.event.takeIf { p.on })).filter { now < it.until }.maxByOrNull { it.until }
        if (pop != null) return Look.Big(pop.tone, pop.title, pop.sub, pop.open)
        if (!p.on) return Look.Idle(false)
        // 1b. A Fitness moment (the scan, a progress hint): the page sends it with its own end time.
        p.fit?.let { f -> fitLook(f, now)?.let { return it } }
        fun backOk(id: String) = seen[id]?.let { now - it < BACK_SHOW_MS } ?: true
        // 2. The green tick after a break.
        pomoBackId(p.pomo, now)?.let { if (backOk(it)) return Look.Compact(Tone.GREEN, "Back to work", "✓", false, "list", it) }
        // 3. A Pomodoro break.
        val po = p.pomo
        if (po != null && breakNow(po, now)) {
            val name = if (po.phase == "long") "Long break" else "Short break"
            return when {
                po.wait -> Look.Compact(Tone.GREEN, name, "Ready", false, "list")
                po.left != null -> Look.Compact(Tone.GREEN, "Paused", clock(po.left), false, "list")
                else -> Look.Compact(Tone.GREEN, name, clock(po.endsAt - now), true, "list")
            }
        }
        val s = p.stand
        if (s != null) {
            // 4. A stand-up and its tick.
            standBackId(s, now)?.let { if (backOk(it)) return Look.Compact(Tone.GREEN, "Back to work", "✓", false, "list", it) }
            if (now >= s.at && now < s.at + s.len) return Look.Compact(Tone.AMBER, "Stand up", clock(s.at + s.len - now), true, "list")
            // 5. The 15 seconds before one (never in a break: the break counts as standing).
            if (now >= s.at - STAND_LEAD_MS && now < s.at && !breakNow(po, s.at)) return Look.Compact(Tone.AMBER, "Stand up in", "${(s.at - now + 999) / 1000}", true, "list")
        }
        // 5b. The rest between sets: counts down live, then "Rest over" for a moment (the sound is the shell's own, Fitness.kt).
        p.rest?.let { r ->
            if (!r.over && now < r.endsAt) return Look.Compact(Tone.BLUE, "Rest", clock(r.endsAt - now), true, "list")
            if (r.over && now - r.overAt < REST_OVER_MS) return Look.Compact(Tone.GREEN, "Rest over", "Go", false, "list")
        }
        // 6. The next meeting.
        val m = p.meet
        if (m != null && now >= m.from && now < m.end) {
            val name = if (p.private) "Meeting" else m.title.ifBlank { "Meeting" }
            return when {
                now >= m.start -> Look.Compact(Tone.BLUE, name, "${mins(m.end - now)} left", true, "plan")
                m.link != null && m.start - now <= MEET_JOIN_MS -> Look.Compact(Tone.BLUE, name, "Join", true, "url:${m.link}")
                else -> Look.Compact(Tone.BLUE, name, mins(m.start - now), true, "plan")
            }
        }
        // 7. Work, with "time left on the island while you work" on.
        if (po != null && po.phase == "work" && po.clock && !po.wait) {
            return if (po.left != null) Look.Compact(Tone.PINK, "Paused", clock(po.left), false, "list")
            else if (now < po.endsAt) Look.Compact(Tone.PINK, "Work", clock(po.endsAt - now), true, "list")
            else Look.Idle(p.working)
        }
        return Look.Idle(p.working)
    }

    /** The look of a Fitness moment, or null when it is over (its end time passed). */
    fun fitLook(f: Fit, now: Long): Look? {
        if (now >= f.until) return null
        return when (f.kind) {
            "scanning" -> Look.Compact(Tone.BLUE, "Scanning", "", false, "list", spin = true)
            "found" -> Look.Found(f.id, f.title, f.fig)
            "notfound" -> Look.Compact(Tone.CORAL, "Not found", "", false, "list")
            "added" -> Look.Added(f.id, f.title, f.sub, f.fig)
            "better" -> Look.Big(Tone.GREEN, f.title, f.sub, "list")
            "same" -> Look.Big(Tone.AMBER, f.title, f.sub, "list")
            "nudge" -> Look.Big(Tone.AMBER, f.title, f.sub, "list")
            else -> null
        }
    }

    /** When the look may change next with no new message (null: never by itself). The service sleeps until then. */
    fun wakeAt(p: Page, pops: List<Pop>, now: Long, hideUntil: Long): Long? {
        val t = mutableListOf<Long>()
        pops.forEach { t += it.until }
        if (p.on) {
            p.event?.let { t += it.until }
            p.pomo?.let { t += it.endsAt; t += it.endsAt + BACK_SHOW_MS; t += it.backAt + BACK_SHOW_MS }
            p.stand?.let { t += it.at - STAND_LEAD_MS; t += it.at; t += it.at + it.len; t += it.at + it.len + BACK_SHOW_MS }
            p.fit?.let { t += it.until }
            p.rest?.let { t += it.endsAt; t += it.overAt + REST_OVER_MS }
            p.meet?.let { t += it.from; t += it.start - MEET_JOIN_MS; t += it.start; t += it.end }
        }
        t += hideUntil
        return t.filter { it > now }.minOrNull()
    }

    // ---------- the page's message ----------
    private fun num(o: JSONObject?, k: String): Long? = o?.opt(k).let { if (it is Number && it.toDouble().isFinite()) it.toLong() else null }
    private fun str(o: JSONObject?, k: String, max: Int): String = (o?.opt(k) as? String)?.replace(Regex("[\\p{Cntrl}\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]"), " ")?.trim()?.take(max) ?: ""

    /** The page's {type:"island", state} (src/island.ts). now: when it came, for the pop's few seconds. */
    fun page(st: JSONObject?, now: Long): Page {
        st ?: return OFF
        if (st.optString("mode") == "off") return OFF
        val priv = st.optBoolean("private")
        val pomo = st.optJSONObject("pomo")?.let { o ->
            val ends = num(o, "endsAt") ?: return@let null
            val back = o.optJSONObject("back")
            Pomo(str(o, "id", 60), str(o, "phase", 10), ends, num(o, "left"), o.optBoolean("wait"), o.optBoolean("clock"),
                back?.let { str(it, "id", 60).ifEmpty { null } }, num(back, "at") ?: 0L)
        }
        val stand = st.optJSONObject("stand")?.let { o -> val at = num(o, "at") ?: return@let null; Stand(at, (num(o, "len") ?: 0L).coerceIn(0L, 3_600_000L)) }
        val meet = st.optJSONObject("meet")?.let { o ->
            val start = num(o, "start") ?: return@let null
            val link = str(o, "link", 1500).takeIf { it.startsWith("https://") && !it.contains(' ') }
            Meet(str(o, "title", 120), start, num(o, "end") ?: (start + 1_800_000L), num(o, "from") ?: start, link)
        }
        val event = st.optJSONObject("event")?.let { e ->
            val id = str(e, "id", 60).ifEmpty { return@let null }
            val kind = str(e, "kind", 10)
            val ai = e.has("privTitle")
            val tone = when { ai -> Tone.BLUE; kind == "chat" -> Tone.CORAL; else -> Tone.PINK }
            val kindWords = when (kind) { "mail" -> "New client email"; "lead" -> "New lead reply"; else -> if (ai) "A message from an AI" else "An AI chat finished" }
            val title = if (priv) str(e, "privTitle", 80).ifEmpty { kindWords } else str(e, "title", 200).ifEmpty { kindWords }
            val sub = if (priv) "" else str(e, "sub", 200)
            Pop("ev:$id", tone, title, sub, if (kind == "chat") "list" else "inbox", now + EVENT_MS)
        }
        val working = st.optJSONObject("task") != null
        return Page(true, priv, working, pomo, stand, meet, event, fit(st.optJSONObject("fit")), fitRest(st.optJSONObject("fit")))
    }

    // ---------- Fitness (V1.60) ----------
    /** The `fit.moment` of the island state. Unknown kinds and a moment with no end time are dropped. */
    fun fit(f: JSONObject?): Fit? {
        val m = f?.optJSONObject("moment") ?: return null
        val kind = str(m, "kind", 12)
        if (kind !in KINDS) return null
        val id = str(m, "id", 60).ifEmpty { return null }
        val at = num(m, "at") ?: return null
        val until = num(m, "until") ?: return null
        return Fit(id, kind, at, until.coerceAtMost(at + 60_000L), str(m, "title", 80), str(m, "sub", 80), IslandFig.parse(m.optJSONObject("fig")), m.optBoolean("sound", true))
    }
    fun fitRest(f: JSONObject?): FitRest? {
        val r = f?.optJSONObject("rest") ?: return null
        val ends = num(r, "endsAt") ?: return null
        return FitRest(ends, str(r, "exercise", 60), (num(r, "set") ?: 0L).toInt().coerceIn(0, 999), (num(r, "of") ?: 0L).toInt().coerceIn(0, 999), r.optBoolean("over"), num(r, "overAt") ?: 0L)
    }
    val KINDS = setOf("scanning", "found", "notfound", "added", "better", "same", "nudge")
}
