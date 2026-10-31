package dev.agentx.phone.watchspike

import android.content.ContentProviderOperation
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.telecom.CallRedirectionService
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.TelephonyManager

// Watch-side start (#1664), debug builds only.
//
// The watch runs no apps, but it can call a contact over Bluetooth. So:
// an "AgentX" contact on the phone, synced to the watch; the watch dials
// it; this app holds the call-redirection role, sees the number, cancels
// the SIM call and rings the watch with its own self-managed call (the
// incoming path that passed in #1636). Answering on the watch starts
// AgentLoop. Three things are unproven on the real phone and are logged
// as RESULT lines:
//   A. a call dialed on the watch passes through CallRedirectionService;
//   B. the ring-back reaches the watch and is answered there (or, with
//      "Answer by itself" on, gets audio without a tap);
//   C. hanging up on the watch reaches the app (onDisconnect).

/** What the owner set on the screen. */
class WatchSettings(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("watchstart", Context.MODE_PRIVATE)
    var number: String
        get() = p.getString("number", AgentNumber.DEFAULT) ?: AgentNumber.DEFAULT
        set(v) = p.edit().putString("number", v).apply()
    var agent: String
        get() = p.getString("agent", "secretary-agent") ?: "secretary-agent"
        set(v) = p.edit().putString("agent", v).apply()
    var node: String
        get() = p.getString("node", "local") ?: "local"
        set(v) = p.edit().putString("node", v).apply()
    var autoAnswer: Boolean
        get() = p.getBoolean("autoAnswer", false)
        set(v) = p.edit().putBoolean("autoAnswer", v).apply()
}

object WatchStart {
    const val EXTRA_AGENT = "dev.agentx.watchspike.AGENT"

    fun settings(ctx: Context) = WatchSettings(ctx)

    /** When each probe step last happened (elapsed ms), for the RESULT lines. */
    @Volatile var redirectedAt = 0L
    @Volatile var ringAt = 0L

    /** Rings the watch with the agent call. Waits up to 5 s for Telecom to allow it. */
    fun ringBack(ctx: Context, attempt: Int = 1) {
        SpikeAccount.register(ctx)
        val telecom = ctx.getSystemService(TelecomManager::class.java)
        val handle = SpikeAccount.handle(ctx)
        if (Build.VERSION.SDK_INT >= 28 && !telecom.isIncomingCallPermitted(handle)) {
            if (attempt < 5) {
                Handler(Looper.getMainLooper()).postDelayed({ ringBack(ctx, attempt + 1) }, 1000)
                return
            }
            SpikeLog.add("RESULT B: FAIL Telecom does not permit the ring-back (another call is still active)")
            return
        }
        ringAt = android.os.SystemClock.elapsedRealtime()
        val extras = Bundle().apply {
            putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, Bundle().apply { putBoolean(EXTRA_AGENT, true) })
        }
        SpikeLog.add("Ringing the watch with the AgentX call…")
        telecom.addNewIncomingCall(handle, extras)
    }

    /** Adds the AgentX contact to the phone unless a contact already has the number. */
    fun addContact(ctx: Context): String {
        val number = settings(ctx).number
        val lookup = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        ctx.contentResolver.query(lookup, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) return "The contact \"${it.getString(0)}\" already has $number."
        }
        val ops = arrayListOf(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, "AgentX").build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_OTHER).build(),
        )
        ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        return "Added the contact AgentX ($number) on the phone."
    }

    /** Refuses a number the phone treats as an emergency number. */
    fun isEmergency(ctx: Context, number: String): Boolean = try {
        Build.VERSION.SDK_INT >= 29 && ctx.getSystemService(TelephonyManager::class.java).isEmergencyNumber(number)
    } catch (e: Exception) {
        SpikeLog.add("Could not check the emergency list: ${e.message}")
        false
    }
}

/**
 * Sees every call the phone places while this app holds the
 * call-redirection role. Ours is cancelled and rung back as the agent
 * call; any other number goes out unchanged, and only its last 3 digits
 * are logged.
 */
class WatchRedirectionService : CallRedirectionService() {
    override fun onPlaceCall(handle: Uri, initialPhoneAccount: PhoneAccountHandle, allowInteractiveResponse: Boolean) {
        val number = handle.schemeSpecificPart
        val ours = WatchStart.settings(this).number
        if (!AgentNumber.matches(number, ours)) {
            SpikeLog.add("Redirection saw a call to ${AgentNumber.masked(number)}: not AgentX, left alone")
            placeCallUnmodified()
            return
        }
        WatchStart.redirectedAt = android.os.SystemClock.elapsedRealtime()
        SpikeLog.add("RESULT A: PASS the call to AgentX passed through redirection; the SIM call is cancelled")
        cancelCall()
        // Give Telecom a moment to drop the cancelled call before ringing.
        val app = applicationContext
        Handler(Looper.getMainLooper()).postDelayed({ WatchStart.ringBack(app) }, 1500)
    }
}
