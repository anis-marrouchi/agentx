// Tests for PillPlacement: where the pill is put back, and how it grows
// into its answer. Run with ../../test.sh.
import CoreGraphics
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let pill = CGSize(width: 264, height: 54)
// A laptop screen with the menu bar and Dock taken out, and an external
// monitor to its right.
let laptop = CGRect(x: 0, y: 80, width: 1512, height: 862)
let monitor = CGRect(x: 1512, y: 0, width: 2560, height: 1415)

// --- Default corner ---

let corner = PillPlacement.defaultOrigin(size: pill, visible: laptop)
check(corner == CGPoint(x: 1512 - 264 - 24, y: 80 + 24), "the default is bottom-right, clear of the Dock")
check(PillPlacement.clamp(saved: nil, size: pill, screens: [laptop], fallback: laptop) == corner,
      "no saved position: the default corner")

// --- Saved positions ---

let onLaptop = CGPoint(x: 300, y: 500)
check(PillPlacement.clamp(saved: onLaptop, size: pill, screens: [laptop, monitor], fallback: laptop) == onLaptop,
      "a position on screen is kept exactly")
let onMonitor = CGPoint(x: 2000, y: 900)
check(PillPlacement.clamp(saved: onMonitor, size: pill, screens: [laptop, monitor], fallback: laptop) == onMonitor,
      "a position on the second monitor is kept")
check(PillPlacement.clamp(saved: onMonitor, size: pill, screens: [laptop], fallback: laptop) == corner,
      "the monitor unplugged: back to the default corner of the main screen")
check(PillPlacement.clamp(saved: CGPoint(x: -5000, y: -5000), size: pill, screens: [laptop, monitor], fallback: laptop) == corner,
      "a position on no screen at all: the default corner")
check(PillPlacement.clamp(saved: CGPoint(x: CGFloat.nan, y: 10), size: pill, screens: [laptop], fallback: laptop) == corner,
      "a nonsense saved value: the default corner")

let halfOff = PillPlacement.clamp(saved: CGPoint(x: 1400, y: 900), size: pill, screens: [laptop], fallback: laptop)
check(halfOff == CGPoint(x: 1512 - 264, y: 942 - 54), "half off the top-right edge: pulled fully on screen")
let underDock = PillPlacement.clamp(saved: CGPoint(x: 200, y: 60), size: pill, screens: [laptop], fallback: laptop)
check(underDock == CGPoint(x: 200, y: 80), "under the Dock: lifted above it, same x")

// Straddling both screens, mostly on the monitor: it goes onto the monitor.
let straddle = PillPlacement.clamp(saved: CGPoint(x: 1450, y: 400), size: pill, screens: [laptop, monitor], fallback: laptop)
check(straddle == CGPoint(x: 1512, y: 400), "straddling two screens: onto the one it overlaps most")

// --- Growing into the answer ---

let grown = CGSize(width: 360, height: 300)
let low = CGRect(origin: corner, size: pill)
let up = PillPlacement.expanded(size: grown, pill: low, visible: laptop)
check(up.above && up.alignRight, "a pill in the bottom-right corner grows up and to the left")
check(up.frame == CGRect(x: low.maxX - 360, y: low.minY, width: 360, height: 300),
      "its row stays put: same bottom edge, same right edge")
check(PillPlacement.collapsed(from: up.frame, size: pill, above: true, alignRight: true) == low,
      "collapsing puts the pill back exactly where it was")

let high = CGRect(x: 600, y: 860, width: 264, height: 54)
let down = PillPlacement.expanded(size: grown, pill: high, visible: laptop)
check(!down.above, "a pill near the top grows down")
check(down.frame.maxY == high.maxY && down.frame.maxX == high.maxX, "keeping its top and right edges")
check(PillPlacement.collapsed(from: down.frame, size: pill, above: false, alignRight: true) == high,
      "and collapses back to the same place")

let middle = CGRect(x: 600, y: laptop.midY - 27, width: 264, height: 54)
check(PillPlacement.expanded(size: grown, pill: middle, visible: laptop).above, "equal room either side: grows up")

