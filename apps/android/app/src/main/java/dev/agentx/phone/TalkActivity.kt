package dev.agentx.phone

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
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
        private const val REQ_WATCH = 2
        private const val REQ_ROLE = 3

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
    private lateinit var watchLine: TextView
    private lateinit var watchSetUp: Button
    private lateinit var watchContact: Button
    private lateinit var watchAuto: CheckBox
    private lateinit var watchOff: Button
    private var startWhenAllowed = false
    private var setUpWhenAllowed = false
    /** Opened by a call from the watch, over the lock screen. */
    private var watchCall = false
    private var sawCall = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (!prefs.paired) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        if (intent?.action == WatchStart.ACTION_WATCH) showOverLockScreen()
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

        // Start from the watch (#1664): off until the owner sets it up.
        text(getString(R.string.watch_heading), android.R.style.TextAppearance_Material_Subhead).setPadding(0, pad, 0, pad / 3)
        watchLine = text("", android.R.style.TextAppearance_Material_Body1)
        watchSetUp = button(R.string.watch_set_up) { setUpWatch() }
        watchContact = button(R.string.watch_add_contact) { addContact() }
        watchAuto = CheckBox(this).apply {
            setText(R.string.watch_auto_answer)
            minHeight = (48 * resources.displayMetrics.density).toInt()
            isChecked = prefs.watchAutoAnswer
            // Saved at once: a separate Save step was missed in the spike.
            setOnCheckedChangeListener { _, on -> prefs.watchAutoAnswer = on }
        }.also { column.addView(it) }
        watchOff = button(R.string.watch_turn_off) { prefs.watchStartOn = false; renderWatch() }
        setContentView(ScrollView(this).apply { fitsSystemWindows = true; addView(column) })

        if (savedInstanceState == null && intent?.action != Intent.ACTION_VIEW) {
            if (prefs.talkTarget == null) loadAgents() else if (TalkConnection.current == null) begin(fromWatch = watchCall)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Each start says what it is: a launcher start after a watch call is not one.
        if (intent?.action == WatchStart.ACTION_WATCH) showOverLockScreen()
        else if (TalkConnection.current == null && !TalkState.active) leaveLockScreen()
        if (intent?.action != Intent.ACTION_VIEW && prefs.talkTarget != null && TalkConnection.current == null) begin(fromWatch = watchCall)
    }

    /** A watch call opens this screen with the phone in a pocket: show it
     *  over the lock screen, so the app is in front and keeps the microphone. */
    private fun showOverLockScreen() {
        watchCall = true
        sawCall = false
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
    }

    /** The watch call is over: this screen no longer shows over the lock screen. */
    private fun leaveLockScreen() {
        watchCall = false
        sawCall = false
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(false)
            setTurnScreenOn(false)
        } else {
            @Suppress("DEPRECATION")
            window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
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
        renderWatch()
        // A watch call over the lock screen: once it ends, give the lock screen back.
        if (call != null) sawCall = true
        if (watchCall && sawCall && call == null && !TalkState.active) {
            val locked = getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true
            leaveLockScreen()
            if (locked) finish()
        }
    }

    private fun renderWatch() {
        val on = prefs.watchStartOn
        val held = WatchStart.holdsRole(this)
        watchLine.text = when {
            !WatchStart.supported -> getString(R.string.watch_unsupported)
            on && held -> getString(R.string.watch_on, getString(R.string.watch_contact_name))
            on -> getString(R.string.watch_role_lost)
            else -> getString(R.string.watch_off)
        }
        watchSetUp.visibility = if (WatchStart.supported && !(on && held)) View.VISIBLE else View.GONE
        val ready = WatchStart.supported && on && held
        watchContact.visibility = if (ready) View.VISIBLE else View.GONE
        watchAuto.visibility = if (ready) View.VISIBLE else View.GONE
        watchOff.visibility = if (on) View.VISIBLE else View.GONE
    }

    /** Microphone, nearby devices (Android 12+) and notifications (13+). */
    private fun missingPermissions(): List<String> {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31) needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        return needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    }

    private fun begin(fromWatch: Boolean = false) {
        if (prefs.talkTarget == null) { loadAgents(); return }
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            startWhenAllowed = true
            requestPermissions(missing.toTypedArray(), REQ_PERMISSIONS)
            return
        }
        TalkState.set(getString(if (fromWatch) R.string.talk_ringing_back else R.string.talk_ringing), active = true)
        try {
            TalkService.start(this, fromWatch)
        } catch (e: RuntimeException) {
            // Shown over the lock screen but not yet in front: ring anyway.
            if (fromWatch) TalkService.startFromWatch(this) else throw e
        }
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_WATCH && setUpWhenAllowed) {
            setUpWhenAllowed = false
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                watchLine.text = getString(R.string.talk_mic_denied)
                return
            }
            setUpWatch()
            return
        }
        if (requestCode != REQ_PERMISSIONS || !startWhenAllowed) return
        startWhenAllowed = false
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            TalkState.set(getString(R.string.talk_mic_denied), active = false)
            return
        }
        // Without nearby devices the call stays on the phone; without
        // notifications there is no Hang up in the shade. Both still work.
        begin(fromWatch = watchCall)
    }

    /** Permissions first (a watch call can't ask with the phone in a
     *  pocket), then Android's call-redirect question, then the contact. */
    private fun setUpWatch() {
        if (prefs.talkTarget == null) { watchLine.text = getString(R.string.watch_pick_first); loadAgents(); return }
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            setUpWhenAllowed = true
            requestPermissions(missing.toTypedArray(), REQ_WATCH)
            return
        }
        if (WatchStart.holdsRole(this)) { turnWatchOn(); return }
        val ask = WatchStart.roleRequest(this)
        if (ask == null) { watchLine.text = getString(R.string.watch_unsupported); return }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(ask, REQ_ROLE)
        } catch (_: Exception) {
            watchLine.text = getString(R.string.watch_unsupported)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_ROLE) return
        if (WatchStart.holdsRole(this)) turnWatchOn() else { renderWatch(); watchLine.text = getString(R.string.watch_role_refused) }
    }

    private fun turnWatchOn() {
        val first = !prefs.watchStartOn
        prefs.watchStartOn = true
        renderWatch()
        if (first) addContact()
    }

    private fun addContact() {
        try { startActivity(WatchStart.contactIntent(this)) } catch (_: Exception) {
            watchLine.text = getString(R.string.watch_no_contacts_app, getString(R.string.watch_contact_name), prefs.watchNumber)
        }
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
