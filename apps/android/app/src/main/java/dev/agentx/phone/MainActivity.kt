package dev.agentx.phone

import android.app.Activity
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle

/** The launcher entry: setup the first time, then the phone app in Chrome. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        if (!prefs.paired) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        addShortcut()
        if (prefs.placesOn) Jobs.syncNow(this)
        openApp(this, prefs)
        finish()
    }

    /** Long-press the app icon: Place reminders. */
    private fun addShortcut() {
        val sm = getSystemService(ShortcutManager::class.java) ?: return
        val shortcut = ShortcutInfo.Builder(this, "places")
            .setShortLabel(getString(R.string.places_title))
            .setIcon(Icon.createWithResource(this, R.drawable.ic_place))
            .setIntent(Intent(this, PlacesActivity::class.java).setAction(Intent.ACTION_VIEW))
            .build()
        try { sm.dynamicShortcuts = listOf(shortcut) } catch (_: Exception) { /* launcher without shortcuts */ }
    }

    companion object {
        /** Opens the phone app. The first time, Chrome gets the key through
         *  /app/pair#token=…: the part after # never reaches the network,
         *  and the page swaps it for its cookie and opens /app. */
        fun openApp(activity: Activity, prefs: Prefs) {
            val base = prefs.baseUrl ?: return
            val url = if (!prefs.browserPaired && prefs.token != null) {
                prefs.browserPaired = true
                "$base/app/pair#token=${Uri.encode(prefs.token)}"
            } else {
                "$base/app"
            }
            activity.startActivity(Intent(activity, TwaActivity::class.java).setData(Uri.parse(url)))
        }
    }
}
