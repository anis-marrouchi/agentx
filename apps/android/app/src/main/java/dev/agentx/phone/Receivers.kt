package dev.agentx.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingEvent
import java.util.UUID

/** Woken by Android when the phone crosses a saved place. Hands the
 *  crossing to EventWorker, which sends it when there is a network. */
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
        val transition = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> "enter"
            Geofence.GEOFENCE_TRANSITION_EXIT -> "exit"
            else -> return
        }
        // The time of the fix that triggered it; the position itself is never read.
        val time = event.triggeringLocation?.time ?: System.currentTimeMillis()
        for (fence in event.triggeringGeofences ?: emptyList()) {
            Jobs.report(context, UUID.randomUUID().toString(), fence.requestId, transition, time)
        }
    }
}

/** Android forgets geofences on restart and on an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = Prefs(context)
        if (!prefs.paired || !prefs.placesOn) return
        Jobs.syncNow(context)
        Jobs.schedule(context)
    }
}
