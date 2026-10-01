import AppKit

/// An agent ringing the owner (#321): the daemon's /calls routes, the ring
/// sound, the poll, and the buttons on the pill. Decisions are in
/// CallModel.swift; main.swift wires them to the conversation.
enum CallClient {
    /// GET /calls/ringing, or nil when the daemon cannot be reached. The
    /// poll is also how the daemon knows the widget is running, and
    /// `query` (CallModel.pollQuery) whether it can ring.
    static func ringing(_ query: String = "") async -> RingingCalls? {
        guard let url = URL(string: "\(Config.daemonURL)/calls/ringing\(query)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(RingingCalls.self, from: data)
    }

    private struct Answered: Decodable { let opener: String }

    /// Pick up: the opener to send through /ask, or nil when the call is
    /// no longer ringing.
    static func answer(_ id: String) async -> String? {
        guard let data = await post(id, "answer", [:]) else { return nil }
        return (try? JSONDecoder().decode(Answered.self, from: data))?.opener
    }

    static func decline(_ id: String) async { _ = await post(id, "decline", [:]) }
    static func later(_ id: String, minutes: Int) async { _ = await post(id, "later", ["minutes": minutes]) }
    static func hangUp(_ id: String) async { _ = await post(id, "hangup", [:]) }

    /// The body on 200, else nil.
    private static func post(_ id: String, _ action: String, _ body: [String: Any]) async -> Data? {
        guard let url = URL(string: "\(Config.daemonURL)/calls/\(id)/\(action)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, response) = try? await URLSession.shared.data(for: req) else { return nil }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 { Log.warn("call \(action) \(id): HTTP \(status)") }
        return status == 200 ? data : nil
    }
}

/// Polls /calls/ringing every two seconds for the life of the app.
@MainActor
final class CallWatcher {
    private var timer: Timer?
    private var polling = false
    /// Each poll that reached the daemon.
    var onPoll: ((RingingCalls) -> Void)?
    /// What to tell the daemon with the next poll (CallModel.pollQuery).
    var query: (() -> String)?

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor [weak self] in await self?.poll() }
        }
        Task { await poll() }
    }

    private func poll() async {
        guard !polling else { return }
        polling = true
        defer { polling = false }
        if let state = await CallClient.ringing(query?() ?? "") { onPoll?(state) }
    }
}

/// The ring: a system sound, again every few seconds until stopped.
@MainActor
final class Ringer {
    private var timer: Timer?
    private var sound: NSSound?

    func start(sound name: String) {
        stop()
        // Names only, as the daemon checks them: never a path from the wire.
        guard name.range(of: #"^[\w -]+$"#, options: .regularExpression) != nil,
              let s = NSSound(contentsOfFile: "/System/Library/Sounds/\(name).aiff", byReference: true) else { return }
        sound = s
        s.play()
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { _ in
            Task { @MainActor [weak self] in
                guard let s = self?.sound, !s.isPlaying else { return }
                s.play()
            }
        }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        sound?.stop(); sound = nil
    }
}

/// The pill's call buttons: Answer, Later and Decline while it rings;
/// Hang up during the call.
final class CallBar: NSView {
    enum Mode { case hidden, ringing, connected }

    static func width(_ mode: Mode) -> CGFloat {
        switch mode {
        case .hidden: return 0
        case .ringing: return 3 * 24 + 2 * 4
        case .connected: return 24
        }
    }

    var onAnswer: (() -> Void)?
    var onDecline: (() -> Void)?
    var onLater: ((Int) -> Void)?
    var onHangUp: (() -> Void)?

    private let answer = CallBar.button("phone.fill", "Answer", .systemGreen)
    private let later = CallBar.button("clock.fill", "Call back later", .secondaryLabelColor)
    private let decline = CallBar.button("phone.down.fill", "Decline", .systemRed)
    private let hangUp = CallBar.button("phone.down.fill", "Hang up", .systemRed)
    private(set) var mode = Mode.hidden

    override init(frame: NSRect) {
        super.init(frame: frame)
        for b in [answer, later, decline, hangUp] { b.target = self; addSubview(b) }
        answer.action = #selector(answerClicked)
        later.action = #selector(laterClicked)
        decline.action = #selector(declineClicked)
        hangUp.action = #selector(hangUpClicked)
        show(.hidden)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    private static func button(_ symbol: String, _ label: String, _ tint: NSColor) -> NSButton {
        let b = NSButton(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.imagePosition = .imageOnly
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 15, weight: .semibold))
        b.contentTintColor = tint
        b.toolTip = label
        b.setAccessibilityLabel(label)
        return b
    }

    func show(_ mode: Mode) {
        self.mode = mode
        isHidden = mode == .hidden
        answer.isHidden = mode != .ringing
        later.isHidden = mode != .ringing
        decline.isHidden = mode != .ringing
        hangUp.isHidden = mode != .connected
        let shown = mode == .ringing ? [answer, later, decline] : mode == .connected ? [hangUp] : []
        for (i, b) in shown.enumerated() { b.frame.origin = NSPoint(x: CGFloat(i) * 28, y: 0) }
    }

    @objc private func answerClicked() { onAnswer?() }
    @objc private func declineClicked() { onDecline?() }
    @objc private func hangUpClicked() { onHangUp?() }

    @objc private func laterClicked() {
        let menu = NSMenu()
        for minutes in CallModel.laterChoices {
            let item = NSMenuItem(title: "Call back in \(minutes) min", action: #selector(laterChosen(_:)), keyEquivalent: "")
            item.target = self
            item.tag = minutes
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: later.frame.maxY), in: self)
    }

    @objc private func laterChosen(_ item: NSMenuItem) { onLater?(item.tag) }
}
