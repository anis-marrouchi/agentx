import AppKit

/// The part of an agent's presence the person can touch: the initial
/// badge, the name, and the speech bubble under them.
///
/// It sits in its own panel, apart from the click-through arrow, so it can
/// take the mouse without the arrow ever stealing a click:
///
///   drag anywhere        move it; it stays there (pinned) for this agent
///   click ×              close: the owner ends what it was showing
///   click Skip           while the owner waits on the person: stop waiting
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
    /// Called when the × in the badge row is clicked.
    var onClose: (() -> Void)?
    /// Called when Skip is clicked, while there is a wait to skip.
    var onSkip: (() -> Void)?
    /// A click that started on the × and has not moved: a close, not a drag.
    private var pressingClose = false
    private var pressingSkip = false
    /// While the owner waits on the person: when the wait runs out. Skip
    /// and the seconds left show in the badge row until then.
    private var waitUntil: Date?
    private var countdown: Timer?
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
        // A lesson's bubble says what is pointed at, why, and how to end it.
        bubble.maximumNumberOfLines = 6
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
    private var nameWidth: CGFloat { (name as NSString).size(withAttributes: PresenceTag.nameAttrs).width + 14 }
    /// "Skip · 45s" is measured at its widest, so the row does not jitter.
    private static let skipWidth: CGFloat = ("Skip · 88s" as NSString).size(withAttributes: nameAttrs).width + 14
    private var skipShown: Bool { waitUntil != nil }
    private var rowWidth: CGFloat { 24 + 4 + nameWidth + 4 + (skipShown ? PresenceTag.skipWidth + 4 : 0) + 18 }
    /// Skip, right of the name pill, while there is a wait.
    private var skipRect: NSRect { NSRect(x: 24 + 4 + nameWidth + 4, y: bounds.maxY - 24 + 3, width: PresenceTag.skipWidth, height: 18) }
    /// The close button, at the end of the row.
    private var closeRect: NSRect { NSRect(x: rowWidth - 18, y: bounds.maxY - 24 + 3, width: 18, height: 18) }

    /// Show Skip and count down `seconds`; 0 or less hides them.
    func setWait(_ seconds: Double) {
        countdown?.invalidate()
        countdown = nil
        waitUntil = seconds > 0 ? Date().addingTimeInterval(seconds) : nil
        if waitUntil != nil {
            countdown = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.needsDisplay = true }
        }
        refit()
    }

    private var secondsLeft: Int { max(0, Int((waitUntil?.timeIntervalSinceNow ?? 0).rounded(.up))) }

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
        let fit = bubble.sizeThatFits(NSSize(width: textW, height: 120))
        let w = min(textW, ceil(fit.width)), h = min(120, ceil(fit.height))
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

        let pill = NSRect(x: badge.maxX + 4, y: badge.minY + 3, width: nameWidth, height: 18)
        color.setFill(); NSBezierPath(roundedRect: pill, xRadius: 9, yRadius: 9).fill()
        draw(name, in: pill, size: 11, weight: .semibold)

        if skipShown {
            let skip = skipRect
            Brand.paper.setFill(); NSBezierPath(roundedRect: skip, xRadius: 9, yRadius: 9).fill()
            color.setStroke()
            let edge = NSBezierPath(roundedRect: skip.insetBy(dx: 0.75, dy: 0.75), xRadius: 8.25, yRadius: 8.25); edge.lineWidth = 1.5; edge.stroke()
            draw("Skip · \(secondsLeft)s", in: skip, size: 11, weight: .semibold, color: color)
        }

        let close = closeRect
        Brand.paper.setFill(); NSBezierPath(ovalIn: close).fill()
        color.setStroke()
        let edge = NSBezierPath(ovalIn: close.insetBy(dx: 0.75, dy: 0.75)); edge.lineWidth = 1.5; edge.stroke()
        draw("\u{00D7}", in: close, size: 13, weight: .bold, color: color)
    }

    private func draw(_ s: String, in r: NSRect, size: CGFloat, weight: NSFont.Weight, color: NSColor = .white) {
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
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
        let p = convert(event.locationInWindow, from: nil)
        pressingClose = closeRect.insetBy(dx: -3, dy: -3).contains(p)
        pressingSkip = skipShown && skipRect.insetBy(dx: -2, dy: -3).contains(p)
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
        defer { dragFrom = nil; dragged = false; pressingClose = false; pressingSkip = false }
        if pressingClose && !dragged { onClose?(); return }
        if pressingSkip && !dragged { setWait(0); onSkip?(); return }
        guard dragged, let w = window else { return }
        onPin?(NSPoint(x: w.frame.minX, y: w.frame.maxY))
    }
}