let leftEdge = CGRect(x: 10, y: 104, width: 264, height: 54)
let right = PillPlacement.expanded(size: grown, pill: leftEdge, visible: laptop)
check(!right.alignRight && right.frame.minX == 10, "near the left edge it grows to the right instead")
check(PillPlacement.collapsed(from: right.frame, size: pill, above: true, alignRight: false) == leftEdge,
      "and collapses back to its left edge")

let tall = CGSize(width: 360, height: 2000)
let squeezed = PillPlacement.expanded(size: tall, pill: low, visible: laptop)
check(squeezed.frame.maxY == laptop.maxY, "taller than the screen: its top stays in view")

let moved = up.frame.offsetBy(dx: -300, dy: 200)
check(PillPlacement.collapsed(from: moved, size: pill, above: true, alignRight: true)
        == low.offsetBy(dx: -300, dy: 200), "dragged while open: the pill collapses where it was dragged")

// --- The character's speech bubble (#491) ---

// The character at rest: its head 78 points above the Dock, 88 from the
// right edge of the screen.
let head = CGPoint(x: laptop.maxX - 24 - PillPlacement.bubbleReach, y: laptop.minY + 78)
let said = PillPlacement.bubble(size: pill, head: head, visible: laptop)
check(said == CGPoint(x: corner.x, y: head.y + PillPlacement.tail),
      "the bubble sits just above the character's head, its right edge where the pill's was")
check(said.x < head.x && head.x < said.x + pill.width, "and the character is under it, so the tail reaches it")
let aside = PillPlacement.bubble(size: pill, head: CGPoint(x: head.x - 150, y: head.y), visible: laptop)
check(aside == CGPoint(x: said.x - 150, y: said.y), "the character steps aside: the bubble goes the same way, as far")
let farLeft = PillPlacement.bubble(size: pill, head: CGPoint(x: laptop.minX + 44, y: head.y), visible: laptop)
check(farLeft.x == laptop.minX && farLeft.x + 18 < laptop.minX + 44,
      "at the left end of the screen the bubble stays fully on it, still over the character")
let saidOpen = PillPlacement.expanded(size: grown, pill: CGRect(origin: said, size: pill), visible: laptop)
check(saidOpen.above && saidOpen.frame.minY == said.y, "an answer opens upwards: the row stays next to the character")

// --- Where the character rests (#502) ---

// Its body and its bubble above the point under it.
let room: CGFloat = 78 + PillPlacement.tail + 54
let atHome = PillPlacement.character(saved: nil, room: room, screens: [laptop, monitor], fallback: laptop)
check(atHome.place == CGPoint(x: head.x, y: laptop.minY) && atHome.visible == laptop,
      "never dragged: on the edge above the Dock, under the right end of its bubble")
check(atHome.ends == laptop.minX + 44...head.x, "and it steps aside between the left end and where it rests")
let put = CGPoint(x: 600, y: 400)
check(PillPlacement.character(saved: put, room: room, screens: [laptop, monitor], fallback: laptop).place == put,
      "a place on screen is kept exactly")
let onSecond = PillPlacement.character(saved: CGPoint(x: 2600, y: 700), room: room, screens: [laptop, monitor], fallback: laptop)
check(onSecond.place == CGPoint(x: 2600, y: 700) && onSecond.visible == monitor && onSecond.ends.lowerBound == monitor.minX + 44,
      "a place on the second monitor is kept, and it steps aside along that screen")
check(PillPlacement.character(saved: CGPoint(x: 2600, y: 700), room: room, screens: [laptop], fallback: laptop) == atHome,
      "the monitor unplugged: back to its corner of the main screen")
check(PillPlacement.character(saved: CGPoint(x: CGFloat.nan, y: 10), room: room, screens: [laptop], fallback: laptop) == atHome,
      "a nonsense saved place: its corner")
let topRight = PillPlacement.character(saved: CGPoint(x: 1500, y: 930), room: room, screens: [laptop], fallback: laptop)
check(topRight.place == CGPoint(x: head.x, y: laptop.maxY - room),
      "dragged into the top-right corner: kept low enough for its bubble, and no further right than it rests")
check(PillPlacement.bubble(size: pill, head: CGPoint(x: topRight.place.x, y: topRight.place.y + 78), visible: laptop).y + pill.height == laptop.maxY,
      "its bubble still fits above it, on screen")
