import AppKit
import WebKit

/// The Hub as the app's own window (#2101 C3, design note §3: "the Hub
/// installed as an app window"). AgentX Voice opens the dashboard's Hub
/// (`Config.dashboardURL` + /hub) in a native window with the traffic
/// lights, a Dock icon and the Hub's own status bar, in place of the pill
/// as the app's main surface.
///
/// The Hub on this Mac's loopback address carries the dashboard token in
/// its page, so the window needs no sign-in. Talking from the window is the
/// Hub's own mic (#2168): the web view is granted the microphone for the
/// dashboard's own address and nothing else. Links to anywhere else open
/// in the browser.
///
/// While the window is on screen the pill steps back (Panel.hubShown): it
/// shows only for an ⌥Space turn, which is still the app's own until
/// #2108 moves it into the Hub.
@MainActor
final class HubWindow: NSObject, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    static let shared = HubWindow()

    /// The Hub is on screen (open, not minimised) or not.
    var onShownChanged: ((Bool) -> Void)?

    private(set) var window: NSWindow?
    private(set) var web: WKWebView?

    /// The app opens as the Hub window. On by default: the Hub is the app.
    static var isApp: Bool {
        get { UserDefaults.standard.object(forKey: "hubApp") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "hubApp") }
    }

    static var hubURL: URL? { URL(string: Config.dashboardURL + "/hub") }

    var isShown: Bool { window.map { $0.isVisible && !$0.isMiniaturized } ?? false }

    func show() {
        prepare()
        NSApp.setActivationPolicy(.regular)
        HubWindow.installMainMenu()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onShownChanged?(isShown)
    }

    /// Makes the window and starts loading the Hub, once; not shown.
    func prepare() {
        guard window == nil else { return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "AgentX"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 720, height: 480)
        w.backgroundColor = Brand.paper
        w.contentView = web
        w.delegate = self
        w.center()
        w.setFrameAutosaveName("AgentXHub")
        window = w
        self.web = web
        load()
    }

    private func load() {
        guard let url = HubWindow.hubURL else { return }
        web?.load(URLRequest(url: url))
    }

    /// Same scheme, host and port as the dashboard.
    static func isHub(_ url: URL?) -> Bool {
        guard let url, let hub = hubURL else { return false }
        return url.scheme == hub.scheme && url.host == hub.host && url.port == hub.port
    }

    // MARK: Window

    func windowWillClose(_ notification: Notification) {
        // The app goes on in the menu bar, as before the Hub window.
        NSApp.setActivationPolicy(.accessory)
        onShownChanged?(false)
    }
    func windowDidMiniaturize(_ notification: Notification) { onShownChanged?(false) }
    func windowDidDeminiaturize(_ notification: Notification) { onShownChanged?(true) }

    // MARK: Web view

    /// The Hub's mic: the dashboard's own page only.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let hub = HubWindow.hubURL
        let same = origin.protocol == hub?.scheme && origin.host == hub?.host && origin.port == (hub?.port ?? 0)
        decisionHandler(same && type == .microphone ? .grant : .deny)
    }

    /// Links elsewhere, and target=_blank, open in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, !HubWindow.isHub(url), action.targetFrame?.isMainFrame ?? true,
           url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if HubWindow.isHub(url) { webView.load(URLRequest(url: url)) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// The dashboard is not running: say so in the window, with a retry.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <body style="font: 14px -apple-system, sans-serif; color: #525252; display: grid; place-items: center; height: 90vh; margin: 0">
        <div style="text-align: center; max-width: 420px">
        <h2 style="color: canvastext">The Hub did not open</h2>
        <p>AgentX's dashboard did not answer at \(Config.dashboardURL). Start it with <code>agentx daemon start</code>, then try again.</p>
        <p><a href="\(Config.dashboardURL)/hub">Try again</a></p></div></body>
        """
        webView.loadHTMLString(html, baseURL: HubWindow.hubURL)
    }

    // MARK: Menus

    /// A regular app needs its own menu bar: Quit, the Edit commands the
    /// Hub's text boxes use (⌘C, ⌘V, ⌘Z), Reload, and the Window menu.
    static func installMainMenu() {
        guard NSApp.mainMenu?.item(withTitle: "Edit") == nil else { return }
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            item.submenu = m
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        sub("AgentX", [item("Quit AgentX", #selector(NSApplication.terminate(_:)), "q")])
        sub("Edit", [
            item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        sub("View", [item("Reload", #selector(WKWebView.reload(_:)), "r")])
        sub("Window", [item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
                       item("Close", #selector(NSWindow.performClose(_:)), "w")])
        NSApp.mainMenu = main
    }
}
