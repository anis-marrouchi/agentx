import SwiftUI

/// Geist in the SwiftUI windows (History, Requests, Settings), at the sizes
/// of the text styles they used. Font.custom falls back to the system font
/// when Brand.registerFonts found no Geist in the bundle.
extension Font {
    static func ax(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Geist", fixedSize: size).weight(weight)
    }

    private static func ax(_ style: NSFont.TextStyle, relativeTo: Font.TextStyle, mono: Bool = false) -> Font {
        .custom(mono ? "Geist Mono" : "Geist", size: NSFont.preferredFont(forTextStyle: style).pointSize, relativeTo: relativeTo)
    }

    static var axBody: Font { ax(.body, relativeTo: .body) }
    static var axCallout: Font { ax(.callout, relativeTo: .callout) }
    static var axCaption: Font { ax(.caption1, relativeTo: .caption) }
    static var axHeadline: Font { ax(.headline, relativeTo: .headline).weight(.semibold) }
    /// Eyebrows: mono, small (was .caption2.monospaced()).
    static var axMeta: Font { ax(.caption2, relativeTo: .caption2, mono: true) }
}
