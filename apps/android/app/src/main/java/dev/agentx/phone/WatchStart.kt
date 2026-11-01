package dev.agentx.phone

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import android.telecom.CallRedirectionService
import android.telecom.PhoneAccountHandle
import android.util.Log

// Start Talk to AgentX from the watch (#1664).
//
// The watch runs no apps, but it can call a contact through the phone. So
// the owner keeps an "AgentX" contact with WatchNumber.NUMBER, which the
// watch's own phone app syncs to the watch. Calling it from the watch
// places a call on the phone; this app holds Android's call-redirect role,
// so it sees the number first, cancels that call before it reaches the SIM
// and rings the watch with Talk's own call, which answers by itself. Every
// other number goes out unchanged.

object WatchStart {
    private const val TAG = "AgentXTalk"

    /** The call-redirect role needs Android 10. */
    fun available(ctx: Context): Boolean = Build.VERSION.SDK_INT >= 29 &&
        ctx.getSystemService(RoleManager::class.java).isRoleAvailable(RoleManager.ROLE_CALL_REDIRECTION)

    fun on(ctx: Context): Boolean = available(ctx) &&
        ctx.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_CALL_REDIRECTION)

    /** Android's own question: let AgentX redirect calls? */
    fun askRole(ctx: Context): Intent? =
        if (Build.VERSION.SDK_INT >= 29) ctx.getSystemService(RoleManager::class.java).createRequestRoleIntent(RoleManager.ROLE_CALL_REDIRECTION) else null

    /** The phone's Contacts app, filled in with the AgentX contact for the owner to save. */
    fun contactForm(ctx: Context): Intent = Intent(Intent.ACTION_INSERT, ContactsContract.Contacts.CONTENT_URI)
        .putExtra(ContactsContract.Intents.Insert.NAME, ctx.getString(R.string.app_name))
        .putExtra(ContactsContract.Intents.Insert.PHONE, WatchNumber.NUMBER)
        .putExtra(ContactsContract.Intents.Insert.PHONE_TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_OTHER)

    /** Starts the call service while Telecom still has this app bound; the
     *  Talk screen does it when Android refuses a start from the background. */
    fun ringBack(ctx: Context) {
        try {
            TalkService.start(ctx, fromWatch = true)
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (Android 12+) is one.
            Log.w(TAG, "call service refused in the background; opening the Talk screen", e)
            try {
                ctx.startActivity(
                    Intent(ctx, TalkActivity::class.java)
                        .setAction(TalkActivity.ACTION_TALK)
                        .putExtra(TalkService.EXTRA_FROM_WATCH, true)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (e2: RuntimeException) {
                Log.w(TAG, "could not open the Talk screen either", e2)
            }
        }
    }
}

/** Sees each call the phone places while AgentX holds the call-redirect role. */
class WatchRedirectionService : CallRedirectionService() {
    override fun onPlaceCall(handle: Uri, initialPhoneAccount: PhoneAccountHandle, allowInteractiveResponse: Boolean) {
        if (!WatchNumber.matches(handle.schemeSpecificPart)) {
            placeCallUnmodified()
            return
        }
        Log.i("AgentXTalk", "AgentX was dialled; cancelling the phone call and ringing the watch back")
        WatchStart.ringBack(applicationContext)
        cancelCall()
    }
}
