import AppKit

/// The floating widget itself.
///
/// NSPanel with .nonactivatingPanel so pressing the hotkey never pulls
/// focus out of whatever you were doing — the entire point of a voice
/// assistant is that you don't stop working to use it. It floats above
/// normal windows, joins every Space, and is deliberately small.
///
/// It is the one floating widget: a small live orb at its head (Orb.swift)
/// in the answering agent's colour, the state or the words beside it, and
/// a close button that shows on hover. Drag it anywhere; the place is
/// remembered across launches.
final class Panel: NSPanel {
    static let size = NSSize(width: 284, height: 54)
    /// The orb's diameter, and the square it draws in with room for its glow.
    private static let orbDiameter: CGFloat = 36
    private static let orbFrame: CGFloat = 52

    private let label = NSTextField(labelWithString: "")
    let orb = PillOrb(diameter: Panel.orbDiameter, frameSize: Panel.orbFrame)
    private let closeButton = NSButton()
    /// Hidden by close, Esc or the menu until the next talk key.
    private(set) var dismissed = false
    /// Set while the app moves the pill, so only a drag is remembered.
    private var placing = false

    /// Scrolls text too long for the pill instead of truncating it.
    ///
    /// Step text is routinely wider than 180 points, and an ellipsis hides
    /// exactly the part that makes it reassuring.
    ///
    /// The first version rotated the STRING by one character every 0.18s.
    /// That flickers, and unavoidably: every tick re-lays out the whole
    /// text, and the motion is quantised to a character width, so it jumps
    /// rather than slides. Instead the label now moves inside a clipping
    /// view, animated by Core Animation — continuous, sub-pixel, composited
    /// off the main thread, and it never touches the text once set.
    private var clip: NSView?
    private var marqueeText = ""

    private var pressedAt: NSPoint?

    /// A click acts on mouse UP, and only when the pointer has not moved.
    ///
    /// The panel is draggable by its background, so acting on mouse DOWN
    /// would fire every time someone repositioned it — you could not move
    /// the widget without talking to it.
    override func mouseDown(with event: NSEvent) {
        pressedAt = NSEvent.mouseLocation
        super.mouseDown(with: event)
    }

