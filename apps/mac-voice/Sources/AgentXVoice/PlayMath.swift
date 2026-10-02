import Foundation

/// Play mode (#505): the character leaves the bottom edge and plays on a
/// frozen picture of the screen. It walks along a line of text as on a
/// floor, jumps to another line, eats words, wipes a line, kicks a word,
/// stomps a line down and carries a word away. These are the numbers only: where the words are, what it does and when, where it
/// is at a given moment and which letters are gone. Foundation only, so
/// the tests can run it without a window.
///
/// Everything is in the picture's points, origin top-left, y downwards.
enum PlayMath {
    typealias M = CharacterMath

    struct Point: Equatable { var x = 0.0, y = 0.0 }

    struct Rect: Equatable {
        var x = 0.0, y = 0.0, w = 0.0, h = 0.0
        var maxX: Double { x + w }
        var maxY: Double { y + h }
        var midX: Double { x + w / 2 }
        var midY: Double { y + h / 2 }
    }

    struct Word: Equatable {
        var text: String
        var rect: Rect
    }

    /// One line of text as it was read, left to right, and the colour of
    /// the page around it (0xRRGGBB): what shows where a word is gone.
    struct Line: Equatable {
        var words: [Word]
        var rect: Rect
        var paper: UInt32 = 0xFFFFFF
    }

    /// One move of a script.
    enum Step: Equatable {
        /// Jump onto the start of a line.
        case jump(line: Int)
        /// Walk along the top of a line to its end.
        case walk(line: Int)
        /// Go through a line and eat these words, letter by letter.
        case eat(line: Int, words: Range<Int>)
        /// Wipe a whole line with a cloth.
        case wipe(line: Int)
        /// Kick a word: its letters fly and pile up at the bottom.
        case kick(line: Int, word: Int)
        /// Hop on a line until its words drop, and fall after them.
        case stomp(line: Int)
        /// Lift a word, carry it to the end of another line, put it down.
        case carry(line: Int, word: Int, to: Int)
        /// Stand still, facing you, for so many seconds.
        case rest(Double)
    }

    /// Points per drawing unit on the page: a body 40 points across,
    /// smaller than on the bottom edge so it fits between lines.
    static let unit = 0.4
    /// The middle of its body above its feet, and its top, in points.
    static let middle = (M.Pose().lift + 50) * unit
    static let top = (M.Pose().lift + 100) * unit + 8
    /// Points a second, and seconds a letter.
    static let walkSpeed = 220.0
    static let wipeSpeed = 260.0
    static let perLetter = 0.09
    /// Its mouth, ahead of its middle.
    static let mouth = 10.0

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
}

/// A script laid out in time: every move has its start and its end, so
/// where the character is, and what is gone, depends on the time alone.
/// The same script gives the same frames on every run.
struct Play {
    typealias P = PlayMath
    typealias M = CharacterMath
    typealias Mo = PlayMotion

    enum Kind { case jump, walk, eat, wipe, kick, stomp, fall, lift, carry, drop, rest }

    struct Move {
        var kind: Kind
        var from, to: P.Point
        var start, duration: Double
        var line = 0
        var words = 0..<0
        var end: Double { start + duration }
    }

    struct Frame {
        /// Its feet.
        var at = P.Point()
        /// -1 turned left, 0 facing you, 1 turned right.
        var face = 0.0
        var pose = M.Pose()
        var t = 0.0
        /// What is covered with the page's colour, and which colour.
        var gone: [(rect: P.Rect, paper: UInt32)] = []
        /// The cloth, while it wipes.
        var cloth: P.Rect?
        /// What was kicked, dropped or carried, where it is now.
        var pieces: [P.Piece] = []
        var done = false
    }

    let lines: [P.Line]
    /// The picture's width and height: where a thrown piece stops.
    let size: P.Point
    private(set) var moves: [Move] = []
    private(set) var cuts: [P.Cut] = []
    var duration: Double { moves.last?.end ?? 0 }

