import Foundation

/// What GET /voice/settings returns, edited in the settings window and
/// sent back as the difference. Foundation only, so the tests can build it.
struct VoiceSettings: Codable, Equatable {
    struct Hotkeys: Codable, Equatable {
        var talk: String
        var stop: String
        var paste: String
    }
    /// The answer shown in the pill: seconds open once spoken (0: until
    /// closed), and its tallest height in points.
    struct Card: Codable, Equatable {
        var timeout: Double
        var maxHeight: Double
        static let standard = Card(timeout: 30, maxHeight: 320)
    }
    struct General: Codable, Equatable {
        var provider: String
        var fallback: String
        var stt: String
        /// The on-device engine: "mlx-whisper" or "parakeet".
        var localStt: String
        /// How a hands-free turn's end is heard: "vad" or "volume".
        var endOfTurn: String
        var hotkeys: Hotkeys
        /// Nil from a daemon older than the card settings.
        var card: Card?
        /// What shows the assistant's state: "orb" or "character". Nil
        /// from a daemon older than the character.
        var look: String?
        /// The pill starts reduced to its orb. Nil from a daemon older
        /// than the reduced pill.
        var startReduced: Bool?
        /// The character takes a stroll when it has nothing to do. Nil
        /// from a daemon older than the stroll.
        var stroll: Bool?

        init(provider: String, fallback: String, stt: String, localStt: String = "mlx-whisper",
             endOfTurn: String = "vad", hotkeys: Hotkeys, card: Card? = nil, look: String? = nil,
             startReduced: Bool? = nil, stroll: Bool? = nil) {
            self.provider = provider; self.fallback = fallback; self.stt = stt
            self.localStt = localStt; self.endOfTurn = endOfTurn; self.hotkeys = hotkeys
            self.card = card; self.look = look; self.startReduced = startReduced
            self.stroll = stroll
        }

        /// A daemon from before these fields leaves them out: the defaults.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            provider = try c.decode(String.self, forKey: .provider)
            fallback = try c.decode(String.self, forKey: .fallback)
            stt = try c.decode(String.self, forKey: .stt)
            localStt = try c.decodeIfPresent(String.self, forKey: .localStt) ?? "mlx-whisper"
            endOfTurn = try c.decodeIfPresent(String.self, forKey: .endOfTurn) ?? "vad"
            hotkeys = try c.decode(Hotkeys.self, forKey: .hotkeys)
            card = try c.decodeIfPresent(Card.self, forKey: .card)
            look = try c.decodeIfPresent(String.self, forKey: .look)
            startReduced = try c.decodeIfPresent(Bool.self, forKey: .startReduced)
            stroll = try c.decodeIfPresent(Bool.self, forKey: .stroll)
        }
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
        /// The chosen orb palette; nil follows the colour.
        var palette: String?
        /// The palette the colour gives when none is chosen.
        let paletteDefault: String?
        var voice: Voice
        let speaks: Speaks
    }
    struct SystemVoice: Codable, Equatable, Identifiable {
        let id: String
        let label: String
        let locale: String
    }

    /// One of the orb's nature palettes: five colours, deep to light.
    struct Palette: Codable, Equatable, Identifiable {
        let id: String
        let label: String
        let colors: [String]
    }

    var general: General
    var agents: [Agent]
    let systemVoices: [SystemVoice]
    /// Nil from a daemon older than the palettes.
    let palettes: [Palette]?
    let menuHotkey: String

    /// The change from `old` to this, as POST /voice/settings takes it:
    /// only what differs, and NSNull for a field put back to its default.
    func patch(from old: VoiceSettings) -> [String: Any] {
        var out: [String: Any] = [:]

        var general: [String: Any] = [:]
        if self.general.provider != old.general.provider { general["provider"] = self.general.provider }
        if self.general.stt != old.general.stt { general["stt"] = self.general.stt }
        if self.general.localStt != old.general.localStt { general["localStt"] = self.general.localStt }
        if self.general.endOfTurn != old.general.endOfTurn { general["endOfTurn"] = self.general.endOfTurn }
        if let look = self.general.look, look != old.general.look { general["look"] = look }
        if let start = self.general.startReduced, start != old.general.startReduced { general["startReduced"] = start }
        if let stroll = self.general.stroll, stroll != old.general.stroll { general["stroll"] = stroll }
        var keys: [String: Any] = [:]
        if self.general.hotkeys.talk != old.general.hotkeys.talk { keys["talk"] = self.general.hotkeys.talk }
        if self.general.hotkeys.stop != old.general.hotkeys.stop { keys["stop"] = self.general.hotkeys.stop }
        if self.general.hotkeys.paste != old.general.hotkeys.paste { keys["paste"] = self.general.hotkeys.paste }
        if !keys.isEmpty { general["hotkeys"] = keys }
        if let card = self.general.card {
            var c: [String: Any] = [:]
            if card.timeout != old.general.card?.timeout { c["timeout"] = card.timeout }
            if card.maxHeight != old.general.card?.maxHeight { c["maxHeight"] = card.maxHeight }
            if !c.isEmpty { general["card"] = c }
        }
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
            field("palette", agent.palette, before.palette)
            if agent.colorSet != before.colorSet || (agent.colorSet && agent.color != before.color) {
                a["color"] = agent.colorSet ? agent.color as Any : NSNull()
            }
            if !a.isEmpty { agents[agent.id] = a }
        }
        if !agents.isEmpty { out["agents"] = agents }
        return out
    }

    /// Seconds to wait before asking the daemon again after a read at
    /// start that failed: 2, 4, 8, 16, then every 30.
    static func retryDelay(after failures: Int) -> Double {
        min(30, pow(2, Double(max(1, failures))))
    }

    /// Seconds between reads once the daemon has answered, so a change
    /// made outside the app shows without a restart.
    static let rereadDelay: Double = 5

    /// Whether a read from the daemon replaces what the app holds: it
    /// differs, and nothing was saved here while it was on its way. A read
    /// that started before a save in the window carries the old settings.
    static func replaces(_ read: VoiceSettings, held: VoiceSettings?, heldWhenAsked: VoiceSettings?) -> Bool {
        held == heldWhenAsked && read != held
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
