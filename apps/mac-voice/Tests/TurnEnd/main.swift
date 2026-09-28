// Tests for TurnEnd: when a hands-free turn is over. Run with ../../test.sh.
//
// Synthetic frames, 32 ms each like Silero VAD's, with a seeded random
// source for the noise so every run sees the same room.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let frame = 0.032
struct Seeded {
    var x: UInt64
    mutating func next() -> Float {
        x = x &* 6364136223846793005 &+ 1442695040888963407
        return Float(x >> 40) / Float(1 << 24)
    }
}
var rng = Seeded(x: 42)

/// Speech: high probabilities with the dips real speech has between syllables.
func speech(_ seconds: Double) -> [Float] {
    (0..<Int(seconds / frame)).map { _ in 0.6 + 0.4 * rng.next() }
}
/// A noisy room: VAD scores noise low but not zero, and now and then a
/// clatter scores a single frame high.
func noise(_ seconds: Double, blipEvery: Int = 9) -> [Float] {
    (0..<Int(seconds / frame)).map { i in i % blipEvery == blipEvery - 1 ? 0.7 : 0.3 * rng.next() }
}
/// Feeds frames; the time at which the turn ended, or nil.
func run(_ frames: [Float], _ tuning: TurnEnd.Tuning = .vad) -> (state: TurnEnd.State, endedAt: Double?) {
    var turn = TurnEnd(tuning)
    var t = 0.0
    for p in frames {
        t += frame
        if turn.feed(probability: p, duration: frame) == .ended { return (.ended, t) }
    }
    return (turn.state, nil)
}

// --- A sentence with pauses in the middle, in a noisy room ---

let firstHalf = speech(1.4), pause = noise(0.7), secondHalf = speech(1.2), hesitation = noise(1.0)
let sentence = firstHalf + pause + secondHalf + hesitation + speech(0.8)
let open = run(sentence)
check(open.state == .speaking, "a 0.7 s and a 1.0 s pause mid-sentence in a noisy room do not end the turn")

let spoken = sentence.count
let finished = run(sentence + noise(3.0))
let lag = (finished.endedAt ?? 99) - Double(spoken) * frame
check(finished.state == .ended, "1.2 s of room noise after the last word ends it")
check(lag >= 1.2 && lag < 1.6, String(format: "and it ends %.2f s after the last word (1.2–1.6 s)", lag))

// --- Noise alone never opens a turn ---

check(run(noise(10)).state == .waiting, "ten seconds of a noisy room with clatters is not speech")
check(run(noise(2) + [0.9, 0.9, 0.9] + noise(2)).state == .waiting,
      "a 0.1 s burst (a cough, a door) does not start the turn")
check(run(noise(1) + speech(0.3)).state == .speaking, "0.3 s of real speech does")

// --- Blips inside the closing pause do not hold the turn open ---

var blippy = speech(1.5)
for _ in 0..<6 { blippy += noise(0.25, blipEvery: 1000) + [0.8] }
let blipped = run(blippy + noise(1))
check(blipped.state == .ended, "single noisy frames during the pause do not keep resetting it")

// --- Hysteresis: the soft end of a word is still speech ---

let trailing = speech(1.0) + Array(repeating: 0.4, count: 50) + noise(0.5)
check(run(trailing).state == .speaking, "frames between 0.35 and 0.5 keep an ongoing turn going")

// --- The volume fallback behaves as before ---

var level = TurnEnd(.level)
check(level.feed(level: 0.01, duration: 0.1) == .waiting, "fallback: below 0.02 is not speech")
check(level.feed(level: 0.05, duration: 0.1) == .speaking, "fallback: one buffer above 0.02 starts the turn")
for _ in 0..<11 { level.feed(level: 0.01, duration: 0.1) }
check(level.state == .speaking, "fallback: 1.1 s of quiet is a pause")
level.feed(level: 0.03, duration: 0.1)
for _ in 0..<11 { level.feed(level: 0.01, duration: 0.1) }
check(level.state == .speaking, "fallback: speech restarts the pause")
level.feed(level: 0.01, duration: 0.1)
check(level.state == .ended, "fallback: 1.2 s of quiet ends the turn")

var loud = TurnEnd(.level)
for _ in 0..<100 { loud.feed(level: 0.03, duration: 0.1) }
check(loud.state == .speaking, "fallback: a room louder than 0.02 holds the turn open (why the VAD exists)")

check(TurnEnd.smooth(level: 0.1, rms: 0.5) == 0.5, "level: attack is instant")
check(abs(TurnEnd.smooth(level: 0.1, rms: 0) - 0.082) < 1e-6, "level: release is slow")

exit(failures == 0 ? 0 : 1)