    /// `start` is where its feet are when play begins. Steps that name a
    /// line or a word that is not there are skipped.
    init(lines: [P.Line], steps: [P.Step], start: P.Point, size: P.Point) {
        self.lines = lines
        self.size = size
        var at = start, now = 0.0
        /// The seconds of a jump over `points`: its crouch, its time in
        /// the air and its landing.
        func leap(_ points: Double) -> Double { Mo.crouch + 0.34 + points / 900 + Mo.landing }
        func add(_ kind: Kind, to: P.Point, _ seconds: Double, line: Int = 0, words: Range<Int> = 0..<0) -> Move {
            Move(kind: kind, from: at, to: to, start: now, duration: seconds, line: line, words: words)
        }
        /// Get to `to` first: a jump, unless it is already there.
        func reach(_ to: P.Point, into list: inout [Move]) {
            guard at != to else { return }
            let m = add(.jump, to: to, leap(hypot(to.x - at.x, to.y - at.y)))
            list.append(m); at = to; now = m.end
        }
        var list: [Move] = [], cuts: [P.Cut] = []
        /// A move on the spot.
        func stay(_ kind: Kind, _ seconds: Double, line: Int) -> Move {
            let m = add(kind, to: at, seconds, line: line)
            list.append(m); now = m.end
            return m
        }
        /// A piece falls: each one a little higher on the pile.
        func throwing(_ source: P.Rect, line: Int, at start: Double, v: P.Point, spin: Double) {
            cuts.append(P.Cut(source: source, paper: lines[line].paper, start: start,
                              path: .thrown(v: v, spin: spin, rise: Double(cuts.count % 4) * 4)))
        }
        for step in steps {
            switch step {
            case .jump(let i):
                guard lines.indices.contains(i) else { continue }
                reach(P.Point(x: lines[i].rect.x, y: lines[i].rect.y), into: &list)
            case .walk(let i):
                guard lines.indices.contains(i) else { continue }
                let r = lines[i].rect
                if at.y != r.y || at.x < r.x || at.x > r.maxX { reach(P.Point(x: r.x, y: r.y), into: &list) }
                let m = add(.walk, to: P.Point(x: r.maxX, y: r.y), (r.maxX - at.x) / P.walkSpeed, line: i)
                list.append(m); at = m.to; now = m.end
            case .eat(let i, let words):
                guard lines.indices.contains(i), !words.isEmpty, words.upperBound <= lines[i].words.count else { continue }
                // In the line, its middle at the middle of the letters.
                let y = lines[i].rect.midY + P.middle
                let first = lines[i].words[words.lowerBound].rect, last = lines[i].words[words.upperBound - 1].rect
                reach(P.Point(x: first.x - P.mouth - 4, y: y), into: &list)
                let count = lines[i].words[words].reduce(0) { $0 + max($1.text.count, 1) }
                let m = add(.eat, to: P.Point(x: last.maxX, y: y), Double(count) * P.perLetter, line: i, words: words)
                list.append(m); at = m.to; now = m.end
            case .wipe(let i):
                guard lines.indices.contains(i) else { continue }
                let r = lines[i].rect
                reach(P.Point(x: r.x, y: r.y), into: &list)
                let m = add(.wipe, to: P.Point(x: r.maxX, y: r.y), r.w / P.wipeSpeed, line: i)
                list.append(m); at = m.to; now = m.end
            case .kick(let i, let w):
                guard lines.indices.contains(i), lines[i].words.indices.contains(w) else { continue }
                let word = lines[i].words[w]
                reach(P.Point(x: word.rect.x - P.mouth - 4, y: lines[i].rect.midY + P.middle), into: &list)
                let m = stay(.kick, 0.6, line: i)
                // The letters leave one after the other, the nearest first.
                let letters = P.letters(of: word)
                for (k, letter) in letters.enumerated() {
                    throwing(letter, line: i, at: m.start + 0.25 + Mo.stagger(k, of: letters.count), v: P.Point(x: 150 + 40 * Double(k), y: -320 - 30 * Double(k % 3)),
                             spin: 4 + Double(k % 3))
                }
            case .stomp(let i):
                guard lines.indices.contains(i) else { continue }
                let r = lines[i].rect
                reach(P.Point(x: r.midX, y: r.y), into: &list)
                let m = stay(.stomp, 1.2, line: i)
                for (k, word) in lines[i].words.enumerated() {
                    let side: Double = k % 2 == 0 ? -1 : 1
                    throwing(word.rect, line: i, at: m.start + 0.4 + 0.8 * Double(k) / Double(lines[i].words.count),
                             v: P.Point(x: 50 * side, y: -90), spin: 5 * side)
                }
                // Its floor is gone: it falls after the words, slowly
                // enough to follow with the eye.
                let floor = P.Point(x: at.x, y: max(size.y - 6, at.y)), drop = floor.y - at.y
                let fall = add(.fall, to: floor, max((2 * drop / P.gravity).squareRoot(), drop / 600), line: i)
                list.append(fall); at = floor; now = fall.end
            case .carry(let i, let w, let j):
                guard lines.indices.contains(i), lines[i].words.indices.contains(w), lines.indices.contains(j), j != i else { continue }
                let word = lines[i].words[w].rect, home = lines[j].rect
                reach(P.Point(x: word.x - P.mouth - 4, y: lines[i].rect.midY + P.middle), into: &list)
                let up = stay(.lift, P.lift, line: i)
                let m = add(.carry, to: P.Point(x: home.maxX - 4, y: home.y), leap(hypot(home.maxX - 4 - at.x, home.y - at.y)), line: j)
                list.append(m); at = m.to; now = m.end
                let down = stay(.drop, P.lift, line: j)
                // After the line, or on top of its end when the page stops there.
                let after = home.maxX + 8 + word.w <= size.x
                let to = after ? P.Point(x: home.maxX + 8, y: home.midY - word.h / 2) : P.Point(x: home.maxX - word.w, y: home.y - word.h - 2)
                cuts.append(P.Cut(source: word, paper: lines[i].paper, start: up.start, path: .held(until: down.start, to: to)))
            case .rest(let seconds):
                let m = add(.rest, to: at, max(seconds, 0))
                list.append(m); now = m.end
            }
        }
        moves = list
        self.cuts = cuts
    }

