import AVFoundation

/// Microphone capture that yields exactly what a speech API wants: 16 kHz
/// mono 16-bit PCM in a RIFF container.
///
/// The hardware input is whatever the device feels like (commonly 48 kHz
/// float32, and on some Macs the format is only valid AFTER the engine
/// starts), so the tap installs with the input node's own format and an
/// AVAudioConverter does the rest. Converting in the tap rather than at
/// the end keeps memory flat for long utterances.
final class Recorder {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private let lock = NSLock()
    private(set) var isRecording = false

    /// Loudness of the most recent buffer, 0…1, smoothed.
    ///
    /// Exists so the widget can tell talking from silence without a second
    /// audio tap. Hands-free listening needs to know when you have
    /// FINISHED a sentence, and the only honest signal for that is the
    /// microphone going quiet — a fixed timeout either cuts people off
    /// mid-thought or leaves the mic open staring at them.
    ///
    /// Read from the main thread while the audio thread writes it. A
    /// Float write is atomic on every platform this runs on, and a reader
    /// that occasionally sees the previous buffer's value is choosing
    /// between two adjacent 100ms windows — which changes nothing.
    private(set) var level: Float = 0

    /// How a hands-free turn's end is heard: "vad" (Silero VAD, once its
    /// model is downloaded; the volume threshold until then) or "volume",
    /// from agentx.json's `voice.endOfTurn`. Push-to-talk sets "hold": its
    /// turn ends on key release, so no detector runs. Set before `start()`.
    var endOfTurn = "vad"
    /// True while this recording's turn is judged by Silero VAD.
    private(set) var usingVAD = false
    private var vad: SileroVAD?
    private var turn = TurnEnd(.level)
    private let turnLock = NSLock()
    /// Bumped by every start, so VAD work queued for an earlier recording
    /// never lands in this one.
    private var generation = 0
    private let vadQueue = DispatchQueue(label: "tn.acme.agentx.voice.vad")

    /// Where the hands-free turn stands: nothing said, talking (a pause
    /// included), or over. Read from the main thread.
    var turnState: TurnEnd.State {
        turnLock.lock(); defer { turnLock.unlock() }
        return turn.state
    }

    /// 16 kHz mono int16 — the format both ElevenLabs and whisper prefer,
    /// and small enough that a 30-second utterance is under 1 MB.
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    enum RecorderError: LocalizedError {
        case micDenied
        case tooShort
        var errorDescription: String? {
            switch self {
            case .micDenied: return "Microphone access denied. Grant it in System Settings › Privacy & Security › Microphone."
            case .tooShort: return "Didn't catch that — hold the hotkey while you speak."
            }
        }
    }

    func requestPermission(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async { done(ok) } }
        default: done(false)
        }
    }

    func start() throws {
        level = 0
        guard !isRecording else { return }
        lock.lock(); pcm.removeAll(keepingCapacity: true); lock.unlock()
        prepareTurn()

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw RecorderError.micDenied }
        converter = AVAudioConverter(from: inputFormat, to: target)

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buf, _ in
            self?.append(buf)
        }
        engine.prepare()
        try engine.start()
        isRecording = true
    }

    /// Stops and returns a WAV, or nil when nothing usable was captured.
    func stop() -> Data? {
        guard isRecording else { return nil }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false

        lock.lock(); let body = pcm; lock.unlock()
        // 16 kHz * 2 bytes = 32 kB/s; under a quarter second is a misfire,
        // not speech, and sending it just wastes an API call.
        guard body.count > 8_000 else { return nil }
        return wav(body)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0,
              let channel = out.int16ChannelData?[0] else { return }

        // RMS over the buffer, in the same pass that copies it.
        var sum: Float = 0
        for i in 0..<Int(out.frameLength) {
            let sample = Float(channel[i]) / 32768.0
            sum += sample * sample
        }
        let rms = (sum / Float(max(Int(out.frameLength), 1))).squareRoot()
        level = TurnEnd.smooth(level: level, rms: rms)
        hearTurn(channel, count: Int(out.frameLength))

        let bytes = Int(out.frameLength) * MemoryLayout<Int16>.size
        lock.lock()
        pcm.append(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)).withMemoryRebound(to: UInt8.self) {
            Data(bytes: $0.baseAddress!, count: bytes)
        })
        lock.unlock()
    }

    /// A fresh turn for a new recording, judged by Silero VAD when its
    /// model is installed and loads; otherwise by the volume threshold,
    /// with the model downloading in the background for next time.
    private func prepareTurn() {
        var detector: SileroVAD?
        // Only a hands-free turn listens for its own end; push-to-talk ("hold")
        // ends on key release, so it never loads or runs the model.
        if endOfTurn == "vad" {
            do {
                if let model = try SileroVAD.loadModel() {
                    detector = try SileroVAD(model: model)
                } else {
                    ModelStore.installInBackground(ModelStore.vad) { Log.info($0) }
                }
            } catch {
                Log.warn("Silero VAD would not load (\(error.localizedDescription)); using the volume threshold")
            }
        }
        turnLock.lock()
        generation += 1
        vad = detector
        usingVAD = detector != nil
        turn = TurnEnd(detector != nil ? .vad : .level)
        turnLock.unlock()
    }

    /// One converted buffer: to the VAD off the audio thread, or straight
    /// to the volume check.
    private func hearTurn(_ channel: UnsafePointer<Int16>, count: Int) {
        turnLock.lock()
        let detector = vad, gen = generation
        if detector == nil {
            turn.feed(level: level, duration: Double(count) / target.sampleRate)
        }
        turnLock.unlock()
        guard let detector else { return }
        var samples = [Float](repeating: 0, count: count)
        for i in 0..<count { samples[i] = Float(channel[i]) / 32768.0 }
        vadQueue.async { [weak self] in
            guard let self else { return }
            let probabilities: [Float]
            do { probabilities = try detector.process(samples) } catch {
                Log.warn("Silero VAD failed (\(error.localizedDescription)); using the volume threshold")
                self.turnLock.lock()
                if self.generation == gen { self.vad = nil; self.usingVAD = false; self.turn = TurnEnd(.level) }
                self.turnLock.unlock()
                return
            }
            self.turnLock.lock()
            if self.generation == gen {
                for p in probabilities { self.turn.feed(probability: p, duration: SileroVAD.frameDuration) }
            }
            self.turnLock.unlock()
        }
    }

    /// Minimal RIFF/WAVE header for 16-bit mono PCM.
    private func wav(_ body: Data) -> Data {
        let rate = UInt32(target.sampleRate), channels: UInt16 = 1, bits: UInt16 = 16
        let byteRate = rate * UInt32(channels) * UInt32(bits / 8)
        var d = Data()
        func str(_ s: String) { d.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        str("RIFF"); u32(UInt32(36 + body.count)); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(channels); u32(rate); u32(byteRate)
        u16(channels * bits / 8); u16(bits)
        str("data"); u32(UInt32(body.count)); d.append(body)
        return d
    }
}
