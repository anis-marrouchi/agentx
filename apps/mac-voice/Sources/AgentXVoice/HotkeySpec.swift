import Carbon.HIToolbox

/// A shortcut as agentx.json stores it: "opt+space", "cmd+opt+period",
/// "ctrl+opt+1". The daemon checks and normalises the same form
/// (src/voice/hotkey.ts); this turns it into what Carbon registers, and a
/// pressed key back into it.
struct HotkeySpec: Equatable {
    let keyCode: UInt32
    /// Carbon modifier flags (cmdKey, optionKey, …).
    let modifiers: UInt32

    static let keys: [String: Int] = {
        var k: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
            "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
            "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
            "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
            "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space, "period": kVK_ANSI_Period, "comma": kVK_ANSI_Comma,
            "slash": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote,
            "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal,
            "leftbracket": kVK_ANSI_LeftBracket, "rightbracket": kVK_ANSI_RightBracket,
            "backslash": kVK_ANSI_Backslash, "grave": kVK_ANSI_Grave,
            "return": kVK_Return, "tab": kVK_Tab,
        ]
        let f = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                 kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
        for (i, code) in f.enumerated() { k["f\(i + 1)"] = code }
        return k
    }()

    private static let modifierFlags: [(String, UInt32)] = [
        ("ctrl", UInt32(controlKey)), ("opt", UInt32(optionKey)),
        ("shift", UInt32(shiftKey)), ("cmd", UInt32(cmdKey)),
    ]
    private static let aliases = ["control": "ctrl", "option": "opt", "alt": "opt", "command": "cmd"]

    /// Nil for anything the daemon would refuse.
    init?(_ text: String) {
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard let key = parts.last, let code = Self.keys[key] else { return nil }
        var mods: UInt32 = 0
        for p in parts.dropLast() {
            let name = Self.aliases[p] ?? p
            guard let flag = Self.modifierFlags.first(where: { $0.0 == name })?.1, mods & flag == 0 else { return nil }
            mods |= flag
        }
        let isF = key.hasPrefix("f") && key.count > 1
        guard isF || mods & UInt32(controlKey | optionKey | cmdKey) != 0 else { return nil }
        keyCode = UInt32(code)
        modifiers = mods
    }

    init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// The stored form, modifiers in the Mac's order.
    var text: String? {
        guard let key = Self.keys.first(where: { UInt32($0.value) == keyCode })?.key else { return nil }
        let mods = Self.modifierFlags.filter { modifiers & $0.1 != 0 }.map(\.0)
        return (mods + [key]).joined(separator: "+")
    }

    /// "⌃⌥1", as menus show shortcuts.
    static func display(_ text: String) -> String {
        let symbols = ["ctrl": "⌃", "opt": "⌥", "shift": "⇧", "cmd": "⌘"]
        let names = ["space": "Space", "period": ".", "comma": ",", "slash": "/", "semicolon": ";",
                     "quote": "'", "minus": "-", "equal": "=", "leftbracket": "[", "rightbracket": "]",
                     "backslash": "\\", "grave": "`", "return": "Return", "tab": "Tab"]
        var parts = text.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.popLast() else { return text }
        return parts.map { symbols[Self.aliases[$0] ?? $0] ?? $0 }.joined() + (names[key] ?? key.uppercased())
    }
}
