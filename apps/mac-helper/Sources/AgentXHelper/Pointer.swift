import AppKit

/// Shows where a control is. Does not click it.
///
/// This is the whole point of the `point` tier: the model's choice becomes
/// visible and reviewable BEFORE anything irreversible happens. A wrong
/// answer moves a cursor and draws a rectangle; a wrong answer in an `act`
/// tier presses a button. Given that instructions may arrive by voice and
/// speech-to-text mishears, the cheap tier is the one worth having first.
enum Pointer {

    /// Move the cursor visibly and mark where it landed.
    ///
    /// Warping the cursor teleports it, and a teleport is easy to miss
    /// entirely — you look away for a second and the pointer is simply
    /// somewhere else, with no way to tell whether the tool did anything.
    /// So the move is ANIMATED along a short eased path: the motion is the
    /// signal, and a person can follow it to the target.
    static func point(x: Double, y: Double, width: Double, height: Double, label: String,
                      holdSeconds: Double = 2.5) {
        let target = CGPoint(x: x + width / 2, y: y + height / 2)
        glide(to: target)
        CGAssociateMouseAndMouseCursorPosition(1)
        highlight(CGRect(x: x, y: y, width: width, height: height),
                  label: label, holdSeconds: holdSeconds)
    }

    /// Ease the cursor to the target over ~280ms.
    ///
    /// Short enough not to feel slow, long enough that the eye tracks it.
    /// Ease-out because motion that decelerates into a target reads as
    /// deliberate, where linear motion reads as a glitch.
    private static func glide(to target: CGPoint) {
        var from = CGPoint.zero
        if let e = CGEvent(source: nil) { from = e.location }
        let steps = 28
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let eased = 1 - pow(1 - t, 3)
            let p = CGPoint(x: from.x + (target.x - from.x) * eased,
                            y: from.y + (target.y - from.y) * eased)
            CGWarpMouseCursorPosition(p)
            Thread.sleep(forTimeInterval: 0.01)
        }
        CGWarpMouseCursorPosition(target)
    }

    /// A borderless overlay that cannot be clicked through by accident and
    /// removes itself. Deliberately short-lived: a highlight that outstays
    /// its welcome is an obstruction.
    private static func highlight(_ rect: CGRect, label: String, holdSeconds: Double) {
        guard let screen = NSScreen.screens.first else { return }
        // AX gives top-left origin; NSWindow wants bottom-left.
        let flipped = CGRect(x: rect.origin.x,
                             y: screen.frame.maxY - rect.origin.y - rect.height,
                             width: rect.width, height: rect.height)

        let panel = NSPanel(contentRect: flipped.insetBy(dx: -4, dy: -4),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let view = NSView(frame: panel.contentView!.bounds)
        view.wantsLayer = true
        view.layer?.borderColor = NSColor.systemGreen.cgColor
        view.layer?.borderWidth = 3
        view.layer?.cornerRadius = 6
        view.layer?.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.12).cgColor
        view.autoresizingMask = [.width, .height]
        panel.contentView?.addSubview(view)

        // A pulse, because a static box on a busy screen is something the
        // eye skips. Two beats is enough to catch attention without
        // becoming an animation someone has to wait out.
        let pulse = CABasicAnimation(keyPath: "borderWidth")
        pulse.fromValue = 3; pulse.toValue = 7
        pulse.duration = 0.45
        pulse.autoreverses = true
        pulse.repeatCount = 2
        view.layer?.add(pulse, forKey: "pulse")

        // The label names what was chosen, so a wrong pick is obvious
        // rather than merely mysterious.
        if !label.isEmpty {
            let tag = NSTextField(labelWithString: label)
            tag.font = .systemFont(ofSize: 11, weight: .semibold)
            tag.textColor = .white
            tag.backgroundColor = NSColor.systemGreen
            tag.drawsBackground = true
            tag.alignment = .center
            tag.sizeToFit()
            tag.frame = NSRect(x: 0, y: -tag.frame.height - 2,
                               width: max(tag.frame.width + 10, view.bounds.width),
                               height: tag.frame.height + 4)
            view.addSubview(tag)
        }
        panel.orderFrontRegardless()

        // Run briefly so the overlay actually renders, then tear down. The
        // helper is a one-shot CLI; without pumping the run loop the window
        // would never appear before the process exited.
        let deadline = Date().addingTimeInterval(holdSeconds)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        panel.orderOut(nil)
    }
}
