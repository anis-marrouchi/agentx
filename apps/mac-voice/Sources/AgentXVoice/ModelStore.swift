import CryptoKit
import Foundation

/// On-device models, fetched on first use into ~/.agentx/models and never
/// shipped with the app or the repository.
///
/// Every file is pinned twice: by the Hugging Face revision it comes from
/// and by its SHA-256. A file that does not match is deleted, so a
/// truncated download or a changed upstream repo can never be loaded. A
/// model counts as installed only when a `.verified` stamp sits next to
/// it, written after every file checked out, so a half-finished download
/// is simply "not installed" and the next attempt starts over.
struct LocalModel: Sendable {
    struct File: Sendable {
        let path: String
        let size: Int64
        let sha256: String
    }

    /// Short name for the command line and the logs: "vad", "parakeet".
    let name: String
    let repo: String
    let revision: String
    let files: [File]

    var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }

    /// ~/.agentx/models/<repo name>/
    var directory: URL {
        ModelStore.root.appendingPathComponent(repo.split(separator: "/").last.map(String.init) ?? repo)
    }

    func url(_ path: String) -> URL { directory.appendingPathComponent(path) }

    private var stamp: URL { directory.appendingPathComponent(".verified") }

    /// Every file is present and was verified for this revision.
    var isInstalled: Bool {
        guard let s = try? String(contentsOf: stamp, encoding: .utf8) else { return false }
        return s.trimmingCharacters(in: .whitespacesAndNewlines) == revision
            && files.allSatisfy { FileManager.default.fileExists(atPath: url($0.path).path) }
    }

    fileprivate func markInstalled() throws {
        try revision.write(to: stamp, atomically: true, encoding: .utf8)
    }
}

