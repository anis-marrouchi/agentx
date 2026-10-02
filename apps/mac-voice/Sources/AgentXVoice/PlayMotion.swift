import Foundation

/// How things move in play mode (#505), after the rules the videos are
/// made with: nothing starts or stops at full speed, a jump is announced
/// by a crouch and ends in a soft landing, letters leave one after the
/// other, and what falls bounces once before it lies still. Numbers only.
enum PlayMotion {
    typealias M = CharacterMath

    /// Fast start, slow stop; and slow start, fast end.
    static func out(_ p: Double) -> Double { 1 - into(1 - p) }
    static func into(_ p: Double) -> Double {
        let p = min(max(p, 0), 1)
        return p * p
    }

    /// The body at one moment of a move: how far along its way (0…1),
    /// how high in its arc (0…1), its stretch, how deep it sits on its
    /// feet (0…1) and how fast it goes (0…1).
    struct Body: Equatable {
        var travel = 0.0, air = 0.0
        var sx = 1.0, sy = 1.0
        var dip = 0.0
        var speed = 0.0
    }

    /// Seconds: the crouch before a jump, the landing after it, and the
    /// start and the stop of a walk.
    static let crouch = 0.16
    static let landing = 0.26
    static let walkUp = 0.2
    static let walkDown = 0.26
    /// How much taller the body is at full stretch, and how much shorter
    /// at the deepest of a crouch and of a landing.
    static let stretch = 0.14
    static let squat = 0.16
    static let squash = 0.2

    /// A jump of `duration` seconds, `t` seconds in. It crouches first
    /// and goes nowhere, leaves stretched, is round at the top, comes
    /// down stretched, and lands: squashed, a little too tall once, then
    /// still. It has arrived when the landing begins.
    static func jump(_ t: Double, of duration: Double) -> Body {
        guard duration > 0 else { return Body(travel: 1) }
        let t = min(max(t, 0), duration)
        let before = min(crouch, duration * 0.25), after = min(landing, duration * 0.3)
        // A jump too short for a whole landing changes shape less, not faster.
        let long = stretch * after / landing, flat = squash * after / landing
        if t < before {
            // Down slowly, up fast: the push.
            let q = t / before
            let deep = q < 0.65 ? out(q / 0.65) : 1 - into((q - 0.65) / 0.35)
            return Body(sx: 1 + squat * 0.7 * deep, sy: 1 - squat * deep, dip: deep)
        }
        if t <= duration - after {
            let u = M.span(t, before, duration - after)
            // Stretched while it moves fast up or down, round at the top.
            let more = long * abs(1 - 2 * u) * min(u / 0.12, 1)
            return Body(travel: u, air: 4 * u * (1 - u), sx: 1 - more * 0.6, sy: 1 + more, speed: 1)
        }
        let more = keys([(0, long), (0.4, -flat), (0.72, 0.04), (1, 0)], at: (t - (duration - after)) / after)
        return Body(travel: 1, sx: 1 - more * 0.6, sy: 1 + more, dip: max(-more / flat, 0))
    }

    /// A walk, or a wipe, of `duration` seconds, `t` seconds in: it gets
    /// up to speed, keeps it, and slows to a stop.
    static func glide(_ t: Double, of duration: Double) -> Body {
        guard duration > 0 else { return Body(travel: 1) }
        let t = min(max(t, 0), duration)
        let up = min(walkUp, duration / 3), down = min(walkDown, duration / 3)
        // Full speed, in ways a second.
        let top = 1 / (duration - up / 2 - down / 2)
        if t < up { return Body(travel: top * t * t / (2 * up), speed: t / up) }
        if t <= duration - down { return Body(travel: top * (t - up / 2), speed: 1) }
        let left = duration - t
        return Body(travel: 1 - top * left * left / (2 * down), speed: left / down)
    }

    /// When the `k`th of `count` things starts after the first: one after
    /// the other, and all gone within 0.4 seconds, so it reads as one go.
    static func stagger(_ k: Int, of count: Int) -> Double {
        guard count > 1 else { return 0 }
        return Double(k) * min(0.035, 0.4 / Double(count - 1))
    }

    /// How high something is above where it landed, `seconds` after it
    /// hit at `speed` (points a second) under `gravity`: one bounce, a
    /// third as fast as it came down, then it lies still.
    static func bounce(_ seconds: Double, speed: Double, gravity: Double) -> Double {
        let up = abs(speed) / 3
        guard seconds > 0, gravity > 0 else { return 0 }
        return max(up * seconds - gravity * seconds * seconds / 2, 0)
    }

    /// The seconds that bounce lasts.
    static func bounceTime(speed: Double, gravity: Double) -> Double {
        gravity > 0 ? 2 * abs(speed) / 3 / gravity : 0
    }

    /// The value at `p` between (place, value) keys in order, eased from
    /// each key to the next.
    static func keys(_ keys: [(at: Double, value: Double)], at p: Double) -> Double {
        guard let first = keys.first, let last = keys.last else { return 0 }
        if p <= first.at { return first.value }
        for (a, b) in zip(keys, keys.dropFirst()) where p <= b.at {
            return a.value + (b.value - a.value) * M.ease(M.span(p, a.at, b.at))
        }
        return last.value
    }
}
