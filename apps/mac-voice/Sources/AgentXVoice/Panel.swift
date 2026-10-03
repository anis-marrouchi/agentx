import AppKit

/// The floating widget itself.
///
/// NSPanel with .nonactivatingPanel so pressing the hotkey never pulls
/// focus out of whatever you were doing — the entire point of a voice
/// assistant is that you don't stop working to use it. It floats above
/// normal windows, joins every Space, and is deliberately small.
///
/// It is the one floating widget: a small live orb at its head (Orb.swift)
/// in the answering agent's palette, the state or the words beside it, and
/// a close button that shows on hover. When an answer has more to read
/// than was spoken, the pill grows into it (PanelAnswer.swift) and
/// collapses again after a while. Drag it anywhere; the place is
/// remembered across launches.
final class Panel: NSPanel {
    static let size = NSSize(width: 284, height: 54)
    /// The orb's diameter, and the square it draws in with room for its glow.
    private static let orbDiameter: CGFloat = 36
    private static let orbFrame: CGFloat = 52

    private let label = NSTextField(labelWithString: "")
    let orb = PillOrb(diameter: Panel.orbDiameter, frameSize: Panel.orbFrame)
    /// One small orb per busy agent while more than one is (MiniOrbs.swift).
    let miniOrbs = MiniOrbsHost()
    /// Busy agents shown in the mini row; 0 hides it.
    private(set) var busyCount = 0
    private let closeButton = NSButton()
    /// Answer, Later and Decline while an agent rings; Hang up during the call.
    let callBar = CallBar(frame: NSRect(x: 0, y: 15, width: 0, height: 24))
    /// The orb, the words and the close button: the pill itself, which
    /// stays where it is while the widget grows into an answer.
    let row = RowView(frame: NSRect(origin: .zero, size: Panel.size))
    /// The answer, below or above the row once the pill has grown.
    let answer = AnswerView(frame: .zero)
    let separator = NSBox()
    /// Hidden by close, Esc or the menu until the next talk key.
    var dismissed = false
    /// Reduced to the orb alone (#457): a small circle with no words and no
    /// buttons, dragged and remembered apart from the pill. A click, a
    /// call or an answer to read opens the full pill again.
    private(set) var reduced = false
    /// Told when the pill reduces or opens.
    var onReduced: ((Bool) -> Void)?
    /// Above zero while the app moves or resizes the pill, so only a drag
    /// is remembered.
    var placing = 0

    // MARK: The answer (PanelAnswer.swift)

    /// Width of the pill grown into an answer.
    static let expandedWidth: CGFloat = 360
    /// Tallest the answer grows, in points, before it scrolls. From
    /// voice.card.maxHeight.
    var cardMaxHeight: CGFloat = 320
    /// Seconds the answer stays open once spoken; 0 until closed. From
    /// voice.card.timeout.
    var cardTimeout: TimeInterval = 30
    /// Grown into an answer.
    var expanded = false
    /// Which way it grew, so it collapses back to the same place.
    var growth = (above: true, alignRight: true)
    var collapseTimer: Timer?
    /// The pointer is over the widget: the answer stays open.
    var hovering = false

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

    /// The palette of the agent shown, for the orb; nil for shades of its tint.
    var agentPalette: () -> [NSColor]? = { nil }

    /// Stay on screen when idle. Off: the pill shows only while active.
    var alwaysVisible = false

    /// Told what the orb is shown, so the character can show the same.
    var onLook: ((State, NSColor, [NSColor]?) -> Void)?
    /// Told when it comes on screen or leaves it, so a still character
    /// draws its bubble's tail again.
    var onShown: (() -> Void)?

    /// Off while the character stands in for the orb (Character.swift):
    /// the words start where the orb was.
    private(set) var showsOrb = true

    /// Set while the pill is the character's speech bubble: where the
    /// character's head is, and the screen it is on.
    private(set) var bubble: (head: NSPoint, visible: NSRect)?

    /// Told of every state rendered, so the menu-bar icon can follow.
    var onRender: ((State) -> Void)?

    /// Close button or Esc. The app stops speech and calls `dismiss()`.
    var onDismiss: (() -> Void)?

    /// The last state rendered, to draw again after a dismiss or a move.
    var current = State.idle

