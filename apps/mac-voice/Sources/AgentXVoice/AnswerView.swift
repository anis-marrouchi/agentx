import AppKit
import WebKit

/// What the agent said, in a form you can read, select and copy, inside
/// the pill.
///
/// Speech is lossy in one specific way that matters: a URL cannot be
/// spoken usefully, an image cannot be spoken at all, and a name you have
/// not seen written is a name you cannot act on. The spoken answer is
/// deliberately short and stripped of exactly those things, so without a
/// visual surface everything worth keeping from a turn is the part that
/// gets thrown away.
///
/// Rich content arrives through the same `agentx:ui` directive Telegram
/// and WhatsApp already use, parsed server-side, so an agent has one way to
/// attach a link or a picture regardless of where it is speaking.
final class AnswerView: NSView {
    // A web view, because agents write markdown: headings, bullets, fenced
    // code, tables. An NSTextView shows that as a mess of asterisks and
    // hashes, which defeats the answer's only purpose: being MORE readable
    // than the spoken answer, not less. Text in it is selectable, and it
    // scrolls once the answer is taller than the pill lets it grow.
    private let web = WKWebView()
    private let links = NSStackView()
    private let thumb = NSImageView()
    private let actions = NSStackView()
    private var source = ""

    /// The answer's natural height, measured after it renders. The pill
    /// grows to it, up to its maximum.
    var onHeight: ((CGFloat) -> Void)?
    /// "Open in chat". Set by the app.
    var onOpenChat: (() -> Void)?
    /// "Listen again" (#492): say the answer again, or stop saying it.
    /// Set by the app, which owns the speaking.
    var onListenAgain: (() -> Void)?
    private var listenButton: NSButton?

    private static let linkRow: CGFloat = 34
    private static let imageHeight: CGFloat = 120

    override init(frame: NSRect) {
        super.init(frame: frame)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        addSubview(web)

        thumb.imageScaling = .scaleProportionallyUpOrDown
        thumb.isHidden = true
        addSubview(thumb)

        links.orientation = .horizontal
        links.spacing = 8
        links.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 8, right: 12)
        addSubview(links)

