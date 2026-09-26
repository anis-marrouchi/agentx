import AppKit

/// Display geometry, in the same top-left coordinate space as everything
/// else in this helper.
///
/// AppKit reports screens in a global space whose origin is the PRIMARY
/// screen's bottom-left and whose y grows upward. The accessibility tree,
/// OCR and the pointer all use top-left origins with y growing downward.
/// Mixing the two puts the cursor on the wrong monitor — and on a single
/// display it looks correct, so the bug only appears on someone else's
/// desk. Converting once, here, is cheaper than remembering not to.
enum Screens {

    struct Info: Codable {
        let index: Int
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        /// The screen with the menu bar.
        let primary: Bool
        /// The screen the active window is on.
        let active: Bool
        /// 2.0 on Retina. A capture comes back at this multiple of the
        /// point size, which is why anything sent to a model is scaled.
        let scale: Double
    }

    static func list() -> [Info] {
        let screens = NSScreen.screens
        guard let primary = screens.first else { return [] }
        // Every y flips about the primary screen's top edge.
        let top = primary.frame.maxY
        return screens.enumerated().map { index, screen in
            Info(index: index,
                 x: screen.frame.minX,
                 y: top - screen.frame.maxY,
                 width: screen.frame.width,
                 height: screen.frame.height,
                 primary: index == 0,
                 active: screen == NSScreen.main,
                 scale: screen.backingScaleFactor)
        }
    }

    /// The screen to capture when no rectangle is given: the one holding
    /// the active window, not blindly the primary.
    static func active() -> Info? {
        let all = list()
        return all.first(where: { $0.active }) ?? all.first
    }

    /// Full bounds of one screen, in top-left coordinates.
    static func rect(_ info: Info) -> CGRect {
        CGRect(x: info.x, y: info.y, width: info.width, height: info.height)
    }

    /// The menu bar strip of a screen.
    ///
    /// Its own region because it is where macOS puts the truth about
    /// background state: recording indicators, capture pills, sync and VPN
    /// status. None of it is in any app's accessibility tree, and reading
    /// a 24-point strip costs a fraction of a full screen.
    static func menuBar(_ info: Info) -> CGRect {
        CGRect(x: info.x, y: info.y, width: info.width, height: 26)
    }

    /// Where macOS shows notification banners: the top-right corner of the
    /// primary screen, under the menu bar. Generous, because banner size
    /// varies with the text; a caller that knows better passes a rect.
    static func notifications(_ info: Info) -> CGRect {
        CGRect(x: info.x + info.width - 420, y: info.y + 26, width: 420, height: 180)
    }
}
