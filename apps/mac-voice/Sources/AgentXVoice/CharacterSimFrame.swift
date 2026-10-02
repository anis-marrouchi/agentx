import Foundation

/// What the character sim returns each frame (CharacterSim.swift).
extension CharacterSim {
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
