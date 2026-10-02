import AppKit
import Carbon.HIToolbox
import ServiceManagement
import SwiftUI

/// Settings: per-agent voices and the app's own shortcuts and engines.
///
/// Everything but launch at login lives in agentx.json and goes through
/// the daemon, which checks each value against the config schema before
/// writing. The window shows what the daemon has and keeps no copy: it
/// loads fresh every time it opens and after every save.
@MainActor
final class SettingsModel: ObservableObject {
    @Published var saved: VoiceSettings?
    @Published var draft: VoiceSettings?
    @Published var selected: String?
    @Published var loading = false
    @Published var saving = false
    @Published var error = ""
    @Published var notice = ""
    @Published var launchAtLogin = LoginItem.isOn
    /// "agents", "general" or "speech".
    @Published var tab = "agents"
    /// A shortcut field is waiting for keys: the app's own shortcuts are
    /// off meanwhile, or they would fire instead of being recorded.
    @Published var recording: String? {
        didSet { if (recording == nil) != (oldValue == nil) { onRecording?(recording != nil) } }
    }

    var onSaved: ((VoiceSettings) -> Void)?
    var onRecording: ((Bool) -> Void)?

    var hasChanges: Bool {
        guard let saved, let draft else { return false }
        return !draft.patch(from: saved).isEmpty
    }

    func load() {
        loading = true
        error = ""
        Task {
            let s = await AgentClient.settings()
            loading = false
            guard let s else {
                error = "The AgentX daemon isn't reachable. Start it, then open Settings again."
                return
            }
            saved = s
            draft = s
            if selected == nil || !s.agents.contains(where: { $0.id == selected }) { selected = s.agents.first?.id }
        }
    }

    func revert() {
        draft = saved
        error = ""
        notice = ""
    }

    func save() {
        guard let saved, let draft, hasChanges else { return }
        saving = true
        error = ""
        notice = ""
        Task {
            let result = await AgentClient.saveSettings(draft.patch(from: saved))
            saving = false
            switch result {
            case .success(let s):
                self.saved = s
                self.draft = s
                notice = "Saved. The next line spoken uses it; no restart needed."
                onSaved?(s)
            case .failure(let f):
                error = f.message
            }
        }
    }

    func preview(_ id: String) {
        guard let draft else { return }
        error = ""
        notice = "Playing a sample…"
        Task {
            if let problem = await AgentClient.preview(agentID: id, voice: draft.previewVoice(for: id)) {
                notice = ""
                error = problem
            } else {
                notice = "Playing a sample. It is not saved until you press Save."
            }
        }
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
            error = ""
        } catch {
            self.error = "macOS didn't change the login item: \(error.localizedDescription)"
        }
        launchAtLogin = LoginItem.isOn
    }

    /// A binding into the draft for the agent `id`.
    func agent(_ id: String) -> Binding<VoiceSettings.Agent>? {
        guard let i = draft?.agents.firstIndex(where: { $0.id == id }) else { return nil }
        return Binding(get: { self.draft!.agents[i] }, set: { self.draft!.agents[i] = $0 })
    }
}

