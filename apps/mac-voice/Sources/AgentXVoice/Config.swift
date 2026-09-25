import Foundation

/// Everything the widget needs to find, resolved once at launch.
///
/// Keys are read from files first and the environment second, because a
/// GUI app launched from Finder inherits almost nothing from a login
/// shell — an app that only reads the environment works when you run it
/// from a terminal and mysteriously fails when you double-click it.
enum Config {
    static let daemonURL = env("AGENTX_DAEMON_URL") ?? "http://127.0.0.1:18800"
    static let agentID = env("AGENTX_VOICE_AGENT") ?? "secretary-agent"

    /// Who speaks before the daemon has said which voice an agent uses:
    /// "system" (free macOS voices, the default) or "elevenlabs".
    static let voiceProvider = env("AGENTX_VOICE_PROVIDER") ?? "system"

    /// ElevenLabs default voice, used when the answering agent has none
    /// configured. Override with AGENTX_VOICE_ID.
    static let voiceID = env("AGENTX_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM"

    /// One voice session per launch. The daemon uses it to decide whether
    /// an agent still needs to introduce itself.
    static let voiceSession = UUID().uuidString
    static let sttModel = env("AGENTX_STT_MODEL") ?? "scribe_v1"

    /// How to invoke smart paste. Run through a login shell, so this is a
    /// command line rather than a path.
    ///
    /// Environment, then a file, then a guess — the same order as the keys
    /// below and for the same reason, with one extra: `agentx` on PATH is
    /// very often the WRONG agentx. It is commonly a globally installed
    /// copy of the published package rather than the local build, so it
    /// silently lacks anything unreleased, and a login shell may resolve
    /// `node` to a version old enough that the CLI will not start at all.
    /// Both were true on the machine this was written on. The file is how
    /// a machine says which build it actually means.
    /// How to invoke `agentx notify`. Derived from pasteCommand so a
    /// machine only has to say once where its agentx lives.
    static var notifyCommand: String {
        pasteCommand.replacingOccurrences(of: " paste", with: " notify")
    }

    static let pasteCommand: String = {
        if let c = env("AGENTX_PASTE_COMMAND"), !c.isEmpty { return c }
        if let s = try? String(contentsOfFile: "\(NSHomeDirectory())/.agentx/paste-command.txt",
                               encoding: .utf8) {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return "agentx paste"
    }()
    static let ttsModel = env("AGENTX_TTS_MODEL") ?? "eleven_turbo_v2_5"

    static let mlxWhisper = env("AGENTX_MLX_WHISPER")
        ?? "\(NSHomeDirectory())/.local/bin/mlx_whisper"
    static let mlxModel = env("AGENTX_MLX_MODEL") ?? "mlx-community/whisper-large-v3-turbo"

    /// nil when no key is available anywhere — the app still runs, falling
    /// back to local STT and `say`, which is the whole point of having a
    /// fallback rather than refusing to start.
    static let elevenLabsKey: String? = {
        if let k = env("ELEVENLABS_API_KEY"), !k.isEmpty { return k }
        for path in ["\(NSHomeDirectory())/.elevenlabs/key",
                     "\(NSHomeDirectory())/.agentx/elevenlabs-key.txt"] {
            if let s = try? String(contentsOfFile: path, encoding: .utf8) {
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { return t }
            }
        }
        return nil
    }()

    private static func env(_ k: String) -> String? {
        guard let v = ProcessInfo.processInfo.environment[k], !v.isEmpty else { return nil }
        return v
    }
}
