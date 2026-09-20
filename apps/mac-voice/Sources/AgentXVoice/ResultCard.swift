import AppKit

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
    private let scroll = NSScrollView()
    private let body = NSTextView()
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
        body.isEditable = false
        body.isSelectable = true
        body.drawsBackground = false
        body.font = .systemFont(ofSize: 13)
        body.textContainerInset = NSSize(width: 10, height: 10)
        body.isAutomaticLinkDetectionEnabled = true
        body.isRichText = true

        // An NSTextView used as a documentView renders NOTHING until it is
        // given a size and told how to grow. Defaults are a zero frame and
        // a fixed-width container, so the card came up blank however much
        // text it held — which looked like "no answer" rather than a
        // layout bug, and is why it read as an empty window.
        body.frame = NSRect(x: 0, y: 0, width: 360, height: 100)
        body.minSize = NSSize(width: 0, height: 0)
        body.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        body.isVerticallyResizable = true
        body.isHorizontallyResizable = false
        body.autoresizingMask = [.width]
        body.textContainer?.widthTracksTextView = true
        body.textContainer?.containerSize = NSSize(width: 360, height: CGFloat.greatestFiniteMagnitude)

        scroll.documentView = body
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autoresizingMask = [.width, .height]
        content.addSubview(scroll)

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
        scroll.frame = NSRect(x: 0, y: linkH, width: w, height: h - linkH - imgH - (imgH > 0 ? 16 : 0))
        // Container width must follow the scroll view or the text lays out
        // against a stale width and clips.
        body.textContainer?.containerSize = NSSize(width: w - 4, height: CGFloat.greatestFiniteMagnitude)
        body.frame.size.width = w - 4
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
        body.string = (written?.isEmpty == false ? written! : spoken)

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
