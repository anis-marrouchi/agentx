package dev.agentx.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Android forgets geofences on restart and on app update: register them again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        if (prefs.connected && prefs.placesOn) SyncWorker.now(context)
    }
}
