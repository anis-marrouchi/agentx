import AppKit

/// A callout that stays on screen and updates while the agent talks.
///
/// The pointer's label vanishes with its highlight, which is fine for
/// "here is the button" and useless for "here is what we are doing and
/// why". A lesson needs somewhere the current instruction persists —
/// something you can glance back at after listening, and that still says
/// what is happening when the speech has moved on.
///
/// Driven over stdin rather than as one-shot calls, because the point is
/// that it UPDATES: a fresh window per step would flash, lose its
/// position, and steal focus. One window, many lines, closed on EOF.
///
///   {"title":"Step 2 of 9","body":"Type from:naval","state":"typing"}
///
/// Anything unparseable is ignored rather than fatal — a malformed line
/// from a caller should not take down the display mid-lesson.
enum HUD {

    private final class Window: NSPanel {
        let titleField = NSTextField(labelWithString: "")
        let bodyField = NSTextField(wrappingLabelWithString: "")
        let dot = NSView()

        init() {
            super.init(contentRect: NSRect(x: 0, y: 0, width: 460, height: 96),
                       styleMask: [.borderless, .nonactivatingPanel],
                       backing: .buffered, defer: false)
            level = .screenSaver
            isOpaque = false
            backgroundColor = .clear
            hasShadow = true
            ignoresMouseEvents = true
            collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

            let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 460, height: 96))
            blur.material = .hudWindow
            blur.blendingMode = .behindWindow
            blur.state = .active
            blur.wantsLayer = true
            blur.layer?.cornerRadius = Brand.Radius.lg
            blur.layer?.masksToBounds = true
            blur.autoresizingMask = [.width, .height]
            contentView = blur

            dot.wantsLayer = true
            dot.layer?.cornerRadius = 4
            dot.frame = NSRect(x: 20, y: 63, width: 8, height: 8)
            blur.addSubview(dot)

            titleField.frame = NSRect(x: 38, y: 58, width: 400, height: 18)
            // Eyebrow: mono, uppercase, tracked — "STEP 2 OF 9".
            titleField.font = .monospacedSystemFont(ofSize: 10, weight: .semibold)
            titleField.textColor = .secondaryLabelColor
            blur.addSubview(titleField)

            bodyField.frame = NSRect(x: 20, y: 14, width: 420, height: 40)
            bodyField.font = Brand.body(size: 14)
            bodyField.textColor = .labelColor
            bodyField.maximumNumberOfLines = 2
            blur.addSubview(bodyField)

            // Top centre: out of the way of most content, and where a
            // person already looks for system feedback.
            if let screen = NSScreen.main {
                let v = screen.visibleFrame
                setFrameOrigin(NSPoint(x: v.midX - 230, y: v.maxY - 130))
            }
        }

        override var canBecomeKey: Bool { false }
    }

    // Teal for the agent acting on the screen, blue while it speaks,
    // amber when it is blocked. One accent family, not a traffic light.
    private static let colours: [String: NSColor] = [
        "talking": Brand.primaryBright,
        "pointing": Brand.accent,
        "typing": Brand.accentDeep,
        "waiting": Brand.warn,
        "done": Brand.accent,
    ]

    /// Read update lines until stdin closes.
    static func run() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = Window()
        window.alphaValue = 0
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.2; window.animator().alphaValue = 1 }

        // stdin on a background thread: the main thread has to keep
        // pumping the run loop or nothing renders and the blur never
        // resolves.
        let queue = DispatchQueue(label: "tn.noqta.agentx.hud.stdin")
        queue.async {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                DispatchQueue.main.async {
                    if let t = obj["title"] as? String {
                        window.titleField.attributedStringValue =
                            Brand.metaString(t, size: 10, color: .secondaryLabelColor)
                    }
                    if let b = obj["body"] as? String { window.bodyField.stringValue = b }
                    let state = (obj["state"] as? String) ?? "talking"
                    let c = colours[state] ?? Brand.primaryBright
                    window.dot.layer?.backgroundColor = c.cgColor
                    window.dot.layer?.shadowColor = c.cgColor
                    window.dot.layer?.shadowOpacity = 0.6
                    window.dot.layer?.shadowRadius = 5
                    window.dot.layer?.shadowOffset = .zero
                }
            }
            // EOF: the lesson ended.
            DispatchQueue.main.async {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.25
                    window.animator().alphaValue = 0
                } completionHandler: {
                    app.terminate(nil)
                }
            }
        }
        app.run()
    }
}
