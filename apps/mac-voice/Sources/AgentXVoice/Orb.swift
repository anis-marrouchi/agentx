import AppKit
import SwiftUI

/// The Siri-style orb at the head of the pill: the agent's nature palette
/// (lagoon, forest, dusk…), and it listens, thinks and speaks.
///
/// Built from SwiftUI's own gradients, no animation library. It only moves
/// while it has something to show and is on screen: idle or hidden, its
/// timeline is paused and the microphone level is no longer read, so an
/// idle assistant costs nothing. With Reduce Motion on, or "Animated orb"
/// off in the menu, it is a still picture that changes between states,
/// never a loop.
@MainActor
final class OrbModel: ObservableObject {
    enum Phase: Equatable { case idle, listening, thinking, speaking }

    @Published var phase: Phase = .idle
    /// 0…1: the microphone while listening.
    @Published var level: Double = 0
    @Published var tint = NSColor(srgbRed: 0.078, green: 0.722, blue: 0.651, alpha: 1)
    /// The agent's palette, five stops deep to light, from the daemon.
    /// Nil: shades of `tint` (an error, held notifications, an older daemon).
    @Published var colors: [NSColor]?
    /// The pill is on screen. Off, nothing moves.
    @Published var onScreen = false
    @Published var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    /// "Animated orb" in the menu. Off: a still orb, as with Reduce Motion.
    @Published var animated = true

    var still: Bool { reduceMotion || !animated }
    /// The timeline runs only while there is motion to draw.
    var paused: Bool { still || phase == .idle || !onScreen }
}

/// The orb as the pill draws it: `OrbBody` at its design size, scaled down
/// to `diameter`, in a frame with room around it for the glow.
struct PillOrbView: View {
    @ObservedObject var model: OrbModel
    let diameter: CGFloat
    let frameSize: CGFloat

    /// The size OrbBody's blur, ring and gradients were drawn for.
    private static let designSize: CGFloat = 96

    var body: some View {
        let paused = model.paused
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { context in
            OrbBody(t: paused ? 0 : context.date.timeIntervalSinceReferenceDate,
                    phase: model.phase, level: model.level, tint: model.tint, colors: model.colors,
                    still: model.still, ringWidth: 5)
                .frame(width: Self.designSize, height: Self.designSize)
                .scaleEffect(diameter / Self.designSize)
        }
        .frame(width: frameSize, height: frameSize)
        .accessibilityElement()
        .accessibilityLabel(Text(accessibilityText))
    }

    private var accessibilityText: String {
        switch model.phase {
        case .idle: return "Idle"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }
}

/// The orb's view in the pill. Clicks go through it to the pill, so
/// pressing on the orb drags the pill like anywhere else on it.
@MainActor
final class PillOrb: NSHostingView<PillOrbView> {
    private let driver: OrbDriver
    var model: OrbModel { driver.model }

    /// The microphone's RMS level, read while listening. Set by the app.
    var levelSource: (() -> Float)? {
        get { driver.levelSource }
        set { driver.levelSource = newValue; driver.watchLevel() }
    }

    init(diameter: CGFloat, frameSize: CGFloat) {
        driver = OrbDriver()
        super.init(rootView: PillOrbView(model: driver.model, diameter: diameter, frameSize: frameSize))
    }

    @available(*, unavailable)
    required init(rootView: PillOrbView) { fatalError("use init(diameter:frameSize:)") }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Show `phase` in `colors`, or in shades of `tint` without them.
    /// Cheap to call on every render: SwiftUI only redraws what changed.
    func show(_ phase: OrbModel.Phase, tint: NSColor, colors: [NSColor]?) {
        let model = driver.model
        if model.tint != tint { model.tint = tint }
        if model.colors != colors { model.colors = colors }
        if model.phase != phase {
            model.phase = phase
            if phase != .listening { model.level = 0 }
        }
        driver.watchLevel()
    }

