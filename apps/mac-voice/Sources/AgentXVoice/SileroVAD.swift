import CoreML
import Foundation

/// Silero VAD on Core ML: how likely each 32 ms of 16 kHz audio is speech.
///
/// Core ML rather than ONNX Runtime: the model is 0.9 MB, macOS already
/// ships the runtime, and the app keeps building with plain swiftc and no
/// package dependency. The weights come from ModelStore.vad on first use.
///
/// Streaming: the model is an LSTM, so each call carries the previous
/// call's state and the last 64 samples as context, exactly as Silero's
/// own ONNX wrapper does. One `SileroVAD` per recording; the loaded model
/// is shared.
final class SileroVAD {
    static let chunk = 512
    static let context = 64
    static let sampleRate = 16_000.0
    static var frameDuration: TimeInterval { Double(chunk) / sampleRate }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: MLModel?

    /// The shared model, loaded once. Nil when it is not installed or will
    /// not load; the caller then falls back to the volume threshold.
    static func loadModel() throws -> MLModel? {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        guard ModelStore.vad.isInstalled else { return nil }
        let config = MLModelConfiguration()
        // Tiny and called every 32 ms: the CPU answers faster than a trip
        // to the Neural Engine.
        config.computeUnits = .cpuOnly
        let url = ModelStore.vad.url("silero-vad-unified-v6.0.0.mlmodelc")
        let model = try MLModel(contentsOf: url, configuration: config)
        cached = model
        return model
    }

    private let model: MLModel
    private let audio: MLMultiArray
    private var hidden: MLMultiArray
    private var cell: MLMultiArray
    private var pending: [Float] = []
    private var tail = [Float](repeating: 0, count: SileroVAD.context)

    init(model: MLModel) throws {
        self.model = model
        audio = try MLMultiArray(shape: [1, NSNumber(value: Self.context + Self.chunk)], dataType: .float32)
        hidden = try Self.zeros()
        cell = try Self.zeros()
    }

    private static func zeros() throws -> MLMultiArray {
        let a = try MLMultiArray(shape: [1, 128], dataType: .float32)
        for i in 0..<a.count { a[i] = 0 }
        return a
    }

    /// Feeds samples (16 kHz, -1…1) and returns one probability per
    /// complete 512-sample frame; leftovers wait for the next call.
    func process(_ samples: [Float]) throws -> [Float] {
        pending.append(contentsOf: samples)
        var out: [Float] = []
        var start = 0
        while pending.count - start >= Self.chunk {
            let frame = pending[start..<start + Self.chunk]
            out.append(try score(frame))
            start += Self.chunk
        }
        pending.removeFirst(start)
        return out
    }

    private func score(_ frame: ArraySlice<Float>) throws -> Float {
        let ptr = audio.dataPointer.bindMemory(to: Float.self, capacity: audio.count)
        for i in 0..<Self.context { ptr[i] = tail[i] }
        var i = Self.context
        for s in frame { ptr[i] = s; i += 1 }
        tail = Array(frame.suffix(Self.context))

        let input = try MLDictionaryFeatureProvider(dictionary: [
            "audio_input": MLFeatureValue(multiArray: audio),
            "hidden_state": MLFeatureValue(multiArray: hidden),
            "cell_state": MLFeatureValue(multiArray: cell),
        ])
        let result = try model.prediction(from: input)
        if let h = result.featureValue(for: "new_hidden_state")?.multiArrayValue { hidden = h }
        if let c = result.featureValue(for: "new_cell_state")?.multiArrayValue { cell = c }
        guard let p = result.featureValue(for: "vad_output")?.multiArrayValue, p.count > 0 else { return 0 }
        return p[0].floatValue
    }
}
