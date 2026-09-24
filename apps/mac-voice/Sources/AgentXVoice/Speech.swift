import AVFoundation
import Foundation

/// Speech in and out, ElevenLabs first with a local fallback on each side.
///
/// The fallbacks are not decoration. This widget is push-to-talk on a
/// laptop: it will be used on hotel wifi, on a plane, and on the day the
/// key expires. A voice assistant that answers "network error" out loud is
/// worse than one that answers in a robot voice, so STT degrades to
/// on-device mlx-whisper and TTS degrades to `say`.
enum Speech {
    // MARK: Speech to text

    static func transcribe(wav: Data) async throws -> String {
        if let key = Config.elevenLabsKey {
            do { return try await elevenLabsSTT(wav: wav, key: key) }
            catch { Log.warn("ElevenLabs STT failed (\(error.localizedDescription)); falling back to mlx-whisper") }
        }
        return try await mlxWhisper(wav: wav)
    }

    private static func elevenLabsSTT(wav: Data, key: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue(key, forHTTPHeaderField: "xi-api-key")

        let boundary = "agentx-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("model_id", Config.sttModel)
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wav)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: req)
        try check(response, data, "speech-to-text")
        struct Reply: Decodable { let text: String? }
        guard let text = (try? JSONDecoder().decode(Reply.self, from: data))?.text else {
            throw VoiceError.api("speech-to-text returned no text")
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// On-device fallback. Writes the WAV to a temp file because
    /// mlx_whisper is a CLI that takes a path.
    private static func mlxWhisper(wav: Data) async throws -> String {
        guard FileManager.default.isExecutableFile(atPath: Config.mlxWhisper) else {
            throw VoiceError.api("no ElevenLabs key and mlx_whisper not found at \(Config.mlxWhisper)")
        }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        let audio = dir.appendingPathComponent("agentx-voice-\(UUID().uuidString).wav")
        try wav.write(to: audio)
        defer { try? FileManager.default.removeItem(at: audio) }

        let out = try run(Config.mlxWhisper,
                          ["--model", Config.mlxModel, "--output-format", "txt",
                           "--output-dir", dir.path, audio.path])
        // mlx_whisper writes <name>.txt next to the audio; prefer that over
        // stdout, which also carries progress noise.
        let txt = audio.deletingPathExtension().appendingPathExtension("txt")
        defer { try? FileManager.default.removeItem(at: txt) }
        if let s = try? String(contentsOf: txt, encoding: .utf8) {
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Text to speech

    /// `voiceID` is the answering agent's voice; nil means the global default.
    static func speak(_ text: String, voiceID: String? = nil) async {
        guard !text.isEmpty else { return }
        if let key = Config.elevenLabsKey {
            do {
                let mp3 = try await elevenLabsTTS(text: text, voiceID: voiceID ?? Config.voiceID, key: key)
                try await Player.shared.play(mp3)
                return
            } catch {
                Log.warn("ElevenLabs TTS failed (\(error.localizedDescription)); falling back to say")
            }
        }
        _ = try? run("/usr/bin/say", [text])
    }

    private static func elevenLabsTTS(text: String, voiceID: String, key: String) async throws -> Data {
        let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceID)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue(key, forHTTPHeaderField: "xi-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": text,
            "model_id": Config.ttsModel,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75],
        ])
        let (data, response) = try await URLSession.shared.data(for: req)
        try check(response, data, "text-to-speech")
        return data
    }

    // MARK: Helpers

    private static func check(_ response: URLResponse, _ data: Data, _ what: String) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let detail = String(data: data.prefix(300), encoding: .utf8) ?? ""
            throw VoiceError.api("\(what) HTTP \(http.statusCode): \(detail)")
        }
    }

    @discardableResult
    static func run(_ path: String, _ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

enum VoiceError: LocalizedError {
    case api(String)
    var errorDescription: String? { if case .api(let m) = self { return m }; return nil }
}

/// Holds a strong reference to the player for the life of playback —
/// an AVAudioPlayer that goes out of scope stops mid-sentence.
final class Player: NSObject, AVAudioPlayerDelegate {
    static let shared = Player()
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?

    func play(_ mp3: Data) async throws {
        let p = try AVAudioPlayer(data: mp3)
        p.delegate = self
        player = p
        p.play()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            finished = c
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finished?.resume(); finished = nil; self.player = nil
    }
}

/// Logs to stderr AND to a file.
///
/// The app is normally launched with `open`, which sends stderr nowhere.
/// The first crash left a .ips report and no application log at all, so
/// the cause had to be reconstructed from a stack trace. A few lines of
/// file logging is the difference between reading what happened and
/// inferring it.
enum Log {
    private static let queue = DispatchQueue(label: "tn.acme.agentx.voice.log")
    private static let path = "\(NSHomeDirectory())/Library/Logs/agentx-voice.log"

    static func warn(_ s: String) { write("WARN \(s)") }
    static func info(_ s: String) { write("INFO \(s)") }

    private static func write(_ s: String) {
        let line = "[\(stamp())] \(s)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
        queue.async {
            guard let data = line.data(using: .utf8) else { return }
            if let fh = FileHandle(forWritingAtPath: path) {
                defer { try? fh.close() }
                _ = try? fh.seekToEnd()
                try? fh.write(contentsOf: data)
            } else {
                try? data.write(to: URL(fileURLWithPath: path))
            }
        }
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date())
    }
}
