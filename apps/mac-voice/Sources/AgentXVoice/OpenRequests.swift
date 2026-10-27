import Foundation

/// The open-requests list (#1455): every question the widget has sent, from
/// the moment it goes until it has been heard.
///
/// Sending no longer holds the pill. A request runs on its own, its answer
/// waits as "not heard", and the owner picks it from the list to hear it.
/// One /ask per agent at a time stays the rule: a second request for an
/// agent that is still thinking waits behind the first and goes when it
/// answers.
///
/// Kept free of AppKit and SwiftUI so the tests can check it without a
/// window. The answers themselves live with the app; this holds what the
/// list and the pill show.
struct OpenRequests {
    /// Where a request is.
    enum Phase: Equatable {
        /// Behind another request for the same agent.
        case waiting
        /// Asked; the agent is working on it.
        case thinking
        /// The answer is back.
        case answered
        /// The agent could not answer, and why, in words.
        case failed(String)
    }

    struct Request: Equatable, Identifiable {
        let id: Int
        let agentID: String
        /// The words as heard.
        let question: String
        let sentAt: Date
        var phase: Phase
        /// When it started thinking, or when its answer came back.
        var since: Date
        /// Played or opened: its answer, or why it failed, has been seen.
        var heard = false

        /// An answer or a failure the owner has not seen yet.
        var isNew: Bool {
            switch phase {
            case .answered, .failed: return !heard
            case .waiting, .thinking: return false
            }
        }

        /// Still with the agent.
        var isOpen: Bool { phase == .waiting || phase == .thinking }
    }

    /// Oldest first, which is the order they were sent in.
    private(set) var requests: [Request] = []
    private var nextID = 1

    /// Heard requests kept in the list. Closing a row by hand comes with
    /// its own slice; until then the oldest heard ones leave by themselves.
    static let keptHeard = 8

    func request(_ id: Int) -> Request? { requests.first { $0.id == id } }

    /// Add a request. It thinks at once, or waits when its agent already has
    /// one out. Returns its id.
    @discardableResult
    mutating func add(agentID: String, question: String, at now: Date) -> Int {
        let busy = requests.contains { $0.agentID == agentID && $0.isOpen }
        let id = nextID
        nextID += 1
        requests.append(Request(id: id, agentID: agentID, question: question, sentAt: now,
                                phase: busy ? .waiting : .thinking, since: now))
        return id
    }

    /// The answer came back.
    mutating func answered(_ id: Int, at now: Date) {
        update(id) { $0.phase = .answered; $0.since = now }
    }

    /// The agent could not answer.
    mutating func failed(_ id: Int, reason: String, at now: Date) {
        update(id) { $0.phase = .failed(reason); $0.since = now }
    }

    /// The oldest request waiting for `agentID`, now thinking, if there is
    /// one and nothing else for that agent is.
    mutating func startNext(for agentID: String, at now: Date) -> Int? {
        guard !requests.contains(where: { $0.agentID == agentID && $0.phase == .thinking }),
              let i = requests.firstIndex(where: { $0.agentID == agentID && $0.phase == .waiting }) else { return nil }
        requests[i].phase = .thinking
        requests[i].since = now
        return requests[i].id
    }

    /// Played, or opened. The oldest heard requests beyond `keptHeard` leave.
    mutating func heard(_ id: Int) {
        update(id) { $0.heard = true }
        let heard = requests.filter { $0.heard && !$0.isOpen }
        if heard.count > Self.keptHeard {
            let gone = Set(heard.prefix(heard.count - Self.keptHeard).map(\.id))
            requests.removeAll { gone.contains($0.id) }
        }
    }

    /// Gone without a trace: the daemon took the words for something else.
    mutating func remove(_ id: Int) {
        requests.removeAll { $0.id == id }
    }

    private mutating func update(_ id: Int, _ change: (inout Request) -> Void) {
        guard let i = requests.firstIndex(where: { $0.id == id }) else { return }
        change(&requests[i])
    }

    // MARK: For the pill

    /// Answers and failures not seen yet: the "1 new" on the pill.
    var newCount: Int { requests.filter(\.isNew).count }

    /// Agents with an answer waiting to be heard.
    var readyAgents: [String] { agents { $0.phase == .answered && !$0.heard } }

    /// Agents whose request failed, not seen yet.
    var failedAgents: [String] {
        agents {
            if case .failed = $0.phase { return !$0.heard }
            return false
        }
    }

    /// Requests waiting behind another, per agent.
    var waiting: [String: Int] {
        requests.filter { $0.phase == .waiting }.reduce(into: [:]) { $0[$1.agentID, default: 0] += 1 }
    }

