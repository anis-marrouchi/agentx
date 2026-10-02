// Tests for play mode (#505): the letters of a word, the built-in script,
// and where the character is and what is gone at each moment.
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

// --- Letters and the page's colour ---

let fox = P.Word(text: "brown", rect: P.Rect(x: 100, y: 50, w: 50, h: 18))
let letters = P.letters(of: fox)
check(letters.count == 5 && letters[0].x == 100 && letters[4].maxX == 150 && letters.allSatisfy { $0.w == 10 && $0.h == 18 },
      "a word's letters are its rectangle cut in equal parts")
check(P.letters(of: P.Word(text: "", rect: fox.rect)).count == 1, "a word read as empty is still one piece")
check(P.common([0xFFFFFF, 0x202020, 0xFEFEFE, 0xFFFFFF, 0x808080]) == 0xFFFFFF, "the page's colour is the one most samples share")
check(P.common([0x101010, 0xFAFBFC, 0xFBFCFD, 0xF8F9FA]) == 0xFAFBFC, "close shades count as one colour")
check(P.common([]) == nil, "no samples, no colour")

// --- The built-in script ---

let demo = P.demo(page, width: 1440, height: 900)
check(demo == [.jump(line: 1), .walk(line: 1), .eat(line: 2, words: 0..<3), .wipe(line: 3), .rest(1.2)],
      "the script takes the line nearest the middle and the two under it in its column")
check(!demo.contains(.walk(line: 0)) && !demo.contains(.wipe(line: 4)) && !demo.contains(.wipe(line: 5)),
      "the menu bar, another column and a line of one word are left alone")
check(P.demo([page[1]], width: 1440, height: 900) == [.jump(line: 0), .walk(line: 0), .eat(line: 0, words: 0..<2), .rest(1.2)],
      "with one line it walks it and eats its first words")
check(P.demo([page[0], page[5]], width: 1440, height: 900).isEmpty, "with no line to stand on there is no script")

// --- The script in time ---

let play = Play(lines: page, steps: demo, start: start)
/// Every frame at 30 a second, to the end and a little after.
let frames = stride(from: 0.0, through: play.duration + 0.5, by: 1.0 / 30).map { play.frame(at: $0) }
func during(_ kind: Play.Kind) -> [Play.Frame] {
    guard let m = play.moves.first(where: { $0.kind == kind }) else { return [] }
    return frames.filter { $0.t >= m.start && $0.t <= m.end }
}

check(play.moves.map(\.kind) == [.jump, .walk, .jump, .eat, .jump, .wipe, .rest], "it jumps to each line before it plays on it")
check(frames.first!.at == start, "it starts from where it stood")
check(Play(lines: page, steps: [.walk(line: 9), .eat(line: 1, words: 4..<9), .rest(0.5)], start: start).moves.map(\.kind) == [.rest],
      "a step that names a line or a word that is not there is skipped")
check(Play(lines: [], steps: [], start: start).frame(at: 0).done, "an empty script is over at once")

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
check(turn < 0.6 && stretch < 0.08, "and its face and body turn and stretch without a snap")
check(!play.frame(at: play.duration - 0.1).done && play.frame(at: play.duration).done, "the script is done when its last move ends")
check(play.frame(at: play.duration + 5).at == play.moves.last!.to && frames.last!.face == 0, "and it stays there, facing you")
check(play.duration > 6 && play.duration < 20, "the built-in script lasts a few seconds")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
