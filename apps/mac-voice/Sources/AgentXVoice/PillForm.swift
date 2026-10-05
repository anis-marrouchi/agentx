/// The pill's two forms (#457): full, or reduced. Reduced, the pill is its
/// orb alone, a small circle with no words and no buttons; with the
/// character, it is the character alone, with no speech bubble.
///
/// Which form is chosen, which one shows, and when the full form goes back
/// by itself. The reduced form is a choice (the menu, or voice.startReduced)
/// that the full pill opens over for a while: a click opens it until a turn
/// has run; a call, an answer to read or a caption until that is over. Then
/// it goes back to the reduced form on its own. Free of AppKit, so the
/// tests can drive it.
struct PillForm: Equatable {
    /// The reduced form is the one chosen.
    private(set) var chosen = false
    /// The reduced form shows now.
    private(set) var reduced = false
    /// Open over the reduced form, something has happened since that sends
    /// it back once over: a turn, a call, an answer or a caption.
    private(set) var pending = false

    /// The menu or the setting: the reduced form, or the full one, from now on.
    mutating func choose(reduced on: Bool) {
        chosen = on
        reduced = on
        pending = false
    }

    /// The full form over the reduced one. A click opens it until a turn
    /// has run; a call, an answer or a caption until it is over. True when
    /// the form changed.
    @discardableResult
    mutating func open(clicked: Bool = false) -> Bool {
        guard reduced else { return false }
        reduced = false
        pending = !clicked
        return true
    }

    /// What is on screen now: `atRest` while idle (or holding
    /// notifications), `holds` while there is something to read or to use:
    /// an answer, the call buttons, a caption. True when the full form
    /// goes back to the reduced one: it is chosen, a turn has run or
    /// something was held since it opened, and that is over.
    @discardableResult
    mutating func rendered(atRest: Bool, holds: Bool) -> Bool {
        guard chosen, !reduced else { return false }
        if !atRest || holds {
            pending = true
            return false
        }
        guard pending else { return false }
        reduced = true
        pending = false
        return true
    }
}