    private func agents(_ test: (Request) -> Bool) -> [String] {
        var seen = Set<String>()
        return requests.filter(test).map(\.agentID).filter { seen.insert($0).inserted }
    }

    /// The rows in the order drawn: by when each was sent, the newest next
    /// to the pill. Rows never move when a state changes.
    func rows(newestLast: Bool) -> [Request] {
        newestLast ? requests : requests.reversed()
    }

    // MARK: Words

    /// The first words of a request, for its row: one line, capitalised,
    /// cut at a word with "…" when longer than `max` characters.
    static func firstWords(_ text: String, max: Int = 48) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        var words = flat.prefix(1).uppercased() + flat.dropFirst()
        guard words.count > max else { return words }
        let cut = words.prefix(max)
        let end = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        words = String(end).trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:")) + "…"
        return words
    }

    /// "0:20", "1:12", "12:05".
    static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// How long ago, for the row's corner: "now", "2 min", "3 h".
    static func ago(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60) min" }
        return "\(s / 3600) h"
    }

    /// The row's state, after the agent's name.
    static func stateWords(_ r: Request, now: Date) -> String {
        switch r.phase {
        case .waiting: return "Waiting its turn"
        case .thinking: return "Thinking, " + clock(Int(now.timeIntervalSince(r.since)))
        case .answered: return r.heard ? "Heard" : "Answer ready"
        case .failed: return "Couldn’t answer"
        }
    }

    /// What VoiceOver reads for a row. The actions (Listen, Show) are the
    /// row's own and are read after it.
    static func voiceOver(name: String, _ r: Request, now: Date) -> String {
        let state: String
        switch r.phase {
        case .waiting: state = "Waiting its turn"
        case .thinking:
            let s = Int(now.timeIntervalSince(r.since))
            state = s < 60 ? "Thinking" : "Thinking, \(s / 60) minute\(s / 60 == 1 ? "" : "s")"
        case .answered: state = r.heard ? "Heard" : "Answer ready, not heard"
        case .failed: state = r.heard ? "Couldn’t answer" : "Couldn’t answer, not seen"
        }
        let asked = flatLower(r.question)
        let s = Int(now.timeIntervalSince(r.sentAt))
        let when = s < 60 ? "Just now" : s < 3600 ? "\(s / 60) minute\(s / 60 == 1 ? "" : "s") ago" : "\(s / 3600) hour\(s / 3600 == 1 ? "" : "s") ago"
        return "\(name). \(state). You asked: \(asked). \(when)."
    }

    private static func flatLower(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let trimmed = flat.trimmingCharacters(in: CharacterSet(charactersIn: " .?!"))
        return trimmed.prefix(1).lowercased() + trimmed.dropFirst()
    }

    /// "1 new", "3 new".
    static func newBadge(_ count: Int) -> String { "\(count) new" }

    /// The pill's line just after a request goes.
    static let sentNote = "Sent. Ask the next one"

    /// The pill's line when an answer comes back and waits.
    static func readyNote(name: String) -> String { "\(name) answered · hover or ⌘⌥O to hear it" }

    /// The pill's line when a request fails.
    static func failedNote(name: String) -> String { "\(name) couldn’t answer · ⌘⌥O to see why" }

    /// How long those lines stay before the pill goes back to its own.
    static let noteSeconds: TimeInterval = 4

    // MARK: Picking a row

    enum Pick: Equatable {
        /// Play the answer and show its text: it is heard from now on.
        case listen
        /// Show the text again; Listen again plays it.
        case show
        /// Say why it failed.
        case reason(String)
        /// Still with the agent: nothing to hear yet.
        case nothing
    }

    static func pick(_ r: Request) -> Pick {
        switch r.phase {
        case .waiting, .thinking: return .nothing
        case .answered: return r.heard ? .show : .listen
        case .failed(let why): return .reason(why)
        }
    }

    /// The row selected after ↑ (`delta` -1) or ↓ (+1), from `selected`,
    /// in `ids` as drawn top to bottom. Nothing selected: ↓ takes the top
    /// row and ↑ the bottom one. It stops at either end.
    static func move(_ selected: Int?, by delta: Int, in ids: [Int]) -> Int? {
        guard !ids.isEmpty else { return nil }
        guard let selected, let i = ids.firstIndex(of: selected) else {
            return delta < 0 ? ids.last : ids.first
        }
        return ids[min(max(i + delta, 0), ids.count - 1)]
    }

    /// The row selected when the list opens from the keyboard: the oldest
    /// answer not heard yet, else the newest, next to the pill.
    var firstSelection: Int? {
        requests.first(where: \.isNew)?.id ?? requests.last?.id
    }
}