    func frame(at t: Double) -> Frame {
        guard let i = moves.lastIndex(where: { $0.start <= t }) else { return Frame(done: true) }
        let m = moves[i], p = M.span(t, m.start, m.end)
        var f = Frame(t: t, done: t >= duration)

        let body = body(m, at: t)
        f.at = P.Point(x: m.from.x + (m.to.x - m.from.x) * body.travel, y: m.from.y + (m.to.y - m.from.y) * body.travel)
        switch m.kind {
        case .jump, .carry:
            // An arc over both ends, kept inside the picture.
            let rise = 30 + hypot(m.to.x - m.from.x, m.to.y - m.from.y) * 0.12
            f.at.y -= min(rise, max(min(m.from.y, m.to.y) - P.top, 0)) * body.air
        // Three hops on the spot.
        case .stomp: f.at.y -= min(22, max(m.from.y - P.top, 0)) * abs(sin(3 * .pi * p))
        // Faster and faster.
        case .fall: f.at.y = m.from.y + (m.to.y - m.from.y) * p * p
        default: break
        }

        // The look of this move, reached from the look of the one before
        // in a fifth of a second: the eyes and the body do not snap.
        let into = M.ease(M.span(t, m.start, m.start + 0.2))
        let before = i > 0 ? look(moves[i - 1]) : look(m)
        let now = look(m)
        f.face = before.face + (now.face - before.face) * into
        f.pose = M.blend(before.pose, now.pose, eyes: into, body: into, marks: into)
        switch m.kind {
        // A step every 50 points, smaller while it starts and stops.
        case .walk: f.pose.lift += 3 * body.speed * abs(sin(.pi * abs(f.at.x - m.from.x) / 50))
        case .jump, .carry:
            f.pose.sy *= body.sy; f.pose.sx *= body.sx
            f.pose.lift *= 1 - 0.5 * body.dip
        case .eat:
            let bite = into * (0.5 + 0.5 * sin(2 * .pi * t / P.perLetter))
            f.pose.sy *= 1 - 0.08 * bite; f.pose.sx *= 1 + 0.05 * bite
        case .wipe: f.pose.tilt += 5 * into * sin(2 * .pi * t * 5)
        // Leans back, then into the kick.
        case .kick: f.pose.tilt -= 14 * sin(2 * .pi * p)
        case .stomp: f.pose.sy *= 1 + into * (0.1 * abs(sin(3 * .pi * p)) - 0.05)
        case .fall: f.pose.sy *= 1 + 0.12 * p; f.pose.sx *= 1 - 0.08 * p
        case .lift, .drop, .rest: break
        }

        for done in moves[...i] {
            let x = done.end <= t ? done.to.x : f.at.x
            switch done.kind {
            case .eat:
                for word in lines[done.line].words[done.words] {
                    let gone = P.letters(of: word).filter { $0.maxX <= x + P.mouth }
                    guard let last = gone.last else { continue }
                    f.gone.append((cover(P.Rect(x: word.rect.x, y: word.rect.y, w: last.maxX - word.rect.x, h: word.rect.h)),
                                   lines[done.line].paper))
                }
            case .wipe:
                let r = lines[done.line].rect
                if x > r.x { f.gone.append((cover(P.Rect(x: r.x, y: r.y, w: min(x, r.maxX) - r.x, h: r.h)), lines[done.line].paper)) }
                if done.end > t { f.cloth = P.Rect(x: x - 9, y: r.y - 2, w: 18, h: r.h + 4) }
            default: break
            }
        }
        move(&f)
        return f
    }

    /// A little more than the letters, so nothing of them shows at the edges.
    func cover(_ r: P.Rect) -> P.Rect { P.Rect(x: r.x - 1, y: r.y - 2, w: r.w + 2, h: r.h + 4) }
}
