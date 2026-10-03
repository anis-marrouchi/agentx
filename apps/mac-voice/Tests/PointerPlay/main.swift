// Tests for play with the pointer (#505): with play mode on, an idle
// character follows the pointer, jumps at it or runs from it, and jumps
// at a click. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias M = CharacterMath
typealias Input = CharacterSim.Input
typealias Game = PointerPlay.Game

let home = 1000.0, range = 44.0...1400.0
let fps = 30.0

/// A character at rest at home, one second in.
func rested() -> (CharacterSim, Double) {
    var sim = CharacterSim()
    var t = 0.0
    for _ in 0..<30 { t += 1 / fps; _ = sim.step(to: t, Input(home: home, range: range)) }
    return (sim, t)
}

/// Step with the pointer at `at(seconds since the start of this run)`.
func run(_ sim: inout CharacterSim, _ t: inout Double, _ seconds: Double, plays: Bool = true,
         activity: M.Activity = .idle, down: (Double) -> Bool = { _ in false },
         until: (CharacterSim) -> Bool = { _ in false },
         at: (Double, Double) -> (x: Double, y: Double)?) -> [CharacterSim.Frame] {
    var frames: [CharacterSim.Frame] = []
    let from = t
    for _ in 0..<Int(seconds * fps) {
        t += 1 / fps
        frames.append(sim.step(to: t, Input(activity: activity, pointer: at(t - from, sim.x), plays: plays,
                                            down: down(t - from), home: home, range: range)))
        if until(sim) { break }
    }
    return frames
}

/// The first game a fresh character starts with a pointer wiggling at
/// `dx` from home, `y` above the edge, after `skip` games were played out.
func game(after skip: Int, dx: Double = 150, y: Double = 60) -> (CharacterSim, Double, Game?) {
    var (sim, t) = rested()
    let wiggle: (Double, Double) -> (x: Double, y: Double)? = { s, _ in (home + dx + 20 * sin(s * 9), y) }
    _ = run(&sim, &t, 600, until: { $0.play.games > skip }, at: wiggle)
    return (sim, t, sim.play.game)
}

// --- Off, nothing changes ---

var (plain, pt) = rested()
let ignored = run(&plain, &pt, 6, plays: false) { s, _ in (home + 150 + 20 * sin(s * 9), 60) }
check(plain.play.games == 0 && abs(plain.x - home) < 0.01, "play mode off: a pointer moving in its sight starts no game, and it stays at home")
check(ignored.allSatisfy { $0.pose.lift < 20 }, "and it does not hop")

// --- A game starts ---

var (still, st) = rested()
_ = run(&still, &st, 6) { _, _ in (home + 150, 60) }
check(still.play.games == 0, "play mode on, a pointer that rests in its sight starts no game")
_ = run(&still, &st, 6) { s, _ in (home + 150 + 20 * sin(s * 9), 700) }
check(still.play.games == 0, "nor does one that moves high above it, out of its sight")
_ = run(&still, &st, 6) { _, _ in nil }
check(still.play.games == 0, "nor one on another screen")
_ = run(&still, &st, 1) { s, _ in (home + 150 + 20 * sin(s * 9), 60) }
check(still.play.games == 1 && still.play.game != nil, "one that moves in its sight starts a game at once")

// The same games in the same order on every run, and all three turn up.
var kinds: [Game] = []
for n in 0..<12 { if let g = game(after: n).2 { kinds.append(g) } }
var again: [Game] = []
for n in 0..<12 { if let g = game(after: n).2 { again.append(g) } }
check(kinds.count == 12 && kinds == again, "twelve games in a row: the same on every run")
check(Set(kinds.map { "\($0)" }).count == 3, "and it follows, jumps and runs away: all three turn up")

func first(_ kind: Game) -> Int { kinds.firstIndex(of: kind)! }

// --- Follow ---

var (dog, dt0, _) = game(after: first(.follow))
let walked = run(&dog, &dt0, 2.5) { s, _ in (home + 150 - 160 * min(s, 2.5), 60) }
let px = home + 150 - 160 * 2.5
check(dog.play.game == .follow && abs(abs(dog.x - px) - PointerPlay.gap) < 60, "following: it goes where the pointer goes, a little short of it")
check(abs(dog.x - home) > 150, "well away from where it rests")
check(walked.contains { !$0.dots.isEmpty } && walked.contains { $0.face < -0.5 }, "turned the way it goes, leaving its dots")
_ = run(&dog, &dt0, 9) { _, _ in (px, 60) }
check(dog.play.game == nil, "a game of follow ends by itself within seven seconds")
_ = run(&dog, &dt0, 8) { _, _ in (200, 700) }
check(abs(dog.x - home) < 3, "left alone after a game, it goes back home")

