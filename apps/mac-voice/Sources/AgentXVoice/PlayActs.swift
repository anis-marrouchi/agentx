import Foundation

/// Play mode past the first script (#505): pieces of the picture that
/// move (a kicked letter, a word that falls, a word carried away), and a
/// different play each time. Numbers only, like `PlayMath`.
extension PlayMath {
    /// A piece cut out of the picture and drawn somewhere else: which
    /// part of the picture, where its top-left corner is now, and how far
    /// it has turned (radians).
    struct Piece: Equatable {
        var from: Rect
        var at: Point
        var turn = 0.0
    }

    /// A piece from the moment it leaves its place. Its place is covered
    /// with the page's colour from then on.
    struct Cut {
        enum Path {
            /// Thrown at this speed (points a second) and turning (about
            /// so many radians a second); it falls and stays on the bottom
            /// of the picture, `rise` points up so a pile is not one row.
            case thrown(v: Point, spin: Double, rise: Double)
            /// Lifted above the character's head, kept there until
            /// `until`, then put down with its corner at `to`.
            case held(until: Double, to: Point)
        }
        var source: Rect
        var paper: UInt32
        var start: Double
        var path: Path
    }

    /// Points a second each second, and the seconds to lift a word or put
    /// it down.
    static let gravity = 1400.0
    static let lift = 0.35

    /// Where a thrown piece is `seconds` after it left. It bounces once
    /// on the bottom of the picture and lies still, and stops at its sides.
    static func thrown(_ source: Rect, v: Point, spin: Double, rise: Double, after seconds: Double,
                       width: Double, height: Double) -> Piece {
        let floor = max(height - source.h - rise, source.y)
        let landing = (-v.y + (v.y * v.y + 2 * gravity * (floor - source.y)).squareRoot()) / gravity
        let s = min(max(seconds, 0), landing)
        // How fast it comes down, and the bounce that makes: a third as
        // fast, sideways too.
        let hit = v.y + gravity * landing
        let more = min(max(seconds - landing, 0), PlayMotion.bounceTime(speed: hit, gravity: gravity))
        let x = min(max(source.x + v.x * (s + more / 3), 0), max(width - source.w, 0))
        // It turns about as fast as `spin`, and lands flat: the right way
        // up or upside down.
        let flat = (spin * landing / .pi).rounded() * .pi
        return Piece(from: source, at: Point(x: x, y: source.y + v.y * s + gravity * s * s / 2 - PlayMotion.bounce(more, speed: hit, gravity: gravity)), turn: landing > 0 ? flat * s / landing : 0)
    }

    /// What it can do to a line.
    enum Act: CaseIterable { case eat, wipe, kick, stomp, carry }

    /// The same numbers for the same seed, so a play can be told again
    /// and tested (SplitMix64).
    struct Seeded: RandomNumberGenerator {
        var state: UInt64
        init(_ seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// A play, different for each seed: it jumps onto one of the lines
    /// near the middle of the page and walks it, then does one thing to
    /// each of up to four others, never the same thing twice. Lines too
    /// close to the top to stand on, too short or of one word are left
    /// alone.
    static func script(_ lines: [Line], width: Double, height: Double, seed: UInt64) -> [Step] {
        var rng = Seeded(seed)
        let fit = lines.indices.filter { lines[$0].words.count >= 2 && lines[$0].rect.w >= 120 && lines[$0].rect.y >= top + 40 }
        func far(_ i: Int) -> Double { hypot(lines[i].rect.midX - width / 2, lines[i].rect.midY - height / 2) }
        let near = fit.sorted { far($0) < far($1) }.prefix(8).shuffled(using: &rng)
        guard let first = near.first else { return [] }
        let acts = Act.allCases.shuffled(using: &rng)
        var steps: [Step] = [.jump(line: first), .walk(line: first)]
        // With one line only, it plays on the line it walked.
        let stage = near.count > 1 ? Array(near.dropFirst().prefix(4)) : [first]
        for (k, i) in stage.enumerated() {
            let n = lines[i].words.count, word = Int.random(in: 0..<n, using: &rng)
            switch acts[k] {
            case .eat:
                let from = Int.random(in: 0..<n - 1, using: &rng)
                steps.append(.eat(line: i, words: from..<min(from + 3, n)))
            case .wipe: steps.append(.wipe(line: i))
            case .stomp: steps.append(.stomp(line: i))
            // The walked line is whole: the word goes to its end.
            case .carry where i != first: steps.append(.carry(line: i, word: word, to: first))
            case .kick, .carry: steps.append(.kick(line: i, word: word))
            }
        }
        return steps + [.rest(1.2)]
    }
}

extension Play {
    /// The pieces that have left their place by this frame: each place is
    /// covered, and the piece is drawn where it is now.
    func move(_ f: inout Frame) {
        for cut in cuts where cut.start <= f.t {
            f.gone.append((cover(cut.source), cut.paper))
            switch cut.path {
            case .thrown(let v, let spin, let rise):
                f.pieces.append(P.thrown(cut.source, v: v, spin: spin, rise: rise, after: f.t - cut.start, width: size.x, height: size.y))
            case .held(let until, let to):
                // From its place to above the head, and from there down.
                let head = P.Point(x: f.at.x - cut.source.w / 2, y: f.at.y - P.top - cut.source.h)
                let a = f.t < until ? P.Point(x: cut.source.x, y: cut.source.y) : head, b = f.t < until ? head : to
                let q = M.ease(f.t < until ? M.span(f.t, cut.start, cut.start + P.lift) : M.span(f.t, until, until + P.lift))
                f.pieces.append(P.Piece(from: cut.source, at: P.Point(x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q)))
            }
        }
    }

    /// How far along a move it is: a jump crouches first and lands at the
    /// end, a walk and a wipe start and stop, the rest keep one pace.
    func body(_ m: Move, at t: Double) -> PlayMotion.Body {
        switch m.kind {
        case .jump, .carry: return PlayMotion.jump(t - m.start, of: m.duration)
        case .walk, .wipe: return PlayMotion.glide(t - m.start, of: m.duration)
        default: return PlayMotion.Body(travel: M.span(t, m.start, m.end))
        }
    }

    /// Which way it faces during a move, and its pose without the motion.
    func look(_ m: Move) -> (face: Double, pose: M.Pose) {
        let way: Double = m.to.x >= m.from.x ? 1 : -1
        switch m.kind {
        case .jump: return (way, M.Pose(tilt: 6 * way, gy: -2))
        case .walk: return (way, M.Pose(tilt: 7 * way))
        case .eat: return (way, M.Pose(size: 1.12))
        case .wipe: return (way, M.Pose(tilt: 12 * way, gy: 4, lid: 0.3))
        case .kick: return (1, M.Pose(gy: 3, size: 1.08))
        case .stomp: return (0, M.Pose(gy: 5))
        case .fall: return (0, M.Pose(gy: -4, size: 1.22))
        case .lift, .drop: return (1, M.Pose(gy: -5))
        case .carry: return (way, M.Pose(tilt: 6 * way, gy: -5))
        case .rest: return (0, M.Pose())
        }
    }
}
