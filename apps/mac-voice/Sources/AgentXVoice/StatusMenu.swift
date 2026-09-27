import AppKit

/// The menu-bar icon: what the assistant is doing, and who it talks to.
///
/// One menu serves the icon and the pill's right-click, so there is one
/// place that says which agent answers and one way to change it.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    let menu = NSMenu()
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

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
            rebuild()
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
                let busy = (agent.active ?? 0) > 0
                // Digits pick an agent while the menu is open.
                let row = action(agent.label + (busy ? "  · working" : "  · idle"), #selector(pick(_:)),
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
