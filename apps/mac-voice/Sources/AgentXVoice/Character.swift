import AppKit

/// The character (#458): the orb grown into a small creature, in the
/// agent's palette, with two eyes, no mouth and no legs. It hovers above
/// the bottom edge of the screen, shows what the assistant is doing, and
/// gets out of the pointer's way. Chosen with `voice.look`; the orb stays
/// the default.
///
/// It reacts and never interrupts: its window takes no clicks and no
/// keys, and never comes forward by itself. With Reduce Motion on, or
/// "Animated orb" off in the menu, it is a still picture that changes
/// between states and stays where it rests.
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
        if shown && timer == nil { tick() }
    }

    /// The frames run only while it is on screen and may move.
    private func run() {
        timer?.invalidate()
        timer = nil
        guard shown else { window.orderOut(nil); return }
        tick()
        window.orderFrontRegardless()
        guard animated, !reduceMotion else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // Keeps moving while a menu is open or the pill is dragged.
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    private func tick() {
        // The screen with the menu bar, less the menu bar and the Dock.
        guard let screen = NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        // It rests under the right end of its bubble, the bubble in the
        // pill's own corner, and goes no further right.
        let left = Double(visible.minX + 44)
        let home = max(Double(visible.maxX - PillPlacement.inset - PillPlacement.bubbleReach), left)
        let range = left...home

        let frame: CharacterSim.Frame
        if timer == nil {
            frame = CharacterSim.still(activity, home: home)
        } else {
            if activity == .listening, let read = levelSource {
                level = OrbMath.smooth(level, toward: OrbMath.level(fromRMS: read()))
            } else {
                level = 0
            }
            let mouse = pointerSource()
            let pointer = screen.frame.contains(mouse) ? (x: Double(mouse.x), y: Double(mouse.y - visible.minY)) : nil
            // The gap its tail fills counts as the bubble, so a pointer a
            // little under a button does not send both away.
            let held = bubbleFrame?.insetBy(dx: 0, dy: -PillPlacement.tail).contains(mouse) ?? false
            frame = sim.step(to: ProcessInfo.processInfo.systemUptime,
                             CharacterSim.Input(activity: activity, level: level, pointer: pointer, held: held,
                                                home: home, range: range))
        }
        let origin = NSPoint(x: (CGFloat(frame.x) - Self.size.width / 2).rounded(), y: visible.minY - Self.ground)
        if window.frame.origin != origin { window.setFrameOrigin(origin) }
        // The bubble goes with the window, so the two move as one.
        bubbleFrame = bubble?(NSPoint(x: origin.x + Self.size.width / 2, y: visible.minY + Self.head), visible)
        view.bubble = bubbleFrame?.offsetBy(dx: -origin.x, dy: -origin.y)
        view.origin = origin.x
        view.shown = frame
        view.needsDisplay = true
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

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

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
