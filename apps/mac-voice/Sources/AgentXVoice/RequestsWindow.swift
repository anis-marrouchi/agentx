import AppKit
import SwiftUI

/// The open-requests list (#1455): one row per request the widget has
/// sent, beside the pill.
///
/// It opens three ways. Hovering the pill for half a second opens it for
/// as long as the pointer is on the pill or the list. A click on the mini
/// orbs or on "1 new", or ⌘⌥O, opens it until Esc or a click elsewhere,
/// with the keyboard in it: ↑ ↓ move, Return picks, Esc hides. Picking a
/// row is the app's to do (`onPick`). What the rows say comes from
/// OpenRequests.swift, which is tested without a window.
///
/// Past five requests it shows one row per agent. Picking an agent's row
/// opens that agent's requests in the list, with its earlier
/// conversations a click away; ← or Esc goes back to the agents.
///
/// A floating non-activating panel like the pill, so opening it never
/// takes the keyboard from the app in front unless the owner asked for
/// the keyboard (a click or the shortcut).
final class RequestsWindow: NSPanel {
    enum Mode {
        /// Opened by hovering the pill: goes when the pointer leaves both.
        case hover
        /// Opened by a click or the shortcut: stays until Esc or a click
        /// elsewhere, and holds the keyboard.
        case pinned
    }

    let model = RequestsModel()
    /// Nil while the list is hidden.
    private(set) var mode: Mode?
    var isOpen: Bool { mode != nil }
    /// The list is above the pill: its newest row at the bottom, next to it.
    private(set) var above = true

    /// The rows now, the newest last when true: one agent's requests when
    /// `agent` is set, else the whole list. Set by the app.
    var rows: (_ newestLast: Bool, _ agent: String?) -> [RequestsModel.Row] = { _, _ in [] }
    /// Where the pill is, to stand beside it and to stay open over it.
    var pillFrame: () -> NSRect = { .zero }
    /// An agent's name, for the header over its requests. Set by the app.
    var agentName: (String) -> String = { $0 }

    static let width: CGFloat = 360
    /// The header, one row, and the padding under the last row.
    private static let headerHeight: CGFloat = 40
    private static let rowHeight: CGFloat = 52
    private static let bottomPadding: CGFloat = 8
    private static let emptyHeight: CGFloat = 92
    /// "Earlier conversations with …", under one agent's requests.
    private static let footerHeight: CGFloat = 36

    /// Counts the thinking clocks while the list shows.
    private var tick: Timer?
    /// The pointer left: hide in a moment unless it comes back.
    private var leaveCheck: DispatchWorkItem?

