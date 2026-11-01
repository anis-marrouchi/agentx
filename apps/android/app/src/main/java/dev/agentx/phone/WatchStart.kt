package dev.agentx.phone

import android.annotation.TargetApi
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import android.telecom.CallRedirectionService
import android.telecom.PhoneAccountHandle
import android.telephony.TelephonyManager
import android.util.Log

// Start a call from the watch (#1664). A watch that runs no apps can still
// call a contact for the phone over Bluetooth. So the owner adds an
// "AgentX" contact (a number that is never a real line) and calls it from
// the watch. This app holds Android's call-redirect role: it sees the
// number before the SIM dials it, cancels that call, and rings the watch
// back with its own call, the direction that puts the watch's microphone on
// the call (#1636). Every other number goes out unchanged.
//
// Proven on a POCO X3 (Android 12) with a Redmi Watch 6 Lite in the #1664
// spike: the phone call is cancelled before it reaches the network, the
// ring-back comes 2–4 s later, and the watch's microphone works when the
// app answers with its screen in front, or holds the microphone in a
// foreground service. The redirect starts that service while Telecom still
// has it bound; Xiaomi silently drops a Talk screen opened from there.

object WatchStart {
    /** The Talk screen opened by a watch call: ring the watch back. */
    const val ACTION_WATCH = "dev.agentx.phone.action.WATCH_CALL"
    private const val TAG = "AgentXTalk"

    /** Android 10+ has the call-redirect role. */
    val supported: Boolean get() = Build.VERSION.SDK_INT >= 29

    fun holdsRole(ctx: Context): Boolean =
        supported && ctx.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION) == true

    /** Android's own question, "Make AgentX your call redirect app?", or
     *  null when the phone has no such role. */
    fun roleRequest(ctx: Context): Intent? {
        if (!supported) return null
        val rm = ctx.getSystemService(RoleManager::class.java) ?: return null
        if (!rm.isRoleAvailable(RoleManager.ROLE_CALL_REDIRECTION)) return null
        return rm.createRequestRoleIntent(RoleManager.ROLE_CALL_REDIRECTION)
    }

    /** The phone's Contacts app, filled in with the AgentX contact for the
     *  owner to save. Needs no contacts permission. */
    fun contactIntent(ctx: Context): Intent =
        Intent(ContactsContract.Intents.Insert.ACTION).setType(ContactsContract.RawContacts.CONTENT_TYPE)
            .putExtra(ContactsContract.Intents.Insert.NAME, ctx.getString(R.string.watch_contact_name))
            .putExtra(ContactsContract.Intents.Insert.PHONE, Prefs(ctx).watchNumber)
            .putExtra(ContactsContract.Intents.Insert.PHONE_TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_OTHER)

    /** Never touch a number the phone lists as an emergency number. */
    fun isEmergency(ctx: Context, number: String): Boolean = try {
        Build.VERSION.SDK_INT >= 29 && ctx.getSystemService(TelephonyManager::class.java).isEmergencyNumber(number)
    } catch (e: Exception) {
        Log.w(TAG, "could not check the emergency list", e)
        false
    }

    /** The watch called AgentX: ring it back from the background. Called
     *  while Telecom still has the redirect service bound, which lets the
     *  app start its microphone service. A screen start is no use here:
     *  Xiaomi drops it without an error when the phone is locked or the
     *  app is in the background (#1677 device test). The Talk screen is
     *  only tried when the phone refuses the service, and the watch is rung
     *  either way. */
    fun ringBack(ctx: Context) {
        try {
            TalkService.start(ctx, fromWatch = true)
            Log.i(TAG, "ring-back 1/4: microphone service asked to start")
            return
        } catch (e: RuntimeException) {
            Log.w(TAG, "ring-back 1/4: microphone service refused from the background", e)
        }
        val open = Intent(ctx, TalkActivity::class.java)
            .setAction(ACTION_WATCH)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        try {
            ctx.startActivity(open)
            Log.i(TAG, "ring-back 1/4: Talk screen asked to open (the phone may drop it)")
        } catch (e: RuntimeException) {
            Log.w(TAG, "ring-back 1/4: Talk screen refused", e)
        }
        TalkService.startFromWatch(ctx)
    }
}

/**
 * Sees every call the phone places, the watch's too, while the app holds
 * the call-redirect role. The AgentX number is cancelled and rung back;
 * every other call goes out unchanged at once, and only its last 3 digits
 * reach the log.
 */
@TargetApi(29)
class WatchRedirectionService : CallRedirectionService() {
    override fun onPlaceCall(handle: Uri, initialPhoneAccount: PhoneAccountHandle, allowInteractiveResponse: Boolean) {
        val number = handle.schemeSpecificPart
        val prefs = Prefs(this)
        if (!prefs.watchStartOn || !AgentNumber.matches(number, prefs.watchNumber) || WatchStart.isEmergency(this, number)) {
            placeCallUnmodified()
            return
        }
        Log.i("AgentXTalk", "watch call to AgentX (${AgentNumber.masked(number)}): ringing back, then cancelling the phone call")
        // Ring back first: once the call is cancelled Telecom unbinds this
        // service, and with it the app's leave to start from the background.
        if (!prefs.paired || prefs.talkTarget == null) {
            TalkState.set(getString(R.string.watch_pick_first), active = false)
        } else {
            WatchStart.ringBack(applicationContext)
        }
        cancelCall()
        Log.i("AgentXTalk", "watch call to AgentX: phone call cancelled")
    }
}
