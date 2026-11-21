package com.cincee.ps.gos

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import android.view.Gravity
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The gym reminder on the phone (the developer, 2 Nov 2026). The page hands over a plan (GymClock.kt); from it the
 * shell arms ONE exact alarm at a time, for the next step:
 *  - 2 h, 1 h, 30 min and 10 min before: a notification (one per day, its words move on), with Yes (it said
 *    Acknowledge until V1.57; the developer: the button says "Yes, I'm going").
 *  - 16 min before: it RINGS. A foreground service plays the alarm sound on the alarm volume and buzzes,
 *    and a full screen card (Acknowledge, Later) comes up, over the lock screen too. The developer, 2 Nov 2026:
 *    each ring stops by itself after 10 minutes and leaves a missed-gym notification; Later is quiet for
 *    5 minutes, then it rings again (again for at most 10); Acknowledge (here, on a notification, on the
 *    Mac) ends it at any time, ringing or snoozed. GymClock.ringNow decides, from the ring kept in prefs.
 *  - It is an alarm, so it rings through PS Do Not Disturb: nothing in this file asks Dnd (the Mac's cards
 *    stay quiet under DND, web src/core/gym.ts gymQuiet).
 * Acknowledge is saved in the vault by the page ({type:"gymAck", day}), so the Mac's card goes too. While
 * it rings, the shell asks vault_probe every 20 s (a few hundred bytes): when the vault moved (the Mac's
 * Acknowledge, say), one background check lets the page sync, and its new plan stops the ring.
 * Only times are kept here, never a title: nothing about the developer's day is on the lock screen beyond "Gym".
 *
 * V1.57: nag mode (a notification every 15 minutes from 10:00 until "Yes, I'm going"), a ring time of its own
 * (22:55) and a gym across midnight all come in the plan (GymClock). And the alarms (Settings, Annoying 15 min
 * reminder, Alarms) ring with this same ring: the same service, screen, 10 minutes, Later and missed notice, with
 * the alarm's own title, words, stop button and colours. One ring at a time: a new one takes over and the one it
 * replaces leaves a missed notice. An alarm's Acknowledge goes to the page as the reminder's {type:"remAct"} done
 * for that day, so the Mac's card goes too; the Mac's Acknowledge takes it out of the plan, which ends it here.
 */
object Gym {
    const val NOTE = "gym"
    const val RING = "gym_ring"
    internal const val NOTE_ID = 31
    internal const val RING_ID = 32
    internal const val MISSED_ID = 33
    internal const val SNOOZED_ID = 34
    private const val GOLD = "#F5C542"
    private val main = Handler(Looper.getMainLooper())

    private fun sp(c: Context) = c.getSharedPreferences("gym", Context.MODE_PRIVATE)
    fun plan(c: Context): GymPlan? = GymClock.parse(sp(c).getString("plan", null))
    private fun fired(c: Context): Set<String> = sp(c).getStringSet("fired", emptySet())!!.toSet()
    internal fun local(c: Context): Set<String> = sp(c).getStringSet("acked", emptySet())!!.toSet()
    /** Alarms acknowledged on this phone ("<id>:<day>"), until the page's plan says so too. */
    internal fun alarmLocal(c: Context): Set<String> = sp(c).getStringSet("alarmAcked", emptySet())!!.toSet()
    fun ring(c: Context): GymRing? = sp(c).getString("ringDay", null)?.let {
        GymRing(it, sp(c).getLong("ringAt", 0), sp(c).getLong("ringStart", 0), sp(c).getLong("snoozeAt", 0), sp(c).getString("ringKey", null) ?: GymClock.GYM)
    }
    fun ringDay(c: Context): String? = ring(c)?.day
    fun ringAt(c: Context): Long = ring(c)?.at ?: 0
    private fun now(c: Context, r: GymRing? = ring(c)) = GymClock.ringNow(r, plan(c), System.currentTimeMillis(), local(c), alarmLocal(c))
    fun ringing(c: Context) = now(c) == RingNow.RINGING
    /** The alarm that rings (or waits after Later) now, if it is one: its title, words, button and colours. */
    fun ringAlarm(c: Context): AlarmItem? = GymClock.alarmOf(plan(c), ring(c))
    private fun saveRing(c: Context, r: GymRing) {
        sp(c).edit().putString("ringDay", r.day).putLong("ringAt", r.at).putLong("ringStart", r.start).putLong("snoozeAt", r.snoozeAt).putString("ringKey", r.key).apply()
    }

