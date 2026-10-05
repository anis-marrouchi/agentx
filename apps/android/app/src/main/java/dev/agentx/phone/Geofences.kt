package dev.agentx.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/**
 * Registers the computer's places as OS geofences. Google Play services
 * watches them with the app closed and wakes GeofenceReceiver on enter or
 * exit; the app itself never reads a position.
 */
object Geofences {
    private const val TAG = "AgentXPlaces"

    fun hasForeground(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)

    /** "Allow all the time". Before Android 10 the foreground grant covers it. */
    fun hasBackground(ctx: Context) =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    fun hasNotifications(ctx: Context) =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted(ctx, Manifest.permission.POST_NOTIFICATIONS)

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    private fun pendingIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx, GeofenceReceiver::class.java)
        // Mutable: Play services fills in which geofence fired.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, 0, intent, flags)
    }

    /**
     * Fetches the place list and replaces every geofence with it. Blocking;
     * call from a worker. Returns how many places are watched.
     */
    fun sync(ctx: Context): Int {
        val prefs = Prefs(ctx)
        val server = prefs.server
        val token = prefs.token
        if (server == null || token == null || !prefs.placesOn) {
            clear(ctx)
            return 0
        }
        val snapshot = Api.places(server, token)
        prefs.syncMinutes = snapshot.syncMinutes
        prefs.lastSyncAt = System.currentTimeMillis()
        if (!snapshot.enabled) {
            clear(ctx)
            prefs.problem = snapshot.reason ?: "Place reminders are off on the computer."
            return 0
        }
        if (!hasForeground(ctx) || !hasBackground(ctx)) {
            clear(ctx)
            prefs.problem = "Location is not allowed all the time, so places can't be watched."
            return 0
        }
        register(ctx, snapshot)
        prefs.problem = null
        return snapshot.places.size
    }

    @SuppressLint("MissingPermission") // checked in sync()
    private fun register(ctx: Context, s: PlacesSnapshot) {
        val client = LocationServices.getGeofencingClient(ctx)
        val pi = pendingIntent(ctx)
        Tasks.await(client.removeGeofences(pi), 30, TimeUnit.SECONDS)
        Prefs(ctx).watching = 0
        if (s.places.isEmpty()) return
        val fences = s.places.map {
            Geofence.Builder()
                .setRequestId(it.id)
                .setCircularRegion(it.lat, it.lon, it.radiusMeters)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                .setNotificationResponsiveness(s.responsivenessSeconds * 1000)
                .build()
        }
        // No initial trigger: saving a place while standing in it must not
        // fire its arrival reminder.
        val request = GeofencingRequest.Builder()
            .setInitialTrigger(0)
            .addGeofences(fences)
            .build()
        Tasks.await(client.addGeofences(request, pi), 30, TimeUnit.SECONDS)
        Prefs(ctx).watching = fences.size
        Log.i(TAG, "watching ${fences.size} place(s)")
    }

    /** Removes every geofence: location reminders off, or disconnected. */
    fun clear(ctx: Context) {
        try {
            Tasks.await(LocationServices.getGeofencingClient(ctx).removeGeofences(pendingIntent(ctx)), 30, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "could not remove geofences: ${e.message}")
        }
        Prefs(ctx).watching = 0
    }
}
