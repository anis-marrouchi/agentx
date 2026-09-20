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
///   {"title":"Step 2 of 9","body":"Type from:naval","state":"typing",
///    "avoid":{"x":218,"y":145,"w":420,"h":40}}
///
/// `avoid` is the rectangle the lesson is about to point at. The callout
/// moves out of its way.
///
/// This is not the same problem as click occlusion, and a hit test does
/// not catch it: the panel sets ignoresMouseEvents, so a click passes
/// straight through and the window server correctly reports whatever is
/// underneath. It is invisible to a click and very visible to a person —
/// which is exactly how this window ended up sitting on top of the search
/// field a lesson was pointing at, with nothing able to notice.
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

            moveToDefault()
        }

        /// Top centre: out of the way of most content, and where a person
        /// already looks for system feedback.
        func moveToDefault() {
            guard let screen = NSScreen.main else { return }
            let v = screen.visibleFrame
            setFrameOrigin(NSPoint(x: v.midX - frame.width / 2, y: v.maxY - frame.height - 34))
        }

        /// Move below the target when the default position would cover it.
        ///
        /// `rect` arrives in accessibility coordinates (top-left origin);
        /// windows use bottom-left, so it is flipped before comparing.
        func avoid(_ rect: CGRect) {
            guard let screen = NSScreen.main else { return }
            let v = screen.visibleFrame
            let flipped = CGRect(x: rect.origin.x,
                                 y: screen.frame.maxY - rect.origin.y - rect.height,
                                 width: rect.width, height: rect.height)
            moveToDefault()
            // A margin, so the callout does not merely touch the target's
            // edge and still crowd it.
            guard frame.insetBy(dx: -16, dy: -16).intersects(flipped) else { return }

            // Prefer just below the target; fall back to just above when
            // there is no room, and give up rather than push it off screen.
            let below = flipped.minY - frame.height - 20
            if below > v.minY {
                setFrameOrigin(NSPoint(x: frame.origin.x, y: below))
            } else {
                let above = flipped.maxY + 20
                if above + frame.height < v.maxY {
                    setFrameOrigin(NSPoint(x: frame.origin.x, y: above))
                }
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
                    if let a = obj["avoid"] as? [String: Any],
                       let x = a["x"] as? Double, let y = a["y"] as? Double,
                       let w = a["w"] as? Double, let h = a["h"] as? Double {
                        window.avoid(CGRect(x: x, y: y, width: w, height: h))
                    } else {
                        window.moveToDefault()
                    }
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
