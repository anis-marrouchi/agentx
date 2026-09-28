// agentx-voice-local: the on-device models of AgentX Voice, from a terminal.
//
//   agentx-voice-local status                 what is installed, and where
//   agentx-voice-local fetch vad|parakeet|all download and verify
//   agentx-voice-local transcribe <wav>...    Parakeet; one JSON line per file
//   agentx-voice-local turn <wav>             where a hands-free turn would end,
//                                             with Silero VAD and with the old
//                                             volume threshold
//
// Built by build.sh next to the app, from the same sources the app runs, so
// what it measures is what the app does. Takes 16 kHz mono 16-bit WAVs.
import Foundation

func fail(_ s: String) -> Never {
    FileHandle.standardError.write(Data("agentx-voice-local: \(s)\n".utf8))
    exit(1)
}

func models(_ name: String) -> [LocalModel] {
    switch name {
    case "vad": return [ModelStore.vad]
    case "parakeet": return [ModelStore.parakeet]
    case "all": return ModelStore.all
    default: fail("unknown model \(name) (vad, parakeet or all)")
    }
}

func json(_ o: [String: Any]) -> String {
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    return String(decoding: d, as: UTF8.self)
}

func ms(since t: Date) -> Int { Int((Date().timeIntervalSince(t) * 1000).rounded()) }

func wavSamples(_ path: String) -> [Float] {
    guard let d = FileManager.default.contents(atPath: path) else { fail("cannot read \(path)") }
    return Parakeet.samples(wav: d)
}

// One line at a time even into a pipe, so progress shows as it happens.
setvbuf(stdout, nil, _IOLBF, 0)

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "status":
    for m in ModelStore.all {
        let mb = Double(m.totalBytes) / 1_000_000
        print("\(m.name): \(m.isInstalled ? "installed" : "not installed") (\(String(format: "%.1f", mb)) MB) \(m.directory.path)")
    }

case "fetch":
    for m in models(args.count > 1 ? args[1] : "all") {
        var last = -1
        do {
            try await ModelStore.install(m) { done, total in
                let pct = Int(Double(done) / Double(max(total, 1)) * 100)
                if pct / 10 != last / 10 { last = pct; print("\(m.name): \(pct)%") }
            }
            print("\(m.name): installed in \(m.directory.path)")
        } catch {
            fail("\(m.name): \(error.localizedDescription)")
        }
    }

case "transcribe":
    let files = Array(args.dropFirst())
    guard !files.isEmpty else { fail("transcribe needs at least one WAV") }
    let t0 = Date()
    let engine: Parakeet
    do { engine = try Parakeet.loaded() } catch { fail(error.localizedDescription) }
    print(json(["event": "loaded", "ms": ms(since: t0)]))
    for f in files {
        let samples = wavSamples(f)
        let t = Date()
        do {
            let text = try engine.transcribe(samples: samples)
            print(json(["file": f, "ms": ms(since: t), "audioMs": samples.count / 16, "text": text]))
        } catch {
            print(json(["file": f, "error": error.localizedDescription]))
        }
    }

case "turn":
    guard args.count > 1 else { fail("turn needs a WAV") }
    let samples = wavSamples(args[1])
    func report(_ name: String, _ endedAt: TimeInterval?, _ startedAt: TimeInterval?) {
        var o: [String: Any] = ["detector": name, "audioSeconds": Double(samples.count) / 16_000]
        o["speechStartedAt"] = startedAt.map { ($0 * 100).rounded() / 100 } ?? NSNull()
        o["turnEndedAt"] = endedAt.map { ($0 * 100).rounded() / 100 } ?? NSNull()
        print(json(o))
    }

    // Silero VAD, 32 ms frames.
    do {
        guard let model = try SileroVAD.loadModel() else { fail("the VAD model is not installed: run fetch vad") }
        let vad = try SileroVAD(model: model)
        var turn = TurnEnd(.vad)
        var t: TimeInterval = 0, started: TimeInterval?, ended: TimeInterval?
        var at = 0
        while at < samples.count, ended == nil {
            let slice = Array(samples[at..<min(at + 1_365, samples.count)])
            at += slice.count
            for p in try vad.process(slice) {
                t += SileroVAD.frameDuration
                let s = turn.feed(probability: p, duration: SileroVAD.frameDuration)
                if s == .speaking, started == nil { started = t }
                if s == .ended { ended = t; break }
            }
        }
        report("silero-vad", ended, started)
    } catch {
        fail("VAD: \(error.localizedDescription)")
    }

    // The volume threshold, on buffers the size the microphone delivers
    // (4096 samples at 48 kHz, 1365 at 16 kHz).
    var turn = TurnEnd(.level)
    var level: Float = 0, t: TimeInterval = 0
    var started: TimeInterval?, ended: TimeInterval?
    var at = 0
    while at < samples.count, ended == nil {
        let slice = samples[at..<min(at + 1_365, samples.count)]
        at += slice.count
        let rms = (slice.reduce(0) { $0 + $1 * $1 } / Float(max(slice.count, 1))).squareRoot()
        level = TurnEnd.smooth(level: level, rms: rms)
        let d = Double(slice.count) / 16_000
        t += d
        let s = turn.feed(level: level, duration: d)
        if s == .speaking, started == nil { started = t }
        if s == .ended { ended = t }
    }
    report("volume", ended, started)

default:
    print("usage: agentx-voice-local status | fetch vad|parakeet|all | transcribe <wav>... | turn <wav>")
    exit(args.isEmpty ? 0 : 1)
}
