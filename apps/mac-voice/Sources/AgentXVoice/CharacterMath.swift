import Foundation

/// The numbers behind the character (#458): the orb grown into a small
/// creature. Kept free of AppKit so the tests can check them without a
/// window.
///
/// Nothing snaps. A state is a small set of numbers (stretch, lean,
/// height, gaze, eyes, and how strong each mark is), so going from any
/// state to any other is a blend of those numbers. Lengths are in the
/// drawing's own units: the body is 100 across.
enum CharacterMath {
    /// What the character shows: the nine states of the pose sheet.
    enum Mood: String, CaseIterable {
        case idle, notices, listening, working, speaking, understood, dozing, calling, asking
    }

    /// What the assistant is doing: the pill's states without their words.
    enum Activity { case idle, listening, thinking, speaking, ringing, waiting }

    /// The state shown for what the assistant is doing. Noticing, the nod
    /// and dozing are not activities: the character passes through them
    /// (`passing`) or settles into them with time.
    static func mood(for activity: Activity) -> Mood {
        switch activity {
        case .idle: return .idle
        case .listening: return .listening
        case .thinking: return .working
        case .speaking: return .speaking
        case .ringing: return .calling
        case .waiting: return .asking
        }
    }

    /// The state it goes through on the way from `from` to `to`, if any:
    /// it notices you before it listens and when it wakes, and nods once
    /// it has heard you.
    static func passing(from: Mood, to: Mood) -> Mood? {
        if from == .dozing { return .notices }
        if from == .idle && to == .listening { return .notices }
        if from == .listening && to == .working { return .understood }
        return nil
    }

    /// Seconds a passing state is held before moving on.
    static func hold(_ mood: Mood) -> Double { mood == .understood ? 0.9 : 0.45 }

    /// Seconds to get into a state. It settles into sleep slowly.
    static func duration(into mood: Mood) -> Double {
        switch mood {
        case .dozing: return 1.8
        case .notices, .understood: return 0.3
        default: return 0.5
        }
    }

    struct Pose: Equatable {
        // Body: stretch, lean in degrees, height above the edge.
        var sx = 1.0, sy = 1.0, tilt = 0.0, lift = 14.0
        // Eyes: gaze, how open (1 open, 0 shut), size, eyelid, and the
        // curve of the shut eye (1 a smile, -1 asleep).
        var gx = 0.0, gy = 0.0, open = 1.0, size = 1.0, lid = 0.0, curve = 0.0
        // Marks, 0…1: voice rings, thinking dots, speech arcs, sleep
        // letters, call rings, the question.
        var hear = 0.0, think = 0.0, speak = 0.0, sleep = 0.0, ring = 0.0, ask = 0.0
    }

    static func pose(_ mood: Mood) -> Pose {
        switch mood {
        case .idle: return Pose()
        case .notices: return Pose(sx: 0.94, sy: 1.08, lift: 18, gy: -3, size: 1.22)
        case .listening: return Pose(tilt: -9, gx: -2, gy: -1, hear: 1)
        case .working: return Pose(sx: 1.03, sy: 0.96, gx: -4, gy: 5, lid: 0.5, think: 1)
        case .speaking: return Pose(sx: 0.97, sy: 1.04, lift: 16, gy: -1, speak: 1)
        case .understood: return Pose(sx: 1.07, sy: 0.9, lift: 8, open: 0, curve: 1)
        case .dozing: return Pose(sx: 1.14, sy: 0.8, lift: 3, open: 0, curve: -1, sleep: 1)
        case .calling: return Pose(sx: 0.95, sy: 1.06, lift: 20, size: 1.22, ring: 1)
        case .asking: return Pose(tilt: 11, gx: 3, gy: -3, ask: 1)
        }
    }

    /// `a` towards `b`: the eyes, the body and the marks each by their own
    /// amount, so the eyes can lead and the body follow.
    static func blend(_ a: Pose, _ b: Pose, eyes: Double, body: Double, marks: Double) -> Pose {
        func mix(_ x: Double, _ y: Double, _ p: Double) -> Double { x + (y - x) * p }
        return Pose(sx: mix(a.sx, b.sx, body), sy: mix(a.sy, b.sy, body),
                    tilt: mix(a.tilt, b.tilt, body), lift: mix(a.lift, b.lift, body),
                    gx: mix(a.gx, b.gx, eyes), gy: mix(a.gy, b.gy, eyes),
                    open: mix(a.open, b.open, eyes), size: mix(a.size, b.size, eyes),
                    lid: mix(a.lid, b.lid, eyes), curve: mix(a.curve, b.curve, eyes),
                    hear: mix(a.hear, b.hear, marks), think: mix(a.think, b.think, marks),
                    speak: mix(a.speak, b.speak, marks), sleep: mix(a.sleep, b.sleep, marks),
                    ring: mix(a.ring, b.ring, marks), ask: mix(a.ask, b.ask, marks))
    }

    /// One change of state. The eyes go first and are there by half time;
    /// the body follows a moment later, with weight.
    struct Transition {
        var from: Pose
        var to: Pose
        var start: Double
        var duration: Double

        func pose(at t: Double) -> Pose {
            blend(from, to,
                  eyes: ease(span(t, start, start + duration * 0.5)),
                  body: swing(span(t, start + duration * 0.15, start + duration * 1.25)),
                  marks: ease(span(t, start, start + duration)))
        }
    }

    /// Slow start, slow stop.
    static func ease(_ p: Double) -> Double {
        let p = min(max(p, 0), 1)
        return p * p * (3 - 2 * p)
    }

    /// How far `t` is between `a` and `b`, 0…1.
    static func span(_ t: Double, _ a: Double, _ b: Double) -> Double {
        min(max((t - a) / (b - a), 0), 1)
    }

    /// Like `ease`, with weight: a small wind-up before it goes and a
    /// small overshoot before it settles.
    static func swing(_ p: Double, back: Double = 1) -> Double {
        let p = min(max(p, 0), 1), c = back * 1.525
        if p < 0.5 { return pow(2 * p, 2) * ((c + 1) * 2 * p - c) / 2 }
        return (pow(2 * p - 2, 2) * ((c + 1) * (2 * p - 2) + c) + 2) / 2
    }

    /// The same "random" number 0…1 for the same `n`, so the marks are
    /// the same on every run and the tests can count on them.
    static func rnd(_ n: Int, _ salt: Int = 0) -> Double {
        let v = sin(Double(n) * 12.9898 + Double(salt) * 78.233) * 43758.5453
        return v - v.rounded(.down)
    }

    /// Where it goes to get out of the pointer's way: `clear` to the side
    /// it is already on, or to the other side when the screen ends there.
    static func aside(x: Double, pointer: Double, clear: Double, range: ClosedRange<Double>) -> Double {
        let side: Double = x >= pointer ? 1 : -1
        let there = pointer + side * clear
        if range.contains(there) { return there }
        return min(max(pointer - side * clear, range.lowerBound), range.upperBound)
    }
}
