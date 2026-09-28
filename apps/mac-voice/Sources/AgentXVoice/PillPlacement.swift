import CoreGraphics

/// Where the pill and its answer card go on screen, kept free of AppKit so
/// the tests can check it without a window. Frames are in screen
/// coordinates, origin bottom-left, as AppKit uses them.
enum PillPlacement {
    /// Distance from the screen's edges for the default corner.
    static let inset: CGFloat = 24
    /// Space between the pill and the answer card.
    static let cardGap: CGFloat = 8

    /// Bottom-right of `visible` (a screen's frame minus the menu bar and
    /// Dock), clear of both.
    static func defaultOrigin(size: CGSize, visible: CGRect) -> CGPoint {
        CGPoint(x: visible.maxX - size.width - inset, y: visible.minY + inset)
    }

    /// A saved position made safe: the pill lands fully on the screen it
    /// overlaps most. When it overlaps none (the monitor it was on has been
    /// unplugged, or the saved value is nonsense) it goes back to the
    /// default corner of `fallback`. Nil `saved`: the default corner.
    static func clamp(saved: CGPoint?, size: CGSize, screens: [CGRect], fallback: CGRect) -> CGPoint {
        guard let saved, saved.x.isFinite, saved.y.isFinite else {
            return defaultOrigin(size: size, visible: fallback)
        }
        let frame = CGRect(origin: saved, size: size)
        var best: CGRect?
        var bestArea: CGFloat = 0
        for screen in screens {
            let overlap = screen.intersection(frame)
            guard !overlap.isNull else { continue }
            let area = overlap.width * overlap.height
            if area > bestArea { bestArea = area; best = screen }
        }
        guard let screen = best, bestArea > 0 else {
            return defaultOrigin(size: size, visible: fallback)
        }
        return inside(frame, screen).origin
    }

    /// Which side of the pill the answer card opens on, and where.
    struct Card: Equatable {
        let origin: CGPoint
        /// True: above the pill. False: below it.
        let above: Bool
    }

    /// Above the pill when there is at least as much room above it as
    /// below, else below. Right edges line up with the pill's, and the
    /// card is kept on the screen.
    static func card(size: CGSize, pill: CGRect, visible: CGRect) -> Card {
        let roomAbove = visible.maxY - pill.maxY
        let roomBelow = pill.minY - visible.minY
        let above = roomAbove >= roomBelow
        let y = above ? pill.maxY + cardGap : pill.minY - cardGap - size.height
        let frame = CGRect(x: pill.maxX - size.width, y: y, width: size.width, height: size.height)
        return Card(origin: inside(frame, visible).origin, above: above)
    }

    /// `frame` moved the least distance that puts it inside `bounds`. A
    /// frame larger than `bounds` keeps its top-left corner in view.
    static func inside(_ frame: CGRect, _ bounds: CGRect) -> CGRect {
        var f = frame
        if f.maxX > bounds.maxX { f.origin.x = bounds.maxX - f.width }
        if f.minX < bounds.minX { f.origin.x = bounds.minX }
        if f.minY < bounds.minY { f.origin.y = bounds.minY }
        if f.maxY > bounds.maxY { f.origin.y = bounds.maxY - f.height }
        return f
    }
}
