// A file in an answer really loads in the card's web view (#1670), not
// just in the HTML. Run with ../../test.sh, which serves Resources/ over
// loopback the way the daemon does, refusing pages on another origin, and
// passes the port.
import AppKit
import WebKit

let daemon = "http://127.0.0.1:\(CommandLine.arguments[1])"
let picture = Artifact(name: "icon.png", mime: "image/png", kind: "image", url: "/AppIcon.png")
let page = Markdown.page("Here it is." + Artifacts.html([picture], base: daemon))

final class Probe: NSObject, WKNavigationDelegate {
    func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
        let js = "return new Promise(r => { const i = document.querySelector('img');"
            + " if (i.complete) r(i.naturalWidth); i.onload = () => r(i.naturalWidth); i.onerror = () => r(0) })"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            let width = (try? result.get() as? NSNumber)?.intValue ?? 0
            print("\(width > 0 ? "ok  " : "FAIL") a picture from the daemon loads in the card (width \(width))")
            exit(width > 0 ? 0 : 1)
        }
    }
}

let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
let probe = Probe()
web.navigationDelegate = probe
web.loadHTMLString(page, baseURL: Artifacts.pageBase(daemon))
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("FAIL timed out"); exit(1) }
NSApplication.shared.run()
