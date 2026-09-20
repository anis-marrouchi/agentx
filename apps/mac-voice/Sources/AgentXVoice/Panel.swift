import AppKit

/// The floating widget itself.
///
/// NSPanel with .nonactivatingPanel so pressing the hotkey never pulls
/// focus out of whatever you were doing — the entire point of a voice
/// assistant is that you don't stop working to use it. It floats above
/// normal windows, joins every Space, and is deliberately small.
final class Panel: NSPanel {
    private let label = NSTextField(labelWithString: "")
    private let orb = NSView()

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

    enum State {
        case idle, listening, thinking, speaking
        /// Live activity from the daemon, with seconds elapsed — the
        /// difference between "it's working" and "it's hung".
        case working(String, Int)
        case error(String)

        var text: String {
            switch self {
            case .idle: return "hold ⌥space"
            case .listening: return "Listening"
            case .thinking: return "Thinking"
            case .speaking: return "Speaking"
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
            case .idle: return .tertiaryLabelColor
            case .listening: return Brand.accent
            case .thinking, .working: return Brand.primaryBright
            case .speaking: return Brand.accentDeep
            case .error: return Brand.alert
            }
        }

        /// Idle is an invitation and belongs in meta type; everything else
        /// is a running commentary and belongs in body type.
        var isMeta: Bool { if case .idle = self { return true }; return false }
    }

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 230, height: 54),
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

        let blur = NSVisualEffectView(frame: contentRect(forFrameRect: frame))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = Brand.Radius.lg
        blur.layer?.masksToBounds = true
        blur.autoresizingMask = [.width, .height]
        contentView = blur

        orb.wantsLayer = true
        orb.layer?.cornerRadius = 4
        orb.frame = NSRect(x: 18, y: 22, width: 8, height: 8)
        blur.addSubview(orb)

        // A clipping window the label slides behind.
        let clipView = NSView(frame: NSRect(x: 38, y: 17, width: 180, height: 20))
        clipView.wantsLayer = true
        clipView.layer?.masksToBounds = true
        label.frame = NSRect(x: 0, y: 0, width: 180, height: 20)
        label.font = Brand.body(size: 12)
        label.lineBreakMode = .byClipping
        label.wantsLayer = true
        clipView.addSubview(label)
        blur.addSubview(clipView)
        clip = clipView

        render(.idle)
        positionBottomRight()
    }

    /// Bottom-right, clear of the Dock — out of the way but visible.
    private func positionBottomRight() {
        guard let screen = NSScreen.main else { return }
        let v = screen.visibleFrame
        setFrameOrigin(NSPoint(x: v.maxX - frame.width - 24, y: v.minY + 24))
    }

    /// AppKit is not thread-safe. Marking this explicitly means a stray
    /// call from a delegate queue is a compile error rather than heap
    /// corruption that traps somewhere unrelated an hour later.
    @MainActor
    func render(_ state: State) {
        orb.layer?.backgroundColor = state.color.cgColor
        // A soft halo on the dot while active: the same --nq-ring-accent
        // idea, and the only ornament on the pill.
        orb.layer?.shadowColor = state.color.cgColor
        orb.layer?.shadowOpacity = state.isMeta ? 0 : 0.55
        orb.layer?.shadowRadius = 5
        orb.layer?.shadowOffset = .zero

        if state.isMeta {
            stopMarquee()
            label.attributedStringValue = Brand.metaString(state.text, color: state.color)
            label.frame.origin.x = 0
        } else {
            label.textColor = state.color
            setText(state.text)
        }
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

    // Borderless panels refuse key status unless told otherwise; without
    // this the widget cannot show a caret or take any future text input.
    override var canBecomeKey: Bool { true }
}
