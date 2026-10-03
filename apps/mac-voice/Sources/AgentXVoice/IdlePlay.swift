import Foundation

/// Small animations by itself (#571): idle and left alone, the character
/// now and then looks around, hops or sways, just for the fun of it, and
/// stretches with a yawn before it dozes. `voice.animations` says how
/// often, or not at all.
///
/// It only decides what an animation adds to the pose; `CharacterSim`
/// follows it, so one cut short by work does not snap. Foundation only,
/// and the same animations in the same order on every run, so the tests
/// can count on them.
struct IdlePlay {
    typealias M = CharacterMath

    /// The animations, by name. The yawn comes before it dozes; the
    /// others are picked now and then.
    enum Act: String, CaseIterable { case look, hop, sway, yawn }

    /// `voice.animations` as the shortest wait between two, in seconds.
    /// The wait is up to twice that. 0: none.
    static func gap(_ often: String?) -> Double {
        switch often {
        case "rarely": return 60
        case "sometimes": return 25
        case "often": return 10
        default: return 0
        }
    }

    /// Seconds an animation takes.
    static func length(_ act: Act) -> Double {
        switch act {
        case .look, .yawn: return 2.6
        case .hop: return 0.9
        case .sway: return 1.8
        }
    }

    /// This close to dozing, in seconds, no animation starts but the yawn.
    static let calm = 6.0

    /// What an animation adds to the pose: gaze and height in drawing
    /// units, lean in degrees, 0…1 crouched (below 0: stretched tall) and
    /// 0…1 how far the eyes are shut.
    struct Out: Equatable {
        var gx = 0.0, gy = 0.0, tilt = 0.0, hop = 0.0, crouch = 0.0, shut = 0.0
    }

    private(set) var act: Act?
    private(set) var played = 0
    private var began = 0.0
    private var next: Double?
    private var yawned = false
    private var turn = 0
    private var shut = 0.0

    /// One frame. `free`: idle, left alone and standing where it is.
    /// `dozeIn`: seconds until it dozes.
    mutating func step(_ now: Double, _ dt: Double, free: Bool, gap: Double, dozeIn: Double) -> Out {
        var out = Out()
        if !free || gap <= 0 {
            act = nil; next = nil
        } else {
            if dozeIn > Self.calm { yawned = false }
            if let on = act, now - began >= Self.length(on) { act = nil; next = nil }
            if act == nil {
                if !yawned && dozeIn <= Self.length(.yawn) {
                    yawned = true
                    start(.yawn, now)
                } else if next == nil {
                    next = now + gap * (1 + M.rnd(played, 5))
                } else if now >= next!, dozeIn > Self.calm {
                    // One of the other two, so the same never comes twice.
                    turn = (turn + 1 + min(Int(M.rnd(played, 6) * 2), 1)) % 3
                    start([Act.look, .hop, .sway][turn], now)
                }
            }
            if let on = act { out = Self.shape(on, (now - began) / Self.length(on)) }
        }
        // The eyes are followed here; the rest by the sim.
        shut += (out.shut - shut) * (1 - exp(-dt * 20))
        out.shut = shut
        return out
    }

    /// Play `act` now, whatever the wait.
    mutating func start(_ act: Act, _ now: Double) {
        self.act = act
        began = now
        played += 1
    }

    /// An animation `p` of the way through, 0…1. Each starts and ends at
    /// nothing, so it joins the resting pose at both ends.
    static func shape(_ act: Act, _ p: Double) -> Out {
        switch act {
        case .look:
            // To one side, to the other, and back.
            return Out(gx: 8 * sin(2 * .pi * p), gy: -1.5 * sin(.pi * p))
        case .hop:
            // A short crouch, then up and down again.
            return Out(hop: 26 * sin(.pi * M.span(p, 0.3, 1)),
                       crouch: 0.7 * M.ease(p / 0.3) * (1 - M.ease(M.span(p, 0.3, 0.5))))
        case .sway:
            // Two swings from side to side, the widest in the middle.
            return Out(tilt: 10 * sin(4 * .pi * p) * sin(.pi * p))
        case .yawn:
            // It stretches tall, looks up, and shuts its eyes a moment.
            return Out(gy: -2 * sin(.pi * p), crouch: -0.8 * sin(.pi * M.span(p, 0, 0.8)),
                       shut: M.ease(M.span(p, 0.15, 0.4)) * (1 - M.ease(M.span(p, 0.75, 1))))
        }
    }
}
