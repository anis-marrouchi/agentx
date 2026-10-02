import AppKit

/// The character (#458): the orb grown into a small creature, in the
/// agent's palette, with two eyes, no mouth and no legs. It hovers above
/// the bottom edge of the screen, or where it was dragged to (#502),
/// shows what the assistant is doing, and gets out of the pointer's way.
/// Chosen with `voice.look`; the orb stays the default.
///
/// It reacts and never interrupts: its window takes no keys, no clicks
/// but a drag of its body with ⌘ held, and never comes forward by itself.
/// With Reduce Motion on, or "Animated orb" off in the menu, it is a
/// still picture that changes between states and stays where it rests.
@MainActor
final class CharacterHost {
    /// The body's width in points, and the room around it for its marks
    /// and for the dots it leaves behind.
    private static let diameter: CGFloat = 56
    private static let size = NSSize(width: 440, height: 150)
    /// The edge it hovers above, from the bottom of its window.
    private static let ground: CGFloat = 8
    /// Above the edge, clear of its body at the top of a hop: where its
    /// speech bubble's tail ends.
    private static let head: CGFloat = 78

    private let window: NSPanel
    private let view = CharacterView(frame: NSRect(origin: .zero, size: CharacterHost.size))
    private var sim = CharacterSim(unit: Double(CharacterHost.diameter) / 100)
    private var timer: Timer?
    private var motionObserver: NSObjectProtocol?

    private var shown = false
    /// Hidden with its bubble, until the talk key or the menu (#502).
    private var hidden = false
    private var animated = true
    private var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private var activity = CharacterMath.Activity.idle
    private var level = 0.0
    /// The microphone's RMS level, read while listening. Set by the app.
    var levelSource: (() -> Float)?
    /// Where the pointer is, in screen coordinates.
    var pointerSource: () -> NSPoint = { NSEvent.mouseLocation }
    /// Its speech bubble (#491), the pill: told every frame where the
    /// character's head is and on which screen, it answers with where the
    /// bubble is, or nil while it is hidden. Set by the app.
    var bubble: ((NSPoint, NSRect) -> NSRect?)?
    private var bubbleFrame: NSRect?

    /// Where it was dragged to: the point under it. Nil: its corner.
    private var place = Config.characterPlace
    /// Where it rests now, `place` made safe for the screens there are.
    private var rest = CGPoint.zero
    /// Its body on screen: where it can be taken hold of.
    private var body = NSRect.zero
    /// Its colours, and the point under it in screen points: play mode
    /// (#505) takes it from there.
    var stops: [NSColor] { view.stops }
    var foot: NSPoint { NSPoint(x: CGFloat(sim.x), y: rest.y) }
    /// Carried by the pointer: where the pointer took hold, and where it
    /// stood then, which is not where it rests once it has stepped aside.
    private var carried: (from: NSPoint, rest: CGPoint)?
    /// A still picture: Reduce Motion, or "Animated orb" off.
    private var still: Bool { !animated || reduceMotion }
    /// The look is the character: whether it is on screen. Nil with the orb.
    var onScreen: Bool? { shown ? !hidden : nil }

