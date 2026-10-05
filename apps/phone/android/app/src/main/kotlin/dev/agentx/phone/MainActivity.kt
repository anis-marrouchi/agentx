package dev.agentx.phone

import android.net.Uri
import com.google.androidbrowserhelper.trusted.TwaLauncher
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The Flutter screens, plus the two things lib/src/browser.dart asks of
 * Android over the "agentx/shell" channel:
 *
 *  - openTrusted: opens the phone app in Chrome as a Trusted Web Activity,
 *    so cookies, camera, microphone and Web Push work as in Chrome itself.
 *    Full screen when the computer vouches for this app at
 *    /.well-known/assetlinks.json (agentx.json: app.android); otherwise a
 *    slim address bar shows. Without a browser that supports it, the
 *    launcher falls back to a Custom Tab.
 *  - launchLink: the link the app was opened with (agentx://places), or null.
 */
class MainActivity : FlutterActivity() {
    private var twa: TwaLauncher? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agentx/shell").setMethodCallHandler { call, result ->
            when (call.method) {
                "openTrusted" -> {
                    val url = call.argument<String>("url")
                    if (url == null) {
                        result.error("bad-url", "url is missing", null)
                    } else {
                        try {
                            twa?.destroy()
                            twa = TwaLauncher(this).also { it.launch(Uri.parse(url)) }
                            result.success(null)
                        } catch (e: Exception) {
                            result.error("no-browser", e.message, null)
                        }
                    }
                }
                "launchLink" -> result.success(intent?.data?.toString())
                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        twa?.destroy()
        super.onDestroy()
    }
}
