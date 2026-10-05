package dev.agentx.phone

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import java.security.MessageDigest

/**
 * Connect this phone to the computer, turn place reminders on or off, and
 * see which permissions are missing. Every refusal says what it costs and
 * how to change it; nothing here needs the computer's terminal except the
 * pairing code.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var connStatus: TextView
    private lateinit var serverField: EditText
    private lateinit var codeField: EditText
    private lateinit var connectBtn: Button
    private lateinit var disconnectBtn: Button
    private lateinit var openBtn: Button
    private lateinit var placesSwitch: SwitchCompat
    private lateinit var locStatus: TextView
    private lateinit var locBtn: Button
    private lateinit var bgStatus: TextView
    private lateinit var bgBtn: Button
    private lateinit var notifStatus: TextView
    private lateinit var notifBtn: Button
    private lateinit var placesStatus: TextView
    private lateinit var syncBtn: Button
    private lateinit var fingerprint: TextView

    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        markAsked(Manifest.permission.ACCESS_FINE_LOCATION)
        refresh()
        if (Geofences.hasForeground(this) && !Geofences.hasBackground(this)) explainBackground()
    }
    private val askOne = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        refresh()
        if (prefs.placesOn) SyncWorker.now(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = Prefs(this)
        connStatus = findViewById(R.id.conn_status)
        serverField = findViewById(R.id.server)
        codeField = findViewById(R.id.code)
        connectBtn = findViewById(R.id.connect)
        disconnectBtn = findViewById(R.id.disconnect)
        openBtn = findViewById(R.id.open_app)
        placesSwitch = findViewById(R.id.places_switch)
        locStatus = findViewById(R.id.loc_status)
        locBtn = findViewById(R.id.loc_btn)
        bgStatus = findViewById(R.id.bg_status)
        bgBtn = findViewById(R.id.bg_btn)
        notifStatus = findViewById(R.id.notif_status)
        notifBtn = findViewById(R.id.notif_btn)
        placesStatus = findViewById(R.id.places_status)
        syncBtn = findViewById(R.id.sync_now)
        fingerprint = findViewById(R.id.fingerprint)

        connectBtn.setOnClickListener { connect() }
        disconnectBtn.setOnClickListener { confirmDisconnect() }
        openBtn.setOnClickListener { startActivity(Intent(this, LaunchActivity::class.java)); finish() }
        placesSwitch.setOnCheckedChangeListener { _, on -> if (on != prefs.placesOn) setPlaces(on) }
        locBtn.setOnClickListener { askForLocation() }
        bgBtn.setOnClickListener { explainBackground() }
        notifBtn.setOnClickListener { askForNotifications() }
        syncBtn.setOnClickListener {
            SyncWorker.now(this)
            Toast.makeText(this, R.string.syncing, Toast.LENGTH_SHORT).show()
            placesStatus.postDelayed({ refresh() }, 4000)
        }
        findViewById<Button>(R.id.copy_fingerprint).setOnClickListener {
            val cm = getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText("fingerprint", fingerprint.text))
            Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
        }
        fingerprint.text = signingFingerprint() ?: getString(R.string.unknown)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val connected = prefs.connected
        connStatus.text = if (connected) getString(R.string.connected_as, prefs.deviceName ?: "Phone", prefs.server) else getString(R.string.not_connected)
        serverField.visibility = if (connected) View.GONE else View.VISIBLE
        codeField.visibility = if (connected) View.GONE else View.VISIBLE
        connectBtn.visibility = if (connected) View.GONE else View.VISIBLE
        disconnectBtn.visibility = if (connected) View.VISIBLE else View.GONE
        openBtn.visibility = if (connected) View.VISIBLE else View.GONE

        placesSwitch.isEnabled = connected
        placesSwitch.isChecked = prefs.placesOn
        val fg = Geofences.hasForeground(this)
        val bg = Geofences.hasBackground(this)
        val nt = Geofences.hasNotifications(this)
        locStatus.text = getString(if (fg) R.string.loc_ok else R.string.loc_missing)
        locBtn.visibility = if (fg) View.GONE else View.VISIBLE
        bgStatus.text = getString(if (bg) R.string.bg_ok else R.string.bg_missing)
        bgBtn.visibility = if (bg || !fg) View.GONE else View.VISIBLE
        notifStatus.text = getString(if (nt) R.string.notif_ok else R.string.notif_missing)
        notifBtn.visibility = if (nt) View.GONE else View.VISIBLE
        syncBtn.isEnabled = connected && prefs.placesOn

        val lines = mutableListOf<String>()
        if (!prefs.placesOn) lines.add(getString(R.string.places_off))
        else if (!fg || !bg) lines.add(getString(R.string.places_need_permission))
        else lines.add(resources.getQuantityString(R.plurals.watching, prefs.watching, prefs.watching))
        if (prefs.lastSyncAt > 0) lines.add(getString(R.string.last_sync, DateUtils.getRelativeTimeSpanString(prefs.lastSyncAt)))
        prefs.lastEvent?.let { lines.add(getString(R.string.last_event, it)) }
        prefs.problem?.let { if (prefs.placesOn) lines.add(it) }
        placesStatus.text = lines.joinToString("\n")
    }

    private fun connect() {
        val typed = serverField.text.toString()
        val code = codeField.text.toString()
        val link = Protocol.parsePairLink(typed)
        val server = link?.origin ?: Protocol.normalizeServer(typed)
        if (server == null) { connStatus.setText(R.string.bad_server); return }
        if (link == null && Protocol.normalizeCode(code).length != 8) { connStatus.setText(R.string.bad_code); return }
        connectBtn.isEnabled = false
        connStatus.setText(R.string.connecting)
        Thread {
            val result = try {
                val token = link?.token ?: Api.redeemCode(server, code)
                val name = Api.me(server, token)
                Triple(token, name, null as String?)
            } catch (e: ApiError) {
                Triple(null, null, if (e.status == 429) getString(R.string.too_many) else e.message)
            } catch (e: Exception) {
                Triple(null, null, getString(R.string.unreachable, e.message ?: e.javaClass.simpleName))
            }
            runOnUiThread {
                connectBtn.isEnabled = true
                val (token, name, error) = result
                if (token == null) { connStatus.text = error; return@runOnUiThread }
                prefs.server = server
                prefs.token = token
                prefs.deviceName = name
                prefs.webPaired = false
                codeField.setText("")
                refresh()
                if (prefs.placesOn) SyncWorker.now(this)
            }
        }.start()
    }

    private fun confirmDisconnect() {
        AlertDialog.Builder(this)
            .setTitle(R.string.disconnect)
            .setMessage(R.string.disconnect_explain)
            .setPositiveButton(R.string.disconnect) { _, _ ->
                SyncWorker.stop(this)
                Thread { Geofences.clear(this) }.start()
                prefs.disconnect()
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun setPlaces(on: Boolean) {
        prefs.placesOn = on
        if (on) {
            prefs.problem = null
            if (!Geofences.hasForeground(this)) askForLocation()
            else if (!Geofences.hasBackground(this)) explainBackground()
            SyncWorker.now(this)
            SyncWorker.schedule(this)
        } else {
            SyncWorker.stop(this)
            Thread { Geofences.clear(this) }.start()
        }
        refresh()
    }

    private fun askForLocation() {
        val p = Manifest.permission.ACCESS_FINE_LOCATION
        if (wasAsked(p) && !shouldShowRequestPermissionRationale(p)) { openAppSettings(); return }
        askLocation.launch(arrayOf(p, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    /** Google's rule, and the honest thing: say why before asking for "all the time". */
    private fun explainBackground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        AlertDialog.Builder(this)
            .setTitle(R.string.bg_title)
            .setMessage(R.string.bg_explain)
            .setPositiveButton(R.string.continue_label) { _, _ ->
                val p = Manifest.permission.ACCESS_BACKGROUND_LOCATION
                // On Android 11 and later this opens the location settings page.
                if (wasAsked(p) && !shouldShowRequestPermissionRationale(p) && Build.VERSION.SDK_INT < Build.VERSION_CODES.R) openAppSettings()
                else { markAsked(p); askOne.launch(p) }
            }
            .setNegativeButton(R.string.not_now, null)
            .show()
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val p = Manifest.permission.POST_NOTIFICATIONS
        if (wasAsked(p) && !shouldShowRequestPermissionRationale(p)) { openAppSettings(); return }
        markAsked(p)
        askOne.launch(p)
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun wasAsked(p: String) = getSharedPreferences("asked", MODE_PRIVATE).getBoolean(p, false)
    private fun markAsked(p: String) = getSharedPreferences("asked", MODE_PRIVATE).edit().putBoolean(p, true).apply()

    /** SHA-256 of this build's signing certificate, for places.android.sha256CertFingerprints. */
    @Suppress("DEPRECATION")
    private fun signingFingerprint(): String? = try {
        val sig = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners?.firstOrNull()
        } else {
            packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()
        }
        sig?.let { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString(":") { "%02X".format(it) } }
    } catch (e: Exception) {
        null
    }
}
