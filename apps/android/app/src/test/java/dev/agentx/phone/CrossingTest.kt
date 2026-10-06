package dev.agentx.phone

import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/** The decisions a real phone makes on a crossing (#681), checked off the phone. */
class CrossingTest {
    @Test
    fun onlyArrivalsAndDeparturesAreSent() {
        assertEquals("enter", GeofenceReceiver.transitionName(Geofence.GEOFENCE_TRANSITION_ENTER))
        assertEquals("exit", GeofenceReceiver.transitionName(Geofence.GEOFENCE_TRANSITION_EXIT))
        assertNull(GeofenceReceiver.transitionName(Geofence.GEOFENCE_TRANSITION_DWELL))
    }

    @Test
    fun theReportCarriesIdPlaceTransitionAndTimeOnly() {
        val body = Report.body(Crossing("evt-1", "pl_abcdef12", "exit", 1_700_000_000_000))
        assertEquals(setOf("id", "place", "transition", "time"), body.keySet())
        assertEquals("pl_abcdef12", body.getString("place"))
        assertEquals("exit", body.getString("transition"))
        assertEquals(1_700_000_000_000, body.getLong("time"))
    }

    @Test
    fun retriesOnlyWhenTheComputerMayTakeItLater() {
        for (status in listOf(200, 202, 400, 401, 403, 404)) assertTrue("$status is final", Report.done(status))
        for (status in listOf(429, 500, 502, 503)) assertFalse("$status is retried", Report.done(status))
    }

    @Test
    fun stopsRetryingACrossingOlderThanADay() {
        val now = 1_700_000_000_000
        assertFalse(Report.tooOld(now - TimeUnit.HOURS.toMillis(23), now))
        assertTrue(Report.tooOld(now - TimeUnit.HOURS.toMillis(25), now))
    }

    @Test
    fun registeringAgainHelpsUnlessThereAreTooManyPlaces() {
        assertTrue(Places.retryRegister(GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE))
        assertTrue(Places.retryRegister(null))
        assertFalse(Places.retryRegister(GeofenceStatusCodes.GEOFENCE_TOO_MANY_GEOFENCES))
    }

    @Test
    fun afterARestartTheKeptPlacesAreUsedUntilTheFirstCheck() {
        val now = 1_700_000_000_000
        val uptime = TimeUnit.MINUTES.toMillis(2)
        // Last check was yesterday: restore the kept list.
        assertFalse(Places.checkedSinceBoot(now - TimeUnit.DAYS.toMillis(1), now, uptime))
        // A check already ran a minute ago, after the boot: it registered newer places.
        assertTrue(Places.checkedSinceBoot(now - TimeUnit.MINUTES.toMillis(1), now, uptime))
        assertFalse(Places.checkedSinceBoot(0, now, uptime))
    }
}
