package dev.agentx.phone

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

private const val TAG = "AgentXPlaces"

private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

/** Sends one place event, retrying until the computer has it. */
class EventWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val json = inputData.getString(KEY) ?: return Result.failure()
        return when (attempt(applicationContext, json)) {
            Outcome.SENT, Outcome.DROP -> Result.success()
            Outcome.RETRY -> if (runAttemptCount < 20) Result.retry() else Result.failure()
        }
    }

    enum class Outcome { SENT, DROP, RETRY }

    companion object {
        private const val KEY = "event"

        /** True when the computer took it, or refused it for good. */
        fun sendNow(ctx: Context, json: String): Boolean = attempt(ctx, json) != Outcome.RETRY

        fun enqueue(ctx: Context, json: String) {
            val req = OneTimeWorkRequestBuilder<EventWorker>()
                .setInputData(workDataOf(KEY to json))
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueue(req)
        }

        private fun attempt(ctx: Context, json: String): Outcome {
            val prefs = Prefs(ctx)
            val server = prefs.server ?: return Outcome.DROP
            val token = prefs.token ?: return Outcome.DROP
            return try {
                Api.postEvent(server, token, json)
                Outcome.SENT
            } catch (e: ApiError) {
                Log.w(TAG, "event refused: ${e.status} ${e.message}")
                when (e.status) {
                    // Unpaired, or the place or the feature is gone: sending again won't help.
                    401 -> { prefs.problem = "The computer no longer accepts this phone. Connect it again."; Outcome.DROP }
                    404, 409 -> { SyncWorker.now(ctx); Outcome.DROP }
                    in 400..499 -> Outcome.DROP
                    else -> Outcome.RETRY
                }
            } catch (e: Exception) {
                Log.w(TAG, "event not sent yet: ${e.message}")
                Outcome.RETRY
            }
        }
    }
}

/** Fetches the place list and registers it again (see Geofences.sync). */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        return try {
            Geofences.sync(applicationContext)
            schedule(applicationContext)
            Result.success()
        } catch (e: ApiError) {
            prefs.problem = if (e.status == 401) "The computer no longer accepts this phone. Connect it again." else "Could not read places: ${e.message}"
            if (e.status in 500..599) Result.retry() else Result.failure()
        } catch (e: Exception) {
            prefs.problem = "Could not reach the computer: ${e.message}"
            Result.retry()
        }
    }

    companion object {
        private const val PERIODIC = "places-sync"
        private const val ONCE = "places-sync-now"

        fun now(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(ONCE, ExistingWorkPolicy.REPLACE, req)
        }

        /** Keeps the list fresh, and puts geofences back after Android dropped them. */
        fun schedule(ctx: Context) {
            val prefs = Prefs(ctx)
            val wm = WorkManager.getInstance(ctx)
            if (!prefs.connected || !prefs.placesOn) {
                wm.cancelUniqueWork(PERIODIC)
                return
            }
            val req = PeriodicWorkRequestBuilder<SyncWorker>(maxOf(15, prefs.syncMinutes).toLong(), TimeUnit.MINUTES)
                .setConstraints(online)
                .build()
            wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req)
        }

        fun stop(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
        }
    }
}
