import AppKit
import Carbon.HIToolbox

/// Global push-to-talk hotkey, default ⌥Space.
///
/// Carbon's RegisterEventHotKey rather than an NSEvent global monitor,
/// because the monitor route requires Accessibility permission and this
/// slice should need nothing but the microphone. Carbon also reports key
/// RELEASE, which is what makes hold-to-talk possible at all.
///
/// ⌥Space and not ⌃Space: control-space is bound to input-source switching
/// on many Macs, and silently stealing it is a bad first impression.
final class Hotkey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let onPress: () -> Void
    private let onRelease: () -> Void

    init(onPress: @escaping () -> Void, onRelease: @escaping () -> Void) {
        self.onPress = onPress
        self.onRelease = onRelease
    }

    func register(keyCode: UInt32 = UInt32(kVK_Space), modifiers: UInt32 = UInt32(optionKey)) {
        var spec = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, ctx in
            guard let ctx, let event else { return noErr }
            let me = Unmanaged<Hotkey>.fromOpaque(ctx).takeUnretainedValue()
            let kind = GetEventKind(event)
            DispatchQueue.main.async {
                if kind == UInt32(kEventHotKeyPressed) { me.onPress() } else { me.onRelease() }
            }
            return noErr
        }, spec.count, &spec, context, &handler)

        var id = EventHotKeyID(signature: OSType(0x41475856), id: 1) // 'AGXV'
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
        _ = id
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
