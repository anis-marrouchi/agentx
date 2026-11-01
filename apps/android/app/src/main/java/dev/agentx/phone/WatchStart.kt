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
// app answers with its screen in front. That is why the redirect opens the
// Talk screen (over the lock screen) instead of ringing from the background.

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

    /** The watch called AgentX: open the Talk screen, which rings it back.
     *  A CallRedirectionService bound by Telecom may start an activity from
     *  the background; if the phone refuses anyway, ring without it. */
    fun ringBack(ctx: Context) {
        val open = Intent(ctx, TalkActivity::class.java)
            .setAction(ACTION_WATCH)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        try {
            ctx.startActivity(open)
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not open the Talk screen; ringing from the background", e)
            TalkService.startFromWatch(ctx)
        }
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
        Log.i("AgentXTalk", "watch call to AgentX (${AgentNumber.masked(number)}): phone call cancelled, ringing back")
        cancelCall()
        if (!prefs.paired || prefs.talkTarget == null) {
            TalkState.set(getString(R.string.watch_pick_first), active = false)
            return
        }
        WatchStart.ringBack(applicationContext)
    }
}
