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

// --- "Show floating pill" in the menu ---

check(PillMenu.isChecked(showPill: true, visible: true), "setting on, pill on screen: checked")
check(!PillMenu.isChecked(showPill: true, visible: false), "setting on but the pill was closed: not checked")
check(!PillMenu.isChecked(showPill: false, visible: true), "setting off: not checked, even mid-answer")
check(PillMenu.click(showPill: true, visible: false) == true,
      "the pill was closed: one click keeps the setting on and brings it back")
check(PillMenu.click(showPill: false, visible: false) == true, "setting off: a click turns it on")
check(PillMenu.click(showPill: false, visible: true) == true, "setting off mid-answer: a click turns it on")
check(PillMenu.click(showPill: true, visible: true) == false, "checked: a click turns it off")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
