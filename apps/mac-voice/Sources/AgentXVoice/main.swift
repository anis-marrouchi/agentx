import AppKit
import Carbon.HIToolbox

/// AgentX Voice — push-to-talk widget over the daemon's /ask endpoint.
///
/// Hold ⌥Space, speak, release. Transcribe (ElevenLabs, falling back to
/// on-device mlx-whisper), POST to /ask, speak the answer (ElevenLabs,
/// falling back to `say`).
///
/// Deliberately has NO computer-use capability in this slice. The point is
/// to find out whether talking to an agent this way is actually pleasant
/// before building the part that can click things.
/// Main-actor isolated in full. An NSApplicationDelegate touches AppKit in
/// every method, and the crash that prompted this was UI state reached from
/// a background queue. Isolating the whole class turns that from a runtime
/// heap corruption into a compile error.
@MainActor
final class App: NSObject, NSApplicationDelegate {
    private let panel = Panel()
    private let statusMenu = StatusMenu()
    /// Stands in for the pill's orb when voice.look is "character".
    private let character = CharacterHost()
    /// The agent whose by-name answer is on screen now, while no turn runs.
    private var asideSpeaker: String?
    private let recorder = Recorder()
    private var hotkey: Hotkey?
    private var pasteHotkey: Hotkey?
    private var stopHotkey: Hotkey?
    private var menuHotkey: Hotkey?
    /// Hold to ask one agent, from agents[].voice.hotkey.
    private var agentHotkeys: [Hotkey] = []
    private let settingsWindow = SettingsWindow()
    /// The saved settings: shortcuts and the speech-to-text engine. Read
    /// from the daemon at launch and after every save; defaults until then.
    private var settings: VoiceSettings?
    /// The agent a per-agent shortcut is asking; nil for the talk key.
    private var forcedAgent: String?
    /// Set by a stop: the answer being spoken ends without reopening the mic.
    private var silenced = false
    private var busy = false
    private var progress: Progress?
    private var ticker: Timer?
    private var startedAt = Date()
    private var lastStep = "Thinking…"
    private var spokenSteps = Set<String>()
    private var lastSpokeAt = Date.distantPast
    /// The answering agent's voice, learned from the daemon. Nil until
    /// then, which speaks in the global default.
    private var voice: VoiceChoice?
    /// Set when the door opens: what was speaking (and is now hushed), so
    /// the words spoken go to that activity rather than to /ask.
    private var talkCheck: Task<AgentClient.Hushed, Never>?
    /// A lesson our last turn started may still be speaking: a click then
    /// opens the door at once, like the key, so the microphone does not
    /// take the lesson's voice for the listener's.
    private var lessonOn = false
    /// Waiting for our answer to be spoken by the daemon's queue. The door
    /// lets go of it: the answer stays queued and plays after the turn.
    private var speaking: Task<Void, Never>?
    /// Words said while our own turn was still running: they go next, and
    /// the stale answer is not spoken.
    private var followUp: String?
    /// "stop" while our own turn was running: drop its answer.
    private var abandoned = false
    /// The agent our own turn is asking. Usually the target; "Writer, …"
    /// sends one question to Writer and leaves the target alone.
    private var turnAgent = ""
    /// Questions in flight per agent: our turn plus any asides.
    private var inFlight: [String: Int] = [:]
    /// Bumped by every stop, so an aside answered after it stays quiet.
    private var stopGeneration = 0
    /// Questions for an agent that already has one in flight, oldest
    /// first. One /ask per agent at a time: a second question waits here
    /// for the first answer instead of racing it into the same session.
    private var waitingAsides: [String: [String]] = [:]
    /// Asides not yet finished: asked, answering, or waiting to be spoken.
    /// While any are open the microphone does not reopen by itself, or it
    /// would hear the next answer as the listener's words.
    private var openAsides = 0

    // An agent ringing the owner (#321).
    private let callWatcher = CallWatcher()
    private let ringer = Ringer()
    /// The call ringing on the pill now.
    private var ringingCall: IncomingCall?
    /// The call being answered, until the daemon has the answer: a poll
    /// sent meanwhile still says the pill is showing it (#408).
    private var answeringCall: String?
    /// The call in progress: every turn goes to its agent until hang-up.
    private var activeCall: IncomingCall?

    /// /ask, counted in flight for the menu while it thinks.
    private func ask(_ heard: String, agent: String) async throws -> AgentClient.Answer {
        track(agent, 1)
        defer { track(agent, -1) }
        return try await AgentClient.ask(heard, agent: agent)
    }

    private func track(_ agent: String, _ delta: Int) {
        let n = inFlight[agent, default: 0] + delta
        inFlight[agent] = n > 0 ? n : nil
        publishThinking()
    }

    /// The menu's per-agent count: questions asked plus questions waiting.
    private func publishThinking() {
        var counts = inFlight
        for (agent, words) in waitingAsides { counts[agent, default: 0] += words.count }
        statusMenu.thinking = counts
    }

