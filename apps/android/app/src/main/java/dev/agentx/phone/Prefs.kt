package dev.agentx.phone

import android.content.Context
import android.content.SharedPreferences

/**
 * What the shell remembers, in app-private storage (backups are off in the
 * manifest, so the device token never leaves the phone).
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.applicationContext.getSharedPreferences("agentx", Context.MODE_PRIVATE)

    var server: String?
        get() = sp.getString("server", null)
        set(v) = sp.edit().putString("server", v).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    var deviceName: String?
        get() = sp.getString("deviceName", null)
        set(v) = sp.edit().putString("deviceName", v).apply()

    /** The owner's switch: watch places or not. Off until turned on. */
    var placesOn: Boolean
        get() = sp.getBoolean("placesOn", false)
        set(v) = sp.edit().putBoolean("placesOn", v).apply()

    /** The phone app in Chrome still needs its own session once. */
    var webPaired: Boolean
        get() = sp.getBoolean("webPaired", false)
        set(v) = sp.edit().putBoolean("webPaired", v).apply()

    var syncMinutes: Int
        get() = sp.getInt("syncMinutes", 360)
        set(v) = sp.edit().putInt("syncMinutes", v).apply()

    var watching: Int
        get() = sp.getInt("watching", 0)
        set(v) = sp.edit().putInt("watching", v).apply()

    var lastSyncAt: Long
        get() = sp.getLong("lastSyncAt", 0)
        set(v) = sp.edit().putLong("lastSyncAt", v).apply()

    /** Why the last sync or registration failed; null when it worked. */
    var problem: String?
        get() = sp.getString("problem", null)
        set(v) = sp.edit().putString("problem", v).apply()

    var lastEvent: String?
        get() = sp.getString("lastEvent", null)
        set(v) = sp.edit().putString("lastEvent", v).apply()

    val connected: Boolean get() = !server.isNullOrEmpty() && !token.isNullOrEmpty()

    fun disconnect() {
        sp.edit().clear().apply()
    }
}
