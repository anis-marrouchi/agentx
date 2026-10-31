import AppKit
import SwiftUI

/// The open-requests list (#1455): one row per request the widget has
/// sent, beside the pill.
///
/// It opens three ways. Hovering the pill for half a second opens it for
/// as long as the pointer is on the pill or the list. A click on the mini
/// orbs or on "1 new", or ⌘⌥O, opens it until Esc or a click elsewhere,
/// with the keyboard in it: ↑ ↓ move, Return picks, ⌘⌫ closes, Esc hides.
/// Picking or closing a row is the app's to do (`onPick`, `onClose`). A
/// thinking row asks before it closes: let it finish (Return), stop the
/// agent (Tab, then Return or Space), or keep it (Esc). What the rows say comes from
/// OpenRequests.swift, which is tested without a window.
///
/// Past five rows the list groups by agent: one row per agent, and picking
/// it opens that agent's rows, with a way back (← or Esc) and to its
/// History.
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

    /// The rows now, the newest last when true. Set by the app.
    var rows: (_ newestLast: Bool) -> [RequestsModel.Row] = { _ in [] }
    /// Where the pill is, to stand beside it and to stay open over it.
    var pillFrame: () -> NSRect = { .zero }

    static let width: CGFloat = 360
    /// The header, one row, and the padding under the last row.
    private static let headerHeight: CGFloat = 40
    private static let rowHeight: CGFloat = 52
    private static let bottomPadding: CGFloat = 8
    /// "Close heard", and Undo after a close.
    private static let footerHeight: CGFloat = 34
    private static let emptyHeight: CGFloat = 104
    /// A failed row opened: its reason and Ask again under it.
    private static let reasonHeight: CGFloat = 56
    /// "Can’t reach AgentX on this Mac", with Try now and the dashboard.
    private static let unreachableHeight: CGFloat = 92
    /// Two placeholder rows while the daemon is slow to answer.
    private static let loadingRows = 2

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
        model.onOpenAgent = { [weak self] agent in MainActor.assumeIsolated { self?.openAgent(agent) } }
        model.onBack = { [weak self] in MainActor.assumeIsolated { self?.back() } }
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
        model.confirming = nil
        model.opened = nil
        model.expanded = nil
        orderOut(nil)
    }

    /// An agent's row in the grouped list was picked: its rows show.
    @MainActor
    func openAgent(_ agentID: String) {
        model.opened = agentID
        model.selected = nil
        reload()
        if model.keyboard { model.selected = model.rows.first?.id }
    }

    /// Back from an agent's rows to one row per agent, on that agent.
    @MainActor
    func back() {
        guard let agent = model.opened else { return }
        model.opened = nil
        reload()
        model.selected = model.rows.first { $0.agent == agent }?.id
    }

    /// The rows again, and the list's size and place for them. Cheap:
    /// SwiftUI redraws only what changed.
    @MainActor
    func reload() {
        guard mode != nil else { return }
        let pill = pillFrame()
        // The agent opened has no rows left: back to every agent.
        if model.opened != nil && rows(true).isEmpty { model.opened = nil }
        let count = rows(true).count
        let footer = count > 0 || model.undo != nil ? Self.footerHeight : 0
        var height: CGFloat
        switch model.status {
        case .loading where count == 0:
            height = Self.headerHeight + CGFloat(Self.loadingRows) * Self.rowHeight + Self.bottomPadding
        case .unreachable:
            height = Self.headerHeight + Self.unreachableHeight + CGFloat(count) * Self.rowHeight + Self.bottomPadding + footer
        default:
            height = (count == 0 ? Self.emptyHeight
                : Self.headerHeight + CGFloat(count) * Self.rowHeight + Self.bottomPadding) + footer
        }
        if let open = model.expanded, rows(true).contains(where: { $0.id == open && $0.reason != nil }) {
            height += Self.reasonHeight
        }
        let screen = NSScreen.screens.first { $0.frame.intersects(pill) } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let spot = PillPlacement.list(width: Self.width, height: height, pill: pill, visible: visible)
        above = spot.above
        let fresh = rows(above)
        if model.rows != fresh { model.rows = fresh }
        if let s = model.selected, !fresh.contains(where: { $0.id == s }) { model.selected = nil }
        if let c = model.confirming, !fresh.contains(where: { $0.id == c && $0.cue == .thinking }) { model.confirming = nil }
        if let e = model.expanded, !fresh.contains(where: { $0.id == e && $0.reason != nil }) { model.expanded = nil }
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
        // A thinking row asking before it closes: Return lets it finish,
        // Tab moves to Stop (never the default), Esc keeps it.
        if let id = model.confirming {
            switch event.keyCode {
            case 48: model.confirmOnStop.toggle() // Tab
            case 36, 76: model.onConfirm?(id, model.confirmOnStop ? .stop : .letItFinish)
            case 49 where model.confirmOnStop: model.onConfirm?(id, .stop) // Space
            case 53: model.onConfirm?(id, .keep)
            default: break
            }
            return true
        }
        switch event.keyCode {
        case 51 where event.modifierFlags.contains(.command): // ⌘⌫
            if let id = model.selected, model.agent(of: id) == nil { model.onClose?(id) }
            return true
        case 123 where model.opened != nil: // ←
            back()
            return true
        case 125, 126: // ↓ ↑
            model.keyboard = true
            model.selected = OpenRequests.move(model.selected, by: event.keyCode == 125 ? 1 : -1, in: ids)
            return true
        case 36, 76: // Return, Enter
            guard let id = model.selected else { return true }
            // A failed row already opened: Return asks again.
            if model.expanded == id { model.onAskAgain?(id) } else { model.pick(id) }
            return true
        case 53: // Esc: back from an agent's rows, else hide
            if model.opened != nil { back() } else { dismissList() }
            return true
        default:
            return false
        }
    }

    /// The row the keyboard is on, while the list shows: the talk key then
    /// talks to its agent. Never an agent's row.
    @MainActor
    var selectedRow: Int? {
        guard isOpen, let id = model.selected, model.agent(of: id) == nil else { return nil }
        return id
    }

    /// The agent of the agent's row the keyboard is on, while the list
    /// shows; or the agent opened.
    @MainActor
    var selectedAgent: String? {
        guard isOpen else { return nil }
        return model.selected.flatMap(model.agent(of:)) ?? model.opened
    }
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
        /// answer", "See why", "Open"; nil while there is nothing to hear yet.
        let action: String?
        /// An agent's row in the grouped list: the agent it opens.
        var agent: String? = nil
        /// Why it failed, in one line: shown under the row once picked.
        var reason: String? = nil
    }

    /// Where the list stands with the daemon that keeps it.
    enum Status: Equatable {
        /// The daemon answered the last read.
        case ready
        /// The first read is taking longer than half a second.
        case loading
        /// The daemon did not answer: the rows come back when it does.
        case unreachable
    }

    @Published var rows: [Row] = []
    @Published var status: Status = .ready
    /// The failed row opened in place, with its reason and Ask again.
    @Published var expanded: Int?
    /// "Ask again" on a failed row. Set by the app.
    var onAskAgain: ((Int) -> Void)?
    /// "Try now" while the daemon is unreachable. Set by the app.
    var onRetry: (() -> Void)?
    /// "Open the dashboard". Set by the app.
    var onDashboard: (() -> Void)?
    /// The row the keyboard is on.
    @Published var selected: Int?
    /// The keyboard is in the list: the selected row has a ring.
    @Published var keyboard = false
    /// A row was clicked, or Return pressed on it. Set by the app.
    var onPick: ((Int) -> Void)?
    /// An agent's row picked: open it. Set by the window.
    var onOpenAgent: ((String) -> Void)?
    /// The agent whose rows show, in the grouped list; nil for all.
    @Published var opened: String?
    /// Its name, for the header.
    @Published var openedName = ""
    /// "History" beside an agent opened: its earlier conversations.
    var onHistory: ((String) -> Void)?

    func agent(of id: Int) -> String? { rows.first { $0.id == id }?.agent }

    /// A row clicked, or Return on it: an agent's row opens, a request is
    /// the app's to pick.
    func pick(_ id: Int) {
        if let agent = agent(of: id) { onOpenAgent?(agent) } else { onPick?(id) }
    }

    /// The row's × or ⌘⌫. Set by the app.
    var onClose: ((Int) -> Void)?
    /// What to do with a thinking row being closed.
    enum CloseChoice { case letItFinish, stop, keep }
    /// The thinking row asking before it closes.
    @Published var confirming: Int? {
        didSet { if confirming != oldValue { confirmOnStop = false } }
    }
    /// Tab moved the confirm to "Stop".
    @Published var confirmOnStop = false
    var onConfirm: ((Int, CloseChoice) -> Void)?
    /// "Closed Ops’s request", with Undo, for a few seconds after a close.
    @Published var undo: String?
    var onUndo: (() -> Void)?
    /// "Close heard": every heard answer and every failure.
    var onCloseHeard: (() -> Void)?
    /// The header's back arrow, beside an agent opened. Set by the window.
    var onBack: (() -> Void)?
    /// Every request, however the rows are grouped. Set by the app.
    @Published var total = 0
    /// A heard answer or a failure in the list. Set by the app.
    @Published var hasHeard = false
}

