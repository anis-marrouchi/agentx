import CoreML
import Foundation

/// NVIDIA Parakeet TDT 0.6B v3 on Core ML: on-device speech to text with
/// no Python, from the model files ModelStore.parakeet fetches.
///
/// Four Core ML models, run in turn: the preprocessor turns 15 s of audio
/// into a mel spectrogram, the encoder turns that into one vector per
/// 80 ms, and the decoder (an LSTM over the words so far) and the joint
/// network walk those vectors greedily. The joint picks a token and how
/// many frames to skip (the "TDT" part), which is why it is fast.
///
/// v3 covers 25 European languages and detects which one on its own. It
/// has NO Arabic; see the benchmark in docs/dashboard/voice.md.
final class Parakeet: @unchecked Sendable {
    enum ParakeetError: LocalizedError {
        case notInstalled
        case badOutput(String)
        var errorDescription: String? {
            switch self {
            case .notInstalled: return "the Parakeet model is not downloaded yet"
            case .badOutput(let what): return "Parakeet returned no \(what)"
            }
        }
    }

    static let sampleRate = 16_000
    /// The Core ML export takes exactly 15 s.
    static let window = 240_000
    /// One encoder frame covers 80 ms.
    static let samplesPerFrame = 1_280
    static let blank = 8_192
    static let durations = [0, 1, 2, 3, 4]
    static let maxSymbolsPerFrame = 10

    private let preprocessor: MLModel
    private let encoder: MLModel
    private let decoder: MLModel
    private let joint: MLModel
    private let vocabulary: [Int: String]

    private static let lock = NSLock()
    nonisolated(unsafe) private static var shared: Parakeet?

    /// The loaded engine, kept for the life of the app: loading costs
    /// seconds (Core ML prepares the encoder for the Neural Engine), a
    /// transcription well under one.
    static func loaded() throws -> Parakeet {
        lock.lock(); defer { lock.unlock() }
        if let shared { return shared }
        let p = try Parakeet()
        shared = p
        return p
    }

    init() throws {
        let store = ModelStore.parakeet
        guard store.isInstalled else { throw ParakeetError.notInstalled }
        func load(_ name: String, _ units: MLComputeUnits) throws -> MLModel {
            let config = MLModelConfiguration()
            config.computeUnits = units
            return try MLModel(contentsOf: store.url(name), configuration: config)
        }
        // The same placement FluidAudio uses: the mel front end on the CPU,
        // the rest wherever Core ML runs it best (the Neural Engine).
        preprocessor = try load("Preprocessor.mlmodelc", .cpuOnly)
        encoder = try load("Encoder.mlmodelc", .cpuAndNeuralEngine)
        decoder = try load("Decoder.mlmodelc", .cpuAndNeuralEngine)
        joint = try load("JointDecisionv3.mlmodelc", .cpuAndNeuralEngine)

        let data = try Data(contentsOf: store.url("parakeet_vocab.json"))
        let raw = try JSONSerialization.jsonObject(with: data) as? [String: String] ?? [:]
        var vocab: [Int: String] = [:]
        for (k, v) in raw { if let id = Int(k) { vocab[id] = v } }
        vocabulary = vocab
    }

    /// A 16 kHz mono 16-bit WAV, as Recorder makes.
    func transcribe(wav: Data) throws -> String {
        try transcribe(samples: Self.samples(wav: wav))
    }

    func transcribe(samples: [Float]) throws -> String {
        var tokens: [Int] = []
        var state = try DecoderState(decoder: decoder)
        for range in Self.windows(samples) {
            tokens += try decode(Array(samples[range]), state: &state)
        }
        return Self.text(tokens, vocabulary: vocabulary)
    }

    // MARK: Pure helpers (tested)

