// Tests for how things move in play mode (#505): the jump with its
// crouch and its landing, the walk that starts and stops, letters that
// leave one after the other, and the one bounce.
// Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias Mo = PlayMotion

/// A move sampled at every frame of a 60 a second screen.
func frames(_ duration: Double, _ body: (Double) -> Mo.Body) -> [Mo.Body] {
    (0...Int((duration * 60).rounded())).map { body(min(Double($0) / 60, duration)) }
}
/// The largest step between two frames.
func step(_ bodies: [Mo.Body], _ value: (Mo.Body) -> Double) -> Double {
    zip(bodies, bodies.dropFirst()).map { abs(value($1) - value($0)) }.max() ?? 0
}

// --- A jump ---

for duration in [0.55, 0.9, 1.6] {
    let j = frames(duration) { Mo.jump($0, of: duration) }
    let before = min(Mo.crouch, duration * 0.25), after = min(Mo.landing, duration * 0.3)
    let name = "a jump of \(duration) s"
    check(j.first == Mo.Body() && j.last?.travel == 1 && abs((j.last?.sy ?? 0) - 1) < 1e-9 && abs((j.last?.sx ?? 0) - 1) < 1e-9,
          "\(name) starts and ends standing as it stood")
    let crouching = frames(before) { Mo.jump($0, of: duration) }
    check(crouching.allSatisfy { $0.travel == 0 && $0.air == 0 } && crouching.contains { $0.sy < 0.88 && $0.sx > 1.05 && $0.dip > 0.8 },
          "\(name) crouches first and goes nowhere meanwhile")
    let landing = frames(after) { Mo.jump(duration - after + $0, of: duration) }
    check(landing.allSatisfy { $0.travel == 1 && $0.air == 0 }, "\(name) has arrived when the landing begins")
    check(landing.contains { $0.sy < (duration < 0.7 ? 0.88 : 0.82) } && landing.contains { $0.sy > 1.02 && $0.dip == 0 },
          "\(name) lands squashed, then a little too tall once")
    check(zip(j, j.dropFirst()).allSatisfy { $1.travel >= $0.travel }, "\(name) never goes back")
    check(abs(Mo.jump(before + (duration - before - after) / 2, of: duration).air - 1) < 1e-9
          && abs(Mo.jump(before + (duration - before - after) / 2, of: duration).sy - 1) < 1e-9, "\(name) is round at the top of its arc")
    check(j.contains { $0.air > 0 && $0.air < 0.5 && $0.sy > 1.07 && $0.sx < 1 }, "\(name) is stretched on its way up and down")
    // From full stretch to full squash is 0.34: never half of it in one frame.
    check(step(j) { $0.sy } < 0.15 && step(j) { $0.sx } < 0.1, "\(name) never snaps from one shape to another")
}
check(Mo.jump(0.3, of: 0) == Mo.Body(travel: 1) && Mo.jump(-1, of: 1) == Mo.Body() && Mo.jump(9, of: 1).travel == 1,
      "a jump of no time is over, and times outside it are its ends")

// --- A walk ---

for duration in [0.3, 1.0, 3.5] {
    let g = frames(duration) { Mo.glide($0, of: duration) }
    let name = "a walk of \(duration) s"
    check(g.first?.travel == 0 && g.first?.speed == 0 && abs((g.last?.travel ?? 0) - 1) < 1e-9 && (g.last?.speed ?? 1) < 1e-9,
          "\(name) starts from still and ends still")
    check(zip(g, g.dropFirst()).allSatisfy { $1.travel >= $0.travel }, "\(name) never goes back")
    check(Mo.glide(duration / 2, of: duration).speed == 1, "\(name) is at full speed in the middle")
    check(step(g) { $0.speed } < 0.3 && g.allSatisfy { $0.sx == 1 && $0.sy == 1 && $0.air == 0 },
          "\(name) gathers and loses speed over several frames")
}
// Even pace would be at a tenth of the way after a tenth of the time.
check(Mo.glide(0.1, of: 1).travel < 0.05 && Mo.glide(0.9, of: 1).travel > 0.93, "a walk is behind an even pace at first, and nearly there near the end")
check(Mo.glide(1, of: 0) == Mo.Body(travel: 1), "a walk of no time is over")

// --- One after the other ---

check(Mo.stagger(0, of: 5) == 0 && abs(Mo.stagger(3, of: 5) - 0.105) < 1e-9, "letters leave 0.035 s apart")
check(abs(Mo.stagger(29, of: 30) - 0.4) < 1e-9 && Mo.stagger(1, of: 30) < 0.035, "a long word is still gone within 0.4 s")
check(Mo.stagger(0, of: 1) == 0 && Mo.stagger(0, of: 0) == 0, "one thing, or none, does not wait")

// --- The bounce ---

let g = 1400.0, hit = 900.0, time = Mo.bounceTime(speed: hit, gravity: g)
check(Mo.bounce(0, speed: hit, gravity: g) == 0 && Mo.bounce(time, speed: hit, gravity: g) < 1e-9 && Mo.bounce(time + 1, speed: hit, gravity: g) == 0,
      "a bounce starts on the ground, ends on it and stays there")
check(abs(Mo.bounce(time / 2, speed: hit, gravity: g) - 300 * 300 / (2 * g)) < 1e-9, "it rises a third as fast as it came down")
check(Mo.bounce(0.1, speed: 0, gravity: g) == 0 && Mo.bounceTime(speed: 0, gravity: g) == 0, "what lands softly does not bounce")

// --- Keys ---

let ks: [(at: Double, value: Double)] = [(0, 1), (0.5, -1), (1, 0)]
check(Mo.keys(ks, at: -1) == 1 && Mo.keys(ks, at: 0.5) == -1 && Mo.keys(ks, at: 2) == 0 && Mo.keys(ks, at: 0.25) == 0 && Mo.keys([], at: 0.5) == 0,
      "keys give their values at their places, the middle between, and the ends outside")

print(failures == 0 ? "all passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
