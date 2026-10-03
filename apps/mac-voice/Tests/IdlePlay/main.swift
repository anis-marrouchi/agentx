// Tests for the character's small animations by itself (#571): when they
// play, when they do not, and that nothing snaps. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias M = CharacterMath
typealias Input = CharacterSim.Input
let home = 1000.0, range = 44.0...1400.0
let doze = Int(CharacterSim.dozeAfter)

/// Run `seconds` at 30 frames a second from second `from`; `input` is asked each frame.
func run(_ sim: inout CharacterSim, from: Int = 0, seconds: Int, _ input: (Double) -> Input) -> [CharacterSim.Frame] {
    ((from * 30 + 1)...((from + seconds) * 30)).map { i in sim.step(to: Double(i) / 30, input(Double(i) / 30)) }
}
func alone(_ gap: Double) -> (Double) -> Input { { _ in Input(animates: gap, home: home, range: range) } }

// --- How often ---

check(IdlePlay.gap("off") == 0 && IdlePlay.gap(nil) == 0 && IdlePlay.gap("always") == 0, "off, or a word it does not know: none")
check(IdlePlay.gap("rarely") > IdlePlay.gap("sometimes") && IdlePlay.gap("sometimes") > IdlePlay.gap("often") && IdlePlay.gap("often") > 0,
      "rarely waits longer than sometimes, sometimes longer than often")

var never = CharacterSim()
_ = run(&never, seconds: doze + 30, alone(0))
check(never.idle.played == 0, "the setting off: it never plays, and does not yawn")

var counts: [String: Int] = [:]
for often in ["rarely", "sometimes", "often"] {
    var sim = CharacterSim()
    _ = run(&sim, seconds: doze - 10, alone(IdlePlay.gap(often)))
    counts[often] = sim.idle.played
}
check(counts["often"]! > counts["sometimes"]! && counts["sometimes"]! >= counts["rarely"]! && counts["rarely"]! >= 1,
      "before it dozes: often plays more than sometimes, and rarely at least once (\(counts))")

var timed = CharacterSim()
var starts: [Double] = []
var was = 0
for i in 1...((doze - 10) * 30) {
    _ = timed.step(to: Double(i) / 30, alone(25)(0))
    if timed.idle.played != was { was = timed.idle.played; starts.append(Double(i) / 30) }
}
let waits = zip(starts.dropFirst(), starts).map { $0 - $1 }
check(starts.first! >= 25 && starts.first! <= 50.1 && waits.allSatisfy { $0 >= 25 && $0 <= 50.1 + 2.6 },
      "sometimes: 25 to 50 seconds between two")

// --- What they are ---

for act in IdlePlay.Act.allCases {
    let a = IdlePlay.shape(act, 0), b = IdlePlay.shape(act, 1)
    func small(_ o: IdlePlay.Out) -> Bool { [o.gx, o.gy, o.tilt, o.hop, o.crouch, o.shut].allSatisfy { abs($0) < 1e-9 } }
    check(small(a) && small(b), "\(act.rawValue) starts and ends at the resting pose")
    check((1..<20).contains { IdlePlay.shape(act, Double($0) / 20) != IdlePlay.Out() }, "\(act.rawValue) does something in between")
}

var player = CharacterSim()
var seen = Set<IdlePlay.Act>()
var frames: [CharacterSim.Frame] = []
for i in 1...((doze - 1) * 30) {
    frames.append(player.step(to: Double(i) / 30, alone(10)(0)))
    if let act = player.idle.act { seen.insert(act) }
}
check(seen == Set(IdlePlay.Act.allCases), "left alone until it dozes, it has looked around, hopped, swayed and yawned")
check(frames.allSatisfy { abs($0.x - home) < 0.5 && $0.dots.isEmpty && $0.stars.isEmpty }, "it stays where it rests and leaves no marks")
var jump = 0.0, turn = 0.0
for (a, b) in zip(frames, frames.dropFirst()) {
    jump = max(jump, abs(b.pose.lift - a.pose.lift)); turn = max(turn, abs(b.pose.tilt - a.pose.tilt))
}
check(jump < 6 && turn < 2.5, "nothing snaps: from one frame to the next it moves a little (\(jump), \(turn))")
check(frames.map(\.pose.lift).max()! > 30, "a hop takes it off where it hovers")
check(frames.map(\.pose.sy).max()! > 1.1, "a stretch makes it taller")

