import AppKit

/// What play mode (#505) draws over the picture: the page's colour where
/// words are gone, the pieces that moved, the cloth, and the character. The context is flipped,
/// in the picture's points.
enum PlayDraw {
    static func draw(_ frame: Play.Frame, in ctx: CGContext, stops: [NSColor], cutouts: PlayCutouts?) {
        for gone in frame.gone {
            let c = gone.paper
            ctx.setFillColor(CGColor(srgbRed: CGFloat(c >> 16 & 0xFF) / 255, green: CGFloat(c >> 8 & 0xFF) / 255,
                                     blue: CGFloat(c & 0xFF) / 255, alpha: 1))
            ctx.fill(cg(gone.rect))
        }
        for piece in frame.pieces {
            let from = cg(piece.from)
            guard let part = cutouts?.image(from, paper: piece.paper) else { continue }
            ctx.saveGState()
            ctx.translateBy(x: piece.at.x + from.width / 2, y: piece.at.y + from.height / 2)
            ctx.rotate(by: piece.turn)
            // The context is flipped; a picture is not.
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(part, in: CGRect(x: -from.width / 2, y: -from.height / 2, width: from.width, height: from.height))
            ctx.restoreGState()
        }
        if let cloth = frame.cloth {
            let path = CGPath(roundedRect: cg(cloth), cornerWidth: 4, cornerHeight: 4, transform: nil)
            ctx.addPath(path)
            ctx.setFillColor(stops[4].cgColor)
            ctx.fillPath()
            ctx.addPath(path)
            ctx.setStrokeColor(stops[1].cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }
        let shown = CharacterSim.Frame(pose: frame.pose, x: frame.at.x, face: frame.face, t: frame.t)
        CharacterDraw.draw(shown, in: ctx, edge: CGPoint(x: frame.at.x, y: frame.at.y), origin: 0,
                           unit: CGFloat(PlayMath.unit * frame.scale), stops: stops)
    }

    private static func cg(_ r: PlayMath.Rect) -> CGRect { CGRect(x: r.x, y: r.y, width: r.w, height: r.h) }
}

/// The pieces of the picture that move, each cut out once: the ink alone,
/// the page's colour around it left out (`PlayMath.ink`).
final class PlayCutouts {
    private let picture: CGImage
    /// Pixels of the picture per point.
    private let scale: CGFloat
    private var made: [[CGFloat]: CGImage] = [:]

    init(picture: CGImage, scale: CGFloat) {
        self.picture = picture
        self.scale = scale
    }

    /// The part of the picture at `from` (points), without its paper.
    func image(_ from: CGRect, paper: UInt32) -> CGImage? {
        let key = [from.minX, from.minY, from.width, from.height]
        if let done = made[key] { return done }
        guard let part = picture.cropping(to: from.applying(CGAffineTransform(scaleX: scale, y: scale))),
              let ctx = CGContext(data: nil, width: part.width, height: part.height, bitsPerComponent: 8, bytesPerRow: part.width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = ctx.data else { return nil }
        ctx.draw(part, in: CGRect(x: 0, y: 0, width: part.width, height: part.height))
        let px = data.bindMemory(to: UInt8.self, capacity: part.width * part.height * 4)
        for i in stride(from: 0, to: part.width * part.height * 4, by: 4) {
            let a = PlayMath.ink(r: px[i], g: px[i + 1], b: px[i + 2], paper: paper)
            // Premultiplied: the colour fades with it.
            for k in 0..<3 { px[i + k] = UInt8(Double(px[i + k]) * a) }
            px[i + 3] = UInt8(255 * a)
        }
        let image = ctx.makeImage()
        made[key] = image
        return image
    }
}

/// The stage: a frozen picture of the screen laid over everything, with
/// the character playing on it. The real page is never touched: nothing
/// is clicked, typed or changed, and what looks eaten or wiped is only
/// painted over on the picture.
///
/// The page behind goes stale while the picture is up, so play ends on
/// the first real input: any key, a click, a scroll, another app or Space
/// coming forward. Unlike the character on its edge, this window does
/// take keys and clicks, for that one purpose.
@MainActor
final class PlayHost {
    private var window: NSPanel?
    private var timer: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var script: Play?
    private var began = 0.0
    /// Raised by each `start`, so a text read that outlives its play can
    /// tell that the picture now up is not the one it read.
    private(set) var number = 0
    /// Told each time a play is over.
    var onEnd: (() -> Void)?

    var running: Bool { window != nil }

