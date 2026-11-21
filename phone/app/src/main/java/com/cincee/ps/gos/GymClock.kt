package com.cincee.ps.gos

import org.json.JSONObject

/**
 * The gym reminder's timing on the phone, with no Android in it (unit tested in src/test). The page
 * (web src/core/gym.ts, src/gymwatch.ts) sends a plan: the gym times for the next 8 days, the
 * days the developer already acknowledged, and the minutes before (120, 60, 30, 10 notify; 16 rings). From that
 * the shell works out every step itself, so the reminders and the ring come on time while PS sleeps.
 * A step more than its grace late (the phone was off) is skipped, never fired late in a pile.
 *
 * V1.57 (the developer, 13 Nov 2026):
 *  - Each day may carry its own ring time (`ring`, his: 22:55), its end (`end`, a gym may run past midnight) and, in
 *    nag mode, the first reminder (`from`, default 10:00) and the interval (`every`, 15 min): a notification every
 *    15 minutes until "Yes, I'm going". A nag step keeps its grace for the whole interval and only the newest fires,
 *    so a phone that was off shows one, never a pile. The day is the day the nagging started.
 *  - Alarms at any time (Settings, Annoying 15 min reminder, Alarms): the plan's `alarms`, each a ring with its own
 *    title, words, stop button and colours. They ring with the same ring (GymRing with key "a:<id>"), the same
 *    10 minutes, the same Later and the same missed notice. Acknowledge is the reminder's "done" for that day.
 *  - PS 1.73: the Priority 1 alarm (web core/duealerts.ts) is one of these alarms with `one`: a single button,
 *    "I acknowledge", and no Later, and with `word` ("yes"): the button only stops it once that word is typed (any case), the
 *    Annoying reminder's own rule (RemRing). Its words carry the task's name and the time left, so they may be up to 160 long.
 */
data class GymItem(val day: String, val at: Long, val end: Long = 0, val ring: Long = 0, val from: Long = 0, val every: Long = 0)
/** One alarm ring (web core/remind.ts alarmRings). `day` is the day Acknowledge counts for. */
data class AlarmItem(val id: String, val day: String, val at: Long, val title: String, val text: String, val yes: String,
                     val later: String, val bg: String, val accent: String, val ink: String, val one: Boolean = false, val word: String = "") {
    val key get() = "a:$id"
    val ackKey get() = "$id:$day"
}
data class GymPlan(val on: Boolean, val time: String, val items: List<GymItem>, val acked: Set<String>,
                   val before: List<Int>, val ring: Int, val grace: Long, val alarms: List<AlarmItem> = emptyList())
data class GymStep(val id: String, val day: String, val at: Long, val mins: Int, val due: Long, val ring: Boolean,
                   val nag: Boolean = false, val grace: Long = 0)
/** One ring and its snoozes, kept while it lasts: `at` gym (or alarm) time, `start` when this ring began, `snoozeAt`
 *  when Later rings again (0 while it rings). `key`: "gym", or "a:<alarm id>" for an alarm. */
data class GymRing(val day: String, val at: Long, val start: Long, val snoozeAt: Long = 0, val key: String = GymClock.GYM) {
    val alarmId: String? get() = if (key.startsWith("a:")) key.substring(2) else null
}
/** Where a ring stands now. AGAIN: Later's 5 minutes are up. MISSED: it rang 10 minutes unanswered. DONE: acknowledged or switched off. */
enum class RingNow { NONE, RINGING, SNOOZED, AGAIN, MISSED, DONE }

object GymClock {
    /** The ring may still start this late (the phone was rebooting at 07:44, say); notifications only `grace`. */
    const val RING_GRACE = 5 * 60_000L
    /** Each ring (the first and every one after Later) stops by itself after this, then a missed-gym notification (the developer, 2 Nov 2026). */
    const val RING_FOR = 10 * 60_000L
    /** Later: quiet this long, then it rings again. */
    const val SNOOZE = 5 * 60_000L
    const val GYM = "gym"
    private val DAY = Regex("""^\d{4}-\d{2}-\d{2}$""")
    private val TIME = Regex("""^([01]\d|2[0-3]):[0-5]\d$""")
    private val ALARM_ID = Regex("""^[a-z0-9]{1,16}$""")
    private val HEX = Regex("""^#[0-9a-fA-F]{6}$""")
    const val MAX_ALARMS = 40
    private fun line(s: String, max: Int) = s.replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim().take(max)

