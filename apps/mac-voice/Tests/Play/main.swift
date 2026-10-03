// Tests for play mode (#505): the letters of a word, the play made for a
// seed, where the character is, what is gone and what has moved at each
// moment.
// Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias P = PlayMath

/// A line of words 8 points a letter and 18 tall, a space between them.
func line(_ text: String, x: Double, y: Double) -> P.Line {
    var words: [P.Word] = [], at = x
    for w in text.split(separator: " ") {
        words.append(P.Word(text: String(w), rect: P.Rect(x: at, y: y, w: Double(w.count) * 8, h: 18)))
        at += Double(w.count + 1) * 8
    }
    return P.Line(words: words, rect: P.Rect(x: x, y: y, w: at - 8 - x, h: 18))
}

let page = [
    line("File Edit View", x: 60, y: 4),
    line("The quick brown fox jumps over them", x: 400, y: 440),
    line("the lazy dog and runs away", x: 400, y: 470),
    line("into the woods before night", x: 400, y: 500),
    line("Far away in another column", x: 1000, y: 472),
    line("Alone", x: 400, y: 700),
]
let start = P.Point(x: 1300, y: 860)

// --- The screens changed (#586) ---

let built = P.Rect(x: 0, y: 0, w: 1440, h: 900), second = P.Rect(x: 1440, y: 0, w: 1920, h: 1080)
check(!P.gone(built, from: [built, second]) && !P.gone(built, from: [built]),
      "a change that leaves the play's screen as it was does not end the play")
check(P.gone(built, from: [second]) && P.gone(built, from: []), "the play's screen unplugged ends it")
check(P.gone(built, from: [P.Rect(x: 0, y: 0, w: 1680, h: 1050), second]), "the play's screen resized ends it")
check(P.gone(second, from: [built, P.Rect(x: -1920, y: 0, w: 1920, h: 1080)]), "the play's screen moved ends it")

// --- Letters and the page's colour ---

let fox = P.Word(text: "brown", rect: P.Rect(x: 100, y: 50, w: 50, h: 18))
let letters = P.letters(of: fox)
check(letters.count == 5 && letters[0].x == 100 && letters[4].maxX == 150 && letters.allSatisfy { $0.w == 10 && $0.h == 18 },
      "a word's letters are its rectangle cut in equal parts")
check(P.letters(of: P.Word(text: "", rect: fox.rect)).count == 1, "a word read as empty is still one piece")
check(P.common([0xFFFFFF, 0x202020, 0xFEFEFE, 0xFFFFFF, 0x808080]) == 0xFFFFFF, "the page's colour is the one most samples share")
check(P.common([0x101010, 0xFAFBFC, 0xFBFCFD, 0xF8F9FA]) == 0xFAFBFC, "close shades count as one colour")
check(P.common([]) == nil, "no samples, no colour")

// --- A play for each seed ---

let size = P.Point(x: 1440, y: 900)
func script(_ seed: UInt64, _ lines: [P.Line] = page) -> [P.Step] { P.script(lines, width: size.x, height: size.y, seed: seed) }
/// The lines a step plays on.
func named(_ step: P.Step) -> [Int] {
    switch step {
    case .jump(let i), .walk(let i), .wipe(let i), .stomp(let i), .eat(let i, _), .kick(let i, _): return [i]
    case .carry(let i, _, let j): return [i, j]
    case .rest, .home: return []
    }
}
let scripts = (0..<200).map { script(UInt64($0)) }
check(script(7) == script(7), "the same seed gives the same play")
check(Set(scripts.map { "\($0)" }).count > 50, "and other seeds give other plays")
check(scripts.allSatisfy { $0.count == 8 && $0[0] == .jump(line: named($0[0])[0]) && $0[1] == .walk(line: named($0[0])[0]) && Array($0[5...]) == [.rest(0.6), .home, .rest(0.3)] },
      "it jumps onto a line, walks it, plays on the three others, rests and goes home")
check(scripts.allSatisfy { s in Set(s.dropFirst(2).dropLast(3).map { "\($0)".prefix(4) }).count == 3 }, "never the same thing twice in a play")
check(scripts.allSatisfy { s in Set(s.dropFirst(2).dropLast(3).map { named($0)[0] }).count == 3 && !s.dropFirst(2).dropLast(3).contains { named($0)[0] == named(s[0])[0] } },
      "one thing a line, and the line it walked stays whole")