let bottomLeft = PillPlacement.character(saved: CGPoint(x: -30, y: 60), room: room, screens: [laptop], fallback: laptop)
check(bottomLeft.place == CGPoint(x: laptop.minX + 44, y: laptop.minY),
      "under the Dock, past the left edge: lifted above it and pulled in, on the same screen")

// --- "Show floating pill" in the menu ---

check(PillMenu.isChecked(showPill: true, visible: true), "setting on, pill on screen: checked")
check(!PillMenu.isChecked(showPill: true, visible: false), "setting on but the pill was closed: not checked")
check(!PillMenu.isChecked(showPill: false, visible: true), "setting off: not checked, even mid-answer")
check(PillMenu.click(showPill: true, visible: false) == true,
      "the pill was closed: one click keeps the setting on and brings it back")
check(PillMenu.click(showPill: false, visible: false) == true, "setting off: a click turns it on")
check(PillMenu.click(showPill: false, visible: true) == true, "setting off mid-answer: a click turns it on")
check(PillMenu.click(showPill: true, visible: true) == false, "checked: a click turns it off")

// --- The pill reduced to its orb (#457) ---

let orb = PillPlacement.orbSize
let rest = PillPlacement.orbOrigin(size: orb, visible: laptop)
check(orb.width == orb.height, "the reduced pill is a circle")
check(rest == CGPoint(x: 756 - 27, y: 80 + 24), "the orb first sits in the middle of the bottom edge, clear of the Dock")
check(PillPlacement.clamp(saved: nil, size: orb, screens: [laptop], fallback: laptop, rest: PillPlacement.orbOrigin) == rest,
      "no saved place: the orb's own default, not the pill's corner")
let dropped = CGPoint(x: 40, y: 700)
check(PillPlacement.clamp(saved: dropped, size: orb, screens: [laptop, monitor], fallback: laptop, rest: PillPlacement.orbOrigin) == dropped,
      "the orb stays where it was dropped")
check(PillPlacement.clamp(saved: onMonitor, size: orb, screens: [laptop], fallback: laptop, rest: PillPlacement.orbOrigin) == rest,
      "its monitor unplugged: back to the bottom of the main screen")
check(PillPlacement.clamp(saved: CGPoint(x: 1500, y: 60), size: orb, screens: [laptop], fallback: laptop, rest: PillPlacement.orbOrigin)
        == CGPoint(x: 1512 - 54, y: 80), "dropped half off the screen: moved fully onto it")
check(PillMenu.reduceTitle(reduced: false) == "Reduce to orb" && PillMenu.reduceTitle(reduced: true) == "Show full pill",
      "one menu item reduces the pill and brings it back")
check(PillMenu.canReduce(showsOrb: true) && !PillMenu.canReduce(showsOrb: false),
      "nothing to reduce to while the character stands in for the orb")

// --- The bubble never covers the character (#554) ---

// The character: 56 points wide, its head 78 above the point under it.
func body(_ head: CGPoint) -> CGRect { CGRect(x: head.x - 28, y: head.y - 78, width: 56, height: 78) }
let card = CGSize(width: 360, height: 374)
let lowHead = CGPoint(x: 700, y: laptop.minY + 78)
check(PillPlacement.bubble(size: card, head: lowHead, visible: laptop) == CGPoint(x: lowHead.x + PillPlacement.bubbleReach - 360, y: lowHead.y + PillPlacement.tail),
      "an answer with room above the character opens there, as the pill sits")
// Dragged or sent high on the screen: room for the pill, not for an answer.
let highHead = CGPoint(x: 700, y: laptop.maxY - 54 - PillPlacement.tail)
let besideLeft = CGRect(origin: PillPlacement.bubble(size: card, head: highHead, visible: laptop), size: card)
check(besideLeft.maxX == highHead.x - PillPlacement.bubbleReach && besideLeft.maxY == laptop.maxY,
      "no room above for the answer: it opens beside the character, on the left, at the top of the screen")
let highLeft = CGPoint(x: laptop.minX + 44, y: highHead.y)
check(PillPlacement.bubble(size: card, head: highLeft, visible: laptop).x == highLeft.x + PillPlacement.bubbleReach,
      "no room on the left either: on the right")
