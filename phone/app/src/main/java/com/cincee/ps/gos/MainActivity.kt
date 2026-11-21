package com.cincee.ps.gos

import android.Manifest
import android.annotation.SuppressLint
import android.app.StatusBarManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.webkit.ValueCallback
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject

/** The screen: the shared web app, edge to edge, plus everything that needs an activity. */
class MainActivity : FragmentActivity() {
    private lateinit var box: FrameLayout
    @Volatile var isShown = false; private set   // read from the bridge thread and workers too
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCb?.onReceiveValue(uri?.let { arrayOf(it) }); fileCb = null
    }
    // The Soundboard's pickers (Soundboard.kt): several audio and video files, or one folder. The answer goes straight to
    // the Soundboard's own threads; nothing is read here.
    private var sbFilesCb: ((List<Uri>) -> Unit)? = null
    private val sbFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> val cb = sbFilesCb; sbFilesCb = null; cb?.invoke(uris) }
    private var sbTreeCb: ((Uri?) -> Unit)? = null
    private val sbTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> val cb = sbTreeCb; sbTreeCb = null; cb?.invoke(uri) }
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { WebHost.sendPerms(); Quiet.sync(this) }
    // V1.55: the camera, only for the page's own scanner (Scan the code on your Mac). The page asks; the WebView request
    // waits here until the person answered Android's prompt, then gets exactly the video it asked for, or nothing.
    private var camReq: android.webkit.PermissionRequest? = null
    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val r = camReq; camReq = null
        if (r != null) { if (ok) r.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else r.deny() }
    }
    fun cameraFor(r: android.webkit.PermissionRequest) {
        camReq?.deny(); camReq = null
        if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            r.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)); return
        }
        camReq = r
        askCamera.launch(android.Manifest.permission.CAMERA)
    }
    private val tick = Runnable { sendScreenTime() }
    /** V1.54: while PS is on screen it looks for an update every 5 minutes (UpdateClock decides; Updater skips it while a look runs). */
    private val updTick = object : Runnable {
        override fun run() { val c = applicationContext; Work.post { Updater.maybe(c, open = true) }; if (!UpdateClock.off(Updater.every(c))) box.postDelayed(this, UpdateClock.everyMs(Updater.every(c))) }
    }
    /** Settings, "Check for updates every" changed: the screen timer starts over at the new pace and looks now if that is already due. */
    fun updatePace() { runOnUiThread { if (isShown) { box.removeCallbacks(updTick); box.post(updTick) } } }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        if (Nuke.done(this)) { Nuke.gone(this, this); return }   // a failed rule: only the Gone screen (Nuke.kt)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
        box = FrameLayout(this)
        setContentView(box)
        mountWeb()
        ViewCompat.setOnApplyWindowInsetsListener(box) { _, ins ->
            // The page is never resized for the keyboard (that relaid out the whole list and made the
            // page jump). The bars and the keyboard height go to the page as CSS values instead.
            lastInsets = ins
            sendInsets()
            if (guardBottom > guardTop) box.post { applyEdgeGuard() }   // PS 1.73: a rotation or a new bar size moves the strips
            WindowInsetsCompat.CONSUMED
        }
        // The keyboard's own slide, frame by frame, so sheets rise with it instead of after it.
        ViewCompat.setWindowInsetsAnimationCallback(box, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
            override fun onProgress(ins: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
                if (running.any { it.typeMask and WindowInsetsCompat.Type.ime() != 0 }) sendKeyboard(ins, false)
                return ins
            }
            override fun onEnd(a: WindowInsetsAnimationCompat) { lastInsets?.let { sendKeyboard(it, true) } }
        })
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { WebHost.post(JSONObject().put("type", "back")) }
        })
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            !getSharedPreferences("ps", MODE_PRIVATE).getBoolean("askedNotify", false)) {
            getSharedPreferences("ps", MODE_PRIVATE).edit().putBoolean("askedNotify", true).apply()
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        handleOpen(intent)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
    }

    /** The page's WebView (PS 1.73 swipe leak: the edge strips are set on it). */
    private var web: android.view.View? = null
    fun mountWeb() {
        val w = WebHost.attach(this)
        web = w
        (w.parent as? FrameLayout)?.removeView(w)
        box.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    private var lastInsets: WindowInsetsCompat? = null
    /** PS 1.73 swipe leak (EdgeGuard.kt): the page's swipeable area in CSS px (0, 0 = off), kept to set again after a resize. */
    private var guardTop = 0.0
    private var guardBottom = 0.0
    fun setEdgeGuard(top: Double, bottom: Double) { runOnUiThread { guardTop = top; guardBottom = bottom; applyEdgeGuard() } }
    private fun applyEdgeGuard() {
        val w = web ?: return
        val g = ViewCompat.getRootWindowInsets(box)?.getInsets(WindowInsetsCompat.Type.systemGestures())
        val r = EdgeGuard.rects(guardTop, guardBottom, resources.displayMetrics.density, w.width, w.height, g?.left ?: 0, g?.right ?: 0)
        w.systemGestureExclusionRects = r.map { android.graphics.Rect(it[0], it[1], it[2], it[3]) }
    }
    private var touchAt = 0L
    fun sendInsets() {
        val ins = lastInsets ?: return
        val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val d = resources.displayMetrics.density
        WebHost.post(JSONObject().put("type", "insets").put("top", bars.top / d).put("bottom", bars.bottom / d)
            .put("left", bars.left / d).put("right", bars.right / d))
        sendKeyboard(ins, true)
    }
    private var lastKb = -1f
    private fun sendKeyboard(ins: WindowInsetsCompat, settled: Boolean) {
        val kb = ins.getInsets(WindowInsetsCompat.Type.ime()).bottom / resources.displayMetrics.density
        if (kb == lastKb && !settled) return
        if (BuildConfig.DEBUG && lastKb <= 0f && kb > 0f && touchAt > 0) Plog.i("keyboard: first frame ${android.os.SystemClock.uptimeMillis() - touchAt} ms after the touch")
        lastKb = kb
        WebHost.post(JSONObject().put("type", "kb").put("h", kb).put("settled", settled))
    }
    override fun dispatchTouchEvent(e: android.view.MotionEvent): Boolean {
        if (e.actionMasked == android.view.MotionEvent.ACTION_DOWN) touchAt = e.downTime
        return super.dispatchTouchEvent(e)
    }

    override fun onStart() { super.onStart(); isShown = true; WatchService.ownFront(); WebHost.visible(true); box.postDelayed(tick, 1500); Quiet.sync(this); applyAwake(); val c = applicationContext; Work.post { Updater.maybe(c, open = true) }; box.removeCallbacks(updTick); box.postDelayed(updTick, UpdateClock.everyMs(Updater.every(c))) }
    override fun onStop() { isShown = false; WebHost.visible(false); box.removeCallbacks(tick); box.removeCallbacks(updTick); window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); super.onStop() }

    /** Fitness: the screen stays on while a workout is open and PS is in front (Fitness.Awake). */
    fun applyAwake() {
        if (isShown && Fitness.Awake.wanted()) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    override fun onResume() { super.onResume(); WebHost.sendPerms(); overlayBack(); WatchService.sync(this); LiveService.sync(this) }

    /** V1.59: the first time the vault is open with the island on and no Display over other apps, say what it is for once.
     *  PS 1.60: Android blocks that permission for an app installed from a file, so the card gives the steps, a button for PS
     *  app's own settings page, and comes back with "Still off" when the person returns and Android still says no. */
    private var islandCard: android.app.AlertDialog? = null
    fun askIsland(still: Boolean = false, force: Boolean = false) {
        val granted = Settings.canDrawOverlays(this)
        val sp = getSharedPreferences("island", MODE_PRIVATE)
        if (!isShown || isFinishing) return
        if (islandCard?.isShowing == true || granted) return
        if (!still && !force && !OverlayHelp.showFirst(granted, Prefs.island(this), sp.getBoolean("asked", false))) return
        sp.edit().putBoolean("asked", true).putBoolean("waiting", true).apply()
        islandCard = android.app.AlertDialog.Builder(this, android.app.AlertDialog.THEME_DEVICE_DEFAULT_DARK)
            .setTitle(OverlayHelp.TITLE)
            .setMessage(OverlayHelp.message(still))
            .setPositiveButton(OverlayHelp.OPEN_APP) { _, _ -> openPermission("app") }
            .setNeutralButton(OverlayHelp.OPEN_OVERLAY) { _, _ -> openPermission("overlay") }
            .setNegativeButton(OverlayHelp.LATER) { _, _ -> sp.edit().putBoolean("waiting", false).apply() }
            .setOnCancelListener { sp.edit().putBoolean("waiting", false).apply() }
            .show()   // Back closes it (Not now)
    }
    /** PS 1.60: back from Settings after the card sent the person there: done, or still off (the card says so). */
    private fun overlayBack() {
        val sp = getSharedPreferences("island", MODE_PRIVATE)
        val waiting = sp.getBoolean("waiting", false)
        val granted = Settings.canDrawOverlays(this)
        if (OverlayHelp.finished(granted, waiting)) { sp.edit().putBoolean("waiting", false).apply(); return }
        if (OverlayHelp.showAgain(granted, Prefs.island(this), waiting)) { sp.edit().putBoolean("waiting", false).apply(); askIsland(true) }
    }
    /** V1.47: a log line when the system asks for memory back while PS is open (it can take the background video's
     *  decoder; the page then reloads the video, web src/core/bgwatch.ts). 10 is "running low" and up. */
    override fun onTrimMemory(level: Int) { super.onTrimMemory(level); if (level >= 10) Plog.i("memory trim $level (shown=$isShown)") }
    override fun onDestroy() {
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(net) }
        WebHost.detach(this)
        super.onDestroy()
    }
    override fun onNewIntent(i: Intent) { super.onNewIntent(i); handleOpen(i) }

    private fun handleOpen(i: Intent?) {
        val what = i?.getStringExtra("open") ?: return
        i.removeExtra("open")
        if (what == "update") { Updater.check(this, true); WebHost.post(JSONObject().put("type", "open").put("what", "settings")); return }
        WebHost.post(JSONObject().put("type", "open").put("what", what))
    }

    private val net = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) { WebHost.post(JSONObject().put("type", "net").put("online", true)) }
        // Net.online asks the system, so it runs on the work thread, never the main thread.
        override fun onLost(n: Network) { val c = applicationContext; box.postDelayed({ Work.post { WebHost.post(JSONObject().put("type", "net").put("online", Net.online(c))) } }, 400) }
    }

    /** Screen time every 10 minutes while PS is open (and once when it opens). Read on the work thread:
     *  it asks the system for every app's usage, label and launcher entry. */
    private fun sendScreenTime() {
        val c = applicationContext
        Work.post { ScreenTime.today(c)?.let { WebHost.post(it) } }
        box.postDelayed(tick, 10 * 60_000)
    }

    /** Add task opened from the home screen widget or the notification's Add task: the page focused its name field with
     *  no tap on the page, and the system raises no keyboard for that, so the page asks for it (src/gos/keyboard.ts,
     *  V1.33). Only while PS is in front; on the main thread (BridgeRoutes.MAIN). */
    fun showKeyboard() {
        if (!isShown) return
        val w = box.getChildAt(0) ?: return
        w.requestFocus()
        WindowCompat.getInsetsController(window, w).show(WindowInsetsCompat.Type.ime())
    }
    fun haptic(kind: String) {
        if (!Prefs.haptics(this)) return
        box.performHapticFeedback(when (kind) {
            "tick" -> HapticFeedbackConstants.CONFIRM
            "drag" -> HapticFeedbackConstants.LONG_PRESS
            "drop" -> HapticFeedbackConstants.GESTURE_END
            "reject" -> HapticFeedbackConstants.REJECT
            else -> HapticFeedbackConstants.CLOCK_TICK
        })
    }

    // ---------- Remember me: Keystore plus the fingerprint ----------
    private fun prompt(title: String, sub: String, negative: Boolean) = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title).setSubtitle(sub)
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        .apply { if (negative) setConfirmationRequired(false) }
        .build()

    // The Keystore steps (making the cipher before the prompt, doFinal or the signature after it) run on
    // the bridge thread (WebHost.bg); only the prompt itself is on the main thread. 2 Nov 2026 freeze:
    // keystore2 can keep a caller waiting for seconds when the phone is busy.
    private fun alive() = !isFinishing && !isDestroyed

    fun rememberSave(username: String, auth: String, kek: String) {
        if (username.isEmpty() || auth.isEmpty() || kek.isEmpty()) return
        val keys = JSONObject().put("username", username).put("auth", auth).put("kek", kek)
        val app = applicationContext
        WebHost.bg {
            val cipher = runCatching { Keys.fingerEncrypt() }.getOrElse { Plog.i("remember: no key (${it.javaClass.simpleName})"); return@bg }
            runOnUiThread { if (alive()) askToSave(app, cipher, keys) }
        }
    }
    private fun askToSave(app: android.content.Context, cipher: javax.crypto.Cipher, keys: JSONObject) {
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                val c = r.cryptoObject?.cipher ?: return
                WebHost.bg {
                    runCatching { Remember.save(app, c, keys) }.onFailure { Plog.i("remember: not saved (${it.javaClass.simpleName})"); return@bg }
                    WebHost.post(JSONObject().put("type", "rememberStatus").put("exists", true))
                    Plog.i("remember: saved")
                }
            }
        }).authenticate(prompt("Open PS app with your fingerprint", "Your keys stay in this phone's Keystore", true), BiometricPrompt.CryptoObject(cipher))
    }

    fun rememberUnlock() {
        val app = applicationContext
        WebHost.bg {
            // Stay signed in: straight in, no fingerprint (until the developer presses Lock).
            Remember.stayKeys(app)?.let { k -> WebHost.post(JSONObject().put("type", "remember").put("username", k.optString("username")).put("auth", k.optString("auth")).put("kek", k.optString("kek"))); return@bg }
            val iv = Remember.iv(app) ?: return@bg
            val cipher = try { Keys.fingerDecrypt(iv) } catch (e: KeyPermanentlyInvalidatedException) {
                // A new fingerprint was added to the phone: the old key is gone on purpose. Sign in again once.
                Remember.forget(app); WebHost.post(JSONObject().put("type", "rememberStatus").put("exists", false)); return@bg
            } catch (e: Exception) { Plog.i("remember: ${e.javaClass.simpleName}"); return@bg }
            runOnUiThread { if (alive()) askToOpen(app, cipher) }
        }
    }
    private fun askToOpen(app: android.content.Context, cipher: javax.crypto.Cipher) {
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                val c = r.cryptoObject?.cipher ?: return
                WebHost.bg {
                    val keys = runCatching { Remember.open(app, c) }.getOrNull() ?: return@bg
                    Prefs.setHandLocked(app, false)
                    WebHost.post(JSONObject().put("type", "remember").put("username", keys.optString("username")).put("auth", keys.optString("auth")).put("kek", keys.optString("kek")))
                }
            }
        }).authenticate(prompt("Open PS app", "Your fingerprint opens your vault on this phone", false), BiometricPrompt.CryptoObject(cipher))
    }

    // ---------- remote restart, shut down and lock: one fingerprint per command (CmdKey.kt) ----------
    fun signCmd(req: String, body: String, toName: String) {
        fun answer(o: JSONObject) = WebHost.post(o.put("type", "cmd:signed").put("req", req))
        val app = applicationContext
        val action = runCatching { JSONObject(body).optString("action") }.getOrDefault("")
        val name = toName.filter { !it.isISOControl() }.take(40).ifEmpty { "your Mac" }
        val title = when (action) { "restart" -> "Restart $name?"; "shutdown" -> "Shut down $name?"; "lock" -> "Lock $name?"; else -> "Cancel the restart of $name?" }
        WebHost.bg {
            val (sig, why) = CmdKey.prepare(app, body)
            if (sig == null) { answer(JSONObject().put("error", why ?: "Refused")); return@bg }
            runOnUiThread {
                if (!alive()) { answer(JSONObject().put("error", "Open PS app first")); return@runOnUiThread }
                BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                        val s = r.cryptoObject?.signature ?: return answer(JSONObject().put("error", "No signature"))
                        WebHost.bg {
                            val out = runCatching { CmdKey.finish(s, body) }.getOrNull() ?: return@bg answer(JSONObject().put("error", "Signing failed"))
                            answer(JSONObject().put("sig", out).put("by", CmdKey.device(app)))
                        }
                    }
                    override fun onAuthenticationError(code: Int, msg: CharSequence) { answer(JSONObject().put("error", "Not confirmed")) }
                }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle("Confirm with your fingerprint")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG).setNegativeButtonText("Cancel").build(),
                    BiometricPrompt.CryptoObject(sig))
            }
        }
    }

    // ---------- permissions, tile, widget, files ----------
    fun openPermission(which: String) {
        val pkg = Uri.parse("package:$packageName")
        val i = when (which) {
            "notifications" -> if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
                shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) { askNotify.launch(Manifest.permission.POST_NOTIFICATIONS); return }
                else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            "usage" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, pkg)
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg)
            "battery" -> @SuppressLint("BatteryLife") Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            "exactAlarm" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
            "install" -> Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkg)
            "fullScreen" -> Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
            // PS 1.60: PS app's own settings page: the camera switch, and the three dots with Allow restricted settings.
            "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
            else -> return
        }
        runCatching { startActivity(i) }.onFailure { runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) } }
    }

    fun offerTile() {
        getSystemService(StatusBarManager::class.java).requestAddTileService(ComponentName(this, PsTileService::class.java), "PS list",
            Icon.createWithResource(this, R.drawable.ic_ps_tile), mainExecutor) { }
    }
    fun offerWidget() {
        val wm = AppWidgetManager.getInstance(this)
        if (wm.isRequestPinAppWidgetSupported && wm.getAppWidgetIds(ComponentName(this, PsWidget::class.java)).isEmpty())
            wm.requestPinAppWidget(ComponentName(this, PsWidget::class.java), null, null)
    }

    /** Main thread. Audio and video files, several at once (Soundboard "Add files"). */
    fun sbPickFiles(cb: (List<Uri>) -> Unit) {
        sbFilesCb?.invoke(emptyList())
        sbFilesCb = cb
        runCatching { sbFiles.launch(arrayOf("audio/*", "video/*")) }.onFailure { sbFilesCb = null; cb(emptyList()) }
    }
    /** Main thread. One folder (Soundboard "Add folder", and "Choose" for the storage place). */
    fun sbPickTree(cb: (Uri?) -> Unit) {
        sbTreeCb?.invoke(null)
        sbTreeCb = cb
        runCatching { sbTree.launch(null) }.onFailure { sbTreeCb = null; cb(null) }
    }

    fun chooseFile(cb: ValueCallback<Array<Uri>>, accept: Array<String>) {
        fileCb?.onReceiveValue(null)
        fileCb = cb
        val types = accept.flatMap { it.split(',') }.map { it.trim() }.filter { it.contains('/') }.ifEmpty { listOf("*/*") }
        pickFile.launch(types.toTypedArray())
    }

}
