package dev.agentx.phone.watchspike

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.telecom.DisconnectCause
import android.telecom.TelecomManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The spike's screen (#1636, debug builds only): call the watch, ring it,
 * answer, hang up, and the log of each run. Pair the watch with the phone
 * as a headset first, as for WhatsApp calls.
 */
class WatchSpikeActivity : Activity() {
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun button(label: String, onClick: () -> Unit) = column.addView(Button(this).apply { text = label; setOnClickListener { onClick() } })

        button("Call the watch (outgoing)") { if (ready()) place() }
        button("Ring the watch (incoming)") { if (ready()) ring() }
        button("Answer") { SpikeConnection.current?.answerHere() ?: SpikeLog.add("No call is ringing") }
        button("Hang up") { SpikeConnection.current?.let { SpikeLog.add("Hung up on the spike screen"); it.end(DisconnectCause.LOCAL) } ?: SpikeLog.add("No call") }
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
    }

    override fun onPause() {
        SpikeLog.listener = null
        super.onPause()
    }

    /** Microphone (and on Android 12+, nearby devices) first; then the phone account. */
    private fun ready(): Boolean {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31) needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            SpikeLog.add("Allow ${missing.joinToString()} and tap again")
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