check(PillPlacement.bubble(size: pill, head: highHead, visible: laptop) == CGPoint(x: highHead.x + PillPlacement.bubbleReach - pill.width, y: laptop.maxY - 54),
      "the pill itself still fits above it there")
var covered = 0, off = 0
for screen in [laptop, monitor] {
    for size in [pill, card, PillPlacement.dots] {
        for x in stride(from: screen.minX + 44, through: screen.maxX - 24 - PillPlacement.bubbleReach, by: 37) {
            for y in stride(from: screen.minY + 78, through: screen.maxY - 54 - PillPlacement.tail, by: 29) {
                let at = CGPoint(x: x, y: y)
                let frame = CGRect(origin: PillPlacement.bubble(size: size, head: at, visible: screen), size: size)
                if frame.intersects(body(at)) { covered += 1 }
                if !screen.contains(frame) { off += 1 }
            }
        }
    }
}
check(covered == 0, "wherever the character may be, the pill, an answer and the dots never cover it (\(covered) do)")
check(off == 0, "and all of them stay on its screen (\(off) do not)")

// --- Reduced to three dots while the character moves (#554) ---

let whole = PillPlacement.shrunk(pill, small: 0), least = PillPlacement.shrunk(pill, small: 1)
check(whole.size == pill && whole.reach == PillPlacement.bubbleReach, "not reduced: the pill, where it always sat")
check(least.size == PillPlacement.dots && PillPlacement.bubble(size: least.size, head: lowHead, visible: laptop, reach: least.reach).x == lowHead.x - 24,
      "reduced: the dots, in the middle above the character's head")
let halfway = PillPlacement.shrunk(pill, small: 0.5).size
check(halfway.width < pill.width && halfway.width > 48 && halfway.height < pill.height && halfway.height > 28, "and every size between on the way")

/// Run `motion` at 30 frames a second from `t` for `seconds`; the amounts it gave.
func run(_ motion: inout BubbleMotion, from t: inout Double, for seconds: Double, moving: Bool, holds: Bool = false) -> [Double] {
    var out: [Double] = []
    let end = t + seconds
    while t < end - 1e-9 { t += 1.0 / 30; out.append(motion.step(now: t, moving: moving, holds: holds)) }
    return out
}
var motion = BubbleMotion()
var clock = 100.0
check(run(&motion, from: &clock, for: 1, moving: false).allSatisfy { $0 == 0 }, "at rest: the full bubble")
check(run(&motion, from: &clock, for: 0.1, moving: true).allSatisfy { $0 == 0 }, "a move shorter than \(BubbleMotion.after) s changes nothing")
check(run(&motion, from: &clock, for: 1, moving: false).allSatisfy { $0 == 0 } && !motion.reduced, "and nothing after it")
let shrinking = run(&motion, from: &clock, for: 0.6, moving: true)
check(shrinking.last == 1 && motion.reduced, "it moves on: the bubble is its three dots")
check(zip(shrinking, shrinking.dropFirst()).allSatisfy { $0 <= $1 } && shrinking.contains { $0 > 0.1 && $0 < 0.9 }, "eased down, never back on the way")
check(run(&motion, from: &clock, for: 0.4, moving: false).allSatisfy { $0 == 1 }, "a stop shorter than \(BubbleMotion.rest) s: still the dots")
check(run(&motion, from: &clock, for: 0.5, moving: true).allSatisfy { $0 == 1 }, "moving again: no flicker between two moves")
let growing = run(&motion, from: &clock, for: 1.2, moving: false)
check(growing.last == 0 && !motion.reduced, "it rests: the full bubble is back")
check(zip(growing, growing.dropFirst()).allSatisfy { $0 >= $1 } && growing.contains { $0 > 0.1 && $0 < 0.9 }, "eased back, never down on the way")
_ = run(&motion, from: &clock, for: 0.6, moving: true)
check(run(&motion, from: &clock, for: 0.2, moving: true, holds: true).allSatisfy { $0 == 0 },
      "an answer, an error or the call buttons: the full bubble at once, moving or not")
check(run(&motion, from: &clock, for: 0.1, moving: true).first! < 0.2 && run(&motion, from: &clock, for: 0.5, moving: true).last == 1,
      "used and gone, and still moving: reduced again, eased")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
