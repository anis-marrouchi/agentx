package dev.agentx.phone.watchspike

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.telecom.DisconnectCause
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.text.InputType
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.agentx.phone.Api
import dev.agentx.phone.Prefs
import dev.agentx.phone.R
import java.io.IOException
import kotlin.concurrent.thread

/**
 * The spike's screen (debug builds only). Top: the watch-side start
 * (#1664): pair, set up, then call the AgentX contact from the watch.
 * Below: the step-1 audio checks (#1636). The log of each run is at the
 * bottom. Pair the watch with the phone as a headset first.
 */
class WatchSpikeActivity : Activity() {
    companion object {
        private const val ROLE_REQUEST = 2
    }

    private lateinit var log: TextView
    private lateinit var status: TextView
    private val settings by lazy { WatchStart.settings(this) }
    private var phoneListener: PhoneStateListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The microphone only works for the app on screen (Android 11+), so the screen stays on.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun button(label: String, onClick: () -> Unit) = column.addView(Button(this).apply { text = label; setOnClickListener { onClick() } })
        fun label(t: String) = column.addView(TextView(this).apply { text = t; setPadding(0, pad, 0, 0) })
        fun field(value: String, hint: String) = EditText(this).apply { setText(value); this.hint = hint; isSingleLine = true }.also { column.addView(it) }

        label("Start the agent from the watch (#1664)")
        status = TextView(this).also { column.addView(it) }

