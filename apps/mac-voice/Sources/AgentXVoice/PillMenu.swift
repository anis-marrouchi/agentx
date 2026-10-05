/// "Show floating pill" in the menu.
///
/// Closing the pill hides it without turning the setting off, so the
/// setting alone said "checked" over an empty screen, and the first click
/// only turned it off. The checkmark follows what is on screen instead,
/// and a click on an unchecked item always brings the pill back.
enum PillMenu {
    static func isChecked(showPill: Bool, visible: Bool) -> Bool {
        showPill && visible
    }

    /// The setting after a click.
    static func click(showPill: Bool, visible: Bool) -> Bool {
        !isChecked(showPill: showPill, visible: visible)
    }

    /// The item that reduces the pill, or brings the full one back: to its
    /// orb, or with the character (which stands in for the orb) to the
    /// character alone, without its speech bubble. The title follows what
    /// is on screen, so a pill open for a while over the chosen orb still
    /// offers to reduce.
    static func reduceTitle(reduced: Bool, character: Bool = false) -> String {
        if character { return reduced ? "Show speech bubble" : "Reduce to character" }
        return reduced ? "Show full pill" : "Reduce to orb"
    }
}