// The pointer leaves its sight: the game is over.
var (lost, lt, _) = game(after: first(.follow))
_ = run(&lost, &lt, 0.2) { _, _ in nil }
check(lost.play.game == nil, "the pointer goes to another screen: the game is over")

// --- Jump at it ---

var (cat, ct, _) = game(after: first(.pounce))
let spot = (x: cat.x + 150, y: 60.0)
let crouching = run(&cat, &ct, PointerPlay.wind - 0.1) { _, _ in spot }
check(cat.play.game == .pounce && crouching.last!.pose.sy < 0.9 && crouching.last!.pose.lift < 12,
      "jumping at it: it crouches first")
check(abs(crouching.last!.x - crouching.first!.x) < 12, "and stays where it is while it crouches")
let jumping = run(&cat, &ct, PointerPlay.air + 0.4, until: { $0.play.game == nil }) { _, _ in spot }
check(jumping.map(\.pose.lift).max()! > 14 + PointerPlay.high * 0.7, "then leaves the edge")
check(cat.play.game == nil && abs(cat.x - spot.x) < PointerPlay.grip, "and comes down on the pointer")
check(!jumping.last!.stars.isEmpty, "with stars: it caught it")
let landed = run(&cat, &ct, 2) { _, _ in spot }
check(abs(landed.last!.pose.lift - 14) < 9 && abs(cat.x - spot.x) > 120, "then it is back on its edge, and steps aside as it always does")

// A pointer that moves away while it is in the air is not caught.
var (miss, mt, _) = game(after: first(.pounce))
let from = miss.x + 150
let missed = run(&miss, &mt, PointerPlay.wind + PointerPlay.air + 0.4) { s, _ in (s < PointerPlay.wind + 0.1 ? from : from + 300, 60) }
check(abs(miss.x - from) < 60 && !missed.contains { !$0.stars.isEmpty }, "it lands where the pointer was: no stars for a pointer that got away")

// Too far or too high to jump at: it follows instead.
check(game(after: first(.pounce), dx: 400).2 == .follow, "a pointer too far to jump at is followed")
check(game(after: first(.pounce), y: 300).2 == .follow, "and so is one too high")

// --- Run away ---

var (mouse, rt, _) = game(after: first(.flee))
let chased = run(&mouse, &rt, PointerPlay.flight - 0.2) { _, x in (home + 150, 60) }
check(mouse.play.game == .flee && abs(mouse.x - (home + 150)) > PointerPlay.far - 10 && range.contains(mouse.x),
      "running away: it puts more room between them than when it steps aside")
check(chased.allSatisfy { range.contains($0.x) }, "and never leaves the edge it lives on")

// --- A click ---

var (jumpy, jt, _) = game(after: first(.follow))
let startled = run(&jumpy, &jt, 0.5, down: { $0 > 0.1 }) { _, _ in (home + 150, 60) }
check(jumpy.play.game == nil, "a click in its sight ends the game")
check(startled.map(\.pose.lift).max()! > 14 + PointerPlay.jolt * 0.5, "and makes it jump")
let held = run(&jumpy, &jt, 1, down: { _ in true }) { _, _ in (home + 150, 60) }
check(held.last!.pose.lift < 22, "once: a button held down is one click")
var (far, ft) = rested()
let unseen = run(&far, &ft, 0.5, down: { $0 > 0.1 }) { _, _ in (200, 700) }
check(unseen.allSatisfy { $0.pose.lift < 20 }, "a click out of its sight is nothing to it")

// --- It gives way ---

var (busy, bt, _) = game(after: first(.pounce))
_ = run(&busy, &bt, PointerPlay.wind + 0.2) { _, x in (x + 150, 60) }
let cut = run(&busy, &bt, 1.5, activity: .listening) { s, _ in (home + 150 + 20 * sin(s * 9), 60) }
check(busy.play.game == nil && busy.mood == .listening, "you speak in the middle of a jump: the game is over and it listens")
var snap = 0.0
for (a, b) in zip(cut, cut.dropFirst()) { snap = max(snap, abs(a.pose.lift - b.pose.lift)) }
check(snap < 22, "coming down as a move, not at once")
_ = run(&busy, &bt, 4, activity: .thinking) { s, _ in (home + 150 + 20 * sin(s * 9), 60) }
let n = busy.play.games
_ = run(&busy, &bt, 4, activity: .speaking) { s, _ in (home + 150 + 20 * sin(s * 9), 60) }
check(busy.play.games == n, "while it works or speaks, no game starts")