    // ---------- from the page ----------
    fun setPlan(c: Context, j: JSONObject) {
        val p = runCatching { GymClock.from(j) }.getOrNull() ?: return
        // Days the vault knows are acknowledged no longer need this phone's own copy.
        val keep = local(c).filter { it !in p.acked && it >= GymClock.minusDay(today()) }.toSet()
        val keepAlarms = alarmLocal(c).filter { it.takeLast(10) >= GymClock.minusDay(today()) }.toSet()
        val forgotten = GymClock.forgetMoved(plan(c), p, fired(c))
        sp(c).edit().putStringSet("fired", forgotten).putString("plan", GymClock.toJson(p).toString()).putStringSet("acked", keep).putStringSet("alarmAcked", keepAlarms).apply()
        // 1.60: a reminder or missed notice up for a gym time the saved settings no longer have (moved from morning to
        // night, a day switched off) goes away; the ring and the next alarm are re-worked by check() below.
        sp(c).getString("noteDay", null)?.let { d -> if (d in p.acked || !p.on || !GymClock.planHas(p, d, sp(c).getLong("noteAt", 0))) cancelNote(c) }
        check(c, "plan")   // acknowledged on the Mac: the ring (or Later's wait) ends here
    }

    /** The alarm, a reboot, an update, a new plan or the ring service: settle the ring, fire what is due now
     *  (never late), arm the next. */
    fun check(c: Context, from: String) {
        val p = plan(c)
        val now = System.currentTimeMillis()
        val r = ring(c)
        when (now(c, r)) {
            RingNow.DONE -> { Plog.i("gym: ring over (acknowledged or switched off)"); endRing(c) }
            RingNow.MISSED -> { Plog.i("gym: rang 10 minutes unanswered, missed"); val a = ringAlarm(c); endRing(c); missed(c, r!!, a) }
            RingNow.AGAIN -> { Plog.i("gym: Later is up, ringing again"); startRing(c, GymClock.again(r!!, now)) }
            else -> {}
        }
        var f = fired(c)
        for (s in GymClock.dueNow(p, now, f, local(c))) {
            f = f + s.id
            if (s.ring) startRing(c, GymRing(s.day, s.at, now)) else note(c, s, p!!)
            Plog.i("gym: ${if (s.ring) "ring" else if (s.nag) "nag reminder" else "reminder ${s.mins} min"} ($from)")
        }
        for (a in GymClock.alarmsDue(p, now, f, alarmLocal(c))) {
            f = f + "${a.key}:${a.day}"
            startRing(c, GymRing(a.day, a.at, now, 0, a.key))
            Plog.i("gym: alarm ring ($from)")
        }
        sp(c).edit().putStringSet("fired", GymClock.prune(f, today())).apply()
        arm(c)
    }
    fun restore(c: Context) {
        check(c, "system")
        // Rebooted mid ring: it goes on for what is left of its 10 minutes (Later's wait is armed by check).
        if (ringing(c)) runCatching { c.startForegroundService(Intent(c, GymRingService::class.java)) }
    }

    private fun today() = java.time.LocalDate.now().toString()

