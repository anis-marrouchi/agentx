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
}
