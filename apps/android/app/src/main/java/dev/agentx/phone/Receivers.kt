package dev.agentx.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingEvent
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Woken by Android when the phone crosses a saved place. Sends the crossing
 * at once, while Android keeps the app awake for this broadcast: with the
 * screen off a background job may wait for Doze's next maintenance window,
 * longer than app.places.maxEventAgeMinutes. EventWorker is queued first and
 * sends it later if this attempt fails or the app is stopped mid-way.
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) {
            if (event.errorCode == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) {
                // Location was turned off: Android dropped every geofence.
                // They are registered again at the next check.
                Prefs(context).lastError = context.getString(R.string.err_location_off)
            }
            return
        }
        val transition = transitionName(event.geofenceTransition) ?: return
        // The time of the fix that triggered it; the position itself is never read.
        val time = event.triggeringLocation?.time ?: System.currentTimeMillis()
        val crossings = (event.triggeringGeofences ?: emptyList()).map {
            Crossing(UUID.randomUUID().toString(), it.requestId, transition, time)
        }
        if (crossings.isEmpty()) return
        val app = context.applicationContext
        for (c in crossings) Jobs.report(app, c)
        val pending = goAsync()
        thread {
            try {
                // Stay inside the broadcast's 10 seconds: a quick send takes
                // at most 8, so start another only if it can still finish.
                val deadline = SystemClock.elapsedRealtime() + 9_500
                for (c in crossings) {
                    if (SystemClock.elapsedRealtime() + 8_000 > deadline) break
                    if (Report.send(app, c, quick = true)) Jobs.reported(app, c.id)
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        /** The word the computer expects, or null for a crossing it doesn't take (dwell). */
        fun transitionName(code: Int): String? = when (code) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> "enter"
            Geofence.GEOFENCE_TRANSITION_EXIT -> "exit"
            else -> null
        }
    }
}

/** Android forgets geofences on restart and on an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = Prefs(context)
        if (!prefs.paired || !prefs.placesOn) return
        val app = context.applicationContext
        // Queued first, so they survive even if the restore below is cut short.
        Jobs.syncNow(app)
        Jobs.schedule(app)
        val pending = goAsync()
        thread {
            try {
                // The check above needs the computer; this doesn't.
                Places.restore(app)
            } finally {
                pending.finish()
            }
        }
    }
}