/// Launch at login is macOS's own setting, never agentx.json.
enum LoginItem {
    /// Installed with `agentx desktop install` or install.sh, which start
    /// the app at login with launchd. A second login item would start a
    /// second copy. Same rule as the installers: any `*agentx.voice*.plist`
    /// whose ProgramArguments[0] is the voice app, whatever its label.
    static var managedByInstaller: Bool {
        let dir = "\(NSHomeDirectory())/Library/LaunchAgents"
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        return files.contains { name in
            guard name.range(of: #"agentx\.voice.*\.plist$"#, options: .regularExpression) != nil,
                  let data = FileManager.default.contents(atPath: "\(dir)/\(name)"),
                  let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let program = (plist["ProgramArguments"] as? [String])?.first
            else { return false }
            return program.hasSuffix("/Contents/MacOS/AgentXVoice")
        }
    }

    static var isOn: Bool { managedByInstaller || SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(spacing: 0) {
            if let draft = model.draft {
                TabView(selection: $model.tab) {
                    AgentsTab(model: model, settings: draft)
                        .tabItem { Text("Agents") }
                        .tag("agents")
                    GeneralTab(model: model)
                        .tabItem { Text("General") }
                        .tag("general")
                    SpeechTab(model: model)
                        .tabItem { Text("Speech") }
                        .tag("speech")
                }
                .padding([.horizontal, .top], 12)
            } else {
                VStack(spacing: 12) {
                    if model.loading { ProgressView() }
                    Text(model.loading ? "Loading settings…" : model.error)
                        .foregroundStyle(.secondary)
                    if !model.loading { Button("Try again") { model.load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if model.draft != nil { footer }
        }
        .frame(width: 660, height: 640)
    }

    private var footer: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                if !model.error.isEmpty {
                    Text(model.error)
                        .foregroundStyle(Color(nsColor: .systemRed))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else if !model.notice.isEmpty {
                    Text(model.notice).foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Revert") { model.revert() }
                .disabled(!model.hasChanges || model.saving)
            Button(model.saving ? "Saving…" : "Save") { model.save() }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(!model.hasChanges || model.saving)
        }
        .padding(12)
    }
}

// MARK: Agents

private struct AgentsTab: View {
    @ObservedObject var model: SettingsModel
    let settings: VoiceSettings

    var body: some View {
        HStack(spacing: 0) {
            List(settings.agents, selection: $model.selected) { agent in
                HStack(spacing: 8) {
                    Circle().fill(Color(hex: agent.color)).frame(width: 10, height: 10)
                    Text(agent.name)
                }
                .tag(agent.id)
            }
            .frame(width: 170)
            Divider()
            if let id = model.selected, let agent = model.agent(id) {
                AgentForm(model: model, agent: agent, settings: settings)
            } else {
                Text("No agents in agentx.json").foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

private struct AgentForm: View {
    @ObservedObject var model: SettingsModel
    @Binding var agent: VoiceSettings.Agent
    let settings: VoiceSettings

    private var provider: String { agent.voice.provider ?? settings.general.provider }

    var body: some View {
        Form {
            voiceSection
            workSection
            shortcutSection
        }
        .formStyle(.grouped)
    }

    private var voiceSection: some View {
        Section {
            providerPicker
            systemVoicePicker
            elevenLabsField
            previewRow
            rateRow
        } header: {
            Text("Voice")
        } footer: {
            Text("Voice changes apply to the next line this agent speaks. ElevenLabs speaks at most 1.2× and at least 0.7×.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var providerPicker: some View {
        let fallback = settings.general.provider == "elevenlabs" ? "ElevenLabs" : "Mac voices"
        return Picker("Voice provider", selection: $agent.voice.provider) {
            Text("Default (\(fallback))").tag(String?.none)
            Text("Mac voices (free)").tag(String?.some("system"))
            Text("ElevenLabs").tag(String?.some("elevenlabs"))
        }
    }

    /// A configured voice the Mac doesn't list (a plain name such as
    /// "Daniel"), kept selectable so the picker can show it.
    private var unlistedVoice: String? {
        guard let s = agent.voice.system, s != "system",
              !settings.systemVoices.contains(where: { $0.id == s }) else { return nil }
        return s
    }

    @ViewBuilder private var systemVoicePicker: some View {
        if agent.voice.systemPerLanguage {
            LabeledContent("Mac voice", value: "One voice per language, set in agentx.json")
        } else {
            Picker("Mac voice", selection: $agent.voice.system) {
                Text("Assigned automatically").tag(String?.none)
                Text("The Mac's default voice").tag(String?.some("system"))
                if let s = unlistedVoice { Text(s).tag(String?.some(s)) }
                ForEach(settings.systemVoices) { v in
                    Text(v.label).tag(String?.some(v.id))
                }
            }
        }
    }

    private var elevenLabsField: some View {
        let text = Binding<String>(
            get: { agent.voice.elevenlabsVoiceId ?? "" },
            set: { agent.voice.elevenlabsVoiceId = $0.isEmpty ? nil : $0 })
        return TextField("ElevenLabs voice ID", text: text, prompt: Text("Default voice"))
            .disabled(provider != "elevenlabs")
    }

    private var previewRow: some View {
        let now: String = agent.speaks.provider == "elevenlabs" ? "ElevenLabs" : (agent.speaks.systemVoice ?? "the Mac's default voice")
        return HStack {
            Text("Saved voice: \(now)").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("Preview") { model.preview(agent.id) }
        }
    }

    private var rateRow: some View {
        let rate = Binding<Double>(
            get: { agent.voice.rate ?? 1 },
            set: { v in
                let snapped = (v * 20).rounded() / 20
                agent.voice.rate = abs(snapped - 1) < 0.001 ? nil : snapped
            })
        return HStack {
            Slider(value: rate, in: 0.75...1.5, step: 0.05) { Text("Speaking speed") }
            Text(String(format: "%.2f×", agent.voice.rate ?? 1)).monospacedDigit().frame(width: 48)
            Button("Normal") { agent.voice.rate = nil }.disabled(agent.voice.rate == nil)
        }
    }

    private var workSection: some View {
        // "off" written out and unset mean the same: both show as Off.
        let narrate = Binding<String?>(
            get: { agent.voice.narrate == "off" ? nil : agent.voice.narrate },
            set: { agent.voice.narrate = $0 })
        return Section("While it works") {
            Picker("Narration", selection: narrate) {
                Text("Off").tag(String?.none)
                Text("On, except scheduled jobs").tag(String?.some("on"))
                Text("On, scheduled jobs too").tag(String?.some("all"))
            }
            Picker("Queue priority", selection: $agent.voice.priority) {
                Text("Normal").tag(String?.none)
                Text("High: ahead of waiting lines").tag(String?.some("high"))
                Text("Low: after waiting lines").tag(String?.some("low"))
            }
        }
    }

    private var shortcutSection: some View {
        let color = Binding<Color>(
            get: { Color(hex: agent.color) },
            set: { agent.color = $0.hex; agent.colorSet = true })
        let footer = agent.colorSet
            ? "Hold the shortcut and speak to ask this agent without changing who is ticked in the menu. The colour also paints this agent's pointer, and picks the orb's palette unless you choose one."
            : "Hold the shortcut and speak to ask this agent without changing who is ticked in the menu. The colour comes from the agent's id until you pick one, and picks the orb's palette unless you choose one."
        return Section {
            HotkeyField(title: "Ask with shortcut", value: $agent.voice.hotkey, optional: true, model: model, id: "agent.\(agent.id)")
            HStack {
                ColorPicker("Orb colour", selection: color, supportsOpacity: false)
                Button("Use default") { agent.colorSet = false }.disabled(!agent.colorSet)
            }
            if let palettes = settings.palettes, !palettes.isEmpty {
                PalettePicker(agent: $agent, palettes: palettes)
            }
        } header: {
            Text("Shortcut and look")
        } footer: {
            Text(footer).font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: General

private struct GeneralTab: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            if let draft = model.draft {
                Section {
                    HotkeyField(title: "Talk (hold)", value: nonOptional(\.talk, draft.general.hotkeys.talk), optional: false, model: model, id: "talk")
                    HotkeyField(title: "Stop every voice", value: nonOptional(\.stop, draft.general.hotkeys.stop), optional: false, model: model, id: "stop")
                    HotkeyField(title: "Smart paste", value: nonOptional(\.paste, draft.general.hotkeys.paste), optional: false, model: model, id: "paste")
                    LabeledContent("Open the menu", value: HotkeySpec.display(draft.menuHotkey))
                } header: {
                    Text("Shortcuts")
                } footer: {
                    Text("Shortcuts change as soon as you save. If one does nothing, another app already uses it.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if draft.general.look != nil {
                    LookSection(look: Binding(get: { model.draft?.general.look ?? "orb" },
                                              set: { model.draft?.general.look = $0 }),
                                startReduced: draft.general.startReduced == nil ? nil
                                    : Binding(get: { model.draft?.general.startReduced ?? false },
                                              set: { model.draft?.general.startReduced = $0 }),
                                stroll: draft.general.stroll == nil ? nil
                                    : Binding(get: { model.draft?.general.stroll ?? false },
                                              set: { model.draft?.general.stroll = $0 }))
                }
                if draft.general.card != nil {
                    AnswerCardSection(card: Binding(get: { model.draft?.general.card ?? .standard },
                                                    set: { model.draft?.general.card = $0 }))
                }
                Section {
                    Toggle("Launch at login", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
                        .disabled(LoginItem.managedByInstaller)
                } footer: {
                    Text(LoginItem.managedByInstaller
                         ? "Started at login by `agentx desktop install`. To stop that, run `agentx desktop stop` in Terminal."
                         : "Saved by macOS as a login item, not in agentx.json. Changes right away.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func nonOptional(_ path: WritableKeyPath<VoiceSettings.Hotkeys, String>, _ now: String) -> Binding<String?> {
        Binding(get: { now }, set: { if let v = $0 { model.draft?.general.hotkeys[keyPath: path] = v } })
    }
}

/// The engines: its own tab so General fits the window without scrolling.
private struct SpeechTab: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            if model.draft != nil {
                Section {
                    Picker("Speech to text", selection: binding(\.stt)) {
                        Text("Automatic").tag("auto")
                        Text("ElevenLabs").tag("elevenlabs")
                        Text("On this Mac").tag("local")
                    }
                    Picker("On-this-Mac engine", selection: binding(\.localStt)) {
                        Text("Whisper (mlx-whisper)").tag("mlx-whisper")
                        Text("Parakeet (downloads 483 MB)").tag("parakeet")
                    }
                    Picker("End of a hands-free turn", selection: binding(\.endOfTurn)) {
                        Text("Voice detection (Silero)").tag("vad")
                        Text("Volume").tag("volume")
                    }
                    Picker("Default voice provider", selection: binding(\.provider)) {
                        Text("Mac voices (free)").tag("system")
                        Text("ElevenLabs").tag("elevenlabs")
                    }
                } header: {
                    Text("Speech")
                } footer: {
                    Text("Automatic uses ElevenLabs when a key is set, and the engine on this Mac otherwise. Parakeet has no Arabic; until its model has downloaded, Whisper answers instead. Voice detection ends a turn when you stop talking, not when the room goes quiet. The default provider is for agents that don't choose their own. All apply to the next question.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func binding(_ path: WritableKeyPath<VoiceSettings.General, String>) -> Binding<String> {
        Binding(get: { model.draft?.general[keyPath: path] ?? "" },
                set: { model.draft?.general[keyPath: path] = $0 })
    }
}

// MARK: Shortcut field

/// Click, then press the keys. Escape cancels; Delete clears an optional one.
private struct HotkeyField: View {
    let title: String
    @Binding var value: String?
    let optional: Bool
    @ObservedObject var model: SettingsModel
    let id: String
    @State private var monitor: Any?
    @State private var hint = ""

    private var recording: Bool { model.recording == id }

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                if !hint.isEmpty { Text(hint).font(.caption).foregroundStyle(.secondary) }
                Button(recording ? "Type the shortcut…" : value.map(HotkeySpec.display) ?? "None") {
                    recording ? stop() : start()
                }
                .frame(minWidth: 110)
                if optional && value != nil && !recording {
                    Button { value = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Clear \(title)")
                }
            }
        }
        .onDisappear { stop() }
    }

    private func start() {
        model.recording = id
        hint = "Esc to cancel"
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let flags = event.modifierFlags.intersection([.control, .option, .shift, .command])
            if event.keyCode == 53 && flags.isEmpty { stop(); return nil }  // Escape
            if (event.keyCode == 51 || event.keyCode == 117) && flags.isEmpty && optional {  // Delete
                value = nil; stop(); return nil
            }
            var mods: UInt32 = 0
            if flags.contains(.control) { mods |= UInt32(controlKey) }
            if flags.contains(.option) { mods |= UInt32(optionKey) }
            if flags.contains(.shift) { mods |= UInt32(shiftKey) }
            if flags.contains(.command) { mods |= UInt32(cmdKey) }
            let spec = HotkeySpec(keyCode: UInt32(event.keyCode), modifiers: mods)
            guard let text = spec.text, HotkeySpec(text) != nil else {
                hint = "Add ⌃, ⌥ or ⌘"
                return nil
            }
            value = text
            stop()
            return nil
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        hint = ""
        if model.recording == id { model.recording = nil }
    }
}

// MARK: Window

@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
    let model = SettingsModel()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 640),
                             styleMask: [.titled, .closable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "AgentX Voice Settings"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(model: model))
            w.delegate = self
            w.center()
            window = w
        }
        model.launchAtLogin = LoginItem.isOn
        model.load()
        // An accessory app has to ask to come forward before its window can
        // take typing; the window was opened on purpose, so that is fine.
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        model.recording = nil
    }
}

extension Color {
    /// "#RRGGBB"; the brand teal when it isn't one.
    init(hex: String) {
        if let c = OrbMath.parseHex(hex) { self.init(.sRGB, red: c.r, green: c.g, blue: c.b) }
        else { self.init(nsColor: Brand.accent) }
    }

    /// "#RRGGBB" in sRGB.
    var hex: String {
        let c = NSColor(self).usingColorSpace(.sRGB) ?? .black
        let v = [c.redComponent, c.greenComponent, c.blueComponent].map { Int(($0 * 255).rounded()).clamped(0, 255) }
        return String(format: "#%02X%02X%02X", v[0], v[1], v[2])
    }
}

private extension Int {
    func clamped(_ lo: Int, _ hi: Int) -> Int { Swift.min(hi, Swift.max(lo, self)) }
}
