import Foundation

/// The character from one moment to the next: which state it is in, where
/// it is along the edge, where it looks, and the marks it leaves. Stepped
/// once a frame; everything it returns is ready to draw. Foundation only,
/// so the tests can run it without a window.
///
/// Along the edge it is measured in screen points; the drawing itself in
/// its own units (CharacterMath), `unit` points each.
struct CharacterSim {
    typealias M = CharacterMath

    struct Input {
        var activity = M.Activity.idle
        /// 0…1: the microphone while listening.
        var level = 0.0
        /// The pointer: along the edge, and its height above it. Nil when
        /// it is on another screen.
        var pointer: (x: Double, y: Double)?
        /// The pointer is on its speech bubble: it stays where it is, so
        /// the bubble is not pulled from under the pointer.
        var held = false
        /// The answering agent sent it to show something (#482): it goes
        /// to `home` at once, awake, whatever the pointer did before.
        var sent = false
        /// `voice.stroll`: with nothing to do, it takes a slow stroll
        /// beside where it rests now and then (#482).
        var strolls = false
        /// Where it rests, and how far it may go.
        var home = 0.0
        var range: ClosedRange<Double> = 0...0
    }

    /// Points per drawing unit: a body 56 points across.
    let unit: Double
    /// Idle this long, it dozes.
    static let dozeAfter = 120.0
    /// How far it keeps from the pointer, and how long before it comes back.
    static let clear = 150.0
    static let awayFor = 4.0
    /// A stroll: how far from where it rests, at most, and how fast.
    static let strollReach = 110.0
    static let strollSpeed = 28.0

    private(set) var mood = M.Mood.idle
    private var goal = M.Mood.idle
    private var change = M.Transition(from: M.Pose(), to: M.Pose(), start: 0, duration: 0.5)
    /// When the passing state it is in gives way to `goal`.
    private var pending: Double?
    private var began: Double?
    private var last = 0.0
    private var restSince = 0.0

    private(set) var x = 0.0
    private(set) var speed = 0.0
    private var target = 0.0
    private var awayUntil = 0.0
    private var steppedAside = false
    /// A stroll: how far from home it is going and has got, when it turns
    /// round or sets off again, and how many it has taken.
    private var strollTo = 0.0, strolled = 0.0
    private var strollNext: Double?
    private var strolls = 0
    private var face = 0.0, lean = 0.0
    private var glance = (x: 0.0, y: 0.0)

    private var nextBlink = 0.0
    private var blinks = 0
    private struct Dot { var born, x, h, way: Double; var n: Int }
    private struct Burst { var born, x, h: Double; var seed: Int }
    private var dots: [Dot] = []
    private var bursts: [Burst] = []
    private var dotClock = 0.0
    private var marks = 0

    init(unit: Double = 0.56) { self.unit = unit }

    /// The pointer is this close: it steps aside.
    private var reach: Double { 50 * unit + 46 }
    private var tall: Double { 114 * unit + 40 }
    /// The middle of the body above the edge, in points.
    private func height(_ pose: M.Pose) -> Double { (pose.lift + 50 * pose.sy) * unit }

