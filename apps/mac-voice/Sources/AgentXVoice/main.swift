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
    private let card = ResultCard()
    private let recorder = Recorder()
    private var hotkey: Hotkey?
    private var pasteHotkey: Hotkey?
    private var stopHotkey: Hotkey?
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
    /// Words said while our own turn was still running: they go next, and
    /// the stale answer is not spoken.
    private var followUp: String?
    /// "stop" while our own turn was running: drop its answer.
    private var abandoned = false

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
        panel.orderFrontRegardless()

        hotkey = Hotkey(
            id: 1,
            onPress: { [weak self] in self?.startListening() },
            onRelease: { [weak self] in self?.stopAndSend() })
        hotkey?.register()
        panel.onClick = { [weak self] in self?.toggleListening() }

        // Turning the hold OFF is the moment anything that piled up
        // becomes welcome. Without this the queue is a hole rather than a
        // delay — the daemon's watcher only notices SYSTEM Focus ending,
        // and this switch is not that.
        panel.onHoldChanged = { [weak self] nowOn in
            guard let self else { return }
            self.panel.render(.idle)
            if !nowOn { Hold.flushHeld() }
            Log.info(nowOn ? "notifications held" : "notifications delivering")
        }

        // ⌘⌥V: reshape the clipboard for wherever the caret is, then paste.
        // Fires on RELEASE so the modifiers are up before cmd-V is sent —
        // pressing it while ⌘⌥ are still held produces a different chord
        // in the destination app.
        pasteHotkey = Hotkey(
            id: 2,
            onPress: {},
            onRelease: { [weak self] in self?.smartPaste() })
        pasteHotkey?.register(keyCode: UInt32(kVK_ANSI_V),
                              modifiers: UInt32(cmdKey | optionKey))

        // ⌘⌥. (and the pill's menu): stop every voice now. ⌘. is the Mac's
        // own "cancel"; Option keeps it from reaching the app in front.
        stopHotkey = Hotkey(
            id: 3,
            onPress: {},
            onRelease: { [weak self] in self?.stopSpeaking() })
        stopHotkey?.register(keyCode: UInt32(kVK_ANSI_Period),
                             modifiers: UInt32(cmdKey | optionKey))
        panel.onStop = { [weak self] in self?.stopSpeaking() }

        recorder.requestPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                if !granted { self.panel.render(.error("Microphone denied")) }
                else { Log.info("ready — hold ⌥Space to talk (agent: \(Config.agentID))") }
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
    // is the room going quiet.

    /// RMS above which the microphone is hearing a voice rather than a room.
    private let speechLevel: Float = 0.02
    /// Quiet this long after speech ends the turn.
    private let endSilence: TimeInterval = 1.2
    /// How long an unprompted follow-up window waits before giving up.
    private let followUpPatience: TimeInterval = 4.0
    /// How long a clicked session waits for you to start talking.
    private let clickPatience: TimeInterval = 8.0

    private var listenPoll: Timer?
    private var heardSpeech = false
    private var quietSince: Date?
    private var openedAt = Date()
    private var patience: TimeInterval = 8.0
    /// True when nothing was said and the window should close in silence.
    private var silentClose = false

    /// Open the microphone with no key held.
    private func listenHandsFree(followUp: Bool) {
        guard !busy, !recorder.isRecording else { return }
        do {
            try recorder.start()
        } catch {
            panel.render(.error(error.localizedDescription))
            return
        }
        heardSpeech = false
        quietSince = nil
        openedAt = Date()
        patience = followUp ? followUpPatience : clickPatience
        silentClose = followUp
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
        let level = recorder.level

        if level > speechLevel {
            heardSpeech = true
            quietSince = nil
            return
        }
        if heardSpeech {
            // Speech has stopped. Give it a beat before deciding the
            // sentence is over — people pause inside sentences.
            let since = quietSince ?? Date()
            quietSince = since
            if Date().timeIntervalSince(since) >= endSilence {
                stopPolling()
                stopAndSend()
            }
            return
        }
        // Nothing said yet. Close quietly rather than making the person
        // dismiss a window they did not ask for.
        if Date().timeIntervalSince(openedAt) >= patience {
            stopPolling()
            _ = recorder.stop()
            panel.render(silentClose ? .idle : .error("Didn't catch that"))
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
        lastSpokeAt = Date()
        Task { await Speech.stopAll() }
        if !recorder.isRecording { panel.render(.idle) }
    }

    private func startListening() {
        // A held key overrides any hands-free window that is open, so the
        // two ways of talking never fight over the microphone.
        stopPolling()
        guard !recorder.isRecording else { return }
        // Option-Space is the door to everything spoken, always: our own
        // answer or step line stops now, and the daemon hushes any talk,
        // lesson or narration, remembering which it was. Even mid-turn —
        // ignoring the key while busy is how Anis spoke to a lesson and
        // nothing listened.
        Speech.stop()
        lastSpokeAt = Date()
        talkCheck = Task { await AgentClient.hush() }
        Log.info("door: opened\(busy ? " (a turn is running)" : "")")
        do {
            try recorder.start()
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
        guard let wav = recorder.stop() else {
            panel.render(.error("Too short — hold while speaking"))
            resetSoon()
            return
        }
        let midTurn = busy
        busy = true
        if !midTurn { panel.render(.thinking) }

        Task { @MainActor in
            let heard = (try? await Speech.transcribe(wav: wav)) ?? ""
            guard !heard.isEmpty else {
                if !midTurn { panel.render(.error("Didn't catch that")); busy = false; resetSoon() }
                return
            }
            Log.info("heard: \(heard)")
            let hushed = await door.value
            if hushed.kind != nil, await AgentClient.door(heard) {
                // The talk or lesson answers out loud through the daemon.
                Log.info("door: \"\(heard)\" → \(hushed.kind!)\(hushed.agentID.map { " (\($0))" } ?? "")")
                if !midTurn { panel.render(.idle); busy = false }
                return
            }
            if midTurn {
                // Our own turn is still thinking. The agent cannot change
                // course mid-turn, so his words go next and the stale
                // answer is not spoken; "stop" just drops it.
                if Self.isStop(heard) { abandoned = true; followUp = nil; Log.info("door: stop → dropping the turn in flight") }
                else { followUp = heard; Log.info("door: \"\(heard)\" → next, instead of the answer in flight") }
                panel.render(.working("Got it — one moment", 0))
                return
            }
            await runTurn(heard)
        }
    }

    static func isStop(_ s: String) -> Bool {
        s.range(of: #"^\s*(stop|stop talking|that'?s enough|enough)[\s.!]*$"#,
                options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// One question and its spoken answer. Words said through the door
    /// while it thinks replace the answer with the next turn.
    private func runTurn(_ heard: String) async {
        silenced = false
        do {
            beginNarration()

            let answer = try await AgentClient.ask(heard)
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
                return await runTurn(next)
            }
            if let v = answer.voice { voice = v }
            Log.info("answer (\(answer.agentID ?? "?")): \(answer.text)")
            // Show BEFORE speaking, but only when there is something
            // the speech cannot deliver — a link, an image, or more
            // text than was read aloud. A card that opens on every
            // "Ok." teaches you to ignore it.
            if ResultCard.isWorthShowing(spoken: answer.text, written: answer.written,
                                         buttons: answer.buttons, imageURL: answer.imageURL) {
                card.show(spoken: answer.text, written: answer.written,
                          buttons: answer.buttons, imageURL: answer.imageURL)
            } else {
                card.orderOut(nil)
            }
            // Stopped while it was thinking: the answer is not spoken.
            if silenced { silenced = false; panel.render(.idle); busy = false; return }
            // Scroll the sentence being spoken, so it can be read as
            // well as heard — and re-read after, which speech cannot do.
            panel.render(.saying(answer.text))
            await Speech.speak(answer.text, voice: voice)
            // Cut off by the door: the new words are being recorded.
            if recorder.isRecording { busy = false; return }
            // Stopped: no follow-up window, the listener asked for quiet.
            if silenced { silenced = false; panel.render(.idle); busy = false; return }
            if let next = followUp { followUp = nil; return await runTurn(next) }
            panel.render(.idle)
            // Leave the microphone open for a moment. Say nothing and
            // it closes itself; start talking and the conversation
            // simply continues.
            busy = false
            // A live lesson now runs on screen and speaks for itself; an
            // open mic would hear the agent. Option-Space is the door.
            if ["teach", "watch", "act"].contains(answer.presenceMode ?? "") { return }
            listenHandsFree(followUp: true)
        } catch {
            endNarration()
            Log.warn("turn failed: \(error.localizedDescription)")
            if abandoned { abandoned = false; panel.render(.idle); busy = false; return }
            if let next = followUp { followUp = nil; return await runTurn(next) }
            panel.render(.error(short(error.localizedDescription)))
            // Say it aloud too — a voice assistant that fails only in
            // a 230px label has failed silently for anyone not looking.
            await Speech.speak("Sorry, that didn't work.", voice: voice)
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
    private func beginNarration() {
        startedAt = Date()
        lastStep = "Thinking…"
        spokenSteps.removeAll()
        lastSpokeAt = Date()
        panel.render(.working(lastStep, 0))

        // Progress delivers on its own serial queue; hop to main before
        // touching any view.
        progress = Progress(agentID: Config.agentID) { [weak self] step, voice in
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
            await Speech.speak(phrase.prefix(1).capitalized + phrase.dropFirst() + ".", voice: self.voice)
        }
    }

    private func short(_ s: String) -> String {
        s.count > 40 ? String(s.prefix(38)) + "…" : s
    }

    private func resetSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.recorder.isRecording, !self.busy else { return }
                self.panel.render(.idle)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { App() }
app.delegate = delegate
app.run()
