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

    /// How close the middle of the character comes to the left edge of
    /// its screen.
    static let characterInset: CGFloat = 44

    /// Where the character rests: the point under it, the screen it is
    /// on, and the ends it may step aside to.
    struct Spot: Equatable {
        let place: CGPoint
        let visible: CGRect
        let ends: ClosedRange<CGFloat>
    }

    /// A place the character was dragged to (#502) made safe: on the
    /// screen nearest to it, between the ends it may step aside to, with
    /// `room` above it for its body and its bubble. Further than `room`
    /// from every screen (its monitor was unplugged, or the saved value
    /// is nonsense) or nil: under the right end of its bubble, the bubble
    /// in the pill's default corner of `fallback`.
    static func character(saved: CGPoint?, room: CGFloat, screens: [CGRect], fallback: CGRect) -> Spot {
        var visible = fallback
        var p = CGPoint(x: fallback.maxX, y: fallback.minY)
        if let saved, saved.x.isFinite, saved.y.isFinite {
            func far(_ r: CGRect) -> CGFloat {
                hypot(max(r.minX - saved.x, 0, saved.x - r.maxX), max(r.minY - saved.y, 0, saved.y - r.maxY))
            }
            if let near = screens.min(by: { far($0) < far($1) }), far(near) <= room {
                visible = near
                p = saved
            }
        }
        let left = visible.minX + characterInset
        let right = max(visible.maxX - inset - bubbleReach, left)
        return Spot(place: CGPoint(x: min(max(p.x, left), right),
                                   y: min(max(p.y, visible.minY), max(visible.maxY - room, visible.minY))),
                    visible: visible, ends: left...right)
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