var (bubble, ut) = rested()
for _ in 0..<120 {
    ut += 1 / fps
    _ = bubble.step(to: ut, Input(pointer: (home + 150 + 20 * sin(ut * 9), 60), held: true, plays: true, home: home, range: range))
}
check(bubble.play.games == 0 && abs(bubble.x - home) < 1, "the pointer on its bubble: no game, it stays")

// Its bubble holds something to use (an answer, an error, call buttons):
// a pointer on its way there starts no game, so the bubble stays put.
var (full, fullT) = rested()
var fullFar = 0.0
for _ in 0..<Int(20 * fps) {
    fullT += 1 / fps
    _ = full.step(to: fullT, Input(pointer: (home + 150 + 20 * sin(fullT * 9), 120), shows: true, plays: true, home: home, range: range))
    fullFar = max(fullFar, abs(full.x - home))
}
check(full.play.games == 0 && fullFar < 1, "its bubble holds something to use: no game, it stays")

// The same in the middle of a game: the game is over.
var (filled, cutT, _) = game(after: 0)
check(filled.play.game != nil, "(a game is on)")
cutT += 1 / fps
_ = filled.step(to: cutT, Input(pointer: (home + 150, 120), shows: true, plays: true, home: home, range: range))
check(filled.play.game == nil, "its bubble fills in the middle of a game: the game is over")

// Sent to show something (#482) in the middle of a game: the game is
// over and it goes home.
var (sent, sentT, _) = game(after: 0)
check(sent.play.game != nil, "(a game is on)")
for _ in 0..<Int(3 * fps) {
    sentT += 1 / fps
    _ = sent.step(to: sentT, Input(pointer: (home + 150, 60), sent: true, plays: true, home: home, range: range))
}
check(sent.play.game == nil && abs(sent.x - home) < 1, "sent to show something in a game: the game is over, it is home")

// A button pressed while it works and still down after is no click: it
// moves as with the button up.
func afterWork(down: Bool) -> [Double] {
    var (sim, t) = rested()
    var lifts: [Double] = []
    for i in 0..<Int(4 * fps) {
        t += 1 / fps
        let f = sim.step(to: t, Input(activity: i < 30 ? .thinking : .idle, pointer: (home + 150, 60), plays: true,
                                      down: down && i >= 20, home: home, range: range))
        lifts.append(f.pose.lift)
    }
    return lifts
}
check(zip(afterWork(down: true), afterWork(down: false)).allSatisfy { abs($0 - $1) < 0.01 },
      "a button held since it worked gives no hop")

// Nothing snaps in any game.
var worst = (lift: 0.0, stretch: 0.0, x: 0.0)
for n in 0..<12 {
    var (sim, t, _) = game(after: n)
    let frames = run(&sim, &t, 8) { s, _ in (home + 150 * cos(s * 1.3), 60 + 40 * sin(s * 2)) }
    for (a, b) in zip(frames, frames.dropFirst()) {
        worst.lift = max(worst.lift, abs(a.pose.lift - b.pose.lift))
        worst.stretch = max(worst.stretch, abs(a.pose.sy - b.pose.sy), abs(a.pose.sx - b.pose.sx))
        worst.x = max(worst.x, abs(a.x - b.x))
    }
}
check(worst.lift < 22 && worst.stretch < 0.09 && worst.x < 480 / fps + 0.01,
      "in twelve games with a circling pointer, no hop, crouch or step is a snap")

// Out on a stroll (#482) when a game starts: the stroll is over, and
// left alone after the game it goes home.
var (roamer, wt) = rested()
while wt < 110, abs(roamer.x - home) < 30 {
    wt += 1 / fps
    _ = roamer.step(to: wt, Input(strolls: true, plays: true, home: home, range: range))
}
check(abs(roamer.x - home) >= 30, "(it is out on a stroll)")
while wt < 140, roamer.play.games == 0 {
    wt += 1 / fps
    _ = roamer.step(to: wt, Input(pointer: (roamer.x + 150 + 20 * sin(wt * 9), 60), strolls: true, plays: true, home: home, range: range))
}
check(roamer.play.games == 1, "(a game starts while it is out)")
for _ in 0..<Int(8 * fps) {
    wt += 1 / fps
    _ = roamer.step(to: wt, Input(strolls: true, plays: true, home: home, range: range))
}
check(abs(roamer.x - home) < 2, "a game ends a stroll: left alone it goes home")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
