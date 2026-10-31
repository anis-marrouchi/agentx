package dev.agentx.phone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Talk to AgentX (#1664): the start button. Opened from its own icon, the
 * long-press shortcut or the call's notification. With an agent chosen, it
 * rings the watch at once; the first time, it asks which agent.
 */
class TalkActivity : Activity() {
    companion object {
        /** The launcher icon and the shortcut: start at once when an agent is chosen. */
        const val ACTION_TALK = "dev.agentx.phone.action.TALK"
        private const val REQ_PERMISSIONS = 1

        /** Long-press the app icon: Talk to <agent>. Kept next to Place reminders. */
        fun shortcut(activity: Activity, target: TalkTarget?): ShortcutInfo? {
            target ?: return null
            return ShortcutInfo.Builder(activity, "talk")
                .setShortLabel(activity.getString(R.string.talk_short))
                .setLongLabel(activity.getString(R.string.talk_to, target.name))
                .setIcon(Icon.createWithResource(activity, R.drawable.ic_talk))
                .setIntent(Intent(activity, TalkActivity::class.java).setAction(ACTION_TALK))
                .build()
        }
    }

    private lateinit var prefs: Prefs
    private lateinit var agentLine: TextView
    private lateinit var status: TextView
    private lateinit var start: Button
    private lateinit var answer: Button
    private lateinit var hangUp: Button
    private lateinit var list: LinearLayout
    private var startWhenAllowed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (!prefs.paired) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        title = getString(R.string.talk_title)
        val pad = (24 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(s: String, style: Int) = TextView(this).apply {
            this.text = s
            setTextAppearance(style)
            setPadding(0, pad / 3, 0, pad / 3)
        }.also { column.addView(it) }
        fun button(label: Int, onClick: () -> Unit) = Button(this).apply {
            setText(label)
            minHeight = (48 * resources.displayMetrics.density).toInt()
            setOnClickListener { onClick() }
        }.also { column.addView(it) }

        text(getString(R.string.talk_lead), android.R.style.TextAppearance_Material_Body1)
        agentLine = text("", android.R.style.TextAppearance_Material_Subhead)
        status = text("", android.R.style.TextAppearance_Material_Body2).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        start = button(R.string.talk_start) { begin() }
        answer = button(R.string.talk_answer_here) { TalkConnection.current?.answerHere() }
        hangUp = button(R.string.talk_hang_up) { TalkService.hangUp(this) }
        button(R.string.talk_change) { loadAgents() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(list)
        setContentView(ScrollView(this).apply { fitsSystemWindows = true; addView(column) })

        if (savedInstanceState == null && intent?.action != Intent.ACTION_VIEW) {
            if (prefs.talkTarget == null) loadAgents() else if (TalkConnection.current == null) begin()
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent?.action != Intent.ACTION_VIEW && prefs.talkTarget != null && TalkConnection.current == null) begin()
    }

    override fun onResume() {
        super.onResume()
        TalkState.listener = { render() }
        render()
    }

    override fun onPause() {
        TalkState.listener = null
        super.onPause()
    }

    private fun render() {
        val target = prefs.talkTarget
        agentLine.text = if (target == null) getString(R.string.talk_no_agent) else getString(R.string.talk_to, target.name)
        val call = TalkConnection.current
        status.text = TalkState.text
        status.visibility = if (TalkState.text.isEmpty()) View.GONE else View.VISIBLE
        start.visibility = if (call == null) View.VISIBLE else View.GONE
        start.isEnabled = target != null
        answer.visibility = if (call?.ringing == true) View.VISIBLE else View.GONE
        hangUp.visibility = if (call != null || TalkState.active) View.VISIBLE else View.GONE
    }

    /** Microphone, nearby devices (Android 12+) and notifications (13+) first. */
    private fun begin() {
        if (prefs.talkTarget == null) { loadAgents(); return }
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31) needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            startWhenAllowed = true
            requestPermissions(missing.toTypedArray(), REQ_PERMISSIONS)
            return
        }
        TalkState.set(getString(R.string.talk_ringing), active = true)
        TalkService.start(this)
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS || !startWhenAllowed) return
        startWhenAllowed = false
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            TalkState.set(getString(R.string.talk_mic_denied), active = false)
            return
        }
        // Without nearby devices the call stays on the phone; without
        // notifications there is no Hang up in the shade. Both still work.
        begin()
    }

    /** The agents online now, one button each. */
    private fun loadAgents() {
        list.removeAllViews()
        list.addView(TextView(this).apply { setText(R.string.talk_loading) })
        val base = prefs.baseUrl ?: return
        val token = prefs.token ?: return
        thread {
            val result = try { Result.success(Api.getAgents(base, token)) } catch (e: Exception) { Result.failure(e) }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                list.removeAllViews()
                val agents = result.getOrNull()
                when {
                    agents == null -> list.addView(TextView(this).apply {
                        text = if ((result.exceptionOrNull() as? Api.HttpError)?.status == 401) getString(R.string.err_unpaired) else getString(R.string.talk_unreachable)
                    })
                    agents.isEmpty() -> list.addView(TextView(this).apply { setText(R.string.talk_none) })
                    else -> for (a in agents) list.addView(Button(this).apply {
                        text = a.name
                        setOnClickListener { choose(a) }
                    })
                }
            }
        }
    }

    private fun choose(target: TalkTarget) {
        prefs.talkTarget = target
        list.removeAllViews()
        try {
            val sm = getSystemService(ShortcutManager::class.java)
            val talk = shortcut(this, target)
            if (sm != null && talk != null) sm.addDynamicShortcuts(listOf(talk))
        } catch (_: Exception) { /* launcher without shortcuts */ }
        render()
    }
}