    /// Busy agents in the order their mini orbs first appeared.
    private var busyOrder: [String] = []

    /// The pill's mini orbs, one per busy agent (#266): questions in
    /// flight or waiting here, answers waiting in or playing from the
    /// daemon's speaking queue. Called when any of those change.
    private func refreshBusy() {
        let queue = statusMenu.queue
        var snap = PillBusy.Snapshot()
        snap.inFlight = inFlight
        snap.waiting = waitingAsides.mapValues(\.count)
        snap.playing = queue?.playing?.agentId
        snap.toSpeak = queue?.waiting.compactMap(\.agentId) ?? []
        let items = PillBusy.items(snap, order: busyOrder)
        busyOrder = items.map(\.agentID)
        let mainActive = recorder.isRecording || busy || asideSpeaker != nil
        guard PillBusy.showsRow(items, mainAgent: shownAgent, mainActive: mainActive) else {
            panel.showBusy([], more: 0)
            return
        }
        let (count, more) = PillBusy.shown(items.count)
        let orbs = items.prefix(count).map { item in
            MiniOrbsModel.Orb(
                agentID: item.agentID, activity: item.activity, queued: item.queued,
                tint: statusMenu.color(of: item.agentID), colors: statusMenu.palette(of: item.agentID),
                tooltip: PillBusy.tooltip(name: statusMenu.name(of: item.agentID),
                                          node: statusMenu.node(of: item.agentID) ?? "this Mac", item: item))
        }
        panel.showBusy(Array(orbs), more: more)
    }

    // --- Shortcuts ---
    //
    // Talk, stop and smart paste come from agentx.json (voice.hotkeys),
    // and each agent may have its own (agents[].voice.hotkey). ⌘⌥A, which
    // opens the menu, is fixed. Saved in the settings window, they are
    // registered again at once: no restart.

    private func registerHotkeys() {
        unregisterHotkeys()
        let keys = settings?.general.hotkeys
        func spec(_ text: String?, _ fallback: String) -> HotkeySpec {
            text.flatMap(HotkeySpec.init) ?? HotkeySpec(fallback)!
        }
        let register = { (key: Hotkey, spec: HotkeySpec, what: String) in
            if !key.register(spec) { Log.warn("shortcut \(spec.text ?? "?") for \(what) is taken by another app") }
        }

        // Hold to talk; release sends.
        let talk = Hotkey(id: 1,
                          onPress: { [weak self] in self?.forcedAgent = nil; self?.startListening() },
                          onRelease: { [weak self] in self?.stopAndSend() })
        register(talk, spec(keys?.talk, "opt+space"), "talk")
        hotkey = talk

        // Smart paste fires on RELEASE so the modifiers are up before cmd-V
        // is sent; pressed while they are held it is a different chord.
        let paste = Hotkey(id: 2, onPress: {}, onRelease: { [weak self] in self?.smartPaste() })
        register(paste, spec(keys?.paste, "cmd+opt+v"), "smart paste")
        pasteHotkey = paste

        // Stop every voice now. ⌘. is the Mac's own "cancel"; Option keeps
        // it from reaching the app in front.
        let stop = Hotkey(id: 3, onPress: {}, onRelease: { [weak self] in self?.stopSpeaking() })
        register(stop, spec(keys?.stop, "cmd+opt+period"), "stop")
        stopHotkey = stop

        // Open the menu-bar menu without the mouse.
        let menu = Hotkey(id: 4, onPress: {}, onRelease: { [weak self] in self?.statusMenu.open() })
        register(menu, HotkeySpec("cmd+opt+a")!, "the menu")
        menuHotkey = menu

        // Hold an agent's own shortcut to ask it; the target stays.
        for (i, agent) in (settings?.agents ?? []).enumerated() {
            guard let text = agent.voice.hotkey, let s = HotkeySpec(text) else { continue }
            let id = agent.id
            let key = Hotkey(id: UInt32(10 + i),
                             onPress: { [weak self] in self?.forcedAgent = id; self?.startListening() },
                             onRelease: { [weak self] in self?.stopAndSend() })
            register(key, s, "asking \(agent.name)")
            agentHotkeys.append(key)
        }
    }

    /// Dropping a Hotkey unregisters it.
    private func unregisterHotkeys() {
        hotkey = nil; pasteHotkey = nil; stopHotkey = nil; menuHotkey = nil
        agentHotkeys.removeAll()
    }

    /// Settings from the daemon: shortcuts now, the rest on next use.
    private func apply(_ saved: VoiceSettings) {
        settings = saved
        let card = saved.general.card ?? .standard
        panel.cardTimeout = card.timeout
        panel.cardMaxHeight = card.maxHeight
        let asCharacter = saved.general.look == "character"
        panel.setShowsOrb(!asCharacter)
        character.setShown(asCharacter)
        if !asCharacter { panel.detach() }
        if settingsWindow.model.recording == nil { registerHotkeys() }
        // Colours may have changed.
        statusMenu.refresh()
        Log.info("settings: talk \(saved.general.hotkeys.talk), speech to text \(saved.general.stt)")
    }

