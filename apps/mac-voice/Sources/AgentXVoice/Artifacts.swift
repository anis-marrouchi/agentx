import Foundation

/// A file an agent declared in its answer (#1670): the same
/// `<agentx-artifact>` line the phone app shows. /ask takes the line out of
/// the text and lists the file with the daemon path that serves it, or no
/// path when this computer can't serve it.
struct Artifact: Decodable, Equatable {
    let name: String
    let mime: String
    /// image, audio, video or file.
    let kind: String
    /// Relative to the daemon; nil when the file is not available here.
    let url: String?
}

enum Artifacts {
    /// The files as HTML, under the answer's text: pictures inline, sound
    /// and video with a player, anything else as an Open link. Each box has
    /// a fixed height, so the answer measures right before media has loaded.
    static func html(_ list: [Artifact], base: String) -> String {
        guard !list.isEmpty else { return "" }
        let items = list.map { a -> String in
            let name = escape(a.name)
            guard let path = a.url else {
                return "<p class=\"ax-missing\">File not available: \(name)</p>"
            }
            let src = escape(base + path)
            switch a.kind {
            case "image": return "<img class=\"ax-media\" src=\"\(src)\" alt=\"\(name)\">"
            case "video": return "<video class=\"ax-media\" src=\"\(src)\" controls preload=\"metadata\"></video>"
            case "audio": return "<audio src=\"\(src)\" controls preload=\"metadata\"></audio><p class=\"ax-name\">\(name)</p>"
            default: return "<p><a href=\"\(src)\">Open \(name)</a></p>"
            }
        }
        return "<div class=\"ax-files\">" + items.joined() + "</div>"
    }

    /// Added to the card's styles.
    static let css = """
      .ax-files { margin-top: 8px; }
      .ax-media { display: block; width: 100%; height: 180px; object-fit: contain;
                  margin: 6px 0; border-radius: 6px; background: color-mix(in srgb, canvastext 6%, transparent); }
      audio { display: block; width: 100%; height: 32px; margin: 6px 0 0; }
      .ax-name, .ax-missing { margin: 2px 0 6px; font-size: 12px; opacity: 0.7; }
      img.md-img { display: block; max-width: 100%; height: 180px; object-fit: contain; margin: 6px 0; }
    """

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
         .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
