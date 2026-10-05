package dev.agentx.phone

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Scheduling for the two background jobs: checking for changed places,
 *  and reporting a crossing. Both wait for a network and survive restarts. */
object Jobs {
    private const val SYNC_PERIODIC = "places-sync"
    private const val SYNC_NOW = "places-sync-now"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun syncNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniqueWork(SYNC_NOW, ExistingWorkPolicy.REPLACE, req)
    }

    /** Checks every app.places.syncMinutes while place reminders are on. */
    fun schedule(context: Context) {
        val prefs = Prefs(context)
        val wm = WorkManager.getInstance(context)
        if (!prefs.paired || !prefs.placesOn) {
            wm.cancelUniqueWork(SYNC_PERIODIC)
            return
        }
        val req = PeriodicWorkRequestBuilder<SyncWorker>(prefs.syncMinutes.toLong(), TimeUnit.MINUTES).setConstraints(online).build()
        wm.enqueueUniquePeriodicWork(SYNC_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    fun cancelAll(context: Context) {
        WorkManager.getInstance(context).cancelAllWork()
    }

    fun report(context: Context, crossing: Crossing) {
        val data = Data.Builder()
            .putString("id", crossing.id).putString("place", crossing.place)
            .putString("transition", crossing.transition).putLong("time", crossing.time)
            .build()
        val req = OneTimeWorkRequestBuilder<EventWorker>()
            .setInputData(data)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(eventWork(crossing.id), ExistingWorkPolicy.KEEP, req)
    }

    /** Sent already (or not worth sending): the queued copy is not needed. */
    fun reported(context: Context, id: String) {
        WorkManager.getInstance(context).cancelUniqueWork(eventWork(id))
    }

    private fun eventWork(id: String) = "place-event-$id"
}

/** One crossing: which place, which way, when. Nothing else. */
data class Crossing(val id: String, val place: String, val transition: String, val time: Long)

object Report {
    /**
     * Sends one crossing to the computer. Returns false when it should be
     * tried again later (offline, or the computer is busy). The computer
     * fires a crossing once even if it arrives twice, by its id.
     */
    fun send(context: Context, crossing: Crossing, quick: Boolean = false): Boolean {
        val prefs = Prefs(context)
        val base = prefs.baseUrl ?: return true
        val token = prefs.token ?: return true
        // Turned off since the crossing: drop it.
        if (!prefs.placesOn) return true
        // The computer drops old reports anyway (app.places.maxEventAgeMinutes);
        // stop retrying one that can only be dropped.
        if (System.currentTimeMillis() - crossing.time > TimeUnit.DAYS.toMillis(1)) return true
        val event = JSONObject()
            .put("id", crossing.id)
            .put("place", crossing.place)
            .put("transition", crossing.transition)
            .put("time", crossing.time)
        return try {
            when (val status = Api.postEvent(base, token, event, quick)) {
                in 200..299 -> true
                401 -> {
                    prefs.lastError = context.getString(R.string.err_unpaired)
                    true
                }
                // Malformed or refused for good (places turned off there): don't retry.
                400, 403, 404 -> true
                else -> !(status >= 500 || status == 429)
            }
        } catch (e: IOException) {
            false
        }
    }
}

class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val before = Prefs(applicationContext).syncMinutes
        val ok = Places.sync(applicationContext)
        if (Prefs(applicationContext).syncMinutes != before) Jobs.schedule(applicationContext)
        return if (ok || runAttemptCount >= 5) Result.success() else Result.retry()
    }
}

/** Sends a crossing that could not be sent at once, when there is a network. */
class EventWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val crossing = Crossing(
            inputData.getString("id") ?: return Result.success(),
            inputData.getString("place") ?: return Result.success(),
            inputData.getString("transition") ?: return Result.success(),
            inputData.getLong("time", 0),
        )
        return if (Report.send(applicationContext, crossing)) Result.success() else Result.retry()
    }
}