    init() {
        window = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.ignoresMouseEvents = true
        window.contentView = view
        view.onDrag = { [weak self] phase in self?.drag(phase) }
        view.unit = Self.diameter / 100
        view.edge = CGPoint(x: Self.size.width / 2, y: Self.size.height - Self.ground)
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                self.run()
            }
        }
    }

    /// `voice.look` is "character", or not.
    func setShown(_ on: Bool) {
        guard shown != on else { return }
        shown = on
        if on { sim = CharacterSim(unit: Double(Self.diameter) / 100) }
        run()
    }

    /// Hide it, as its bubble is hidden: gone until it is asked back.
    func setHidden(_ on: Bool) {
        guard hidden != on else { return }
        hidden = on
        run()
    }

    /// "Reset position" in the menu: back to its corner, forgetting where
    /// it was dragged. Not with the orb look, whose place is the pill's.
    func resetPosition() {
        guard shown else { return }
        place = nil
        Config.characterPlace = nil
        redraw()
    }

    /// `voice.stroll`: a slow walk now and then while it has nothing to do.
    var strolls = false

    /// "Animated orb" in the menu.
    func setAnimated(_ on: Bool) {
        guard animated != on else { return }
        animated = on
        run()
    }

    /// Show what the pill shows, in `colors` or in shades of `tint`.
    func show(_ activity: CharacterMath.Activity, tint: NSColor, colors: [NSColor]?) {
        self.activity = activity
        view.stops = CharacterDraw.stops(tint: tint, colors: colors)
        redraw()
    }

    /// Standing still, it is drawn again when something changes: its
    /// state, or its bubble showing or hiding.
    func redraw() {
        if shown && !hidden && still { tick() }
    }

    /// The frames run only while it is on screen and may move.
    private func run() {
        timer?.invalidate()
        timer = nil
        guard shown, !hidden else { carried = nil; window.orderOut(nil); return }
        tick()
        window.orderFrontRegardless()
        // Still, it only watches for the hand that moves it.
        let still = still
        let timer = Timer.scheduledTimer(withTimeInterval: still ? 0.1 : 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if still { self?.aim() } else { self?.tick() } }
        }
        // Keeps moving while a menu is open or the pill is dragged.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// It takes the pointer only to be moved: on its body, with ⌘ held.
    /// Any other click goes through it to the window behind.
    private func aim() {
        // The button came up where no event told of it.
        if carried != nil && NSEvent.pressedMouseButtons & 1 == 0 { drop() }
        let take = carried != nil || (NSEvent.modifierFlags.contains(.command) && body.contains(pointerSource()))
        if window.ignoresMouseEvents == take { window.ignoresMouseEvents = !take }
    }

    private func drag(_ phase: CharacterView.Drag) {
        switch phase {
        case .began:
            let mouse = pointerSource()
            if body.contains(mouse) { carried = (mouse, CGPoint(x: body.midX, y: rest.y)) }
        case .moved:
            if carried != nil { tick() }
        case .ended:
            if carried != nil { tick() }
            drop()
        }
    }

    /// Let go: where it was carried to is kept. A click alone moves nothing.
    private func drop() {
        guard let was = carried else { return }
        carried = nil
        guard pointerSource() != was.from else { return }
        place = rest
        Config.characterPlace = rest
    }

    private func tick() {
        // Where nobody put it: the screen with the menu bar, less the
        // menu bar and the Dock; under the right end of its bubble, the
        // bubble in the pill's own corner. It goes no further right.
        let screens = NSScreen.screens
        guard let first = screens.first else { return }
        let mouse = pointerSource()
        var wanted = place
        if let carried {
            wanted = CGPoint(x: carried.rest.x + mouse.x - carried.from.x, y: carried.rest.y + mouse.y - carried.from.y)
        }
        let spot = PillPlacement.character(saved: wanted, room: Self.head + PillPlacement.tail + Panel.size.height,
                                           screens: screens.map(\.visibleFrame), fallback: first.visibleFrame)
        let visible = spot.visible
        rest = spot.place
        let home = Double(rest.x)
        if carried != nil { sim.carry(to: home) }

        let frame: CharacterSim.Frame
        if still {
            frame = CharacterSim.still(activity, home: home)
        } else {
            if activity == .listening, let read = levelSource {
                level = OrbMath.smooth(level, toward: OrbMath.level(fromRMS: read()))
            } else {
                level = 0
            }
            let near = screens.first { $0.visibleFrame == visible }?.frame.contains(mouse) ?? false
            let pointer = near ? (x: Double(mouse.x), y: Double(mouse.y - rest.y)) : nil
            // The gap its tail fills counts as the bubble, so a pointer a
            // little under a button does not send both away. With ⌘ held
            // it waits too, to be taken hold of.
            let held = carried != nil
                || (bubbleFrame?.insetBy(dx: 0, dy: -PillPlacement.tail).contains(mouse) ?? false)
                || (NSEvent.modifierFlags.contains(.command) && window.frame.contains(mouse))
            frame = sim.step(to: ProcessInfo.processInfo.systemUptime,
                             CharacterSim.Input(activity: activity, level: level, pointer: pointer, held: held, strolls: strolls,
                                                plays: Config.playMode, down: NSEvent.pressedMouseButtons & 1 != 0,
                                                home: home, range: Double(spot.ends.lowerBound)...Double(spot.ends.upperBound)))
        }
        let origin = NSPoint(x: (CGFloat(frame.x) - Self.size.width / 2).rounded(), y: (rest.y - Self.ground).rounded())
        if window.frame.origin != origin { window.setFrameOrigin(origin) }
        body = NSRect(x: CGFloat(frame.x) - Self.diameter / 2, y: rest.y, width: Self.diameter, height: Self.head)
        // The bubble goes with the window, so the two move as one.
        bubbleFrame = bubble?(NSPoint(x: origin.x + Self.size.width / 2, y: origin.y + Self.ground + Self.head), visible)
        view.bubble = bubbleFrame?.offsetBy(dx: -origin.x, dy: -origin.y)
        view.origin = origin.x
        view.shown = frame
        view.needsDisplay = true
        aim()
    }
}

