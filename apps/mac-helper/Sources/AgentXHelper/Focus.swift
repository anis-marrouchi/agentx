import AppKit
import ApplicationServices

/// What currently has keyboard focus.
///
/// This exists because of a near miss. A lesson located "the search box",
/// clicked it, and typed. The click landed on a navigation LINK rather
/// than an input, the page changed underneath, focus ended up somewhere
/// else entirely, and the next step pressed Return. On a social site the
/// thing that had focus could have been the compose box — so a search
/// query was one keystroke from being published.
///
/// Synthetic typing goes wherever focus is. It cannot tell a search field
/// from a post composer from a terminal. So the caller has to look first,
/// and that means a way to ask.
enum Focus {

    struct Focused: Codable {
        let role: String
        let label: String
        let value: String?
        /// True when this can accept typing at all.
        let editable: Bool
        /// True when typing here plausibly PUBLISHES something. Heuristic
        /// and deliberately over-inclusive: the cost of a false alarm is a
        /// refused step, and the cost of a miss is a public post.
        let publishRisk: Bool
        let app: String
    }

    /// Roles that accept text.
    private static let editableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    ]

    /// Words that suggest the field posts, sends or publishes. Checked
    /// against the label, the placeholder and the nearest container — in
    /// several languages, because the UI under test is not always English.
    private static let publishWords = [
        "post", "tweet", "compose", "reply", "publish", "send", "message",
        "comment", "status", "quoi de neuf", "publier", "répondre", "envoyer",
        "tweeter", "message", "commentaire",
    ]

    static func current() -> Focused? {
        // Ask the frontmost application directly, the way AXTree does.
        //
        // Going through the system-wide element's focused-application
        // attribute returned nothing here even with a text field focused,
        // and a focus check that always fails is a gate that blocks
        // everything — safe, and useless. Force-casting a CFTypeRef that
        // came back nil also silently yields nil rather than an error,
        // which is how this hid.
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)

        var elementRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &elementRef) == .success,
              CFGetTypeID(elementRef) == AXUIElementGetTypeID()
        else { return nil }
        let element = unsafeBitCast(elementRef, to: AXUIElement.self)

        let role = string(element, kAXRoleAttribute) ?? ""
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute]
            .compactMap { string(element, $0) }
            .first(where: { !$0.isEmpty }) ?? ""
        let value = string(element, kAXValueAttribute)

        // Also consider the enclosing container: a composer's textbox is
        // often unlabelled while its parent says "Post".
        var context = "\(label) \(string(element, kAXRoleDescriptionAttribute) ?? "")"
        var parentRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success,
           let parent = parentRef as! AXUIElement? {
            context += " " + ([kAXTitleAttribute, kAXDescriptionAttribute]
                .compactMap { string(parent, $0) }.joined(separator: " "))
        }
        let haystack = context.lowercased()
        let risky = publishWords.contains { haystack.contains($0) }

        return Focused(
            role: role,
            label: label,
            value: value,
            editable: editableRoles.contains(role)
                || (string(element, kAXRoleDescriptionAttribute)?.lowercased().contains("text") ?? false),
            publishRisk: risky,
            app: app.localizedName ?? "unknown")
    }

    private static func string(_ node: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, attr as CFString, &ref) == .success else { return nil }
        if let s = ref as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        return nil
    }
}
