import AppKit

/// Shows where a control is. Does not click it.
///
/// This is the whole point of the `point` tier: the model's choice becomes
/// visible and reviewable BEFORE anything irreversible happens. A wrong
/// answer moves a cursor and draws a rectangle; a wrong answer in an `act`
/// tier presses a button. Given that instructions may arrive by voice and
/// speech-to-text mishears, the cheap tier is the one worth having first.
enum Pointer {

    /// Move the cursor and flash a highlight around the element.
    static func point(x: Double, y: Double, width: Double, height: Double, label: String) {
        // Accessibility reports top-left origin in screen coordinates;
        // CGWarpMouseCursorPosition wants the same, so no flip is needed —
        // unlike NSWindow, which would.
        let center = CGPoint(x: x + width / 2, y: y + height / 2)
        CGWarpMouseCursorPosition(center)
        CGAssociateMouseAndMouseCursorPosition(1)
        highlight(CGRect(x: x, y: y, width: width, height: height), label: label)
    }

    /// A borderless overlay that cannot be clicked through by accident and
    /// removes itself. Deliberately short-lived: a highlight that outstays
    /// its welcome is an obstruction.
    private static func highlight(_ rect: CGRect, label: String) {
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
        panel.orderFrontRegardless()

        // Run briefly so the overlay actually renders, then tear down. The
        // helper is a one-shot CLI; without pumping the run loop the window
        // would never appear before the process exited.
        let deadline = Date().addingTimeInterval(1.6)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        panel.orderOut(nil)
    }
}
