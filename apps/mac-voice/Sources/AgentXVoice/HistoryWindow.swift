import AppKit
import SwiftUI

/// History: past voice exchanges by day, filterable by agent.
///
/// The daemon keeps the records (every /ask turn is a task trace on the
/// voice channel); the window reads them and keeps no copy. The list holds
/// summaries only, and an answer in full is fetched when it is selected.
/// Replay goes through the daemon's speaking queue, like any answer.
@MainActor
final class HistoryStore: ObservableObject {
    static let pageSize = 30

    @Published var exchanges: [VoiceExchange] = []
    @Published var next: String?
    /// nil shows every agent.
    @Published var agent: String? { didSet { if agent != oldValue { reload() } } }
    @Published var agents: [AgentClient.AgentInfo] = []
    @Published var selected: String? { didSet { if selected != oldValue { loadDetail() } } }
    @Published var detail: VoiceExchangeDetail?
    @Published var loading = false
    @Published var error = ""
    @Published var notice = ""

    /// Swapped for fixed data when rendering screenshots.
    var fetchPage: (String?, Int, String?) async -> Result<VoiceHistoryPage, HistoryClient.HistoryFailure> = HistoryClient.page
    var fetchDetail: (String) async -> VoiceExchangeDetail? = HistoryClient.detail
    var fetchAgents: () async -> [AgentClient.AgentInfo]? = AgentClient.agents

    var days: [HistoryDay] { HistoryLogic.groupByDay(exchanges) }

    func name(of id: String) -> String { agents.first { $0.id == id }?.label ?? id }

    func color(of id: String) -> Color {
        Color(hex: OrbMath.colorHex(agentID: id, configured: agents.first { $0.id == id }?.color))
    }

    func reload() {
        loading = true
        error = ""
        Task {
            if agents.isEmpty, let a = await fetchAgents() { agents = a }
            let result = await fetchPage(agent, Self.pageSize, nil)
            loading = false
            switch result {
            case .success(let page):
                exchanges = page.exchanges
                next = page.next
                if selected == nil || !exchanges.contains(where: { $0.id == selected }) { selected = exchanges.first?.id }
            case .failure(let f):
                exchanges = []
                next = nil
                error = f.message
            }
        }
    }

    func loadOlder() {
        guard let before = next, !loading else { return }
        loading = true
        Task {
            let result = await fetchPage(agent, Self.pageSize, before)
            loading = false
            switch result {
            case .success(let page):
                exchanges = HistoryLogic.merge(exchanges, page.exchanges)
                next = page.next
            case .failure(let f):
                error = f.message
            }
        }
    }

    private func loadDetail() {
        detail = nil
        guard let id = selected else { return }
        Task {
            let d = await fetchDetail(id)
            if selected == id { detail = d }
        }
    }

    func replay(_ id: String) {
        notice = ""
        error = ""
        Task {
            if let problem = await HistoryClient.replay(id) { error = problem }
            else { notice = "Queued. It plays after anything already speaking." }
        }
    }

    func copy(_ d: VoiceExchangeDetail) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(d.answer ?? "", forType: .string)
        notice = "Answer copied."
    }

    func openTask(_ d: VoiceExchangeDetail) {
        guard let url = URL(string: Config.dashboardURL + d.taskPath) else { return }
        NSWorkspace.shared.open(url)
    }
}