    /// Who the pill names and whose colour its orb wears: the agent a
    /// shortcut is asking, a by-name answer being spoken, else the agent
    /// our turn is asking, else the target.
    private var shownAgent: String {
        if let call = ringingCall ?? activeCall { return call.agentId }
        if let forcedAgent, recorder.isRecording { return forcedAgent }
        if let asideSpeaker { return asideSpeaker }
        return busy && !turnAgent.isEmpty ? turnAgent : Config.effectiveAgentID
    }

    /// The answer's "Open in chat": the agent's page in the dashboard, with
    /// its chat open.
    private func openChat() {
        let who = shownAgent
        guard !who.isEmpty, let url = URL(string: "\(Config.dashboardURL)/admin/agents/\(who)#chat") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Close, Esc or "Hide pill": the pill goes, the character with it,
    /// and the voice stops, the same stop as ⌘⌥. An open microphone closes
    /// without sending. The next talk key brings them back.
    private func dismissPill() {
        Log.info("pill: dismissed")
        // Closing the pill declines a ringing call and ends one in progress.
        if ringingCall != nil { endRinging { await CallClient.decline($0) } }
        if activeCall != nil { hangUp() }
        panel.dismiss()
        character.setHidden(true)
        if recorder.isRecording {
            stopPolling()
            _ = recorder.stop()
            forcedAgent = nil
            talkCheck = nil
        }
        stopSpeaking()
    }

    /// The talk key, a call or the menu: a hidden pill may show again,
    /// and a hidden character is back.
    private func summonPill() {
        character.setHidden(false)
        panel.summon()
    }

    /// ⌘⌥V. Everything except the hotkey lives in `agentx paste`.
    private func smartPaste() {
        guard !busy else { return }
        busy = true
        panel.render(.working("Pasting…", 0))
        SmartPaste.run { [weak self] result in
            guard let self else { return }
            self.busy = false
            guard let result else {
                self.panel.render(.error("Smart paste unavailable"))
                return
            }
            // Quiet when nothing changed: "pasted as copied" is the common
            // case and does not deserve an announcement.
            if let what = SmartPaste.summary(result) {
                self.panel.render(.working(what, 0))
            }
            self.panel.render(.idle)
        }
    }

    /// Only one widget, however it was started.
    ///
    /// Two pills were sitting on screen at once: the installed copy in
    /// /Applications and a freshly built one from the source tree. Same
    /// bundle identifier, different paths, so macOS is happy to run both —
    /// and the older one keeps rendering an older UI, which looks exactly
    /// like a bug in the new build.
    ///
    /// The NEWEST wins. After an upgrade or a rebuild the thing you just
    /// made is the one you want; a stale copy showing yesterday's
    /// behaviour has no claim to the screen.
    private func retireOlderInstances() {
        let me = ProcessInfo.processInfo.processIdentifier
        let mine = Bundle.main.bundleIdentifier
        for app in NSWorkspace.shared.runningApplications {
            guard app.bundleIdentifier == mine,
                  app.processIdentifier != me else { continue }
            Log.info("retiring an older instance (pid \(app.processIdentifier))")
            if !app.terminate() { app.forceTerminate() }
        }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        retireOlderInstances()
        panel.onRender = { [weak self] state in
            self?.statusMenu.show(state)
            // Who the main orb shows may have changed.
            self?.refreshBusy()
        }
        statusMenu.onActivity = { [weak self] in self?.refreshBusy() }
        panel.contextMenu = { [weak self] in self?.statusMenu.menu ?? NSMenu() }
        panel.agentName = { [weak self] in
            guard let self else { return "" }
            let who = self.shownAgent
            return who.isEmpty ? "" : self.statusMenu.name(of: who)
        }
        panel.agentTint = { [weak self] in
            guard let self else { return Brand.accent }
            return self.statusMenu.color(of: self.shownAgent)
        }
        panel.alwaysVisible = Config.showPill
        panel.orb.setAnimated(Config.animatedOrb)
        panel.miniOrbs.setAnimated(Config.animatedOrb)
        panel.orb.levelSource = { [weak self] in self?.recorder.level ?? 0 }
        character.setAnimated(Config.animatedOrb)
        character.levelSource = { [weak self] in self?.recorder.level ?? 0 }
        // The pill is the character's speech bubble: it goes where the
        // character goes.
        character.bubble = { [weak self] head, visible in
            guard let panel = self?.panel else { return nil }
            panel.attach(head: head, visible: visible)
            return panel.isVisible ? panel.frame : nil
        }
        panel.onLook = { [weak self] state, tint, colors in
            self?.character.show(state.activity, tint: tint, colors: colors)
        }
        panel.onShown = { [weak self] in self?.character.redraw() }
        panel.onDismiss = { [weak self] in self?.dismissPill() }
        panel.agentPalette = { [weak self] in
            guard let self else { return nil }
            return self.statusMenu.palette(of: self.shownAgent)
        }
        panel.answer.onOpenChat = { [weak self] in self?.openChat() }
        statusMenu.pillVisible = { [weak self] in self?.panel.isVisible ?? false }
        statusMenu.onHidePill = { [weak self] in self?.dismissPill() }
        statusMenu.characterVisible = { [weak self] in self?.character.onScreen }
        statusMenu.onShowCharacter = { [weak self] in self?.summonPill() }
        // Each does nothing with the other's look.
        statusMenu.onResetPosition = { [weak self] in
            self?.panel.resetPosition()
            self?.character.resetPosition()
        }
        statusMenu.onAnimatedOrbChanged = { [weak self] on in
            self?.panel.orb.setAnimated(on)
            self?.panel.miniOrbs.setAnimated(on)
            self?.character.setAnimated(on)
        }
        panel.render(.idle)
        statusMenu.onPillChanged = { [weak self] on in
            guard let self else { return }
            self.panel.alwaysVisible = on
            // Asking for the pill brings back one that was dismissed.
            if on { self.summonPill() }
            if !self.busy && !self.recorder.isRecording { self.panel.render(.idle) }
        }
        statusMenu.onTargetChanged = { [weak self] id in
            Config.effectiveAgentID = id
            // The last answer's voice belongs to the previous agent.
            self?.voice = nil
            Log.info("target agent: \(id)")
        }
        statusMenu.refresh()

        registerHotkeys()
        panel.onClick = { [weak self] in self?.toggleListening() }
        statusMenu.onSettings = { [weak self] in self?.settingsWindow.show() }
        settingsWindow.model.onSaved = { [weak self] saved in self?.apply(saved) }
        // While a shortcut field waits for keys, ours stand aside so the
        // keys reach the field.
        settingsWindow.model.onRecording = { [weak self] recording in
            guard let self else { return }
            if recording { self.unregisterHotkeys() } else { self.registerHotkeys() }
        }
        // At login the app can start before the daemon answers. Keep
        // asking: one missed read left the orb and the built-in
        // shortcuts until the app was restarted.
        Task { @MainActor in
            var failures = 0
            while true {
                if let saved = await AgentClient.settings() { apply(saved); break }
                failures += 1
                if failures == 1 { Log.warn("settings: the daemon did not answer, asking again") }
                try? await Task.sleep(for: .seconds(VoiceSettings.retryDelay(after: failures)))
            }
        }

        // Turning the hold OFF is the moment anything that piled up
        // becomes welcome. Without this the queue is a hole rather than a
        // delay — the daemon's watcher only notices SYSTEM Focus ending,
        // and this switch is not that.
        statusMenu.onHoldChanged = { [weak self] nowOn in
            guard let self else { return }
            self.panel.render(.idle)
            if !nowOn { Hold.flushHeld() }
            Log.info(nowOn ? "notifications held" : "notifications delivering")
        }

        statusMenu.onStop = { [weak self] in self?.stopSpeaking() }

        panel.callBar.onAnswer = { [weak self] in self?.answerCall() }
        panel.callBar.onDecline = { [weak self] in self?.endRinging { await CallClient.decline($0) } }
        panel.callBar.onLater = { [weak self] minutes in self?.endRinging { await CallClient.later($0, minutes: minutes) } }
        panel.callBar.onHangUp = { [weak self] in self?.hangUp() }
        callWatcher.onPoll = { [weak self] state in self?.polled(state) }
        callWatcher.query = { [weak self] in
            guard let self else { return "" }
            return CallModel.pollQuery(ringing: self.ringingCall?.id ?? self.answeringCall, canRing: self.canRing)
        }
        callWatcher.start()

        // The target does not wait for the microphone: the menu shows it
        // either way.
        Task { @MainActor in
            Config.effectiveAgentID = await AgentClient.resolveAgent()
            Log.info("agent: \(Config.effectiveAgentID.isEmpty ? "the daemon's default" : Config.effectiveAgentID)")
        }
        recorder.requestPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                if !granted { self.panel.render(.error("Microphone denied")) }
                else { Log.info("ready — hold ⌥Space to talk") }
            }
        }
    }

