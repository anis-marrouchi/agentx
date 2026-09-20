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
    /// Step text like "Bash: check the calendar for conflicts tomorrow" is
    /// routinely wider than 180 points, and an ellipsis hides exactly the
    /// specific part that makes it reassuring. A slow marquee shows all of
    /// it without making the widget bigger.
    private var marquee: Timer?
    private var marqueeText = ""
    private var marqueeOffset = 0

    enum State {
        case idle, listening, thinking, speaking
        /// Live activity from the daemon, with seconds elapsed — the
        /// difference between "it's working" and "it's hung".
        case working(String, Int)
        case error(String)

        var text: String {
            switch self {
            case .idle: return "⌥Space to talk"
            case .listening: return "Listening…"
            case .thinking: return "Thinking…"
            case .speaking: return "Speaking…"
            case .working(let what, let secs): return "\(what)  ·  \(secs)s"
            case .error(let m): return m
            }
        }
        var color: NSColor {
            switch self {
            case .idle: return .secondaryLabelColor
            case .listening: return .systemRed
            case .thinking: return .systemOrange
            case .speaking: return .systemGreen
            case .working: return .systemOrange
            case .error: return .systemYellow
            }
        }
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
        blur.layer?.cornerRadius = 14
        blur.layer?.masksToBounds = true
        blur.autoresizingMask = [.width, .height]
        contentView = blur

        orb.wantsLayer = true
        orb.layer?.cornerRadius = 6
        orb.frame = NSRect(x: 16, y: 21, width: 12, height: 12)
        blur.addSubview(orb)

        label.frame = NSRect(x: 38, y: 17, width: 180, height: 20)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        blur.addSubview(label)

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
        label.textColor = state.color
        orb.layer?.backgroundColor = state.color.cgColor
        setText(state.text)
    }

    /// Fits, or scrolls. Restarting the marquee on every tick would make
    /// long text stutter in place, so identical text is left alone.
    @MainActor
    private func setText(_ text: String) {
        let fits = (text as NSString)
            .size(withAttributes: [.font: label.font ?? NSFont.systemFont(ofSize: 12)])
            .width <= label.frame.width

        if fits {
            stopMarquee()
            label.stringValue = text
            return
        }
        if text == marqueeText { return }
        marqueeText = text
        marqueeOffset = 0
        startMarquee()
    }

    @MainActor
    private func startMarquee() {
        marquee?.invalidate()
        // Gap so the loop point is readable rather than words colliding.
        let looped = marqueeText + "     ·     "
        marquee = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let chars = Array(looped)
                guard chars.count > 1 else { return }
                self.marqueeOffset = (self.marqueeOffset + 1) % chars.count
                let rotated = Array(chars[self.marqueeOffset...]) + Array(chars[..<self.marqueeOffset])
                self.label.stringValue = String(rotated)
            }
        }
    }

    @MainActor
    private func stopMarquee() {
        marquee?.invalidate(); marquee = nil
        marqueeText = ""; marqueeOffset = 0
    }

    // Borderless panels refuse key status unless told otherwise; without
    // this the widget cannot show a caret or take any future text input.
    override var canBecomeKey: Bool { true }
}
