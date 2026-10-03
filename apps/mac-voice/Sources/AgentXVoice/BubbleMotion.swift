import Foundation

/// When the character's bubble is reduced to its three dots (#554): while
/// the character moves, so a wide bubble is not carried across the screen.
/// Stepped once a frame. Foundation only, so the tests can run it without
/// a window.
struct BubbleMotion {
    /// Seconds it moves before the bubble reduces, and rests before the
    /// bubble grows back: a short move changes nothing, and two moves
    /// close together are one. Then the seconds the change itself takes.
    static let after = 0.15, rest = 0.6, ease = 0.25

    private(set) var reduced = false
    private var moving = false
    private var since = 0.0
    private var last = 0.0
    private var amount = 0.0

    /// One frame: 0 the full bubble … 1 the dots, eased. `holds`: the
    /// bubble has something to read or to use (an answer, an error, the
    /// call buttons), which is never reduced.
    mutating func step(now: Double, moving: Bool, holds: Bool) -> Double {
        if moving != self.moving { self.moving = moving; since = now }
        let dt = min(max(now - last, 0), 0.1)
        last = now
        if holds {
            reduced = false
            amount = 0
        } else if moving != reduced, now - since >= (moving ? Self.after : Self.rest) {
            reduced = moving
        }
        let step = dt / Self.ease
        amount += min(max((reduced ? 1 : 0) - amount, -step), step)
        return amount * amount * (3 - 2 * amount)
    }
}