check(scripts.allSatisfy { $0.allSatisfy { named($0).allSatisfy { $0 >= 1 && $0 <= 4 } } }, "the menu bar and a line of one word are left alone")
for act in ["eat", "wipe", "kick", "stomp", "carry"] {
    check(scripts.contains { $0.contains { "\($0)".hasPrefix(act) } }, "some plays \(act)")
}
let alone = (0..<50).map { script(UInt64($0), [page[1]]) }
check(alone.allSatisfy { $0.count == 6 && named($0[2]) == [0] } && !alone.contains { $0.contains { "\($0)".hasPrefix("carry") } },
      "with one line it walks it and plays on it, and carries nothing")
check(script(1, [page[0], page[5]]).isEmpty, "with no line to stand on there is no script")

// --- The page decides (#580) ---

check(Set(scripts.map { named($0[0])[0] }).count == 4, "with no heading it walks any of the lines near the middle")
var titled = page
titled.append(P.Line(words: [P.Word(text: "Release", rect: P.Rect(x: 400, y: 380, w: 120, h: 30)), P.Word(text: "notes", rect: P.Rect(x: 530, y: 380, w: 90, h: 30))],
                     rect: P.Rect(x: 400, y: 380, w: 220, h: 30)))
check((0..<50).allSatisfy { script(UInt64($0), titled)[0] == .jump(line: 6) }, "a line clearly taller than the others is the heading: it walks that one")
/// The line an act of this name took, and the lines still whole then.
func took(_ s: [P.Step], _ act: String) -> (line: Int, free: [Int])? {
    guard let k = s.firstIndex(where: { "\($0)".hasPrefix(act) }) else { return nil }
    let taken = Set(s[..<k].map { named($0)[0] })
    return (named(s[k])[0], (1...4).filter { !taken.contains($0) })
}
check(scripts.allSatisfy { s in took(s, "wipe").map { t in t.free.allSatisfy { page[$0].rect.w <= page[t.line].rect.w } } ?? true },
      "the wipe takes the widest line still whole")
check(scripts.allSatisfy { s in took(s, "stomp").map { t in t.free.allSatisfy { page[$0].words.count <= page[t.line].words.count } } ?? true },
      "the stomp the one with the most words")
check(scripts.allSatisfy { $0.allSatisfy { if case .kick(let i, let w) = $0 { return page[i].words[w].text.count == page[i].words.map(\.text.count).max() } else { return true } } },
      "a kick takes the longest word of its line")

// --- It shrinks into the play and grows out of it (#580) ---

let whole = Play(lines: page, steps: script(3), start: start, size: size)
let all = stride(from: 0.0, through: whole.duration + 0.5, by: 1.0 / 30).map { whole.frame(at: $0) }
let leap = whole.moves[0], back = whole.moves[whole.back!]
check(all.first!.scale == P.edge && all.first!.at == start, "it starts where it stood on its edge, as big as there")
check(all.filter { $0.t <= leap.start + PlayMotion.crouch }.allSatisfy { $0.scale == P.edge }, "still that big while it crouches")
check(all.filter { $0.t >= leap.end - PlayMotion.landing && $0.t <= back.start }.allSatisfy { $0.scale == 1 }, "it has its play size from its first landing to its last jump")
check(back.to == start && whole.moves.last!.kind == .rest && all.filter { $0.t >= back.end - PlayMotion.landing }.allSatisfy { $0.scale == P.edge },
      "it jumps back to where it stood and lands as big as it left")
check(all.last!.at == start && all.last!.face == 0 && all.last!.pose == CharacterMath.Pose(), "and ends there, facing you, as it stands on its edge")
check(zip(all, all.dropFirst()).allSatisfy { abs($0.scale - $1.scale) < 0.05 }, "its size never changes at once")
check(Play(lines: page, steps: [.jump(line: 1), .home], start: start, size: size).back == 1 && Play(lines: page, steps: [.home], start: start, size: size).moves.isEmpty,
      "going home from home is no move")

// --- The script in time ---

