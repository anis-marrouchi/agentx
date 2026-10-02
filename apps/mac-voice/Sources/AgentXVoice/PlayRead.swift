import AppKit
import Vision

/// Play mode's stage (#505): one picture of the screen and the lines of
/// text on it. The picture is read here, on this Mac, by Apple's Vision
/// framework; it is kept in memory only and nothing is uploaded.
///
/// Taking the picture needs the Screen Recording permission. Without it
/// macOS gives a picture of the desktop alone rather than an error, so the
/// permission is checked first.
enum PlayRead {
    static var allowed: Bool { CGPreflightScreenCaptureAccess() }

    /// Shows the system's request, once; after that macOS only answers no.
    static func ask() { CGRequestScreenCaptureAccess() }

    /// What is on `screen` now.
    static func picture(of screen: NSScreen) -> CGImage? {
        // Screens are measured from the bottom of the first one; the
        // picture is asked for from its top.
        guard let first = NSScreen.screens.first else { return nil }
        let f = screen.frame
        let rect = CGRect(x: f.minX, y: first.frame.maxY - f.maxY, width: f.width, height: f.height)
        return CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    }

    /// The lines of text in `image`, top to bottom, in points of a picture
    /// `size` across with its origin top-left. Slow (a second or so for a
    /// whole screen): call it off the main thread.
    static func lines(in image: CGImage, size: CGSize) -> [PlayMath.Line] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["fr-FR", "en-US"]
        // Where the letters are matters here, not what they spell.
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil,
              let found = request.results else { return [] }
        let pixels = Pixels(image, size: size)

        var lines: [PlayMath.Line] = []
        for observation in found {
            guard let text = observation.topCandidates(1).first else { continue }
            let s = text.string
            var words: [PlayMath.Word] = []
            var i = s.startIndex
            while i < s.endIndex {
                guard !s[i].isWhitespace else { i = s.index(after: i); continue }
                let end = s[i...].firstIndex(where: \.isWhitespace) ?? s.endIndex
                // Vision's boxes are 0…1 from the bottom-left of the image.
                if let b = (try? text.boundingBox(for: i..<end))?.boundingBox {
                    words.append(PlayMath.Word(text: String(s[i..<end]),
                                               rect: PlayMath.Rect(x: b.minX * size.width, y: (1 - b.maxY) * size.height,
                                                                   w: b.width * size.width, h: b.height * size.height)))
                }
                i = end
            }
            guard let first = words.first, let last = words.last else { continue }
            let top = words.map(\.rect.y).min()!, bottom = words.map(\.rect.maxY).max()!
            let rect = PlayMath.Rect(x: first.rect.x, y: top, w: last.rect.maxX - first.rect.x, h: bottom - top)
            lines.append(PlayMath.Line(words: words, rect: rect, paper: pixels?.paper(around: rect) ?? 0xFFFFFF))
        }
        return lines.sorted { abs($0.rect.y - $1.rect.y) > 6 ? $0.rect.y < $1.rect.y : $0.rect.x < $1.rect.x }
    }

    /// The picture at one pixel a point, to read colours from.
    private struct Pixels {
        let data: [UInt8]
        let width, height: Int

        init?(_ image: CGImage, size: CGSize) {
            let w = Int(size.width), h = Int(size.height)
            guard w > 0, h > 0 else { return nil }
            var bytes = [UInt8](repeating: 0, count: w * h * 4)
            let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
                guard let ctx = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            guard drawn else { return nil }
            data = bytes; width = w; height = h
        }

        /// The page's colour around a line: what most points just above
        /// and just under it share.
        func paper(around r: PlayMath.Rect) -> UInt32? {
            var samples: [UInt32] = []
            for y in [Int(r.y) - 3, Int(r.maxY) + 3] where y >= 0 && y < height {
                for x in stride(from: max(Int(r.x), 0), to: min(Int(r.maxX), width), by: 3) {
                    let i = (y * width + x) * 4
                    samples.append(UInt32(data[i]) << 16 | UInt32(data[i + 1]) << 8 | UInt32(data[i + 2]))
                }
            }
            return PlayMath.common(samples)
        }
    }
}
