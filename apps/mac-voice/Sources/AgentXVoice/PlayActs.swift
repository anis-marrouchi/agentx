import Foundation

/// Play mode past the first script (#505): pieces of the picture that
/// move (a kicked letter, a word that falls, a word carried away), and a
/// different play each time. Numbers only, like `PlayMath`.
extension PlayMath {
    /// A piece cut out of the picture and drawn somewhere else: which
    /// part of the picture, where its top-left corner is now, how far it
    /// has turned (radians), and the page's colour around it, which is
    /// left out so only its ink moves.
    struct Piece: Equatable {
        var from: Rect
        var at: Point
        var turn = 0.0
        var paper: UInt32 = 0xFFFFFF
    }

    /// How much of a pixel of a moved piece is drawn, 0…1: none of the
    /// page's colour, all of the ink, and the soft edge of a letter in
    /// between. Without it a flying letter carries a box of page with it
    /// and covers the text it passes.
    static func ink(r: UInt8, g: UInt8, b: UInt8, paper: UInt32) -> Double {
        let far = max(abs(Int(r) - Int(paper >> 16 & 0xFF)), abs(Int(g) - Int(paper >> 8 & 0xFF)), abs(Int(b) - Int(paper & 0xFF)))
        return min(max(Double(far - 10) / 40, 0), 1)
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

    /// A word's letters: the word's rectangle cut into equal parts, one a
    /// character. An estimate, close enough to take them one at a time.
    static func letters(of word: Word) -> [Rect] {
        let n = max(word.text.count, 1), w = word.rect.w / Double(n)
        return (0..<n).map { Rect(x: word.rect.x + Double($0) * w, y: word.rect.y, w: w, h: word.rect.h) }
    }

    /// The colour most of `samples` share: the page around a line. Close
    /// shades count as one, so the soft edge of a letter does not win.
    static func common(_ samples: [UInt32]) -> UInt32? {
        var count: [UInt32: Int] = [:]
        for s in samples { count[s & 0xF8F8F8, default: 0] += 1 }
        guard let best = count.max(by: { ($0.value, $0.key) < ($1.value, $1.key) })?.key else { return nil }
        return samples.first { $0 & 0xF8F8F8 == best }
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

    /// A play, different for each page and each seed. It jumps onto the
    /// page's heading, the line clearly taller than the others, or with
    /// no heading onto one of the lines near the middle, and walks it.
    /// Then it does one thing to each of up to four others, never the same
    /// thing twice, and each thing to the line that suits it (`suits`).
    /// Then it goes home. Lines too close to the top to stand on, too
    /// short or of one word are left alone.
    static func script(_ lines: [Line], width: Double, height: Double, seed: UInt64) -> [Step] {
        var rng = Seeded(seed)
        let fit = lines.indices.filter { lines[$0].words.count >= 2 && lines[$0].rect.w >= 120 && lines[$0].rect.y >= top + 40 }
        func far(_ i: Int) -> Double { hypot(lines[i].rect.midX - width / 2, lines[i].rect.midY - height / 2) }
        var near = Array(fit.sorted { far($0) < far($1) }.prefix(8))
        let usual = fit.map { lines[$0].rect.h }.sorted()[safe: fit.count / 2] ?? 0
        let heading = fit.filter { lines[$0].rect.h >= usual * 1.4 }.max { lines[$0].rect.h < lines[$1].rect.h }
        guard let first = heading ?? near.randomElement(using: &rng) else { return [] }
        near.removeAll { $0 == first }
        var steps: [Step] = [.jump(line: first), .walk(line: first)]
        // With one line only, it plays on the line it walked.
        if near.isEmpty { near = [first] }
        for act in Act.allCases.shuffled(using: &rng).prefix(4) {
            let luck = near.map { _ in Double.random(in: 0..<1, using: &rng) }
            guard let k = near.indices.max(by: { suits(act, lines[near[$0]], luck[$0]) < suits(act, lines[near[$1]], luck[$1]) }) else { break }
            let i = near.remove(at: k), words = lines[i].words
            let n = words.count, word = Int.random(in: 0..<n, using: &rng)
            switch act {
            case .eat:
                let from = Int.random(in: 0..<n - 1, using: &rng)
                steps.append(.eat(line: i, words: from..<min(from + 3, n)))
            case .wipe: steps.append(.wipe(line: i))
            case .stomp: steps.append(.stomp(line: i))
            // The walked line is whole: the word goes to its end.
            case .carry where i != first: steps.append(.carry(line: i, word: word, to: first))
            // Its longest word: the most letters to fly.
            case .kick, .carry: steps.append(.kick(line: i, word: words.indices.max { words[$0].text.count < words[$1].text.count } ?? word))
            }
        }
        return steps + [.rest(0.6), .home, .rest(0.3)]
    }

    /// How well a line suits an act, the page deciding what happens
    /// where (#580): the widest line is wiped, the one with the most words
    /// stomped, the one with the longest word kicked, the shortest gives
    /// the word that is carried. Any line can be eaten: `luck` decides.
    static func suits(_ act: Act, _ line: Line, _ luck: Double) -> Double {
        switch act {
        case .wipe: return line.rect.w
        case .stomp: return Double(line.words.count)
        case .kick: return Double(line.words.map(\.text.count).max() ?? 0)
        case .carry: return -line.rect.w
        case .eat: return luck
        }
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

extension Play {
    /// Its size at `t`, in play sizes (#580): as big as on its edge when
    /// it leaves it and when it is back, shrinking in the air of its
    /// first jump and growing in the air of its last. It never changes
    /// size at once.
    func scale(at t: Double) -> Double {
        func air(_ m: Move) -> Double { M.ease(M.span(t, m.start + Mo.crouch, m.end - Mo.landing)) }
        if let back, t >= moves[back].start { return 1 + (P.edge - 1) * air(moves[back]) }
        guard let first = moves.first, first.kind == .jump, back != 0 else { return 1 }
        return P.edge - (P.edge - 1) * air(first)
    }

    /// The pieces that have left their place by this frame: each place is
    /// covered, and the piece is drawn where it is now.
    func move(_ f: inout Frame) {
        for cut in cuts where cut.start <= f.t {
            f.gone.append((cover(cut.source), cut.paper))
            switch cut.path {
            case .thrown(let v, let spin, let rise):
                var piece = P.thrown(cut.source, v: v, spin: spin, rise: rise, after: f.t - cut.start, width: size.x, height: size.y)
                piece.paper = cut.paper
                f.pieces.append(piece)
            case .held(let until, let to):
                // From its place to above the head, and from there down.
                let head = P.Point(x: f.at.x - cut.source.w / 2, y: f.at.y - P.top - cut.source.h)
                let a = f.t < until ? P.Point(x: cut.source.x, y: cut.source.y) : head, b = f.t < until ? head : to
                let q = M.ease(f.t < until ? M.span(f.t, cut.start, cut.start + P.lift) : M.span(f.t, until, until + P.lift))
                f.pieces.append(P.Piece(from: cut.source, at: P.Point(x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q), paper: cut.paper))
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