    /** PS 1.73: may this typed text stop the alarm? Always when it has no word; else only the word, any case, spaces trimmed. */
    fun confirms(a: AlarmItem?, typed: String?): Boolean = a == null || a.word.isEmpty() || (typed ?: "").trim().equals(a.word.trim(), ignoreCase = true)

    fun parse(s: String?): GymPlan? = runCatching { from(JSONObject(s ?: return null)) }.getOrNull()
    fun from(j: JSONObject): GymPlan {
        val items = ArrayList<GymItem>()
        j.optJSONArray("items")?.let { a ->
            for (i in 0 until minOf(a.length(), 20)) {
                val o = a.optJSONObject(i) ?: continue
                val day = o.optString("day"); val at = o.optLong("at")
                if (!DAY.matches(day) || at <= 0) continue
                val end = o.optLong("end", 0).takeIf { it > at } ?: 0
                val ring = o.optLong("ring", 0).takeIf { it > 0 } ?: 0
                val every = o.optLong("every", 0).takeIf { it in 60_000L..(6 * 3_600_000L) } ?: 0
                val from = if (every > 0) o.optLong("from", 0).takeIf { it in 1..at } ?: 0 else 0
                items.add(GymItem(day, at, end, ring, from, if (from > 0) every else 0))
            }
        }
        val acked = HashSet<String>()
        j.optJSONArray("acked")?.let { a -> for (i in 0 until minOf(a.length(), 30)) a.optString(i).takeIf { DAY.matches(it) }?.let(acked::add) }
        val before = ArrayList<Int>()
        j.optJSONArray("before")?.let { a -> for (i in 0 until minOf(a.length(), 8)) a.optInt(i).takeIf { it in 1..600 }?.let(before::add) }
        val alarms = ArrayList<AlarmItem>()
        j.optJSONArray("alarms")?.let { a ->
            for (i in 0 until minOf(a.length(), MAX_ALARMS)) {
                val o = a.optJSONObject(i) ?: continue
                val id = o.optString("id"); val day = o.optString("day"); val at = o.optLong("at")
                if (!ALARM_ID.matches(id) || !DAY.matches(day) || at <= 0) continue
                fun hex(k: String, def: String) = o.optString(k).takeIf { HEX.matches(it) } ?: def
                alarms.add(AlarmItem(id, day, at,
                    title = line(o.optString("title"), 30).ifEmpty { "Alarm" },
                    text = line(o.optString("text"), 160),
                    yes = line(o.optString("yes"), 30).ifEmpty { "Acknowledge" },
                    later = line(o.optString("later"), 30).ifEmpty { "Later" },
                    bg = hex("bg", "#2a1a08"), accent = hex("accent", "#f59e0b"), ink = RemInk.inkOr(o.optString("ink"), hex("bg", "#2a1a08")),   // V1.58: never white on a light alarm
                    one = o.optBoolean("one", false), word = line(o.optString("word"), 30)))
            }
        }
        return GymPlan(
            alarms = alarms.sortedBy { it.at },
            on = j.optBoolean("on"),
            time = j.optString("time").takeIf { TIME.matches(it) } ?: "08:00",
            items = items.sortedBy { it.at },
            acked = acked,
            before = before.ifEmpty { listOf(120, 60, 30, 10) },
            ring = j.optInt("ring", 16).coerceIn(1, 600),
            grace = j.optLong("grace", 120_000L).coerceIn(30_000L, 15 * 60_000L),
        )
    }
    fun toJson(p: GymPlan): JSONObject = JSONObject().put("on", p.on).put("time", p.time)
        .put("items", org.json.JSONArray().apply { p.items.forEach { put(JSONObject().put("day", it.day).put("at", it.at).put("end", it.end).put("ring", it.ring).put("from", it.from).put("every", it.every)) } })
        .put("acked", org.json.JSONArray(p.acked.sorted())).put("before", org.json.JSONArray(p.before)).put("ring", p.ring).put("grace", p.grace)
        .put("alarms", org.json.JSONArray().apply { p.alarms.forEach { put(alarmJson(it)) } })
    fun alarmJson(a: AlarmItem): JSONObject = JSONObject().put("id", a.id).put("day", a.day).put("at", a.at).put("title", a.title).put("text", a.text)
        .put("yes", a.yes).put("later", a.later).put("bg", a.bg).put("accent", a.accent).put("ink", a.ink).put("one", a.one).put("word", a.word)

