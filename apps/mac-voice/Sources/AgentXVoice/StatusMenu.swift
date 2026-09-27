import AppKit

/// The menu-bar icon: what the assistant is doing, and who it talks to.
///
/// One menu serves the icon and the pill's right-click, so there is one
/// place that says which agent answers and one way to change it.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    let menu = NSMenu()
    /// Variable width: the badge with the number of queued lines sits beside the icon.
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    private enum Roster {
        case loading
        /// The daemon did not answer. Said so, with a retry, rather than
        /// an empty list that looks like "you have no agents".
        case down
        case loaded([AgentClient.AgentInfo])
    }
    private var roster = Roster.loading
    /// Reopen the menu once the retry's answer is in.
    private var reopenAfterRefresh = false
    /// The daemon's speaking queue, polled while anything is in flight.
    private var queue: AgentClient.QueueState?
    private var queuePoll: Timer?

    /// Questions this widget has in flight, per agent. Set by the app.
    var thinking: [String: Int] = [:] {
        didSet { rebuild(); watchQueue(force: true) }
    }

    /// Set by the app.
    var onStop: (() -> Void)?
    var onHoldChanged: ((Bool) -> Void)?
    var onTargetChanged: ((String) -> Void)?
    var onPillChanged: ((Bool) -> Void)?

    override init() {
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        show(.idle)
        rebuild()
    }

    /// The agent's display name, or its id until /agents has answered.
    func name(of id: String) -> String {
        guard case .loaded(let agents) = roster else { return id }
        return agents.first { $0.id == id }?.label ?? id
    }

    /// Open the menu from the keyboard.
    func open() { item.button?.performClick(nil) }

    func refresh() {
        Task {
            let agents = await AgentClient.agents()
            roster = agents.map { .loaded($0) } ?? .down
            queue = await AgentClient.queueState()
            rebuild()
            showBadge()
            if reopenAfterRefresh { reopenAfterRefresh = false; open() }
        }
    }

    /// The icon follows the pill's state.
    func show(_ state: Panel.State) {
        let (symbol, label): (String, String) = switch state {
        case .idle: Hold.isOn ? ("bell.slash", "Notifications held") : ("waveform", "Idle")
        case .listening: ("mic.fill", "Listening")
        case .thinking, .working: ("ellipsis.circle", "Thinking")
        case .speaking, .saying: ("speaker.wave.2.fill", "Speaking")
        case .error: ("exclamationmark.triangle", "Error")
        }
        guard item.button?.toolTip != "AgentX Voice — \(label)" else { return }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "AgentX Voice: \(label)")
        image?.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = "AgentX Voice — \(label)"
    }

    /// The number of lines waiting to be spoken, beside the icon.
    private func showBadge() {
        let n = queue?.waiting.count ?? 0
        item.button?.imagePosition = .imageLeading
        item.button?.title = n > 0 ? "\(n)" : ""
    }

    /// Poll the queue only while there is something to show: a question in
    /// flight, or lines playing or waiting. `force` starts it whatever the
    /// last poll saw: an answer that just came back is about to be queued,
    /// so the poll carries on until it has been seen through.
    private func watchQueue(force: Bool = false) {
        let active = force || !thinking.isEmpty || queue?.playing != nil || !(queue?.waiting.isEmpty ?? true)
        if !active { queuePoll?.invalidate(); queuePoll = nil; return }
        guard queuePoll == nil else { return }
        queuePoll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.queue = await AgentClient.queueState()
                self.rebuild()
                self.showBadge()
                self.watchQueue()
            }
        }
    }

    /// "thinking", "speaking", "queued 2", or both, for one agent's row.
    private func state(of agent: AgentClient.AgentInfo) -> String {
        var parts: [String] = []
        // Speaking one answer and thinking on the next are both true at once.
        if queue?.playing?.agentId == agent.id { parts.append("speaking") }
        let asked = thinking[agent.id, default: 0]
        if asked > 0 {
            // More than one: the rest wait for the answer in flight.
            parts.append(asked > 1 ? "thinking (+\(asked - 1) asked)" : "thinking")
        }
        if parts.isEmpty && (agent.active ?? 0) > 0 { parts.append("working") }
        let queued = queue?.waiting.filter { $0.agentId == agent.id }.count ?? 0
        if queued > 0 { parts.append("queued \(queued)") }
        return parts.isEmpty ? "idle" : parts.joined(separator: " · ")
    }

    // MARK: NSMenuDelegate

    /// Show what is known now and refresh underneath; the open menu
    /// updates in place when the answer arrives.
    func menuWillOpen(_ menu: NSMenu) {
        rebuild()
        refresh()
    }

    // MARK: Building

    private func rebuild() {
        menu.removeAllItems()
        let target = Config.effectiveAgentID
        let pinned = Config.agentID != nil

        switch roster {
        case .loading:
            menu.addItem(disabled("Loading agents…"))
        case .down:
            menu.addItem(disabled("AgentX daemon isn't reachable"))
            menu.addItem(action("Retry", #selector(retry), key: "r", modifiers: []))
        case .loaded(let agents):
            menu.addItem(NSMenuItem.sectionHeader(title: pinned ? "Agent (set by AGENTX_VOICE_AGENT)" : "Talk to"))
            if agents.isEmpty { menu.addItem(disabled("No agents configured")) }
            for (i, agent) in agents.enumerated() {
                // Digits pick an agent while the menu is open.
                let row = action(agent.label + "  · " + state(of: agent), #selector(pick(_:)),
                                 key: i < 9 ? "\(i + 1)" : "", modifiers: [])
                row.representedObject = agent.id
                row.state = agent.id == target ? .on : .off
                row.isEnabled = !pinned
                menu.addItem(row)
            }
        }

        menu.addItem(.separator())
        menu.addItem(action("Stop speaking", #selector(stop), key: ".", modifiers: [.command, .option]))
        let hold = action("Hold notifications", #selector(toggleHold), key: "")
        hold.state = Hold.isOn ? .on : .off
        menu.addItem(hold)
        let pill = action("Show floating pill", #selector(togglePill), key: "")
        pill.state = Config.showPill ? .on : .off
        menu.addItem(pill)

        menu.addItem(.separator())
        menu.addItem(action("Settings…", #selector(openSettings), key: ","))
        menu.addItem(action("History…", #selector(openHistory), key: "y"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit AgentX Voice",
                                action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        row.isEnabled = false
        return row
    }

    private func action(_ title: String, _ selector: Selector, key: String,
                        modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        row.keyEquivalentModifierMask = modifiers
        row.target = self
        return row
    }

    // MARK: Actions

    @objc private func pick(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Config.chosenAgentID = id
        onTargetChanged?(id)
        rebuild()
    }

    @objc private func retry() {
        reopenAfterRefresh = true
        roster = .loading
        refresh()
    }

    @objc private func stop() { onStop?() }

    @objc private func toggleHold() {
        onHoldChanged?(Hold.toggle())
    }

    @objc private func togglePill() {
        Config.showPill.toggle()
        onPillChanged?(Config.showPill)
    }

    @objc private func openSettings() { openDashboard("/admin") }
    @objc private func openHistory() { openDashboard("/activity") }

    private func openDashboard(_ path: String) {
        guard let url = URL(string: Config.dashboardURL + path) else { return }
        NSWorkspace.shared.open(url)
    }
}
