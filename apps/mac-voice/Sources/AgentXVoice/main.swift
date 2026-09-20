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
    private var busy = false
    private var progress: Progress?
    private var ticker: Timer?
    private var startedAt = Date()
    private var lastStep = "Thinking…"
    private var spokenSteps = Set<String>()
    private var lastSpokeAt = Date.distantPast

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

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel.orderFrontRegardless()

        hotkey = Hotkey(
            id: 1,
            onPress: { [weak self] in self?.startListening() },
            onRelease: { [weak self] in self?.stopAndSend() })
        hotkey?.register()

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

        recorder.requestPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                if !granted { self.panel.render(.error("Microphone denied")) }
                else { Log.info("ready — hold ⌥Space to talk (agent: \(Config.agentID))") }
            }
        }
    }

    private func startListening() {
        // A turn already in flight must not be interrupted by a stray
        // keypress; the answer is still coming and will be spoken.
        guard !busy, !recorder.isRecording else { return }
        do {
            try recorder.start()
            panel.render(.listening)
        } catch {
            panel.render(.error(error.localizedDescription))
        }
    }

    private func stopAndSend() {
        guard recorder.isRecording else { return }
        guard let wav = recorder.stop() else {
            panel.render(.error("Too short — hold while speaking"))
            resetSoon()
            return
        }
        busy = true
        panel.render(.thinking)

        Task { @MainActor in
            do {
                let heard = try await Speech.transcribe(wav: wav)
                guard !heard.isEmpty else {
                    panel.render(.error("Didn't catch that"))
                    busy = false; resetSoon(); return
                }
                Log.info("heard: \(heard)")
                beginNarration()

                let answer = try await AgentClient.ask(heard)
                endNarration()
                Log.info("answer: \(answer.text)")
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
                // Scroll the sentence being spoken, so it can be read as
                // well as heard — and re-read after, which speech cannot do.
                panel.render(.saying(answer.text))
                await Speech.speak(answer.text)
                panel.render(.idle)
            } catch {
                endNarration()
                Log.warn("turn failed: \(error.localizedDescription)")
                panel.render(.error(short(error.localizedDescription)))
                // Say it aloud too — a voice assistant that fails only in
                // a 230px label has failed silently for anyone not looking.
                await Speech.speak("Sorry, that didn't work.")
                resetSoon()
            }
            busy = false
        }
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
        progress = Progress(agentID: Config.agentID) { [weak self] step in
            Task { @MainActor in
                guard let self, self.busy else { return }
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
            await Speech.speak(phrase.prefix(1).capitalized + phrase.dropFirst() + ".")
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
