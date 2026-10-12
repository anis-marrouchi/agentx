import Foundation

/// The daemon's floor (#924): who may speak and show a bubble on this
/// Mac. A demo, a recording or a script takes it; until it lets go, an
/// answer waits to be shown and spoken, the microphone does not open by
/// itself, and for a recording the character and the pill stay out.
/// See src/voice/floor.ts; FloorWatcher.swift follows it.
struct FloorState: Decodable, Equatable {
    var seq = 0
    var held = false
    /// Who holds it, as the owner reads it.
    var holder: String?
    /// The holder plays sound of its own.
    var sound = false
    /// A recording: nothing of the assistant shows.
    var hide = false
    /// Milliseconds since 1970, as the daemon sends them.
    var expiresAt: Double?

    static let free = FloorState()

    /// As it is at `now` (seconds since 1970): a hold past its time is
    /// over, whether or not the daemon was there to say so.
    func at(_ now: TimeInterval) -> FloorState {
        guard held, let expiresAt, now * 1000 >= expiresAt else { return self }
        return FloorState(seq: seq)
    }

    /// An answer waits: shown and spoken once the floor is free.
    var holdsAnswers: Bool { held }
    /// The microphone must not open by itself, and a window it opened is
    /// thrown away: it would hear the holder and take it for the owner.
    var closesOpenMicrophone: Bool { held && sound }
    /// The character, the pill and every bubble stay off the screen.
    var hidesEverything: Bool { held && hide }

    /// The menu's row while it is held: who, and for how long at most.
    func menuTitle(now: TimeInterval) -> String? {
        guard held else { return nil }
        let who = holder ?? "Someone"
        guard let expiresAt else { return "\(who) holds the floor" }
        let left = max(0, Int((expiresAt / 1000 - now).rounded(.up)))
        let time = left >= 90 ? "\(Int((Double(left) / 60).rounded())) min" : "\(left) s"
        return "\(who) holds the floor (up to \(time))"
    }
}
