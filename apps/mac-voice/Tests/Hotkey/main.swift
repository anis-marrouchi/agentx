// Tests for the global shortcuts: every key answers, also after they are
// registered again. Run with ../../test.sh.
import AppKit
import Carbon.HIToolbox

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

/// What macOS sends when a registered shortcut is pressed, without a key
/// press: that would need the Accessibility permission.
func press(_ id: UInt32) {
    var event: EventRef?
    CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, 0, &event)
    var key = EventHotKeyID(signature: OSType(0x41475856), id: id)
    SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                      MemoryLayout<EventHotKeyID>.size, &key)
    SendEventToEventTarget(event, GetApplicationEventTarget())
    // The handler hands the press to the main queue.
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}

// The app's order: talk first, an agent's own key last. Chords nobody uses.
let chords: [(UInt32, String, String)] = [
    (1, "talk", "ctrl+opt+shift+cmd+f18"), (2, "paste", "ctrl+opt+shift+cmd+f19"),
    (3, "stop", "ctrl+opt+shift+cmd+f20"), (10, "agent", "ctrl+opt+shift+cmd+f16"),
]
var fired: [String] = []
var keys: [Hotkey] = []
func registerAll() {
    keys.removeAll()
    for (id, what, text) in chords {
        let key = Hotkey(id: id, onPress: { fired.append(what) }, onRelease: {})
        key.register(HotkeySpec(text)!)
        keys.append(key)
    }
}

registerAll()
for (id, _, _) in chords { press(id) }
check(fired == ["talk", "paste", "stop", "agent"], "every shortcut answers, not only the last one registered: \(fired)")

// A settings save registers them all again.
fired = []
registerAll()
for (id, _, _) in chords { press(id) }
check(fired == ["talk", "paste", "stop", "agent"], "and again after they are registered a second time: \(fired)")

fired = []
keys.removeAll()
press(1)
check(fired.isEmpty, "a dropped shortcut is silent")

exit(failures == 0 ? 0 : 1)
