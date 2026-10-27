import CoreGraphics
import Foundation

/// Who is busy right now, for the row of mini orbs in the pill (#266).
///
/// Asking two agents back to back used to look like one: the pill has one
/// orb for one agent. While more than one agent is busy, a small orb per
/// agent sits in the pill beside the words, in its colour, with a cue for
/// what it is doing. The main orb keeps following whoever is listening or
/// speaking.
///
/// Kept free of AppKit and SwiftUI so the tests can check it without a
/// window.
enum PillBusy {
    /// What one agent is doing, most visible first.
    enum Activity: Equatable {
        /// Its answer is being spoken now.
        case speaking
        /// Its answer is back and waits in the speaking queue.
        case answering
        /// Its answer is back and waits to be heard: nothing plays until
        /// the owner picks it from the open-requests list (#1455).
        case ready
        /// It could not answer, and the owner has not seen why yet.
        case failed
        /// A question to it is in flight.
        case thinking
        /// Only questions waiting for it: nothing asked yet.
        case queued

        var word: String {
            switch self {
            case .speaking: return "speaking"
            case .answering: return "answer waiting to be spoken"
            case .ready: return "answer ready, not heard"
            case .failed: return "couldn’t answer"
            case .thinking: return "thinking"
            case .queued: return "queued"
            }
        }
    }

    struct Item: Equatable {
        let agentID: String
        let activity: Activity
        /// Questions waiting for it behind the one in flight.
        let queued: Int
    }

    /// What the app knows about each agent's work.
    struct Snapshot {
        /// Questions this widget has in flight, per agent.
        var inFlight: [String: Int] = [:]
        /// Questions waiting for an agent that already has one in flight.
        var waiting: [String: Int] = [:]
        /// The agent the daemon is speaking for now.
        var playing: String?
        /// Agents with answers waiting in the daemon's speaking queue.
        var toSpeak: [String] = []
        /// Agents with an answer waiting to be heard (OpenRequests).
        var ready: [String] = []
        /// Agents whose request failed, not seen yet.
        var failed: [String] = []
    }

    /// One item per busy agent. Agents already in `order` keep their
    /// place, so an orb never jumps when another's state changes; new
    /// ones join at the end.
    static func items(_ s: Snapshot, order: [String]) -> [Item] {
        var ids = Set(s.inFlight.filter { $0.value > 0 }.keys)
        ids.formUnion(s.waiting.filter { $0.value > 0 }.keys)
        if let p = s.playing, !p.isEmpty { ids.insert(p) }
        ids.formUnion(s.toSpeak.filter { !$0.isEmpty })
        ids.formUnion(s.ready.filter { !$0.isEmpty })
        ids.formUnion(s.failed.filter { !$0.isEmpty })

        let kept = order.filter(ids.contains)
        let fresh = ids.subtracting(kept).sorted()
        return (kept + fresh).map { id in
            let activity: Activity
            if s.playing == id { activity = .speaking }
            else if s.toSpeak.contains(id) { activity = .answering }
            // Something to hear or to see beats a request still thinking.
            else if s.ready.contains(id) { activity = .ready }
            else if s.failed.contains(id) { activity = .failed }
            else if s.inFlight[id, default: 0] > 0 { activity = .thinking }
            else { activity = .queued }
            // In flight beyond the first also waits (a turn plus an aside).
            let extra = max(0, s.inFlight[id, default: 0] - 1)
            return Item(agentID: id, activity: activity, queued: s.waiting[id, default: 0] + extra)
        }
    }

    /// The row shows when more than one agent is busy, when the one busy
    /// agent has an answer to hear or a failure to see, or when it still
    /// has a question out that the main orb is not showing: the pill
    /// listens for the next while it thinks. One line being spoken on its
    /// own is the main orb's, or a notification's.
    static func showsRow(_ items: [Item], mainAgent: String, mainActive: Bool) -> Bool {
        if items.count >= 2 { return true }
        if let only = items.first, only.activity == .ready || only.activity == .failed { return true }
        guard let only = items.first, only.activity == .thinking || only.activity == .queued else { return false }
        return !mainActive || only.agentID != mainAgent
    }

    // MARK: Layout

    /// A mini orb's diameter, the gap between two, and the most shown
    /// before a "+n" stands for the rest.
    static let diameter: CGFloat = 15
    static let gap: CGFloat = 6
    static let maxShown = 4
    /// Width of the "+n" after the last orb shown.
    static let overflowWidth: CGFloat = 18

    /// How many orbs are drawn for `count` busy agents, and how many more
    /// the "+n" stands for.
    static func shown(_ count: Int) -> (orbs: Int, more: Int) {
        count <= maxShown ? (count, 0) : (maxShown - 1, count - (maxShown - 1))
    }

    /// The row's width for `count` busy agents; 0 for none.
    static func rowWidth(_ count: Int) -> CGFloat {
        let (orbs, more) = shown(count)
        guard orbs > 0 else { return 0 }
        let base = CGFloat(orbs) * diameter + CGFloat(orbs - 1) * gap
        return more > 0 ? base + gap + overflowWidth : base
    }

    /// Left edge of each orb, from the row's left edge.
    static func orbOffsets(_ count: Int) -> [CGFloat] {
        (0..<shown(count).orbs).map { CGFloat($0) * (diameter + gap) }
    }

    /// The hover text: the agent's name, its node when it is not this
    /// Mac's, and what it is doing.
    static func tooltip(name: String, node: String?, item: Item) -> String {
        var s = name
        if let node, !node.isEmpty { s += " on \(node)" }
        s += " · \(item.activity.word)"
        if item.queued > 0 { s += ", \(item.queued) more queued" }
        return s
    }
}