// --- The yawn before it dozes ---

var sleepy = CharacterSim()
_ = run(&sleepy, seconds: doze - 3, alone(60))
let before = sleepy.idle.played
var yawning = false, shut = false
for frame in run(&sleepy, from: doze - 3, seconds: 3, alone(60)) {
    if sleepy.idle.act == .yawn { yawning = true; if frame.pose.open < 0.2 { shut = true } }
}
check(yawning && shut && sleepy.idle.played == before + 1, "just before it dozes it stretches and yawns, once, eyes shut")
_ = run(&sleepy, from: doze, seconds: 3, alone(60))
check(sleepy.mood == .dozing, "then it dozes")
let asleep = sleepy.idle.played
_ = run(&sleepy, from: doze + 3, seconds: 120, alone(10))
check(sleepy.idle.played == asleep && sleepy.idle.act == nil, "asleep, it plays nothing")

// --- Never in the way ---

for (what, input) in [
    ("while an agent thinks", Input(activity: .thinking, animates: 10, home: home, range: range)),
    ("while you talk", Input(activity: .listening, animates: 10, home: home, range: range)),
    ("sent to show something", Input(sent: true, animates: 10, home: home, range: range)),
    ("with the pointer on its bubble", Input(held: true, animates: 10, home: home, range: range)),
    ("with an answer in its bubble", Input(shows: true, animates: 10, home: home, range: range)),
    ("while it shows a state asked for by name", Input(asked: .idle, animates: 10, home: home, range: range)),
] as [(String, Input)] {
    var sim = CharacterSim()
    _ = run(&sim, seconds: 90) { _ in input }
    check(sim.idle.played == 0, "\(what): it plays nothing")
}

// On a stroll it walks, and plays only once it is back where it rests.
var walker = CharacterSim()
var far = 0.0, playedAway = 0.0
for t in 0..<(300 * 30) {
    let f = walker.step(to: Double(t) / 30, Input(strolls: true, animates: 10, home: home, range: range))
    far = max(far, abs(f.x - home))
    if walker.idle.act != nil { playedAway = max(playedAway, abs(f.x - home)) }
}
check(far > 20 && walker.idle.played > 0 && playedAway < 0.5, "with the stroll on: it strolls and it plays, never both at once (\(far), \(playedAway))")

// Work in the middle of one: it stops, and the body does not jump.
var cut = CharacterSim()
var t = 0
while cut.idle.act != .hop, t < doze * 30 { t += 1; _ = cut.step(to: Double(t) / 30, alone(10)(0)) }
check(cut.idle.act == .hop, "(it is in a hop)")
for _ in 1...12 { t += 1; _ = cut.step(to: Double(t) / 30, alone(10)(0)) }
var last = cut.step(to: Double(t) / 30, alone(10)(0)).pose.lift
var worst = 0.0
for _ in 1...45 {
    t += 1
    let lift = cut.step(to: Double(t) / 30, Input(activity: .thinking, animates: 10, home: home, range: range)).pose.lift
    worst = max(worst, abs(lift - last)); last = lift
}
check(cut.idle.act == nil && worst < 6, "work in the middle of a hop: it stops, and comes down without a jump (\(worst))")

// The pointer comes close: stepping aside comes first.
var shy = CharacterSim()
_ = run(&shy, seconds: 60) { _ in Input(pointer: (x: home - 20, y: 30), animates: 10, home: home, range: range) }
check(abs(shy.x - home) > 100, "the pointer close: it steps aside as before")

// Called by name (#570 will ask for one): it plays at once.
var asked = IdlePlay()
asked.start(.sway, 5)
check(asked.act == .sway && asked.step(5.5, 1.0 / 30, free: true, gap: 60, dozeIn: 100).tilt != 0, "started by name, it plays without the wait")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
