package dev.agentx.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingEvent
import java.text.DateFormat
import java.util.Date
import java.util.UUID

/**
 * Woken by Play services when the phone enters or leaves a place, with the
 * app closed and the screen off. Sends the event at once if it can and
 * hands it to WorkManager otherwise, so it still arrives once the phone
 * has a connection again (with the same id, so it never fires twice).
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        val prefs = Prefs(context)
        if (event.hasError()) {
            if (event.errorCode == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) {
                // Location was turned off: Android dropped the geofences.
                prefs.problem = "Location is turned off on this phone. Turn it on, then open AgentX to watch your places again."
                prefs.watching = 0
            }
            Log.w(TAG, "geofence error ${event.errorCode}")
            return
        }
        val enter = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> true
            Geofence.GEOFENCE_TRANSITION_EXIT -> false
            else -> return
        }
        if (!prefs.placesOn) return
        val at = System.currentTimeMillis()
        val events = (event.triggeringGeofences ?: emptyList()).map {
            Protocol.eventJson(UUID.randomUUID().toString(), it.requestId, enter, at)
        }
        if (events.isEmpty()) return
        prefs.lastEvent = "${if (enter) "Entered" else "Left"} a place at ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))}"

        val pending = goAsync()
        Thread {
            try {
                for (json in events) {
                    if (!EventWorker.sendNow(context, json)) EventWorker.enqueue(context, json)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private const val TAG = "AgentXPlaces"
    }
}
