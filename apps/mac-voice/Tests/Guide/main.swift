// Tests for guiding (#482): the daemon's rectangles turned for AppKit,
// where the character stands to show one, the outline of its mark, and
// its way up or down. Run with ../../test.sh.
import CoreGraphics
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias G = GuideMath

// A 1440 x 900 primary display; the Dock takes 70 points at the bottom
// and the menu bar 25 at the top.
let visible = CGRect(x: 0, y: 70, width: 1440, height: 805)
let button = G.toAppKit(CGRect(x: 600, y: 300, width: 90, height: 24), primaryHeight: 900)
check(button == CGRect(x: 600, y: 576, width: 90, height: 24), "a rectangle measured from the top is turned to one from the bottom")
let second = G.toAppKit(CGRect(x: 1500, y: -200, width: 50, height: 20), primaryHeight: 900)
check(second.minY == 1080, "one on a screen above the primary display lands above it")

let stand = G.stand(beside: button, in: visible, body: 56, tall: 78, inset: 44)
check(stand.x + 28 < button.minX, "it stands on the left of what it shows, clear of it")
check(abs(stand.y + 39 - button.midY) < 0.001, "with its body level with the middle")
let edge = CGRect(x: 30, y: 400, width: 120, height: 30)
let other = G.stand(beside: edge, in: visible, body: 56, tall: 78, inset: 44)
check(other.x - 28 > edge.maxX, "with no room on the left, it stands on the right")

let box = G.outline(.box, around: button)
check(box.contains(button) && box.width < button.width + 12, "a box is a little wider than what it marks")
let oval = G.outline(.circle, around: button)
let a = oval.width / 2, b = oval.height / 2
func inside(_ p: CGPoint) -> Bool { pow((p.x - oval.midX) / a, 2) + pow((p.y - oval.midY) / b, 2) < 1 }
check(inside(CGPoint(x: button.minX, y: button.minY)) && inside(CGPoint(x: button.maxX, y: button.maxY)),
      "an oval clears the corners of what it marks")
let line = G.outline(.underline, around: button)
check(line.height == 0 && line.minY < button.minY && line.minY > button.minY - 8 && line.width >= button.width,
      "an underline runs just under it, its whole width")
check(G.outline(.none, around: button).isNull, "no mark, no outline")
check(G.Mark(rawValue: "circle") == .circle && G.Mark(rawValue: "arrow") == nil, "a mark is one of the four the daemon sends")

var y: CGFloat = 78
var frames = 0
while y != 537 && frames < 300 { y = G.glide(y, toward: 537, dt: 1.0 / 30); frames += 1 }
check(y == 537 && frames > 10 && frames < 45, "it glides up to where it is sent in about a second, and arrives (\(frames) frames)")
var steps: [CGFloat] = [], at: CGFloat = 537
for _ in 0..<5 { let next = G.glide(at, toward: 78, dt: 1.0 / 30); steps.append(at - next); at = next }
check(steps.allSatisfy { $0 > 0 } && steps[0] > steps[4], "fast at first, then slower: no jump")
check(G.glide(100, toward: 500, dt: 5) < 500, "a long gap between two frames is one step, not a jump there")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