    /// A click on the pill's row talks. A click in the answer does not:
    /// that is for reading and selecting.
    override func mouseUp(with event: NSEvent) {
        defer { pressedAt = nil }
        if let start = pressedAt {
            let now = NSEvent.mouseLocation
            let moved = hypot(now.x - start.x, now.y - start.y)
            let onRow = convertToScreen(row.convert(row.bounds, to: nil)).contains(start)
            // Reduced, a click opens the pill; it does not start talking.
            if moved < 4 && onRow {
                if reduced { MainActor.assumeIsolated { setReduced(false) } } else { onClick?() }
            }
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
        /// An agent is calling: the words already name it and its reason.
        case ringing(String)
        /// In a call, between turns: a click talks.
        case onCall

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
            case .ringing(let text): return text
            case .onCall: return "On call · click to talk"
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
            case .ringing: return Brand.accent
            case .onCall: return Brand.accentDeep
            }
        }

        /// What the character shows. A call between turns waits for you.
        var activity: CharacterMath.Activity {
            switch self {
            case .idle, .error: return .idle
            case .listening: return .listening
            case .thinking, .working: return .thinking
            case .speaking, .saying: return .speaking
            case .ringing: return .ringing
            case .onCall: return .waiting
            }
        }

        /// A call must not be missed behind an orb: it opens the full pill.
        var opensFullPill: Bool {
            switch self {
            case .ringing, .onCall: return true
            default: return false
            }
        }

        /// Idle is an invitation and belongs in meta type; everything else
        /// is a running commentary and belongs in body type.
        var isMeta: Bool { if case .idle = self { return true }; return false }

