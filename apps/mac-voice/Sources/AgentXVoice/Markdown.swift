import Foundation

/// Markdown to HTML, small and dependency-free.
///
/// Agents write markdown by default — headings, bullets, fenced code,
/// tables. Rendered as plain text it is a mess of asterisks and hashes,
/// which is worse than useless when the whole point of the card is that
/// the written answer is more readable than the spoken one.
///
/// A real parser would be better and is not worth a dependency here. This
/// handles what agents actually produce; anything it does not recognise
/// falls through as text rather than breaking the page.
enum Markdown {

    static func toHTML(_ markdown: String) -> String {
        var html = ""
        var inCode = false
        var listDepth = 0

        func closeList() {
            while listDepth > 0 { html += "</ul>"; listDepth -= 1 }
        }

        for rawLine in markdown.components(separatedBy: .newlines) {
            let line = rawLine

            // Fenced code: everything inside is literal, including things
            // that would otherwise look like markdown.
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode { html += "</code></pre>" } else { closeList(); html += "<pre><code>" }
                inCode.toggle()
                continue
            }
            if inCode { html += escape(line) + "\n"; continue }

            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { closeList(); html += "<p></p>"; continue }

            // Headings
            if let h = heading(trimmed) {
                closeList()
                html += "<h\(h.level)>\(inline(h.text))</h\(h.level)>"
                continue
            }

            // Bullets and numbered items, both rendered as a list — the
            // marker style matters far less than the indentation reading
            // correctly.
            if let item = listItem(trimmed) {
                if listDepth == 0 { html += "<ul>"; listDepth = 1 }
                html += "<li>\(inline(item))</li>"
                continue
            }

            if trimmed.hasPrefix("> ") {
                closeList()
                html += "<blockquote>\(inline(String(trimmed.dropFirst(2))))</blockquote>"
                continue
            }

            // Horizontal rule
            if trimmed == "---" || trimmed == "***" { closeList(); html += "<hr>"; continue }

            closeList()
            html += "<p>\(inline(trimmed))</p>"
        }
        closeList()
        if inCode { html += "</code></pre>" }
        return html
    }

    private static func heading(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        var rest = Substring(line)
        while rest.first == "#" && level < 6 { level += 1; rest = rest.dropFirst() }
        guard level > 0, rest.first == " " else { return nil }
        return (level, String(rest.dropFirst()))
    }

    private static func listItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ "] {
            if line.hasPrefix(marker) { return String(line.dropFirst(marker.count)) }
        }
        // "1. item"
        if let dot = line.firstIndex(of: "."), line[line.startIndex..<dot].allSatisfy(\.isNumber),
           line.index(after: dot) < line.endIndex, line[line.index(after: dot)] == " " {
            return String(line[line.index(dot, offsetBy: 2)...])
        }
        return nil
    }

    /// Inline spans. Order matters: code first, so its contents are not
    /// then treated as emphasis.
    private static func inline(_ text: String) -> String {
        var s = escape(text)
        s = replace(s, #"`([^`]+)`"#, "<code>$1</code>")
        s = replace(s, #"\*\*([^*]+)\*\*"#, "<strong>$1</strong>")
        s = replace(s, #"(?<![\*\w])\*([^*]+)\*(?![\*\w])"#, "<em>$1</em>")
        s = replace(s, #"\[([^\]]+)\]\(([^)\s]+)\)"#, "<a href=\"$2\">$1</a>")
        // Bare URLs, but not ones already inside an href.
        s = replace(s, #"(?<!["=])\b(https?://[^\s<)]+)"#, "<a href=\"$1\">$1</a>")
        return s
    }

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        return re.stringByReplacingMatches(
            in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Wraps rendered HTML in a page that follows the system appearance.
    /// A card that is white while everything else is dark is worse than
    /// plain text.
    static func page(_ body: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <style>
          :root { color-scheme: light dark; }
          body {
            font: -apple-system-body; font-size: 13px;
            margin: 12px; line-height: 1.5;
            color: canvastext; background: transparent;
            word-wrap: break-word;
          }
          h1,h2,h3,h4 { margin: .6em 0 .3em; font-size: 1.08em; font-weight: 650; }
          p { margin: .4em 0; }
          ul { margin: .35em 0; padding-left: 1.2em; }
          li { margin: .15em 0; }
          code {
            font: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
            background: color-mix(in srgb, canvastext 10%, transparent);
            padding: 1px 4px; border-radius: 4px;
          }
          pre {
            background: color-mix(in srgb, canvastext 8%, transparent);
            padding: 8px 10px; border-radius: 6px; overflow-x: auto;
          }
          pre code { background: none; padding: 0; }
          blockquote {
            margin: .4em 0; padding-left: .8em;
            border-left: 3px solid color-mix(in srgb, canvastext 25%, transparent);
            opacity: .85;
          }
          a { color: linktext; }
          hr { border: none; border-top: 1px solid color-mix(in srgb, canvastext 20%, transparent); }
        </style></head><body>\(body)</body></html>
        """
    }
}