struct RequestsView: View {
    @ObservedObject var model: RequestsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let agent = model.opened {
                    Button(action: { model.onBack?() }) {
                        Image(systemName: "chevron.left").font(.system(size: 11, weight: .bold))
                    }
                    .buttonStyle(.borderless)
                    .help("Every agent (←)")
                    .accessibilityLabel("Back to every agent")
                    Text(model.openedName)
                        .font(.system(size: 13, weight: .bold))
                        .lineLimit(1)
                    Button("History") { model.onHistory?(agent) }
                        .buttonStyle(.borderless)
                        .font(.system(size: 12))
                        .accessibilityHint("Opens \(model.openedName)’s earlier conversations")
                } else {
                    Text("Open requests")
                        .font(.system(size: 13, weight: .bold))
                }
                if model.opened == nil && model.total > 0 {
                    Text("\(model.total)")
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
            .accessibilityElement(children: model.opened == nil ? .combine : .contain)
            .accessibilityAddTraits(.isHeader)

            if model.status == .unreachable {
                Unreachable(retry: { model.onRetry?() }, dashboard: { model.onDashboard?() })
            }
            if model.rows.isEmpty && model.status == .loading {
                VStack(spacing: 0) {
                    ForEach(0..<2, id: \.self) { _ in LoadingRow() }
                }
                .padding(.horizontal, 6)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading open requests")
            } else if model.rows.isEmpty && model.status == .unreachable {
                EmptyView()
            } else if model.rows.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nothing open")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Hold ⌥Space and ask any agent. Each request shows here until you close it.")
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
                                Group {
                                    if model.confirming == row.id {
                                        CloseConfirm(row: row, onStop: model.confirmOnStop,
                                                     choose: { model.onConfirm?(row.id, $0) })
                                    } else {
                                        VStack(alignment: .leading, spacing: 0) {
                                            RequestRow(row: row,
                                                       selected: model.selected == row.id,
                                                       ring: model.keyboard && model.selected == row.id,
                                                       pick: { model.pick(row.id) },
                                                       close: { model.onClose?(row.id) })
                                            if model.expanded == row.id, let reason = row.reason {
                                                FailedReason(reason: reason, askAgain: { model.onAskAgain?(row.id) })
                                            }
                                        }
                                    }
                                }
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
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !model.rows.isEmpty || model.undo != nil { footer }
        }
    }

    /// "Close heard" on the left; after a close, its line and Undo.
    private var footer: some View {
        HStack(spacing: 8) {
            if !model.rows.isEmpty {
                Button("Close heard") { model.onCloseHeard?() }
                    .buttonStyle(.borderless)
                    .font(.system(size: 12))
                    .disabled(!model.hasHeard)
                    .accessibilityHint("Closes every heard answer and every failure")
            }
            Spacer(minLength: 0)
            if let undo = model.undo {
                Text(undo)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Button("Undo") { model.onUndo?() }
                    .buttonStyle(.borderless)
                    .font(.system(size: 12, weight: .semibold))
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 34)
        .overlay(alignment: .top) { Divider().opacity(0.5) }
    }
}

