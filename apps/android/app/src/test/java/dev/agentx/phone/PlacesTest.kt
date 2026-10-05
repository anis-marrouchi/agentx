package dev.agentx.phone

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlacesTest {
    @Test
    fun readsThePlacesAndSkipsIncompleteOnes() {
        val places = JSONArray(
            """[
              {"id":"pl_a","name":"School","lat":48.85,"lng":2.35,"radius":150},
              {"id":"pl_b","lat":48.86,"lng":2.36,"radius":200},
              {"id":"","name":"No id","lat":1,"lng":1,"radius":150},
              {"id":"pl_c","name":"No radius","lat":1,"lng":1},
              "not a place"
            ]""",
        )
        assertEquals(
            listOf(
                Places.Fence("pl_a", "School", 48.85, 2.35, 150.0),
                Places.Fence("pl_b", "pl_b", 48.86, 2.36, 200.0),
            ),
            Places.parse(places),
        )
        assertTrue(Places.parse(null).isEmpty())
    }

    @Test
    fun keepsAtMostAndroidsLimit() {
        val places = JSONArray()
        repeat(120) { places.put(org.json.JSONObject().put("id", "pl_$it").put("lat", 1.0).put("lng", 2.0).put("radius", 150)) }
        assertEquals(100, Places.parse(places).size)
    }

    @Test
    fun whatIsKeptForARestartReadsBackTheSame() {
        val fences = listOf(Places.Fence("pl_a", "School", 48.85, 2.35, 150.0), Places.Fence("pl_b", "Office", -33.9, 151.2, 500.0))
        assertEquals(fences, Places.parse(JSONArray(Places.toJson(fences))))
    }
}