let demo: [P.Step] = [.jump(line: 1), .walk(line: 1), .eat(line: 2, words: 0..<3), .wipe(line: 3), .rest(1.2)]
let play = Play(lines: page, steps: demo, start: start, size: size)
/// Every frame at 30 a second, to the end and a little after.
let frames = stride(from: 0.0, through: play.duration + 0.5, by: 1.0 / 30).map { play.frame(at: $0) }
func during(_ kind: Play.Kind) -> [Play.Frame] {
    guard let m = play.moves.first(where: { $0.kind == kind }) else { return [] }
    return frames.filter { $0.t >= m.start && $0.t <= m.end }
}

check(play.moves.map(\.kind) == [.jump, .walk, .jump, .eat, .jump, .wipe, .rest], "it jumps to each line before it plays on it")
check(frames.first!.at == start, "it starts from where it stood")
check(Play(lines: page, steps: [.walk(line: 9), .eat(line: 1, words: 4..<9), .kick(line: 1, word: 9), .carry(line: 1, word: 0, to: 1), .stomp(line: 9), .rest(0.5)], start: start, size: size).moves.map(\.kind) == [.rest],
      "a step that names a line or a word that is not there is skipped")
check(Play(lines: [], steps: [], start: start, size: size).frame(at: 0).done, "an empty script is over at once")

let walk = during(.walk)
check(walk.allSatisfy { $0.at.y == 440 }, "walking, its feet stay on the top of the line")
check(zip(walk, walk.dropFirst()).allSatisfy { $0.at.x <= $1.at.x } && walk.first!.at.x < 410 && walk.last!.at.x > 660,
      "and it goes from the start of the line to its end")
check(walk.dropFirst(8).allSatisfy { $0.face == 1 }, "turned the way it goes")

let hop = play.moves[2]
let air = frames.filter { $0.t > hop.start && $0.t < hop.end }
check(air.map(\.at.y).min()! < min(hop.from.y, hop.to.y) - 20, "a jump rises above both lines")
check(play.frame(at: hop.end).at == hop.to, "and lands where the next move starts")
check(frames.allSatisfy { $0.at.y - P.top >= 0 && $0.at.y <= 900 && $0.at.x >= 0 && $0.at.x <= 1440 }, "it never leaves the picture")

/// How many letters of the second line are covered in a frame.
func eaten(_ f: Play.Frame) -> Int { Int((f.gone.filter { $0.rect.y < 480 && $0.rect.y > 460 }.reduce(0) { $0 + $1.rect.w - 2 } / 8).rounded()) }
let eat = during(.eat)
check(eaten(eat.first!) == 0 && eaten(eat.last!) == 10, "eating starts with every letter there and ends with the three words gone")
check(zip(eat, eat.dropFirst()).allSatisfy { eaten($1) - eaten($0) >= 0 && eaten($1) - eaten($0) <= 1 }, "one letter at a time, never one back")
let midEat = eat[eat.count / 2]
check(midEat.gone.allSatisfy { $0.rect.maxX <= midEat.at.x + P.mouth + 1 }, "only what its mouth has passed is gone")
check(eat.allSatisfy { abs($0.at.y - P.middle - 479) < 0.001 }, "it goes through the line, its middle on the letters")
check(frames.last!.gone.allSatisfy { $0.rect.maxX <= 400 + 12 * 8 + 1 || $0.rect.y > 490 }, "the words it was not asked to eat stay")

let wipe = during(.wipe)
func wiped(_ f: Play.Frame) -> Double { f.gone.filter { $0.rect.y > 490 }.map(\.rect.w).max() ?? 0 }
check(zip(wipe, wipe.dropFirst()).allSatisfy { wiped($0) <= wiped($1) }, "a wipe only grows")
check(wipe.dropFirst().dropLast().allSatisfy { $0.cloth != nil } && frames.last!.cloth == nil, "the cloth shows while it wipes, and not after")
check(abs(wiped(frames.last!) - (page[3].rect.w + 2)) < 0.001, "and the whole line is wiped at the end")
check(frames.last!.gone.allSatisfy { $0.paper == 0xFFFFFF }, "what is gone is covered in the page's colour")

// --- Nothing snaps, and it ends ---

