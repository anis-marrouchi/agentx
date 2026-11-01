// The answer card in a real web view. Run with ../../test.sh, which serves
// Resources/ over loopback the way the daemon does, refusing pages on
// another origin, and passes the port.
// - A file in an answer really loads in the card (#1670), not just in the HTML.
// - The card is same-origin with the daemon, so its page runs no script:
//   not a <script>, not a handler, not a clicked `javascript:` link (#1680).
import AppKit
import WebKit

let daemon = "http://127.0.0.1:\(CommandLine.arguments[1])"
let base = Artifacts.pageBase(daemon)
var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

/// Loads a page and hands the web view over once it has finished.
final class Loader: NSObject, WKNavigationDelegate {
    let web: WKWebView
    var then: ((WKWebView) -> Void)?
    init(_ config: WKWebViewConfiguration) {
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240), configuration: config)
        super.init()
        web.navigationDelegate = self
    }
    func load(_ html: String, then: @escaping (WKWebView) -> Void) {
        self.then = then
        web.loadHTMLString(html, baseURL: base)
    }
    func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
        let next = then; then = nil
        next?(web)
    }
}

/// App script, which must still run with page script off.
func run(_ web: WKWebView, _ js: String, _ done: @escaping (Any?) -> Void) {
    web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { done(try? $0.get()) }
}

// Everything a page could try, all setting the title to "ran".
let hostile = Markdown.page("""
    <script>document.title = 'ran'</script>
    <img src="/missing.png" onerror="document.title = 'ran'">
    <a id="js" href="javascript:document.title = 'ran'">open</a>
    """)
let clickThenTitle = "document.getElementById('js').click();"
    + " return new Promise(r => setTimeout(() => r(document.title), 500))"

var keep: [Loader] = []
func step(_ config: WKWebViewConfiguration, _ html: String, _ js: String, _ check: @escaping (Any?) -> Void,
          next: @escaping () -> Void) {
    let loader = Loader(config)
    keep.append(loader)
    loader.load(html) { web in run(web, js) { check($0); next() } }
}

let picture = Artifact(name: "icon.png", mime: "image/png", kind: "image", url: "/AppIcon.png")
let steps: [(@escaping () -> Void) -> Void] = [
    { next in
        step(CardWeb.configuration(), Markdown.page("Here it is." + Artifacts.html([picture], base: daemon)),
             "return new Promise(r => { const i = document.querySelector('img');"
                + " if (i.complete) r(i.naturalWidth); i.onload = () => r(i.naturalWidth); i.onerror = () => r(0) })",
             { let w = ($0 as? NSNumber)?.intValue ?? 0
               check(w > 0, "a picture from the daemon loads in the card (width \(w))") }, next: next)
    },
    { next in
        // Control: with page script on, the same page does run, so the
        // next case is not passing by accident.
        step(WKWebViewConfiguration(), hostile, clickThenTitle,
             { check(($0 as? String) == "ran", "control: a default web view runs the page's script") }, next: next)
    },
    { next in
        step(CardWeb.configuration(), hostile, clickThenTitle,
             { check(($0 as? String) != "ran", "the card runs no page script, handler or javascript: link") }, next: next)
    },
    { next in
        let md = Markdown.page(Markdown.toHTML("[open](javascript:document.title='ran')"))
        step(CardWeb.configuration(), md,
             "const n = document.querySelectorAll('a').length; return n + ':' + document.title",
             { check(($0 as? String) == "0:", "a javascript: link in an answer is text, not a link") }, next: next)
    },
]

func go(_ i: Int) {
    guard i < steps.count else {
        if failures > 0 { print("\(failures) failed"); exit(1) }
        print("all passed")
        exit(0)
    }
    steps[i]({ go(i + 1) })
}
go(0)
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("FAIL timed out"); exit(1) }
NSApplication.shared.run()
