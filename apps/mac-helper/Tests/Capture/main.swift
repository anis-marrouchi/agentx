import Foundation

// Wait-for-change, wait-for-stable and the in-memory ring, on a fake clock:
// no screen, no sleeping.

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok { failures += 1; print("FAIL line \(line): \(what)") }
}

/// A region whose sample is `frames[t]` for the current fake time.
final class Scene {
    var t: TimeInterval = 0
    let frame: (TimeInterval) -> [UInt8]
    init(_ frame: @escaping (TimeInterval) -> [UInt8]) { self.frame = frame }
    func wait(baseline: [UInt8]?, stable: Bool, _ o: Watch.Options = Watch.Options()) -> Watch.Outcome {
        Watch.wait(baseline: baseline, untilStable: stable, options: o,
                   sample: { self.frame(self.t) }, now: { self.t }, sleep: { self.t += $0 })
    }
}

let dark = [UInt8](repeating: 0, count: 256)
let light = [UInt8](repeating: 255, count: 256)
let grey = [UInt8](repeating: 128, count: 256)

// Change: a banner appears at 0.3 s.
do {
    let s = Scene { $0 >= 0.3 ? light : dark }
    let r = s.wait(baseline: dark, stable: false)
    check(r.changed && !r.timedOut, "sees the change")
    check(r.waited >= 0.3 && r.waited < 0.45, "returns at the first changed sample, waited \(r.waited)")
}

// Change that never comes: times out, reports it.
do {
    let s = Scene { _ in dark }
    var o = Watch.Options(); o.timeout = 1
    let r = s.wait(baseline: dark, stable: false, o)
    check(!r.changed && r.timedOut, "times out without a change")
    check(r.waited >= 1 && r.waited < 1.2, "stops at the timeout, waited \(r.waited)")
}

// A tiny difference (antialiasing) is not a change.
do {
    var near = dark; near[0] = 200
    let s = Scene { _ in near }
    var o = Watch.Options(); o.timeout = 0.5
    check(s.wait(baseline: dark, stable: false, o).timedOut, "ignores a sub-threshold difference")
}

// Stable: an animation runs until 1.0 s, then holds.
do {
    let s = Scene { t in t < 1.0 ? (Int(t * 10) % 2 == 0 ? dark : light) : grey }
    let r = s.wait(baseline: nil, stable: true)
    check(r.stable && !r.timedOut, "settles")
    check(r.waited >= 1.4 && r.waited < 1.7, "waits for stableFor after the last movement, waited \(r.waited)")
}

// Stable never reached: keeps flickering.
do {
    let s = Scene { t in Int(t * 10) % 2 == 0 ? dark : light }
    var o = Watch.Options(); o.timeout = 2
    let r = s.wait(baseline: nil, stable: true, o)
    check(!r.stable && r.timedOut, "times out while still moving")
}

// Change, then stable: a banner slides in over 0.3 s and holds.
do {
    let s = Scene { t in t < 0.2 ? dark : t < 0.5 ? (Int(t * 10) % 2 == 0 ? grey : light) : light }
    let r = s.wait(baseline: dark, stable: true)
    check(r.changed && r.stable, "change then settle")
    check(r.waited >= 0.9, "captures after the slide-in, not during it, waited \(r.waited)")
}

// Ring: keeps only changes, drops old frames but never the newest.
do {
    var ring = Ring<String>(seconds: 2, capacity: 10, threshold: 0.015)
    check(ring.wants(dark), "wants the first frame")
    ring.add("a", grid: dark, at: 0)
    check(!ring.wants(dark), "skips an unchanged frame")
    check(ring.wants(light), "wants a changed frame")
    ring.add("b", grid: light, at: 1)
    ring.add("c", grid: dark, at: 3.5)
    check(ring.entries.map(\.frame) == ["c"], "drops frames older than the window: \(ring.entries.map(\.frame))")
    ring.prune(now: 60)
    check(ring.entries.map(\.frame) == ["c"], "keeps the newest frame on a still screen")
}

// Ring: capacity, and recent() includes the frame already showing.
do {
    var ring = Ring<Int>(seconds: 100, capacity: 3, threshold: 0.015)
    for i in 0..<5 { ring.add(i, grid: i % 2 == 0 ? dark : light, at: Double(i)) }
    check(ring.entries.map(\.frame) == [2, 3, 4], "caps at capacity: \(ring.entries.map(\.frame))")
    check(ring.recent(within: 1.5, now: 4).map(\.frame) == [2, 3, 4], "recent includes the frame showing at the window start")
    check(ring.recent(within: 10, now: 4).map(\.frame) == [2, 3, 4], "recent is everything when the window is wider")
}

if failures > 0 { print("\(failures) failure(s)"); exit(1) }
print("capture tests passed")
