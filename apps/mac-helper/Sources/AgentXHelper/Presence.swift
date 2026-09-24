import AppKit

/// An agent's own cursor on screen: its colour, its initial, its name.
///
/// Drawn, never driven. `point` moves the person's real mouse, which is
/// right for a lesson the person watches and wrong for one they take part
/// in — their hand is on that mouse. This cursor is a click-through window
/// that glides to what the agent means, highlights it, and says a line in
/// a bubble, while the real pointer stays exactly where the person left it.
///
/// Driven over stdin, one JSON object per line, like the HUD:
///
///   {"cmd":"move","x":120,"y":80,"w":90,"h":24,"highlight":true}
///   {"cmd":"say","text":"The export button is top right."}
///   {"cmd":"clear"}   drop the highlight
///   {"cmd":"park"}    rest in the bottom-right corner, no highlight
///   {"cmd":"ping"}    nothing; keeps an idle overlay alive
///
/// Coordinates are accessibility coordinates (top-left origin, global),
/// the same as `read`, `ocr` and `point`.
///
/// It never outlives its owner: EOF, the owner's death (`--parent`, or
/// being re-parented to launchd) or `--idle` seconds without a command
/// fade everything out and exit. One process draws one cursor, on one
/// screen; it follows across Spaces but is never duplicated per display.
enum Presence {

    // MARK: Geometry

    /// Accessibility → AppKit. Global AX coordinates are measured from the
    /// top of the PRIMARY display, whichever screen the point is on.
    static func toAppKit(_ p: CGPoint) -> CGPoint {
        let h = NSScreen.screens.first?.frame.maxY ?? 0
        return CGPoint(x: p.x, y: h - p.y)
    }

    static func toAppKit(_ r: CGRect) -> CGRect {
        let o = toAppKit(CGPoint(x: r.minX, y: r.maxY))
        return CGRect(x: o.x, y: o.y, width: r.width, height: r.height)
    }

    // MARK: Windows

    private static func panel(_ rect: NSRect) -> NSPanel {
        let p = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .screenSaver
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        // Click-through: the person's clicks land on the app underneath.
        p.ignoresMouseEvents = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        return p
    }

    /// The arrow, the initial badge, the name, and the speech bubble.
    private final class AvatarView: NSView {
        let color: NSColor
        let initial: String
        let name: String
        let bubble = NSTextField(wrappingLabelWithString: "")
        /// The bubble's background, so the text gets padding.
        let box = NSView()
        /// Wide on both sides of the tip, so the bubble can sit to the left
        /// when the target is near the right edge of the screen.
        static let size = NSSize(width: 720, height: 170)
        /// The arrow tip, in view coordinates (bottom-left origin).
        static let tip = NSPoint(x: 360, y: size.height - 6)
        var bubbleLeft = false { didSet { if bubbleLeft != oldValue { layoutBubble() } } }

        init(color: NSColor, initial: String, name: String) {
            self.color = color; self.initial = initial; self.name = name
            super.init(frame: NSRect(origin: .zero, size: AvatarView.size))
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
        }
        required init?(coder: NSCoder) { fatalError() }

        /// Under the badge and name, never over them.
        func setBubble(_ text: String) {
            box.isHidden = text.isEmpty
            bubble.stringValue = text
            let textW: CGFloat = 300
            bubble.preferredMaxLayoutWidth = textW
            let fit = bubble.sizeThatFits(NSSize(width: textW, height: 90))
            let w = min(textW, ceil(fit.width)), h = min(90, ceil(fit.height))
            bubble.frame = NSRect(x: 10, y: 6, width: w, height: h)
            box.setFrameSize(NSSize(width: w + 20, height: h + 12))
            layoutBubble()
        }

        func layoutBubble() {
            let t = AvatarView.tip, s = box.frame.size
            box.setFrameOrigin(NSPoint(x: bubbleLeft ? t.x - s.width - 4 : t.x + 16, y: t.y - 58 - s.height))
        }

