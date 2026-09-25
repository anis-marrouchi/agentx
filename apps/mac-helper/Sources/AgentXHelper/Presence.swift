import AppKit

/// An agent's own cursor on screen: its colour, its initial, its name.
///
/// Drawn, never driven. `point` moves the person's real mouse, which is
/// right for a lesson the person watches and wrong for one they take part
/// in — their hand is on that mouse. This cursor is a click-through arrow
/// that glides to what the agent means, highlights it, and says a line in
/// a bubble, while the real pointer stays exactly where the person left it.
///
/// Driven over stdin, one JSON object per line, like the HUD:
///
///   {"cmd":"move","x":120,"y":80,"w":90,"h":24,"highlight":true}
///   {"cmd":"say","text":"The export button is top right."}
///   {"cmd":"clear"}   drop the highlight
///   {"cmd":"park"}    return beside the person's own pointer, no highlight
///   {"cmd":"ping"}    nothing; keeps an idle overlay alive
///
/// Coordinates are accessibility coordinates (top-left origin, global),
/// the same as `read`, `ocr` and `point`.
///
/// Only the arrow and highlight are click-through. The name tag and bubble
/// (PresenceTag) can be dragged out of the way; with `--pos-file` the spot
/// is remembered for this agent and the tag stays there on later turns.
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

    /// Floating, not screen-saver level: above the windows the person works
    /// in, below menus, alerts and Spotlight.
    fileprivate static func panel(_ rect: NSRect, clickThrough: Bool = true) -> NSPanel {
        let p = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        // The arrow and the highlight are click-through: the person's clicks
        // land on the app underneath. Only the name tag takes the mouse.
        p.ignoresMouseEvents = clickThrough
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        return p
    }

    /// The arrow alone: the system cursor's silhouette, in the agent's colour.
    private final class ArrowView: NSView {
        let color: NSColor
        static let size = NSSize(width: 30, height: 40)
        /// The arrow tip, in view coordinates (bottom-left origin).
        static let tip = NSPoint(x: 4, y: size.height - 4)

        init(color: NSColor) {
            self.color = color
            super.init(frame: NSRect(origin: .zero, size: ArrowView.size))
        }
        required init?(coder: NSCoder) { fatalError() }

        override func draw(_ dirtyRect: NSRect) {
            let t = ArrowView.tip
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
        }
    }

    // MARK: Pinned position

    /// Where the person dragged this agent's tag: its top-left, AppKit
    /// coordinates, as {"x":…,"y":…}. Ignored if no screen shows it any more.
    static func loadPin(_ file: String?) -> NSPoint? {
        guard let file, let data = FileManager.default.contents(atPath: file),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let x = o["x"] as? Double, let y = o["y"] as? Double else { return nil }
        let p = NSPoint(x: x, y: y)
        // The badge row hangs below the top-left; it must be on a screen.
        let row = NSPoint(x: x + 12, y: y - 12)
        return NSScreen.screens.contains(where: { $0.frame.contains(row) }) ? p : nil
    }

    static func savePin(_ p: NSPoint?, to file: String?) {
        guard let file else { return }
        guard let p else { try? FileManager.default.removeItem(atPath: file); return }
        let url = URL(fileURLWithPath: file)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: ["x": Double(p.x), "y": Double(p.y)])
            try data.write(to: url, options: .atomic)
        } catch {
            FileHandle.standardError.write("presence: could not save position: \(error)\n".data(using: .utf8)!)
        }
    }

    // MARK: Behaviour

    private final class Controller {
        let arrow: NSPanel
        let tagPanel: NSPanel
        let tag: PresenceTag
        let ring: NSPanel
        let color: NSColor
        let posFile: String?
        var at: CGPoint          // tip position, AppKit coordinates
        /// The tag's top-left once the person has dragged it; nil rides with the arrow.
        var pinned: NSPoint?
        var timer: Timer?

        init(color: NSColor, initial: String, name: String, posFile: String?) {
            self.color = color
            self.posFile = posFile
            arrow = Presence.panel(NSRect(origin: .zero, size: ArrowView.size))
            arrow.contentView = ArrowView(color: color)
            tag = PresenceTag(color: color, initial: initial, name: name)
            tagPanel = Presence.panel(NSRect(origin: .zero, size: tag.frame.size), clickThrough: false)
            tagPanel.contentView = tag
            ring = Presence.panel(.zero)
            let ringView = NSView()
            ringView.wantsLayer = true
            ringView.layer?.borderWidth = 3
            ringView.layer?.borderColor = color.cgColor
            ringView.layer?.cornerRadius = 8
            ringView.layer?.backgroundColor = color.withAlphaComponent(0.10).cgColor
            ring.contentView = ringView
            pinned = Presence.loadPin(posFile)
            at = Controller.parking()
            tag.onPin = { [weak self] p in self?.pinned = p; Presence.savePin(p, to: posFile) }
            tag.onUnpin = { [weak self] in
                guard let self else { return }
                self.pinned = nil
                Presence.savePin(nil, to: posFile)
                self.place(self.at)
            }
            place(at)
            for p in [arrow, tagPanel] {
                p.alphaValue = 0
                p.orderFrontRegardless()
            }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                arrow.animator().alphaValue = 1
                tagPanel.animator().alphaValue = 1
            }
        }

        /// Just below and right of the person's real pointer, so handing
        /// back reads as returning to them, without covering their cursor.
        static func parking() -> CGPoint {
            let m = NSEvent.mouseLocation
            let v = (NSScreen.screens.first(where: { $0.frame.contains(m) }) ?? NSScreen.main)?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            return CGPoint(x: min(max(m.x + 28, v.minX), v.maxX - 40), y: min(max(m.y - 28, v.minY + 40), v.maxY))
        }

        func place(_ tip: CGPoint) {
            arrow.setFrameOrigin(NSPoint(x: tip.x - ArrowView.tip.x, y: tip.y - ArrowView.tip.y))
            if tag.dragged { return }
            let size = tagPanel.frame.size
            var top = pinned ?? NSPoint(x: tip.x + 20, y: tip.y - 26)
            if pinned == nil {
                // Near the right edge the tag sits to the left of the arrow.
                let screen = NSScreen.screens.first(where: { $0.frame.contains(tip) }) ?? NSScreen.main
                if let edge = screen?.visibleFrame.maxX, top.x + size.width > edge { top.x = tip.x - 4 - size.width }
            }
            tagPanel.setFrameOrigin(NSPoint(x: top.x, y: top.y - size.height))
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
            arrow.orderFrontRegardless()
            tagPanel.orderFrontRegardless()
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
                tag.setBubble(obj["text"] as? String ?? "")
                place(at)
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
                arrow.animator().alphaValue = 0
                tagPanel.animator().alphaValue = 0
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
    static func run(name: String, initial: String, colorHex: String?, parent: pid_t?, idle: TimeInterval,
                    posFile: String? = nil) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let ctl = Controller(color: color(hex: colorHex), initial: initial, name: name, posFile: posFile)
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
