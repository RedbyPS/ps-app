package com.cincee.ps.gos

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.graphics.drawable.Icon
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.RemoteViews
import org.json.JSONObject

/** Quick Settings tile: swipe down, tap PS, the list opens over whatever was in front. */
class PsTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            // PS 1.72: the icon given each time, from this build, so a tile Android kept from before an update never shows an old one.
            icon = Icon.createWithResource(this@PsTileService, R.drawable.ic_ps_tile)
            state = Tile.STATE_INACTIVE
            label = "PS list"
            subtitle = PsWidget.count?.let { if (it == 0) "All clear" else "$it open" } ?: "Your tasks"
            updateTile()
        }
    }
    override fun onClick() {
        startActivityAndCollapse(Notifier.openIntent(this, "list", 3))
    }
}

/**
 * Home screen widget: the next three tasks and an Add button. It shows task titles on the home
 * screen; the page only sends them while the vault is open, and only the top three.
 */
class PsWidget : AppWidgetProvider() {
    companion object {
        @Volatile var count: Int? = null; private set   // set from the bridge thread
        @Volatile private var top = listOf<String>()

        fun update(c: Context, m: JSONObject) {
            count = m.optInt("count")
            top = (0 until (m.optJSONArray("list")?.length() ?: 0)).map { m.getJSONArray("list").optString(it) }.take(3)
            if (Prefs.widget(c)) render(c)
            TileService.requestListeningState(c, ComponentName(c, PsTileService::class.java))
        }

        fun render(c: Context) {
            val wm = AppWidgetManager.getInstance(c)
            val ids = wm.getAppWidgetIds(ComponentName(c, PsWidget::class.java))
            if (ids.isEmpty()) return
            val v = RemoteViews(c.packageName, R.layout.widget_ps)
            v.setTextViewText(R.id.w_count, count?.let { if (it == 0) "all clear" else "$it open" } ?: "")
            v.setTextViewText(R.id.w_t1, top.getOrNull(0) ?: if (count == 0) "Nothing on your list" else "Open PS app to see your list")
            v.setTextViewText(R.id.w_t2, top.getOrNull(1) ?: "")
            v.setTextViewText(R.id.w_t3, top.getOrNull(2) ?: "")
            v.setOnClickPendingIntent(R.id.w_root, Notifier.openIntent(c, "list", 4))
            v.setOnClickPendingIntent(R.id.w_add, Notifier.openIntent(c, "add", 5))
            wm.updateAppWidget(ids, v)
        }
    }
    override fun onUpdate(c: Context, wm: AppWidgetManager, ids: IntArray) = render(c)
}
