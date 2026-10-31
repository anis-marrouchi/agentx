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
    /// voice.startReduced has been applied for this launch.
    private var startApplied = false
    /// The character playing on a frozen picture of the screen (#505).
    private let play = PlayHost()
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
    /// from the daemon at launch, every few seconds after that, and after
    /// every save; defaults until then.
    private var settings: VoiceSettings?
    /// The agent a per-agent shortcut is asking; nil for the talk key.
    private var forcedAgent: String?
    /// The open request the talk key continues: its row was picked by the
    /// keyboard in the list when the key went down (#1455).
    private var forcedRequest: Int?
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
    /// The answer in the pill, for Listen again (#492): what was said, by
    /// which agent, in which voice.
    private var shownAnswer: (text: String, agentID: String?, voice: VoiceChoice?)?
    /// Listen again in progress; a second click stops it.
    private var replaying: Task<Void, Never>?
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

    // Send and move on (#1455): a request outside a call runs on its own,
    // and its answer waits in the open-requests list until it is picked.

    /// Every request sent outside a call, until it has been heard.
    private var requests = OpenRequests()
    /// Each answered request's answer, until its row leaves the list.
    private var answers: [Int: AgentClient.Answer] = [:]
    /// The list beside the pill.
    private let requestsWindow = RequestsWindow()
    private var listHotkey: Hotkey?
    /// Opens the list after half a second's hover on the pill.
    private var hoverOpen: DispatchWorkItem?
    /// Puts the pill back to rest after a passing line.
    private var noteReset: DispatchWorkItem?

    // An agent ringing the owner (#321).
    private let callWatcher = CallWatcher()
    private let guideWatcher = GuideWatcher()
    /// Who may speak and show a bubble on this Mac (#924).
    private let floorWatcher = FloorWatcher()
    /// Who held the floor at its last change, for the log.
    private var floorHolder: String?
    /// The microphone is open with no key held and no click: a follow-up
    /// window. What it hears while a holder plays sound is thrown away.
    private var openedByItself = false
    /// A play runs, or its picture is being taken (#562).
    private var playing = false
    /// When the app started, for the hint in the character's bubble.
    private let launched = ProcessInfo.processInfo.systemUptime
    private let ringer = Ringer()
    /// The call ringing on the pill now.
    private var ringingCall: IncomingCall?
    /// The call being answered, until the daemon has the answer: a poll
    /// sent meanwhile still says the pill is showing it (#408).
    private var answeringCall: String?
    /// The call in progress: every turn goes to its agent until hang-up.
    private var activeCall: IncomingCall?

    /// /ask, counted in flight for the menu while it thinks.
    private func ask(_ heard: String, agent: String, handsFree: Bool = false) async throws -> AgentClient.Answer {
        track(agent, 1)
        defer { track(agent, -1) }
        return try await AgentClient.ask(heard, agent: agent, handsFree: handsFree)
    }

    /// The floor was taken, renewed or freed (#924). A recording takes
    /// the character and the pill off the screen; a holder that plays
    /// sound closes a microphone that had opened by itself.
    private func floorChanged(_ floor: FloorState) {
        if floor.holder != floorHolder {
            floorHolder = floor.holder
            // Just taken: an answer being read or said leaves the screen.
            // Its line is cut on the daemon and plays again after.
            if floor.held && !recorder.isRecording { panel.collapse(); panel.render(rest) }
            Log.info(floor.held
                ? "floor: held by \(floor.holder ?? "?")\(floor.sound ? ", plays sound" : "")\(floor.hide ? ", everything hidden" : "")"
                : "floor: free")
        }
        character.setConcealed(floor.hidesEverything)
        panel.setConcealed(floor.hidesEverything)
        statusMenu.floor = floor
        if floor.closesOpenMicrophone && recorder.isRecording && openedByItself {
            Log.info("floor: closing the microphone it opened by itself")
            openedByItself = false
            stopPolling()
            _ = recorder.stop()
            panel.render(rest)
        }
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
        for (agent, n) in requests.waiting { counts[agent, default: 0] += n }
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
        snap.waiting = waitingAsides.mapValues(\.count).merging(requests.waiting, uniquingKeysWith: +)
        snap.playing = queue?.playing?.agentId
        snap.toSpeak = queue?.waiting.compactMap(\.agentId) ?? []
        snap.ready = requests.readyAgents
        snap.failed = requests.failedAgents
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
            if key.register(spec) { Log.info("shortcut \(spec.text ?? "?") for \(what): registered") }
            else { Log.warn("shortcut \(spec.text ?? "?") for \(what) is taken by another app") }
        }

        // Hold to talk; release sends. With a row picked by the keyboard in
        // the open-requests list, the words go to that row's agent and, on
        // a request's row, continue that request in its row.
        let talk = Hotkey(id: 1,
                          onPress: { [weak self] in
                              self?.forcedAgent = self?.listAgent
                              self?.forcedRequest = self?.listRequest
                              self?.startListening()
                          },
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

        // The open-requests list, with the keyboard in it (#1455).
        let list = Hotkey(id: 5, onPress: {}, onRelease: { [weak self] in self?.openList(keyboard: true) })
        register(list, HotkeySpec("cmd+opt+o")!, "open requests")
        listHotkey = list

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
        hotkey = nil; pasteHotkey = nil; stopHotkey = nil; menuHotkey = nil; listHotkey = nil
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
        character.strolls = saved.general.stroll == true
        character.animates = IdlePlay.gap(saved.general.animations)
        if !asCharacter { panel.detach() }
        idleWords()
        // voice.startReduced is how the assistant starts: read once. With
        // the character, it starts without its bubble.
        if !startApplied {
            startApplied = true
            if saved.general.startReduced == true { panel.summon(); panel.setReduced(true) }
        }
        if settingsWindow.model.recording == nil { registerHotkeys() }
        // Colours may have changed.
        statusMenu.refresh()
        Log.info("settings: talk \(saved.general.hotkeys.talk), speech to text \(saved.general.stt)")
    }

    /// A play can start: the character shows and may move, and the
    /// assistant has nothing to say or hear.
    private var canPlay: Bool {
        character.onScreen == true && Config.animatedOrb
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            && !busy && !recorder.isRecording && !play.running && !floorWatcher.state.held
    }

    /// What the idle bubble says (#562): no hint at a guide stop, on the
    /// way there or during a play; the stop's caption if it has one.
    /// The character's bubble says the hint only just after the app
    /// starts, then there is none at idle (#576).
    private func idleWords() {
        let hint = GuideMath.hintShows(character: settings?.general.look == "character",
                                       sinceStart: ProcessInfo.processInfo.systemUptime - launched, held: Hold.isOn)
        panel.setIdle(GuideMath.idle(caption: character.caption, away: character.sent || playing, hint: hint))
    }

    /// "Play on this page" (#505): one picture of the character's screen, the
    /// lines of text read on it, and the character plays on the picture,
    /// differently each time. The page itself is never touched.
    private func startPlay() {
        guard canPlay, let screen = NSScreen.screens.first(where: { $0.frame.contains(character.foot) }) ?? NSScreen.screens.first
        else { return }
        guard PlayRead.allowed else {
            PlayRead.ask()
            Log.warn("play: no Screen Recording permission; allow AgentX Voice in System Settings, then quit and reopen it")
            panel.render(.error("Allow Screen Recording"))
            resetSoon()
            return
        }
        let stops = character.stops, size = screen.frame.size
        // No idle bubble while it is away. The picture leaves the character
        // and its bubble out, so the character stays where it is meanwhile.
        playing = true
        idleWords()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard let picture = PlayRead.picture(of: screen, without: character.windows + [panel.windowNumber]), !busy, !recorder.isRecording else {
                playing = false
                idleWords()
                return
            }
            let foot = character.foot
            let start = PlayMath.Point(x: foot.x - screen.frame.minX, y: screen.frame.maxY - foot.y)
            play.start(picture: picture, on: screen, stops: stops, at: start)
            // It is on the picture now, where it stood and as big: its own
            // window goes from under it, and it never disappears (#580).
            character.setAway(true)
            let number = play.number
            let asked = ProcessInfo.processInfo.systemUptime
            let lines = await Task.detached { PlayRead.lines(in: picture, size: size) }.value
            Log.info("play: \(lines.count) lines read in \(Int((ProcessInfo.processInfo.systemUptime - asked) * 1000)) ms")
            // Ended while its text was read, and maybe started again since:
            // these lines belong to a picture that is gone.
            guard play.running, play.number == number else { return }
            let steps = PlayMath.script(lines, width: size.width, height: size.height, seed: .random(in: 0 ... .max))
            if steps.isEmpty { play.end("no line of text to play on") }
            else { play.play(Play(lines: lines, steps: steps, start: start, size: PlayMath.Point(x: size.width, y: size.height))) }
        }
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
        requestsWindow.dismissList()
        character.setHidden(true)
        if recorder.isRecording {
            stopPolling()
            _ = recorder.stop()
            forcedAgent = nil
            forcedRequest = nil
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
        character.bubble = { [weak self] head, visible, small in
            guard let panel = self?.panel else { return nil }
            panel.attach(head: head, visible: visible, small: small)
            return panel.isVisible ? panel.frame : nil
        }
        character.bubbleShows = { [weak self] in self?.panel.holdsSomething ?? false }
        panel.onLook = { [weak self] state, tint, colors in
            self?.character.show(state.activity, tint: tint, colors: colors)
            // The assistant has something to show: play gives way.
            if state.activity != .idle { self?.play.end("the assistant is busy") }
        }
        statusMenu.playReady = { [weak self] in self?.canPlay ?? false }
        statusMenu.onPlay = { [weak self] in self?.startPlay() }
        play.onEnd = { [weak self] in
            guard let self else { return }
            self.playing = false
            self.character.setAway(false)
            self.idleWords()
        }
        panel.onShown = { [weak self] in self?.character.redraw() }
        panel.onDismiss = { [weak self] in self?.dismissPill() }
        panel.agentPalette = { [weak self] in
            guard let self else { return nil }
            return self.statusMenu.palette(of: self.shownAgent)
        }
        panel.answer.onOpenChat = { [weak self] in self?.openChat() }
        // The open-requests list (#1455): a click on the mini orbs or "1 new",
        // half a second's hover, ⌘⌥O or the menu opens it.
        requestsWindow.rows = { [weak self] newestLast, agent in
            self?.listRows(newestLast: newestLast, agent: agent) ?? []
        }
        requestsWindow.pillFrame = { [weak self] in self?.panel.frame ?? .zero }
        requestsWindow.agentName = { [weak self] id in self?.statusMenu.name(of: id) ?? id }
        requestsWindow.model.onPick = { [weak self] id in self?.pick(id) }
        requestsWindow.model.onHistory = { [weak self] agent in
            self?.requestsWindow.dismissList()
            HistoryWindow.shared.show(agent: agent)
        }
        panel.onOpenList = { [weak self] in self?.openList(keyboard: false) }
        panel.onHover = { [weak self] inside in self?.pillHover(inside) }
        statusMenu.onOpenRequests = { [weak self] in self?.openList(keyboard: true) }
        statusMenu.shortcut = { [weak self] id in
            self?.settings?.agents.first(where: { $0.id == id })?.voice.hotkey.map(HotkeySpec.display)
        }
        panel.answer.onListenAgain = { [weak self] in self?.listenAgain() }
        statusMenu.pillVisible = { [weak self] in self?.panel.isVisible ?? false }
        statusMenu.onHidePill = { [weak self] in self?.dismissPill() }
        statusMenu.pillReduced = { [weak self] in self?.panel.reduced ?? false }
        statusMenu.onReduce = { [weak self] on in
            guard let self else { return }
            Log.info("pill: \(on ? "reduced" : "opened")")
            // Asking for the reduced form brings back a pill, or a
            // character, that was dismissed.
            if on { self.summonPill() }
            self.panel.setReduced(on)
        }
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
        character.onClick = { [weak self] in self?.toggleListening() }
        character.contextMenu = { [weak self] in self?.statusMenu.menu ?? NSMenu() }
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
        // shortcuts until the app was restarted. And keep reading once it
        // has answered (#482): a change made in the Terminal or in
        // agentx.json shows without a restart. Not during a play, which
        // has put the character away, and not while the microphone is
        // open: applying registers the shortcuts again, and the release
        // of a held talk key would be lost. The next read applies it.
        Task { @MainActor in
            var failures = 0
            while true {
                let asked = settings
                guard let saved = await AgentClient.settings() else {
                    failures += 1
                    if failures == 1 { Log.warn("settings: the daemon did not answer, asking again") }
                    try? await Task.sleep(for: .seconds(VoiceSettings.retryDelay(after: failures)))
                    continue
                }
                failures = 0
                if !play.running, !recorder.isRecording,
                   VoiceSettings.replaces(saved, held: settings, heldWhenAsked: asked) { apply(saved) }
                try? await Task.sleep(for: .seconds(VoiceSettings.rereadDelay))
            }
        }

        // Turning the hold OFF is the moment anything that piled up
        // becomes welcome. Without this the queue is a hole rather than a
        // delay — the daemon's watcher only notices SYSTEM Focus ending,
        // and this switch is not that.
        statusMenu.onHoldChanged = { [weak self] nowOn in
            guard let self else { return }
            self.idleWords()
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
        // The answering agent sends the character to something (#482).
        guideWatcher.wanted = { [weak self] in self?.character.onScreen == true }
        guideWatcher.onCommand = { [weak self] rect, mark, caption, asked in self?.character.guide(to: rect, mark: mark, caption: caption, asked: asked) }
        character.onGuide = { [weak self] in self?.idleWords() }
        // The hint has had its seconds: no bubble at idle from here.
        DispatchQueue.main.asyncAfter(deadline: .now() + GuideMath.hintSeconds) { [weak self] in self?.idleWords() }
        guideWatcher.start()
        character.onScreenChanged = { [weak self] in self?.guideWatcher.start() }
        floorWatcher.onChange = { [weak self] floor in self?.floorChanged(floor) }
        statusMenu.onTakeFloorBack = { Task { await FloorClient.takeBack() } }
        floorWatcher.start()

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
        // A replay is playing (#492): the follow-up window would hear it.
        if followUp && replaying != nil { return }
        // So it would the floor's holder, and take it for the owner (#924).
        if followUp && floorWatcher.state.closesOpenMicrophone { return }
        recorder.endOfTurn = settings?.general.endOfTurn ?? "vad"
        do {
            try recorder.start()
        } catch {
            panel.render(.error(error.localizedDescription))
            return
        }
        if !followUp && lessonOn { talkCheck = Task { await AgentClient.hush() } }
        openedByItself = followUp
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
        endReplay()
        if !recorder.isRecording { panel.render(rest) }
    }

    /// Listen again (#492): the answer in the pill, said again from its
    /// start in its agent's voice. It waits its turn on the daemon's
    /// speaking queue like any line. A second click stops it, the same
    /// stop as the stop shortcut.
    private func listenAgain() {
        switch ListenAgain.click(replaying: replaying != nil, text: shownAnswer?.text) {
        case .nothing: return
        case .stop: stopSpeaking(); return
        case .speak: break
        }
        guard let shown = shownAnswer else { return }
        // An open microphone would take the replay for the listener's
        // words: it closes without sending.
        if recorder.isRecording {
            stopPolling()
            _ = recorder.stop()
            panel.render(rest)
        }
        Log.info("listen again (\(shown.agentID ?? "?"))")
        // Nothing else on screen: the orb speaks while it is said.
        let onScreen = !busy && asideSpeaker == nil
        if onScreen { panel.render(.saying(shown.text)) }
        panel.answer.setReplaying(true)
        let line = Task { await Speech.say(shown.text, agentID: shown.agentID, kind: "answer", voice: shown.voice) }
        replaying = line
        Task { @MainActor [weak self] in
            await line.value
            guard let self, self.replaying == line else { return }
            self.endReplay()
            if onScreen && !self.busy && !self.recorder.isRecording && self.asideSpeaker == nil { self.panel.render(self.rest) }
        }
    }

    /// The speaker button back to Listen again.
    private func endReplay() {
        replaying?.cancel()
        replaying = nil
        panel.answer.setReplaying(false)
    }

    private func startListening() {
        // A held key overrides any hands-free window that is open, so the
        // two ways of talking never fight over the microphone.
        stopPolling()
        play.end("the talk key")
        requestsWindow.dismissList()
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
        // A replay waits, hushed, like any answer, and plays again on
        // resume: the button keeps it, so a click stops it rather than
        // queueing a second copy. It lets go when the daemon's wait ends.
        lastSpokeAt = Date()
        talkCheck = Task { await AgentClient.hush() }
        Log.info("door: opened\(busy ? " (a turn is running)" : "")")
        openedByItself = false
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
        let handsFree = openedByItself
        openedByItself = false
        // The floor's holder was playing sound and nobody asked for the
        // microphone: what it heard is the holder, not the owner (#924).
        if handsFree && floorWatcher.state.closesOpenMicrophone {
            Log.info("floor: dropped what the open microphone heard")
            _ = recorder.stop()
            panel.render(rest)
            return
        }
        // Clicked or hands-free: nothing hushed yet. They did speak, so
        // hush now; whatever was talking gets the words, same as the key.
        let door = talkCheck ?? Task { await AgentClient.hush() }
        talkCheck = nil
        let forced = forcedAgent
        forcedAgent = nil
        let continued = forcedRequest
        forcedRequest = nil
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
                    await apologise("Sorry, I didn't hear that. Please say it again.", voice: voice)
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
            // Send and move on (#1455): outside a call, a request runs on its
            // own and the pill is free for the next one at once. Its answer
            // waits in the open-requests list as not heard.
            if activeCall == nil {
                if !midTurn { busy = false }
                if Self.isStop(heard) { stopSpeaking(); return }
                // A request's row picked: the words continue it, in its row.
                if let continued, requests.request(continued)?.agentID == agent {
                    continueRequest(continued, heard)
                } else {
                    send(heard, agent: agent)
                }
                return
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
            await runTurn(heard, agent: agent, handsFree: handsFree)
        }
    }

    // --- Open requests (#1455) ---

    /// Send a request and move on: it runs on its own, or waits behind the
    /// one its agent is still thinking about.
    private func send(_ heard: String, agent: String) {
        let id = requests.add(agentID: agent, question: heard, at: Date())
        Log.info("request \(id) → \(agent)\(requests.request(id)?.phase == .waiting ? " (waits its turn)" : ""): \(heard)")
        if requests.request(id)?.phase == .thinking { run(id) }
        requestsChanged()
        note("\(statusMenu.name(of: agent)) · \(OpenRequests.sentNote)")
    }

    /// Words said with a request's row picked: they continue that request
    /// in its row rather than adding one. The daemon's voice session keeps
    /// the conversation, so the agent hears them as a follow-up.
    private func continueRequest(_ id: Int, _ heard: String) {
        guard let result = requests.followUp(id, question: heard, at: Date()) else { return }
        let agent = requests.request(id)?.agentID ?? ""
        switch result {
        case .ask:
            Log.info("request \(id) → \(agent), follow-up: \(heard)")
            answers[id] = nil
            run(id)
        case .waits:
            Log.info("request \(id) → \(agent), follow-up (waits its turn): \(heard)")
            answers[id] = nil
        case .afterAnswer:
            Log.info("request \(id) → \(agent), follow-up after the answer in flight: \(heard)")
        }
        requestsChanged()
        note("\(statusMenu.name(of: agent)) · \(OpenRequests.followUpNote)")
    }

    /// Ask the agent. The answer waits as not heard, with a soft sound, or
    /// plays at once with "Play answers at once" ticked. The agent's next
    /// request goes as soon as this one is back.
    private func run(_ id: Int) {
        guard let r = requests.request(id) else { return }
        Task { @MainActor in
            let result: Result<AgentClient.Answer, Error>
            do { result = .success(try await ask(r.question, agent: r.agentID)) }
            catch { result = .failure(error) }
            let now = Date()
            // Words said while it thought go now, in its row, in place of
            // this answer: the owner had already moved on.
            if requests.askPending(id, at: now) {
                Log.info("request \(id): the follow-up goes in place of this answer")
                requestsChanged()
                run(id)
                return
            }
            switch result {
            case .success(let answer) where answer.dropped:
                Log.info("request \(id): the daemon took the words for the floor holder's sound")
                requests.remove(id)
            case .success(let answer):
                Log.info("request \(id) answered (\(answer.agentID ?? r.agentID)): \(answer.text)")
                answers[id] = answer
                requests.answered(id, at: now)
            case .failure(let error):
                Log.warn("request \(id) failed (\(r.agentID)): \(error.localizedDescription)")
                requests.failed(id, reason: Self.reason(error), at: now)
            }
            if let next = requests.startNext(for: r.agentID, at: now) { run(next) }
            requestsChanged()
            guard let done = requests.request(id) else { return }
            if done.phase == .answered && Config.playAnswersAtOnce {
                await waitForFloor(r.agentID, ownTurn: false)
                if requests.request(id)?.heard == false { play(id) }
                return
            }
            cue(done)
        }
    }

    /// Why a request failed, in a line the list and the pill can show.
    private static func reason(_ error: Error) -> String {
        let text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "Something went wrong." }
        return text.count > 140 ? String(text.prefix(139)) + "…" : text
    }

    /// An answer is back, or a request failed: one soft sound, and a line
    /// on the pill for a few seconds. Nothing plays.
    private func cue(_ r: OpenRequests.Request) {
        let name = statusMenu.name(of: r.agentID)
        if case .failed = r.phase { note(OpenRequests.failedNote(name: name)) }
        else { note(OpenRequests.readyNote(name: name)) }
        // Quiet while notifications are held, while someone holds the floor,
        // and while the microphone is open, which would hear it.
        if !Hold.isOn && !floorWatcher.state.held && !recorder.isRecording { NSSound(named: "Pop")?.play() }
    }

    /// A passing line on the pill at rest, back to the pill's own after
    /// a few seconds. Not over listening, a turn, a call or an answer
    /// being said.
    private func note(_ text: String) {
        guard !recorder.isRecording, !busy, asideSpeaker == nil, activeCall == nil, ringingCall == nil else { return }
        noteReset?.cancel()
        panel.render(.note(text))
        let reset = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, case .note(let shown) = self.panel.current, shown == text,
                      !self.recorder.isRecording, !self.busy else { return }
                self.panel.render(self.rest)
            }
        }
        noteReset = reset
        DispatchQueue.main.asyncAfter(deadline: .now() + OpenRequests.noteSeconds, execute: reset)
    }

    /// The pill and the list follow the requests: the mini orbs, "1 new",
    /// the menu's states and the list's rows.
    private func requestsChanged() {
        // Rows that left the list take their answers with them.
        let kept = Set(requests.requests.map(\.id))
        answers = answers.filter { kept.contains($0.key) }
        publishThinking()
        refreshBusy()
        panel.showNew(requests.newCount)
        statusMenu.ready = requests.readyAgents
        requestsWindow.reload()
    }

    /// The agent of the row the keyboard is on in the open list.
    private var listAgent: String? {
        requestsWindow.selectedRow.flatMap { requests.request($0)?.agentID ?? requests.agent(ofGroup: $0) }
    }

    /// The request whose row the keyboard is on in the open list; nil on
    /// an agent's row, whose words start a new request for that agent.
    private var listRequest: Int? {
        requestsWindow.selectedRow.flatMap { requests.request($0)?.id }
    }

    /// Open the list: by a click (no keyboard), or by ⌘⌥O or the menu
    /// (the keyboard lands on the oldest answer not heard yet).
    private func openList(keyboard: Bool) {
        hoverOpen?.cancel()
        hoverOpen = nil
        if keyboard { summonPill() }
        requestsWindow.open(.pinned, select: keyboard ? requests.firstEntry : nil)
    }

    /// Half a second on the pill opens the list, while there is a request
    /// to show; leaving the pill lets a list opened that way go.
    private func pillHover(_ inside: Bool) {
        hoverOpen?.cancel()
        hoverOpen = nil
        guard inside else { requestsWindow.pointerLeft(); return }
        guard !requests.requests.isEmpty, !requestsWindow.isOpen, !recorder.isRecording else { return }
        let open = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.panel.hovering, !self.recorder.isRecording else { return }
                self.requestsWindow.open(.hover)
            }
        }
        hoverOpen = open
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: open)
    }

    /// The list's rows, as OpenRequests words them: one agent's requests
    /// when `agent` is set; past five requests one row per agent; else
    /// every request.
    private func listRows(newestLast: Bool, agent: String? = nil) -> [RequestsModel.Row] {
        let now = Date()
        if agent == nil && requests.isGrouped {
            return requests.groups(newestLast: newestLast).map { g in
                let name = statusMenu.name(of: g.agentID)
                let cue: RequestsModel.Row.Cue
                if g.requests.contains(where: { $0.phase == .answered && !$0.heard }) { cue = .ready }
                else if g.requests.contains(where: { if case .failed = $0.phase { return !$0.heard }; return false }) { cue = .failed }
                else if g.requests.contains(where: { $0.phase == .thinking }) { cue = .thinking }
                else if g.requests.contains(where: { $0.phase == .waiting }) { cue = .waiting }
                else { cue = .heard }
                return RequestsModel.Row(
                    id: g.id, group: g.agentID, name: name, state: OpenRequests.groupState(g, now: now),
                    words: OpenRequests.firstWords(g.latest.question),
                    ago: OpenRequests.ago(Int(now.timeIntervalSince(g.latest.sentAt))),
                    cue: cue, isNew: g.newCount > 0,
                    tint: statusMenu.color(of: g.agentID), colors: statusMenu.palette(of: g.agentID),
                    voiceOver: OpenRequests.groupVoiceOver(name: name, g, now: now), action: "Open")
            }
        }
        let shown = agent.map { requests.rows(for: $0, newestLast: newestLast) } ?? requests.rows(newestLast: newestLast)
        return shown.map { r in
            let name = statusMenu.name(of: r.agentID)
            let cue: RequestsModel.Row.Cue
            let action: String?
            switch r.phase {
            case .waiting: cue = .waiting; action = nil
            case .thinking: cue = .thinking; action = nil
            case .answered: cue = r.heard ? .heard : .ready; action = r.heard ? "Show the answer" : "Listen"
            case .failed: cue = .failed; action = "See why"
            }
            return RequestsModel.Row(
                id: r.id, name: name, state: OpenRequests.stateWords(r, now: now),
                words: OpenRequests.firstWords(r.question),
                ago: OpenRequests.ago(Int(now.timeIntervalSince(r.sentAt))),
                cue: cue, isNew: r.isNew,
                tint: statusMenu.color(of: r.agentID), colors: statusMenu.palette(of: r.agentID),
                voiceOver: OpenRequests.voiceOver(name: name, r, now: now), action: action)
        }
    }

    /// A row picked in the list: an answer not heard plays, a heard one
    /// shows its text again (Listen again plays it), a failure says why.
    private func pick(_ id: Int) {
        guard let r = requests.request(id) else { return }
        let action = OpenRequests.pick(r)
        guard action != .nothing else { return }
        requestsWindow.dismissList()
        switch action {
        case .nothing: return
        case .listen: play(id)
        case .show: showAgain(id)
        case .reason(let why):
            requests.heard(id)
            requestsChanged()
            note("\(statusMenu.name(of: r.agentID)) couldn’t answer: \(why)")
        }
    }

    /// Play an answer: heard from now on, its text in the pill, said in
    /// its agent's voice on the daemon's speaking queue. Listen again, or
    /// the stop shortcut, stops it.
    private func play(_ id: Int) {
        guard let r = requests.request(id), let answer = answers[id] else { return }
        requests.heard(id)
        requestsChanged()
        let agent = answer.agentID ?? r.agentID
        Log.info("request \(id): playing (\(agent))")
        endReplay()
        // An open microphone would take the answer for the listener's words.
        if recorder.isRecording {
            stopPolling()
            _ = recorder.stop()
        }
        if AnswerView.isWorthShowing(spoken: answer.text, written: answer.written,
                                     buttons: answer.buttons, imageURL: answer.imageURL) {
            panel.showAnswer(spoken: answer.text, written: answer.written,
                             buttons: answer.buttons, imageURL: answer.imageURL)
        }
        shownAnswer = (answer.text, agent, answer.voice)
        noteReset?.cancel()
        let onScreen = !busy
        if onScreen { asideSpeaker = agent; panel.render(.saying(answer.text)) }
        panel.answer.setReplaying(true)
        let line = Task { await Speech.say(answer.text, agentID: agent, kind: "answer", voice: answer.voice) }
        replaying = line
        Task { @MainActor [weak self] in
            await line.value
            guard let self else { return }
            if self.replaying == line { self.endReplay() }
            if onScreen && self.asideSpeaker == agent {
                self.asideSpeaker = nil
                if !self.busy && !self.recorder.isRecording { self.panel.render(self.rest) }
            }
        }
    }

    /// A heard answer again: its text in the pill, with Listen again.
    private func showAgain(_ id: Int) {
        guard let r = requests.request(id), let answer = answers[id] else { return }
        panel.showAnswer(spoken: answer.text, written: answer.written,
                         buttons: answer.buttons, imageURL: answer.imageURL)
        shownAnswer = (answer.text, answer.agentID ?? r.agentID, answer.voice)
    }

    /// Someone holds the floor (#924): the answer is kept, and shown and
    /// said once it is free. Until then nothing of it is on screen.
    private func waitForFloor(_ agent: String?, ownTurn: Bool = true) async {
        let floor = floorWatcher.state
        guard floor.holdsAnswers else { return }
        Log.info("floor: answer\(agent.map { " (\($0))" } ?? "") kept until \(floor.holder ?? "the holder") lets go")
        if !recorder.isRecording { panel.render(rest) }
        // The owner's own words end the wait: "stop" drops the answer,
        // anything else replaces it, and neither should wait for the holder.
        let generation = stopGeneration
        while floorWatcher.state.holdsAnswers && generation == stopGeneration && !(ownTurn && (abandoned || followUp != nil || silenced)) {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// An apology said aloud, for someone not looking. Not while the
    /// floor is held: the line would wait behind the holder with the
    /// turn still open, and the pill already says it.
    private func apologise(_ text: String, voice: VoiceChoice?) async {
        guard !floorWatcher.state.held else { return }
        await Speech.say(text, agentID: nil, kind: "line", voice: voice)
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
            if case .success(let answer) = result { await waitForFloor(answer.agentID ?? agent, ownTurn: false) }
            guard generation == stopGeneration else { return }
            switch result {
            case .success(let answer):
                Log.info("aside answer (\(answer.agentID ?? agent)): \(answer.text)")
                if AnswerView.isWorthShowing(spoken: answer.text, written: answer.written,
                                             buttons: answer.buttons, imageURL: answer.imageURL) {
                    panel.showAnswer(spoken: answer.text, written: answer.written,
                                     buttons: answer.buttons, imageURL: answer.imageURL)
                    shownAnswer = (answer.text, answer.agentID ?? agent, answer.voice)
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
                await apologise("Sorry, \(statusMenu.name(of: agent)) couldn't answer that.", voice: nil)
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
    private func runTurn(_ heard: String, agent: String, handsFree: Bool = false) async {
        silenced = false
        turnAgent = agent
        do {
            beginNarration(agent)

            let answer = try await ask(heard, agent: agent, handsFree: handsFree)
            endNarration()
            // The daemon took the words for the floor holder's sound.
            if answer.dropped {
                Log.info("floor: the daemon dropped hands-free words")
                panel.render(.idle); busy = false; return
            }
            await waitForFloor(answer.agentID)
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
                shownAnswer = (answer.text, answer.agentID, voice)
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
            await apologise("Sorry, that didn't work.", voice: voice)
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
    private var canRing: Bool { activeCall == nil && !busy && !recorder.isRecording && !floorWatcher.state.held }

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