    /// Lay `picture` over `screen`, the character waiting at `foot` (the
    /// picture's points) until `play(_:)` gives it a script: reading the
    /// text takes a moment, and the page must not move meanwhile.
    func start(picture: CGImage, on screen: NSScreen, stops: [NSColor], at foot: PlayMath.Point) {
        guard !running else { return }
        script = nil
        number += 1
        let panel = PlayWindow(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.hasShadow = false
        panel.hidesOnDeactivate = false

        let bounds = NSRect(origin: .zero, size: screen.frame.size)
        let backdrop = NSView(frame: bounds)
        backdrop.wantsLayer = true
        backdrop.layer?.contents = picture
        let view = PlayView(frame: bounds)
        view.stops = stops
        view.picture = picture
        // As big as on its edge, where it stood: it shrinks once it jumps (#580).
        view.shown = Play.Frame(at: foot, pose: CharacterMath.pose(.working), scale: PlayMath.edge)
        view.onInput = { [weak self] in self?.end("a key or a click") }
        backdrop.addSubview(view)
        panel.contentView = backdrop
        panel.setFrame(screen.frame, display: true)
        window = panel
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(view)

        func watch(_ center: NotificationCenter, _ name: Notification.Name, _ object: Any?, _ why: String) {
            observers.append((center, center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.end(why) }
            }))
        }
        watch(.default, NSWindow.didResignKeyNotification, panel, "another window came forward")
        watch(NSWorkspace.shared.notificationCenter, NSWorkspace.activeSpaceDidChangeNotification, nil, "the Space changed")
        // macOS says this for more than a screen plugged or resized: the
        // Dock moving, the display's brightness range changing. The picture
        // is stale only if its own screen is gone or has another size (#586).
        let frame = PlayMath.Rect(screen.frame)
        observers.append((.default, NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                if PlayMath.gone(frame, from: NSScreen.screens.map { PlayMath.Rect($0.frame) }) { self?.end("the screens changed") }
            }
        }))

        let shownAt = ProcessInfo.processInfo.systemUptime
        let frames = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self, weak view] _ in
            MainActor.assumeIsolated {
                guard let self, let view else { return }
                let now = ProcessInfo.processInfo.systemUptime
                if let script = self.script {
                    view.shown = script.frame(at: now - self.began)
                } else {
                    // Its thinking dots hop while it waits.
                    view.shown.t = now - shownAt
                }
                view.needsDisplay = true
                if view.shown.done { self.end("the script ended") }
            }
        }
        RunLoop.main.add(frames, forMode: .common)
        timer = frames
    }

    /// The script to play on the picture that is up. Nothing happens if
    /// the play has ended meanwhile.
    func play(_ script: Play) {
        guard running, self.script == nil else { return }
        self.script = script
        began = ProcessInfo.processInfo.systemUptime
        Log.info("play: started, \(script.lines.count) lines read, \(String(format: "%.1f", script.duration)) s")
    }

    /// Take the picture away and drop it. Safe to call when no play runs.
    func end(_ why: String) {
        guard let panel = window else { return }
        window = nil
        timer?.invalidate()
        timer = nil
        for (center, observer) in observers { center.removeObserver(observer) }
        observers = []
        // The character is back on its edge before the picture goes, so
        // it is never off the screen in between (#580).
        onEnd?()
        panel.orderOut(nil)
        panel.contentView?.layer?.contents = nil
        panel.contentView = nil
        Log.info("play: ended, \(why)")
    }
}

/// Borderless, and still able to take the keys that end the play.
private final class PlayWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The drawing over the picture. Every key, click and scroll ends the play.
private final class PlayView: NSView {
    var shown = Play.Frame()
    var stops = CharacterDraw.stops(tint: Brand.accent, colors: nil)
    /// The picture under it: moved pieces are cut from it.
    var picture: CGImage? { didSet { cutouts = nil } }
    private var cutouts: PlayCutouts?
    var onInput: (() -> Void)?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        if cutouts == nil, let picture {
            cutouts = PlayCutouts(picture: picture, scale: CGFloat(picture.width) / max(bounds.width, 1))
        }
        PlayDraw.draw(shown, in: ctx, stops: stops, cutouts: cutouts)
    }

    override func keyDown(with event: NSEvent) { onInput?() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool { onInput?(); return true }
    override func mouseDown(with event: NSEvent) { onInput?() }
    override func rightMouseDown(with event: NSEvent) { onInput?() }
    override func otherMouseDown(with event: NSEvent) { onInput?() }
    override func scrollWheel(with event: NSEvent) { onInput?() }
}

private extension PlayMath.Rect {
    init(_ r: NSRect) { self.init(x: r.minX, y: r.minY, w: r.width, h: r.height) }
}
