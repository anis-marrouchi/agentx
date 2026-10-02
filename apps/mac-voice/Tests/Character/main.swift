// Tests for the character (#458): its states, that nothing snaps, and how
// it moves out of the pointer's way. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias M = CharacterMath
typealias Input = CharacterSim.Input

// --- The nine states ---

check(M.Mood.allCases.count == 9, "there are nine states")
var distinct = true
for a in M.Mood.allCases { for b in M.Mood.allCases where a != b && M.pose(a) == M.pose(b) { distinct = false } }
check(distinct, "and each has a pose of its own")
check(M.mood(for: .idle) == .idle && M.mood(for: .listening) == .listening && M.mood(for: .thinking) == .working
      && M.mood(for: .speaking) == .speaking && M.mood(for: .ringing) == .calling && M.mood(for: .waiting) == .asking,
      "what the pill shows maps to a state: thinking works, a ringing call calls, a call between turns asks")
check(M.passing(from: .idle, to: .listening) == .notices, "it notices you before it listens")
check(M.passing(from: .listening, to: .working) == .understood, "it nods once it has heard you")
check(M.passing(from: .dozing, to: .speaking) == .notices, "it wakes before anything else")
check(M.passing(from: .working, to: .speaking) == nil, "other changes go straight there")

// --- Easing ---

check(M.ease(0) == 0 && M.ease(1) == 1 && M.swing(0) == 0 && abs(M.swing(1) - 1) < 1e-9, "a change starts at the old pose and ends at the new one")
var back = false, over = false
for i in 0...100 { let v = M.swing(Double(i) / 100); if v < 0 { back = true }; if v > 1 { over = true } }
check(back && over, "the body winds up before it goes and overshoots before it settles")
let half = M.Transition(from: M.pose(.idle), to: M.pose(.working), start: 0, duration: 1).pose(at: 0.5)
check(half.lid == M.pose(.working).lid && half.sx != M.pose(.working).sx, "the eyes are there by half time, the body is not")

// --- Nothing snaps ---

/// Run `seconds` at 30 frames a second, and return the frames.
let home = 1000.0, range = 44.0...1400.0
var clock = 0.0
func run(_ sim: inout CharacterSim, _ seconds: Double, _ activity: M.Activity, level: Double = 0,
         pointer: (x: Double, y: Double)? = nil) -> [CharacterSim.Frame] {
    var frames: [CharacterSim.Frame] = []
    for _ in 0..<Int(seconds * 30) {
        clock += 1.0 / 30
        frames.append(sim.step(to: clock, Input(activity: activity, level: level, pointer: pointer, home: home, range: range)))
    }
    return frames
}
/// The largest change between two frames in a row, per number.
func jumps(_ frames: [CharacterSim.Frame]) -> (stretch: Double, lift: Double, tilt: Double, mark: Double, eye: Double, x: Double) {
    var j = (stretch: 0.0, lift: 0.0, tilt: 0.0, mark: 0.0, eye: 0.0, x: 0.0)
    for (a, b) in zip(frames, frames.dropFirst()) {
        let p = a.pose, q = b.pose
        j.stretch = max(j.stretch, abs(p.sx - q.sx), abs(p.sy - q.sy))
        j.lift = max(j.lift, abs(p.lift - q.lift))
        j.tilt = max(j.tilt, abs(p.tilt - q.tilt))
        j.mark = max(j.mark, abs(p.hear - q.hear), abs(p.think - q.think), abs(p.speak - q.speak),
                     abs(p.sleep - q.sleep), abs(p.ring - q.ring), abs(p.ask - q.ask))
        j.eye = max(j.eye, abs(p.lid - q.lid), abs(p.curve - q.curve), abs(p.size - q.size), abs(p.gx - q.gx), abs(p.gy - q.gy))
        j.x = max(j.x, abs(a.x - b.x))
    }
    return j
}

