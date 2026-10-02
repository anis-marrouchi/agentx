import CoreGraphics

/// Where the pill goes on screen, and how it grows into its answer, kept free of AppKit so
/// the tests can check it without a window. Frames are in screen
/// coordinates, origin bottom-left, as AppKit uses them.
enum PillPlacement {
    /// Distance from the screen's edges for the default corner.
    static let inset: CGFloat = 24

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

    /// The pill grown into its answer: where the whole widget goes, and
    /// which way it grew.
    struct Expanded: Equatable {
        let frame: CGRect
        /// True: the answer opens above the pill's row. False: below it.
        let above: Bool
        /// True: right edges line up with the pill's. False: left edges.
        let alignRight: Bool
    }

    /// The pill at `pill` grown to `size`. It grows up when there is at
    /// least as much room above the pill as below, else down, so its row
    /// stays where it was. It grows leftwards, keeping the right edge,
    /// unless that would leave the screen. Too tall for the screen: kept
    /// on it, top-left in view.
    static func expanded(size: CGSize, pill: CGRect, visible: CGRect) -> Expanded {
        let above = visible.maxY - pill.maxY >= pill.minY - visible.minY
        let alignRight = pill.maxX - size.width >= visible.minX
        let frame = CGRect(x: alignRight ? pill.maxX - size.width : pill.minX,
                           y: above ? pill.minY : pill.maxY - size.height,
                           width: size.width, height: size.height)
        return Expanded(frame: inside(frame, visible), above: above, alignRight: alignRight)
    }

    /// Where the pill goes back to when the widget at `frame` collapses:
    /// its row's end on the side it grew from.
    static func collapsed(from frame: CGRect, size: CGSize, above: Bool, alignRight: Bool) -> CGRect {
        CGRect(x: alignRight ? frame.maxX - size.width : frame.minX,
               y: above ? frame.minY : frame.maxY - size.height,
               width: size.width, height: size.height)
    }

    /// How far the bubble reaches to the right of the character's middle,
    /// and the gap above its head that the bubble's tail fills.
    static let bubbleReach: CGFloat = 64
    static let tail: CGFloat = 10

    /// The pill as the character's speech bubble (#491): above `head`,
    /// the top of the character, most of it to the left, kept on screen.
    static func bubble(size: CGSize, head: CGPoint, visible: CGRect) -> CGPoint {
        inside(CGRect(x: head.x + bubbleReach - size.width, y: head.y + tail,
                      width: size.width, height: size.height), visible).origin
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