    /// Right-click opens the same menu as the menu-bar icon.
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = contextMenu?() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: contentView ?? NSView())
    }

    /// The menu to show on right-click. Set by the app.
    var contextMenu: (() -> NSMenu)?

    /// The target agent's name, shown while listening or answering.
    var agentName: () -> String = { "" }

    /// The colour of the agent shown, for the orb.
    var agentTint: () -> NSColor = { Brand.accent }

    /// Stay on screen when idle. Off: the pill shows only while active.
    var alwaysVisible = false

    /// Told of every state rendered, so the menu-bar icon can follow.
    var onRender: ((State) -> Void)?

    /// Close button or Esc. The app stops speech and calls `dismiss()`.
    var onDismiss: (() -> Void)?

    /// The pill moved, by a drag or a reset. The answer card follows.
    var onMove: (() -> Void)?

    /// The last state rendered, to draw again after a dismiss or a move.
    private var current = State.idle

    override func mouseUp(with event: NSEvent) {
        defer { pressedAt = nil }
        if let start = pressedAt {
            let now = NSEvent.mouseLocation
            let moved = hypot(now.x - start.x, now.y - start.y)
            if moved < 4 { onClick?() }
        }
        super.mouseUp(with: event)
    }

    enum State {
        case idle, listening, thinking, speaking
        /// Live activity from the daemon, with seconds elapsed — the
        /// difference between "it's working" and "it's hung".
        case working(String, Int)
        /// What is being said right now, scrolled in full.
        ///
        /// "Speaking" told you the state and not the content, which is the
        /// wrong half: you already know it is speaking, you can hear it.
        /// What you cannot do is re-read a sentence that has gone past, or
        /// follow it at all in a noisy room.
        case saying(String)
        case error(String)

        var text: String {
            switch self {
            case .idle: return Hold.isOn ? "notifications held" : "hold ⌥space"
            case .listening: return "Listening"
            case .thinking: return "Thinking"
            case .speaking: return "Speaking"
            case .saying(let text): return text
            // "·" is the system's own separator glyph.
            case .working(let what, let secs): return "\(what)  ·  \(secs)s"
            case .error(let m): return m
            }
        }
        var color: NSColor {
            switch self {
            // Teal carries every ACTIVE state, so the widget reads as one
            // thing doing work rather than a traffic light. System reds
            // and greens were macOS's voice, not the product's, and they
            // shift with the user's accent-colour setting.
            case .idle: return Hold.isOn ? Brand.warn : .tertiaryLabelColor
            case .listening: return Brand.accent
            case .thinking, .working: return Brand.primaryBright
            case .speaking, .saying: return Brand.accentDeep
            case .error: return Brand.alert
            }
        }

        /// Idle is an invitation and belongs in meta type; everything else
        /// is a running commentary and belongs in body type.
        var isMeta: Bool { if case .idle = self { return true }; return false }

        /// What the orb does: follows the voice, turns a ring, or pulses.
        /// Idle and errors hold it still.
        var orbPhase: OrbModel.Phase {
            switch self {
            case .idle, .error: return .idle
            case .listening: return .listening
            case .thinking, .working: return .thinking
            case .speaking, .saying: return .speaking
            }
        }
    }

    /// Called when the pill is clicked. Set by the app.
    ///
    /// The hotkey is faster once you know it, and invisible until then.
    /// A widget whose only affordance is a chord you have to be told about
    /// is a widget most people never use — "HOLD ⌥SPACE" is printed on it
    /// precisely because there was nothing to click.
    var onClick: (() -> Void)?

    init() {
        super.init(contentRect: NSRect(origin: .zero, size: Self.size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false

        let blur = NSVisualEffectView(frame: NSRect(origin: .zero, size: Self.size))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = Brand.Radius.lg
        blur.layer?.masksToBounds = true
        blur.autoresizingMask = [.width, .height]
        contentView = blur

        // An opaque tint over the blur, and it is not a style preference.
        //
        // `blendingMode = .behindWindow` composites whatever is behind the
        // pill, so the editor's own panel dividers were coming through it
        // as a faint rectangle around the widget — it read as a border the
        // widget was drawing, when it was the window behind. Translucency
        // is pleasant over wallpaper and actively confusing over ruled UI.
        //
        // This keeps enough blur to feel native while making the pill read
        // as one solid object wherever it is parked.
        let tint = NSView(frame: blur.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = NSColor.windowBackgroundColor
            .withAlphaComponent(0.72).cgColor
        tint.layer?.cornerRadius = Brand.Radius.lg
        tint.autoresizingMask = [.width, .height]
        blur.addSubview(tint)

        // The orb, centred 28 points from the left edge; its square is
        // larger than the orb so the glow is not cut off.
        let h = Self.size.height
        orb.frame = NSRect(x: 28 - Self.orbFrame / 2, y: (h - Self.orbFrame) / 2,
                           width: Self.orbFrame, height: Self.orbFrame)
        blur.addSubview(orb)

        // A clipping window the label slides behind. Clicks pass through
        // it, so pressing on the words drags the pill too.
        let clipView = PassThroughView(frame: NSRect(x: 54, y: 17, width: 196, height: 20))
        clipView.wantsLayer = true
        clipView.layer?.masksToBounds = true
        label.frame = NSRect(x: 0, y: 0, width: 196, height: 20)
        label.font = Brand.body(size: 12)
        label.lineBreakMode = .byClipping
        label.wantsLayer = true
        clipView.addSubview(label)
        blur.addSubview(clipView)
        clip = clipView

        // Close, shown while the pointer is over the pill. Its space is
        // kept when hidden, so the words never jump under it.
        closeButton.frame = NSRect(x: Self.size.width - 28, y: (h - 18) / 2, width: 18, height: 18)
        closeButton.isBordered = false
        closeButton.bezelStyle = .regularSquare
        closeButton.imagePosition = .imageOnly
        closeButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Hide")
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.toolTip = "Hide (Esc)"
        closeButton.setAccessibilityLabel("Hide the pill")
        closeButton.target = self
        closeButton.action = #selector(closeClicked)
        closeButton.isHidden = true
        blur.addSubview(closeButton)
        blur.addTrackingArea(NSTrackingArea(rect: .zero,
                                            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                            owner: self, userInfo: nil))

        render(.idle)
        restorePosition()

        NotificationCenter.default.addObserver(self, selector: #selector(moved),
                                               name: NSWindow.didMoveNotification, object: self)
        // A monitor unplugged or rearranged: bring the pill back on screen.
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    // MARK: Place

    /// Where it was left, kept on a screen that still exists; the
    /// bottom-right corner the first time.
    @MainActor
    func restorePosition() {
        let screens = NSScreen.screens.map(\.visibleFrame)
        let fallback = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        place(PillPlacement.clamp(saved: Config.pillOrigin, size: frame.size, screens: screens, fallback: fallback))
    }

    /// Back to the bottom-right corner, forgetting where it was dragged.
    @MainActor
    func resetPosition() {
        Config.pillOrigin = nil
        restorePosition()
    }

    @MainActor
    private func place(_ origin: NSPoint) {
        placing = true
        setFrameOrigin(origin)
        placing = false
        onMove?()
    }

    /// Remember a drag. Moves the app makes itself are not saved, so a
    /// reset or a clamp never overwrites where the user put it.
    @objc private func moved() {
        MainActor.assumeIsolated {
            guard !placing else { return }
            Config.pillOrigin = frame.origin
            onMove?()
        }
    }

    @objc private func screensChanged() {
        MainActor.assumeIsolated { restorePosition() }
    }

    // MARK: Show and hide

    /// Close, Esc or the menu: hidden until `summon()`, whatever is
    /// rendered meanwhile.
    @MainActor
    func dismiss() {
        dismissed = true
        hide()
    }

    /// The talk key: allowed on screen again.
    @MainActor
    func summon() {
        guard dismissed else { return }
        dismissed = false
        render(current)
    }

    @MainActor
    private func show() {
        orb.setOnScreen(true)
        if !isVisible { orderFrontRegardless() }
    }

    @MainActor
    private func hide() {
        closeButton.isHidden = true
        orb.setOnScreen(false)
        if isVisible { orderOut(nil) }
    }

    @objc private func closeClicked() { onDismiss?() }

    override func mouseEntered(with event: NSEvent) { closeButton.isHidden = false }
    override func mouseExited(with event: NSEvent) { closeButton.isHidden = true }

    /// Esc, once the pill has been clicked and so holds the keyboard.
    override func cancelOperation(_ sender: Any?) { onDismiss?() }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onDismiss?() } else { super.keyDown(with: event) }
    }

    /// AppKit is not thread-safe. Marking this explicitly means a stray
    /// call from a delegate queue is a compile error rather than heap
    /// corruption that traps somewhere unrelated an hour later.
    @MainActor
    func render(_ state: State) {
        current = state
        // The agent's colour, except where the state is the message: an
        // error, or notifications held.
        let tint: NSColor
        switch state {
        case .error: tint = Brand.alert
        case .idle where Hold.isOn: tint = Brand.warn
        default: tint = agentTint()
        }
        orb.show(state.orbPhase, tint: tint)

        if state.isMeta {
            stopMarquee()
            label.attributedStringValue = Brand.metaString(state.text, color: state.color)
            label.frame.origin.x = 0
        } else {
            // The orb carries the state now, so the words are plain text
            // that reads in both themes. Errors keep their colour.
            if case .error = state { label.textColor = state.color } else { label.textColor = .labelColor }
            setText(named(state))
        }

        if dismissed || (state.isMeta && !alwaysVisible) { hide() } else { show() }
        onRender?(state)
    }

    /// "Nadia · Listening": who is listening or answering. Errors are the
    /// widget's own, so they carry no name.
    @MainActor
    private func named(_ state: State) -> String {
        let name = agentName()
        if name.isEmpty { return state.text }
        if case .error = state { return state.text }
        return "\(name) · \(state.text)"
    }

    /// Fits, or scrolls. Identical text is left alone so a per-second tick
    /// cannot restart the animation and make it stutter in place.
    @MainActor
    private func setText(_ text: String) {
        guard let clipView = clip else { label.stringValue = text; return }
        let font = label.font ?? NSFont.systemFont(ofSize: 12)
        let width = (text as NSString).size(withAttributes: [.font: font]).width

        if width <= clipView.bounds.width {
            stopMarquee()
            label.stringValue = text
            label.frame.size.width = clipView.bounds.width
            label.frame.origin.x = 0
            return
        }
        if text == marqueeText { return }
        marqueeText = text
        startMarquee(text: text, textWidth: width, in: clipView)
    }

    @MainActor
    private func startMarquee(text: String, textWidth: CGFloat, in clipView: NSView) {
        label.layer?.removeAnimation(forKey: "marquee")

        // Gap so the loop point reads as a pause rather than words colliding.
        let gap: CGFloat = 40
        let travel = textWidth + gap
        label.stringValue = text
        label.frame = NSRect(x: 0, y: 0, width: textWidth + gap, height: clipView.bounds.height)

        let slide = CABasicAnimation(keyPath: "position.x")
        slide.fromValue = label.layer?.position.x ?? 0
        slide.byValue = -travel
        // Speed proportional to length, so a long step is not punishingly
        // slow and a short one is not a blur. ~40 points a second reads at
        // a glance without demanding attention.
        slide.duration = CFTimeInterval(travel / 40)
        slide.repeatCount = .infinity
        slide.isRemovedOnCompletion = false
        label.layer?.add(slide, forKey: "marquee")
    }

    @MainActor
    private func stopMarquee() {
        label.layer?.removeAnimation(forKey: "marquee")
        marqueeText = ""
    }

    // Borderless panels refuse key status unless told otherwise. The pill
    // takes it only when clicked (showing it never does: that is
    // orderFrontRegardless, not makeKey), so Esc can reach it then.
    override var canBecomeKey: Bool { true }
}

/// A view clicks go through, to the pill behind it.
private final class PassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
