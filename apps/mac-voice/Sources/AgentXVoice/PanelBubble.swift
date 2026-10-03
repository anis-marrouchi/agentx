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
        (contentView as? Surface)?.shape(size: amount > 0 ? PillPlacement.shrunk(bubbleSize, small: amount).size : nil)
        invalidateShadow()
        // The row was not laid out while reduced, and the frame may already
        // be the full pill's: nothing else would lay it out again.
        if amount == 0, let content = contentView { layoutContent(content.bounds) }
    }

    /// The caption the bubble says now (#566): at a stop it shows whatever
    /// the assistant is doing; only an error or a call takes its place.
    @MainActor
    var caption: String? {
        guard case .caption(let words) = idle else { return nil }
        switch current {
        case .error, .ringing, .onCall: return nil
        default: return words
        }
    }

    /// The bubble's size: with a caption, as wide as its words, no wider.
    @MainActor
    var bubbleSize: NSSize {
        guard let caption else { return Self.size }
        let words = (caption as NSString).size(withAttributes: [.font: Brand.body()]).width
        return NSSize(width: GuideMath.bubbleWidth(words: words, full: Self.size.width), height: Self.size.height)
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