    // ---------- the alarm ----------
    private fun alarmIntent(c: Context) = PendingIntent.getBroadcast(c, 3101, Intent(c, GymAlarm::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun arm(c: Context) {
        val am = c.getSystemService(AlarmManager::class.java)
        am.cancel(alarmIntent(c))
        val p = plan(c)
        val n = GymClock.next(p, System.currentTimeMillis(), fired(c), local(c))
        val a = GymClock.nextAlarm(p, System.currentTimeMillis(), fired(c), alarmLocal(c))
        // The ring needs the alarm too: Later's ring again, or its 10 minutes being up.
        val r = ring(c)
        val w = GymClock.ringWake(r)
        val (due, ringing) = listOfNotNull(n?.let { it.due to it.ring }, a?.let { it.at to true }, w?.let { it to (r!!.snoozeAt > 0) }).minByOrNull { it.first } ?: return
        val at = due.coerceAtLeast(System.currentTimeMillis() + 1000)
        // A ring is a real alarm clock (the system keeps it exact through Doze and shows the alarm icon);
        // the rest use the same exact alarms as the 10 minute call alerts.
        if (ringing && am.canScheduleExactAlarms()) am.setAlarmClock(AlarmManager.AlarmClockInfo(at, Notifier.openIntent(c, "fitness", 3102)), alarmIntent(c))
        else if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent(c))
        else am.setWindow(AlarmManager.RTC_WAKEUP, at, 60_000, alarmIntent(c))
    }

    // ---------- the four reminders ----------
    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)
    private fun can(c: Context) = c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    const val YES = "Yes, I'm going"
    private fun ackIntent(c: Context, day: String, key: String = GymClock.GYM) = PendingIntent.getBroadcast(c, Notifier.nid("gymack$key$day"),
        Intent(c, GymAction::class.java).putExtra("day", day).putExtra("key", key), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun note(c: Context, s: GymStep, p: GymPlan) {
        if (!can(c)) return
        val item = p.items.firstOrNull { it.day == s.day }
        val ringAt = item?.ring?.takeIf { it > 0 } ?: (s.at - p.ring * 60_000L)
        val n = Notification.Builder(c, NOTE)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(GOLD))
            .setContentTitle(if (s.nag) "Going to the gym today?" else GymClock.title(s.at, System.currentTimeMillis()))
            .setContentText(if (s.nag) "Gym at ${hm(s.at)}. Your phone rings at ${hm(ringAt)} unless you say Yes." else "At ${hm(s.at)}. Your phone rings at ${hm(ringAt)}.")
            .setWhen(s.at).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(false)
            .setTimeoutAfter(((item?.end?.takeIf { it > 0 } ?: (s.at + 90 * 60_000L)) - System.currentTimeMillis()).coerceAtLeast(60_000L))
            .setContentIntent(Notifier.openIntent(c, "fitness", 3103))
            .addAction(Notification.Action.Builder(null, YES, ackIntent(c, s.day)).build())
            .setGroup("gym")
            .build()
        sp(c).edit().putString("noteDay", s.day).putLong("noteAt", s.at).apply()
        nm(c).notify(NOTE_ID, n)
    }
    private fun cancelNote(c: Context) { nm(c).cancel(NOTE_ID); nm(c).cancel(MISSED_ID); sp(c).edit().remove("noteDay").remove("noteAt").apply() }
    private fun missedId(key: String) = if (key == GymClock.GYM) MISSED_ID else Notifier.nid("alarm-missed-$key")
    private fun hm(at: Long) = java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)

    /** It rang 10 minutes and nobody answered (or another ring took over): one notification that stays, with its Yes. */
    private fun missed(c: Context, r: GymRing, a: AlarmItem?) {
        if (!can(c)) return
        val alarm = r.alarmId != null
        val n = Notification.Builder(c, NOTE)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(colour(a?.accent, GOLD))
            .setContentTitle(if (alarm) "Missed alarm" else "Missed gym alarm")
            .setContentText(if (alarm) "${a?.title ?: "Alarm"} at ${hm(r.at)}. It rang for 10 minutes." else "Gym at ${hm(r.at)}. It rang for 10 minutes.")
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(Notifier.openIntent(c, if (alarm) "list" else "fitness", 3105))
            .addAction(Notification.Action.Builder(null, if (alarm) a?.yes ?: "Acknowledge" else YES, ackIntent(c, r.day, r.key)).build())
            .setGroup("gym")
            .build()
        if (!alarm) sp(c).edit().putString("noteDay", r.day).putLong("noteAt", r.at).apply()
        nm(c).notify(missedId(r.key), n)
    }
    private fun colour(hex: String?, def: String) = runCatching { Color.parseColor(hex ?: def) }.getOrDefault(Color.parseColor(def))

    // ---------- the ring ----------
    private fun startRing(c: Context, r: GymRing) {
        // One ring at a time: another one still ringing or waiting after Later gives way and leaves a missed notice.
        val old = ring(c)
        if (old != null && (old.key != r.key || old.day != r.day) && now(c, old) in setOf(RingNow.RINGING, RingNow.SNOOZED, RingNow.AGAIN)) {
            Plog.i("gym: a new ring takes over, the one before is missed")
            missed(c, old, GymClock.alarmOf(plan(c), old))
        }
        saveRing(c, r)
        nm(c).cancel(SNOOZED_ID)
        runCatching { c.startForegroundService(Intent(c, GymRingService::class.java)) }.onFailure {
            // The exact alarm lets PS start the service; if the system refuses anyway, the card and one long buzz still come.
            Plog.i("gym: no ring service (${it.javaClass.simpleName}), notification only")
            if (can(c)) nm(c).notify(RING_ID, ringNotice(c))
            Buzz.once(c)
        }
        RingScreen.bring(c, GymRingActivity::class.java, RING, "gym")   // 1.72: the card at once, over other apps and the lock screen
    }
    /** Quiet now: no sound, no ring card. The ring itself is kept (Later). */
    private fun silence(c: Context) {
        c.stopService(Intent(c, GymRingService::class.java))
        nm(c).cancel(RING_ID)
        GymRingActivity.closeAll()
    }
    /** The ring is over: acknowledged, switched off, or missed. */
    fun endRing(c: Context) {
        sp(c).edit().remove("ringDay").remove("ringAt").remove("ringStart").remove("snoozeAt").apply()
        silence(c)
        nm(c).cancel(SNOOZED_ID)
    }

    /** Later (the ring card or its notification): quiet for 5 minutes, then it rings again. */
    fun later(c: Context, from: String) {
        val r = ring(c) ?: return
        if (!ringing(c)) return
        val a = ringAlarm(c)
        val s = GymClock.later(r, System.currentTimeMillis())
        saveRing(c, s)
        silence(c)
        // On the ring's channel: no sound and no buzz of its own, so the wait itself is quiet.
        if (can(c)) nm(c).notify(SNOOZED_ID, Notification.Builder(c, RING)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(colour(a?.accent, GOLD))
            .setContentTitle(if (a != null) "${a.title} again in 5 minutes" else "Gym alarm in 5 minutes")
            .setContentText(if (a != null) "Rings again at ${hm(s.snoozeAt)}." else "Gym at ${hm(r.at)}. Rings again at ${hm(s.snoozeAt)}.")
            .setCategory(Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true).setOngoing(true)
            .setContentIntent(Notifier.openIntent(c, if (a != null) "list" else "fitness", 3106))
            .addAction(Notification.Action.Builder(null, a?.yes ?: YES, ackIntent(c, r.day, r.key)).build())
            .setGroup("gym").build())
        arm(c)
        Plog.i("gym: Later, rings again in 5 minutes ($from)")
    }

    /** The full screen card while it rings (over the lock screen; "Gym" and the time only). */
    fun ringNotice(c: Context): Notification {
        val time = hm(ringAt(c))
        val full = PendingIntent.getActivity(c, 3104, Intent(c, GymRingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val day = ringDay(c) ?: today()
        val r = ring(c)
        val a = ringAlarm(c)
        return Notification.Builder(c, RING)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(colour(a?.accent, GOLD))
            .setContentTitle(if (a != null) "${a.title} at $time" else "Gym at $time")
            .setContentText(if (a != null && a.text.isNotEmpty()) a.text else "Rings up to 10 minutes. Later: again in 5.")
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true).setOnlyAlertOnce(true)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(Notification.Action.Builder(null, a?.yes ?: YES, ackIntent(c, day, r?.key ?: GymClock.GYM)).build())
            .addAction(Notification.Action.Builder(null, a?.later ?: "Later", laterIntent(c)).build())
            .build()
    }
    private fun laterIntent(c: Context) = PendingIntent.getBroadcast(c, 3107, Intent(c, GymAction::class.java).putExtra("op", "later"),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** Acknowledge (or "Yes, I'm going") on this phone, for the gym or an alarm by its key. */
    fun ack(c: Context, day: String, key: String, from: String) {
        if (key.startsWith("a:")) ackAlarm(c, key.substring(2), day, from) else ack(c, day, from)
    }
    /** An alarm's Acknowledge: quiet here at once, then the reminder's "done" for that day in the vault (the Mac's card goes). */
    fun ackAlarm(c: Context, id: String, day: String, from: String) {
        if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(day) || !Regex("""^[a-z0-9]{1,16}$""").matches(id)) return
        sp(c).edit().putStringSet("alarmAcked", alarmLocal(c) + "$id:$day").apply()
        val r = ring(c)
        if (r?.alarmId == id && r.day == day) endRing(c)
        nm(c).cancel(missedId("a:$id"))
        arm(c)
        Plog.i("gym: alarm acknowledged ($from)")
        val o = JSONObject().put("type", "remAct").put("id", id).put("act", "done").put("day", day).put("at", System.currentTimeMillis()).put("by", "phone")
        if (WebHost.unlocked) WebHost.post(o)
        else {
            // Kept like a reminder's answer (Receivers.flushPending sends it once the page runs), the newest per alarm.
            val p = c.getSharedPreferences("pending", Context.MODE_PRIVATE)
            val kept = p.getStringSet("rem", emptySet())!!.filterNot { s -> runCatching { JSONObject(s).optString("id") == id }.getOrDefault(true) }
            p.edit().putStringSet("rem", (kept + o.toString()).toSet()).apply()
            Reminds.saveSoon(c)
        }
    }
    /** Yes on this phone (the ring card or a notification): quiet here at once, then saved in the vault. */
    fun ack(c: Context, day: String, from: String) {
        if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(day)) return
        sp(c).edit().putStringSet("acked", local(c) + day).apply()
        endRing(c)
        cancelNote(c)
        arm(c)
        Plog.i("gym: acknowledged ($from)")
        if (WebHost.unlocked) WebHost.post(JSONObject().put("type", "gymAck").put("day", day))
        else {
            val p = c.getSharedPreferences("pending", Context.MODE_PRIVATE)
            p.edit().putStringSet("gym", p.getStringSet("gym", emptySet())!! + day).apply()
            Reminds.saveSoon(c)   // a background check soon carries it to the vault, so the Mac card goes too
        }
    }

    /** While it rings and the screen is off: one background check when the vault moved (see the header). */
    fun syncSoon(c: Context) {
        if (!Prefs.background(c)) return
        WorkManager.getInstance(c).enqueueUniqueWork("ps-gym-sync", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<PulseWorker>().setInputData(workDataOf("force" to true)).build())
    }

    /** No ring service: one long buzz at least (alarm vibration ignores silent mode). */
    object Buzz {
        private val PATTERN = longArrayOf(0, 900, 300, 900, 300, 900, 300, 1400)
        fun once(c: Context) = runCatching {
            c.getSystemService(VibratorManager::class.java).defaultVibrator
                .vibrate(VibrationEffect.createWaveform(PATTERN, -1), VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
        }
        fun loop(c: Context) = runCatching {
            c.getSystemService(VibratorManager::class.java).defaultVibrator
                .vibrate(VibrationEffect.createWaveform(longArrayOf(0, 900, 600), 1), VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
        }
        fun stop(c: Context) = runCatching { c.getSystemService(VibratorManager::class.java).defaultVibrator.cancel() }
    }
}

/** Plays the ring until Acknowledge, Later or its 10 minutes are up. Started by the gym alarm (an exact alarm may start a foreground service). */
class GymRingService : Service() {
    private val h = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private val bg = Executors.newSingleThreadExecutor()
    private var lastProbe: String? = null
    private val poll = object : Runnable {
        override fun run() {
            val c = this@GymRingService
            if (!Gym.ringing(c)) { Gym.check(c, "ring"); return }
            bg.execute {
                val p = Pulse.probe(c)
                if (p != null && lastProbe != null && p != lastProbe) h.post { Gym.syncSoon(c) }
                if (p != null) lastProbe = p
            }
            h.postDelayed(this, 20_000)
        }
    }

    /** Its 10 minutes are up: check ends it and leaves the missed notification (the exact alarm does too). */
    private val end = Runnable { Gym.check(this, "ring") }

    override fun onBind(i: Intent?): IBinder? = null
    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        val r = Gym.ring(this)
        if (r == null || !Gym.ringing(this)) { stopSelf(); return START_NOT_STICKY }
        startForeground(Gym.RING_ID, Gym.ringNotice(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (player == null) play()
        h.removeCallbacks(poll); h.postDelayed(poll, 20_000)
        h.removeCallbacks(end); h.postDelayed(end, (r.start + GymClock.RING_FOR - System.currentTimeMillis()).coerceAtLeast(0) + 500)
        return START_STICKY
    }
    private fun play() {
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        player = runCatching {
            MediaPlayer().apply { setAudioAttributes(attrs); setDataSource(this@GymRingService, uri); isLooping = true; prepare(); start() }
        }.getOrNull() ?: runCatching { MediaPlayer.create(this, R.raw.rest_over, attrs, 0)?.apply { isLooping = true; start() } }.getOrNull()
        if (player == null) Plog.i("gym: no ring sound, buzz only")
        Gym.Buzz.loop(this)
    }
    override fun onDestroy() {
        h.removeCallbacks(poll); h.removeCallbacks(end)
        runCatching { player?.stop(); player?.release() }
        player = null
        Gym.Buzz.stop(this)
        bg.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

/** The gym alarm: whatever step is due now. */
class GymAlarm : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { Gym.check(c.applicationContext, "alarm") }
}
/** Acknowledge on a gym notification or on the ring's notification; Later on the ring's notification. */
class GymAction : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.getStringExtra("op") == "later") Gym.later(c.applicationContext, "notification")
        else Gym.ack(c.applicationContext, i.getStringExtra("day") ?: return, i.getStringExtra("key") ?: GymClock.GYM, "notification")
    }
}

