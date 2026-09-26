import AppKit

/// The `buffer` verb: a region's last few seconds, held in memory.
///
/// Samples the region `fps` times a second into a `Ring`, keeping a frame
/// only when it differs from the one before. Frames are downscaled to
/// `maxPixels` before they are kept, so ten seconds of a whole Retina
/// screen costs a few megabytes, not a few hundred.
///
/// Commands on stdin, one per line:
///
///   dump SECONDS DIR   write the frames from the last SECONDS to DIR as
///                      PNGs and answer with one JSON line listing them
///                      (DIR last, so it may contain spaces)
///
/// EOF ends the process: the daemon that owns it closes stdin, or dies.
enum Buffer {

    static func run(region: CGRect, fps: Double, seconds: Double, maxPixels: Int, threshold: Double) {
        let clock = { ProcessInfo.processInfo.systemUptime }
        let lock = NSLock()
        var ring = Ring<CGImage>(seconds: seconds, capacity: Int(ceil(seconds * max(fps, 0.1))) + 1,
                                 threshold: threshold)

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now(), repeating: 1 / max(fps, 0.1))
        timer.setEventHandler {
            guard let image = Vision.snapshot(region), let grid = Vision.grid(image) else { return }
            lock.lock(); defer { lock.unlock() }
            let now = clock()
            guard ring.wants(grid) else { ring.prune(now: now); return }
            ring.add(Vision.scaled(image, maxPixels: maxPixels), grid: grid, at: now)
        }
        timer.resume()

        while let line = readLine() {
            let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
            guard parts.first == "dump", parts.count == 3, let within = Double(parts[1]) else {
                reply(["ok": false, "error": "expected: dump SECONDS DIR"])
                continue
            }
            lock.lock()
            let now = clock()
            let frames = ring.recent(within: within, now: now)
            lock.unlock()
            var written: [[String: Any]] = []
            for (i, entry) in frames.enumerated() {
                let path = (parts[2] as NSString).appendingPathComponent(String(format: "frame-%03d.png", i))
                if Vision.write(entry.frame, to: path) {
                    written.append(["path": path, "ageMs": Int((now - entry.at) * 1000),
                                    "width": entry.frame.width, "height": entry.frame.height])
                }
            }
            reply(["ok": true, "frames": written,
                   "region": ["x": region.minX, "y": region.minY, "w": region.width, "h": region.height]])
        }
        timer.cancel()
    }

    private static func reply(_ payload: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}