var step = 0.0, turn = 0.0, stretch = 0.0
for (a, b) in zip(frames, frames.dropFirst()) {
    step = max(step, hypot(a.at.x - b.at.x, a.at.y - b.at.y))
    turn = max(turn, abs(a.face - b.face), abs(a.pose.tilt - b.pose.tilt) / 20)
    stretch = max(stretch, abs(a.pose.sx - b.pose.sx), abs(a.pose.sy - b.pose.sy))
}
check(step < 45, "it never moves more than a body's width between two frames")
// A landing is its fastest change of shape: from stretched to squashed
// (0.34) in three frames.
check(turn < 0.6 && stretch < 0.2, "and its face and body turn and stretch without a snap")
check(!play.frame(at: play.duration - 0.1).done && play.frame(at: play.duration).done, "the script is done when its last move ends")
check(play.frame(at: play.duration + 5).at == play.moves.last!.to && frames.last!.face == 0, "and it stays there, facing you")
check(play.duration > 6 && play.duration < 20, "a script of four moves lasts a few seconds")

// --- Kicking, stomping, carrying ---

func frames(of p: Play) -> [Play.Frame] { stride(from: 0.0, through: p.duration + 2, by: 1.0 / 30).map { p.frame(at: $0) } }
func move(_ p: Play, _ kind: Play.Kind) -> Play.Move { p.moves.first { $0.kind == kind }! }

let kick = Play(lines: page, steps: [.kick(line: 1, word: 2), .rest(2)], start: start, size: size)
let kicked = frames(of: kick), hit = move(kick, .kick).start + 0.25
check(kicked.filter { $0.t < hit }.allSatisfy { $0.pieces.isEmpty && $0.gone.isEmpty }, "before the kick lands, the word is in its place")
let allGone = hit + PlayMotion.stagger(4, of: 5)
check(kicked.filter { $0.t >= allGone }.allSatisfy { $0.pieces.count == 5 && $0.gone.count == 5 }, "after it, each of its five letters is a piece, and its place is covered")
let leaving = kicked.filter { $0.t >= hit && $0.t < allGone }.map(\.pieces.count)
check(leaving.first == 1 && leaving == leaving.sorted() && Set(leaving).count > 2 && kicked.first { $0.t >= hit }!.pieces[0].from == P.letters(of: page[1].words[2])[0],
      "the letters leave one after the other, the nearest first")
check(kicked.last!.pieces.map(\.from) == P.letters(of: page[1].words[2]), "the pieces are the letters of that word")
// Only the ink of a piece moves: the page's colour around it is left
// out, or a flying letter would cover the text it passes with a box.
var tinted = page
tinted[1].paper = 0x1E1E1E
let onDark = frames(of: Play(lines: tinted, steps: [.kick(line: 1, word: 2), .carry(line: 1, word: 0, to: 0), .rest(2)], start: start, size: size))
check(kicked.last!.pieces.allSatisfy { $0.paper == 0xFFFFFF } && onDark.last!.pieces.count == 6 && onDark.last!.pieces.allSatisfy { $0.paper == 0x1E1E1E },
      "a piece knows the colour of the page it was cut from, kicked or carried")
check(P.ink(r: 255, g: 255, b: 255, paper: 0xFFFFFF) == 0 && P.ink(r: 250, g: 252, b: 249, paper: 0xFFFFFF) == 0,
      "the page's colour, and what is next to it, is not drawn")
check(P.ink(r: 0, g: 0, b: 0, paper: 0xFFFFFF) == 1 && P.ink(r: 230, g: 230, b: 230, paper: 0x1E1E1E) == 1 && P.ink(r: 255, g: 40, b: 255, paper: 0xFFFFFF) == 1,
      "ink is drawn in full, dark on light, light on dark, or a colour")
let soft = P.ink(r: 225, g: 225, b: 225, paper: 0xFFFFFF)
check(soft > 0 && soft < 1, "and the soft edge of a letter in part")
let air1 = kicked.first { $0.t >= hit + 0.2 }!
check(air1.pieces.allSatisfy { $0.at.y < 440 && $0.at.x > $0.from.x && $0.turn != 0 }, "they fly up and away, turning")
check(kicked.last!.pieces.allSatisfy { $0.at.y + 18 <= 900 && $0.at.y + 18 > 880 && $0.at.x >= 0 && $0.at.x + 8 <= 1440 }, "and come to rest on the bottom of the picture")
check(kicked.last!.pieces == kicked[kicked.count - 20].pieces, "where they stay")
check(kicked.last!.pieces.allSatisfy { abs(sin($0.turn)) < 1e-9 }, "lying flat")
check(Set(kicked.last!.pieces.map(\.at.y)).count > 1, "not all at one height: a pile")

