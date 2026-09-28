// Tests for PillPlacement: where the pill is put back, and which side the
// answer card opens on. Run with ../../test.sh.
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

// --- The answer card ---

let card = CGSize(width: 380, height: 260)
let low = CGRect(origin: corner, size: pill)
let placed = PillPlacement.card(size: card, pill: low, visible: laptop)
check(placed.above, "a pill at the bottom opens the card above it")
check(placed.origin == CGPoint(x: low.maxX - 380, y: low.maxY + 8), "above, right edges aligned, 8 points apart")

let high = CGRect(x: 600, y: 860, width: 264, height: 54)
let below = PillPlacement.card(size: card, pill: high, visible: laptop)
check(!below.above, "a pill near the top opens the card below it")
check(below.origin == CGPoint(x: high.maxX - 380, y: high.minY - 8 - 260), "below, right edges aligned")

let middle = CGRect(x: 600, y: laptop.midY - 27, width: 264, height: 54)
check(PillPlacement.card(size: card, pill: middle, visible: laptop).above, "equal room either side: above")

let leftEdge = CGRect(x: 0, y: 104, width: 264, height: 54)
check(PillPlacement.card(size: card, pill: leftEdge, visible: laptop).origin.x == 0,
      "at the left edge the card is kept on screen")

let tall = CGSize(width: 380, height: 700)
let squeezed = PillPlacement.card(size: tall, pill: low, visible: laptop)
check(squeezed.origin.y + 700 <= laptop.maxY && squeezed.origin.y >= laptop.minY,
      "a card taller than the room left still fits on screen")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
