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

check(saved.general.localStt == "mlx-whisper" && saved.general.endOfTurn == "vad",
      "a daemon that sends no engine or end-of-turn gets the defaults")
var engine = saved
engine.general.localStt = "parakeet"
engine.general.endOfTurn = "volume"
let enginePatch = engine.patch(from: saved)["general"] as? [String: Any]
check(enginePatch?["localStt"] as? String == "parakeet" && enginePatch?["endOfTurn"] as? String == "volume"
      && enginePatch?.count == 2, "the local engine and the end of a turn are sent when changed")

let preview = saved.previewVoice(for: "researcher")
check(preview["system"] == nil && preview["rate"] as? Double == 1.2, "a preview leaves a per-language voice alone")
check(saved.previewVoice(for: "writer")["system"] as? String == "Ava", "and sends a single voice")

// --- Palettes and the answer card (#211) ---

check(saved.general.startReduced == nil && saved.general.look == nil && saved.general.card == nil && saved.palettes == nil && saved.agents[0].palette == nil,
      "a daemon without palettes or card settings still decodes")

let newer = """
{"general":{"provider":"system","fallback":"system","stt":"auto","hotkeys":{"talk":"opt+space","stop":"cmd+opt+period","paste":"cmd+opt+v"},
  "card":{"timeout":30,"maxHeight":320}},
 "agents":[{"id":"writer","name":"Writer","color":"#0D9488","colorSet":false,"paletteDefault":"lagoon",
   "voice":{"systemPerLanguage":false},"speaks":{"provider":"system","systemVoice":null}},
  {"id":"researcher","name":"Researcher","color":"#123456","colorSet":true,"palette":"forest","paletteDefault":"ocean",
   "voice":{"systemPerLanguage":false},"speaks":{"provider":"system","systemVoice":null}}],
 "systemVoices":[],"palettes":[{"id":"lagoon","label":"Lagoon","colors":["#0B6E73","#0E9594","#1FBFB2","#56DCCB","#B8F4EA"]}],
 "menuHotkey":"cmd+opt+a"}
"""
let current = try! JSONDecoder().decode(VoiceSettings.self, from: Data(newer.utf8))
check(current.general.card == VoiceSettings.Card(timeout: 30, maxHeight: 320) && current.palettes?.first?.colors.count == 5,
      "card settings and palettes decode")
var edit = current
edit.agents[0].palette = "dusk"
edit.agents[1].palette = nil
edit.general.card?.timeout = 0
let p2 = edit.patch(from: current)
let a2 = p2["agents"] as? [String: [String: Any]]
check(a2?["writer"]?["palette"] as? String == "dusk", "a picked palette is sent")
check(a2?["researcher"]?["palette"] is NSNull, "back to the colour's palette sends null")
let card2 = (p2["general"] as? [String: Any])?["card"] as? [String: Any]
check(card2?["timeout"] as? Double == 0 && card2?["maxHeight"] == nil, "only the changed card setting is sent")

// --- Start reduced (#457) ---

check(current.general.startReduced == nil && current.patch(from: current)["general"] == nil,
      "a daemon older than the reduced pill sends no start setting, and none is sent back")
let withStart = try! JSONDecoder().decode(VoiceSettings.self, from: Data(newer.replacingOccurrences(
    of: "\"card\":{\"timeout\":30,\"maxHeight\":320}", with: "\"card\":{\"timeout\":30,\"maxHeight\":320},\"startReduced\":false").utf8))
check(withStart.general.startReduced == false, "the start setting decodes")
var startsSmall = withStart
startsSmall.general.startReduced = true
let startPatch = startsSmall.patch(from: withStart)["general"] as? [String: Any]
check(startPatch?["startReduced"] as? Bool == true && startPatch?.count == 1, "only the start setting is sent when it changes")

// --- The character's stroll when idle (#482) ---

check(withStart.general.stroll == nil && withStart.patch(from: withStart)["general"] == nil,
      "a daemon older than the stroll sends no stroll setting, and none is sent back")
let withStroll = try! JSONDecoder().decode(VoiceSettings.self, from: Data(newer.replacingOccurrences(
    of: "\"card\":{\"timeout\":30,\"maxHeight\":320}", with: "\"card\":{\"timeout\":30,\"maxHeight\":320},\"stroll\":false").utf8))
check(withStroll.general.stroll == false, "the stroll setting decodes")
var strollsNow = withStroll
strollsNow.general.stroll = true
let strollPatch = strollsNow.patch(from: withStroll)["general"] as? [String: Any]
check(strollPatch?["stroll"] as? Bool == true && strollPatch?.count == 1, "only the stroll setting is sent when it changes")

// --- The character's small animations when idle (#571) ---

check(withStroll.general.animations == nil && withStroll.patch(from: withStroll)["general"] == nil,
      "a daemon older than the animations sends no such setting, and none is sent back")
let withPlay = try! JSONDecoder().decode(VoiceSettings.self, from: Data(newer.replacingOccurrences(
    of: "\"card\":{\"timeout\":30,\"maxHeight\":320}", with: "\"card\":{\"timeout\":30,\"maxHeight\":320},\"animations\":\"sometimes\"").utf8))
check(withPlay.general.animations == "sometimes", "the animations setting decodes")
var playsOften = withPlay
playsOften.general.animations = "often"
let playPatch = playsOften.patch(from: withPlay)["general"] as? [String: Any]
check(playPatch?["animations"] as? String == "often" && playPatch?.count == 1, "only the animations setting is sent when it changes")

// --- The read at start, asked again until the daemon answers ---

check((1...6).map { VoiceSettings.retryDelay(after: $0) } == [2, 4, 8, 16, 30, 30], "waits 2, 4, 8, 16 seconds, then every 30")
check(VoiceSettings.retryDelay(after: 0) == 2 && VoiceSettings.retryDelay(after: 500) == 30, "never under 2 seconds, never over 30")

// --- Read again while the app runs, so a change in the Terminal shows (#482) ---

var asCharacter = saved
asCharacter.general.look = "character"
check(VoiceSettings.replaces(saved, held: nil, heldWhenAsked: nil), "the first read is taken")
check(!VoiceSettings.replaces(saved, held: saved, heldWhenAsked: saved), "a read with nothing new changes nothing")
check(VoiceSettings.replaces(asCharacter, held: saved, heldWhenAsked: saved), "a look changed outside the app is taken")
check(!VoiceSettings.replaces(saved, held: asCharacter, heldWhenAsked: saved), "a read that started before a save here is dropped")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
