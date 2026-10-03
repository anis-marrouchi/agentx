import AppKit

/// Guiding (#482): the daemon's /voice/guide route, the wait on it, and
/// the mark the character leaves on what it shows. Where it stands is in
/// GuideMath.swift; Character.swift moves it there.
enum GuideClient {
    struct Command: Decodable {
        struct Rect: Decodable { let x, y, width, height: Double }
        let seq: Int
        /// Nil: back to where it rests.
        let rect: Rect?
        let mark: String
        /// What its bubble says at the stop (#562). Nil: no bubble there,
        /// and a daemon too old to send one.
        let text: String?
        /// The state it shows meanwhile (#570). Nil: its real state, and
        /// a daemon too old to send one.
        let expression: String?
    }

    /// GET /voice/guide: the command after `seq`, as soon as there is
    /// one; the current one after 25 s; nil when the daemon cannot be
    /// reached or is too old to know the route.
    static func next(after seq: Int) async -> Command? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/guide?after=\(seq)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 35
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(Command.self, from: data)
    }
}

/// Waits on the daemon while the character is on screen. The wait is
/// also how the daemon knows there is a character to send.
@MainActor
final class GuideWatcher {
    private var seq = 0
    private var away = false
    private var task: Task<Void, Never>?
    /// The character is on screen.
    var wanted: (() -> Bool)?
    /// Show this, in AppKit coordinates, with this caption and in this
    /// state, or go home.
    var onCommand: ((NSRect?, GuideMath.Mark, String?, CharacterMath.Mood?) -> Void)?

    /// (Re)start the wait. Called again when the character comes on screen
    /// or leaves it, so a wait already open is ended: cancelling it closes
    /// its socket, and the daemon stops counting a character as there.
    func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.turn()
            }
        }
    }

    private func turn() async {
        guard wanted?() == true, let command = await GuideClient.next(after: seq) else {
            // Hidden, or the daemon is gone: nothing is left on screen.
            if away { away = false; onCommand?(nil, .none, nil, nil) }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            return
        }
        guard command.seq != seq else { return }
        seq = command.seq
        let rect = command.rect.map {
            GuideMath.toAppKit(CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height),
                               primaryHeight: NSScreen.screens.first?.frame.maxY ?? 0)
        }
        let asked = command.expression.flatMap { CharacterMath.Mood(rawValue: $0) }
        away = rect != nil || asked != nil
        Log.info("guide: \(rect.map { "to \(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height)) \(command.mark)" } ?? "home")\(asked.map { ", \($0.rawValue)" } ?? "")")
        onCommand?(rect, GuideMath.Mark(rawValue: command.mark) ?? .box, rect == nil ? nil : command.text, asked)
    }
}

/// What the character was sent to show (#482): it stands beside it until
/// it is sent home, taken hold of or hidden; its mark; its glide there and back.
@MainActor
final class CharacterGuide {
    private(set) var showing: NSRect?
    /// What its bubble says there (#562).
    private(set) var caption: String?
    private let mark = GuideMark()
    /// On its way up or down, to what it shows or back; and the last frame.
    private var gliding = false
    private var ticked = 0.0

    func show(_ rect: NSRect, _ kind: GuideMath.Mark, caption text: String?, color: NSColor, animated: Bool) {
        showing = rect
        caption = text
        gliding = true
        mark.show(kind, around: rect, color: color, animated: animated)
    }

    /// Back to where it rests, gliding there unless it was taken hold of.
    func end(glide: Bool = true) {
        gliding = glide && showing != nil
        showing = nil
        caption = nil
        mark.hide()
    }

    /// Where it stands beside what it shows, on that thing's screen.
    func stand(screens: [NSScreen], body: CGFloat, tall: CGFloat) -> CGPoint? {
        guard let showing, let first = screens.first else { return nil }
        let middle = CGPoint(x: showing.midX, y: showing.midY)
        return GuideMath.stand(beside: showing, in: (screens.first { $0.frame.contains(middle) } ?? first).visibleFrame,
                               body: body, tall: tall, inset: PillPlacement.characterInset)
    }

    /// Its height this frame: sent somewhere or back, it glides up or down
    /// to `y`; otherwise it is there at once.
    func height(from: CGFloat, toward y: CGFloat, now: Double, still: Bool) -> CGFloat {
        let h = gliding && !still ? GuideMath.glide(from, toward: y, dt: now - ticked) : y
        gliding = h != y
        ticked = now
        return h
    }
}

/// The mark on what the character shows: drawn on its own click-through
/// window over the page, which is never touched.
@MainActor
final class GuideMark {
    /// Room around the outline for the stroke.
    private static let margin: CGFloat = 6
    private let window: NSPanel
    private let shape = CAShapeLayer()

    init() {
        window = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.ignoresMouseEvents = true
        let view = NSView()
        view.wantsLayer = true
        view.layer?.addSublayer(shape)
        window.contentView = view
        shape.lineWidth = 3
        shape.lineCap = .round
        shape.lineJoin = .round
    }

    /// Draw `mark` around `rect`. Animated, it is drawn on once the
    /// character has had time to get there.
    func show(_ mark: GuideMath.Mark, around rect: NSRect, color: NSColor, animated: Bool) {
        // Kept to the screen it is on, whatever size it was sent.
        let screen = NSScreen.screens.first { $0.frame.intersects(rect) }?.frame ?? .null
        let outline = GuideMath.outline(mark, around: rect).intersection(screen)
        guard !outline.isNull, !outline.isEmpty else { return hide() }
        let frame = outline.insetBy(dx: -Self.margin, dy: -Self.margin)
        window.setFrame(frame, display: false)
        let inner = CGRect(x: Self.margin, y: Self.margin, width: outline.width, height: outline.height)
        let path = CGMutablePath()
        switch mark {
        case .circle: path.addEllipse(in: inner)
        case .underline: path.move(to: inner.origin); path.addLine(to: CGPoint(x: inner.maxX, y: inner.minY))
        default: path.addRoundedRect(in: inner, cornerWidth: min(6, inner.width / 2), cornerHeight: min(6, inner.height / 2))
        }
        shape.frame = CGRect(origin: .zero, size: frame.size)
        shape.path = path
        shape.strokeColor = color.cgColor
        shape.fillColor = mark == .box ? color.withAlphaComponent(0.12).cgColor : nil
        shape.removeAllAnimations()
        if animated {
            let draw = CABasicAnimation(keyPath: "strokeEnd")
            draw.fromValue = 0
            draw.toValue = 1
            draw.beginTime = CACurrentMediaTime() + 0.35
            draw.duration = 0.45
            draw.fillMode = .backwards
            draw.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            shape.add(draw, forKey: "draw")
            let appear = CABasicAnimation(keyPath: "opacity")
            appear.fromValue = 0
            appear.toValue = 1
            appear.beginTime = draw.beginTime
            appear.duration = 0.15
            appear.fillMode = .backwards
            shape.add(appear, forKey: "appear")
        }
        window.orderFrontRegardless()
    }

    func hide() {
        shape.removeAllAnimations()
        window.orderOut(nil)
    }
}
