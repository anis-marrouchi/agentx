import Foundation

/// Waiting for the right moment to capture.
///
/// A single frame taken whenever the caller gets round to it misses
/// anything short-lived: a notification banner is gone within seconds, and
/// a page that is still loading is captured half-drawn. So a capture can
/// wait for its region to CHANGE (something appeared), to be STABLE
/// (whatever was moving has stopped), or both in that order.
///
/// Pure logic over an injected sampler and clock, so it is testable
/// without a screen. A sample is a small greyscale grid (see
/// `Vision.grid`); comparing grids ignores antialiasing and one-pixel
/// shifts.
enum Watch {

    struct Options {
        /// Mean absolute difference, 0…1, above which two samples differ.
        var threshold: Double = 0.015
        /// Time between samples.
        var interval: TimeInterval = 0.1
        /// Give up after this long; the caller still gets a frame.
        var timeout: TimeInterval = 5
        /// How long the region must stay unchanged to count as stable.
        var stableFor: TimeInterval = 0.4
    }

    struct Outcome: Equatable {
        /// The region changed from the baseline (only when asked to wait for it).
        var changed: Bool
        /// The region settled (only when asked to wait for it).
        var stable: Bool
        var timedOut: Bool
        var waited: TimeInterval
    }

    /// Mean absolute difference of two grids, 0…1; nil when they cannot be compared.
    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double? {
        guard a.count == b.count, !a.isEmpty else { return nil }
        var total = 0.0
        for i in 0..<a.count { total += abs(Double(a[i]) - Double(b[i])) / 255.0 }
        return total / Double(a.count)
    }

    /// Waits for a change from `baseline` (when given), then for stability
    /// (when `untilStable`). Returns as soon as the requested conditions
    /// hold, or at the timeout.
    static func wait(baseline: [UInt8]?, untilStable: Bool, options o: Options,
                     sample: () -> [UInt8]?, now: () -> TimeInterval,
                     sleep: (TimeInterval) -> Void) -> Outcome {
        let start = now()
        var outcome = Outcome(changed: false, stable: false, timedOut: false, waited: 0)
        func expired() -> Bool { now() - start >= o.timeout }
        func finish(timedOut: Bool) -> Outcome {
            outcome.timedOut = timedOut
            outcome.waited = now() - start
            return outcome
        }

        if let base = baseline {
            while true {
                if let s = sample(), let d = difference(base, s), d > o.threshold { break }
                if expired() { return finish(timedOut: true) }
                sleep(o.interval)
            }
            outcome.changed = true
        }
        guard untilStable else { return finish(timedOut: false) }

        var last = sample()
        var quietSince = now()
        while true {
            if expired() { return finish(timedOut: true) }
            sleep(o.interval)
            let s = sample()
            if let a = last, let b = s, let d = difference(a, b), d <= o.threshold {
                if now() - quietSince >= o.stableFor {
                    outcome.stable = true
                    return finish(timedOut: false)
                }
            } else {
                quietSince = now()
            }
            last = s
        }
    }
}
