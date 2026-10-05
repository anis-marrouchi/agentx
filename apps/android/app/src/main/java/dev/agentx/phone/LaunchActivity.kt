package dev.agentx.phone

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import com.google.androidbrowserhelper.trusted.TwaLauncher

/**
 * The app icon. Opens the computer's phone app (/app) in Chrome as a
 * Trusted Web Activity: the same page, service worker and notifications as
 * the installed web app, unchanged. Until this phone is connected it opens
 * the settings screen instead.
 *
 * The first launch opens /app/pair with the device token in the URL
 * fragment, the same link `agentx app pair` shows as a QR code, so the
 * phone app in Chrome is paired too without a second code.
 */
class LaunchActivity : Activity() {
    private var launcher: TwaLauncher? = null
    private var launched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        val server = prefs.server
        val token = prefs.token
        if (server == null || token == null) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }
        // Opening the app is a good moment to catch up on place changes.
        if (prefs.placesOn) SyncWorker.now(this)
        val target = if (prefs.webPaired) "$server/app" else "$server/app/pair#token=${Uri.encode(token)}"
        val builder = TrustedWebActivityIntentBuilder(Uri.parse(target))
        launcher = TwaLauncher(this).also {
            it.launch(builder, null, null) {
                launched = true
                prefs.webPaired = true
            }
        }
    }

    override fun onRestart() {
        super.onRestart()
        // Back from the phone app: leave, rather than show an empty screen.
        if (launched) finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        launcher?.destroy()
    }
}