        override func draw(_ dirtyRect: NSRect) {
            let t = AvatarView.tip
            // The arrow: the system cursor's silhouette, in the agent's colour.
            let arrow = NSBezierPath()
            arrow.move(to: t)
            arrow.line(to: NSPoint(x: t.x, y: t.y - 26))
            arrow.line(to: NSPoint(x: t.x + 7, y: t.y - 20))
            arrow.line(to: NSPoint(x: t.x + 12, y: t.y - 30))
            arrow.line(to: NSPoint(x: t.x + 16, y: t.y - 28))
            arrow.line(to: NSPoint(x: t.x + 11, y: t.y - 18))
            arrow.line(to: NSPoint(x: t.x + 20, y: t.y - 18))
            arrow.close()
            NSGraphicsContext.current?.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 4
            shadow.shadowOffset = NSSize(width: 0, height: -1)
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
            shadow.set()
            color.setFill(); arrow.fill()
            NSGraphicsContext.current?.restoreGraphicsState()
            NSColor.white.setStroke(); arrow.lineWidth = 1.5; arrow.stroke()

            // The badge with the initial, and the name pill beside it.
            let badge = NSRect(x: t.x + 16, y: t.y - 50, width: 24, height: 24)
            color.setFill(); NSBezierPath(ovalIn: badge).fill()
            NSColor.white.setStroke()
            let ring = NSBezierPath(ovalIn: badge.insetBy(dx: 0.75, dy: 0.75)); ring.lineWidth = 1.5; ring.stroke()
            draw(initial, in: badge, size: 11, weight: .bold, color: .white)

            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .semibold)]
            let nameW = (name as NSString).size(withAttributes: attrs).width + 14
            let pill = NSRect(x: badge.maxX + 4, y: badge.minY + 3, width: nameW, height: 18)
            color.setFill(); NSBezierPath(roundedRect: pill, xRadius: 9, yRadius: 9).fill()
            draw(name, in: pill, size: 11, weight: .semibold, color: .white)
        }

        private func draw(_ s: String, in r: NSRect, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
            let sz = (s as NSString).size(withAttributes: a)
            (s as NSString).draw(at: NSPoint(x: r.midX - sz.width / 2, y: r.midY - sz.height / 2), withAttributes: a)
        }
    }

    // MARK: Behaviour

    private final class Controller {
        let avatar: NSPanel
        let view: AvatarView
        let ring: NSPanel
        let color: NSColor
        var at: CGPoint          // tip position, AppKit coordinates
        var timer: Timer?

        init(color: NSColor, initial: String, name: String) {
            self.color = color
            view = AvatarView(color: color, initial: initial, name: name)
            avatar = Presence.panel(NSRect(origin: .zero, size: AvatarView.size))
            avatar.contentView = view
            ring = Presence.panel(.zero)
            let ringView = NSView()
            ringView.wantsLayer = true
            ringView.layer?.borderWidth = 3
            ringView.layer?.borderColor = color.cgColor
            ringView.layer?.cornerRadius = 8
            ringView.layer?.backgroundColor = color.withAlphaComponent(0.10).cgColor
            ring.contentView = ringView
            at = Controller.parking()
            place(at)
            avatar.alphaValue = 0
            avatar.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { $0.duration = 0.2; avatar.animator().alphaValue = 1 }
        }

        static func parking() -> CGPoint {
            let v = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            return CGPoint(x: v.maxX - 380, y: v.minY + 170)
        }

        func place(_ tip: CGPoint) {
            avatar.setFrameOrigin(NSPoint(x: tip.x - AvatarView.tip.x, y: tip.y - AvatarView.tip.y))
            let screen = NSScreen.screens.first(where: { $0.frame.contains(tip) }) ?? NSScreen.main
            view.bubbleLeft = (screen?.visibleFrame.maxX ?? .greatestFiniteMagnitude) - tip.x < 360
        }

        /// Glide with minimum-jerk easing; duration follows distance, as in
        /// Pointer, so a long move reads as a reach and a short one as a nudge.
        func glide(to target: CGPoint) {
            timer?.invalidate()
            let from = at
            let d = hypot(target.x - from.x, target.y - from.y)
            let duration = min(0.9, max(0.2, 0.12 + d / 2200))
            let start = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
                guard let self else { t.invalidate(); return }
                let u = min(1, Date().timeIntervalSince(start) / duration)
                let e = 10 * pow(u, 3) - 15 * pow(u, 4) + 6 * pow(u, 5)
                self.at = CGPoint(x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e)
                self.place(self.at)
                if u >= 1 { t.invalidate() }
            }
        }

        func highlight(_ rect: CGRect?) {
            guard let rect else { ring.orderOut(nil); return }
            ring.setFrame(Presence.toAppKit(rect).insetBy(dx: -6, dy: -6), display: true)
            ring.orderFrontRegardless()
            avatar.orderFrontRegardless()
        }

        func handle(_ obj: [String: Any]) {
            switch obj["cmd"] as? String {
            case "move":
                guard let x = obj["x"] as? Double, let y = obj["y"] as? Double else { return }
                let w = obj["w"] as? Double ?? 0, h = obj["h"] as? Double ?? 0
                let rect = CGRect(x: x, y: y, width: w, height: h)
                // Aim just inside the control's lower-left third, so the
                // arrow points AT it rather than covering its label.
                let aim = CGPoint(x: x + min(w * 0.5, 24), y: y + h * 0.7)
                glide(to: Presence.toAppKit(aim))
                highlight((obj["highlight"] as? Bool ?? false) && w > 0 && h > 0 ? rect : nil)
            case "say":
                view.setBubble(obj["text"] as? String ?? "")
            case "clear":
                highlight(nil)
            case "park":
                highlight(nil)
                glide(to: Controller.parking())
            default:
                break
            }
        }

        func fadeOut(_ done: @escaping () -> Void) {
            ring.orderOut(nil)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                avatar.animator().alphaValue = 0
            } completionHandler: { done() }
        }
    }

    static func color(hex: String?) -> NSColor {
        guard let hex, hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else {
            return Brand.primaryBright
        }
        return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                       blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }

    /// Read commands until stdin closes, the owner dies, or it goes idle.
    static func run(name: String, initial: String, colorHex: String?, parent: pid_t?, idle: TimeInterval) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let ctl = Controller(color: color(hex: colorHex), initial: initial, name: name)
        var lastCommand = Date()
        var quitting = false
        // Main thread only. The fade is a courtesy: exit follows regardless.
        func quit() {
            if quitting { return }
            quitting = true
            ctl.fadeOut { exit(0) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
        }
        DispatchQueue(label: "tn.acme.agentx.presence.stdin").async {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { lastCommand = Date(); ctl.handle(obj) }
            }
            DispatchQueue.main.async { quit() }
        }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            let orphaned = getppid() == 1 || (parent.map { kill($0, 0) != 0 && errno == ESRCH } ?? false)
            let idled = idle > 0 && Date().timeIntervalSince(lastCommand) > idle
            if orphaned || idled { quit() }
        }
        app.run()
    }
}
