import Foundation

/// What the character sim is given and returns each frame (CharacterSim.swift).
extension CharacterSim {
    struct Input {
        var activity = M.Activity.idle
        /// 0…1: the microphone while listening.
        var level = 0.0
        /// The pointer: along the edge, and its height above it. Nil when
        /// it is on another screen.
        var pointer: (x: Double, y: Double)?
        /// The pointer is on its speech bubble: it stays where it is, so
        /// the bubble is not pulled from under the pointer.
        var held = false
        /// The answering agent sent it to show something (#482): it goes
        /// to `home` at once, awake, whatever the pointer did before.
        var sent = false
        /// The state it was asked to show by name (#570), in place of
        /// what the assistant is doing.
        var asked: M.Mood?
        /// `voice.stroll`: with nothing to do, it takes a slow stroll
        /// beside where it rests now and then (#482).
        var strolls = false
        /// What stands on its line, along the edge: the sides of the
        /// windows there (#539). On a stroll it stops short of the first.
        var edges: [Double] = []
        /// Its bubble holds something to use (an answer, an error, the
        /// call buttons): no game, so the bubble waits for the hand.
        var shows = false
        /// "Play mode" is ticked: idle, it plays with the pointer (#505).
        var plays = false
        /// The mouse button is down.
        var down = false
        /// Where it rests, and how far it may go.
        var home = 0.0
        var range: ClosedRange<Double> = 0...0
    }

    /// A trail dot or a star, where and how it is drawn this frame.
    struct Mark: Equatable {
        /// Along the edge and above it, in points.
        var x, y: Double
        /// Radius in drawing units, opacity, turn in degrees, and which
        /// palette stop colours it.
        var r, alpha, turn: Double
        var shade: Int
    }

    struct Frame {
        var pose = M.Pose()
        var x = 0.0
        /// -1 turned left, 0 facing you, 1 turned right.
        var face = 0.0
        var level = 0.0
        /// 0…1: the rise and fall of its own voice while speaking.
        var voice = 0.0
        /// Seconds since it appeared, for the marks' own loops.
        var t = 0.0
        var dots: [Mark] = []
        var stars: [Mark] = []
    }
}
