import Foundation

/// The last few seconds of a region, in memory.
///
/// For a caller that arrives late: the banner it wanted to see has gone,
/// but a frame showing it is still here. Frames are kept only while they
/// are younger than `seconds` and never more than `capacity` of them, and
/// a frame identical to the one before is not kept at all — a still screen
/// costs one frame, not one per tick.
///
/// Nothing here touches the disk. Frames leave memory only when a caller
/// asks for them (the `buffer` verb's `dump` command).
struct Ring<Frame> {
    struct Entry {
        let at: TimeInterval
        let frame: Frame
        /// The comparison grid, so the next sample can be checked against it.
        let grid: [UInt8]
    }

    let seconds: TimeInterval
    let capacity: Int
    let threshold: Double
    private(set) var entries: [Entry] = []

    init(seconds: TimeInterval, capacity: Int, threshold: Double) {
        self.seconds = seconds
        self.capacity = max(1, capacity)
        self.threshold = threshold
    }

    /// Whether a sample with this grid would be kept: always when empty,
    /// otherwise only when it differs from the newest frame.
    func wants(_ grid: [UInt8]) -> Bool {
        guard let last = entries.last else { return true }
        guard let d = Watch.difference(last.grid, grid) else { return true }
        return d > threshold
    }

    mutating func add(_ frame: Frame, grid: [UInt8], at: TimeInterval) {
        entries.append(Entry(at: at, frame: frame, grid: grid))
        prune(now: at)
    }

    mutating func prune(now: TimeInterval) {
        // The newest frame stays even when old: on a still screen it IS
        // what has been showing for the whole window.
        while entries.count > 1, now - entries[0].at > seconds { entries.removeFirst() }
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
    }

    /// Frames from the last `within` seconds, oldest first, plus the frame
    /// that was already showing when that window opened.
    func recent(within: TimeInterval, now: TimeInterval) -> [Entry] {
        guard let first = entries.lastIndex(where: { now - $0.at > within }) else { return entries }
        return Array(entries[first...])
    }
}