var sim = CharacterSim()
var all: [CharacterSim.Frame] = []
var seen: Set<M.Mood> = []
// Every state in turn, some cut short in the middle of the change.
let script: [(Double, M.Activity)] = [(1, .idle), (1.5, .listening), (0.2, .thinking), (2, .thinking), (2, .speaking),
                                      (0.1, .idle), (0.1, .listening), (0.1, .idle), (1, .ringing), (1.5, .waiting),
                                      (0.3, .speaking), (1, .idle)]
for (seconds, activity) in script {
    for _ in 0..<Int(seconds * 30) {
        all += run(&sim, 1.0 / 30, activity, level: 0.6)
        seen.insert(sim.mood)
    }
}
let j = jumps(all)
check(j.stretch < 0.06 && j.lift < 4 && j.tilt < 4, "no body snaps from one frame to the next, even when a change is cut short (\(String(format: "%.3f %.2f %.2f", j.stretch, j.lift, j.tilt)))")
check(j.mark < 0.25 && j.eye < 1.2, "marks fade in and out, and the eyes turn, never jump (\(String(format: "%.2f %.2f", j.mark, j.eye)))")
check(seen.isSuperset(of: [.idle, .notices, .listening, .understood, .working, .speaking, .calling, .asking]),
      "a turn and a call go through eight of the nine states")

// --- Dozing ---

var sleepy = CharacterSim()
clock = 0
_ = run(&sleepy, CharacterSim.dozeAfter - 2, .idle)
check(sleepy.mood == .idle, "idle, it stays awake for a while")
let settling = run(&sleepy, 6, .idle)
check(sleepy.mood == .dozing && settling.last!.pose.sleep > 0.99, "then it dozes")
check(jumps(settling).mark < 0.05, "and falls asleep slowly")
let asleep = run(&sleepy, 4, .idle)
check(Set(asleep.map { ($0.pose.sy * 1000).rounded() }).count > 10, "asleep, it still breathes")
let waking = run(&sleepy, 2, .listening)
check(sleepy.mood == .listening && waking.contains { $0.pose.size > 1.1 }, "your voice wakes it: it notices you, then listens")
check(jumps(waking).mark < 0.25, "and waking is a change like any other")

// --- Out of the pointer's way ---

var shy = CharacterSim()
clock = 0
_ = run(&shy, 1, .idle)
check(abs(shy.x - home) < 0.01, "it rests at home")
let pointer = (x: home - 20, y: 30.0)
let away = run(&shy, 2, .idle, pointer: pointer)
check(shy.x - pointer.x > 120 && range.contains(shy.x), "the pointer comes close: it moves clear of it, to the side it was on")
check(jumps(away).x < 480.0 / 30 + 0.01, "by gliding, not by jumping")
check(away.contains { !$0.dots.isEmpty }, "it leaves dots behind while it moves")
check(away.contains { !$0.stars.isEmpty }, "and reacts with stars once it has stepped aside")
check(away.contains { $0.face > 0.5 } && abs(away.last!.face) < 0.1, "it turns the way it goes, and faces you again when it stops")
check(away.last!.pose.gx < -1, "then looks at the pointer")
let rest = run(&shy, 1.5, .idle, pointer: pointer)
check(rest.last!.dots.isEmpty && rest.last!.stars.isEmpty, "the dots and stars fade away")
check(abs(shy.x - (pointer.x + CharacterSim.clear)) < 3, "it stays clear while the pointer is where it rests")
_ = run(&shy, CharacterSim.awayFor + 3, .idle, pointer: (x: 200, y: 400))
check(abs(shy.x - home) < 2, "left alone, it goes back home")

var cornered = CharacterSim()
clock = 0
_ = cornered.step(to: 0, Input(home: 1380, range: range))
for i in 1...60 { _ = cornered.step(to: Double(i) / 30, Input(pointer: (x: 1370, y: 20), home: 1380, range: range)) }
check(cornered.x < 1370 - 120 && range.contains(cornered.x), "against the end of the screen, it goes the other way")
check(M.aside(x: 50, pointer: 60, clear: 150, range: range) == 210, "and the same at the other end")

let fixed = CharacterSim.still(.thinking, home: home)
check(fixed.pose == M.pose(.working) && fixed.x == home && fixed.dots.isEmpty, "with Reduce Motion it is the state alone, at home")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