    init() {
        let frame = NSRect(x: 0, y: 0, width: Self.width, height: Self.emptyHeight)
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        setAccessibilityLabel("Open requests")

        let surface = Surface(frame: frame)
        contentView = surface
        model.onOpenAgent = { [weak self] agent in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.openAgent(agent)
            }
        }
        model.onBack = { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.backToAgents()
            }
        }
        let host = RequestsHost(rootView: RequestsView(model: model))
        host.frame = surface.bounds
        host.autoresizingMask = [.width, .height]
        surface.addSubview(host)
        surface.addTrackingArea(NSTrackingArea(rect: .zero,
                                               options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                               owner: self, userInfo: nil))
    }

    // Borderless panels refuse key status unless told otherwise. The list
    // takes it only when opened by a click or the shortcut.
    override var canBecomeKey: Bool { true }

    // MARK: Open and close

    /// Show the list beside the pill. Hovering never turns a list opened
    /// by a click or the shortcut back into one that closes by itself.
    /// `select`: the row the keyboard starts on, when opened for it.
    @MainActor
    func open(_ mode: Mode, select: Int? = nil) {
        leaveCheck?.cancel()
        leaveCheck = nil
        if self.mode != .pinned { self.mode = mode }
        if mode == .pinned {
            model.keyboard = select != nil
            if let select { model.selected = select }
        }
        reload()
        orderFrontRegardless()
        if self.mode == .pinned { makeKey() }
        if tick == nil {
            tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                Task { @MainActor [weak self] in self?.reload() }
            }
        }
    }

    @MainActor
    func dismissList() {
        guard mode != nil else { return }
        mode = nil
        tick?.invalidate()
        tick = nil
        leaveCheck?.cancel()
        leaveCheck = nil
        model.keyboard = false
        model.selected = nil
        model.agent = nil
        orderOut(nil)
    }

    /// One agent's requests in place of the agents, the keyboard on the
    /// newest, next to the pill.
    @MainActor
    func openAgent(_ agent: String) {
        // A click on an agent's row in a list opened by hovering keeps it
        // open: its rows change under the pointer.
        if mode == .hover { mode = .pinned; makeKey() }
        model.agentName = agentName(agent)
        model.agent = agent
        reload()
        model.selected = above ? model.rows.last?.id : model.rows.first?.id
    }

    /// Back from one agent's requests to the agents, on that agent's row.
    @MainActor
    func backToAgents() {
        guard let agent = model.agent else { return }
        model.agent = nil
        reload()
        model.selected = model.rows.first { $0.group == agent }?.id
    }

    /// The rows again, and the list's size and place for them. Cheap:
    /// SwiftUI redraws only what changed.
    @MainActor
    func reload() {
        guard mode != nil else { return }
        let pill = pillFrame()
        // The agent's requests all left, or the list is flat again.
        if let agent = model.agent, rows(true, agent).isEmpty || !rows(true, nil).contains(where: { $0.group != nil }) {
            model.agent = nil
        }
        let count = rows(true, model.agent).count
        let height = count == 0 ? Self.emptyHeight
            : Self.headerHeight + CGFloat(count) * Self.rowHeight + Self.bottomPadding
                + (model.agent == nil ? 0 : Self.footerHeight)
        let screen = NSScreen.screens.first { $0.frame.intersects(pill) } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let spot = PillPlacement.list(width: Self.width, height: height, pill: pill, visible: visible)
        above = spot.above
        let fresh = rows(above, model.agent)
        if model.rows != fresh { model.rows = fresh }
        if let s = model.selected, !fresh.contains(where: { $0.id == s }) { model.selected = nil }
        if frame != spot.frame { setFrame(spot.frame, display: true) }
    }

    /// The pointer left the pill or the list. A list opened by hovering
    /// goes a moment later, unless the pointer is back on either.
    @MainActor
    func pointerLeft() {
        guard mode == .hover else { return }
        leaveCheck?.cancel()
        let check = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.mode == .hover else { return }
                let at = NSEvent.mouseLocation
                if self.frame.contains(at) || self.pillFrame().contains(at) { return }
                self.dismissList()
            }
        }
        leaveCheck = check
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: check)
    }

    override func mouseEntered(with event: NSEvent) {
        MainActor.assumeIsolated {
            leaveCheck?.cancel()
            leaveCheck = nil
        }
    }

    override func mouseExited(with event: NSEvent) {
        MainActor.assumeIsolated { pointerLeft() }
    }

    /// A click elsewhere: a list opened by a click or the shortcut goes.
    override func resignKey() {
        super.resignKey()
        MainActor.assumeIsolated {
            if mode == .pinned { dismissList() }
        }
    }

    // MARK: Keyboard

    /// ↑ ↓ Return and Esc, taken before SwiftUI sees them, so the list
    /// answers the same keys whatever has focus inside it.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, MainActor.assumeIsolated({ key(event) }) { return }
        super.sendEvent(event)
    }

    @MainActor
    private func key(_ event: NSEvent) -> Bool {
        let ids = model.rows.map(\.id)
        switch event.keyCode {
        case 125, 126: // ↓ ↑
            model.keyboard = true
            model.selected = OpenRequests.move(model.selected, by: event.keyCode == 125 ? 1 : -1, in: ids)
            return true
        case 36, 76: // Return, Enter
            guard let id = model.selected, let row = model.rows.first(where: { $0.id == id }) else { return true }
            model.pick(row)
            return true
        case 124: // →: into an agent's requests
            guard let id = model.selected, let agent = model.rows.first(where: { $0.id == id })?.group else { return false }
            openAgent(agent)
            return true
        case 123: // ←: back to the agents
            guard model.agent != nil else { return false }
            backToAgents()
            return true
        case 53: // Esc: back to the agents first, then hide
            if model.agent != nil { backToAgents() } else { dismissList() }
            return true
        default:
            return false
        }
    }

    /// The row the keyboard is on, while the list shows: the talk key then
    /// talks to its agent.
    @MainActor
    var selectedRow: Int? { isOpen ? model.selected : nil }
}

/// Takes the first click even while the list is not the key window, so a
/// row picked from a list opened by hovering is picked at once.
private final class RequestsHost: NSHostingView<RequestsView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// What the list shows. Rows are made by the app from OpenRequests.
@MainActor
final class RequestsModel: ObservableObject {
    struct Row: Identifiable, Equatable {
        enum Cue: Equatable { case waiting, thinking, ready, heard, failed }
        let id: Int
        /// An agent's row in a grouped list: picking it opens that agent's
        /// requests. Nil for a request's own row.
        var group: String? = nil
        let name: String
        /// "Thinking, 1:12", "Answer ready", "Heard", "Couldn’t answer".
        let state: String
        /// The first words of the request.
        let words: String
        /// "now", "2 min".
        let ago: String
        let cue: Cue
        /// An answer or a failure not seen yet: a blue dot and a bold name.
        let isNew: Bool
        let tint: NSColor
        let colors: [NSColor]?
        /// The whole row, as VoiceOver reads it.
        let voiceOver: String
        /// What picking it does, for VoiceOver: "Listen", "Show the
        /// answer", "See why"; nil while there is nothing to hear yet.
        let action: String?
    }

    @Published var rows: [Row] = []
    /// The row the keyboard is on.
    @Published var selected: Int?
    /// The keyboard is in the list: the selected row has a ring.
    @Published var keyboard = false
    /// The agent whose requests the list shows; nil shows them all.
    @Published var agent: String?
    /// The agent's name, for the header while its requests show.
    var agentName = ""
    /// A request's row was clicked, or Return pressed on it. Set by the app.
    var onPick: ((Int) -> Void)?
    /// An agent's row was picked. Set by the window.
    var onOpenAgent: ((String) -> Void)?
    /// "Earlier conversations with …": the agent's history. Set by the app.
    var onHistory: ((String) -> Void)?
    /// Back to the agents. Set by the window.
    var onBack: (() -> Void)?

