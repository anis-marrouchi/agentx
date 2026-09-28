import AppKit
import SwiftUI

/// The Siri-style overlay: an orb in the agent's colour that listens,
/// thinks and speaks, with a line of words under it.
///
/// Built from SwiftUI's own gradients, no animation library. The orb only
/// moves while it is on screen: hidden, its timeline is paused and the
/// microphone level is no longer read, so an idle assistant costs nothing.
/// With Reduce Motion on it is a still picture that changes between
/// states, never a loop.
@MainActor
final class OrbModel: ObservableObject {
    enum Phase: Equatable { case hidden, listening, thinking, speaking }

    @Published var phase: Phase = .hidden
    /// 0…1: the microphone while listening.
    @Published var level: Double = 0
    @Published var tint = NSColor(srgbRed: 0.078, green: 0.722, blue: 0.651, alpha: 1)
    @Published var name = ""
    /// What was heard, or what is being said.
    @Published var line = ""
    /// The step the agent is on, and for how long.
    @Published var status = ""
    @Published var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
}

struct OrbView: View {
    @ObservedObject var model: OrbModel
    @Environment(\.colorScheme) private var scheme

    /// The agent's colour, lifted in dark mode so the name stays readable.
    private var nameColor: Color {
        guard scheme == .dark, let c = model.tint.usingColorSpace(.sRGB) else { return Color(nsColor: model.tint) }
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        return Color(nsColor: NSColor(hue: h, saturation: s * 0.55, brightness: min(1, b + 0.35), alpha: 1))
    }

    var body: some View {
        VStack(spacing: 8) {
            orb.frame(width: 96, height: 96).padding(.top, 4)
            if !model.name.isEmpty {
                Text(model.name.uppercased())
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .tracking(0.8)
                    .foregroundStyle(nameColor)
            }
            if !model.line.isEmpty {
                Text(model.line)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .truncationMode(.head)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: OrbOverlay.width)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var orb: some View {
        let still = model.reduceMotion
        let paused = still || model.phase == .hidden
        return TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { context in
            OrbBody(t: paused ? 0 : context.date.timeIntervalSinceReferenceDate,
                    phase: model.phase, level: model.level, tint: model.tint, still: still)
        }
        .accessibilityLabel(Text(accessibilityText))
    }

    private var accessibilityText: String {
        switch model.phase {
        case .hidden: return ""
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }
}

/// One frame of the orb at time `t`.
struct OrbBody: View {
    let t: Double
    let phase: OrbModel.Phase
    let level: Double
    let tint: NSColor
    /// Reduce Motion: a still orb, sized and shaded by state alone.
    let still: Bool

    /// How much the orb swells and glows, 0…1.
    private var energy: Double {
        switch phase {
        case .hidden: return 0
        case .listening: return still ? 0.45 : 0.12 + 0.88 * level
        case .thinking: return still ? 0.2 : 0.22 + 0.08 * sin(t * 2.2)
        case .speaking: return still ? 0.7 : OrbMath.speakingEnvelope(at: t)
        }
    }

    /// How fast the colours drift.
    private var speed: Double {
        switch phase {
        case .hidden: return 0
        case .listening: return 0.5 + level * 1.5
        case .thinking: return 1.3
        case .speaking: return 0.9
        }
    }

    var body: some View {
        let scale = 0.78 + 0.22 * energy
        ZStack {
            Circle()
                .fill(Color(nsColor: tint).opacity(0.28 + 0.32 * energy))
                .blur(radius: 10 + 12 * energy)
                .scaleEffect(scale * 1.08)
            fill
                .clipShape(Circle())
                .scaleEffect(scale)
            // Thinking reads as a slow ring going round; the other states
            // as a soft rim.
            if phase == .thinking {
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(Color.white.opacity(0.75), style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    .rotationEffect(.radians(still ? -.pi / 2 : t * 3.1))
                    .scaleEffect(scale * 0.86)
            } else {
                Circle()
                    .strokeBorder(Color.white.opacity(0.3 + 0.25 * energy), lineWidth: 1)
                    .scaleEffect(scale)
            }
        }
    }

    @ViewBuilder private var fill: some View {
        let shades = palette
        if #available(macOS 15, *) {
            MeshGradient(width: 3, height: 3, points: meshPoints, colors: [
                shades[0], shades[1], shades[2],
                shades[3], shades[4], shades[1],
                shades[2], shades[3], shades[0],
            ])
        } else {
            // macOS 14: two gradients stand in for the mesh.
            ZStack {
                AngularGradient(colors: [shades[0], shades[2], shades[3], shades[1], shades[0]],
                                center: .center, angle: .radians(t * speed))
                RadialGradient(colors: [shades[4], shades[4].opacity(0)],
                               center: UnitPoint(x: 0.5 + 0.12 * cos(t * speed), y: 0.5 + 0.12 * sin(t * speed)),
                               startRadius: 2, endRadius: 44)
            }
        }
    }

    /// Corners fixed, edges sway, the centre wanders further when there
    /// is more energy. `still` keeps the resting grid.
    private var meshPoints: [SIMD2<Float>] {
        let s = still ? 0 : t * speed
        let reach = Float(0.08 + 0.14 * energy)
        func sway(_ phase: Double) -> Float { Float(sin(s + phase)) * reach * 0.6 }
        return [
            [0, 0], [0.5 + sway(0.3), 0], [1, 0],
            [0, 0.5 + sway(1.1)],
            [0.5 + Float(cos(s * 1.3)) * reach, 0.5 + Float(sin(s * 1.7)) * reach],
            [1, 0.5 + sway(2.3)],
            [0, 1], [0.5 + sway(3.7), 1], [1, 1],
        ]
    }

    /// Five shades around the agent's colour: lighter, deeper and two
    /// neighbouring hues, and a bright core that grows with the voice.
    private var palette: [Color] {
        let base = tint.usingColorSpace(.sRGB) ?? tint
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        base.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        // Thinking turns the hues slowly; the others hold them.
        let drift = phase == .thinking && !still ? CGFloat(sin(t * 0.8)) * 0.04 : 0
        func shade(_ dh: CGFloat, _ ds: CGFloat, _ db: CGFloat) -> Color {
            var hue = (h + dh + drift).truncatingRemainder(dividingBy: 1)
            if hue < 0 { hue += 1 }
            return Color(nsColor: NSColor(hue: hue, saturation: min(1, max(0, s + ds)),
                                          brightness: min(1, max(0, b + db)), alpha: 1))
        }
        let core = CGFloat(0.12 + 0.3 * energy)
        return [
            shade(0, 0, 0),
            shade(0.07, -0.05, 0.08),
            shade(-0.06, 0.05, -0.12),
            shade(0.13, -0.1, 0.02),
            shade(0.02, -0.35 * core * 2, core),
        ]
    }
}

/// The window the orb lives in: floating, on every Space, click-through
/// and never key, so the app in front keeps the keyboard.
private final class OrbPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OrbOverlay {
    static let width: CGFloat = 300
    private static let height: CGFloat = 250

    let model = OrbModel()
    private let panel: NSPanel
    private let host: NSHostingView<OrbView>
    private var levelTimer: Timer?
    private var motionObserver: NSObjectProtocol?

    /// The microphone's RMS level, read while listening. Set by the app.
    var levelSource: (() -> Float)?

    init() {
        panel = OrbPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: Self.height),
                         styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        host = NSHostingView(rootView: OrbView(model: model))
        host.frame = NSRect(x: 0, y: 0, width: Self.width, height: Self.height)
        panel.contentView = host

        let model = self.model
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            }
        }
    }

