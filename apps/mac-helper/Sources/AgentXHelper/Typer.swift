import AppKit

/// Synthetic typing and key presses.
///
/// This is the first verb here that CHANGES something rather than pointing
/// at it, so it is worth being explicit about what that means: these
/// events are indistinguishable from the keyboard to every application,
/// they go wherever focus happens to be, and nothing downstream can tell
/// them from a person. There is no undo.
///
/// Two consequences are built in rather than left to callers. Typing is
/// paced like a hand, so a field with its own debouncing or autocomplete
/// behaves the way it would for a person instead of receiving a paste-like
/// burst it never sees in production. And `submit` is a separate verb from
/// `type`, so committing a form is always its own deliberate call — never
/// a trailing newline that slipped into some text.
enum Typer {

    /// Type text at human cadence.
    ///
    /// CGEventKeyboardSetUnicodeString rather than keycodes: keycodes are
    /// layout-dependent, so the same call produces different characters on
    /// an AZERTY machine, and this host is French.
    static func type(_ text: String, wpm: Double = 260) {
        // A character every ~46ms at 260wpm — brisk but visibly typed, so
        // someone watching a lesson can read along.
        let base = 60.0 / (wpm * 5.0)
        let source = CGEventSource(stateID: .combinedSessionState)

        for ch in text {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { continue }
            var utf16 = Array(String(ch).utf16)
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)

            // Jitter, and a longer pause after a space — real typing is
            // bursty at word boundaries, and a metronome is the tell.
            var delay = base * Double.random(in: 0.65...1.45)
            if ch == " " { delay += base * 0.9 }
            Thread.sleep(forTimeInterval: delay)
        }
    }

    /// Named keys, for the things typing cannot express.
    private static let keyCodes: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49,
        "delete": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    static func press(_ name: String) -> Bool {
        guard let code = keyCodes[name.lowercased()] else { return false }
        let source = CGEventSource(stateID: .combinedSessionState)
        CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.035)
        CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
        return true
    }

    /// Modifier names accepted by `key` and the click verbs.
    static let modifierFlags: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand,
        "shift": .maskShift,
        "opt": .maskAlternate, "option": .maskAlternate, "alt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
        "fn": .maskSecondaryFn,
    ]

    static func flags(from names: [String]) -> CGEventFlags {
        var f = CGEventFlags()
        for n in names { if let m = modifierFlags[n.lowercased()] { f.insert(m) } }
        return f
    }

    /// Press a named key with optional modifiers, e.g. cmd+a.
    static func press(_ name: String, modifiers: [String] = []) -> Bool {
        guard let code = keyCodes[name.lowercased()] ?? letterCode(name) else { return false }
        let source = CGEventSource(stateID: .combinedSessionState)
        let mods = flags(from: modifiers)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = mods
        up?.flags = mods
        down?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.035)
        up?.post(tap: .cghidEventTap)
        return true
    }

    /// Single letters, digits, comma and period, so `key --name a --mod cmd` works.
    private static func letterCode(_ name: String) -> CGKeyCode? {
        let map: [Character: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
            "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
            ",": 43, ".": 47,
        ]
        guard name.count == 1, let ch = name.lowercased().first else { return nil }
        return map[ch]
    }

    // MARK: Mouse

    /// Click where the cursor already is.
    ///
    /// Separate from `point` on purpose: point is safe to run against
    /// anything, and keeping the click a distinct call means nothing
    /// clicks merely because it was located.
    static func click(button: String = "left", clicks: Int = 1, modifiers: [String] = []) {
        let p = CGEvent(source: nil)?.location ?? .zero
        let source = CGEventSource(stateID: .combinedSessionState)
        let right = button.lowercased() == "right"
        let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
        let mouseButton: CGMouseButton = right ? .right : .left
        let mods = flags(from: modifiers)

        for i in 1...max(1, clicks) {
            let down = CGEvent(mouseEventSource: source, mouseType: downType,
                               mouseCursorPosition: p, mouseButton: mouseButton)
            let up = CGEvent(mouseEventSource: source, mouseType: upType,
                             mouseCursorPosition: p, mouseButton: mouseButton)
            // clickState is what makes the OS read two clicks as a
            // double-click rather than two separate ones.
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            down?.flags = mods
            up?.flags = mods
            down?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: Double.random(in: 0.05...0.09))
            up?.post(tap: .cghidEventTap)
            // Inside the system double-click interval, or the second click
            // starts a new sequence.
            if i < clicks { Thread.sleep(forTimeInterval: 0.08) }
        }
    }

    /// Scroll by wheel units at the cursor. Negative dy scrolls down.
    static func scroll(dx: Int32 = 0, dy: Int32 = 0, steps: Int = 10) {
        let source = CGEventSource(stateID: .combinedSessionState)
        // Broken into steps with easing: one large wheel event jumps, and
        // momentum-scrolling views ignore it entirely.
        let n = max(1, steps)
        for i in 1...n {
            let t = Double(i) / Double(n)
            let ease = 1 - pow(1 - t, 2)
            let prev = Double(i - 1) / Double(n)
            let prevEase = 1 - pow(1 - prev, 2)
            let stepY = Int32((Double(dy) * (ease - prevEase)).rounded())
            let stepX = Int32((Double(dx) * (ease - prevEase)).rounded())
            if stepX == 0 && stepY == 0 { continue }
            CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                    wheelCount: 2, wheel1: stepY, wheel2: stepX, wheel3: 0)?
                .post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.016)
        }
    }

    /// Press at the current point, move, release. Used for sliders,
    /// reordering and selection.
    static func drag(to target: CGPoint, durationSeconds: Double = 0.6) {
        let from = CGEvent(source: nil)?.location ?? target
        let source = CGEventSource(stateID: .combinedSessionState)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.06)

        let steps = max(12, Int(durationSeconds * 90))
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let e = 10 * pow(t, 3) - 15 * pow(t, 4) + 6 * pow(t, 5)
            let p = CGPoint(x: from.x + (target.x - from.x) * e,
                            y: from.y + (target.y - from.y) * e)
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
                    mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: durationSeconds / Double(steps))
        }
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
}
