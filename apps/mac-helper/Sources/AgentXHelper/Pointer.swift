import AppKit

/// Shows where a control is, at a speed a person can follow. Does not click.
///
/// The first version warped the cursor, then eased it over a flat 280ms.
/// Both read as machine motion: a teleport is missed entirely, and a
/// constant-duration slide is the same speed whether it crosses the screen
/// or nudges thirty points. Neither looks like a hand.
///
/// Real pointing has three properties worth copying, all cheap:
///
///   1. Duration follows Fitts's law — far targets and small targets take
///      longer. A fixed duration is the single biggest tell.
///   2. Velocity is minimum-jerk: accelerate, cruise, decelerate. Linear
///      motion reads as a glitch; abrupt stops read as a snap.
///   3. The path bows slightly. Hands do not travel in straight lines, and
///      a perfectly straight traverse is conspicuous on a long move.
///
/// There is deliberately no click here. The point tier exists so a model's
/// choice is visible and reviewable BEFORE anything irreversible happens.
enum Pointer {

    static func point(x: Double, y: Double, width: Double, height: Double, label: String,
                      holdSeconds: Double = 2.5, instant: Bool = false) {
        let target = CGPoint(x: x + width / 2, y: y + height / 2)
        if instant {
            CGWarpMouseCursorPosition(target)
        } else {
            humanMove(to: target, targetSize: min(width, height))
        }
        CGAssociateMouseAndMouseCursorPosition(1)
        annotate(CGRect(x: x, y: y, width: width, height: height),
                 label: label, holdSeconds: holdSeconds)
    }

    // MARK: Movement

    /// Move the way a hand would.
    private static func humanMove(to target: CGPoint, targetSize: Double) {
        let from = CGEvent(source: nil)?.location ?? target
        let dx = target.x - from.x, dy = target.y - from.y
        let distance = (dx * dx + dy * dy).squareRoot()
        if distance < 2 { CGWarpMouseCursorPosition(target); return }

        // Fitts's law: time ∝ log2(distance / width + 1). The constants put
        // a short hop near 180ms and a full-screen traverse near 700ms,
        // which is roughly what a person does — fast enough not to feel
        // like waiting, slow enough to follow.
        let width = max(targetSize, 12)
        let difficulty = log2(distance / width + 1)
        let duration = min(0.95, max(0.18, 0.09 + 0.13 * difficulty))

        // Bow the path perpendicular to the direction of travel, scaled to
        // distance and with a stable sign so it does not wobble.
        let bow = min(distance * 0.08, 55.0) * (dx * dy >= 0 ? 1.0 : -1.0)
        let nx = -dy / distance, ny = dx / distance
        let control = CGPoint(x: from.x + dx * 0.5 + nx * bow,
                              y: from.y + dy * 0.5 + ny * bow)

        let steps = max(24, Int(duration * 110))
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            // Minimum-jerk: 10t³ − 15t⁴ + 6t⁵. Starts and ends at zero
            // velocity AND zero acceleration, which is why it looks settled
            // rather than braked.
            let e = 10 * pow(t, 3) - 15 * pow(t, 4) + 6 * pow(t, 5)
            let p = quadratic(from, control, target, e)

            // A trace of tremor, fading to nothing as it arrives. Without
            // it the path is mathematically perfect and reads as drawn.
            let tremor = (1 - e) * 0.7
            let jitter = CGPoint(x: Double.random(in: -tremor...tremor),
                                 y: Double.random(in: -tremor...tremor))
            CGWarpMouseCursorPosition(CGPoint(x: p.x + jitter.x, y: p.y + jitter.y))
            Thread.sleep(forTimeInterval: duration / Double(steps))
        }

