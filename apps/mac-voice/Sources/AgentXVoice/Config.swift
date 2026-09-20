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

    /// ElevenLabs default voice. Override with AGENTX_VOICE_ID.
    static let voiceID = env("AGENTX_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM"
    static let sttModel = env("AGENTX_STT_MODEL") ?? "scribe_v1"
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
