import AppKit
import SwiftUI

/// The row of mini orbs in the pill: one per busy agent (PillBusy.swift).
///
/// Each is a small glassy dot in the agent's colours with a cue for its
/// state: a ring going round while it thinks, a steady ring while its
/// answer waits to be spoken, a gentle pulse while it speaks, and a count
/// when more questions wait for it. It moves only while shown on screen
/// with something busy; Reduce Motion or "Animated orb" off gives still
/// orbs. Clicks go through to the pill, it never takes the keyboard, and
/// hovering an orb names the agent and its node.
@MainActor
final class MiniOrbsModel: ObservableObject {
    struct Orb: Identifiable, Equatable {
        var id: String { agentID }
        let agentID: String
        let activity: PillBusy.Activity
        let queued: Int
        let tint: NSColor
        /// Five stops deep to light, or nil for shades of `tint`.
        let colors: [NSColor]?
        let tooltip: String
    }

    @Published var orbs: [Orb] = []
    @Published var more = 0
    @Published var onScreen = false
    @Published var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    @Published var animated = true

    var still: Bool { reduceMotion || !animated }
    /// Only thinking and speaking move; the timeline stops otherwise.
    var paused: Bool {
        still || !onScreen || !orbs.contains { $0.activity == .thinking || $0.activity == .speaking }
    }
}

struct MiniOrbsView: View {
    @ObservedObject var model: MiniOrbsModel

    var body: some View {
        let paused = model.paused
        TimelineView(.animation(minimumInterval: 1.0 / 24, paused: paused)) { context in
            let t = paused ? 0 : context.date.timeIntervalSinceReferenceDate
            HStack(spacing: PillBusy.gap) {
                ForEach(model.orbs) { orb in
                    MiniOrb(orb: orb, t: t, still: model.still)
                        .frame(width: PillBusy.diameter, height: PillBusy.diameter)
                }
                if model.more > 0 {
                    Text("+\(model.more)")
                        .font(.system(size: 10, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: PillBusy.overflowWidth, alignment: .leading)
                }
            }
            .padding(.trailing, MiniOrbsHost.inset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(model.orbs.map(\.tooltip).joined(separator: "; ")))
    }
}

/// One mini orb at time `t`.
struct MiniOrb: View {
    let orb: MiniOrbsModel.Orb
    let t: Double
    let still: Bool

    var body: some View {
        let pulse = orb.activity == .speaking && !still ? 0.9 + 0.1 * OrbMath.speakingEnvelope(at: t) : 1
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [light, deep], center: UnitPoint(x: 0.38, y: 0.32),
                                     startRadius: 0, endRadius: PillBusy.diameter * 0.62))
                .overlay(Circle().fill(RadialGradient(colors: [.white.opacity(0.5), .white.opacity(0)],
                                                      center: UnitPoint(x: 0.34, y: 0.26),
                                                      startRadius: 0, endRadius: 5)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5))
                .scaleEffect(orb.activity == .queued ? 0.72 : 0.78 * pulse)
                .opacity(orb.activity == .queued ? 0.7 : 1)
            cue
            if orb.queued > 0 {
                Text("\(min(orb.queued, 9))")
                    .font(.system(size: 7.5, weight: .bold).monospacedDigit())
                    .foregroundStyle(.white)
                    .frame(width: 9, height: 9)
                    .background(Circle().fill(Color(nsColor: deepest)))
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.8), lineWidth: 0.6))
                    .offset(x: 5, y: -6)
            }
        }
    }

    /// The state cue drawn around the dot.
    @ViewBuilder private var cue: some View {
        switch orb.activity {
        case .thinking:
            Circle()
                .trim(from: 0, to: 0.3)
                .stroke(Color(nsColor: ring), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                .rotationEffect(.radians(still ? -.pi / 2 : t * 3.4))
        case .answering:
            Circle().stroke(Color(nsColor: ring).opacity(0.85), lineWidth: 1.2)
        case .speaking:
            Circle().stroke(Color(nsColor: ring).opacity(0.5), lineWidth: 1)
                .scaleEffect(still ? 1 : 0.94 + 0.06 * OrbMath.speakingEnvelope(at: t + 0.4))
        case .queued:
            EmptyView()
        }
    }

    private var light: Color {
        if let c = orb.colors, c.count == 5 { return Color(nsColor: c[3]) }
        return Color(nsColor: orb.tint.blended(withFraction: 0.35, of: .white) ?? orb.tint)
    }
    private var deep: Color {
        if let c = orb.colors, c.count == 5 { return Color(nsColor: c[1]) }
        return Color(nsColor: orb.tint)
    }
    private var deepest: NSColor {
        if let c = orb.colors, c.count == 5 { return c[0] }
        return orb.tint.blended(withFraction: 0.3, of: .black) ?? orb.tint
    }
    /// The ring reads on the pill in both themes: the agent's mid colour.
    private var ring: NSColor {
        if let c = orb.colors, c.count == 5 { return c[2] }
        return orb.tint
    }
}

/// The row's view in the pill. Clicks go through it, as through the main
/// orb; hovering still shows each orb's name (tooltips are tracking
/// rects, not clicks). It never takes the keyboard.
@MainActor
final class MiniOrbsHost: NSHostingView<MiniOrbsView> {
    let model: MiniOrbsModel
    private var motionObserver: NSObjectProtocol?
    private var tips: [NSView.ToolTipTag] = []

    init() {
        let model = MiniOrbsModel()
        self.model = model
        super.init(rootView: MiniOrbsView(model: model))
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main) { [weak model] _ in
            MainActor.assumeIsolated {
                model?.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            }
        }
    }

    @available(*, unavailable)
    required init(rootView: MiniOrbsView) { fatalError("use init()") }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// Room right of the last orb for its queued badge.
    static let inset: CGFloat = 3
    /// The host's width for `count` busy agents.
    static func width(_ count: Int) -> CGFloat { PillBusy.rowWidth(count) + inset * 2 }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }

    /// Show these orbs, the "+n" for the rest. Cheap on every call:
    /// SwiftUI redraws only what changed.
    func show(_ orbs: [MiniOrbsModel.Orb], more: Int) {
        if model.orbs != orbs { model.orbs = orbs }
        if model.more != more { model.more = more }
        placeTooltips()
    }

    func setOnScreen(_ on: Bool) {
        if model.onScreen != on { model.onScreen = on }
    }

    func setAnimated(_ on: Bool) {
        if model.animated != on { model.animated = on }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        placeTooltips()
    }

    /// One tooltip rectangle per orb. SwiftUI's `.help` needs the view to
    /// be hit, and this one lets clicks through, so AppKit's own tooltip
    /// rectangles carry the names instead.
    private func placeTooltips() {
        tips.forEach(removeToolTip)
        tips = []
        tipRects = []
        let count = model.orbs.count + model.more
        let offsets = PillBusy.orbOffsets(count)
        let width = PillBusy.rowWidth(count)
        // The row is drawn against the right edge.
        let left = bounds.width - Self.inset - width
        let d = PillBusy.diameter
        for (i, orb) in model.orbs.enumerated() where i < offsets.count {
            let rect = NSRect(x: left + offsets[i], y: (bounds.height - d) / 2, width: d, height: d)
            tips.append(addToolTip(rect, owner: self, userData: nil))
            tipRects.append((rect, orb.tooltip))
        }
    }

    private var tipRects: [(NSRect, String)] = []
}

extension MiniOrbsHost: NSViewToolTipOwner {
    nonisolated func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag,
                          point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        MainActor.assumeIsolated { tipRects.first { $0.0.contains(point) }?.1 ?? "" }
    }
}
