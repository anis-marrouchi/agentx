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

    fun report(context: Context, id: String, place: String, transition: String, time: Long) {
        val data = Data.Builder()
            .putString("id", id).putString("place", place)
            .putString("transition", transition).putLong("time", time)
            .build()
        val req = OneTimeWorkRequestBuilder<EventWorker>()
            .setInputData(data)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("place-event-$id", ExistingWorkPolicy.KEEP, req)
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

/** Sends one crossing: which place, which way, when. Nothing else. */
class EventWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val base = prefs.baseUrl ?: return Result.success()
        val token = prefs.token ?: return Result.success()
        // Turned off since the crossing: drop it.
        if (!prefs.placesOn) return Result.success()
        val time = inputData.getLong("time", 0)
        // The computer drops old reports anyway (app.places.maxEventAgeMinutes);
        // stop retrying one that can only be dropped.
        if (System.currentTimeMillis() - time > TimeUnit.DAYS.toMillis(1)) return Result.success()
        val event = JSONObject()
            .put("id", inputData.getString("id"))
            .put("place", inputData.getString("place"))
            .put("transition", inputData.getString("transition"))
            .put("time", time)
        return try {
            when (val status = Api.postEvent(base, token, event)) {
                in 200..299 -> Result.success()
                401 -> {
                    prefs.lastError = applicationContext.getString(R.string.err_unpaired)
                    Result.success()
                }
                // Malformed or refused for good (places turned off there): don't retry.
                400, 403, 404 -> Result.success()
                else -> if (status >= 500 || status == 429) Result.retry() else Result.success()
            }
        } catch (e: IOException) {
            Result.retry()
        }
    }
}
