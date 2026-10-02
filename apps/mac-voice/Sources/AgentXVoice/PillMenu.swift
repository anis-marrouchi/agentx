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

    /// The item that reduces the pill to its orb, or brings the pill back.
    static func reduceTitle(reduced: Bool) -> String {
        reduced ? "Show full pill" : "Reduce to orb"
    }

    /// Only a pill that has its orb can be reduced to it: while the
    /// character stands in for the orb, there is nothing to reduce to.
    static func canReduce(showsOrb: Bool) -> Bool { showsOrb }
}
