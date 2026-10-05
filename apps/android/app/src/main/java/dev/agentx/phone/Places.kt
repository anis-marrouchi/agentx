package dev.agentx.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Registers the saved places as OS geofences. Android, not this app, then
 * watches the location and wakes GeofenceReceiver on a crossing, even with
 * the app closed and the screen off. No position is ever read here.
 */
object Places {
    /** Android allows 100 geofences per app. */
    private const val MAX_GEOFENCES = 100

    /** Held while registering, by sync() and restore(). */
    private val lock = ReentrantLock()

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
    fun clear(context: Context, timeoutSeconds: Long = 30) {
        try {
            Tasks.await(LocationServices.getGeofencingClient(context).removeGeofences(pendingIntent(context)), timeoutSeconds, TimeUnit.SECONDS)
        } catch (_: Exception) {
            // Nothing registered, or Play services unavailable: nothing to stop.
        }
    }

    /** One saved place, as the computer sends it and as it is kept for a restart. */
    data class Fence(val id: String, val name: String, val lat: Double, val lng: Double, val radius: Double)

    /** Reads the `places` array of GET /api/app/places, skipping incomplete
     *  entries, up to Android's limit. */
    fun parse(places: JSONArray?): List<Fence> {
        val out = mutableListOf<Fence>()
        if (places == null) return out
        for (i in 0 until places.length()) {
            if (out.size >= MAX_GEOFENCES) break
            val p = places.optJSONObject(i) ?: continue
            val id = p.optString("id")
            val radius = p.optDouble("radius", Double.NaN)
            val lat = p.optDouble("lat", Double.NaN)
            val lng = p.optDouble("lng", Double.NaN)
            if (id.isEmpty() || radius.isNaN() || lat.isNaN() || lng.isNaN()) continue
            out.add(Fence(id, p.optString("name", id), lat, lng, radius))
        }
        return out
    }

    /** The places as kept in Prefs.watched: only what a geofence needs. */
    fun toJson(fences: List<Fence>): String {
        val arr = JSONArray()
        for (f in fences) {
            arr.put(JSONObject().put("id", f.id).put("name", f.name).put("lat", f.lat).put("lng", f.lng).put("radius", f.radius))
        }
        return arr.toString()
    }

    /**
     * Fetches the places from the computer and registers them. Blocking;
     * runs in SyncWorker. Returns false when it should be tried again later.
     */
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
                prefs.watched = null
                clear(context)
                return true
            }
            prefs.lastError = e.message
            return false
        } catch (e: IOException) {
            prefs.lastError = context.getString(R.string.err_offline)
            return false
        }

        // Registering is locked with restore(), so the two never register
        // over each other at boot.
        lock.withLock {
            prefs.syncMinutes = body.optInt("syncMinutes", 60).coerceIn(15, 1440)
            val fences = parse(body.optJSONArray("places"))
            prefs.placeNames = fences.map { it.name }.toSet()
            prefs.lastSyncAt = System.currentTimeMillis()

            val on = body.optBoolean("enabled", false) && prefs.placesOn && access(context) == Access.ALL_THE_TIME
            clear(context)
            if (!on || fences.isEmpty()) {
                prefs.watched = null
                prefs.lastError = when {
                    !body.optBoolean("enabled", false) -> body.optString("reason").ifEmpty { null }
                    prefs.placesOn && access(context) != Access.ALL_THE_TIME -> context.getString(R.string.err_permission)
                    else -> null
                }
                return true
            }
            val error = register(context, fences)
            // Kept even if Android refused them for now (location off, say): it is
            // still the list to watch again after a restart.
            prefs.watched = toJson(fences)
            prefs.lastError = error?.message
            return error == null || !error.retry
        }
    }

    /**
     * After a restart: watches the places registered before it again, from
     * what was kept, without waiting for the computer to be reachable (the
     * tailnet is often not up yet at boot). SyncWorker then checks for
     * changes as usual. Blocking; runs inside the boot broadcast, so Play
     * services gets 8 seconds per call instead of 30, and it waits at most
     * 8 seconds for a check that is registering at the same time.
     */
    fun restore(context: Context) {
        val prefs = Prefs(context)
        if (!prefs.paired || !prefs.placesOn || access(context) != Access.ALL_THE_TIME) return
        // Busy: a check is registering the current places right now.
        if (!lock.tryLock(8, TimeUnit.SECONDS)) return
        try {
            restoreLocked(context, prefs)
        } finally {
            lock.unlock()
        }
    }

    private fun restoreLocked(context: Context, prefs: Prefs) {
        // A check already ran since the phone started: it registered the
        // current places, which may be newer than the ones kept.
        if (prefs.lastSyncAt >= System.currentTimeMillis() - SystemClock.elapsedRealtime()) return
        val kept = prefs.watched ?: return
        val fences = try { parse(JSONArray(kept)) } catch (_: Exception) { emptyList() }
        if (fences.isEmpty()) return
        register(context, fences, timeoutSeconds = 8)?.let { prefs.lastError = it.message }
    }

    private class RegisterError(val message: String, val retry: Boolean)

    /** Replaces whatever is registered with these places. Null when it worked. */
    @SuppressLint("MissingPermission") // callers check access() first
    private fun register(context: Context, fences: List<Fence>, timeoutSeconds: Long = 30): RegisterError? {
        clear(context, timeoutSeconds)
        return try {
            val request = GeofencingRequest.Builder()
                // 0: a place the phone is already inside doesn't fire now;
                // only a real arrival or departure does.
                .setInitialTrigger(0)
                .addGeofences(fences.map { f ->
                    Geofence.Builder()
                        .setRequestId(f.id)
                        .setCircularRegion(f.lat, f.lng, f.radius.toFloat())
                        .setExpirationDuration(Geofence.NEVER_EXPIRE)
                        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                        .build()
                })
                .build()
            Tasks.await(LocationServices.getGeofencingClient(context).addGeofences(request, pendingIntent(context)), timeoutSeconds, TimeUnit.SECONDS)
            null
        } catch (e: Exception) {
            val code = ((e.cause ?: e) as? ApiException)?.statusCode
            when (code) {
                GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE -> RegisterError(context.getString(R.string.err_location_off), true)
                GeofenceStatusCodes.GEOFENCE_TOO_MANY_GEOFENCES -> RegisterError(context.getString(R.string.err_too_many), false)
                else -> RegisterError(context.getString(R.string.err_register, e.message ?: e.toString()), true)
            }
        }
    }
}
