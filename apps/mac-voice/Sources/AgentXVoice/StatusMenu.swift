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
    private(set) var queue: AgentClient.QueueState?
    /// Agents on other mesh nodes this widget has asked or been told
    /// about by /voice/address: /agents lists only this node's.
    private var remote: [String: AgentClient.Addressed] = [:]
    /// Told when the thinking counts or the speaking queue change, so the
    /// pill's mini orbs follow.
    var onActivity: (() -> Void)?
    private var queuePoll: Timer?
    /// The last three voice exchanges, for a quick replay.
    private let recent = RecentExchanges()

    /// Questions this widget has in flight, per agent. Set by the app.
    var thinking: [String: Int] = [:] {
        didSet { rebuild(); watchQueue(force: true); onActivity?() }
    }

    /// Set by the app.
    var onStop: (() -> Void)?
    var onHoldChanged: ((Bool) -> Void)?
    var onTargetChanged: ((String) -> Void)?
    var onPillChanged: ((Bool) -> Void)?
    var onAnimatedOrbChanged: ((Bool) -> Void)?
    /// Hide the pill and stop speech, as its close button does.
    var onHidePill: (() -> Void)?
    /// Put the pill back in the bottom-right corner.
    var onResetPosition: (() -> Void)?
    /// Whether the pill is on screen, for "Hide pill" and "Show floating pill".
    var pillVisible: () -> Bool = { false }
    /// Whether the pill is reduced: to its orb, or to the character alone.
    var pillReduced: () -> Bool = { false }
    /// Reduce the pill (true), or open it again.
    var onReduce: ((Bool) -> Void)?
    /// The character look: whether the character is on screen. Nil with
    /// the orb look.
    var characterVisible: () -> Bool? = { nil }
    /// Bring a hidden character back, and let its bubble show again.
    var onShowCharacter: (() -> Void)?
    var onSettings: (() -> Void)?
    /// Play mode (#505): whether a play can start now, and start one.
    var playReady: () -> Bool = { false }
    var onPlay: (() -> Void)?

    override init() {
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        show(.idle)
        rebuild()
    }

    /// What /voice/address said about an agent. Only agents on other
    /// nodes are kept; this node's come from /agents.
    func learn(_ agent: AgentClient.Addressed) {
        guard agent.isRemote else { return }
        remote[agent.agentID] = agent
    }

    private func local(_ id: String) -> AgentClient.AgentInfo? {
        guard case .loaded(let agents) = roster else { return nil }
        return agents.first { $0.id == id }
    }

    /// The node an agent on another node lives on; nil for this node's.
    func node(of id: String) -> String? {
        local(id) == nil ? remote[id]?.node : nil
    }

    /// The agent's display name, or its id until /agents has answered.
    func name(of id: String) -> String {
        local(id)?.label ?? remote[id]?.name ?? id
    }

    /// The agent's colour for the orb: what the daemon sent, else the
    /// one derived from its id, which is the same colour.
    func color(of id: String) -> NSColor {
        let configured = local(id)?.color ?? remote[id]?.color
        let hex = OrbMath.colorHex(agentID: id, configured: configured)
        guard let c = OrbMath.parseHex(hex) else { return Brand.accent }
        return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
    }

    /// The agent's orb palette, five colours deep to light, or nil when
    /// the daemon sent none.
    func palette(of id: String) -> [NSColor]? {
        guard let hexes = local(id)?.palette?.colors ?? remote[id]?.palette?.colors, hexes.count == 5 else { return nil }
        let colors = hexes.compactMap(OrbMath.parseHex).map { NSColor(srgbRed: $0.r, green: $0.g, blue: $0.b, alpha: 1) }
        return colors.count == 5 ? colors : nil
    }

    /// Open the menu from the keyboard.
    func open() { item.button?.performClick(nil) }

    func refresh() {
        Task {
            let agents = await AgentClient.agents()
            roster = agents.map { .loaded($0) } ?? .down
            queue = await AgentClient.queueState()
            await recent.refresh()
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
        case .ringing: ("phone.arrow.down.left.fill", "Incoming call")
        case .onCall: ("phone.fill", "On a call")
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
                self.onActivity?()
                self.watchQueue()
            }
        }
    }

    /// "thinking", "speaking", "queued 2", or both, for one agent's row.
    private func state(of agent: AgentClient.AgentInfo) -> String {
        state(of: agent.id, active: agent.active ?? 0)
    }

    private func state(of id: String, active: Int) -> String {
        var parts: [String] = []
        // Speaking one answer and thinking on the next are both true at once.
        if queue?.playing?.agentId == id { parts.append("speaking") }
        let asked = thinking[id, default: 0]
        if asked > 0 {
            // More than one: the rest wait for the answer in flight.
            parts.append(asked > 1 ? "thinking (+\(asked - 1) asked)" : "thinking")
        }
        if parts.isEmpty && active > 0 { parts.append("working") }
        let queued = queue?.waiting.filter { $0.agentId == id }.count ?? 0
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
            // Agents on other nodes, while asked, answering or the target:
            // "Planner (server)  · thinking". /agents lists only this node's.
            let localIDs = Set(agents.map(\.id))
            var others = Set(thinking.keys)
            if let p = queue?.playing?.agentId { others.insert(p) }
            for item in queue?.waiting ?? [] { if let id = item.agentId { others.insert(id) } }
            if !target.isEmpty { others.insert(target) }
            for id in others.subtracting(localIDs).filter({ remote[$0] != nil || thinking[$0] != nil }).sorted() {
                let node = remote[id]?.node ?? "mesh"
                let row = action("\(name(of: id)) (\(node))  · " + state(of: id, active: 0), #selector(pick(_:)),
                                 key: "", modifiers: [])
                row.representedObject = id
                row.state = id == target ? .on : .off
                row.isEnabled = !pinned
                menu.addItem(row)
            }
        }
        recent.addItems(to: menu, name: name(of:))

        menu.addItem(.separator())
        menu.addItem(action("Stop speaking", #selector(stop), key: ".", modifiers: [.command, .option]))
        let hold = action("Hold notifications", #selector(toggleHold), key: "")
        hold.state = Hold.isOn ? .on : .off
        menu.addItem(hold)
        let pill = action("Show floating pill", #selector(togglePill), key: "")
        pill.state = PillMenu.isChecked(showPill: Config.showPill, visible: pillVisible()) ? .on : .off
        menu.addItem(pill)
        // The pill to its orb, or the character to itself without its bubble.
        menu.addItem(action(PillMenu.reduceTitle(reduced: pillReduced(), character: characterVisible() != nil),
                            #selector(toggleReduce), key: ""))
        let orb = action("Animated orb", #selector(toggleOrb), key: "")
        orb.state = Config.animatedOrb ? .on : .off
        menu.addItem(orb)
        let mode = action("Play mode", #selector(togglePlayMode), key: "")
        mode.state = Config.playMode ? .on : .off
        menu.addItem(mode)
        if Config.playMode {
            let play = action("Play on this page", #selector(startPlay), key: "")
            play.isEnabled = playReady()
            menu.addItem(play)
        }
        // The character hides with its bubble, and has no bubble at rest.
        switch characterVisible() {
        case true?: menu.addItem(action("Hide character", #selector(hidePill), key: ""))
        case false?: menu.addItem(action("Show character", #selector(showCharacter), key: ""))
        case nil:
            let hide = action("Hide pill", #selector(hidePill), key: "")
            hide.isEnabled = pillVisible()
            menu.addItem(hide)
        }
        menu.addItem(action("Reset position", #selector(resetPosition), key: ""))

        menu.addItem(.separator())
        menu.addItem(action("Settings…", #selector(openSettings), key: ","))
        menu.addItem(action("Dashboard…", #selector(openDashboardHome), key: "d"))
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
        Config.showPill = PillMenu.click(showPill: Config.showPill, visible: pillVisible())
        onPillChanged?(Config.showPill)
    }

    @objc private func toggleOrb() {
        Config.animatedOrb.toggle()
        onAnimatedOrbChanged?(Config.animatedOrb)
    }

    @objc private func toggleReduce() { onReduce?(!pillReduced()) }
    @objc private func togglePlayMode() { Config.playMode.toggle() }
    @objc private func startPlay() { onPlay?() }

    @objc private func hidePill() { onHidePill?() }
    @objc private func showCharacter() { onShowCharacter?() }
    @objc private func resetPosition() { onResetPosition?() }

    @objc private func openSettings() { onSettings?() }
    @objc private func openDashboardHome() { openDashboard("/admin") }
    @objc private func openHistory() { HistoryWindow.shared.show() }

    private func openDashboard(_ path: String) {
        guard let url = URL(string: Config.dashboardURL + path) else { return }
        NSWorkspace.shared.open(url)
    }
}
