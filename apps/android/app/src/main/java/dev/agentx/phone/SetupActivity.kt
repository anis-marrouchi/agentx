package dev.agentx.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.io.IOException
import kotlin.concurrent.thread

/** First run: the computer's address and a pairing code from `agentx app pair`. */
class SetupActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val address = findViewById<EditText>(R.id.address)
        val code = findViewById<EditText>(R.id.code)
        val pair = findViewById<Button>(R.id.pair)
        val status = findViewById<TextView>(R.id.status)

        pair.setOnClickListener {
            val base = Api.normaliseAddress(address.text.toString())
            if (base == null) {
                status.text = getString(R.string.setup_bad_address)
                return@setOnClickListener
            }
            // Same form as the phone app's field: capitals and the dash are optional.
            val raw = code.text.toString().uppercase().filter { it.isLetterOrDigit() }
            if (raw.length != 8) {
                status.text = getString(R.string.setup_bad_code)
                return@setOnClickListener
            }
            pair.isEnabled = false
            status.text = getString(R.string.setup_pairing)
            thread {
                val result: String? = try {
                    val token = Api.pairWithCode(base, raw.substring(0, 4) + "-" + raw.substring(4))
                    val prefs = Prefs(this)
                    prefs.baseUrl = base
                    prefs.token = token
                    prefs.browserPaired = false
                    null
                } catch (e: Api.HttpError) {
                    e.message
                } catch (e: IOException) {
                    getString(R.string.setup_unreachable)
                }
                runOnUiThread {
                    pair.isEnabled = true
                    if (result != null) {
                        status.text = result
                    } else {
                        status.text = ""
                        startActivity(Intent(this, PlacesActivity::class.java).putExtra(PlacesActivity.EXTRA_FIRST_RUN, true))
                        finish()
                    }
                }
            }
        }
        findViewById<View>(R.id.setup_root).requestFocus()
    }
}