    /// Samples of a 16-bit PCM WAV as -1…1, found by its "data" chunk.
    static func samples(wav: Data) -> [Float] {
        let bytes = [UInt8](wav)
        var offset = 12
        while offset + 8 <= bytes.count {
            let id = String(decoding: bytes[offset..<offset + 4], as: UTF8.self)
            let size = Int(UInt32(bytes[offset + 4]) | UInt32(bytes[offset + 5]) << 8
                | UInt32(bytes[offset + 6]) << 16 | UInt32(bytes[offset + 7]) << 24)
            let body = offset + 8
            if id == "data" {
                let end = min(bytes.count, body + size)
                var out = [Float]()
                out.reserveCapacity((end - body) / 2)
                var i = body
                while i + 1 < end {
                    out.append(Float(Int16(bitPattern: UInt16(bytes[i]) | UInt16(bytes[i + 1]) << 8)) / 32768)
                    i += 2
                }
                return out
            }
            offset = body + size + (size & 1)
        }
        return []
    }

    /// Splits audio longer than the 15 s window, each cut at the quietest
    /// 20 ms of the window's last 3 s, so a cut rarely lands in a word.
    static func windows(_ samples: [Float], window: Int = Parakeet.window) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start = 0
        let step = sampleRate / 50
        while samples.count - start > window {
            let searchFrom = start + window - 3 * sampleRate
            var best = start + window, bestEnergy = Float.greatestFiniteMagnitude
            var at = searchFrom
            while at + step <= start + window {
                var e: Float = 0
                for i in at..<at + step { e += samples[i] * samples[i] }
                if e < bestEnergy { bestEnergy = e; best = at + step / 2 }
                at += step
            }
            out.append(start..<best)
            start = best
        }
        if start < samples.count { out.append(start..<samples.count) }
        return out
    }

    /// SentencePiece pieces to text: "▁" marks the start of a word.
    static func text(_ tokens: [Int], vocabulary: [Int: String]) -> String {
        var s = ""
        for t in tokens {
            guard let piece = vocabulary[t], !(piece.hasPrefix("<") && piece.hasSuffix(">")) else { continue }
            s += piece.replacingOccurrences(of: "\u{2581}", with: " ")
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Inference

    private struct DecoderState {
        var hidden: MLMultiArray
        var cell: MLMultiArray
        /// The decoder's output for the last token emitted (blank at first).
        var output: MLMultiArray?
        let target: MLMultiArray
        let targetLength: MLMultiArray

        init(decoder: MLModel) throws {
            hidden = try MLMultiArray(shape: [2, 1, 640], dataType: .float32)
            cell = try MLMultiArray(shape: [2, 1, 640], dataType: .float32)
            for i in 0..<hidden.count { hidden[i] = 0; cell[i] = 0 }
            target = try MLMultiArray(shape: [1, 1], dataType: .int32)
            targetLength = try MLMultiArray(shape: [1], dataType: .int32)
            targetLength[0] = 1
        }
    }

    private func step(_ token: Int, _ state: inout DecoderState) throws {
        state.target[0] = NSNumber(value: token)
        let out = try decoder.prediction(from: MLDictionaryFeatureProvider(dictionary: [
            "targets": MLFeatureValue(multiArray: state.target),
            "target_length": MLFeatureValue(multiArray: state.targetLength),
            "h_in": MLFeatureValue(multiArray: state.hidden),
            "c_in": MLFeatureValue(multiArray: state.cell),
        ]))
        guard let d = out.featureValue(for: "decoder")?.multiArrayValue,
              let h = out.featureValue(for: "h_out")?.multiArrayValue,
              let c = out.featureValue(for: "c_out")?.multiArrayValue else { throw ParakeetError.badOutput("decoder state") }
        state.output = d; state.hidden = h; state.cell = c
    }

    /// One window: preprocessor, encoder, then greedy TDT decoding.
    private func decode(_ chunk: [Float], state: inout DecoderState) throws -> [Int] {
        guard chunk.count >= Self.samplesPerFrame else { return [] }
        let audio = try MLMultiArray(shape: [1, NSNumber(value: Self.window)], dataType: .float32)
        let ptr = audio.dataPointer.bindMemory(to: Float.self, capacity: Self.window)
        ptr.initialize(repeating: 0, count: Self.window)
        chunk.withUnsafeBufferPointer { src in ptr.update(from: src.baseAddress!, count: min(chunk.count, Self.window)) }
        let length = try MLMultiArray(shape: [1], dataType: .int32)
        length[0] = NSNumber(value: chunk.count)

        let mel = try preprocessor.prediction(from: MLDictionaryFeatureProvider(dictionary: [
            "audio_signal": MLFeatureValue(multiArray: audio),
            "audio_length": MLFeatureValue(multiArray: length),
        ]))
        guard let melArray = mel.featureValue(for: "mel")?.multiArrayValue,
              let melLength = mel.featureValue(for: "mel_length")?.multiArrayValue else { throw ParakeetError.badOutput("mel") }
        let enc = try encoder.prediction(from: MLDictionaryFeatureProvider(dictionary: [
            "mel": MLFeatureValue(multiArray: melArray),
            "mel_length": MLFeatureValue(multiArray: melLength),
        ]))
        guard let frames = enc.featureValue(for: "encoder")?.multiArrayValue,
              let encLength = enc.featureValue(for: "encoder_length")?.multiArrayValue else { throw ParakeetError.badOutput("encoder output") }

        let hiddenSize = frames.shape[1].intValue
        let available = frames.shape[2].intValue
        let actual = (chunk.count + Self.samplesPerFrame - 1) / Self.samplesPerFrame
        let count = min(encLength[0].intValue, available, actual)
        let hStride = frames.strides[1].intValue, tStride = frames.strides[2].intValue

        let encStep = try MLMultiArray(shape: [1, NSNumber(value: hiddenSize), 1], dataType: .float32)
        let encStride = encStep.strides[1].intValue
        let encDest = encStep.dataPointer.bindMemory(to: Float.self, capacity: encStep.count)
        func load(frame t: Int) {
            switch frames.dataType {
            case .float16:
                let src = frames.dataPointer.bindMemory(to: Float16.self, capacity: frames.count)
                for h in 0..<hiddenSize { encDest[h * encStride] = Float(src[h * hStride + t * tStride]) }
            default:
                let src = frames.dataPointer.bindMemory(to: Float.self, capacity: frames.count)
                for h in 0..<hiddenSize { encDest[h * encStride] = src[h * hStride + t * tStride] }
            }
        }

        if state.output == nil { try step(Self.blank, &state) }
        var tokens: [Int] = []
        var t = 0
        var symbolsHere = 0
        var loaded = -1
        while t < count {
            if loaded != t { load(frame: t); loaded = t }
            guard let decoderOut = state.output else { throw ParakeetError.badOutput("decoder output") }
            let out = try joint.prediction(from: MLDictionaryFeatureProvider(dictionary: [
                "encoder_step": MLFeatureValue(multiArray: encStep),
                "decoder_step": MLFeatureValue(multiArray: decoderOut),
            ]))
            guard let tokenArray = out.featureValue(for: "token_id")?.multiArrayValue,
                  let durArray = out.featureValue(for: "duration")?.multiArrayValue else { throw ParakeetError.badOutput("joint decision") }
            let token = tokenArray[0].intValue
            let bin = durArray[0].intValue
            let duration = Self.durations.indices.contains(bin) ? Self.durations[bin] : 1

            if token == Self.blank {
                t += max(duration, 1)
                symbolsHere = 0
                continue
            }
            tokens.append(token)
            try step(token, &state)
            if duration > 0 {
                t += duration
                symbolsHere = 0
            } else {
                symbolsHere += 1
                if symbolsHere >= Self.maxSymbolsPerFrame { t += 1; symbolsHere = 0 }
            }
        }
        return tokens
    }
}
