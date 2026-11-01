// Tests for Artifacts and Markdown pictures: files in an answer (#1670).
// Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let base = "http://127.0.0.1:18800"
let video = Artifact(name: "promo.mp4", mime: "video/mp4", kind: "video", url: "/app-files?agent=a&file=.agentx%2Foutbox%2Fpromo.mp4")
let image = Artifact(name: "chart.png", mime: "image/png", kind: "image", url: "/app-files?agent=a&file=c.png")
let audio = Artifact(name: "note.m4a", mime: "audio/mp4", kind: "audio", url: "/app-files?agent=a&file=n.m4a")
let pdf = Artifact(name: "report.pdf", mime: "application/pdf", kind: "file", url: "/app-files?agent=a&file=r.pdf")
let gone = Artifact(name: "old<1>.png", mime: "image/png", kind: "image", url: nil)

check(Artifacts.html([], base: base) == "", "no files: nothing added")
let html = Artifacts.html([video, image, audio, pdf, gone], base: base)
check(html.contains("<video class=\"ax-media\" src=\"\(base)/app-files?agent=a&amp;file=.agentx%2Foutbox%2Fpromo.mp4\" controls"), "a video gets a player from the daemon")
check(html.contains("<img class=\"ax-media\" src=\"\(base)/app-files?agent=a&amp;file=c.png\""), "a picture shows inline")
check(html.contains("<audio src=\"\(base)/app-files?agent=a&amp;file=n.m4a\" controls"), "sound gets a player")
check(html.contains("<a href=\"\(base)/app-files?agent=a&amp;file=r.pdf\">Open report.pdf</a>"), "another file is an Open link")
check(html.contains("File not available: old&lt;1&gt;.png"), "a file with no url says so, escaped")
check(!html.contains("agentx-artifact"), "no raw tag")

let decoded = try? JSONDecoder().decode([Artifact].self, from: Data(#"[{"name":"a.png","mime":"image/png","kind":"image","url":null}]"#.utf8))
check(decoded == [Artifact(name: "a.png", mime: "image/png", kind: "image", url: nil)], "a missing file decodes with no url")

let md = Markdown.toHTML("See ![Trend](https://example.com/t.png) and [docs](https://example.com/d).")
check(md.contains("<img class=\"md-img\" alt=\"Trend\" src=\"https://example.com/t.png\">"), "a web picture renders inline")
check(md.contains("<a href=\"https://example.com/d\">docs</a>"), "a link stays a link")
check(!md.contains("!<a") && !md.contains("href=\"https://example.com/t.png\""), "the picture is not also a link")

// Agent text can repeat untrusted content: a quote must not end an href
// and start an attribute, and only web and mail links become links.
let bare = Markdown.toHTML(#"See https://a.b/"onmouseover="alert(1) now"#)
check(!bare.contains("\"onmouseover"), "a quote in a bare URL does not break out of href")
let quoted = Markdown.toHTML(#"[x](https://a.b/"onclick="alert(1))"#)
check(!quoted.contains("\"onclick"), "a quote in a link target does not break out of href")
let single = Markdown.toHTML("[x](https://a.b/'onclick='alert(1))")
check(!single.contains("'onclick"), "a single quote is escaped too")
let js = Markdown.toHTML("[x](javascript:alert(1))")
check(!js.contains("href=\"javascript"), "a javascript: link stays text")
check(Markdown.toHTML("[mail](mailto:a@b.c)").contains("<a href=\"mailto:a@b.c\">mail</a>"), "a mailto link stays a link")
check(Markdown.page("").contains("Content-Security-Policy\" content=\"default-src 'none';"), "the card page allows no script")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
