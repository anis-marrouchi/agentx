// Tests for the on-device model plumbing that needs no model: the
// download manifest, checksums, WAV reading, window cuts and token text.
// Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

// A private models folder, so nothing here sees or touches the real one.
let dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentx-models-test-\(UUID().uuidString)")
setenv("AGENTX_MODELS_DIR", dir.path, 1)
defer { try? FileManager.default.removeItem(at: dir) }

// --- Manifest ---

for m in ModelStore.all {
    check(m.revision.count == 40, "\(m.name): pinned to a full revision")
    check(m.files.allSatisfy { $0.sha256.count == 64 && $0.size > 0 }, "\(m.name): every file has a size and a SHA-256")
    check(m.directory.path.hasPrefix(dir.path), "\(m.name): lives under the models folder")
    check(!m.isInstalled, "\(m.name): an empty folder is not installed")
}
check(ModelStore.vad.totalBytes < 1_000_000, "the VAD download is under 1 MB")
check((480_000_000..<490_000_000).contains(ModelStore.parakeet.totalBytes), "the Parakeet download is about 483 MB")

// --- Checksums ---

let f = dir.appendingPathComponent("hello.txt")
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
try? Data("hello\n".utf8).write(to: f)
check((try? ModelStore.sha256(of: f)) == "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      "sha256 of a file matches shasum -a 256")

// --- WAV reading ---

func wav(_ samples: [Int16], extraChunk: Bool) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(Data("RIFF".utf8)); u32(0); d.append(Data("WAVE".utf8))
    d.append(Data("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
    if extraChunk { d.append(Data("LIST".utf8)); u32(3); d.append(contentsOf: [1, 2, 3, 0]) }
    d.append(Data("data".utf8)); u32(UInt32(samples.count * 2))
    for s in samples { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
    return d
}
let read = Parakeet.samples(wav: wav([0, 16384, -32768], extraChunk: true))
check(read == [0, 0.5, -1], "WAV samples are found past other chunks (odd sizes padded) and scaled to -1…1")

// --- Windows ---

check(Parakeet.windows([Float](repeating: 0.1, count: 16_000 * 5)) == [0..<80_000], "5 s is one window")
var long = [Float](repeating: 0.3, count: 16_000 * 40)
for i in 212_000..<212_320 { long[i] = 0 }       // a quiet 20 ms at 13.25 s
let cuts = Parakeet.windows(long)
check(cuts.count == 3 && cuts.allSatisfy { $0.count <= Parakeet.window }, "40 s is split into windows of at most 15 s")
check(cuts.first.map { abs($0.upperBound - 212_160) <= 320 } ?? false, "the first cut lands in the quiet moment")
check(cuts.first?.lowerBound == 0 && cuts.last?.upperBound == long.count
      && zip(cuts, cuts.dropFirst()).allSatisfy { $0.upperBound == $1.lowerBound }, "the windows cover the audio with no gap or overlap")

// --- Tokens to text ---

let vocab = [0: "<unk>", 1: "\u{2581}Hel", 2: "lo", 3: "\u{2581}world", 4: ".", 5: "<|endoftext|>"]
check(Parakeet.text([1, 2, 3, 4, 5, 0], vocabulary: vocab) == "Hello world.", "pieces join into words; control tokens are dropped")

exit(failures == 0 ? 0 : 1)
