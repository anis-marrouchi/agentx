import AppKit

/// The part of an agent's presence the person can touch: the initial
/// badge, the name, and the speech bubble under them.
///
/// It sits in its own panel, apart from the click-through arrow, so it can
/// take the mouse without the arrow ever stealing a click:
///
///   drag anywhere        move it; it stays there (pinned) for this agent
///   double-click bubble  dismiss the bubble for the rest of this overlay
///   double-click name    unpin; it rides next to the arrow again
///
/// The view is top-anchored: the badge row stays put as the bubble comes
/// and goes, and the window grows or shrinks underneath it.
final class PresenceTag: NSView {
    let color: NSColor
    let initial: String
    let name: String
    let bubble = NSTextField(wrappingLabelWithString: "")
    /// The bubble's background, so the text gets padding.
    let box = NSView()

    static let rowHeight: CGFloat = 24
    static let gap: CGFloat = 8

    /// Called with the window's new top-left once a drag ends.
    var onPin: ((NSPoint) -> Void)?
    var onUnpin: (() -> Void)?
    /// A double-click on the bubble hides it; later lines stay hidden too.
    private(set) var dismissed = false

    private var dragFrom: NSPoint?
    private var windowFrom: NSPoint = .zero
    /// True mid-drag, so a glide doesn't pull the tag out of the hand.
    private(set) var dragged = false

    init(color: NSColor, initial: String, name: String) {
        self.color = color; self.initial = initial; self.name = name
        super.init(frame: .zero)
        wantsLayer = true
        bubble.font = Brand.body(size: 13)
        bubble.textColor = Brand.ink
        bubble.maximumNumberOfLines = 4
        box.wantsLayer = true
        box.layer?.backgroundColor = Brand.paper.cgColor
        box.layer?.cornerRadius = Brand.Radius.md
        box.layer?.borderWidth = 2
        box.layer?.borderColor = color.cgColor
        box.isHidden = true
        box.addSubview(bubble)
        addSubview(box)
        setFrameSize(fittingSize)
    }
    required init?(coder: NSCoder) { fatalError() }

    private static let nameAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .semibold)]
    private var rowWidth: CGFloat { 24 + 4 + (name as NSString).size(withAttributes: PresenceTag.nameAttrs).width + 14 }

    override var fittingSize: NSSize {
        guard !box.isHidden else { return NSSize(width: rowWidth, height: PresenceTag.rowHeight) }
        return NSSize(width: max(rowWidth, box.frame.width),
                      height: PresenceTag.rowHeight + PresenceTag.gap + box.frame.height)
    }

    func setBubble(_ text: String) {
        box.isHidden = text.isEmpty || dismissed
        bubble.stringValue = text
        let textW: CGFloat = 300
        bubble.preferredMaxLayoutWidth = textW
        let fit = bubble.sizeThatFits(NSSize(width: textW, height: 90))
        let w = min(textW, ceil(fit.width)), h = min(90, ceil(fit.height))
        bubble.frame = NSRect(x: 10, y: 6, width: w, height: h)
        box.frame = NSRect(x: 0, y: 0, width: w + 20, height: h + 12)
        refit()
    }

    /// Resize the window to the content, keeping its top-left where it is.
    private func refit() {
        let size = fittingSize
        setFrameSize(size)
        needsDisplay = true
        guard let w = window else { return }
        let top = NSPoint(x: w.frame.minX, y: w.frame.maxY)
        w.setFrame(NSRect(x: top.x, y: top.y - size.height, width: size.width, height: size.height), display: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        let badge = NSRect(x: 0, y: bounds.maxY - 24, width: 24, height: 24)
        color.setFill(); NSBezierPath(ovalIn: badge).fill()
        NSColor.white.setStroke()
        let ring = NSBezierPath(ovalIn: badge.insetBy(dx: 0.75, dy: 0.75)); ring.lineWidth = 1.5; ring.stroke()
        draw(initial, in: badge, size: 11, weight: .bold)

        let nameW = (name as NSString).size(withAttributes: PresenceTag.nameAttrs).width + 14
        let pill = NSRect(x: badge.maxX + 4, y: badge.minY + 3, width: nameW, height: 18)
        color.setFill(); NSBezierPath(roundedRect: pill, xRadius: 9, yRadius: 9).fill()
        draw(name, in: pill, size: 11, weight: .semibold)
    }

    private func draw(_ s: String, in r: NSRect, size: CGFloat, weight: NSFont.Weight) {
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: NSColor.white]
        let sz = (s as NSString).size(withAttributes: a)
        (s as NSString).draw(at: NSPoint(x: r.midX - sz.width / 2, y: r.midY - sz.height / 2), withAttributes: a)
    }

    // MARK: Mouse

    /// The label would swallow clicks meant for the drag.
    override func hitTest(_ point: NSPoint) -> NSView? {
        frame.contains(point) ? self : nil
    }
    /// The panel never activates this app, so the first click must count.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            let p = convert(event.locationInWindow, from: nil)
            if !box.isHidden && box.frame.contains(p) {
                dismissed = true
                box.isHidden = true
                refit()
            } else if p.y >= bounds.maxY - PresenceTag.rowHeight {
                onUnpin?()
            }
            dragFrom = nil
            return
        }
        dragFrom = NSEvent.mouseLocation
        windowFrom = window?.frame.origin ?? .zero
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let from = dragFrom, let w = window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - from.x, dy = now.y - from.y
        if !dragged && hypot(dx, dy) < 3 { return }
        dragged = true
        w.setFrameOrigin(NSPoint(x: windowFrom.x + dx, y: windowFrom.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        defer { dragFrom = nil; dragged = false }
        guard dragged, let w = window else { return }
        onPin?(NSPoint(x: w.frame.minX, y: w.frame.maxY))
    }
}
