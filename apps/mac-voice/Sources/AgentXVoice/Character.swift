import AppKit

/// The character (#458): the orb grown into a small creature, in the
/// agent's palette, with two eyes, no mouth and no legs. It hovers above
/// the bottom edge of the screen, or where it was dragged to (#502),
/// shows what the assistant is doing, and gets out of the pointer's way.
/// The answering agent can send it to something on screen, which it
/// marks (#482). Chosen with `voice.look`; the orb stays the default.
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
    /// character's head is, on which screen, and how far reduced to its
    /// dots it is (0…1), it answers with where the bubble is, or nil
    /// while it is hidden. Set by the app.
    var bubble: ((NSPoint, NSRect, CGFloat) -> NSRect?)?
    private var bubbleFrame: NSRect?
    private var motion = BubbleMotion()
    /// What stands on its line (#539): the sides of the windows there,
    /// read once a second while it may stroll and play mode is ticked.
    private var edges: [Double] = []
    private var edgesRead = 0.0
    /// Its bubble holds something to use: no play with the pointer then.
    var bubbleShows: (() -> Bool)?

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
    /// What the answering agent sent it to show (#482), and its mark.
    private let guide = CharacterGuide()
    /// Sent somewhere, and what its bubble says there (#562).
    var sent: Bool { guide.showing != nil }
    var caption: String? { guide.caption }
    /// The state it was asked to show by name (#570), there or where it rests.
    private var asked: CharacterMath.Mood?
    /// Told when it is sent somewhere, to its next stop or back.
    var onGuide: (() -> Void)?
    /// A still picture: Reduce Motion, or "Animated orb" off.
    private var still: Bool { !animated || reduceMotion }
    /// The look is the character: whether it is on screen. Nil with the orb.
    var onScreen: Bool? { shown ? !hidden : nil }
    /// Told when it comes on screen or leaves it: shown or hidden, or the look changed.
    var onScreenChanged: (() -> Void)?

    init() {
        window = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true
        // One above its bubble, which never hides it (#554).
        window.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
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
        onScreenChanged?()
    }

    /// Hide it, as its bubble is hidden: gone until it is asked back.
    func setHidden(_ on: Bool) {
        guard hidden != on else { return }
        hidden = on
        run()
        onScreenChanged?()
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
    /// `voice.animations` as the wait between two small animations by
    /// itself (`IdlePlay.gap`), and AgentX's own hold, which stops them.
    var animates = 0.0
    private var quiet = false

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

    /// Go beside `rect` and mark it, or with nil go back to where it
    /// rests; in the state `asked`, or with nil its real one.
    func guide(to rect: NSRect?, mark kind: GuideMath.Mark = .none, caption: String? = nil, asked mood: CharacterMath.Mood? = nil) {
        asked = shown && !hidden ? mood : nil
        if shown, !hidden, carried == nil, let rect {
            guide.show(rect, kind, caption: caption, color: view.stops[2], animated: !still)
        } else {
            guide.end()
        }
        onGuide?()
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
        guard shown, !hidden else { carried = nil; guide(to: nil); window.orderOut(nil); return }
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
            if body.contains(mouse) { guide.end(glide: false); onGuide?(); carried = (mouse, CGPoint(x: body.midX, y: rest.y)) }
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
        } else if let beside = guide.stand(screens: screens, body: Self.diameter, tall: Self.head) {
            wanted = beside
        }
        let spot = PillPlacement.character(saved: wanted, room: Self.head + PillPlacement.tail + Panel.size.height,
                                           screens: screens.map(\.visibleFrame), fallback: first.visibleFrame)
        let visible = spot.visible
        let now = ProcessInfo.processInfo.systemUptime
        rest = CGPoint(x: spot.place.x, y: guide.height(from: rest.y, toward: spot.place.y, now: now, still: still))
        let home = Double(rest.x)
        if carried != nil { sim.carry(to: home) }

        let frame: CharacterSim.Frame
        if still {
            frame = CharacterSim.still(activity, asked: asked, sent: guide.showing != nil, home: home)
        } else {
            if activity == .listening, let read = levelSource {
                level = OrbMath.smooth(level, toward: OrbMath.level(fromRMS: read()))
            } else if asked == .listening {
                // Asked to listen, there is no microphone to follow: a slow swell.
                level = 0.45 + 0.3 * sin(now * 5)
            } else {
                level = 0
            }
            let near = screens.first { $0.visibleFrame == visible }?.frame.contains(mouse) ?? false
            // Showing something, it does not step aside for the pointer.
            let pointer = near && guide.showing == nil ? (x: Double(mouse.x), y: Double(mouse.y - rest.y)) : nil
            // The gap its tail fills counts as the bubble, so a pointer a
            // little under a button does not send both away. With ⌘ held
            // it waits too, to be taken hold of.
            let held = carried != nil
                || (bubbleFrame?.insetBy(dx: 0, dy: -PillPlacement.tail).contains(mouse) ?? false)
                || (NSEvent.modifierFlags.contains(.command) && window.frame.contains(mouse))
            if now - edgesRead >= 1 {
                edgesRead = now
                // The window list counts down from the top of the main screen.
                let top = first.frame.maxY - rest.y
                quiet = animates > 0 && Hold.isOn
                edges = strolls && Config.playMode ? Meets.edges(of: Meets.windows(), band: (top - Self.head)...top) : []
            }
            frame = sim.step(to: now,
                             CharacterSim.Input(activity: activity, level: level, pointer: pointer, held: held, sent: guide.showing != nil, asked: asked, strolls: strolls,
                                                edges: edges, shows: bubbleShows?() ?? false, plays: Config.playMode, animates: quiet ? 0 : animates, down: NSEvent.pressedMouseButtons & 1 != 0,
                                                home: home, range: Double(spot.ends.lowerBound)...Double(spot.ends.upperBound)))
        }
        let origin = NSPoint(x: (CGFloat(frame.x) - Self.size.width / 2).rounded(), y: (rest.y - Self.ground).rounded())
        if window.frame.origin != origin { window.setFrameOrigin(origin) }
        body = NSRect(x: CGFloat(frame.x) - Self.diameter / 2, y: rest.y, width: Self.diameter, height: Self.head)
        // The bubble goes with the window, so the two move as one. It
        // stays above the top of the body, a jump included, as far as the
        // screen has room, and is reduced to its dots while it moves (#554).
        let top = CGFloat(frame.pose.lift + 100 * frame.pose.sy) * Self.diameter / 100
        let room = max(visible.maxY - rest.y - PillPlacement.tail - Panel.size.height, Self.head)
        let head = min(max(top + 2 - PillPlacement.tail, Self.head), room)
        let moving = carried != nil || abs(sim.speed) > 8 || rest.y != spot.place.y || head > Self.head
        if still { motion = BubbleMotion() }
        // A caption is to be read from the moment it is sent (#566).
        let small = still ? 0 : motion.step(now: now, moving: moving, holds: guide.caption != nil || bubbleShows?() ?? false)
        let at = NSPoint(x: origin.x + Self.size.width / 2, y: origin.y + Self.ground + head)
        bubbleFrame = bubble?(at, visible, CGFloat(small))
        // Its tail, unless the bubble had to go beside it.
        let above = bubbleFrame.map { $0.minY >= at.y && $0.minX < at.x && at.x < $0.maxX } ?? false
        view.bubble = above ? bubbleFrame?.offsetBy(dx: -origin.x, dy: -origin.y) : nil
        view.origin = origin.x
        view.shown = frame
        view.needsDisplay = true
        aim()
    }
}
