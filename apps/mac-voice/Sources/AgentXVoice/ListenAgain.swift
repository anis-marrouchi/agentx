import Foundation

/// The answer's Listen again button (#492): what it shows, and what a
/// click does. A click speaks the answer in the pill again, from its
/// start, in its agent's voice; a click while it plays stops it.
enum ListenAgain {
    enum Click: Equatable {
        /// Queue the answer again on the daemon's speaking queue.
        case speak
        /// Stop it, the same stop as the stop shortcut.
        case stop
        /// No answer to say: nothing happens.
        case nothing
    }

    static func click(replaying: Bool, text: String?) -> Click {
        if replaying { return .stop }
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .nothing }
        return .speak
    }

    /// The SF Symbol and the label (tooltip and screen reader) for a state.
    static func look(replaying: Bool) -> (symbol: String, label: String) {
        replaying ? ("stop.fill", "Stop listening") : ("speaker.wave.2", "Listen again")
    }
}