        val prefs = Prefs(this)
        val address = field(prefs.baseUrl ?: getString(R.string.watch_default_address), "Computer address (https://…)")
        val code = field("", "Pairing code (agentx app pair)").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS }
        button("Pair") { pair(address.text.toString(), code.text.toString()) }

        label("Agent")
        val agent = field(settings.agent, "Agent id")
        label("AgentX number (not a real line)")
        val number = field(settings.number, "Number").apply { inputType = InputType.TYPE_CLASS_PHONE }
        val auto = CheckBox(this).apply { text = "Answer by itself (no tap on the watch)"; isChecked = settings.autoAnswer }
        column.addView(auto)
        button("Save and set up") {
            settings.agent = agent.text.toString().trim().ifEmpty { "secretary-agent" }
            settings.autoAnswer = auto.isChecked
            val n = AgentNumber.normalise(number.text.toString())
            if (WatchStart.isEmergency(this, n)) SpikeLog.add("REFUSED $n is an emergency number here. Kept ${settings.number}.")
            else settings.number = n
            setUp()
        }
        button("Ring the watch with the agent (no watch dial)") { if (ready()) WatchStart.ringBack(this) }
        button("Hang up") { SpikeConnection.current?.end(DisconnectCause.LOCAL) ?: SpikeLog.add("No call") }
        button("Send this log to the agent") { sendLog() }

        label("Step 1 audio checks (#1636)")
        button("Call the watch (outgoing)") { if (ready()) place() }
        button("Ring the watch (incoming)") { if (ready()) ring() }
        button("Answer") { SpikeConnection.current?.let { it.answeredOnPhone = true; it.onAnswer() } ?: SpikeLog.add("No call is ringing") }
        button("Clear the log") { SpikeLog.clear() }

        log = TextView(this).apply { setTextIsSelectable(true); setPadding(0, pad, 0, 0) }
        column.addView(log)
        setContentView(ScrollView(this).apply { addView(column) })

        SpikeLog.add("Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
    }

    override fun onResume() {
        super.onResume()
        log.text = SpikeLog.text()
        SpikeLog.listener = { log.text = it }
        showStatus()
        watchPhoneCalls()
    }

    override fun onPause() {
        SpikeLog.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        stopWatchingPhoneCalls()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == ROLE_REQUEST) {
            SpikeLog.add(if (resultCode == RESULT_OK) "This app now redirects calls (role granted)" else "FAIL the call-redirect role was not granted")
            setUp()
        }
    }

    /** What is ready, in one line. */
    private fun showStatus() {
        val prefs = Prefs(this)
        val role = roleHeld()
        status.text = listOf(
            if (prefs.paired) "Paired with ${prefs.baseUrl}" else "Not paired: type a code from `agentx app pair`",
            if (role) "Redirects calls: yes" else "Redirects calls: no (tap Save and set up)",
            "Watch dials ${settings.number} → ${settings.agent}",
        ).joinToString("\n")
    }

    private fun roleHeld(): Boolean = Build.VERSION.SDK_INT >= 29 &&
        getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION)

    private fun pair(addressText: String, codeText: String) {
        val base = Api.normaliseAddress(addressText) ?: return SpikeLog.add("That address doesn't look right (https://…)")
        val raw = codeText.uppercase().filter { it.isLetterOrDigit() }
        if (raw.length != 8) return SpikeLog.add("The pairing code has 8 letters and digits")
        SpikeLog.add("Pairing with $base…")
        thread {
            try {
                val token = Api.pairWithCode(base, raw.substring(0, 4) + "-" + raw.substring(4))
                Prefs(this).apply { baseUrl = base; this.token = token }
                SpikeLog.add("PASS paired")
            } catch (e: IOException) {
                SpikeLog.add("FAIL pairing: ${e.message}")
            }
            runOnUiThread { showStatus() }
        }
    }

    /** Permissions, then the call-redirect role, then the contact. Each tap moves one step on. */
    private fun setUp() {
        if (!ready(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) return
        if (Build.VERSION.SDK_INT < 29) return SpikeLog.add("FAIL call redirection needs Android 10 or newer")
        val roles = getSystemService(RoleManager::class.java)
        if (!roles.isRoleAvailable(RoleManager.ROLE_CALL_REDIRECTION)) return SpikeLog.add("FAIL this phone has no call-redirect role")
        if (!roles.isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION)) {
            SpikeLog.add("Asking for the call-redirect role…")
            @Suppress("DEPRECATION")
            startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_CALL_REDIRECTION), ROLE_REQUEST)
            return
        }
        try {
            SpikeLog.add(WatchStart.addContact(this))
        } catch (e: Exception) {
            SpikeLog.add("FAIL adding the contact: ${e.message}")
        }
        watchPhoneCalls()
        showStatus()
        SpikeLog.add("Ready. Sync the AgentX contact to the watch in Mi Fitness, then call it from the watch.")
    }

    /**
     * A's failure shows here: a phone call starts and redirection never saw
     * it. Self-managed calls don't count as phone calls, so the agent call
     * doesn't trip it; a call answered after ringing is skipped too.
     */
    @Suppress("DEPRECATION")
    private fun watchPhoneCalls() {
        if (phoneListener != null || checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return
        val listener = object : PhoneStateListener() {
            private var last = TelephonyManager.CALL_STATE_IDLE
            @Deprecated("Deprecated in Java")
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                val before = last
                last = state
                if (state != TelephonyManager.CALL_STATE_OFFHOOK || before != TelephonyManager.CALL_STATE_IDLE) return
                val now = SystemClock.elapsedRealtime()
                if (now - WatchStart.redirectedAt < 15_000) return
                SpikeLog.add("RESULT A: FAIL a phone call started without passing through AgentX's redirection. " +
                    "If it was the watch calling AgentX, this phone skips redirection for watch calls: hang up on the watch, " +
                    "then use \"Ring the watch with the agent\" to talk instead.")
            }
        }
        getSystemService(TelephonyManager::class.java).listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
        phoneListener = listener
    }

    @Suppress("DEPRECATION")
    private fun stopWatchingPhoneCalls() {
        phoneListener?.let { getSystemService(TelephonyManager::class.java).listen(it, PhoneStateListener.LISTEN_NONE) }
        phoneListener = null
    }

    /** Posts the log as a chat message to the agent, so the result reaches the computer without a cable. */
    private fun sendLog() {
        val prefs = Prefs(this)
        val base = prefs.baseUrl
        val token = prefs.token
        if (base == null || token == null) return SpikeLog.add("Pair first")
        val text = "Watch start log (#1664), from the AgentX watch spike app:\n\n" + SpikeLog.text().takeLast(7_000)
        SpikeLog.add("Sending the log to ${settings.agent}…")
        thread {
            try {
                AgentClient(base, token).ask(text, null, settings.node, settings.agent)
                SpikeLog.add("PASS log sent")
            } catch (e: IOException) {
                SpikeLog.add("FAIL sending the log: ${e.message}")
            }
        }
    }

    /** Microphone (and on Android 12+, nearby devices) plus [more]; then the phone account. */
    private fun ready(vararg more: String): Boolean {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO, *more)
        if (Build.VERSION.SDK_INT >= 31) needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            SpikeLog.add("Allow ${missing.joinToString { it.substringAfterLast('.') }} and tap again")
            requestPermissions(missing.toTypedArray(), 1)
            return false
        }
        SpikeAccount.register(this)
        return true
    }

    private fun place() {
        val telecom = getSystemService(TelecomManager::class.java)
        val handle = SpikeAccount.handle(this)
        if (Build.VERSION.SDK_INT >= 28 && !telecom.isOutgoingCallPermitted(handle)) {
            SpikeLog.add("FAIL Telecom does not permit a call now (another call active?)")
            return
        }
        SpikeLog.add("Placing the call…")
        telecom.placeCall(SpikeAccount.address, Bundle().apply { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle) })
    }

    private fun ring() {
        val telecom = getSystemService(TelecomManager::class.java)
        val handle = SpikeAccount.handle(this)
        if (Build.VERSION.SDK_INT >= 28 && !telecom.isIncomingCallPermitted(handle)) {
            SpikeLog.add("FAIL Telecom does not permit a call now (another call active?)")
            return
        }
        SpikeLog.add("Ringing…")
        telecom.addNewIncomingCall(handle, Bundle())
    }
}
