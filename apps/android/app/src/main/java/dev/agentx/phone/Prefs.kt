package dev.agentx.phone

import android.content.Context
import android.content.SharedPreferences

/**
 * What the app remembers, in app-private storage that is excluded from
 * backups (res/xml/data_extraction_rules.xml).
 *
 * The token is this phone's device key from `agentx app pair`: the same
 * kind of key the phone app keeps in its cookie. It only opens /app and
 * /api/app on the paired computer, and `agentx app revoke` cancels it.
 */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.applicationContext.getSharedPreferences("agentx", Context.MODE_PRIVATE)

    /** https://<computer>, without a trailing slash or /app. */
    var baseUrl: String?
        get() = p.getString("baseUrl", null)
        set(v) = p.edit().putString("baseUrl", v).apply()

    var token: String?
        get() = p.getString("token", null)
        set(v) = p.edit().putString("token", v).apply()

    /** Chrome has been handed the key once (through /app/pair). */
    var browserPaired: Boolean
        get() = p.getBoolean("browserPaired", false)
        set(v) = p.edit().putBoolean("browserPaired", v).apply()

    /** The owner's switch for place reminders on this phone. Off by default. */
    var placesOn: Boolean
        get() = p.getBoolean("placesOn", false)
        set(v) = p.edit().putBoolean("placesOn", v).apply()

    /** Names of the places registered at the last check, for the screen. */
    var placeNames: Set<String>
        get() = p.getStringSet("placeNames", emptySet()) ?: emptySet()
        set(v) = p.edit().putStringSet("placeNames", v).apply()

    var lastSyncAt: Long
        get() = p.getLong("lastSyncAt", 0)
        set(v) = p.edit().putLong("lastSyncAt", v).apply()

    /** Plain words for the screen, or null when the last check went well. */
    var lastError: String?
        get() = p.getString("lastError", null)
        set(v) = p.edit().putString("lastError", v).apply()

    /** app.places.syncMinutes from the computer. */
    var syncMinutes: Int
        get() = p.getInt("syncMinutes", 60)
        set(v) = p.edit().putInt("syncMinutes", v).apply()

    val paired: Boolean get() = baseUrl != null && token != null

    fun forget() {
        p.edit().clear().apply()
    }
}
