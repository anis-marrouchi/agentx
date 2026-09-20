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
        guard !isRecording else { return }
        lock.lock(); pcm.removeAll(keepingCapacity: true); lock.unlock()

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

        let bytes = Int(out.frameLength) * MemoryLayout<Int16>.size
        lock.lock()
        pcm.append(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)).withMemoryRebound(to: UInt8.self) {
            Data(bytes: $0.baseAddress!, count: bytes)
        })
        lock.unlock()
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
