import AppKit

/// The character's drawing surface. Flipped, so the drawing's y grows
/// downwards as in the pose sheet it was ported from.
final class CharacterView: NSView {
    var shown = CharacterSim.Frame()
    var stops = CharacterDraw.stops(tint: Brand.accent, colors: nil)
    var unit: CGFloat = 0.56
    /// Under the character, in this view; and the view's left edge on screen.
    var edge = CGPoint.zero
    var origin: CGFloat = 0
    /// Its speech bubble in this window, origin bottom-left; nil while hidden.
    var bubble: NSRect?

    /// A drag of its body. Its window takes the mouse for nothing else.
    enum Drag { case began, moved, ended }
    var onDrag: ((Drag) -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onDrag?(.began) }
    override func mouseDragged(with event: NSEvent) { onDrag?(.moved) }
    override func mouseUp(with event: NSEvent) { onDrag?(.ended) }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        // The body is drawn where the window is, which follows the frame
        // to the nearest point; the rest of the way is drawn here.
        let at = CGPoint(x: CGFloat(shown.x) - origin, y: edge.y)
        CharacterDraw.draw(shown, in: ctx, edge: at, origin: origin, unit: unit, stops: stops)
        if let bubble { drawTail(in: ctx, from: bubble) }
    }

    /// The bubble's tail: a small point from its bottom edge down to the
    /// character, in the bubble's own colours.
    private func drawTail(in ctx: CGContext, from bubble: NSRect) {
        let half: CGFloat = 7, corner = Brand.Radius.lg + half
        let x = min(max(bounds.midX, bubble.minX + corner), bubble.maxX - corner)
        // One point up into the bubble, so no gap shows between the two.
        let top = bounds.height - bubble.minY - 1
        let tip = CGPoint(x: x, y: top + 1 + PillPlacement.tail)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            ctx.move(to: CGPoint(x: x - half, y: top))
            ctx.addLine(to: tip)
            ctx.addLine(to: CGPoint(x: x + half, y: top))
            ctx.closePath()
            ctx.setFillColor(NSColor.windowBackgroundColor.withAlphaComponent(0.92).cgColor)
            ctx.fillPath()
            ctx.move(to: CGPoint(x: x - half, y: top + 1))
            ctx.addLine(to: tip)
            ctx.addLine(to: CGPoint(x: x + half, y: top + 1))
            ctx.setStrokeColor(NSColor.separatorColor.cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }
    }
}
