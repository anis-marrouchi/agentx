import Foundation

/// An agent ringing the owner (#321): the daemon's call, and the decisions
/// the widget makes about it. Foundation only, so Tests/Calls runs it
/// without AppKit. The network and the pill are in Calls.swift.
struct IncomingCall: Decodable, Equatable {
    let id: String
    let agentId: String
    let reason: String
    let urgency: String
}

/// GET /calls/ringing.
struct RingingCalls: Decodable {
    let calls: [IncomingCall]
    let ringSound: String
    let ringSeconds: Int
}

enum CallModel {
    enum Action: Equatable {
        case none
        /// Start ringing this call.
        case ring(IncomingCall)
        /// The call ringing here stopped ringing on the daemon: missed,
        /// declined or answered somewhere else.
        case stop
    }

    /// What to do after a poll. `ringing` is the call ringing here, if
    /// any. A new call rings only when the widget is free (`canRing`: no
    /// call in progress, no turn, microphone closed); until then it stays
    /// on the daemon and is offered again on the next poll.
    static func action(ringing: String?, calls: [IncomingCall], canRing: Bool) -> Action {
        if let ringing {
            return calls.contains { $0.id == ringing } ? .none : .stop
        }
        guard canRing, let first = calls.first else { return .none }
        return .ring(first)
    }

    /// What each poll tells the daemon (#408): `busy` when a new call
    /// cannot ring here, `showing` with the call that is ringing. The
    /// daemon keeps a call waiting while the widget is busy, so its ring
    /// time runs only once it can ring.
    static func pollQuery(ringing: String?, canRing: Bool) -> String {
        var items: [String] = []
        if ringing != nil || !canRing { items.append("busy=1") }
        if let ringing { items.append("showing=\(ringing)") }
        return items.isEmpty ? "" : "?" + items.joined(separator: "&")
    }

    /// "Call back in…" choices, in minutes.
    static let laterChoices = [5, 15, 30]

    /// Said during a call to end it.
    static func isHangUp(_ text: String) -> Bool {
        text.range(of: #"^\s*(hang up|end (the )?call|good ?bye|bye( bye)?|talk (to you )?later)[\s.!]*$"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The pill's words while it rings.
    static func ringingText(name: String, reason: String) -> String {
        name.isEmpty ? "Incoming call · \(reason)" : "\(name) is calling · \(reason)"
    }
}