enum ModelStore {
    static let root: URL = {
        if let dir = ProcessInfo.processInfo.environment["AGENTX_MODELS_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".agentx/models")
    }()

    /// Silero VAD v6, converted to Core ML by FluidInference (MIT). 0.9 MB.
    /// One call scores 32 ms of 16 kHz audio (512 samples plus 64 of context).
    static let vad = LocalModel(
        name: "vad",
        repo: "FluidInference/silero-vad-coreml",
        revision: "b419383c55c110e2c9271fa6ee0ea83d03c70d96",
        files: [
            .init(path: "silero-vad-unified-v6.0.0.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "2141be60ea0adf7acb1232fbcfaffb2be308ae02e6672d3762aedf36611ea9fd"),
            .init(path: "silero-vad-unified-v6.0.0.mlmodelc/coremldata.bin", size: 593, sha256: "f460dcdf796b19c04bc38ab6e69601831f634e5e74d499487f0c8fe17ca12f0f"),
            .init(path: "silero-vad-unified-v6.0.0.mlmodelc/metadata.json", size: 3232, sha256: "282b1b788b5d4d66d6a70d468464a7ada71d2469a8705526b741fd9ab841295a"),
            .init(path: "silero-vad-unified-v6.0.0.mlmodelc/model.mil", size: 25126, sha256: "79eea23c368f3e7edf85af798a953f5b0910e4b08ff48e55fff8545dd05fd047"),
            .init(path: "silero-vad-unified-v6.0.0.mlmodelc/weights/weight.bin", size: 882304, sha256: "853cf34740d3f5061f977ebe2976f7c921b064261c9c4753b3a1196f2dba42b4"),
        ])

    /// NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), converted to Core ML by
    /// FluidInference. 483 MB, almost all of it the encoder. The same build
    /// FluidAudio loads by default: 6-bit palettized encoder, 15 s window.
    static let parakeet = LocalModel(
        name: "parakeet",
        repo: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
        revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
        files: [
            .init(path: "Preprocessor.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d"),
            .init(path: "Preprocessor.mlmodelc/coremldata.bin", size: 486, sha256: "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d"),
            .init(path: "Preprocessor.mlmodelc/metadata.json", size: 2841, sha256: "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf"),
            .init(path: "Preprocessor.mlmodelc/model.mil", size: 28181, sha256: "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93"),
            .init(path: "Preprocessor.mlmodelc/weights/weight.bin", size: 491072, sha256: "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea"),
            .init(path: "Encoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105"),
            .init(path: "Encoder.mlmodelc/coremldata.bin", size: 485, sha256: "d48034a167a82e88fc3df64f60af963ab3983538271175b8319e7d5720a0fb86"),
            .init(path: "Encoder.mlmodelc/metadata.json", size: 2921, sha256: "da24da9cca943fb29d7fa8e376d57fca7cb3aa08ca51b956b0b0e56813f087e9"),
            .init(path: "Encoder.mlmodelc/model.mil", size: 959769, sha256: "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808"),
            .init(path: "Encoder.mlmodelc/weights/weight.bin", size: 445187200, sha256: "e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421"),
            .init(path: "Decoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350"),
            .init(path: "Decoder.mlmodelc/coremldata.bin", size: 554, sha256: "18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99"),
            .init(path: "Decoder.mlmodelc/metadata.json", size: 3427, sha256: "a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9"),
            .init(path: "Decoder.mlmodelc/model.mil", size: 13110, sha256: "ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35"),
            .init(path: "Decoder.mlmodelc/weights/weight.bin", size: 23604992, sha256: "48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41"),
            .init(path: "JointDecisionv3.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c"),
            .init(path: "JointDecisionv3.mlmodelc/coremldata.bin", size: 521, sha256: "f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342"),
            .init(path: "JointDecisionv3.mlmodelc/metadata.json", size: 3453, sha256: "d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f"),
            .init(path: "JointDecisionv3.mlmodelc/model.mil", size: 11775, sha256: "be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d"),
            .init(path: "JointDecisionv3.mlmodelc/weights/weight.bin", size: 12642764, sha256: "4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e"),
            .init(path: "parakeet_vocab.json", size: 151122, sha256: "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735"),
        ])

    static let all = [vad, parakeet]

    enum StoreError: LocalizedError {
        case http(String, Int)
        case mismatch(String)
        var errorDescription: String? {
            switch self {
            case .http(let path, let code): return "download of \(path) failed with HTTP \(code)"
            case .mismatch(let path): return "\(path) did not match its checksum and was deleted"
            }
        }
    }

    /// Downloads whatever is missing or wrong, checks every file, then
    /// stamps the model installed. `progress` gets bytes done and total.
    static func install(_ model: LocalModel, progress: ((Int64, Int64) -> Void)? = nil) async throws {
        if model.isInstalled { return }
        let fm = FileManager.default
        try fm.createDirectory(at: model.directory, withIntermediateDirectories: true)
        var done: Int64 = 0
        for file in model.files {
            let dest = model.url(file.path)
            if fm.fileExists(atPath: dest.path), (try? sha256(of: dest)) == file.sha256 {
                done += file.size
                progress?(done, model.totalBytes)
                continue
            }
            try? fm.removeItem(at: dest)
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let source = URL(string: "https://huggingface.co/\(model.repo)/resolve/\(model.revision)/\(file.path)")!
            let (tmp, response) = try await URLSession.shared.download(from: source)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                try? fm.removeItem(at: tmp)
                throw StoreError.http(file.path, http.statusCode)
            }
            guard (try? sha256(of: tmp)) == file.sha256 else {
                try? fm.removeItem(at: tmp)
                throw StoreError.mismatch(file.path)
            }
            try fm.moveItem(at: tmp, to: dest)
            done += file.size
            progress?(done, model.totalBytes)
        }
        try model.markInstalled()
    }

    /// Streams the file, so the 445 MB encoder is never held in memory.
    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static let background = BackgroundInstalls()

    /// Starts one download of `model` in the background unless it is
    /// installed or already downloading. For first use: the turn that
    /// found it missing falls back, and a later one gets the model.
    static func installInBackground(_ model: LocalModel, log: @escaping @Sendable (String) -> Void) {
        guard !model.isInstalled, background.begin(model.name) else { return }
        log("downloading the \(model.name) model (\(model.totalBytes / 1_000_000) MB) into \(model.directory.path)")
        Task.detached {
            do {
                try await install(model)
                log("the \(model.name) model is installed")
            } catch {
                log("the \(model.name) model could not be downloaded: \(error.localizedDescription)")
            }
            background.end(model.name)
        }
    }
}

private final class BackgroundInstalls: @unchecked Sendable {
    private let lock = NSLock()
    private var running = Set<String>()
    func begin(_ name: String) -> Bool { lock.lock(); defer { lock.unlock() }; return running.insert(name).inserted }
    func end(_ name: String) { lock.lock(); running.remove(name); lock.unlock() }
}
