import Foundation

/// Play mode (#505): the character leaves the bottom edge and plays on a
/// frozen picture of the screen. It walks along a line of text as on a
/// floor, jumps to another line, eats words and wipes a line. These are
/// the numbers only: where the words are, what it does and when, where it
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

    /// The built-in script: the line nearest the middle of the page and
    /// the two under it in the same column. It walks the first, eats the
    /// start of the second and wipes the third. Lines too close to the top
    /// to stand on, too short or of one word are left alone.
    static func demo(_ lines: [Line], width: Double, height: Double) -> [Step] {
        let fit = lines.indices.filter { lines[$0].words.count >= 2 && lines[$0].rect.w >= 120 && lines[$0].rect.y >= top + 40 }
        func far(_ i: Int) -> Double { hypot(lines[i].rect.midX - width / 2, lines[i].rect.midY - height / 2) }
        guard let first = fit.min(by: { far($0) < far($1) }) else { return [] }
        let a = lines[first].rect
        let under = fit.filter { lines[$0].rect.y > a.y + a.h / 2 && lines[$0].rect.x < a.maxX && lines[$0].rect.maxX > a.x }
            .sorted { lines[$0].rect.y < lines[$1].rect.y }
        let picked = [first] + under.prefix(2)
        var steps: [Step] = [.jump(line: first), .walk(line: first)]
        if picked.count > 1 { steps += [.eat(line: picked[1], words: 0..<min(3, lines[picked[1]].words.count))] }
        else { steps += [.eat(line: first, words: 0..<min(2, lines[first].words.count))] }
        if picked.count > 2 { steps += [.wipe(line: picked[2])] }
        return steps + [.rest(1.2)]
    }
}

/// A script laid out in time: every move has its start and its end, so
/// where the character is, and what is gone, depends on the time alone.
/// The same script gives the same frames on every run.
struct Play {
    typealias P = PlayMath
    typealias M = CharacterMath

    enum Kind { case jump, walk, eat, wipe, rest }

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
        var done = false
    }

    let lines: [P.Line]
    private(set) var moves: [Move] = []
    var duration: Double { moves.last?.end ?? 0 }

    /// `start` is where its feet are when play begins. Steps that name a
    /// line or a word that is not there are skipped.
    init(lines: [P.Line], steps: [P.Step], start: P.Point) {
        self.lines = lines
        var at = start, now = 0.0
        func add(_ kind: Kind, to: P.Point, _ seconds: Double, line: Int = 0, words: Range<Int> = 0..<0) -> Move {
            Move(kind: kind, from: at, to: to, start: now, duration: seconds, line: line, words: words)
        }
        /// Get to `to` first: a jump, unless it is already there.
        func reach(_ to: P.Point, into list: inout [Move]) {
            guard at != to else { return }
            let m = add(.jump, to: to, 0.5 + hypot(to.x - at.x, to.y - at.y) / 900)
            list.append(m); at = to; now = m.end
        }
        var list: [Move] = []
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
            case .rest(let seconds):
                let m = add(.rest, to: at, max(seconds, 0))
                list.append(m); now = m.end
            }
        }
        moves = list
    }

    func frame(at t: Double) -> Frame {
        guard let i = moves.lastIndex(where: { $0.start <= t }) else { return Frame(done: true) }
        let m = moves[i], p = M.span(t, m.start, m.end)
        var f = Frame(t: t, done: t >= duration)

        f.at = P.Point(x: m.from.x + (m.to.x - m.from.x) * p, y: m.from.y + (m.to.y - m.from.y) * p)
        if m.kind == .jump {
            // An arc over both ends, kept inside the picture.
            let rise = 30 + hypot(m.to.x - m.from.x, m.to.y - m.from.y) * 0.12
            f.at.y -= min(rise, max(min(m.from.y, m.to.y) - P.top, 0)) * 4 * p * (1 - p)
        }

        // The look of this move, reached from the look of the one before
        // in a fifth of a second: the eyes and the body do not snap.
        let into = M.ease(M.span(t, m.start, m.start + 0.2))
        let before = i > 0 ? look(moves[i - 1]) : look(m)
        let now = look(m)
        f.face = before.face + (now.face - before.face) * into
        f.pose = M.blend(before.pose, now.pose, eyes: into, body: into, marks: into)
        switch m.kind {
        case .walk: f.pose.lift += 3 * into * abs(sin(2 * .pi * t * 2.2))
        case .jump:
            let air = sin(.pi * p)
            f.pose.sy *= 1 + 0.12 * air; f.pose.sx *= 1 - 0.08 * air
        case .eat:
            let bite = into * (0.5 + 0.5 * sin(2 * .pi * t / P.perLetter))
            f.pose.sy *= 1 - 0.08 * bite; f.pose.sx *= 1 + 0.05 * bite
        case .wipe: f.pose.tilt += 5 * into * sin(2 * .pi * t * 5)
        case .rest: break
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
        return f
    }

    /// A little more than the letters, so nothing of them shows at the edges.
    private func cover(_ r: P.Rect) -> P.Rect { P.Rect(x: r.x - 1, y: r.y - 2, w: r.w + 2, h: r.h + 4) }

    /// Which way it faces during a move, and its pose without the motion.
    private func look(_ m: Move) -> (face: Double, pose: M.Pose) {
        let way: Double = m.to.x >= m.from.x ? 1 : -1
        switch m.kind {
        case .jump: return (way, M.Pose(tilt: 6 * way, gy: -2))
        case .walk: return (way, M.Pose(tilt: 7 * way))
        case .eat: return (way, M.Pose(size: 1.12))
        case .wipe: return (way, M.Pose(tilt: 12 * way, gy: 4, lid: 0.3))
        case .rest: return (0, M.Pose())
        }
    }
}
