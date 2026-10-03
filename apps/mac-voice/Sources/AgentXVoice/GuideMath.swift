import CoreGraphics
import Foundation

/// Guiding (#482): the answering agent sends the character to something
/// on screen. Where it stands to show it, and the mark it leaves there.
/// Kept free of AppKit so the tests can check it without a window.
/// Rectangles are in screen coordinates, origin bottom-left, as AppKit
/// uses them, once toAppKit has turned them.
enum GuideMath {
    enum Mark: String {
        case box, circle, underline, none
    }

    /// Accessibility → AppKit: the daemon's rectangles are measured from
    /// the top of the primary display, whichever screen they are on.
    static func toAppKit(_ r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// The point under the character while it shows `rect`: beside it,
    /// its body level with the middle. On the left, away from which its
    /// bubble reaches, so the bubble does not cover what it shows; on the
    /// right when the left has no room in `visible`.
    static func stand(beside rect: CGRect, in visible: CGRect, body: CGFloat, tall: CGFloat,
                      inset: CGFloat, gap: CGFloat = 14) -> CGPoint {
        let left = rect.minX - gap - body / 2
        let x = left >= visible.minX + inset ? left : rect.maxX + gap + body / 2
        return CGPoint(x: x, y: rect.midY - tall / 2)
    }

    /// What the mark is drawn along, around `rect`: a box a little wider
    /// than it, an oval that clears its corners, or a line under it.
    static func outline(_ mark: Mark, around rect: CGRect) -> CGRect {
        switch mark {
        case .box: return rect.insetBy(dx: -5, dy: -5)
        // An oval through a rectangle's corners is √2 times its size.
        case .circle: return rect.insetBy(dx: -(rect.width * 0.21 + 6), dy: -(rect.height * 0.21 + 6))
        case .underline: return CGRect(x: rect.minX - 2, y: rect.minY - 5, width: rect.width + 4, height: 0)
        case .none: return .null
        }
    }

    /// What the bubble says while the assistant has nothing to say (#562).
    enum Idle: Equatable { case hint, caption(String), nothing }

    /// At a stop the bubble says the command's caption, and with none
    /// there is no bubble; the idle hint is for where it rests, not for
    /// a stop, the way there or a play. `away`: sent somewhere, or playing.
    static func idle(caption: String?, away: Bool) -> Idle {
        if let caption, !caption.isEmpty { return .caption(caption) }
        return away ? .nothing : .hint
    }

    /// What a label needs beyond the width of its words (#569): a text
    /// field keeps two points clear at each end, and cuts the last letter
    /// when given the words' width alone.
    static let labelEnds: CGFloat = 4

    /// How wide the bubble is around a caption `words` wide (#566): its
    /// label and the room at both ends of the row, no wider; never less
    /// than holds its tail, nor more than `full`, where a long one scrolls.
    static func bubbleWidth(words: CGFloat, full: CGFloat) -> CGFloat {
        min(max(words.rounded(.up) + labelEnds + 52, 96), full)
    }

    /// Whether words `words` wide show whole in a label `room` wide.
    static func fits(words: CGFloat, room: CGFloat) -> Bool {
        words + labelEnds <= room
    }

    /// One frame of its way up or down to where it is sent: most of the
    /// way in a third of a second, and there once it is within a point.
    static func glide(_ y: CGFloat, toward goal: CGFloat, dt: Double) -> CGFloat {
        let next = y + (goal - y) * CGFloat(1 - exp(-7 * min(max(dt, 0), 0.1)))
        return abs(goal - next) < 1 ? goal : next
    }
}
