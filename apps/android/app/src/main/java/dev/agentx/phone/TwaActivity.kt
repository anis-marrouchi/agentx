package dev.agentx.phone

import android.net.Uri
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * The phone app, unchanged, in a Trusted Web Activity: Chrome renders
 * https://<computer>/app with its own cookies, camera, microphone and Web
 * Push. Full screen when the computer vouches for this app at
 * /.well-known/assetlinks.json (agentx.json: app.android); otherwise Chrome
 * shows a slim address bar and everything still works.
 */
class TwaActivity : LauncherActivity() {
    override fun getLaunchingUrl(): Uri {
        intent?.data?.let { return it }
        val base = Prefs(this).baseUrl ?: return super.getLaunchingUrl()
        return Uri.parse("$base/app")
    }
}
