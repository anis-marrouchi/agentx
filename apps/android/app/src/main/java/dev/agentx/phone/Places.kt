package dev.agentx.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Tasks
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Registers the saved places as OS geofences. Android, not this app, then
 * watches the location and wakes GeofenceReceiver on a crossing, even with
 * the app closed and the screen off. No position is ever read here.
 */
object Places {
    /** Android allows 100 geofences per app. */
    private const val MAX_GEOFENCES = 100

    enum class Access { NONE, FOREGROUND_ONLY, ALL_THE_TIME }

    fun access(context: Context): Access {
        val fine = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
        if (!fine) return Access.NONE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            return Access.FOREGROUND_ONLY
        }
        return Access.ALL_THE_TIME
    }

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, GeofenceReceiver::class.java)
        // Geofencing fills the intent in, so it must stay mutable (Android 12+).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }

    /** Stops watching every place. */
    fun clear(context: Context) {
        try {
            Tasks.await(LocationServices.getGeofencingClient(context).removeGeofences(pendingIntent(context)), 30, TimeUnit.SECONDS)
        } catch (_: Exception) {
            // Nothing registered, or Play services unavailable: nothing to stop.
        }
    }

    /**
     * Fetches the places from the computer and registers them. Blocking;
     * runs in SyncWorker. Returns false when it should be tried again later.
     */
    @SuppressLint("MissingPermission") // checked through access() first
    fun sync(context: Context): Boolean {
        val prefs = Prefs(context)
        val base = prefs.baseUrl
        val token = prefs.token
        if (base == null || token == null) return true

        val body = try {
            Api.getPlaces(base, token)
        } catch (e: Api.HttpError) {
            if (e.status == 401) {
                prefs.lastError = context.getString(R.string.err_unpaired)
                clear(context)
                return true
            }
            prefs.lastError = e.message
            return false
        } catch (e: IOException) {
            prefs.lastError = context.getString(R.string.err_offline)
            return false
        }

        prefs.syncMinutes = body.optInt("syncMinutes", 60).coerceIn(15, 1440)
        val places = body.optJSONArray("places")
        val names = mutableSetOf<String>()
        val fences = mutableListOf<Geofence>()
        if (places != null) {
            for (i in 0 until minOf(places.length(), MAX_GEOFENCES)) {
                val p = places.optJSONObject(i) ?: continue
                val id = p.optString("id")
                val radius = p.optDouble("radius", Double.NaN)
                val lat = p.optDouble("lat", Double.NaN)
                val lng = p.optDouble("lng", Double.NaN)
                if (id.isEmpty() || radius.isNaN() || lat.isNaN() || lng.isNaN()) continue
                names.add(p.optString("name", id))
                fences.add(
                    Geofence.Builder()
                        .setRequestId(id)
                        .setCircularRegion(lat, lng, radius.toFloat())
                        .setExpirationDuration(Geofence.NEVER_EXPIRE)
                        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                        .build(),
                )
            }
        }
        prefs.placeNames = names
        prefs.lastSyncAt = System.currentTimeMillis()

        val on = body.optBoolean("enabled", false) && prefs.placesOn && access(context) == Access.ALL_THE_TIME
        clear(context)
        if (!on || fences.isEmpty()) {
            prefs.lastError = when {
                !body.optBoolean("enabled", false) -> body.optString("reason").ifEmpty { null }
                prefs.placesOn && access(context) != Access.ALL_THE_TIME -> context.getString(R.string.err_permission)
                else -> null
            }
            return true
        }
        return try {
            val request = GeofencingRequest.Builder()
                // 0: a place the phone is already inside doesn't fire now;
                // only a real arrival or departure does.
                .setInitialTrigger(0)
                .addGeofences(fences)
                .build()
            Tasks.await(LocationServices.getGeofencingClient(context).addGeofences(request, pendingIntent(context)), 30, TimeUnit.SECONDS)
            prefs.lastError = null
            true
        } catch (e: Exception) {
            val code = ((e.cause ?: e) as? ApiException)?.statusCode
            prefs.lastError = when (code) {
                GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE -> context.getString(R.string.err_location_off)
                GeofenceStatusCodes.GEOFENCE_TOO_MANY_GEOFENCES -> context.getString(R.string.err_too_many)
                else -> context.getString(R.string.err_register, e.message ?: e.toString())
            }
            code != GeofenceStatusCodes.GEOFENCE_TOO_MANY_GEOFENCES
        }
    }
}