        // Listen again, Copy and Open in chat, shown while the pointer is
        // over the answer.
        actions.orientation = .horizontal
        actions.spacing = 2
        let idle = ListenAgain.look(replaying: false)
        let listen = actionButton(idle.symbol, idle.label, #selector(listenAgain))
        listenButton = listen
        actions.addArrangedSubview(listen)
        actions.addArrangedSubview(actionButton("doc.on.doc", "Copy the answer", #selector(copyAnswer)))
        actions.addArrangedSubview(actionButton("bubble.left.and.bubble.right", "Open in chat", #selector(openChat)))
        actions.isHidden = true
        actions.edgeInsets = NSEdgeInsets(top: 1, left: 3, bottom: 1, right: 3)
        // A backing of its own, so the buttons read over the text below.
        actions.wantsLayer = true
        actions.layer?.cornerRadius = 7
        actions.layer?.cornerCurve = .continuous
        addSubview(actions)

        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private func actionButton(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
        let b = NSButton()
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.imagePosition = .imageOnly
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        b.contentTintColor = .secondaryLabelColor
        b.toolTip = label
        b.setAccessibilityLabel(label)
        b.target = self
        b.action = action
        b.widthAnchor.constraint(equalToConstant: 24).isActive = true
        b.heightAnchor.constraint(equalToConstant: 22).isActive = true
        return b
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        let w = bounds.width, h = bounds.height
        let linkH: CGFloat = links.arrangedSubviews.isEmpty ? 0 : Self.linkRow
        let imgH: CGFloat = thumb.isHidden ? 0 : Self.imageHeight
        thumb.frame = NSRect(x: 12, y: h - imgH - 10, width: w - 24, height: imgH)
        web.frame = NSRect(x: 0, y: linkH, width: w, height: max(0, h - linkH - imgH - (imgH > 0 ? 16 : 0)))
        links.frame = NSRect(x: 0, y: 0, width: w, height: linkH)
        // Three 24-point buttons, 2 apart, with 3 points each side.
        actions.frame = NSRect(x: w - 90, y: h - 32, width: 82, height: 26)
    }

    /// Does this turn have anything the spoken answer did not already
    /// deliver?
    ///
    /// Opening on every turn, including "Ok.", shows one word you have
    /// already heard. A surface that adds nothing trains you to ignore it,
    /// so the turn where it DOES carry a link gets ignored too.
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
    /// URLs and formatting the spoken form had to drop. `onHeight` follows
    /// once it has rendered.
    @MainActor
    func show(spoken: String, written: String?, buttons: [(String, String)], imageURL: String?) {
        source = (written?.isEmpty == false ? written! : spoken)
        web.loadHTMLString(Markdown.page(Markdown.toHTML(source), css: Brand.cardCSS), baseURL: nil)

        links.arrangedSubviews.forEach { links.removeArrangedSubview($0); $0.removeFromSuperview() }
        for (label, url) in buttons.prefix(4) {
            let b = NSButton(title: label, target: self, action: #selector(openLink(_:)))
            b.bezelStyle = .push
            b.controlSize = .small
            b.toolTip = url
            b.identifier = NSUserInterfaceItemIdentifier(url)
            links.addArrangedSubview(b)
        }

        thumb.isHidden = true
        thumb.image = nil
        if let s = imageURL, let u = URL(string: s) {
            // Off the main thread: a slow image must never stall the UI,
            // and the answer is useful without it.
            URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
                guard let data, let img = NSImage(data: data) else { return }
                Task { @MainActor in
                    guard let self, self.source.isEmpty == false else { return }
                    self.thumb.image = img
                    self.thumb.isHidden = false
                    self.measure()
                }
            }.resume()
        }
        resizeSubviews(withOldSize: bounds.size)
    }

    /// Empty again, once the pill has collapsed.
    @MainActor
    func clear() {
        source = ""
        web.loadHTMLString("", baseURL: nil)
        thumb.isHidden = true
        links.arrangedSubviews.forEach { links.removeArrangedSubview($0); $0.removeFromSuperview() }
    }

    /// The rendered text's height plus the image and links around it.
    @MainActor
    private func measure() {
        let js = "(() => { const b = document.body, s = getComputedStyle(b);"
            + " return b.scrollHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom) })()"
        web.evaluateJavaScript(js) { [weak self] value, _ in
            MainActor.assumeIsolated {
                guard let self, !self.source.isEmpty else { return }
                let text = CGFloat((value as? NSNumber)?.doubleValue ?? 120)
                let extra = (self.links.arrangedSubviews.isEmpty ? 0 : Self.linkRow)
                    + (self.thumb.isHidden ? 0 : Self.imageHeight + 16)
                self.resizeSubviews(withOldSize: self.bounds.size)
                self.onHeight?(ceil(text + extra))
            }
        }
    }

    override func mouseEntered(with event: NSEvent) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            actions.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            actions.layer?.borderColor = NSColor.separatorColor.cgColor
            actions.layer?.borderWidth = 1 / (window?.backingScaleFactor ?? 2)
        }
        actions.isHidden = source.isEmpty
    }
    override func mouseExited(with event: NSEvent) { actions.isHidden = true }

    @objc private func copyAnswer() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(source, forType: .string)
    }

    @objc private func openChat() { onOpenChat?() }

    @objc private func listenAgain() { onListenAgain?() }

    /// The speaker while the answer is being said again: a stop button,
    /// so a second click stops it.
    func setReplaying(_ on: Bool) {
        guard let b = listenButton else { return }
        let look = ListenAgain.look(replaying: on)
        b.image = NSImage(systemSymbolName: look.symbol, accessibilityDescription: look.label)
        b.toolTip = look.label
        b.setAccessibilityLabel(look.label)
    }

    /// Select-and-⌘C: the pill has no Edit menu to route the shortcut.
    func copySelection() { NSApp.sendAction(#selector(NSText.copy(_:)), to: web, from: nil) }

    @objc private func openLink(_ sender: NSButton) {
        guard let s = sender.identifier?.rawValue, let u = URL(string: s) else { return }
        NSWorkspace.shared.open(u)
    }
}

extension AnswerView: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { if !source.isEmpty { measure() } }
    }

    /// Links open in the real browser. A pill is not a place to read a web
    /// page, and navigating away would replace the answer it exists to hold.
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