    mutating func step(to now: Double, _ input: Input) -> Frame {
        if began == nil {
            began = now; last = now; restSince = now; nextBlink = now + 2
            x = input.home; target = input.home
        }
        let dt = min(max(now - last, 0), 0.1)
        last = now

        // The pointer comes close: out of its way. Left alone: back home,
        // unless the pointer is resting there.
        let near = input.pointer.map { abs($0.x - x) < reach && abs($0.y) < tall } ?? false
        if input.sent {
            target = min(max(input.home, input.range.lowerBound), input.range.upperBound)
            restSince = now
            // The stroll is over: sent home again, it rests there.
            strolled = 0; strollTo = 0; strollNext = nil
        } else if input.held {
            target = x
            awayUntil = max(awayUntil, now + Self.awayFor)
        } else if near {
            target = M.aside(x: x, pointer: input.pointer!.x, clear: Self.clear, range: input.range)
            awayUntil = now + Self.awayFor
            restSince = now
            steppedAside = true
            // The stroll is over: left alone it goes home, not back to
            // where the pointer met it.
            strolled = 0; strollTo = 0; strollNext = nil
        } else if now >= awayUntil {
            let taken = input.pointer.map { abs($0.x - input.home) < Self.clear && abs($0.y) < tall } ?? false
            if !taken {
                if target != input.home { steppedAside = false }
                stroll(now, dt, input)
                target = min(max(input.home + strolled, input.range.lowerBound), input.range.upperBound)
            }
        }

        // Which state. A change starts from the pose it has now, so a
        // change in the middle of another is still one smooth move.
        if input.activity != .idle { restSince = now }
        var want = M.mood(for: input.activity)
        if want == .idle && now - restSince >= Self.dozeAfter { want = .dozing }
        if want != goal {
            goal = want
            if let via = M.passing(from: mood, to: want), via != mood {
                go(via, now); pending = now + M.hold(via)
            } else {
                go(want, now); pending = nil
            }
        }
        if let at = pending, now >= at { pending = nil; go(goal, now) }
        var pose = change.pose(at: now)

        // Along the edge: a spring a little short of critical, so it
        // arrives with a small overshoot.
        let wasMoving = abs(speed) > 40
        speed += (26 * (target - x) - 8.4 * speed) * dt
        speed = min(max(speed, -480), 480)
        x += speed * dt
        let moving = abs(speed) > 40
        let way: Double = speed >= 0 ? 1 : -1
        func toward(_ value: inout Double, _ to: Double, _ rate: Double) { value += (to - value) * (1 - exp(-dt * rate)) }
        toward(&face, min(max(speed / 200, -1), 1), 10)
        toward(&lean, min(max(speed / 480, -1), 1) * 13, 8)

        // It leaves dots behind while it moves, and stars when it has
        // stepped aside or understood.
        if abs(speed) > 60 {
            dotClock += dt
            while dotClock >= 0.05 {
                dotClock -= 0.05
                marks += 1
                dots.append(Dot(born: now, x: x, h: height(pose), way: way, n: marks))
            }
        }
        if wasMoving && !moving && steppedAside {
            steppedAside = false
            burst(now, pose)
        }
        dots.removeAll { now - $0.born >= Self.dotLife }
        bursts.removeAll { now - $0.born >= Self.starLife }

        // The eyes follow the pointer while it has nothing else to look at.
        var look = (x: 0.0, y: 0.0)
        if let p = input.pointer, [.idle, .notices, .calling, .asking].contains(mood) {
            let dx = p.x - x, dy = height(pose) - p.y
            let far = max(hypot(dx, dy), 1)
            let pull = min(far / 60, 1) * 4.5
            look = (dx / far * pull, dy / far * pull)
        }
        toward(&glance.x, look.x + face * 2, 9)
        toward(&glance.y, look.y, 9)

        // What keeps it alive: breath, bob, blinks, and the voice.
        let t = now - (began ?? now)
        func wave(_ period: Double) -> Double { sin(2 * .pi * t / period) }
        let z = pose.sleep
        let breath = (1 - z) * 0.012 * wave(2.8) + z * 0.04 * wave(3.4)
        let voice = pose.speak * OrbMath.speakingEnvelope(at: t)
        pose.sx *= (1 - breath / 2) * (1 + pose.hear * 0.05 * input.level)
        pose.sy *= (1 + breath) * (1 + pose.hear * 0.05 * input.level + 0.035 * voice)
        pose.lift += (1 - z) * 4 * wave(1.4) + z * 1.5 * wave(3.4) + 5 * voice
            + pose.ring * 7 * abs(wave(1.25)) + 6 * min(abs(speed) / 300, 1)
        pose.tilt += lean
        pose.gx += glance.x
        pose.gy += glance.y
        if now >= nextBlink + Self.blink {
            blinks += 1
            nextBlink = now + 2.2 + 4.5 * M.rnd(blinks)  // uneven, never the same loop twice
        }
        if now >= nextBlink { pose.open *= 1 - sin(.pi * (now - nextBlink) / Self.blink) }

        return Frame(pose: pose, x: x, face: face, level: input.level, voice: voice, t: t,
                     dots: dots.compactMap { dot(at: now, $0) }, stars: bursts.flatMap { stars(at: now, $0) })
    }