        /// What the orb does: follows the voice, turns a ring, or pulses.
        /// Idle and errors hold it still.
        var orbPhase: OrbModel.Phase {
            switch self {
            case .idle, .error, .onCall: return .idle
            case .listening: return .listening
            case .thinking, .working: return .thinking
            // Ringing pulses, so the pill is seen as well as heard.
            case .speaking, .saying, .ringing: return .speaking
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

        let surface = Surface(frame: NSRect(origin: .zero, size: Self.size))
        contentView = surface
        surface.addSubview(row)
        separator.boxType = .separator
        separator.isHidden = true
        surface.addSubview(separator)
        surface.addSubview(answer)
        answer.onHeight = { [weak self] height in self?.grow(answerHeight: height) }

        // The orb, centred 28 points from the left edge; its square is
        // larger than the orb so the glow is not cut off.
        let h = Self.size.height
        orb.frame = NSRect(x: 28 - Self.orbFrame / 2, y: (h - Self.orbFrame) / 2,
                           width: Self.orbFrame, height: Self.orbFrame)
        row.addSubview(orb)

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
        row.addSubview(clipView)
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
        row.addSubview(closeButton)
        miniOrbs.isHidden = true
        row.addSubview(miniOrbs)
        row.addSubview(callBar)
        surface.layoutContent = { [weak self] bounds in self?.layoutContent(bounds) }
        MainActor.assumeIsolated { layoutContent(surface.bounds) }
        surface.addTrackingArea(NSTrackingArea(rect: .zero,
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

    /// The row on the edge it grew from, full width; the answer in the
    /// rest. The answer is always laid out at its full width, so its text
    /// does not reflow while the pill grows around it.
    @MainActor
    func layoutContent(_ bounds: NSRect) {
        let h = Self.size.height
        let answerHeight = max(0, bounds.height - h)
        let above = growth.above
        row.frame = NSRect(x: 0, y: above ? 0 : answerHeight, width: bounds.width, height: h)
        // Reduced, the orb is all there is: in the middle of its circle.
        orb.frame.origin.x = reduced ? (bounds.width - Self.orbFrame) / 2 : 28 - Self.orbFrame / 2
        if reduced { return }
        closeButton.frame.origin.x = bounds.width - 28
        // The mini orbs sit between the words and the close button, and
        // the words give up that room while they show.
        let miniWidth = busyCount > 0 ? MiniOrbsHost.width(busyCount) : 0
        miniOrbs.frame = NSRect(x: bounds.width - 28 - miniWidth, y: (h - 24) / 2, width: miniWidth, height: 24)
        // The call buttons sit left of those, and the words give way again.
        let callWidth = CallBar.width(callBar.mode)
        let callX = bounds.width - 28 - (miniWidth > 0 ? miniWidth + 4 : 0) - callWidth
        callBar.frame = NSRect(x: callX, y: (h - 24) / 2, width: callWidth, height: 24)
        let head: CGFloat = showsOrb ? 54 : 18
        let clipWidth = bounds.width - 34 - head - (miniWidth > 0 ? miniWidth + 4 : 0) - (callWidth > 0 ? callWidth + 4 : 0)
        if let clip, clip.frame.width != clipWidth || clip.frame.minX != head {
            clip.frame.origin.x = head
            clip.frame.size.width = clipWidth
            // Text that scrolled may fit now, and the other way round.
            marqueeText = ""
            if !current.isMeta { setText(label.stringValue) }
        }
        answer.frame = NSRect(x: 0, y: above ? h : 0, width: Self.expandedWidth, height: answerHeight)
        separator.frame = NSRect(x: 0, y: above ? h - 1 : answerHeight, width: bounds.width, height: 1)
    }

    /// Where it was left, kept on a screen that still exists; the
    /// bottom-right corner the first time.
    @MainActor
    func restorePosition() {
        collapse(animated: false)
        if let bubble {
            place(PillPlacement.bubble(size: frame.size, head: bubble.head, visible: bubble.visible))
            return
        }
        let screens = NSScreen.screens.map(\.visibleFrame)
        let fallback = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        place(PillPlacement.clamp(saved: reduced ? Config.orbOrigin : Config.pillOrigin, size: frame.size,
                                  screens: screens, fallback: fallback,
                                  rest: reduced ? PillPlacement.orbOrigin : PillPlacement.defaultOrigin))
    }

    /// Back to where it first sat (the pill: the bottom-right corner; the
    /// orb: the middle of the bottom edge), forgetting where it was dragged.
    /// Not while it is the character's bubble: nothing would move, and
    /// the place kept for the orb look would be lost.
    @MainActor
    func resetPosition() {
        guard bubble == nil else { return }
        if reduced { Config.orbOrigin = nil } else { Config.pillOrigin = nil }
        restorePosition()
    }

    /// Reduce the pill to its orb, or open it again. The two forms keep
    /// their own places. Nothing to reduce to while the character stands
    /// in for the orb.
    @MainActor
    func setReduced(_ on: Bool) {
        guard reduced != on, !on || PillMenu.canReduce(showsOrb: showsOrb) else { return }
        collapse(animated: false)
        reduced = on
        clip?.isHidden = on
        closeButton.isHidden = true
        miniOrbs.isHidden = on || busyCount == 0
        (contentView as? Surface)?.shape(circle: on ? PillPlacement.orbSize.height : nil)
        placing += 1
        setContentSize(on ? PillPlacement.orbSize : Self.size)
        placing -= 1
        restorePosition()
        invalidateShadow()
        render(current)
        onReduced?(on)
    }

    /// The character's speech bubble (#491): the pill sits above `head`,
    /// the top of the character, and goes where it goes, grown or not. It
    /// is not dragged by itself, and the place it was dragged to as a
    /// pill is kept for the orb look.
    @MainActor
    func attach(head: NSPoint, visible: NSRect) {
        bubble = (head, visible)
        isMovableByWindowBackground = false
        // Growing or collapsing: it catches up on the next frame.
        guard placing == 0 else { return }
        let to = PillPlacement.bubble(size: Self.size, head: head, visible: visible)
        let from = collapsedFrame().origin
        let moved = PillPlacement.inside(frame.offsetBy(dx: to.x - from.x, dy: to.y - from.y), visible)
        if moved.origin != frame.origin { place(moved.origin) }
    }

    /// The orb look again: a pill of its own, back where it was left.
    @MainActor
    func detach() {
        guard bubble != nil else { return }
        bubble = nil
        isMovableByWindowBackground = true
        restorePosition()
    }

    @MainActor
    private func place(_ origin: NSPoint) {
        placing += 1
        setFrameOrigin(origin)
        placing -= 1
    }

    /// Remember a drag. Moves the app makes itself are not saved, so a
    /// reset or a clamp never overwrites where the user put it. Dragged
    /// while grown, the pill is remembered where it will collapse to.
    @objc private func moved() {
        MainActor.assumeIsolated {
            guard placing == 0 else { return }
            if reduced { Config.orbOrigin = frame.origin; return }
            Config.pillOrigin = expanded ? collapsedFrame().origin : frame.origin
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
        collapse(animated: false)
        hide()
    }

    /// The talk key: allowed on screen again.
    @MainActor
    func summon() {
        guard dismissed else { return }
        dismissed = false
        render(current)
    }

    /// The orb at the pill's head, or none while the character shows.
    @MainActor
    func setShowsOrb(_ on: Bool) {
        guard showsOrb != on else { return }
        if !on { setReduced(false) }
        showsOrb = on
        orb.isHidden = !on
        orb.setOnScreen(on && isVisible)
        if let content = contentView { layoutContent(content.bounds) }
    }

    @MainActor
    func show() {
        orb.setOnScreen(showsOrb)
        miniOrbs.setOnScreen(!miniOrbs.isHidden)
        if !isVisible { orderFrontRegardless(); onShown?() }
    }

    @MainActor
    private func hide() {
        closeButton.isHidden = true
        orb.setOnScreen(false)
        miniOrbs.setOnScreen(false)
        if isVisible { orderOut(nil); onShown?() }
    }

    @objc private func closeClicked() { onDismiss?() }

    override func mouseEntered(with event: NSEvent) {
        closeButton.isHidden = reduced
        hovering = true
        MainActor.assumeIsolated { armCollapse() }
    }
    override func mouseExited(with event: NSEvent) {
        closeButton.isHidden = true
        hovering = false
        MainActor.assumeIsolated { armCollapse() }
    }

    /// Esc, once the pill has been clicked and so holds the keyboard.
    override func cancelOperation(_ sender: Any?) { onDismiss?() }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onDismiss?() } else { super.keyDown(with: event) }
    }

    /// ⌘C copies what is selected in the answer. The app has no Edit menu
    /// to route the shortcut there.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if expanded, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers == "c" {
            answer.copySelection()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    /// AppKit is not thread-safe. Marking this explicitly means a stray
    /// call from a delegate queue is a compile error rather than heap
    /// corruption that traps somewhere unrelated an hour later.
    @MainActor
    func render(_ state: State) {
        if reduced && state.opensFullPill { setReduced(false) }
        current = state
        // The agent's colour, except where the state is the message: an
        // error, or notifications held.
        let tint: NSColor
        switch state {
        case .error: tint = Brand.alert
        case .idle where Hold.isOn: tint = Brand.warn
        default: tint = agentTint()
        }
        let colors: [NSColor]?
        switch state {
        case .error: colors = nil
        case .idle where Hold.isOn: colors = nil
        default: colors = agentPalette()
        }
        orb.show(state.orbPhase, tint: tint, colors: colors)

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

        // Grown into an answer, it stays until it collapses, idle or not;
        // so does a pill with agents still busy in its mini orbs.
        // Reduced, the orb is the assistant's place on screen: it stays, idle or not.
        if dismissed || (state.isMeta && !alwaysVisible && !expanded && busyCount == 0 && !reduced) { hide() } else { show() }
        // After showing or hiding: a still character draws its bubble's
        // tail only while the bubble is on screen.
        onLook?(state, tint, colors)
        armCollapse()
        onRender?(state)
    }

    /// On screen with something to use: an answer, an error or the call
    /// buttons. The character does not play with the pointer then (#537).
    @MainActor
    var holdsSomething: Bool {
        guard isVisible else { return false }
        if case .error = current { return true }
        return expanded || callBar.mode != .hidden
    }

    /// The call buttons for this moment of a call; `.hidden` outside one.
    @MainActor
    func showCall(_ mode: CallBar.Mode) {
        guard mode != callBar.mode else { return }
        if mode != .hidden { setReduced(false) }
        callBar.show(mode)
        if let content = contentView { layoutContent(content.bounds) }
    }

    /// The mini orbs: one per busy agent, or none to hide the row. The
    /// pill stays on screen while the row shows, even when idle.
    @MainActor
    func showBusy(_ orbs: [MiniOrbsModel.Orb], more: Int) {
        let count = orbs.isEmpty ? 0 : orbs.count + more
        miniOrbs.show(orbs, more: more)
        miniOrbs.isHidden = count == 0 || reduced
        if count != busyCount {
            busyCount = count
            if let content = contentView { layoutContent(content.bounds) }
            render(current)
        } else {
            miniOrbs.setOnScreen(isVisible && count > 0)
        }
    }

    /// "Nadia · Listening": who is listening or answering. Errors are the
    /// widget's own, so they carry no name.
    @MainActor
    private func named(_ state: State) -> String {
        let name = agentName()
        if name.isEmpty { return state.text }
        if case .error = state { return state.text }
        if case .ringing = state { return state.text }
        return "\(name) · \(state.text)"
    }

    /// Fits, or scrolls. Identical text is left alone so a per-second tick
    /// cannot restart the animation and make it stutter in place.
    @MainActor
    func setText(_ text: String) {
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
    func stopMarquee() {
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

/// The pill's row: its background passes clicks through, so pressing
/// anywhere on it drags the pill, while its close button still clicks.
final class RowView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }
}