/// A failed row, picked: why, in one line, and Ask again, which sends the
/// same words to the same agent as a new request.
struct FailedReason: View {
    let reason: String
    let askAgain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(reason)
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.tail)
            Button(OpenRequests.askAgain, action: askAgain)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .font(.system(size: 11.5))
        }
        .padding(.leading, 40)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: 56, maxHeight: 56, alignment: .topLeading)
        .accessibilityElement(children: .contain)
    }
}

/// The daemon did not answer the last read: the rows are kept by AgentX
/// and come back when it answers. The app tries again every few seconds.
struct Unreachable: View {
    let retry: () -> Void
    let dashboard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(OpenRequests.unreachableTitle)
                .font(.system(size: 13, weight: .semibold))
            Text(OpenRequests.unreachableBody)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button("Try now", action: retry)
                Button("Open the dashboard", action: dashboard)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .font(.system(size: 11.5))
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: 92, maxHeight: 92, alignment: .topLeading)
        .accessibilityElement(children: .contain)
    }
}

/// A grey placeholder row while the daemon is slow with the first read.
struct LoadingRow: View {
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Color.primary.opacity(0.08)).frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 6) {
                Capsule().fill(Color.primary.opacity(0.08)).frame(width: 130, height: 9)
                Capsule().fill(Color.primary.opacity(0.06)).frame(width: 220, height: 9)
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52, alignment: .leading)
    }
}

/// A thinking row being closed asks first: "Writer is still thinking",
/// let it finish (the default), stop it (never the default), or keep it.
struct CloseConfirm: View {
    let row: RequestsModel.Row
    /// Tab moved the keyboard to Stop.
    let onStop: Bool
    let choose: (RequestsModel.CloseChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(OpenRequests.stillThinking(name: row.name))
                .font(.system(size: 12.5, weight: .semibold))
                .lineLimit(1)
            HStack(spacing: 6) {
                Button(OpenRequests.letItFinish) { choose(.letItFinish) }
                    .buttonStyle(.borderedProminent)
                    .tint(onStop ? Color.secondary : RequestRow.blue)
                Button(OpenRequests.stopAgent(name: row.name)) { choose(.stop) }
                    .buttonStyle(.bordered)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(RequestRow.red, lineWidth: onStop ? 2 : 0))
                Button(OpenRequests.keep) { choose(.keep) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .font(.system(size: 11.5))
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.06)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(OpenRequests.stillThinking(name: row.name))
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
    /// The × on hover and on the keyboard's row.
    let close: () -> Void
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
            if (hovering || selected) && row.agent == nil {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .help("Close (⌘⌫)")
                .accessibilityLabel("Close")
            } else {
                Text(row.ago)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
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
            if row.agent == nil { Button("Close", action: close) }
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
