// Tests for the History window's data: decoding, days, durations, links. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

var cal = Calendar(identifier: .gregorian)
cal.timeZone = TimeZone(identifier: "UTC")!
let en = Locale(identifier: "en_US")
let now = cal.date(from: DateComponents(year: 2026, month: 3, day: 10, hour: 15))!
func ms(_ day: Int, _ hour: Int, year: Int = 2026, month: Int = 3) -> Double {
    cal.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!.timeIntervalSince1970 * 1000
}
func ex(_ id: String, _ at: Double, agent: String = "writer", status: String = "ok", chars: Int = 10) -> VoiceExchange {
    VoiceExchange(id: id, agentId: agent, at: at, durationMs: 4200, status: status,
                  question: "question \(id)", answerPreview: "answer", answerChars: chars, error: nil)
}

// --- Decoding what the daemon sends ---

let pageJSON = """
{"exchanges":[{"id":"01JA","agentId":"writer","at":1773154800000,"durationMs":4200,"status":"ok",
 "question":"What is on today?","answerPreview":"Two meetings…","answerChars":812,"error":null}],"next":"01JA"}
"""
let page = try! JSONDecoder().decode(VoiceHistoryPage.self, from: Data(pageJSON.utf8))
check(page.exchanges.count == 1 && page.next == "01JA" && page.exchanges[0].answerChars == 812, "a list page decodes")

let detailJSON = """
{"id":"01JA","agentId":"writer","at":1773154800000,"durationMs":null,"status":"ok","question":"q",
 "answer":"See https://example.com/a.","truncated":false,"error":null,
 "ui":{"buttons":[{"label":"Guide","url":"https://example.com/g"}],"media":{"type":"video","url":"https://example.com/v"}},
 "taskPath":"/tasks/01JA?agent=writer&channel=voice"}
"""
let detail = try! JSONDecoder().decode(VoiceExchangeDetail.self, from: Data(detailJSON.utf8))
check(detail.links.map(\.0) == ["Guide", "Video"] && detail.links.map(\.1) == ["https://example.com/g", "https://example.com/v"],
      "buttons and media become links")
check(detail.taskPath.hasPrefix("/tasks/01JA"), "the task path is kept for the dashboard")

// --- Days ---

let days = HistoryLogic.groupByDay([ex("a", ms(8, 9)), ex("c", ms(10, 14)), ex("b", ms(9, 20)), ex("d", ms(10, 9))],
                                   now: now, calendar: cal, locale: en)
check(days.map(\.title) == ["Today", "Yesterday", "Sunday, March 8"], "days are Today, Yesterday, then the date: \(days.map(\.title))")
check(days[0].exchanges.map(\.id) == ["c", "d"], "a day lists its newest exchange first")
let lastYear = HistoryLogic.groupByDay([ex("z", ms(2, 9, year: 2025, month: 12))], now: now, calendar: cal, locale: en)
check(lastYear.first?.title.contains("2025") == true, "another year shows the year: \(lastYear.first?.title ?? "")")
check(HistoryLogic.groupByDay([], now: now, calendar: cal).isEmpty, "no history, no days")

// --- Durations ---

check(HistoryLogic.duration(800) == "0.8 s", "under ten seconds shows a tenth")
check(HistoryLogic.duration(12_400) == "12 s", "seconds")
check(HistoryLogic.duration(125_000) == "2 min 5 s", "minutes and seconds")
check(HistoryLogic.duration(120_000) == "2 min", "whole minutes")
check(HistoryLogic.duration(nil) == "—", "unknown while the answer is coming")

// --- The menu row ---

let long = VoiceExchange(id: "x", agentId: "writer", at: 0, durationMs: nil, status: "ok",
                         question: "Could you   summarise\nthe three open reviews and tell me which one is blocking the release",
                         answerPreview: "", answerChars: 0, error: nil)
let title = HistoryLogic.menuTitle(long, agentName: "Writer")
check(title.hasPrefix("\u{201C}Could you summarise the three") && title.hasSuffix("\u{2026}\u{201D} · Writer"), "a menu row is the clipped question and the agent: \(title)")
check(!long.canReplay && ex("y", 0).canReplay && !ex("z", 0, status: "error").canReplay, "only an answered exchange can be replayed")

// --- Paging ---

let merged = HistoryLogic.merge([ex("b", 2), ex("a", 1)], [ex("a", 1), ex("0", 0.5)])
check(merged.map(\.id) == ["b", "a", "0"], "an older page adds without duplicates")
let q = HistoryLogic.query(agent: "writer", limit: 30, before: "01JA")
check(q == "limit=30&agent=writer&before=01JA", "the page query: \(q)")
check(HistoryLogic.query(agent: nil, limit: 3, before: nil) == "limit=3", "all agents, first page")
check(HistoryLogic.query(agent: "a b&c", limit: 3, before: nil).contains("agent=a%20b%26c"), "an agent id is encoded")

// --- Links in the written answer ---

check(HistoryLogic.linkify("See https://example.com/a.") == "See [https://example.com/a](https://example.com/a).", "a bare URL becomes a link, without the full stop")
check(HistoryLogic.linkify("[Guide](https://example.com/g)") == "[Guide](https://example.com/g)", "a markdown link is left alone")
check(HistoryLogic.linkify("<https://example.com>") == "<https://example.com>", "an autolink is left alone")
check(HistoryLogic.linkify("no links here") == "no links here", "text without links is unchanged")
let two = HistoryLogic.linkify("a http://x.test/1, b https://y.test/2")
check(two == "a [http://x.test/1](http://x.test/1), b [https://y.test/2](https://y.test/2)", "several links: \(two)")
let md = try? AttributedString(markdown: HistoryLogic.linkify("See https://example.com/a."),
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
check(md?.runs.contains { $0.link?.absoluteString == "https://example.com/a" } == true, "the result renders as a link")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("history: all passed")
