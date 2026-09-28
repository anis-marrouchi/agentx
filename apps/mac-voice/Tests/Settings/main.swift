// Tests for the settings window's data: shortcuts and the saved patch. Run with ../../test.sh.
import Carbon.HIToolbox
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

// --- Shortcuts: the same form the daemon stores ---

let talk = HotkeySpec("opt+space")
check(talk == HotkeySpec(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)), "opt+space is ⌥Space")
check(HotkeySpec("Command+Option+Period")?.text == "opt+cmd+period", "long names and any order normalise")
check(HotkeySpec("ctrl+opt+1")?.keyCode == UInt32(kVK_ANSI_1), "digits map to their key")
check(HotkeySpec("f5") != nil && HotkeySpec("F12")?.keyCode == UInt32(kVK_F12), "function keys need no modifier")
check(HotkeySpec("a") == nil && HotkeySpec("shift+a") == nil, "a shortcut that would eat typing is refused")
check(HotkeySpec("opt+opt+a") == nil && HotkeySpec("hyper+a") == nil && HotkeySpec("opt+") == nil, "malformed shortcuts are refused")
let pressed = HotkeySpec(keyCode: UInt32(kVK_ANSI_2), modifiers: UInt32(controlKey | cmdKey))
check(pressed.text == "ctrl+cmd+2", "a pressed key becomes the stored form")
check(HotkeySpec(pressed.text!) == pressed, "and reads back as the same key")
check(HotkeySpec.display("ctrl+opt+1") == "⌃⌥1" && HotkeySpec.display("opt+cmd+period") == "⌥⌘.", "shown as menus show them")

// --- The patch sent on Save ---

let json = """
{"general":{"provider":"system","fallback":"system","stt":"auto","hotkeys":{"talk":"opt+space","stop":"cmd+opt+period","paste":"cmd+opt+v"}},
 "agents":[
  {"id":"writer","name":"Writer","color":"#0D9488","colorSet":false,
   "voice":{"system":"Ava","systemPerLanguage":false,"narrate":"on"},"speaks":{"provider":"system","systemVoice":"Ava en-US"}},
  {"id":"researcher","name":"Researcher","color":"#123456","colorSet":true,
   "voice":{"systemPerLanguage":true,"rate":1.2},"speaks":{"provider":"system","systemVoice":null}}],
 "systemVoices":[{"id":"v1","label":"Ava en-US","locale":"en-US"}],"menuHotkey":"cmd+opt+a"}
"""
let saved = try! JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8))
check(saved.patch(from: saved).isEmpty, "no change, nothing to send")

var draft = saved
draft.general.stt = "local"
draft.general.hotkeys.talk = "ctrl+space"
draft.agents[0].voice.system = nil
draft.agents[0].voice.rate = 1.1
draft.agents[0].voice.hotkey = "ctrl+opt+1"
draft.agents[0].color = "#FF0000"
draft.agents[0].colorSet = true
draft.agents[1].colorSet = false
let patch = draft.patch(from: saved)
let general = patch["general"] as? [String: Any]
check(general?["stt"] as? String == "local" && (general?["hotkeys"] as? [String: Any])?["talk"] as? String == "ctrl+space"
      && general?["provider"] == nil, "general sends only what changed")
let agents = patch["agents"] as? [String: [String: Any]]
let writer = agents?["writer"]
check(writer?["system"] is NSNull, "a field put back to its default is sent as null")
check(writer?["rate"] as? Double == 1.1 && writer?["hotkey"] as? String == "ctrl+opt+1" && writer?["color"] as? String == "#FF0000",
      "changed agent fields are sent")
check(writer?["narrate"] == nil, "unchanged agent fields are not")
check(agents?["researcher"]?["color"] is NSNull && agents?["researcher"]?.count == 1, "Use default clears the colour")

let preview = saved.previewVoice(for: "researcher")
check(preview["system"] == nil && preview["rate"] as? Double == 1.2, "a preview leaves a per-language voice alone")
check(saved.previewVoice(for: "writer")["system"] as? String == "Ava", "and sends a single voice")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
