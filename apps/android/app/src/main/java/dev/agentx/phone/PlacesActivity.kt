package dev.agentx.phone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.Switch
import android.widget.TextView
import java.text.DateFormat
import java.util.Date
import kotlin.concurrent.thread

/**
 * Place reminders on this phone: the switch, which location permissions
 * are on, the places being watched, and the way out (turn off, forget
 * this computer). Also reached from the phone app's Alerts tab and by
 * long-pressing the app icon.
 */
class PlacesActivity : Activity() {
    companion object {
        const val EXTRA_FIRST_RUN = "firstRun"
        private const val REQ_FOREGROUND = 1
        private const val REQ_BACKGROUND = 2
    }

    private lateinit var prefs: Prefs
    private lateinit var switch: Switch
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_places)
        prefs = Prefs(this)
        switch = findViewById(R.id.places_switch)
        status = findViewById(R.id.places_status)

        findViewById<View>(R.id.first_run).visibility = if (intent.getBooleanExtra(EXTRA_FIRST_RUN, false)) View.VISIBLE else View.GONE
        switch.setOnClickListener {
            if (switch.isChecked) turnOn() else turnOff()
        }
        findViewById<Button>(R.id.sync_now).setOnClickListener {
            status.text = getString(R.string.places_checking)
            thread {
                Places.sync(this)
                runOnUiThread { render() }
            }
        }
        findViewById<Button>(R.id.android_settings).setOnClickListener { openAppSettings() }
        findViewById<Button>(R.id.open_app).setOnClickListener {
            if (prefs.paired) MainActivity.openApp(this, prefs)
        }
        findViewById<Button>(R.id.forget).setOnClickListener { confirmForget() }
    }

    override fun onResume() {
        super.onResume()
        if (!prefs.paired) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        // Back from Android's settings: finish turning on if "All the time" was chosen.
        if (prefs.placesOn) {
            Jobs.schedule(this)
            Jobs.syncNow(this)
        }
        render()
    }

    private fun render() {
        val access = Places.access(this)
        switch.isChecked = prefs.placesOn
        findViewById<TextView>(R.id.perm_location).text = getString(
            R.string.perm_location,
            getString(if (access != Places.Access.NONE) R.string.allowed else R.string.not_allowed),
        )
        findViewById<TextView>(R.id.perm_background).text = getString(
            R.string.perm_background,
            getString(if (access == Places.Access.ALL_THE_TIME) R.string.allowed else R.string.not_allowed),
        )
        findViewById<TextView>(R.id.perm_notifications).text = getString(
            R.string.perm_notifications,
            getString(if (notificationsAllowed()) R.string.allowed else R.string.not_allowed),
        )
        val names = prefs.placeNames.sorted()
        val synced = if (prefs.lastSyncAt > 0) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(prefs.lastSyncAt)) else null
        val lines = mutableListOf<String>()
        lines += when {
            !prefs.placesOn -> getString(R.string.places_off)
            // Location was taken away in Android's settings after turning on.
            access != Places.Access.ALL_THE_TIME -> getString(R.string.places_no_access)
            names.isEmpty() -> getString(R.string.places_none)
            else -> getString(R.string.places_watching, names.joinToString(", "))
        }
        if (synced != null) lines += getString(R.string.places_last_check, synced)
        prefs.lastError?.let { lines += it }
        status.text = lines.joinToString("\n")
        findViewById<TextView>(R.id.computer).text = getString(R.string.paired_with, Uri.parse(prefs.baseUrl ?: "").host ?: "")
    }

    private fun notificationsAllowed(): Boolean =
        Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    // --- Turning on: precise location first, then "Allow all the time". ---

    private fun turnOn() {
        when (Places.access(this)) {
            Places.Access.NONE -> requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_FOREGROUND,
            )
            Places.Access.FOREGROUND_ONLY -> askBackground()
            Places.Access.ALL_THE_TIME -> enable()
        }
        switch.isChecked = prefs.placesOn
    }

    private fun askBackground() {
        // Android 11 and later show no dialog for this: the request opens the
        // app's location page, where the owner picks "Allow all the time".
        AlertDialog.Builder(this)
            .setTitle(R.string.bg_title)
            .setMessage(R.string.bg_message)
            .setPositiveButton(R.string.bg_continue) { _, _ ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQ_BACKGROUND)
                } else enable()
            }
            .setNegativeButton(R.string.not_now) { _, _ -> denied(getString(R.string.denied_background)) }
            .show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_FOREGROUND -> when {
                Places.access(this) == Places.Access.ALL_THE_TIME -> enable()
                Places.access(this) == Places.Access.FOREGROUND_ONLY -> askBackground()
                else -> denied(getString(R.string.denied_location))
            }
            REQ_BACKGROUND -> if (Places.access(this) == Places.Access.ALL_THE_TIME) enable() else denied(getString(R.string.denied_background))
        }
    }

    private fun enable() {
        prefs.placesOn = true
        prefs.lastError = null
        Jobs.schedule(this)
        Jobs.syncNow(this)
        render()
    }

    /** Says plainly why it stays off, and how to change it. */
    private fun denied(message: String) {
        prefs.placesOn = false
        render()
        AlertDialog.Builder(this)
            .setTitle(R.string.denied_title)
            .setMessage(message)
            .setPositiveButton(R.string.open_settings) { _, _ -> openAppSettings() }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    private fun turnOff() {
        prefs.placesOn = false
        Jobs.schedule(this)
        thread {
            Places.clear(this)
            runOnUiThread { render() }
        }
        render()
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setTitle(R.string.forget_title)
            .setMessage(R.string.forget_message)
            .setPositiveButton(R.string.forget) { _, _ ->
                thread {
                    Places.clear(this)
                    Jobs.cancelAll(this)
                    prefs.forget()
                    runOnUiThread {
                        startActivity(Intent(this, SetupActivity::class.java))
                        finish()
                    }
                }
            }
            .setNegativeButton(R.string.close, null)
            .show()
    }
}
