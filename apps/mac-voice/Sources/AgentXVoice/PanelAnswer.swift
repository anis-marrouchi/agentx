import AppKit

/// The pill growing into its answer, and collapsing back.
///
/// One surface, not a second window: the row with the orb stays where it
/// is and the widget grows up or down from it, whichever has more room.
/// It collapses on close or Esc, or `cardTimeout` seconds after the answer
/// has been spoken, and never while the pointer is over it.
extension Panel {
    /// A gentle spring: a little past the target, then back. Reduce Motion
    /// skips the animation entirely.
    private static let spring = CAMediaTimingFunction(controlPoints: 0.3, 1.12, 0.5, 1)

    /// Show an answer. The pill grows once it has been measured. A pill
    /// the person dismissed stays dismissed.
    @MainActor
    func showAnswer(spoken: String, written: String?, buttons: [(String, String)], imageURL: String?) {
        guard !dismissed else { return }
        answer.show(spoken: spoken, written: written, buttons: buttons, imageURL: imageURL)
    }

    /// Grow, or resize while grown, to fit an answer `answerHeight` tall.
    @MainActor
    func grow(answerHeight: CGFloat) {
        guard !dismissed else { return }
        // An answer to read, or one that asks: the full pill opens for it,
        // and goes back to the reduced form once it has gone.
        open()
        shrink(0)
        let pill = collapsedFrame()
        guard let visible = bubble?.visible ?? visibleFrame(for: pill) else { return }
        let size = CGSize(width: Self.expandedWidth, height: min(Self.size.height + min(answerHeight, cardMaxHeight), visible.height))
        // The character's bubble opens above it, or beside it: never over it.
        let spot = bubble.map {
            PillPlacement.Expanded(frame: CGRect(origin: PillPlacement.bubble(size: size, head: $0.head, visible: visible), size: size),
                                   above: true, alignRight: true)
        } ?? PillPlacement.expanded(size: size, pill: pill, visible: visible)
        if !expanded {
            growth = (spot.above, spot.alignRight)
            expanded = true
            // Lay the row on its edge before the first frame, so it does
            // not jump when the growth starts.
            if let content = contentView { layoutContent(content.bounds) }
        }
        separator.isHidden = false
        show()
        animate(to: spot.frame)
        armCollapse()
    }

    /// Back to the pill alone, where it was.
    @MainActor
    func collapse(animated: Bool = true) {
        collapseTimer?.invalidate()
        collapseTimer = nil
        guard expanded else { return }
        var pill = collapsedFrame()
        if let bubble {
            pill.origin = PillPlacement.bubble(size: Self.size, head: bubble.head, visible: bubble.visible)
        } else if let visible = visibleFrame(for: pill) {
            pill = PillPlacement.inside(pill, visible)
        }
        expanded = false
        animate(to: pill, animated: animated) { [weak self] in
            guard let self, !self.expanded else { return }
            self.separator.isHidden = true
            self.answer.clear()
            // Idle and not kept on screen: it goes, now the answer has.
            self.render(self.current)
        }
    }

    /// Where the pill is, or will be once collapsed.
    @MainActor
    func collapsedFrame() -> NSRect {
        guard expanded else { return frame }
        return PillPlacement.collapsed(from: frame, size: Self.size, above: growth.above, alignRight: growth.alignRight)
    }

    /// Start the countdown to collapse, when the answer has been spoken
    /// and nobody is reading it. Anything else cancels it.
    @MainActor
    func armCollapse() {
        collapseTimer?.invalidate()
        collapseTimer = nil
        guard expanded, cardTimeout > 0, !hovering, current.orbPhase == .idle else { return }
        collapseTimer = Timer.scheduledTimer(withTimeInterval: cardTimeout, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.collapse() }
        }
    }

    /// The visible frame of the screen `rect` overlaps most.
    @MainActor
    private func visibleFrame(for rect: NSRect) -> NSRect? {
        let best = NSScreen.screens.max { a, b in
            let x = a.frame.intersection(rect), y = b.frame.intersection(rect)
            return (x.isNull ? 0 : x.width * x.height) < (y.isNull ? 0 : y.width * y.height)
        }
        return (best ?? NSScreen.main)?.visibleFrame
    }

    @MainActor
    private func animate(to target: NSRect, animated: Bool = true, then done: (() -> Void)? = nil) {
        placing += 1
        let finish = { [weak self] in
            guard let self else { return }
            self.placing -= 1
            self.invalidateShadow()
            done?()
        }
        if !animated || !isVisible || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            setFrame(target, display: true)
            finish()
            return
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.34
            ctx.timingFunction = Self.spring
            animator().setFrame(target, display: true)
        }, completionHandler: {
            MainActor.assumeIsolated { finish() }
        })
    }
}
