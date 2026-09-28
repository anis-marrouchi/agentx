import Foundation

/// Past voice exchanges as the daemon serves them (GET /voice/history),
/// and the small decisions the History window and the menu make about
/// them. Foundation only, so Tests/History can run it without a window.

/// One row of the list: a bounded summary, never the whole answer.
struct VoiceExchange: Decodable, Identifiable, Equatable {
    let id: String
    let agentId: String
    /// When it was asked, ms since the epoch.
    let at: Double
    let durationMs: Int?
    /// "ok", "error", "in-flight", "canceled" or "timeout".
    let status: String
    let question: String
    let answerPreview: String
    let answerChars: Int
    let error: String?

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
    var failed: Bool { status == "error" || status == "timeout" || status == "canceled" }
    /// Something to say again.
    var canReplay: Bool { answerChars > 0 && !failed }
}

struct VoiceHistoryPage: Decodable {
    let exchanges: [VoiceExchange]
    let next: String?
}

/// One exchange in full (GET /voice/history/:id), loaded when opened.
struct VoiceExchangeDetail: Decodable {
    struct Button: Decodable, Equatable { let label: String; let url: String }
    struct Media: Decodable, Equatable { let type: String; let url: String; let caption: String? }
    struct UI: Decodable, Equatable { let buttons: [Button]?; let media: Media? }

    let id: String
    let agentId: String
    let at: Double
    let durationMs: Int?
    let status: String
    let question: String
    let answer: String?
    let truncated: Bool
    let ui: UI?
    let error: String?
    /// The task page, relative to the dashboard's address.
    let taskPath: String

    /// Buttons and a non-image media link, as (label, url).
    var links: [(String, String)] {
        var out = (ui?.buttons ?? []).map { ($0.label, $0.url) }
        if let m = ui?.media { out.append((m.caption ?? m.type.capitalized, m.url)) }
        return out
    }
}

/// A day's exchanges under one heading.
struct HistoryDay: Equatable {
    let title: String
    let exchanges: [VoiceExchange]
}

enum HistoryLogic {
    /// Newest day first, each day newest first; "Today", "Yesterday", then
    /// the date. Input order does not matter.
    static func groupByDay(_ items: [VoiceExchange], now: Date = Date(),
                           calendar: Calendar = .current, locale: Locale = .current) -> [HistoryDay] {
        let sorted = items.sorted { $0.at != $1.at ? $0.at > $1.at : $0.id > $1.id }
        var days: [HistoryDay] = []
        var current: (Date, [VoiceExchange])?
        for e in sorted {
            let day = calendar.startOfDay(for: e.date)
            if let c = current, c.0 == day {
                current = (day, c.1 + [e])
            } else {
                if let c = current { days.append(HistoryDay(title: dayTitle(c.0, now: now, calendar: calendar, locale: locale), exchanges: c.1)) }
                current = (day, [e])
            }
        }
        if let c = current { days.append(HistoryDay(title: dayTitle(c.0, now: now, calendar: calendar, locale: locale), exchanges: c.1)) }
        return days
    }

    static func dayTitle(_ day: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: y) { return "Yesterday" }
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        f.setLocalizedDateFormatFromTemplate(sameYear ? "EEEEdMMMM" : "EEEEdMMMMyyyy")
        return f.string(from: day)
    }

    /// How long the answer took: "0.8 s", "12 s", "2 min 5 s"; "—" unknown.
    static func duration(_ ms: Int?) -> String {
        guard let ms, ms >= 0 else { return "—" }
        if ms < 10_000 { return String(format: "%.1f s", Double(ms) / 1000) }
        let s = Int((Double(ms) / 1000).rounded())
        if s < 60 { return "\(s) s" }
        let m = s / 60, r = s % 60
        return r == 0 ? "\(m) min" : "\(m) min \(r) s"
    }

    /// A menu row: the question, clipped, and who answered.
    static func menuTitle(_ e: VoiceExchange, agentName: String, max: Int = 44) -> String {
        let q = e.question.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let clipped = q.count > max ? String(q.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : q
        return "\u{201C}\(clipped)\u{201D} · \(agentName)"
    }

    /// Add a page to what is shown: no duplicates, newest first.
    static func merge(_ shown: [VoiceExchange], _ page: [VoiceExchange]) -> [VoiceExchange] {
        var seen = Set(shown.map(\.id))
        var out = shown
        for e in page where seen.insert(e.id).inserted { out.append(e) }
        return out.sorted { $0.at != $1.at ? $0.at > $1.at : $0.id > $1.id }
    }

    /// Bare http(s) URLs as markdown links, so the written answer shows
    /// them as links. URLs already inside a markdown link or <…> are left.
    static func linkify(_ text: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"(?<![\(\[<])\bhttps?://[^\s<>()\[\]]+"#) else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var url = ns.substring(with: m.range)
            // A sentence's full stop or comma is not part of the link.
            var tail = ""
            while let c = url.last, ".,;:!?\"'".contains(c) { tail = String(c) + tail; url.removeLast() }
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += "[\(url)](\(url))"
            out += tail
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    /// The query string for a page of history.
    static func query(agent: String?, limit: Int, before: String?) -> String {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let agent, !agent.isEmpty { items.append(URLQueryItem(name: "agent", value: agent)) }
        if let before, !before.isEmpty { items.append(URLQueryItem(name: "before", value: before)) }
        var c = URLComponents()
        c.queryItems = items
        return c.percentEncodedQuery ?? ""
    }
}