    /// With nothing to do, a slow walk a little way from home, a wait
    /// there, and a slow walk back: slow enough to leave no trail. Any
    /// work, or dozing off, takes it home the same way.
    private mutating func stroll(_ now: Double, _ dt: Double, _ input: Input) {
        if !input.strolls || mood != .idle {
            strollTo = 0; strollNext = nil
        } else if strollNext == nil {
            strollNext = now + 25 + 30 * M.rnd(strolls, 3)
        } else if now >= strollNext! {
            if strollTo == 0 {
                strolls += 1
                let far = 40 + (Self.strollReach - 40) * M.rnd(strolls, 1)
                let room = (left: input.home - input.range.lowerBound, right: input.range.upperBound - input.home)
                // To the side picked, unless only the other has the room.
                var way: Double = M.rnd(strolls, 2) < 0.5 ? -1 : 1
                if (way > 0 ? room.right : room.left) < far { way = -way }
                strollTo = way * min(far, way > 0 ? room.right : room.left)
                strollNext = now + abs(strollTo) / Self.strollSpeed + 5 + 6 * M.rnd(strolls, 4)
            } else {
                strollTo = 0
                strollNext = nil
            }
        }
        let pace = Self.strollSpeed * dt
        strolled += min(max(strollTo - strolled, -pace), pace)
    }

    /// Carried by the pointer (#502): it is where it is put, at once, and
    /// a stroll it was on is over.
    mutating func carry(to place: Double) {
        x = place; target = place; speed = 0
        strolled = 0; strollTo = 0; strollNext = nil
    }

    /// The state alone, where it rests: for Reduce Motion, which shows a
    /// still picture that changes between states and never a loop.
    static func still(_ activity: M.Activity, home: Double) -> Frame {
        // Its marks at full strength, so each state reads without motion:
        // the arcs of its voice only while it speaks.
        let pose = M.pose(M.mood(for: activity))
        return Frame(pose: pose, x: home, level: 1, voice: pose.speak)
    }

    private mutating func go(_ to: M.Mood, _ now: Double) {
        change = M.Transition(from: change.pose(at: now), to: M.pose(to), start: now, duration: M.duration(into: to))
        mood = to
        if to == .understood { burst(now, change.from) }
    }

    private mutating func burst(_ now: Double, _ pose: M.Pose) {
        marks += 1
        bursts.append(Burst(born: now, x: x, h: height(pose), seed: marks))
    }

    private static let blink = 0.2
    private static let dotLife = 0.8
    private static let starLife = 0.9
    /// A dot this far from the body has faded out: its window ends soon after.
    static let dotReach = 200.0

    /// A dot left behind: born at the body, it drifts up, shrinks and fades.
    private func dot(at now: Double, _ d: Dot) -> Mark? {
        let a = (now - d.born) / Self.dotLife
        guard a >= 0, a < 1 else { return nil }
        let r = (3.4 + 4.4 * M.rnd(d.n)) * pow(1 - a, 0.8) * min(a / 0.12, 1)
        return Mark(x: d.x - d.way * (30 + 16 * a) * unit,
                    y: d.h - (10 + (M.rnd(d.n, 1) - 0.5) * 26 - 16 * a * M.rnd(d.n, 2)) * unit,
                    r: r, alpha: 0.8 * (1 - a) * min(max((Self.dotReach - abs(d.x - x)) / 60, 0), 1), turn: 0, shade: 2 + d.n % 2)
    }

    /// A small burst of stars: they fly out over the top, turn, and fade.
    private func stars(at now: Double, _ b: Burst) -> [Mark] {
        let a = (now - b.born) / Self.starLife
        guard a >= 0, a < 1 else { return [] }
        let n = 6
        return (0..<n).map { i in
            let angle = -Double.pi * (0.08 + 0.84 * (Double(i) + 0.5 * M.rnd(i, b.seed)) / (Double(n) - 0.5))
            let far = 50 + (24 + 26 * M.rnd(i, b.seed + 1)) * (1 - pow(1 - a, 3))
            return Mark(x: b.x + cos(angle) * far * unit, y: b.h - sin(angle) * far * unit,
                        r: (6 + 6 * M.rnd(i, b.seed + 2)) * pow(sin(.pi * a), 0.6),
                        alpha: min(2.2 * (1 - a), 1), turn: 120 * a + 40 * Double(i), shade: 1 + i % 3)
        }
    }
}
