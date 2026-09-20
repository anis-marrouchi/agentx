import AppKit
import WebKit

/// What the agent said, in a form you can read, click and copy.
///
/// Speech is lossy in one specific way that matters: a URL cannot be
/// spoken usefully, an image cannot be spoken at all, and a name you have
/// not seen written is a name you cannot act on. The spoken answer is
/// deliberately short and stripped of exactly those things — so without a
/// visual surface, everything worth keeping from a turn is the part that
/// gets thrown away.
///
/// Rich content arrives through the same `agentx:ui` directive Telegram
/// and WhatsApp already use, parsed server-side, so an agent has one way to
/// attach a link or a picture regardless of where it is speaking.
final class ResultCard: NSPanel {
    // A web view, because agents write markdown — headings, bullets,
    // fenced code, tables. An NSTextView shows that as a mess of asterisks
    // and hashes, which defeats the card's only purpose: being MORE
    // readable than the spoken answer, not less.
    private let web = WKWebView()
    private let links = NSStackView()
    private let thumb = NSImageView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 260),
                   styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        title = "Agent"
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let content = NSView(frame: contentRect(forFrameRect: frame))
        content.autoresizingMask = [.width, .height]

        // Selectable, so the whole point — copying a link or a name out —
        // actually works. Editable would let a stray keystroke destroy the
        // answer before it is read.
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        content.addSubview(web)

        thumb.imageScaling = .scaleProportionallyUpOrDown
        thumb.isHidden = true
        content.addSubview(thumb)

        links.orientation = .horizontal
        links.spacing = 8
        links.edgeInsets = NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)
        content.addSubview(links)

        contentView = content
        layout(content)
    }

    private func layout(_ content: NSView) {
        let w = content.bounds.width, h = content.bounds.height
        let linkH: CGFloat = links.arrangedSubviews.isEmpty ? 0 : 34
        let imgH: CGFloat = thumb.isHidden ? 0 : 120
        thumb.frame = NSRect(x: 10, y: h - imgH - 10, width: w - 20, height: imgH)
        web.frame = NSRect(x: 0, y: linkH, width: w, height: h - linkH - imgH - (imgH > 0 ? 16 : 0))
        links.frame = NSRect(x: 0, y: 0, width: w, height: linkH)
    }

    /// Does this turn have anything the spoken answer did not already
    /// deliver?
    ///
    /// The card opened on every turn, including "Ok." — a window with one
    /// word in it, appearing and demanding dismissal, for an answer you had
    /// already heard. A surface that adds nothing is worse than no surface:
    /// it trains you to ignore it, so the turn where it DOES carry a link
    /// gets ignored too.
    ///
    /// Worth showing when there is rich content, a URL you could click, or
    /// materially more written than was spoken. Otherwise the speech was
    /// the whole answer.
    static func isWorthShowing(spoken: String, written: String?, buttons: [(String, String)], imageURL: String?) -> Bool {
        if !buttons.isEmpty || imageURL != nil { return true }
        let text = (written?.isEmpty == false ? written! : spoken)
        if text.range(of: #"https?://"#, options: .regularExpression) != nil { return true }
        // Speech drops formatting, so written is often a little longer for
        // the same content. Only a real difference counts.
        let spokenLen = spoken.trimmingCharacters(in: .whitespacesAndNewlines).count
        let writtenLen = text.trimmingCharacters(in: .whitespacesAndNewlines).count
        if writtenLen > spokenLen + 80 { return true }
        // Long enough that re-reading it beats re-hearing it.
        return writtenLen > 280
    }

    /// `spoken` is what was said; `written` is the fuller answer with the
    /// URLs and formatting the spoken form had to drop.
    @MainActor
    func show(spoken: String, written: String?, buttons: [(String, String)], imageURL: String?) {
        let source = (written?.isEmpty == false ? written! : spoken)
        web.loadHTMLString(Markdown.page(Markdown.toHTML(source)), baseURL: nil)

        links.arrangedSubviews.forEach { links.removeArrangedSubview($0); $0.removeFromSuperview() }
        for (label, url) in buttons.prefix(4) {
            let b = NSButton(title: label, target: self, action: #selector(openLink(_:)))
            b.bezelStyle = .rounded
            b.toolTip = url
            b.identifier = NSUserInterfaceItemIdentifier(url)
            links.addArrangedSubview(b)
        }

        thumb.isHidden = true
        if let s = imageURL, let u = URL(string: s) {
            // Off the main thread: a slow image must never stall the UI,
            // and the card is useful without it.
            URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
                guard let data, let img = NSImage(data: data) else { return }
                Task { @MainActor in
                    guard let self else { return }
                    self.thumb.image = img
                    self.thumb.isHidden = false
                    if let c = self.contentView { self.layout(c) }
                }
            }.resume()
        }

        if let c = contentView { layout(c) }
        positionAboveWidget()
        orderFrontRegardless()
    }

    @objc private func openLink(_ sender: NSButton) {
        guard let s = sender.identifier?.rawValue, let u = URL(string: s) else { return }
        NSWorkspace.shared.open(u)
    }

    /// Sits just above the pill so the two read as one thing.
    private func positionAboveWidget() {
        guard let screen = NSScreen.main else { return }
        let v = screen.visibleFrame
        setFrameOrigin(NSPoint(x: v.maxX - frame.width - 24, y: v.minY + 24 + 54 + 10))
    }

    override var canBecomeKey: Bool { true }
}

extension ResultCard: WKNavigationDelegate {
    /// Links open in the real browser. A 380-point utility panel is not a
    /// place to read a web page, and navigating away would replace the
    /// answer the card exists to hold.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
