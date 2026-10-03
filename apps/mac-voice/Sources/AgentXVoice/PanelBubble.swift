import AppKit

/// The bubble while its character moves (#554): reduced to three dots in
/// the smallest shape that holds them, so the character is not carried
/// across the screen under a wide pill. The dots say it is still there,
/// listening or answering; the words come back when the character rests.
/// When that is, is in BubbleMotion.swift; the sizes in PillPlacement.
extension Panel {
    /// `amount` of the way from the pill (0) to its dots (1): the words
    /// fade out, then the dots fade in, and the shape follows. The frame
    /// is set by `attach`, with the place.
    @MainActor
    func shrink(_ amount: CGFloat) {
        guard amount != small else { return }
        small = amount
        row.alphaValue = max(1 - 2 * amount, 0)
        dots.alphaValue = max(2 * amount - 1, 0)
        (contentView as? Surface)?.shape(size: amount > 0 ? PillPlacement.shrunk(Self.size, small: amount).size : nil)
        invalidateShadow()
    }
}

/// Three dots, in the middle of the bubble.
final class BubbleDots: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.setFill()
        for i in -1...1 {
            NSBezierPath(ovalIn: NSRect(x: bounds.midX + CGFloat(i) * 10 - 2.5, y: bounds.midY - 2.5, width: 5, height: 5)).fill()
        }
    }

    /// Clicks go through to the pill: a click on the dots talks.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
