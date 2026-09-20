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
        label.stringValue = state.text
        label.textColor = state.color
        orb.layer?.backgroundColor = state.color.cgColor
    }

    // Borderless panels refuse key status unless told otherwise; without
    // this the widget cannot show a caret or take any future text input.
    override var canBecomeKey: Bool { true }
}