    func pick(_ row: Row) {
        if let agent = row.group { onOpenAgent?(agent) } else { onPick?(row.id) }
    }
}

struct RequestsView: View {
    @ObservedObject var model: RequestsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if model.agent != nil {
                    Button(action: { model.onBack?() }) {
                        Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to all agents")
                    Text(model.agentName)
                        .font(.system(size: 13, weight: .bold))
                        .lineLimit(1)
                } else {
                    Text("Open requests")
                        .font(.system(size: 13, weight: .bold))
                }
                if !model.rows.isEmpty {
                    Text("\(model.rows.count)")
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .background(Capsule().fill(Color.primary.opacity(0.08)))
                }
                Spacer(minLength: 0)
                Text("⌘⌥O")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Shortcut: Command Option O")
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            if model.rows.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nothing open")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Hold ⌥Space and ask any agent.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .accessibilityElement(children: .combine)
            } else {
                ScrollViewReader { scroller in
                    ScrollView(.vertical) {
                        VStack(spacing: 0) {
                            ForEach(model.rows) { row in
                                RequestRow(row: row,
                                           selected: model.selected == row.id,
                                           ring: model.keyboard && model.selected == row.id,
                                           pick: { model.pick(row) })
                                    .id(row.id)
                            }
                        }
                        .padding(.horizontal, 6)
                        .padding(.bottom, 8)
                    }
                    .onChange(of: model.selected) { _, id in
                        if let id { scroller.scrollTo(id) }
                    }
                }
                if let agent = model.agent {
                    Button(action: { model.onHistory?(agent) }) {
                        HStack(spacing: 6) {
                            Image(systemName: "clock.arrow.circlepath")
                            Text("Earlier conversations with \(model.agentName)")
                                .lineLimit(1)
                        }
                        .font(.system(size: 12))
                        .foregroundStyle(RequestRow.blue)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .accessibilityHint("Opens History for this agent")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// One request: its agent's orb, name and state, the first words of the
/// request, and how long ago it was sent.
struct RequestRow: View {
    let row: RequestsModel.Row
    let selected: Bool
    /// The keyboard is on this row.
    let ring: Bool
    let pick: () -> Void
    @State private var hovering = false

    /// The "not heard" blue, lighter in dark so it reads on the dark pill.
    static let blue = Color(nsColor: NSColor(name: nil) { look in
        look.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.478, green: 0.635, blue: 1, alpha: 1)      // #7aa2ff
            : NSColor(srgbRed: 0.114, green: 0.306, blue: 0.847, alpha: 1)  // #1d4ed8
    })
    /// "Couldn’t answer", readable on both themes.
    static let red = Color(nsColor: NSColor(name: nil) { look in
        look.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 1, green: 0.561, blue: 0.529, alpha: 1)      // #ff8f87
            : NSColor(srgbRed: 0.706, green: 0.137, blue: 0.094, alpha: 1)  // #b42318
    })

    var body: some View {
        HStack(spacing: 10) {
            MiniOrb(orb: orb, t: 0, still: true)
                .frame(width: PillBusy.diameter, height: PillBusy.diameter)
                .scaleEffect(1.4)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    if row.isNew {
                        Circle().fill(Self.blue).frame(width: 8, height: 8)
                    }
                    Text(row.name)
                        .font(.system(size: 13, weight: row.isNew ? .bold : .semibold))
                        .lineLimit(1)
                    Text("· " + row.state)
                        .font(.system(size: 11.5, weight: row.cue == .ready || row.cue == .failed ? .semibold : .regular))
                        .foregroundStyle(stateColor)
                        .lineLimit(1)
                }
                Text(row.words)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 4)
            Text(row.ago)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.primary.opacity(hovering || selected ? 0.06 : 0)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(Self.blue, lineWidth: ring ? 2 : 0))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: pick)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.voiceOver)
        .accessibilityAddTraits(row.action == nil ? [] : .isButton)
        .accessibilityActions {
            if let action = row.action {
                Button(action, action: pick)
            }
        }
    }

    private var stateColor: Color {
        switch row.cue {
        case .ready: return Self.blue
        case .failed: return Self.red
        case .waiting, .thinking, .heard: return .secondary
        }
    }

    /// The row's orb is the pill's mini orb, still, with the same cues.
    private var orb: MiniOrbsModel.Orb {
        let activity: PillBusy.Activity
        switch row.cue {
        case .thinking: activity = .thinking
        case .ready: activity = .ready
        case .failed: activity = .failed
        // Waiting, or heard: the small dimmed dot, with no ring.
        case .waiting, .heard: activity = .queued
        }
        return MiniOrbsModel.Orb(agentID: "\(row.id)", activity: activity, queued: 0,
                                 tint: row.tint, colors: row.colors, tooltip: row.voiceOver)
    }
}
