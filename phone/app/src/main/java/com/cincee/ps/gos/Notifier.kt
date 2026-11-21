package com.cincee.ps.gos

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Notifications on this phone only (Rule Zero: nothing is ever sent to anyone). Client emails and
 * call alerts come from the same card logic as PS on the Mac (src/mailcards.ts, meetwatch.ts). On
 * the lock screen only a plain line shows ("New client email"), never a name or text.
 */
object Notifier {
    const val MAIL = "mail"
    const val CALLS = "calls"
    const val QUIET = "ps"
    // V1.33: the update notice is quiet (no sound, no pop up) and comes once per version. Android does not
    // let an app lower a channel it made, so it is a new channel and the old loud one goes.
    const val UPDATES = "updates-quiet"
    private const val OLD_UPDATES = "updates"
    const val CHATS = "chats"
    /** G Squad messages (PS 1.60, web core/squadnotify.ts): a card for each message from someone else. */
    const val SQUAD = "squad-messages"

    fun channels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(OLD_UPDATES) != null) nm.deleteNotificationChannel(OLD_UPDATES)
        nm.createNotificationChannels(listOf(
            NotificationChannel(MAIL, "Client emails", NotificationManager.IMPORTANCE_HIGH).apply { description = "A client wrote to you. Stays until you dismiss it."; lightColor = Color.parseColor("#EC4E86"); enableLights(true) },
            NotificationChannel(CALLS, "Calls and meetings", NotificationManager.IMPORTANCE_HIGH).apply { description = "Booked, declined, a lead messaged about a call, and 10 minutes before." },
            NotificationChannel(QUIET, "PS list", NotificationManager.IMPORTANCE_MIN).apply { description = "The quiet line that opens your list."; setShowBadge(false) },
            NotificationChannel(UPDATES, "Updates", NotificationManager.IMPORTANCE_LOW).apply { description = "A quiet note when a new PS app is out. It installs only when you tap Update now."; setShowBadge(true) },
            NotificationChannel(SQUAD, "G Squad messages", NotificationManager.IMPORTANCE_HIGH).apply { description = "Someone wrote in G Squad. The lock screen only says there is a new message." },
            NotificationChannel(CHATS, "Claude chats", NotificationManager.IMPORTANCE_HIGH).apply { description = "A Claude Code chat on your Mac just finished. Its name only." },
            // The gym reminder (Gym.kt): 2 h, 1 h, 30 and 10 min before, and the ring (its sound comes from the ring service).
            NotificationChannel(Gym.NOTE, "Gym reminder", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "2 hours, 1 hour, 30 and 10 minutes before gym time, and a missed gym alarm. Acknowledge stops the ring."; lightColor = Color.parseColor("#F5C542"); enableLights(true) },
            NotificationChannel(Gym.RING, "Gym alarm", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Rings 16 minutes before gym time, up to 10 minutes. Later rings again in 5."; setSound(null, null); enableVibration(false); setBypassDnd(false) },
            // Fitness (Fitness.kt): PS makes the buzz and the chime itself, so both channels are silent.
            NotificationChannel(Fitness.REST, "Rest timer", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "The countdown between sets, on the lock screen, with +15 s and Skip."; setSound(null, null); enableVibration(false); setShowBadge(false) },
            NotificationChannel(Fitness.OVER, "Rest over", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Time for the next set. PS app buzzes (even on silent) and chimes (not on silent)."; setSound(null, null); enableVibration(false) },
            // Sleep mode (Sleep.kt): the quiet line for the night, the alarm (its sound comes from the service), and the
            // silent full screen notice that brings the clock back over the lock screen after the power button.
            NotificationChannel(Sleep.ON, "Sleep mode", NotificationManager.IMPORTANCE_LOW).apply {
                description = "A quiet line while Sleep mode is on. Tap it for the clock."; setSound(null, null); enableVibration(false); setShowBadge(false) },
            NotificationChannel(Sleep.RING, "Sleep mode alarm", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Your Sleep mode alarms. They ring up to 10 minutes, even with PS app Do Not Disturb on."; setSound(null, null); enableVibration(false) },
            NotificationChannel(Sleep.BRK, "Sleep mode break", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Asks \"Go back to sleep?\" when a short break in the night is up. A short buzz, no sound."; setSound(null, null); enableVibration(true); vibrationPattern = longArrayOf(0, 180) },
            NotificationChannel(Sleep.BACK, "Sleep mode clock", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Brings the clock back over the lock screen after you press the power button. Silent."; setSound(null, null); enableVibration(false); setShowBadge(false) },
            // The Annoying 15 min reminder (Remind.kt): PS plays each reminder's own sound itself, so the channel is silent.
            NotificationChannel(Remind.RING_CH, "Reminder ring", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A reminder rings like an alarm for a minute and shows a full screen card. PS plays the sound itself."; setSound(null, null); enableVibration(false); setBypassDnd(false) },
            // PS 1.70 the day countdown while PS is closed (DayEnd.kt): End day now? and the time left reminders.
            NotificationChannel(DayEnd.CH, "Day countdown", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "End day now? when your day reaches zero, and how much of your day is left." },
            NotificationChannel(Remind.CH, "Annoying reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Pops up from its start time until you confirm it. Remind me in, or swiping it away, brings it back later."; setSound(null, null); enableVibration(true) },
            // The Soundboard's timed plays (Soundboard.kt): PS plays the file itself on the alarm stream, so the channel is silent.
            NotificationChannel(Soundboard.RING, "Soundboard timed plays", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A sound or video you set to play at a time of day. Stop ends it; a loop stops by itself after 10 minutes."; setSound(null, null); enableVibration(false) },
        ))
    }

    fun nid(id: String) = (id.hashCode() and 0x3fffffff) or 0x40000000
    private fun can(c: Context) = c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED

    fun openIntent(c: Context, what: String = "list", req: Int = 0): PendingIntent =
        PendingIntent.getActivity(c, req, Intent(c, MainActivity::class.java).putExtra("open", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** What this phone already showed, kept across restarts (NoteLedger.kt). Written with commit() before
     *  the notification is posted, so a crash or a restart in between can never show it twice. */
    private var ledger: NoteLedger? = null
    @Synchronized private fun ledger(c: Context): NoteLedger = ledger ?: c.getSharedPreferences("notes", Context.MODE_PRIVATE).let { sp ->
        NoteLedger({ sp.getString("shown", null) }, { sp.edit().putString("shown", it).commit() })
    }.also { ledger = it }
    private fun showing(c: Context, id: String) =
        runCatching { c.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == id && it.id == nid(id) } }.getOrDefault(false)

    /** A card from the page: {id, rev, tone, title, sub, body, url, discreetText}. Off the main thread (the
     *  bridge thread, or the work thread for the shell's own call alarms): it reads and writes the ledger
     *  and asks the system what is in the shade. */
    fun card(c: Context, card: JSONObject) {
        if (!can(c)) return
        val id = card.optString("id").take(40).ifEmpty { return }
        // Do Not Disturb (Dnd below): the page holds its own cards; this catches the shell's call alarms too.
        if (Dnd.mutes(c, Dnd.kind(id))) return
        // Client emails, lead replies and finished chats ("m:", "n:", "c:", re-sent by the page until dismissed):
        // shown before, replace it quietly if it is still in the shade, else leave it gone (a repeat from the
        // page's minute resync, a background check or a restart). A new revision shows, with sound. Meeting
        // cards and the shell's call alarms keep their own once-only memory (meetalerts.ts, the alarm), and a
        // snoozed card comes back under the same id, so they are left as before.
        val quiet = if (id.startsWith("m:") || id.startsWith("n:") || id.startsWith("c:") || id.startsWith("g:")) {
            val rev = card.optString("rev").ifEmpty { card.optString("at") }.takeIf { it != "null" } ?: ""
            val act = ledger(c).decide(id, rev, showing(c, id), System.currentTimeMillis())
            if (act == NoteLedger.Act.SKIP) return
            act == NoteLedger.Act.UPDATE
        } else true
        if (id.startsWith("c:")) return chat(c, id, card, quiet)
        if (id.startsWith("g:")) return squad(c, id, card, quiet)
        // "n:" an Instantly reply from a lead (src/core/leadcards.ts): like a client email, Remind me in and Dismiss.
        val lead = id.startsWith("n:")
        val mail = id.startsWith("m:") || lead
        val discreet = card.optString("discreetText").ifEmpty { if (lead) "New lead reply" else if (mail) "New client email" else "PS app" }
        // During a call the phone shows only the plain line, like the Mac's discreet cards.
        val inCall = Ays.inMeeting
        val title = if (inCall) discreet else card.optString("title")
        val text = if (inCall) "" else listOf(card.optString("sub"), card.optString("body")).filter { it.isNotBlank() && it != "null" }.joinToString("\n")
        val pub = Notification.Builder(c, if (mail) MAIL else CALLS).setSmallIcon(R.drawable.ic_stat_ps).setContentTitle(discreet).setColor(Color.parseColor("#EC4E86")).build()
        val b = Notification.Builder(c, if (mail) MAIL else CALLS)
            .setSmallIcon(R.drawable.ic_stat_ps)
            .setColor(Color.parseColor("#EC4E86"))
            .setContentTitle(title)
            .setContentText(text.lineSequence().firstOrNull() ?: "")
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(pub)
            .setOnlyAlertOnce(quiet)
            .setAutoCancel(!mail)
            .setCategory(if (mail) Notification.CATEGORY_EMAIL else Notification.CATEGORY_EVENT)
            .setContentIntent(openIntent(c, "inbox", nid(id)))
            .setGroup(if (mail) "mail" else "calls")
        // Swiped away (or Clear all) = Dismiss, on every device, as on the Mac's stack and the chat cards. Without
        // it a swipe only left this shade: the vault never heard, the Mac kept the card, and the next revision of it
        // (a remind coming due) brought it back here too (3 Nov 2026).
        if (NoteLedger.swipeDismisses(id)) b.setDeleteIntent(Receivers.cardAction(c, id, "dismiss"))
        card.optString("callAt").takeIf { it.isNotBlank() && it != "null" }?.let { at ->
            runCatching { java.time.Instant.parse(at).toEpochMilli() }.getOrNull()?.let { b.setWhen(it).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true) }
        }
        // "Remind me in 15 mins": the card goes away on every device and comes back then (Reminds below).
        if (mail) b.addAction(Notification.Action.Builder(null, "Remind me in 15 mins", Receivers.cardAction(c, id, "remind")).build())
        if (mail) b.addAction(Notification.Action.Builder(null, "Dismiss", Receivers.cardAction(c, id, "dismiss")).build())
        // Join (a call link) and Open (the Gmail thread) open in their own apps. Opening is not sending.
        for ((k, label) in listOf("join" to "Join", "url" to "Open")) {
            val u = card.optString(k)
            if (u.startsWith("https://")) b.addAction(Notification.Action.Builder(null, label,
                PendingIntent.getActivity(c, nid(id + k), Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)).build())
        }
        c.getSystemService(NotificationManager::class.java).notify(id, nid(id), b.build())
        timing(quiet)
    }
    /** A G Squad message (PS 1.60): the sender's name and the words only behind the unlock, "New G Squad message" on the lock screen
     *  (no words, no name). Open and Reply both open the G Squad chat, where the box is; a swipe or Dismiss is the Dismiss on every
     *  device (the page saves a "seen up to here" mark). The page already holds the card back while Do Not Disturb is on. */
    private fun squad(c: Context, id: String, card: JSONObject, quiet: Boolean) {
        val discreet = card.optString("discreetText").ifEmpty { "New G Squad message" }
        val title = if (Ays.inMeeting) discreet else card.optString("title")
        val text = if (Ays.inMeeting) "" else card.optString("body").takeIf { it != "null" } ?: ""
        val pub = Notification.Builder(c, SQUAD).setSmallIcon(R.drawable.ic_stat_ps).setContentTitle(discreet).setColor(Color.parseColor("#2DD4BF")).build()
        val b = Notification.Builder(c, SQUAD)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#2DD4BF"))
            .setContentTitle(title).setContentText(text.lineSequence().firstOrNull() ?: "")
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(pub)
            .setOnlyAlertOnce(quiet).setAutoCancel(true).setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(c, "gsquad", nid(id)))
            .setGroup("squad")
            .setDeleteIntent(Receivers.cardAction(c, id, "dismiss"))
        b.addAction(Notification.Action.Builder(null, "Open", openIntent(c, "gsquad", nid(id + "open"))).build())
        b.addAction(Notification.Action.Builder(null, "Reply", openIntent(c, "gsquad", nid(id + "reply"))).build())
        b.addAction(Notification.Action.Builder(null, "Dismiss", Receivers.cardAction(c, id, "dismiss")).build())
        c.getSystemService(NotificationManager::class.java).notify(id, nid(id), b.build())
        timing(quiet)
    }
    /** V1.59: how long a new card took from the live link's signal to the shade (logcat "PSGOS", no names). */
    private fun timing(quiet: Boolean) {
        val at = LiveLink.lastSignalAt
        val ms = android.os.SystemClock.elapsedRealtime() - at
        if (!quiet && at > 0 && ms < 120_000) Plog.i("live: notification shown $ms ms after the signal")
    }
    /** A Claude Code chat finished (src/core/chatdone.ts): its name, Dismiss clears it on the Mac too. */
    private fun chat(c: Context, id: String, card: JSONObject, quiet: Boolean) {
        val name = if (Ays.inMeeting) "A Claude chat finished" else card.optString("title")
        val pub = Notification.Builder(c, CHATS).setSmallIcon(R.drawable.ic_stat_ps).setContentTitle("A Claude chat finished").setColor(Color.parseColor("#D97757")).build()
        val b = Notification.Builder(c, CHATS)
            .setSmallIcon(R.drawable.ic_stat_ps)
            .setColor(Color.parseColor("#D97757"))
            .setContentTitle(name)
            .setContentText(if (Ays.inMeeting) "" else card.optString("sub"))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(pub)
            .setOnlyAlertOnce(quiet)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setContentIntent(openIntent(c, "list", nid(id)))
            .setDeleteIntent(Receivers.cardAction(c, id, "dismiss"))
            .setGroup("chats")
            .addAction(Notification.Action.Builder(null, "Dismiss", Receivers.cardAction(c, id, "dismiss")).build())
        var at = System.currentTimeMillis()
        card.optString("at").takeIf { it.isNotBlank() && it != "null" }?.let { s ->
            runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()?.let { at = it; b.setWhen(it).setShowWhen(true) }
        }
        c.getSystemService(NotificationManager::class.java).notify(id, nid(id), b.build())
        timing(quiet)
        chatSummary(c, posted = ChatGroup.Row(id, name, if (Ays.inMeeting) "" else card.optString("sub"), at))
    }

    /** V1.56: finished chats bundle under one summary from two up (ChatGroup.kt), as the Mac's one bubble. Each chat is
     *  still its own notification, so a swipe on one dismisses only that chat; under two chats the summary goes. */
    private fun chatSummary(c: Context, posted: ChatGroup.Row? = null, gone: String? = null) {
        val nm = c.getSystemService(NotificationManager::class.java)
        val shade = runCatching {
            nm.activeNotifications.mapNotNull { n ->
                val tag = n.tag ?: return@mapNotNull null
                if (n.notification.channelId != CHATS || !tag.startsWith("c:")) return@mapNotNull null
                val x = n.notification.extras
                ChatGroup.Row(tag, x.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: "", x.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "", n.notification.`when`)
            }
        }.getOrDefault(emptyList())
        val s = ChatGroup.summary(ChatGroup.rows(shade, posted, gone), Ays.inMeeting)
        if (s == null) { runCatching { nm.cancel(ChatGroup.TAG, ChatGroup.ID) }; return }
        val pub = Notification.Builder(c, CHATS).setSmallIcon(R.drawable.ic_stat_ps).setContentTitle(s.title).setColor(Color.parseColor("#D97757")).build()
        val style = Notification.InboxStyle().setBigContentTitle(s.title)
        s.lines.forEach { style.addLine(it) }
        val b = Notification.Builder(c, CHATS)
            .setSmallIcon(R.drawable.ic_stat_ps)
            .setColor(Color.parseColor("#D97757"))
            .setContentTitle(s.title)
            .setContentText(s.text)
            .setStyle(style)
            .setGroup("chats")
            .setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)   // the chats chime, the summary never does
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(pub)
            .setCategory(Notification.CATEGORY_STATUS)
            .setContentIntent(openIntent(c, "list", ChatGroup.ID))
        nm.notify(ChatGroup.TAG, ChatGroup.ID, b.build())
    }

    fun cancelCard(c: Context, id: String) {
        c.getSystemService(NotificationManager::class.java).cancel(id.take(40), nid(id.take(40)))
        if (id.startsWith("c:")) runCatching { chatSummary(c, gone = id.take(40)) }
    }

    fun updated(c: Context, version: String) {
        if (!can(c)) return
        c.getSystemService(NotificationManager::class.java).cancel("update", 7)
        val n = Notification.Builder(c, UPDATES).setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#EC4E86"))
            .setContentTitle("PS app $version${if (BuildConfig.KEYWORD.isNotBlank()) " · ${BuildConfig.KEYWORD}" else ""} is installed").setContentText("Tap to open PS app.")
            .setContentIntent(openIntent(c, "list", 8)).setAutoCancel(true).setTimeoutAfter(10 * 60_000).build()
        c.getSystemService(NotificationManager::class.java).notify("updated", 8, n)
    }

    /** PS 1.72 (the developer: after an update the old icon lingered on the notifications; RepostCore.kt has the rules): right
     *  after an update every PS notification still showing is posted again by this build, silently (no sound, no buzz,
     *  no pop up), with this build's icon, so the shade and the status bar show the new picture at once. */
    fun repostAfterUpdate(c: Context) {
        if (!can(c)) return
        val nm = c.getSystemService(NotificationManager::class.java)
        val live = runCatching { nm.activeNotifications.toList() }.getOrDefault(emptyList()).filter { it.packageName == c.packageName }.map {
            RepostCore.Live(it.id, it.tag, (it.notification.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0, it.notification.fullScreenIntent != null)
        }
        val h = android.os.Handler(android.os.Looper.getMainLooper())
        RepostCore.pick(live, setOf("updated")).forEachIndexed { i, l ->
            h.postDelayed({
                runCatching {
                    val s = nm.activeNotifications.firstOrNull { it.id == l.id && it.tag == l.tag } ?: return@runCatching   // gone meanwhile: stays gone
                    nm.notify(l.tag, l.id, Notification.Builder.recoverBuilder(c, s.notification).setSmallIcon(R.drawable.ic_stat_ps).setOnlyAlertOnce(true).build())
                }
            }, RepostCore.delay(i))
        }
    }

    fun update(c: Context, version: String, keyword: String = "") {
        if (!can(c)) return
        val n = Notification.Builder(c, UPDATES).setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#EC4E86"))
            .setContentTitle("Update available · PS app $version${if (keyword.isNotBlank()) " · $keyword" else ""}").setContentText("Open PS app and tap Update now when it suits you.")
            .setContentIntent(openIntent(c, "update", 7)).setAutoCancel(true).build()
        c.getSystemService(NotificationManager::class.java).notify("update", 7, n)
    }
}

/**
 * PS Do Not Disturb on this phone (web src/core/dnd.ts decides, src/dnd.ts sends
 * {type:"dnd", state:{on, until, mute}} already worked out for the phone). PS only: never Android's own
 * Do Not Disturb or any system setting. Kept in prefs so a background check while the page sleeps follows it.
 */
object Dnd {
    private fun sp(c: Context) = c.getSharedPreferences("dnd", Context.MODE_PRIVATE)
    fun set(c: Context, st: JSONObject?) { sp(c).edit().putString("state", (st ?: JSONObject()).toString()).apply() }
    fun kind(id: String) = when {
        id.startsWith("m:") -> "mail"
        id.startsWith("c:") -> "chats"
        id.startsWith("n:") -> "leads"
        id.startsWith("g:") -> "gsquad"
        else -> "meetings"      // booked, declined, a lead's message, 10 minutes before (and the shell's own alarms)
    }
    fun mutes(c: Context, kind: String): Boolean {
        val st = runCatching { JSONObject(sp(c).getString("state", "{}") ?: "{}") }.getOrNull() ?: return false
        if (!st.optBoolean("on")) return false
        val until = st.optLong("until")
        if (until > 0 && until <= System.currentTimeMillis()) return false
        return st.optJSONObject("mute")?.optBoolean(kind) == true
    }
}

/**
 * 10 minutes before each real call, on time even while PS sleeps (AlarmManager). The schedule is sealed
 * by the device key, so every function here that reads or writes it is for the bridge thread, a worker
 * or goAsync, never the main thread (Keys).
 */
object Alarms {
    private const val F = "schedule"
    private val last = SameAsLast()
    // Start and end times of the sealed schedule (no titles), so "Are you sure" asks no Keystore each time.
    @Volatile private var spans: LongArray? = null
    private fun keep(list: JSONArray) {
        spans = LongArray(list.length() * 2).also { a -> for (i in 0 until list.length()) { val m = list.optJSONObject(i); a[2 * i] = m?.optLong("start") ?: 0; a[2 * i + 1] = m?.optLong("end") ?: 0 } }
    }

    fun set(c: Context, list: JSONArray) {
        val text = list.toString()
        if (!(last.same(text) && Keys.file(c, F).exists())) { Keys.write(c, F, text); last.wrote(text) }
        keep(list)
        arm(c, list)
    }
    fun restore(c: Context) { Keys.read(c, F)?.let { runCatching { JSONArray(it).also { l -> keep(l); arm(c, l) } } } }

    /** Is a real meeting on right now? ("Are you sure" stays quiet then.) Off the main thread. */
    fun inMeeting(c: Context): Boolean {
        val s = spans ?: (Keys.read(c, F)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return false).let { keep(it); spans!! }
        val now = System.currentTimeMillis()
        for (i in 0 until s.size / 2) if (s[2 * i] <= now && s[2 * i + 1] > now) return true
        return false
    }

    private fun arm(c: Context, list: JSONArray) {
        val am = c.getSystemService(AlarmManager::class.java)
        val sp = c.getSharedPreferences("alarms", Context.MODE_PRIVATE)
        // Cancel what was armed before, then arm the new list.
        sp.getStringSet("ids", emptySet())!!.forEach { am.cancel(Receivers.alarm(c, it)) }
        val now = System.currentTimeMillis()
        val ids = HashSet<String>()
        for (i in 0 until list.length()) {
            val m = list.getJSONObject(i)
            val at = m.optLong("start") - 10 * 60_000
            if (at < now - 60_000 || at > now + 2 * 86_400_000) continue
            val id = m.optString("id").take(40)
            val pi = Receivers.alarm(c, id)
            if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.coerceAtLeast(now + 1000), pi)
            else am.setWindow(AlarmManager.RTC_WAKEUP, at.coerceAtLeast(now + 1000), 60_000, pi)
            ids.add(id)
        }
        sp.edit().putStringSet("ids", ids).apply()
    }

    /** The alarm went off: find the call in the sealed schedule and say so. */
    fun fire(c: Context, id: String) {
        val list = Keys.read(c, F)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return
        for (i in 0 until list.length()) {
            val m = list.getJSONObject(i)
            if (m.optString("id").take(40) != id) continue
            val mins = ((m.optLong("start") - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)
            Notifier.card(c, JSONObject().put("id", id).put("title", if (mins <= 1) "A call starts now" else "A call starts in $mins minutes")
                .put("sub", m.optString("title")).put("discreetText", "A call starts soon")
                .put("callAt", java.time.Instant.ofEpochMilli(m.optLong("start")).toString()))
        }
    }
}

@Suppress("unused")
private val sdk = Build.VERSION.SDK_INT