    // --- Hands-free listening ---
    //
    // Holding a chord is fine for one question and wrong for a
    // conversation: the reply arrives, you want to say one more thing, and
    // you have to find ⌥Space again while the assistant sits idle. So the
    // microphone reopens by itself after every answer, and closes again on
    // its own if you say nothing.
    //
    // Ending on SILENCE rather than a timer is the whole trick. A fixed
    // window either cuts people off mid-sentence or leaves the mic open
    // staring at them; the only honest signal that a sentence has finished
    // is the voice stopping. The recorder judges that (TurnEnd.swift).

    /// How long an unprompted follow-up window waits before giving up.
    private let followUpPatience: TimeInterval = 4.0
    /// How long a clicked session waits for you to start talking.
    private let clickPatience: TimeInterval = 8.0
    /// In a call the other side waits longer for an answer.
    private let callPatience: TimeInterval = 10.0

    private var listenPoll: Timer?
    private var openedAt = Date()
    private var patience: TimeInterval = 8.0
    /// True when nothing was said and the window should close in silence.
    private var silentClose = false

    /// Open the microphone with no key held.
    private func listenHandsFree(followUp: Bool) {
        guard !busy, !recorder.isRecording else { return }
        recorder.endOfTurn = settings?.general.endOfTurn ?? "vad"
        do {
            try recorder.start()
        } catch {
            panel.render(.error(error.localizedDescription))
            return
        }
        if !followUp && lessonOn { talkCheck = Task { await AgentClient.hush() } }
        openedAt = Date()
        patience = followUp ? (activeCall == nil ? followUpPatience : callPatience) : clickPatience
        silentClose = followUp
        asideSpeaker = nil
        panel.render(.listening)

        listenPoll?.invalidate()
        // Timer fires on the run loop but its closure is not main-actor
        // isolated, and pollLevel touches UI. Hopping explicitly keeps it
        // correct under Swift 6 rather than relying on the timer happening
        // to run where we want it.
        listenPoll = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor [weak self] in self?.pollLevel() }
        }
    }

    private func pollLevel() {
        guard recorder.isRecording else { stopPolling(); return }
        switch recorder.turnState {
        case .speaking: return
        case .ended:
            stopPolling()
            stopAndSend()
            return
        case .waiting: break
        }
        // Nothing said yet. Close quietly rather than making the person
        // dismiss a window they did not ask for.
        if Date().timeIntervalSince(openedAt) >= patience {
            stopPolling()
            _ = recorder.stop()
            // Nothing said after an early hush: let the queue play on.
            if let door = talkCheck {
                talkCheck = nil
                Task { _ = await door.value; await AgentClient.resume() }
            }
            panel.render(silentClose ? rest : .error("Didn't catch that"))
            if !silentClose { resetSoon() }
        }
    }

    private func stopPolling() {
        listenPoll?.invalidate()
        listenPoll = nil
    }

    /// The pill was clicked: start if idle, finish early if already listening.
    private func toggleListening() {
        if recorder.isRecording {
            stopPolling()
            stopAndSend()
            return
        }
        listenHandsFree(followUp: false)
    }

    /// Barge-in without a question: every voice stops, queued lines are
    /// dropped, and the widget goes quiet.
    private func stopSpeaking() {
        Log.info("stop: silencing every voice")
        if busy { silenced = true }
        stopGeneration += 1
        waitingAsides.removeAll()
        publishThinking()
        asideSpeaker = nil
        lastSpokeAt = Date()
        Task { await Speech.stopAll() }
        if !recorder.isRecording { panel.render(rest) }
    }

    private func startListening() {
        // A held key overrides any hands-free window that is open, so the
        // two ways of talking never fight over the microphone.
        stopPolling()
        guard !recorder.isRecording else { return }
        // A dismissed pill comes back with the talk key.
        summonPill()
        // Option-Space is the door to everything spoken, always: our own
        // answer or step line stops now, and the daemon hushes any talk,
        // lesson or narration, remembering which it was. Even mid-turn —
        // ignoring the key while busy is how Anis spoke to a lesson and
        // nothing listened.
        Speech.stop()
        speaking?.cancel()
        speaking = nil
        lastSpokeAt = Date()
        talkCheck = Task { await AgentClient.hush() }
        Log.info("door: opened\(busy ? " (a turn is running)" : "")")
        // Push-to-talk ends on key release; no end-of-turn detection needed.
        recorder.endOfTurn = "hold"
        do {
            try recorder.start()
            asideSpeaker = nil
            panel.render(.listening)
        } catch {
            panel.render(.error(error.localizedDescription))
        }
    }

    private func stopAndSend() {
        guard recorder.isRecording else { return }
        // Clicked or hands-free: nothing hushed yet. They did speak, so
        // hush now; whatever was talking gets the words, same as the key.
        let door = talkCheck ?? Task { await AgentClient.hush() }
        talkCheck = nil
        let forced = forcedAgent
        forcedAgent = nil
        guard let wav = recorder.stop() else {
            // Nothing said, so no door follows the hush: let the queue play on.
            Task { _ = await door.value; await AgentClient.resume() }
            panel.render(.error("Too short — hold while speaking"))
            resetSoon()
            return
        }
        let midTurn = busy
        busy = true
        if !midTurn { panel.render(.thinking) }

        Task { @MainActor in
            var heard = ""
            do { heard = try await Speech.transcribe(wav: wav, engine: settings?.general.stt ?? "auto",
                                                          local: settings?.general.localStt ?? "mlx-whisper") }
            catch { Log.warn("transcription failed: \(error.localizedDescription)") }
            guard !heard.isEmpty else {
                _ = await door.value
                await AgentClient.resume()
                if !midTurn {
                    panel.render(.error("Didn't catch that"))
                    // Say it aloud: someone not looking would think it was sent.
                    await Speech.say("Sorry, I didn't hear that. Please say it again.", agentID: nil, kind: "line", voice: voice)
                    busy = false; resetSoon()
                }
                return
            }
            Log.info("heard: \(heard)")
            if activeCall != nil && CallModel.isHangUp(heard) {
                _ = await door.value
                await AgentClient.resume()
                if !midTurn { busy = false }
                hangUp()
                return
            }
            let hushed = await door.value
            lessonOn = hushed.kind == "lesson"
            // Always through the door, even with nothing hushed: the
            // listener's turn is over, so the daemon's queue plays on.
            if await AgentClient.door(heard) {
                // The talk or lesson answers out loud through the daemon.
                Log.info("door: \"\(heard)\" → \(hushed.kind ?? "?")\(hushed.agentID.map { " (\($0))" } ?? "")")
                if !midTurn { panel.render(.idle); busy = false }
                return
            }
            // "Writer, …" sends this one question to Writer; the target
            // stays. An agent's own shortcut already said who.
            let agent: String
            if let forced { agent = forced }
            else if let call = activeCall { agent = call.agentId }
            else {
                // Any agent on the mesh, by name. One on another node is
                // remembered, so the pill and the menu can name and colour it.
                let addressed = await AgentClient.address(heard, target: Config.effectiveAgentID)
                statusMenu.learn(addressed)
                agent = addressed.agentID
            }
            if midTurn {
                // Another agent: ask it alongside ours rather than waiting.
                if agent != turnAgent && !Self.isStop(heard) {
                    askAside(heard, agent: agent)
                    panel.render(.working("Asked \(statusMenu.name(of: agent))", 0))
                    return
                }
                // Our own turn is still thinking. The agent cannot change
                // course mid-turn, so his words go next and the stale
                // answer is not spoken; "stop" just drops it, and every
                // aside with it.
                if Self.isStop(heard) {
                    abandoned = true; followUp = nil
                    stopGeneration += 1; waitingAsides.removeAll(); publishThinking()
                    Log.info("door: stop → dropping the turn in flight")
                } else {
                    followUp = heard
                    Log.info("door: \"\(heard)\" → next, instead of the answer in flight")
                }
                panel.render(.working("Got it — one moment", 0))
                return
            }
            // That agent is still answering an aside: this question waits
            // behind it rather than running beside it.
            if inFlight[agent] != nil && !Self.isStop(heard) {
                askAside(heard, agent: agent)
                panel.render(.working("Queued for \(statusMenu.name(of: agent))", 0))
                busy = false; resetSoon()
                return
            }
            await runTurn(heard, agent: agent)
        }
    }

    /// A question for another agent while our own turn thinks. It runs
    /// alongside; the answer waits its turn in the daemon's speaking queue,
    /// so it never talks over ours. An agent already answering an aside
    /// gets this one next, not at the same time.
    private func askAside(_ heard: String, agent: String) {
        if inFlight[agent] != nil || waitingAsides[agent] != nil {
            waitingAsides[agent, default: []].append(heard)
            publishThinking()
            Log.info("aside → \(agent) (waits for its answer in flight): \(heard)")
            return
        }
        runAside(heard, agent: agent)
    }

    private func runAside(_ heard: String, agent: String) {
        let generation = stopGeneration
        openAsides += 1
        Log.info("aside → \(agent): \(heard)")
        Task { @MainActor in
            defer { openAsides -= 1 }
            let result: Result<AgentClient.Answer, Error>
            do { result = .success(try await ask(heard, agent: agent)) }
            catch { result = .failure(error) }
            // The next question for this agent goes now, while this
            // answer waits to be spoken.
            startNextAside(for: agent)
            guard generation == stopGeneration else { return }
            switch result {
            case .success(let answer):
                Log.info("aside answer (\(answer.agentID ?? agent)): \(answer.text)")
                if AnswerView.isWorthShowing(spoken: answer.text, written: answer.written,
                                             buttons: answer.buttons, imageURL: answer.imageURL) {
                    panel.showAnswer(spoken: answer.text, written: answer.written,
                                     buttons: answer.buttons, imageURL: answer.imageURL)
                }
                // Nothing else on screen: the pill shows this answer, its
                // orb in this agent's colour, while it is spoken.
                let onScreen = !busy && !recorder.isRecording
                if onScreen { asideSpeaker = agent; panel.render(.saying(answer.text)) }
                await Speech.say(answer.text, agentID: answer.agentID ?? agent, kind: "answer", voice: answer.voice)
                if onScreen && asideSpeaker == agent {
                    asideSpeaker = nil
                    if !busy && !recorder.isRecording { panel.render(.idle) }
                }
            case .failure(let error):
                Log.warn("aside failed (\(agent)): \(error.localizedDescription)")
                await Speech.say("Sorry, \(statusMenu.name(of: agent)) couldn't answer that.", agentID: nil, kind: "line", voice: nil)
            }
        }
    }

    /// Send the oldest question waiting for `agent`, if any.
    private func startNextAside(for agent: String) {
        guard var waiting = waitingAsides[agent], !waiting.isEmpty else {
            waitingAsides[agent] = nil
            return
        }
        let next = waiting.removeFirst()
        waitingAsides[agent] = waiting.isEmpty ? nil : waiting
        runAside(next, agent: agent)
        publishThinking()
    }

    static func isStop(_ s: String) -> Bool {
        s.range(of: #"^\s*(stop|stop talking|that'?s enough|enough)[\s.!]*$"#,
                options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// One question and its spoken answer. Words said through the door
    /// while it thinks replace the answer with the next turn.
    private func runTurn(_ heard: String, agent: String) async {
        silenced = false
        turnAgent = agent
        do {
            beginNarration(agent)

            let answer = try await ask(heard, agent: agent)
            endNarration()
            if abandoned {
                abandoned = false
                Log.info("dropped answer (\(answer.agentID ?? "?")): \(answer.text)")
                panel.render(.idle); busy = false; return
            }
            if let next = followUp {
                followUp = nil
                Log.info("superseded answer (\(answer.agentID ?? "?")): \(answer.text)")
                panel.render(.thinking)
                return await runTurn(next, agent: agent)
            }
            if let v = answer.voice { voice = v }
            Log.info("answer (\(answer.agentID ?? "?")): \(answer.text)")
            // Show BEFORE speaking, but only when there is something
            // the speech cannot deliver — a link, an image, or more
            // text than was read aloud. A card that opens on every
            // "Ok." teaches you to ignore it.
            if AnswerView.isWorthShowing(spoken: answer.text, written: answer.written,
                                         buttons: answer.buttons, imageURL: answer.imageURL) {
                panel.showAnswer(spoken: answer.text, written: answer.written,
                                 buttons: answer.buttons, imageURL: answer.imageURL)
            } else {
                panel.collapse()
            }
            // Stopped while it was thinking: the answer is not spoken.
            if silenced { silenced = false; panel.render(.idle); busy = false; return }
            // Scroll the sentence being spoken, so it can be read as
            // well as heard — and re-read after, which speech cannot do.
            panel.render(.saying(answer.text))
            // Queued on the daemon behind whatever is already speaking.
            let line = Task { await Speech.say(answer.text, agentID: answer.agentID, kind: "answer", voice: voice) }
            speaking = line
            await line.value
            if speaking == line { speaking = nil }
            // Cut off by the door: the new words are being recorded.
            if recorder.isRecording { busy = false; return }
            // Stopped: no follow-up window, the listener asked for quiet.
            if silenced { silenced = false; panel.render(.idle); busy = false; return }
            if let next = followUp { followUp = nil; return await runTurn(next, agent: agent) }
            panel.render(.idle)
            // Leave the microphone open for a moment. Say nothing and
            // it closes itself; start talking and the conversation
            // simply continues.
            busy = false
            // A live lesson now runs on screen and speaks for itself; an
            // open mic would hear the agent. Option-Space is the door.
            if ["teach", "watch", "act"].contains(answer.presenceMode ?? "") { lessonOn = true; return }
            // Another agent's answer is still to come; an open mic would
            // take it for the listener's words.
            if openAsides > 0 { return }
            listenHandsFree(followUp: true)
        } catch {
            endNarration()
            Log.warn("turn failed: \(error.localizedDescription)")
            if abandoned { abandoned = false; panel.render(.idle); busy = false; return }
            if let next = followUp { followUp = nil; return await runTurn(next, agent: agent) }
            panel.render(.error(short(error.localizedDescription)))
            // Say it aloud too — a voice assistant that fails only in
            // a 230px label has failed silently for anyone not looking.
            await Speech.say("Sorry, that didn't work.", agentID: nil, kind: "line", voice: voice)
            resetSoon()
        }
        busy = false
    }

    /// Narrate the wait using what the daemon says it is actually doing.
    ///
    /// Two sources, because neither alone is enough: `task:step` events
    /// say what the agent is doing but arrive irregularly, and a 1-second
    /// ticker proves the thing is still alive between them. Together they
    /// answer both "what is it doing" and "is it stuck".
    private func beginNarration(_ agent: String) {
        startedAt = Date()
        lastStep = "Thinking…"
        spokenSteps.removeAll()
        lastSpokeAt = Date()
        panel.render(.working(lastStep, 0))

        // Progress delivers on its own serial queue; hop to main before
        // touching any view.
        progress = Progress(agentID: agent) { [weak self] step, voice in
            Task { @MainActor in
                guard let self, self.busy else { return }
                if let voice { self.voice = voice }
                self.lastStep = step
                Log.info("step: \(step)")
                self.panel.render(.working(step, Int(Date().timeIntervalSince(self.startedAt))))
                self.speakStepIfDue(step)
            }
        }
        progress?.start()

        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.busy else { return }
                self.panel.render(.working(self.lastStep, Int(Date().timeIntervalSince(self.startedAt))))
            }
        }
    }

    private func endNarration() {
        ticker?.invalidate(); ticker = nil
        progress?.stop(); progress = nil
    }

    /// Say what it is doing, sparingly.
    ///
    /// Silence during a long turn reads as a broken assistant, and a
    /// visible label does not help someone who asked by voice precisely
    /// because they were not looking at the screen. But narrating every
    /// step would talk over itself and be worse than silence — so: nothing
    /// for the first stretch, then at most one short line every 15
    /// seconds, and never the same step twice.
    private func speakStepIfDue(_ step: String) {
        let elapsed = Date().timeIntervalSince(startedAt)
        guard elapsed > 12 else { return }
        guard Date().timeIntervalSince(lastSpokeAt) > 15 else { return }

        // The step is "Tool: detail". Both halves go to the daemon, which
        // decides whether it is worth saying and in what words. Reading the
        // detail aloud directly is what produced "still working, osascript
        // tell application Calendar".
        let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
        let tool = parts.first?.trimmingCharacters(in: .whitespaces) ?? step
        let detail = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""

        // Reserve the slot before awaiting, or two steps arriving together
        // both pass the interval check and talk over each other.
        lastSpokeAt = Date()
        Task { @MainActor in
            guard let phrase = await AgentClient.phrase(
                tool: tool, detail: detail, elapsed: Int(elapsed)) else { return }
            guard !self.spokenSteps.contains(phrase) else { return }
            self.spokenSteps.insert(phrase)
            await Speech.say(phrase.prefix(1).capitalized + phrase.dropFirst() + ".", agentID: nil, kind: "narration", voice: self.voice)
        }
    }

    // --- Calls (#321) ---
    //
    // An agent rings: the pill shows who and why, rings, and offers Answer,
    // Later and Decline. Answering sends the daemon's opener through /ask,
    // so the agent speaks first; then the usual hands-free loop runs with
    // the caller as the agent until hang-up.

    /// At rest: waiting for the next words in a call, else idle.
    private var rest: Panel.State { activeCall == nil ? .idle : .onCall }

    /// A new call can ring: no call in progress, no turn, microphone closed.
    private var canRing: Bool { activeCall == nil && !busy && !recorder.isRecording }

    private func polled(_ state: RingingCalls) {
        switch CallModel.action(ringing: ringingCall?.id, calls: state.calls, canRing: canRing) {
        case .none:
            return
        case .stop:
            Log.info("call: stopped ringing")
            ringer.stop()
            ringingCall = nil
            panel.showCall(.hidden)
            panel.render(.idle)
        case .ring(let call):
            Log.info("call: \(call.agentId) is calling: \(call.reason)")
            ringingCall = call
            summonPill()
            panel.showCall(.ringing)
            panel.render(.ringing(CallModel.ringingText(name: statusMenu.name(of: call.agentId), reason: call.reason)))
            ringer.start(sound: state.ringSound)
        }
    }

    /// Decline or later: the ring stops and the pill goes back to rest.
    private func endRinging(_ send: @escaping (String) async -> Void) {
        guard let call = ringingCall else { return }
        ringer.stop()
        ringingCall = nil
        panel.showCall(.hidden)
        panel.render(.idle)
        Task { await send(call.id) }
    }

    private func answerCall() {
        // A turn of our own is still running: keep ringing until it ends.
        guard let call = ringingCall, !busy else { return }
        if recorder.isRecording { stopPolling(); _ = recorder.stop() }
        ringer.stop()
        ringingCall = nil
        answeringCall = call.id
        busy = true
        panel.render(.thinking)
        Task { @MainActor in
            let answer = await CallClient.answer(call.id)
            answeringCall = nil
            guard let opener = answer else {
                busy = false
                panel.showCall(.hidden)
                panel.render(.error("The call ended"))
                resetSoon()
                return
            }
            Log.info("call: answered \(call.id)")
            activeCall = call
            panel.showCall(.connected)
            await runTurn(opener, agent: call.agentId)
        }
    }

    /// Hang up: the button, "bye", or closing the pill during a call.
    private func hangUp() {
        guard let call = activeCall else { return }
        Log.info("call: hung up \(call.id)")
        activeCall = nil
        panel.showCall(.hidden)
        if recorder.isRecording { stopPolling(); _ = recorder.stop() }
        stopSpeaking()
        Task { await CallClient.hangUp(call.id) }
    }

    private func short(_ s: String) -> String {
        s.count > 40 ? String(s.prefix(38)) + "…" : s
    }

    private func resetSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.recorder.isRecording, !self.busy else { return }
                self.panel.render(self.rest)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { App() }
app.delegate = delegate
app.run()