        // Long moves overshoot slightly and correct — the correction is
        // what makes an arrival look human rather than magnetic.
        if distance > 320 {
            let over = CGPoint(x: target.x + dx / distance * 4,
                               y: target.y + dy / distance * 4)
            CGWarpMouseCursorPosition(over)
            Thread.sleep(forTimeInterval: 0.045)
        }
        CGWarpMouseCursorPosition(target)
    }

    private static func quadratic(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ t: Double) -> CGPoint {
        let u = 1 - t
        return CGPoint(x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
                       y: u * u * a.y + 2 * u * t * b.y + t * t * c.y)
    }

    /// A click, made visible.
    ///
    /// A synthetic click is otherwise invisible — the UI reacts, but
    /// nothing shows that the press came from here rather than from the
    /// person watching. In a lesson that ambiguity is the whole problem:
    /// you cannot learn a gesture you did not see performed.
    ///
    /// So the cursor position gets a ring that snaps inward and rebounds,
    /// which is how a fingertip reads — compression then release, not a
    /// flash. Runs before the event so the visual leads the reaction by a
    /// frame or two, the way a real press does.
    static func clickFlourish(durationSeconds: Double = 0.42) {
        guard let p = CGEvent(source: nil)?.location,
              let screen = NSScreen.screens.first(where: {
                  $0.frame.contains(CGPoint(x: p.x, y: $0.frame.maxY - p.y))
              }) ?? NSScreen.main else { return }

        let r: CGFloat = 46
        let flipped = CGPoint(x: p.x, y: screen.frame.maxY - p.y)
        let panel = NSPanel(contentRect: NSRect(x: flipped.x - r, y: flipped.y - r,
                                                width: r * 2, height: r * 2),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        let host = NSView(frame: panel.contentView!.bounds)
        host.wantsLayer = true
        panel.contentView = host

        let ring = CAShapeLayer()
        let box = CGRect(x: r - 17, y: r - 17, width: 34, height: 34)
        ring.path = CGPath(ellipseIn: box, transform: nil)
        ring.fillColor = Brand.accent.withAlphaComponent(0.22).cgColor
        ring.strokeColor = Brand.accent.cgColor
        ring.lineWidth = 2.5
        ring.frame = host.bounds
        ring.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        host.layer?.addSublayer(ring)

        // Squash then rebound past rest, then settle — the shape of a
        // press. A single scale-down reads as the UI shrinking, not as a
        // finger landing.
        let squash = CAKeyframeAnimation(keyPath: "transform.scale")
        squash.values = [1.0, 0.55, 1.22, 1.0]
        squash.keyTimes = [0, 0.28, 0.62, 1.0]
        squash.timingFunctions = [
            CAMediaTimingFunction(name: .easeIn),
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeOut),
        ]
        squash.duration = durationSeconds

        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0.0, 1.0, 0.9, 0.0]
        fade.keyTimes = [0, 0.18, 0.55, 1.0]
        fade.duration = durationSeconds

        let group = CAAnimationGroup()
        group.animations = [squash, fade]
        group.duration = durationSeconds
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        ring.add(group, forKey: "click")

        panel.orderFrontRegardless()
        let deadline = Date().addingTimeInterval(durationSeconds)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.012))
        }
        panel.orderOut(nil)
    }

    // MARK: Annotation

    /// A radar ping and a marching-ants border.
    ///
    /// Presentation tools converge on these two for the same reason: an
    /// expanding ring draws the eye to a point without hiding what is
    /// underneath, and a moving dash says "this one" in a way a static box
    /// does not on a busy screen. Both are Core Animation, so they run on
    /// the render thread and stay smooth while the process is otherwise
    /// blocked.
    private static func annotate(_ rect: CGRect, label: String, holdSeconds: Double) {
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(
            CGPoint(x: rect.midX, y: $0.frame.maxY - rect.midY)) }) ?? NSScreen.main else { return }

        // Accessibility gives top-left origin; NSWindow wants bottom-left.
        let flipped = CGRect(x: rect.origin.x,
                             y: screen.frame.maxY - rect.origin.y - rect.height,
                             width: rect.width, height: rect.height)
        let pad: CGFloat = 60  // room for the ping to expand past the target
        let panel = NSPanel(contentRect: flipped.insetBy(dx: -pad, dy: -pad),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        let host = NSView(frame: panel.contentView!.bounds)
        host.wantsLayer = true
        panel.contentView = host

        let box = CGRect(x: pad, y: pad, width: rect.width, height: rect.height)
        let accent = Brand.accent

        // Marching ants.
        let border = CAShapeLayer()
        border.path = CGPath(roundedRect: box.insetBy(dx: -3, dy: -3),
                             cornerWidth: Brand.Radius.base, cornerHeight: Brand.Radius.base, transform: nil)
        border.fillColor = accent.withAlphaComponent(0.10).cgColor
        border.strokeColor = accent.cgColor
        border.lineWidth = 2.5
        border.lineDashPattern = [7, 4]
        host.layer?.addSublayer(border)

        let ants = CABasicAnimation(keyPath: "lineDashPhase")
        ants.fromValue = 0; ants.toValue = 11
        ants.duration = 0.55
        ants.repeatCount = .infinity
        border.add(ants, forKey: "ants")

        // Radar ping, twice, offset so the second starts as the first fades.
        for delay in [0.0, 0.5] {
            let ping = CAShapeLayer()
            ping.path = CGPath(roundedRect: box.insetBy(dx: -3, dy: -3),
                               cornerWidth: Brand.Radius.base, cornerHeight: Brand.Radius.base, transform: nil)
            ping.fillColor = NSColor.clear.cgColor
            ping.strokeColor = accent.cgColor
            ping.lineWidth = 2
            ping.opacity = 0
            host.layer?.addSublayer(ping)

            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 1.0; grow.toValue = 1.9
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.85; fade.toValue = 0.0

            let group = CAAnimationGroup()
            group.animations = [grow, fade]
            group.duration = 1.0
            group.beginTime = CACurrentMediaTime() + delay
            group.repeatCount = 2
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            group.isRemovedOnCompletion = false
            // Scale about the target, not the layer's corner.
            ping.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            ping.frame = host.bounds
            ping.add(group, forKey: "ping")
        }

        if !label.isEmpty { addLabel(label, to: host, above: box, accent: accent) }

        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            panel.animator().alphaValue = 1
        }

        // The process is a one-shot CLI: without pumping the run loop the
        // window would never render before it exits.
        let deadline = Date().addingTimeInterval(holdSeconds)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            panel.animator().alphaValue = 0
        }
        let fadeEnd = Date().addingTimeInterval(0.26)
        while Date() < fadeEnd {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        panel.orderOut(nil)
    }

    /// A pill above the target naming what was chosen, so a wrong pick is
    /// obvious rather than merely mysterious.
    private static func addLabel(_ text: String, to host: NSView, above box: CGRect, accent: NSColor) {
        // Meta type — mono, uppercase, tracked — because this names a
        // thing rather than saying something about it.
        let field = NSTextField(labelWithString: "")
        field.attributedStringValue = Brand.metaString(text, size: 10.5, color: .white)
        field.alignment = .center
        field.sizeToFit()

        let w = field.frame.width + 18, h = field.frame.height + 8
        // Below the target when there is no room above, so a control near
        // the top of the screen still gets a readable label.
        let above = box.maxY + 8 + h < host.bounds.height
        let y = above ? box.maxY + 8 : box.minY - h - 8
        let pill = NSView(frame: NSRect(x: box.midX - w / 2, y: y, width: w, height: h))
        pill.wantsLayer = true
        pill.layer?.backgroundColor = accent.cgColor
        pill.layer?.cornerRadius = Brand.Radius.sm
        field.frame = NSRect(x: 9, y: 4, width: field.frame.width, height: field.frame.height)
        pill.addSubview(field)
        host.addSubview(pill)

        let rise = CABasicAnimation(keyPath: "position.y")
        rise.fromValue = (pill.layer?.position.y ?? 0) + (above ? -6 : 6)
        rise.toValue = pill.layer?.position.y ?? 0
        rise.duration = 0.22
        rise.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pill.layer?.add(rise, forKey: "rise")
    }
}