/// The character's drawing surface. Flipped, so the drawing's y grows
/// downwards as in the pose sheet it was ported from.
final class CharacterView: NSView {
    var shown = CharacterSim.Frame()
    var stops = CharacterDraw.stops(tint: Brand.accent, colors: nil)
    var unit: CGFloat = 0.56
    /// Under the character, in this view; and the view's left edge on screen.
    var edge = CGPoint.zero
    var origin: CGFloat = 0
    /// Its speech bubble in this window, origin bottom-left; nil while hidden.
    var bubble: NSRect?

    /// A drag of its body. Its window takes the mouse for nothing else.
    enum Drag { case began, moved, ended }
    var onDrag: ((Drag) -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onDrag?(.began) }
    override func mouseDragged(with event: NSEvent) { onDrag?(.moved) }
    override func mouseUp(with event: NSEvent) { onDrag?(.ended) }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        // The body is drawn where the window is, which follows the frame
        // to the nearest point; the rest of the way is drawn here.
        let at = CGPoint(x: CGFloat(shown.x) - origin, y: edge.y)
        CharacterDraw.draw(shown, in: ctx, edge: at, origin: origin, unit: unit, stops: stops)
        if let bubble { drawTail(in: ctx, from: bubble) }
    }

    /// The bubble's tail: a small point from its bottom edge down to the
    /// character, in the bubble's own colours.
    private func drawTail(in ctx: CGContext, from bubble: NSRect) {
        let half: CGFloat = 7, corner = Brand.Radius.lg + half
        let x = min(max(bounds.midX, bubble.minX + corner), bubble.maxX - corner)
        // One point up into the bubble, so no gap shows between the two.
        let top = bounds.height - bubble.minY - 1
        let tip = CGPoint(x: x, y: top + 1 + PillPlacement.tail)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            ctx.move(to: CGPoint(x: x - half, y: top))
            ctx.addLine(to: tip)
            ctx.addLine(to: CGPoint(x: x + half, y: top))
            ctx.closePath()
            ctx.setFillColor(NSColor.windowBackgroundColor.withAlphaComponent(0.92).cgColor)
            ctx.fillPath()
            ctx.move(to: CGPoint(x: x - half, y: top + 1))
            ctx.addLine(to: tip)
            ctx.addLine(to: CGPoint(x: x + half, y: top + 1))
            ctx.setStrokeColor(NSColor.separatorColor.cgColor)
            ctx.setLineWidth(1)
            ctx.strokePath()
        }
    }
}