    /** Every step for the days not acknowledged (by the vault or on this phone), soonest first. */
    fun steps(p: GymPlan?, localAcked: Set<String> = emptySet()): List<GymStep> {
        if (p == null || !p.on) return emptyList()
        val out = ArrayList<GymStep>()
        for (g in p.items) {
            if (g.day in p.acked || g.day in localAcked) continue
            if (g.every > 0 && g.from > 0) {
                // Nag mode: every interval from the first reminder until the gym ends (or 1 h 30 after it starts).
                val end = if (g.end > 0) g.end else g.at + 90 * 60_000L
                var t = g.from; var k = 0
                while (t < end && k < 400) { out.add(GymStep("${g.day}:n$k", g.day, g.at, Math.round((g.at - t) / 60_000.0).toInt(), t, false, true, g.every)); t += g.every; k++ }
            } else for (m in p.before) out.add(GymStep("${g.day}:$m", g.day, g.at, m, g.at - m * 60_000L, false, false, p.grace))
            if (g.ring > 0) out.add(GymStep("${g.day}:r", g.day, g.at, Math.round((g.at - g.ring) / 60_000.0).toInt(), g.ring, true, false, RING_GRACE))
            else out.add(GymStep("${g.day}:${p.ring}", g.day, g.at, p.ring, g.at - p.ring * 60_000L, true, false, RING_GRACE))
        }
        return out.sortedBy { it.due }
    }
    private fun graceOf(p: GymPlan, s: GymStep) = if (s.ring) RING_GRACE else if (s.grace > 0) s.grace else p.grace

    /** What fires now: due, within its grace, not fired yet. A ring comes first, then the newest notification only. */
    fun dueNow(p: GymPlan?, now: Long, fired: Set<String>, localAcked: Set<String> = emptySet()): List<GymStep> {
        if (p == null) return emptyList()
        val live = steps(p, localAcked).filter { it.due <= now && now < it.due + graceOf(p, it) }
        // Only the newest of each kind, and only if it has not fired: an older one missed while the phone was off stays missed.
        val ring = live.filter { it.ring }.takeLast(1).filter { it.id !in fired }
        val note = live.filter { !it.ring }.takeLast(1).filter { it.id !in fired }
        return ring + note
    }

    /** Alarm rings due now: on time, at most RING_GRACE late, not rung yet, not acknowledged here. The newest only. */
    fun alarmsDue(p: GymPlan?, now: Long, fired: Set<String>, localAcked: Set<String> = emptySet()): List<AlarmItem> {
        if (p == null) return emptyList()
        return p.alarms.filter { it.at <= now && now < it.at + RING_GRACE && "${it.key}:${it.day}" !in fired && it.ackKey !in localAcked }.takeLast(1)
    }
    /** The next alarm ring still to come, or null. */
    fun nextAlarm(p: GymPlan?, now: Long, fired: Set<String>, localAcked: Set<String> = emptySet()): AlarmItem? =
        p?.alarms?.firstOrNull { it.at > now && "${it.key}:${it.day}" !in fired && it.ackKey !in localAcked }
    fun alarmOf(p: GymPlan?, r: GymRing?): AlarmItem? { val id = r?.alarmId ?: return null; return p?.alarms?.firstOrNull { it.id == id && it.day == r.day } }
    /** The next step still to come (the one alarm to arm), or null. */
    fun next(p: GymPlan?, now: Long, fired: Set<String>, localAcked: Set<String> = emptySet()): GymStep? =
        steps(p, localAcked).firstOrNull { it.due > now && it.id !in fired }