let stomp = Play(lines: page, steps: [.stomp(line: 2), .rest(1)], start: start, size: size)
let stomped = frames(of: stomp), hops = move(stomp, .stomp), fall = move(stomp, .fall)
check(stomped.filter { $0.t <= hops.start + 0.3 }.allSatisfy { $0.pieces.isEmpty }, "the first hop drops nothing")
let dropping = stomped.filter { $0.t >= hops.start && $0.t <= hops.end }.map(\.pieces.count)
check(zip(dropping, dropping.dropFirst()).allSatisfy { $1 - $0 >= 0 && $1 - $0 <= 1 } && dropping.last == 6, "then the words drop one at a time, all six")
check(stomped.filter { $0.t > hops.start && $0.t < hops.end }.contains { $0.at.y < 470 - 15 }, "it hops on the line")
check(fall.to.y == 894 && stomped.last!.at.y == 894, "and falls to the bottom after them")
let falling = stomped.filter { $0.t >= fall.start && $0.t <= fall.end }.map(\.at.y)
check(zip(falling, falling.dropFirst()).allSatisfy { $0 <= $1 }, "never back up")

let carry = Play(lines: page, steps: [.carry(line: 3, word: 2, to: 1), .rest(1)], start: start, size: size)
let carried = frames(of: carry), up = move(carry, .lift), over = move(carry, .carry), down = move(carry, .drop)
let woods = page[3].words[2].rect
check(carried.filter { $0.t < up.start }.allSatisfy { $0.pieces.isEmpty }, "a word stays until it is lifted")
check(carried.filter { $0.t > over.start && $0.t < over.end }.allSatisfy { f in
    f.pieces.count == 1 && abs(f.pieces[0].at.x + woods.w / 2 - f.at.x) < 0.001 && abs(f.pieces[0].at.y + woods.h + P.top - f.at.y) < 0.001
}, "carried, it is above the character's head")
check(carried.last!.pieces == [P.Piece(from: woods, at: P.Point(x: page[1].rect.maxX + 8, y: 440))], "and it is put down after the other line, upright")
check(carried.last!.gone.count == 1 && carried.last!.gone[0].rect.x == woods.x - 1, "its old place is covered")
let edge = [line("ends at the edge of this page", x: 1440 - 29 * 8, y: 300), page[3]]
check(Play(lines: edge, steps: [.carry(line: 1, word: 0, to: 0)], start: start, size: size).frame(at: 99).pieces[0].at
      == P.Point(x: 1440 - 4 * 8, y: 300 - 18 - 2), "with no room after the line, on top of its end")
check(over.to == P.Point(x: page[1].rect.maxX - 4, y: 440) && down.start == over.end, "it stands on the end of that line to put it down")

// --- Any play stays in the picture and does not snap ---

var worst = 0.0, out = 0, long = 0.0
for s in scripts.prefix(60) {
    let p = Play(lines: page, steps: s, start: start, size: size), fs = frames(of: p)
    long = max(long, p.duration)
    for (a, b) in zip(fs, fs.dropFirst()) { worst = max(worst, hypot(a.at.x - b.at.x, a.at.y - b.at.y)) }
    for f in fs {
        if f.at.y - P.top < 0 || f.at.y > 900 || f.at.x < 0 || f.at.x > 1440 { out += 1 }
        for piece in f.pieces {
            let right: Double = piece.at.x + piece.from.w, bottom: Double = piece.at.y + piece.from.h
            if piece.at.x < 0 || right > 1440.001 || bottom > 900.001 { out += 1 }
        }
    }
}
check(out == 0, "in sixty plays, neither it nor a piece leaves the picture")
check(worst < 45, "and it never moves more than a body's width between two frames")
check(long < 30, "the longest lasts under half a minute")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
