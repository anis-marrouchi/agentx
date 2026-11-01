package dev.agentx.phone

import android.app.ActivityManager
import android.app.KeyguardManager
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

// What the audio system does during a watch call, for the log only (#1664,
// device try 5). Try 4 saw Telecom report the watch while nothing was heard
// either way; this logs the Bluetooth SCO link, the audio mode, the
// communication device, what plays and what records, and whether the phone
// is locked, so the next try tells which one is missing.
class TalkAudioLog(private val ctx: Context) {
    companion object {
        private const val TAG = "AgentXTalk"

        private fun modeName(m: Int) = when (m) {
            AudioManager.MODE_NORMAL -> "NORMAL"
            AudioManager.MODE_RINGTONE -> "RINGTONE"
            AudioManager.MODE_IN_CALL -> "IN_CALL"
            AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
            else -> "mode $m"
        }

        private fun scoName(s: Int) = when (s) {
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> "DISCONNECTED"
            AudioManager.SCO_AUDIO_STATE_CONNECTING -> "CONNECTING"
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> "CONNECTED"
            AudioManager.SCO_AUDIO_STATE_ERROR -> "ERROR"
            else -> "state $s"
        }

        private fun usageName(u: Int) = when (u) {
            AudioAttributes.USAGE_VOICE_COMMUNICATION -> "voice call"
            AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING -> "call tones"
            AudioAttributes.USAGE_MEDIA -> "media"
            AudioAttributes.USAGE_NOTIFICATION_RINGTONE -> "ringtone"
            AudioAttributes.USAGE_ASSISTANT -> "assistant"
            else -> "usage $u"
        }

        private fun device(d: AudioDeviceInfo?) = if (d == null) "none" else "${d.productName} (type ${d.type})"

        /** One line: mode, communication device, SCO, locked, app importance. */
        @Suppress("DEPRECATION")
        fun state(ctx: Context): String = try {
            val audio = ctx.getSystemService(AudioManager::class.java)
            val comm = if (Build.VERSION.SDK_INT >= 31) device(audio.communicationDevice) else "n/a"
            val locked = ctx.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked
            val me = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }
            "mode ${modeName(audio.mode)}, comm device $comm, scoOn ${audio.isBluetoothScoOn}, " +
                "voice call vol ${audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)}/${audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)}, " +
                "locked $locked, importance ${me.importance}"
        } catch (e: RuntimeException) {
            "audio state unknown: ${e.message}"
        }
    }

    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var on = false

    private val sco = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            i ?: return
            if (i.action == BluetoothHeadset.ACTION_AUDIO_STATE_CHANGED) {
                // The watch's own audio link, as Telecom drives it.
                val now = when (i.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)) {
                    BluetoothHeadset.STATE_AUDIO_CONNECTED -> "CONNECTED"
                    BluetoothHeadset.STATE_AUDIO_CONNECTING -> "CONNECTING"
                    BluetoothHeadset.STATE_AUDIO_DISCONNECTED -> "DISCONNECTED"
                    else -> "state ${i.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)}"
                }
                Log.i(TAG, "watch audio link (HFP): $now")
                return
            }
            val now = i.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
            val was = i.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_PREVIOUS_STATE, -1)
            Log.i(TAG, "SCO link: ${scoName(was)} → ${scoName(now)}")
        }
    }

    private val playing = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>?) {
            val voice = configs.orEmpty().joinToString { usageName(it.audioAttributes.usage) }
            Log.i(TAG, "playing now: ${voice.ifEmpty { "nothing" }}")
        }
    }

    private val recording = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
            val ours = configs.orEmpty().joinToString { r ->
                val silenced = if (Build.VERSION.SDK_INT >= 29) r.isClientSilenced.toString() else "n/a"
                "source ${r.clientAudioSource} on ${device(r.audioDevice)}, silenced $silenced"
            }
            Log.i(TAG, "recording now: ${ours.ifEmpty { "nothing" }}")
        }
    }

    private val modeChanged by lazy {
        AudioManager.OnModeChangedListener { m -> Log.i(TAG, "audio mode now ${modeName(m)}") }
    }
    private val commChanged by lazy {
        AudioManager.OnCommunicationDeviceChangedListener { d -> Log.i(TAG, "communication device now ${device(d)}") }
    }

    fun start() {
        if (on) return
        on = true
        Log.i(TAG, "call audio at start: ${state(ctx)}")
        try {
            // The headset one needs BLUETOOTH_CONNECT; without it only the SCO one comes.
            val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED).apply { addAction(BluetoothHeadset.ACTION_AUDIO_STATE_CHANGED) }
            // Exported: the headset one comes from Bluetooth's own process; both are protected broadcasts.
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(sco, filter, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(sco, filter)
            audio.registerAudioPlaybackCallback(playing, main)
            audio.registerAudioRecordingCallback(recording, main)
            if (Build.VERSION.SDK_INT >= 31) {
                audio.addOnModeChangedListener(ctx.mainExecutor, modeChanged)
                audio.addOnCommunicationDeviceChangedListener(ctx.mainExecutor, commChanged)
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "audio log could not listen", e)
        }
    }

    fun stop() {
        if (!on) return
        on = false
        Log.i(TAG, "call audio at end: ${state(ctx)}")
        try { ctx.unregisterReceiver(sco) } catch (e: RuntimeException) { Log.w(TAG, "SCO log already gone", e) }
        audio.unregisterAudioPlaybackCallback(playing)
        audio.unregisterAudioRecordingCallback(recording)
        if (Build.VERSION.SDK_INT >= 31) {
            audio.removeOnModeChangedListener(modeChanged)
            audio.removeOnCommunicationDeviceChangedListener(commChanged)
        }
    }
}