    /// The pill came on screen or went off it.
    func setOnScreen(_ on: Bool) {
        let model = driver.model
        guard model.onScreen != on else { return }
        model.onScreen = on
        if !on { model.level = 0 }
        driver.watchLevel()
    }

    /// "Animated orb" in the menu.
    func setAnimated(_ on: Bool) {
        guard driver.model.animated != on else { return }
        driver.model.animated = on
        driver.watchLevel()
    }
}

/// Reads the microphone into the model while listening, and follows the
/// Reduce Motion setting.
@MainActor
private final class OrbDriver {
    let model = OrbModel()
    var levelSource: (() -> Float)?
    private var levelTimer: Timer?
    private var motionObserver: NSObjectProtocol?

    init() {
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                self.watchLevel()
            }
        }
    }

    /// The microphone is read only while listening, on screen, with
    /// motion allowed.
    func watchLevel() {
        let wanted = model.phase == .listening && model.onScreen && !model.still && levelSource != nil
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

/// One frame of the orb at time `t`.
struct OrbBody: View {
    let t: Double
    let phase: OrbModel.Phase
    let level: Double
    let tint: NSColor
    /// The agent's palette, deep to light; nil for shades of `tint`.
    var colors: [NSColor]? = nil
    /// Reduce Motion: a still orb, sized and shaded by state alone.
    let still: Bool
    /// The thinking ring's stroke at the 96-point design size. The pill
    /// draws the orb small, so it passes a thicker one that still reads.
    var ringWidth: CGFloat = 2.2

    /// How much the orb swells and glows, 0…1.
    private var energy: Double {
        switch phase {
        case .idle: return 0
        case .listening: return still ? 0.45 : 0.12 + 0.88 * level
        case .thinking: return still ? 0.2 : 0.22 + 0.08 * sin(t * 2.2)
        case .speaking: return still ? 0.7 : OrbMath.speakingEnvelope(at: t)
        }
    }

    /// How fast the colours drift.
    private var speed: Double {
        switch phase {
        case .idle: return 0
        case .listening: return 0.5 + level * 1.5
        case .thinking: return 1.3
        case .speaking: return 0.9
        }
    }

    var body: some View {
        let scale = 0.78 + 0.22 * energy
        ZStack {
            Circle()
                .fill(glow.opacity(0.28 + 0.32 * energy))
                .blur(radius: 10 + 12 * energy)
                .scaleEffect(scale * 1.08)
            fill
                .clipShape(Circle())
                .scaleEffect(scale)
            // Glass: a soft light from the top left, as on a marble.
            Circle()
                .fill(RadialGradient(colors: [.white.opacity(0.42), .white.opacity(0)],
                                     center: UnitPoint(x: 0.34, y: 0.26), startRadius: 0, endRadius: 34))
                .scaleEffect(scale)
            // Thinking reads as a slow ring going round; the other states
            // as a soft rim.
            if phase == .thinking {
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(Color.white.opacity(0.75), style: StrokeStyle(lineWidth: ringWidth, lineCap: .round))
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

    /// The halo's colour: the palette's middle stop, or the tint.
    private var glow: Color {
        if let colors, colors.count == 5 { return Color(nsColor: colors[2]) }
        return Color(nsColor: tint)
    }

    /// Five colours for the mesh: the agent's palette when it has one,
    /// with its light stop brightening into a core as the voice grows.
    private var palette: [Color] {
        guard let colors, colors.count == 5 else { return shades }
        let core = CGFloat(0.1 + 0.35 * energy)
        let light = colors[4].blended(withFraction: core, of: .white) ?? colors[4]
        // Spread so neighbouring mesh points differ: deep beside light.
        return [colors[1], colors[3], colors[0], colors[2], light].map { Color(nsColor: $0) }
    }

    /// Five shades around the agent's colour: lighter, deeper and two
    /// neighbouring hues, and a bright core that grows with the voice.
    private var shades: [Color] {
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