struct HistoryView: View {
    @ObservedObject var store: HistoryStore

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            HStack(spacing: 0) {
                list.frame(width: 320)
                Divider()
                detailPane.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if !store.error.isEmpty || !store.notice.isEmpty { footer }
        }
        .frame(minWidth: 760, minHeight: 480)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Picker("Agent", selection: $store.agent) {
                Text("All agents").tag(String?.none)
                ForEach(store.agents, id: \.id) { a in Text(a.label).tag(String?.some(a.id)) }
            }
            .frame(width: 220)
            Spacer()
            if store.loading { ProgressView().controlSize(.small) }
            Button("Refresh") { store.reload() }
                .keyboardShortcut("r", modifiers: .command)
        }
        .padding(10)
    }

    @ViewBuilder private var list: some View {
        if store.exchanges.isEmpty {
            Text(store.loading ? "Loading…" : store.error.isEmpty ? "No voice exchanges yet." : "Nothing to show.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(selection: $store.selected) {
                ForEach(store.days, id: \.title) { day in
                    Section(day.title) {
                        ForEach(day.exchanges) { e in row(e).tag(e.id) }
                    }
                }
                if store.next != nil {
                    Button("Load older") { store.loadOlder() }
                        .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.inset)
        }
    }

    private func row(_ e: VoiceExchange) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle().fill(store.color(of: e.agentId)).frame(width: 8, height: 8)
                Text(store.name(of: e.agentId)).font(.caption.weight(.semibold))
                Spacer()
                Text(e.date, style: .time).font(.caption).foregroundStyle(.secondary)
                Text(HistoryLogic.duration(e.durationMs)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(e.question).fontWeight(.medium).lineLimit(2)
            Text(e.failed ? (e.error ?? "No answer") : e.answerPreview)
                .font(.callout)
                .foregroundStyle(e.failed ? Color(nsColor: Brand.alert) : .secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var detailPane: some View {
        if let d = store.detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 6) {
                        Circle().fill(store.color(of: d.agentId)).frame(width: 10, height: 10)
                        Text(store.name(of: d.agentId)).font(.headline)
                        Spacer()
                        Text("Answered in \(HistoryLogic.duration(d.durationMs))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("YOU SAID").font(.caption2.monospaced()).tracking(0.8).foregroundStyle(.secondary)
                        Text(d.question).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ANSWER").font(.caption2.monospaced()).tracking(0.8).foregroundStyle(.secondary)
                        if let answer = d.answer, !answer.isEmpty {
                            Text(written(answer)).textSelection(.enabled)
                            if d.truncated { Text("The answer is longer; open the task for all of it.").font(.caption).foregroundStyle(.secondary) }
                        } else {
                            Text(d.error ?? "No answer was recorded.").foregroundStyle(Color(nsColor: Brand.alert))
                        }
                    }
                    if !d.links.isEmpty {
                        HStack(spacing: 8) {
                            ForEach(d.links, id: \.1) { link in
                                if let url = URL(string: link.1) { Link(link.0, destination: url) }
                            }
                        }
                    }
                    Divider()
                    HStack(spacing: 8) {
                        Button("Replay") { store.replay(d.id) }
                            .disabled(!(d.answer?.isEmpty == false))
                            .keyboardShortcut(.return, modifiers: .command)
                        Button("Copy") { store.copy(d) }
                            .disabled(!(d.answer?.isEmpty == false))
                            .keyboardShortcut("c", modifiers: [.command, .shift])
                        Button("Open task in dashboard") { store.openTask(d) }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            Text(store.selected == nil ? "Select an exchange." : "Loading…")
                .foregroundStyle(.secondary)
        }
    }

    /// The answer as written: markdown links and bare URLs as links.
    private func written(_ answer: String) -> AttributedString {
        let md = HistoryLogic.linkify(answer)
        return (try? AttributedString(markdown: md, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(answer)
    }

    private var footer: some View {
        HStack {
            Text(store.error.isEmpty ? store.notice : store.error)
                .foregroundStyle(store.error.isEmpty ? Color.secondary : Color(nsColor: .systemRed))
                .font(.callout)
            Spacer()
        }
        .padding(10)
    }
}

@MainActor
final class HistoryWindow: NSObject {
    static let shared = HistoryWindow()
    let store = HistoryStore()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 560),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
            w.title = "AgentX Voice History"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: HistoryView(store: store))
            w.center()
            window = w
        }
        store.agents = []
        store.reload()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

/// The menu's last three exchanges, for a quick replay.
@MainActor
final class RecentExchanges: NSObject {
    private(set) var items: [VoiceExchange] = []

    func refresh() async {
        if case .success(let page) = await HistoryClient.page(agent: nil, limit: 3) { items = page.exchanges }
    }

    /// A "Recent" section, or nothing when there is no history.
    func addItems(to menu: NSMenu, name: (String) -> String) {
        guard !items.isEmpty else { return }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem.sectionHeader(title: "Recent · click to replay"))
        for e in items {
            let row = NSMenuItem(title: HistoryLogic.menuTitle(e, agentName: name(e.agentId)),
                                 action: #selector(replay(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = e.id
            row.isEnabled = e.canReplay
            row.toolTip = e.answerPreview.isEmpty ? nil : e.answerPreview
            menu.addItem(row)
        }
    }

    @objc private func replay(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Task {
            if let problem = await HistoryClient.replay(id) { Log.warn("history replay: \(problem)") }
        }
    }
}
