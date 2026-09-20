import AppKit

/// AgentX Voice — push-to-talk widget over the daemon's /ask endpoint.
///
/// Hold ⌥Space, speak, release. Transcribe (ElevenLabs, falling back to
/// on-device mlx-whisper), POST to /ask, speak the answer (ElevenLabs,
/// falling back to `say`).
///
/// Deliberately has NO computer-use capability in this slice. The point is
/// to find out whether talking to an agent this way is actually pleasant
/// before building the part that can click things.
final class App: NSObject, NSApplicationDelegate {
    private let panel = Panel()
    private let recorder = Recorder()
    private var hotkey: Hotkey?
    private var busy = false
    private var progress: Progress?
    private var ticker: Timer?
    private var startedAt = Date()
    private var lastStep = "Thinking…"

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel.orderFrontRegardless()

        hotkey = Hotkey(
            onPress: { [weak self] in self?.startListening() },
            onRelease: { [weak self] in self?.stopAndSend() })
        hotkey?.register()

        recorder.requestPermission { [weak self] granted in
            guard let self else { return }
            if !granted { self.panel.render(.error("Microphone denied")) }
            else { Log.info("ready — hold ⌥Space to talk (agent: \(Config.agentID))") }
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
                panel.render(.speaking)
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
        panel.render(.working(lastStep, 0))

        progress = Progress(agentID: Config.agentID) { [weak self] step in
            guard let self, self.busy else { return }
            self.lastStep = step
            Log.info("step: \(step)")
            self.panel.render(.working(step, Int(Date().timeIntervalSince(self.startedAt))))
        }
        progress?.start()

        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, self.busy else { return }
            self.panel.render(.working(self.lastStep, Int(Date().timeIntervalSince(self.startedAt))))
        }
    }

    private func endNarration() {
        ticker?.invalidate(); ticker = nil
        progress?.stop(); progress = nil
    }

    private func short(_ s: String) -> String {
        s.count > 40 ? String(s.prefix(38)) + "…" : s
    }

    private func resetSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, !self.recorder.isRecording, !self.busy else { return }
            self.panel.render(.idle)
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.run()
