import AppKit
import ApplicationServices

/// Reads the focused application's accessibility tree.
///
/// The tree, not a screenshot, is the primary surface. It gives structured,
/// verifiable elements with real roles and real frames — so a click can be
/// confirmed to have hit the control that was chosen, and the candidate set
/// is ENUMERABLE, which is what lets a decision model pick from it rather
/// than invent coordinates.
///
/// Its honest failure mode is apps that expose nothing: icon-only toolbars,
/// custom-drawn editors, canvas games. For those the tree comes back thin
/// and the caller should say so rather than guess — screenshots are the
/// documented fallback, and are deliberately not in this first cut.
enum AXTree {

    struct Element: Codable {
        let id: Int
        let role: String
        /// Best human-readable name, from whichever attribute has one.
        let label: String
        let value: String?
        let enabled: Bool
        let x: Double, y: Double, width: Double, height: Double
        /// Index of the parent in the same flat array; -1 for the root.
        let parent: Int
    }

    struct Snapshot: Codable {
        let app: String
        let pid: Int32
        let window: String?
        let elements: [Element]
        let truncated: Bool
        let note: String?
    }

    /// Accessibility is TCC-gated and there is no way to ask politely from
    /// a CLI — the prompt only appears for a bundled, signed app. Report it
    /// clearly instead of returning an empty tree that looks like an app
    /// with no controls.
    static func trusted() -> Bool { AXIsProcessTrusted() }

    static func snapshot(maxElements: Int = 400) -> Snapshot {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return Snapshot(app: "unknown", pid: 0, window: nil, elements: [],
                            truncated: false, note: "no frontmost application")
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var elements: [Element] = []
        var truncated = false

        // The focused window, not the whole app: an app's tree includes
        // every window it owns, and pointing at a control in a background
        // window is worse than useless.
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef)
        let root = (windowRef as! AXUIElement?) ?? axApp
        let windowTitle = string(root, kAXTitleAttribute)

        // Traverse everything, but only SPEND the budget on elements worth
        // choosing between.
        //
        // A modern web page is mostly containers: x.com fills 273 of 400
        // slots with unlabelled AXGroups before reaching its search field,
        // so a naive cap returns a tree with no inputs in it and the page
        // looks like it exposes nothing. Skipped nodes still have their
        // children walked; `parent` points at the nearest KEPT ancestor, so
        // the hierarchy stays usable for page-scoping.
        var queue: [(AXUIElement, Int)] = [(root, -1)]
        while !queue.isEmpty {
            if elements.count >= maxElements { truncated = true; break }
            let (node, parent) = queue.removeFirst()

            var keptIndex = parent
            if let e = describe(node, id: elements.count, parent: parent), worthKeeping(e) {
                keptIndex = elements.count
                elements.append(e)
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for c in children { queue.append((c, keptIndex)) }
            }
        }

        return Snapshot(
            app: app.localizedName ?? "unknown",
            pid: app.processIdentifier,
            window: windowTitle,
            elements: elements,
            truncated: truncated,
            note: elements.count < 3
                ? "this app exposes almost no accessibility information — the tree is not usable here"
                : nil)
    }

    /// Containers earn a slot only when they say something.
    ///
    /// The web area itself is always kept — page-scoping needs it as an
    /// anchor even though it carries no label of its own.
    private static func worthKeeping(_ e: Element) -> Bool {
        if e.role == "AXWebArea" { return true }
        let isContainer = e.role == "AXGroup" || e.role == "AXUnknown"
            || e.role == "AXSplitGroup" || e.role == "AXScrollArea"
        if !isContainer { return true }
        // A labelled group is usually a landmark worth naming; "0" and ""
        // are the DOM showing through.
        let label = e.label.trimmingCharacters(in: .whitespaces)
        return label.count > 1 && label != "0"
    }

    private static func describe(_ node: AXUIElement, id: Int, parent: Int) -> Element? {
        guard let role = string(node, kAXRoleAttribute) else { return nil }

        // First attribute that actually names the thing. Title is usually
        // best, but buttons frequently carry only a description, and menu
        // items only a value.
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXLabelValueAttribute,
                     kAXHelpAttribute, kAXPlaceholderValueAttribute]
            .compactMap { string(node, $0) }
            .first(where: { !$0.isEmpty }) ?? ""

        var frame = CGRect.zero
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(node, kAXPositionAttribute as CFString, &posRef) == .success,
           AXUIElementCopyAttributeValue(node, kAXSizeAttribute as CFString, &sizeRef) == .success {
            var p = CGPoint.zero, s = CGSize.zero
            AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
            AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
            frame = CGRect(origin: p, size: s)
        }

        var enabledRef: CFTypeRef?
        AXUIElementCopyAttributeValue(node, kAXEnabledAttribute as CFString, &enabledRef)
        let enabled = (enabledRef as? Bool) ?? true

        // Invisible and zero-sized nodes cannot be pointed at, and there
        // are a great many of them — dropping them keeps the candidate set
        // small enough to hand to a model.
        if frame.width < 1 || frame.height < 1 { return nil }

        return Element(id: id, role: role, label: label,
                       value: string(node, kAXValueAttribute),
                       enabled: enabled,
                       x: frame.origin.x, y: frame.origin.y,
                       width: frame.size.width, height: frame.size.height,
                       parent: parent)
    }

    private static func string(_ node: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, attr as CFString, &ref) == .success else { return nil }
        if let s = ref as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let n = ref as? NSNumber { return n.stringValue }
        return nil
    }
}