/** The full screen card while it rings: over the lock screen, the screen turned on, a big Yes (or the alarm's own button) and Later. */
class GymRingActivity : ComponentActivity() {
    companion object {
        private val open = HashSet<GymRingActivity>()
        fun closeAll() { open.toList().forEach { it.finish() } }
    }
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setShowWhenLocked(true); setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        open.add(this)
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()
        val at = Gym.ringAt(this)
        val time = java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)
        // The gym's gold look, or the alarm's own (V1.57): its title in the orb, its words, its stop button, its colours.
        val key = Gym.ring(this)?.key ?: GymClock.GYM
        val a = Gym.ringAlarm(this)
        fun col(hex: String?, def: String) = runCatching { Color.parseColor(hex ?: def) }.getOrDefault(Color.parseColor(def))
        val bg = col(a?.bg, "#0B0C0E")
        val accent = col(a?.accent, "#F5C542")
        // V1.58: an alarm's words, smaller words and the words on its accent come from its background and accent
        // (RemInk), so a light alarm (Paper, white, cream) reads like a dark one.
        val look = a?.let { RemInk.alarm(it.bg, it.accent, it.ink) }
        val ink = if (look != null) col(look.ink, "#F4F6F2") else Color.parseColor("#F4F6F2")
        val soft = if (look != null) col(look.sub, "#F4F6F2") else Color.parseColor("#FFE7A3")
        val onAcc = if (look != null) col(look.on, "#0B0C0E") else Color.parseColor("#0B0C0E")
        val hintInk = if (look != null) col(look.hint, "#F4F6F2") else (ink and 0x00FFFFFF) or (0x9E shl 24)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setBackgroundColor(bg); setPadding(dp(28), dp(40), dp(28), dp(40))
        }
        val orbText = a?.title?.uppercase() ?: "GYM"
        val orb = TextView(this).apply {
            text = orbText; textSize = if (orbText.length <= 4) 22f else if (orbText.length <= 9) 16f else 12f
            typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER; letterSpacing = .2f; maxLines = 3
            setTextColor(onAcc); setPadding(dp(10), dp(10), dp(10), dp(10))
            background = GradientDrawable().apply {
                if (a != null) { setColor(accent) } else { colors = intArrayOf(Color.parseColor("#FFE08A"), Color.parseColor("#F5C542"), Color.parseColor("#C9971C")) }
                shape = GradientDrawable.OVAL
            }
            layoutParams = LinearLayout.LayoutParams(dp(132), dp(132))
        }
        val big = TextView(this).apply {
            text = time; textSize = 64f; typeface = Typeface.create(Typeface.DEFAULT, 900, false); gravity = Gravity.CENTER
            setTextColor(ink); setPadding(0, dp(28), 0, 0)
        }
        val sub = TextView(this).apply {
            text = if (a != null) a.text else GymClock.title(at, System.currentTimeMillis()); textSize = 20f; gravity = Gravity.CENTER
            setTextColor(soft); setPadding(0, dp(4), 0, dp(40))
        }
        val ack = Button(this).apply {
            text = a?.yes ?: Gym.YES; isAllCaps = false; textSize = 22f; typeface = Typeface.DEFAULT_BOLD; setTextColor(onAcc)
            stateListAnimator = null
            background = GradientDrawable().apply { setColor(accent); cornerRadius = 99 * d }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(76))
            setOnClickListener {
                performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
                Gym.ack(applicationContext, Gym.ringDay(applicationContext) ?: java.time.LocalDate.now().toString(), key, "ring")
                finish()
            }
        }
        val later = Button(this).apply {
            text = a?.later ?: "Later"; isAllCaps = false; textSize = 19f; typeface = Typeface.DEFAULT_BOLD; setTextColor(soft)
            stateListAnimator = null
            background = GradientDrawable().apply { setColor(Color.TRANSPARENT); setStroke(dp(2), accent); cornerRadius = 99 * d }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(60)).apply { topMargin = dp(14) }
            setOnClickListener {
                performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
                Gym.later(applicationContext, "ring")
                finish()
            }
        }
        val hint = TextView(this).apply {
            text = if (a != null) "${a.yes} stops it here and on your Mac. ${a.later} rings again in 5 minutes."
                else "${Gym.YES} stops it here and on your Mac. Later rings again in 5 minutes."
            textSize = 14f; gravity = Gravity.CENTER
            setTextColor(hintInk); setPadding(0, dp(14), 0, 0)
        }
        listOf(orb, big, sub, ack, later, hint).forEach(root::addView)
        setContentView(root)
        // Back leaves the card; the ring goes on until Acknowledge, Later or its 10 minutes (the notification has both buttons).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { finish() } })
        orb.scaleX = .6f; orb.scaleY = .6f; orb.alpha = 0f
        orb.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(520).setInterpolator(OvershootInterpolator(1.6f)).start()
        breathe(orb)
    }
    private fun breathe(v: android.view.View) {
        v.animate().scaleX(1.06f).scaleY(1.06f).setStartDelay(600).setDuration(700).withEndAction {
            v.animate().scaleX(1f).scaleY(1f).setStartDelay(0).setDuration(700).withEndAction { if (!isFinishing) breathe(v) }.start()
        }.start()
    }
    override fun onResume() { super.onResume(); if (!Gym.ringing(this)) finish() }
    override fun onDestroy() { open.remove(this); super.onDestroy() }
}

