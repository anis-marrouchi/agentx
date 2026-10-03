import CoreGraphics
import Foundation

/// What the character meets on the live screen (#539): the sides of the
/// windows that stand on its line. Read from the window list, which gives
/// each window's rectangle and no picture, title or text, so it needs no
/// permission.
enum Meets {
    /// A window smaller than this is not something to stop at.
    static let least = CGSize(width: 80, height: 40)

    /// Where the sides of `windows`, front to back, cross `band`: each
    /// side only where no window in front covers it. One set of
    /// coordinates for both.
    static func edges(of windows: [CGRect], band: ClosedRange<CGFloat>) -> [Double] {
        var found: [Double] = []
        for (i, window) in windows.enumerated() {
            let low = max(window.minY, band.lowerBound), high = min(window.maxY, band.upperBound)
            guard window.width >= least.width, window.height >= least.height, low < high else { continue }
            let y = (low + high) / 2
            for x in [window.minX, window.maxX] {
                let covered = windows[..<i].contains { $0.minX < x && x < $0.maxX && $0.minY <= y && y < $0.maxY }
                if !covered { found.append(Double(x)) }
            }
        }
        return found
    }

    /// The ordinary windows on screen, front to back, measured from the
    /// top left of the main screen.
    static func windows() -> [CGRect] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { window in
            guard window[kCGWindowLayer as String] as? Int == 0, window[kCGWindowAlpha as String] as? Double != 0,
                  let bounds = window[kCGWindowBounds as String] else { return nil }
            return CGRect(dictionaryRepresentation: bounds as! CFDictionary)
        }
    }
}
