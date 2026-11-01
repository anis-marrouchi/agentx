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

    /// Fallback styling when no design tokens are supplied.
    static let defaultCSS = """
      body { font: -apple-system-body; font-size: 13px; margin: 12px; line-height: 1.5;
             color: canvastext; background: transparent; word-wrap: break-word; }
      code { font: ui-monospace, monospace; font-size: 12px;
             background: color-mix(in srgb, canvastext 10%, transparent);
             padding: 1px 4px; border-radius: 4px; }
      pre { background: color-mix(in srgb, canvastext 8%, transparent);
            padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
      a { color: linktext; }
    """


    static func toHTML(_ markdown: String) -> String {
        var html = ""
        var inCode = false
        var listDepth = 0

        func closeList() {
            while listDepth > 0 { html += "</ul>"; listDepth -= 1 }
        }

        let lines = markdown.components(separatedBy: .newlines)
        var i = 0
        while i < lines.count {
            let line = lines[i]
            i += 1

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

            // Pipe table: a row followed by a `|---|:--:|` separator. Rows
            // run until the first line without a pipe.
            if i < lines.count, trimmed.contains("|"),
               let align = separator(lines[i]), align.count == cellsOf(trimmed).count {
                closeList()
                let width = align.count
                func row(_ text: String, _ tag: String) -> String {
                    var cells = Array(cellsOf(text).prefix(width))
                    cells += Array(repeating: "", count: width - cells.count)
                    return "<tr>" + zip(cells, align).map { cell, a in
                        "<\(tag)\(a.map { " style=\"text-align:\($0)\"" } ?? "")>\(inline(cell))</\(tag)>"
                    }.joined() + "</tr>"
                }
                html += "<div class=\"md-table\"><table><thead>\(row(trimmed, "th"))</thead><tbody>"
                i += 1
                while i < lines.count {
                    let next = lines[i].trimmingCharacters(in: .whitespaces)
                    guard !next.isEmpty, next.contains("|") else { break }
                    html += row(next, "td")
                    i += 1
                }
                html += "</tbody></table></div>"
                continue
            }

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

    /// Cells of a table row: split on pipes, but not on `\|`; the outer
    /// pipes are optional.
    private static func cellsOf(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|") && !row.hasSuffix("\\|") { row.removeLast() }
        var cells = [""]
        var escaped = false
        for ch in row {
            if escaped { cells[cells.count - 1] += ch == "|" ? "|" : "\\\(ch)"; escaped = false }
            else if ch == "\\" { escaped = true }
            else if ch == "|" { cells.append("") }
            else { cells[cells.count - 1].append(ch) }
        }
        if escaped { cells[cells.count - 1] += "\\" }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The `|---|:--:|---:|` line under a table header, as one alignment
    /// per column (nil = default), or nil when the line is not one.
    private static func separator(_ line: String) -> [String?]? {
        guard line.contains("-") else { return nil }
        let cells = cellsOf(line)
        var align: [String?] = []
        for cell in cells {
            let dashes = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            switch (cell.hasPrefix(":"), cell.hasSuffix(":")) {
            case (true, true): align.append("center")
            case (false, true): align.append("right")
            case (true, false): align.append("left")
            default: align.append(nil)
            }
        }
        return align
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
        // A picture on the web, before links: `![alt](https://...)` is a
        // link with a `!` in front.
        s = replace(s, #"!\[([^\]"]*)\]\((https?://[^)\s"]+)\)"#, "<img class=\"md-img\" alt=\"$1\" src=\"$2\">")
        // Only web and mail links: a javascript: target stays text.
        s = replace(s, #"\[([^\]]+)\]\(((?:https?://|mailto:)[^)\s]+)\)"#, "<a href=\"$2\">$1</a>")
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
         // Quotes too: a link target goes into href="...", and a quote in
         // agent text must not end it and start an attribute.
         .replacingOccurrences(of: "\"", with: "&quot;")
         .replacingOccurrences(of: "'", with: "&#39;")
    }

    /// Wraps rendered HTML in a page that follows the system appearance.
    /// A card that is white while everything else is dark is worse than
    /// plain text.
    ///
    /// The page runs no script of its own: the card is same-origin with the
    /// daemon (#1670), and its text can repeat untrusted content.
    static let policy = "default-src 'none'; img-src http: https:; media-src http: https:; style-src 'unsafe-inline'"

    static func page(_ body: String, css: String? = nil) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <style>\(css ?? defaultCSS)</style>
        </head><body>\(body)</body></html>
        """
    }
}