    /** Steps that are over and done with: kept only from yesterday on. */
    fun prune(fired: Set<String>, today: String): Set<String> {
        val y = minusDay(today)
        // Gym steps start with their day; alarm rings ("a:<id>:<day>") end with it.
        return fired.filter { (if (it.startsWith("a:")) it.takeLast(10) else it.take(10)) >= y }.takeLast(120).toSet()
    }
    internal fun minusDay(day: String): String {
        val d = java.time.LocalDate.parse(day).minusDays(1)
        return d.toString()
    }

    /** Is this gym day (its time) still in the plan? A ring or a notice made from an older plan, for a time the saved
     *  gym settings no longer have (the gym moved from the morning to the night), is not followed any more. */
    fun planHas(p: GymPlan?, day: String, at: Long): Boolean = p?.items?.any { it.day == day && it.at == at } == true

    /** A gym day whose time changed in a new plan (moved later the same day, say) is a new step: what already fired for the
     *  old time on that day is forgotten, so the new ring and notices come. Alarm entries ("a:") are not touched. */
    fun forgetMoved(old: GymPlan?, new: GymPlan, fired: Set<String>): Set<String> {
        val moved = new.items.filter { n -> old?.items?.any { it.day == n.day && it.at != n.at } == true && old.items.none { it.day == n.day && it.at == n.at } }.map { it.day }.toSet()
        if (moved.isEmpty()) return fired
        return fired.filterNot { !it.startsWith("a:") && it.take(10) in moved }.toSet()
    }

    /** Where the ring stands. Acknowledge (here, on the Mac: the plan's acked) ends it at any time, ringing or snoozed. */
    fun ringNow(r: GymRing?, p: GymPlan?, now: Long, localAcked: Set<String>, alarmAcked: Set<String> = emptySet()): RingNow = when {
        r == null -> RingNow.NONE
        // An alarm: done once acknowledged here, or once the page's plan no longer has it (acknowledged on the Mac,
        // switched off or removed).
        r.alarmId != null -> if (alarmOf(p, r) == null || "${r.alarmId}:${r.day}" in alarmAcked) RingNow.DONE else ringing(r, now)
        p == null || !p.on || r.day in p.acked || r.day in localAcked || !planHas(p, r.day, r.at) -> RingNow.DONE
        else -> ringing(r, now)
    }
    private fun ringing(r: GymRing, now: Long): RingNow = when {
        r.snoozeAt > 0 && now < r.snoozeAt -> RingNow.SNOOZED
        r.snoozeAt > 0 && now < r.snoozeAt + RING_GRACE -> RingNow.AGAIN
        r.snoozeAt > 0 -> RingNow.MISSED            // the phone was off when Later's ring was due
        now < r.start + RING_FOR -> RingNow.RINGING
        else -> RingNow.MISSED
    }
    /** Later: quiet now, rings again in 5 minutes. */
    fun later(r: GymRing, now: Long) = r.copy(snoozeAt = now + SNOOZE)
    /** Later is over: a new ring, again for at most 10 minutes. */
    fun again(r: GymRing, now: Long) = r.copy(start = now, snoozeAt = 0)
    /** When the ring next needs the alarm: Later's ring, or this ring's 10 minutes being up. */
    fun ringWake(r: GymRing?): Long? = when { r == null -> null; r.snoozeAt > 0 -> r.snoozeAt; else -> r.start + RING_FOR }

    /** "Gym in 2 h", "Gym in 30 min", "Gym time". */
    fun title(at: Long, now: Long): String {
        val left = Math.round((at - now) / 60_000.0).toInt()
        return when {
            left <= 0 -> "Gym time"
            left >= 60 && left % 60 == 0 -> "Gym in ${left / 60} h"
            left > 60 -> "Gym in ${left / 60} h ${left % 60} min"
            else -> "Gym in $left min"
        }
    }
}
