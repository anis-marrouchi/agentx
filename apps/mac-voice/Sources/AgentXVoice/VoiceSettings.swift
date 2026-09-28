import Foundation

/// What GET /voice/settings returns, edited in the settings window and
/// sent back as the difference. Foundation only, so the tests can build it.
struct VoiceSettings: Codable, Equatable {
    struct Hotkeys: Codable, Equatable {
        var talk: String
        var stop: String
        var paste: String
    }
    struct General: Codable, Equatable {
        var provider: String
        var fallback: String
        var stt: String
        var hotkeys: Hotkeys
    }
    struct Voice: Codable, Equatable {
        var provider: String?
        var system: String?
        var systemPerLanguage: Bool
        var elevenlabsVoiceId: String?
        var rate: Double?
        var narrate: String?
        var priority: String?
        var hotkey: String?
    }
    struct Speaks: Codable, Equatable {
        let provider: String
        let systemVoice: String?
    }
    struct Agent: Codable, Equatable, Identifiable {
        let id: String
        let name: String
        var color: String
        var colorSet: Bool
        var voice: Voice
        let speaks: Speaks
    }
    struct SystemVoice: Codable, Equatable, Identifiable {
        let id: String
        let label: String
        let locale: String
    }

    var general: General
    var agents: [Agent]
    let systemVoices: [SystemVoice]
    let menuHotkey: String

    /// The change from `old` to this, as POST /voice/settings takes it:
    /// only what differs, and NSNull for a field put back to its default.
    func patch(from old: VoiceSettings) -> [String: Any] {
        var out: [String: Any] = [:]

        var general: [String: Any] = [:]
        if self.general.provider != old.general.provider { general["provider"] = self.general.provider }
        if self.general.stt != old.general.stt { general["stt"] = self.general.stt }
        var keys: [String: Any] = [:]
        if self.general.hotkeys.talk != old.general.hotkeys.talk { keys["talk"] = self.general.hotkeys.talk }
        if self.general.hotkeys.stop != old.general.hotkeys.stop { keys["stop"] = self.general.hotkeys.stop }
        if self.general.hotkeys.paste != old.general.hotkeys.paste { keys["paste"] = self.general.hotkeys.paste }
        if !keys.isEmpty { general["hotkeys"] = keys }
        if !general.isEmpty { out["general"] = general }

        var agents: [String: Any] = [:]
        for agent in self.agents {
            guard let before = old.agents.first(where: { $0.id == agent.id }) else { continue }
            var a: [String: Any] = [:]
            func field<T: Equatable>(_ name: String, _ now: T?, _ was: T?) {
                if now != was { a[name] = now.map { $0 as Any } ?? NSNull() }
            }
            field("provider", agent.voice.provider, before.voice.provider)
            field("system", agent.voice.system, before.voice.system)
            field("elevenlabsVoiceId", agent.voice.elevenlabsVoiceId.flatMap { $0.isEmpty ? nil : $0 },
                  before.voice.elevenlabsVoiceId)
            field("rate", agent.voice.rate, before.voice.rate)
            field("narrate", agent.voice.narrate, before.voice.narrate)
            field("priority", agent.voice.priority, before.voice.priority)
            field("hotkey", agent.voice.hotkey, before.voice.hotkey)
            if agent.colorSet != before.colorSet || (agent.colorSet && agent.color != before.color) {
                a["color"] = agent.colorSet ? agent.color as Any : NSNull()
            }
            if !a.isEmpty { agents[agent.id] = a }
        }
        if !agents.isEmpty { out["agents"] = agents }
        return out
    }

    /// The fields a preview speaks with: the draft's voice for one agent.
    func previewVoice(for id: String) -> [String: Any] {
        guard let v = agents.first(where: { $0.id == id })?.voice else { return [:] }
        var out: [String: Any] = [
            "provider": v.provider.map { $0 as Any } ?? NSNull(),
            "elevenlabsVoiceId": v.elevenlabsVoiceId.flatMap { $0.isEmpty ? nil : $0 }.map { $0 as Any } ?? NSNull(),
            "rate": v.rate.map { $0 as Any } ?? NSNull(),
        ]
        // A per-language list is not shown in the window; leave it be.
        if !v.systemPerLanguage { out["system"] = v.system.map { $0 as Any } ?? NSNull() }
        return out
    }
}
