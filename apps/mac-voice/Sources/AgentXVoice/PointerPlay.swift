import Foundation

/// Play with the pointer (#505): with "Play mode" ticked, an idle
/// character does more than step aside. When the pointer moves within
/// its sight it starts a game: it follows it along the edge, crouches
/// and jumps at it like a cat, or runs away from it. Between games it
/// rests, and the usual rules hold. A click in its sight makes it jump.
///
/// It only decides where the character wants to be and how it crouches
/// and hops; `CharacterSim` moves it. Foundation only, and the same
/// games in the same order on every run, so the tests can count on them.
struct PointerPlay {
    typealias M = CharacterMath

    enum Game: Equatable { case follow, pounce, flee }

    struct Out: Equatable {
        /// Where it wants to be along the edge. Nil: no game, the usual rules.
        var target: Double?
        /// 0…1 crouched, and the height of a hop in drawing units.
        var crouch = 0.0
        var hop = 0.0
        /// It came down on the pointer just now.
        var caught = false
    }

    /// How far along the edge and above it the pointer is seen, in points.
    static let sight = (x: 520.0, y: 360.0)
    /// A pointer slower than this, in points a second, starts no game.
    static let stir = 80.0
    /// Following, it stops this short of the pointer.
    static let gap = 70.0
    /// It jumps at a pointer no further than this, and no higher.
    static let leap = (x: 220.0, y: 150.0)
    /// It has caught a pointer this close to where it comes down.
    static let grip = 45.0
    /// Running away, it puts this much between the pointer and itself.
    static let far = 320.0
    /// Seconds: the crouch before a jump, the jump, running away, and
    /// the jump a click gives it.
    static let wind = 0.5, air = 0.6, flight = 2.5, start = 0.35
    /// Drawing units: how high it jumps at the pointer, and at a click.
    static let high = 70.0, jolt = 34.0

    private(set) var game: Game?
    private(set) var games = 0
    private var began = 0.0, until = 0.0, next = 0.0
    private var jumpTo: Double?
    private var seen: (x: Double, y: Double)?
    private var down = false
    private var jolted: Double?

    /// One frame. `x` is where the character is; `pointer` along the edge
    /// and above it, nil on another screen; `down` the mouse button.
    mutating func step(_ now: Double, _ dt: Double, x: Double, pointer: (x: Double, y: Double)?,
                       down: Bool, range: ClosedRange<Double>) -> Out {
        let clicked = down && !self.down
        self.down = down
        let before = seen
        seen = pointer
        guard let p = pointer, abs(p.x - x) < Self.sight.x, abs(p.y) < Self.sight.y else {
            if game != nil { end(now) }
            return Out(hop: hop(now))
        }
        func inside(_ v: Double) -> Double { min(max(v, range.lowerBound), range.upperBound) }

        // A click startles it: a small jump, and the game is over.
        if clicked && jumpTo == nil {
            jolted = now
            if game != nil { end(now) }
        }

        if game == nil, now >= next, jolted == nil, let was = before, dt > 0,
           hypot(p.x - was.x, p.y - was.y) / dt > Self.stir {
            games += 1
            let pick = M.rnd(games, 7)
            let reach = abs(p.x - x) < Self.leap.x && abs(p.y) < Self.leap.y
            game = pick < 0.5 ? .follow : pick < 0.8 ? (reach ? .pounce : .follow) : .flee
            began = now
            jumpTo = nil
            until = now + (game == .follow ? 4 + 3 * M.rnd(games, 2) : game == .flee ? Self.flight : Self.wind + Self.air)
        }

        var out = Out(hop: hop(now))
        switch game {
        case nil:
            break
        case .follow:
            // On the side it is on, a little short of the pointer.
            out.target = inside(p.x + (x >= p.x ? Self.gap : -Self.gap))
        case .pounce:
            let t = now - began
            if t < Self.wind {
                out.target = x
                out.crouch = M.ease(t / (Self.wind * 0.8))
            } else {
                // It jumps at where the pointer was when it let go.
                if jumpTo == nil { jumpTo = inside(p.x) }
                let a = M.span(t, Self.wind, Self.wind + Self.air)
                out.target = jumpTo
                out.crouch = 1 - M.ease(a / 0.25)
                out.hop = Self.high * sin(.pi * a)
            }
        case .flee:
            out.target = abs(p.x - x) < Self.far ? M.aside(x: x, pointer: p.x, clear: Self.far, range: range) : x
        }
        if game != nil && now >= until {
            out.caught = game == .pounce && abs(p.x - x) < Self.grip && abs(p.y) < Self.leap.y
            end(now)
        }
        return out
    }

    /// The assistant has work, or play is off: no game, and none at once
    /// after. The button is still followed, so one held through it is no click.
    mutating func stop(_ now: Double, down: Bool) {
        if game != nil { end(now) }
        self.down = down
        jolted = nil
        seen = nil
    }

    /// A game is over: a rest of five to thirteen seconds before the next.
    private mutating func end(_ now: Double) {
        game = nil
        jumpTo = nil
        next = now + 5 + 8 * M.rnd(games, 3)
    }

    /// The jump a click gives it.
    private mutating func hop(_ now: Double) -> Double {
        guard let at = jolted else { return 0 }
        let a = (now - at) / Self.start
        if a >= 1 { jolted = nil; return 0 }
        return Self.jolt * sin(.pi * a)
    }
}
