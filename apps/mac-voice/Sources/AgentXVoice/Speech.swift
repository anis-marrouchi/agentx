import AVFoundation
import Foundation

/// How the daemon says an agent should sound (the `voice` of /ask and of
/// step events). Missing fields mean the free system voice.
struct VoiceChoice: Decodable {
    var provider: String?
    var elevenlabsVoiceId: String?
    /// A macOS voice identifier for `say -v`, or a Siri voice id; nil for
    /// the OS default.
    var systemVoice: String?
    /// When ElevenLabs cannot speak, use the system voice instead.
    var fallback: Bool?

    init(provider: String? = nil, elevenlabsVoiceId: String? = nil, systemVoice: String? = nil, fallback: Bool? = nil) {
        self.provider = provider; self.elevenlabsVoiceId = elevenlabsVoiceId
        self.systemVoice = systemVoice; self.fallback = fallback
    }

    /// From a step event, which arrives as untyped JSON.
    init?(json: Any?) {
        guard let o = json as? [String: Any] else { return nil }
        self.init(provider: o["provider"] as? String, elevenlabsVoiceId: o["elevenlabsVoiceId"] as? String,
                  systemVoice: o["systemVoice"] as? String, fallback: o["fallback"] as? Bool)
    }
}

/// Speech in and out. Speech out uses the free macOS voices unless the
/// daemon says an agent speaks through ElevenLabs; speech in uses
/// ElevenLabs when there is a key, with a local fallback.
///
/// The fallbacks are not decoration. This widget is push-to-talk on a
/// laptop: it will be used on hotel wifi, on a plane, and on the day the
/// key expires. A voice assistant that answers "network error" out loud is
/// worse than one that answers in a robot voice, so STT degrades to
/// on-device mlx-whisper and ElevenLabs TTS degrades to `say`.
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

    /// Silence whatever this app is saying (an answer or a step line).
    static func stop() { Player.shared.stop() }

    /// Barge-in: silence every voice on this Mac and drop every queued
    /// line. This app's line, whatever holds the shared script's lock, and
    /// the daemon's talk, lesson or narration (POST /voice/stop).
    static func stopAll() async {
        Player.shared.stop()
        Player.stopScript()
        await AgentClient.stopVoice()
    }

    /// `voice` is the answering agent's, as the daemon resolved it; nil
    /// (no answer yet) means the provider this app is configured with.
    static func speak(_ text: String, voice: VoiceChoice? = nil) async {
        guard !text.isEmpty else { return }
        if (voice?.provider ?? Config.voiceProvider) == "elevenlabs" {
            if let key = Config.elevenLabsKey {
                do {
                    let mp3 = try await elevenLabsTTS(text: text, voiceID: voice?.elevenlabsVoiceId ?? Config.voiceID, key: key)
                    try await Player.shared.play(mp3)
                    return
                } catch {
                    Log.warn("ElevenLabs TTS failed (\(error.localizedDescription))")
                }
            } else {
                Log.warn("ElevenLabs is the voice provider but there is no key")
            }
            guard voice?.fallback ?? true else { return }
        }
        await Player.shared.say(text, voice: voice?.systemVoice)
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
/// an AVAudioPlayer that goes out of scope stops mid-sentence — and to the
/// `say` process, so `stop()` silences either.
final class Player: NSObject, AVAudioPlayerDelegate {
    static let shared = Player()
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?
    private var sayProcess: Process?

    /// Speak with a system voice; returns when done or stopped. The text
    /// goes in on stdin, so a line that starts with "-" is not an option.
    ///
    /// Every line goes through the daemon's script when it can: it switches
    /// the default for a Siri voice (`say -v` cannot use one), holds the one
    /// speaker lock, bounds the line, and is what a stop reaches. A script
    /// from before `--stop` treats any id as a Siri one, so it only gets
    /// Siri and default lines.
    func say(_ text: String, voice: String?) async {
        let p = Process()
        let script = Self.script
        let siri = voice?.hasPrefix("com.apple.ttsbundle.gryphon-neural_") ?? false
        let current = (try? String(contentsOfFile: script, encoding: .utf8))?.contains("--stop") ?? false
        if (voice == nil || siri || current) && FileManager.default.fileExists(atPath: script) {
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = [script] + (voice.map { [$0] } ?? [])
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            p.arguments = voice.flatMap { siri ? nil : ["-v", $0] } ?? []
        }
        let input = Pipe()
        p.standardInput = input
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let line = LineWatch(c)
            p.terminationHandler = { _ in DispatchQueue.main.async { line.finish() } }
            do { try p.run() } catch {
                p.terminationHandler = nil
                Log.warn("say failed to start (\(error.localizedDescription))")
                c.resume()
                return
            }
            sayProcess = p
            input.fileHandleForWriting.write(Data(text.utf8))
            try? input.fileHandleForWriting.close()
            // The line ends when its voice stops, even if `say` does not exit.
            let pid = p.processIdentifier
            line.watch { AudioOutput.playing(pid: pid) } onEnd: {
                guard p.isRunning else { return }
                // The script's trap stops `say`, restores the voice, and
                // frees the lock for the next line.
                Log.warn("say went quiet but kept running; stopping it")
                p.terminate()
            }
        }
        if sayProcess === p { sayProcess = nil }
    }

    static let script = NSHomeDirectory() + "/.agentx/voice/siri-say.sh"

    /// Stop the line holding the script's lock, whoever started it, and
    /// drop every line queued behind it.
    static func stopScript() {
        guard FileManager.default.fileExists(atPath: script) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [script, "--stop"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { Log.warn("stop failed to start (\(error.localizedDescription))") }
    }

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

    /// Cut the line off now; the `play` awaiting it returns.
    func stop() {
        sayProcess?.terminate(); sayProcess = nil
        player?.stop()
        finished?.resume(); finished = nil; player = nil
    }
}

/// One `say` line: resumed once, by the process exiting or by its voice
/// going quiet (SpeechEnd), whichever comes first. Main-queue confined.
private final class LineWatch: @unchecked Sendable {
    private var continuation: CheckedContinuation<Void, Never>?
    private var timer: DispatchSourceTimer?

    init(_ c: CheckedContinuation<Void, Never>) { continuation = c }

    func watch(_ playing: @escaping () -> Bool, onEnd: @escaping () -> Void) {
        DispatchQueue.main.async {
            guard self.continuation != nil else { return }
            var end = SpeechEnd()
            let t = DispatchSource.makeTimerSource(queue: .main)
            t.schedule(deadline: .now() + 0.1, repeating: 0.1)
            t.setEventHandler {
                guard end.ended(playing: playing(), at: Date()) else { return }
                onEnd()
                self.finish()
            }
            self.timer = t
            t.resume()
        }
    }

    func finish() {
        timer?.cancel(); timer = nil
        continuation?.resume(); continuation = nil
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