    var isVisible: Bool { panel.isVisible }

    /// Where the orb's card ends on screen, for the answer card to sit
    /// under. Nil while hidden.
    var contentFrame: NSRect? {
        guard panel.isVisible else { return nil }
        let h = min(Self.height, host.fittingSize.height)
        return NSRect(x: panel.frame.minX, y: panel.frame.maxY - h, width: Self.width, height: h)
    }

    func show(_ phase: OrbModel.Phase, name: String, tint: NSColor, line: String, status: String) {
        guard phase != .hidden else { hide(); return }
        model.name = name
        model.tint = tint
        model.line = line
        model.status = status
        if model.phase != phase {
            model.phase = phase
            if phase != .listening { model.level = 0 }
        }
        watchLevel()
        if !panel.isVisible {
            position()
            panel.orderFrontRegardless()
        }
    }

    func hide() {
        model.phase = .hidden
        model.level = 0
        watchLevel()
        panel.orderOut(nil)
    }

    /// Top right, under the menu bar, where macOS puts Siri.
    private func position() {
        guard let screen = NSScreen.main else { return }
        let v = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: v.maxX - Self.width - 16, y: v.maxY - Self.height - 10))
    }

    /// The microphone is read only while listening, on screen, with
    /// motion allowed.
    private func watchLevel() {
        let wanted = model.phase == .listening && !model.reduceMotion && levelSource != nil
        if !wanted { levelTimer?.invalidate(); levelTimer = nil; return }
        guard levelTimer == nil else { return }
        levelTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let read = self.levelSource else { return }
                self.model.level = OrbMath.smooth(self.model.level, toward: OrbMath.level(fromRMS: read()))
            }
        }
    }
}
