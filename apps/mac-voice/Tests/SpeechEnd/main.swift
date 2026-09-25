// Tests for SpeechEnd: when a spoken line has ended. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

// --- The decision alone ---

let t0 = Date()
func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

var waiting = SpeechEnd()
check(!waiting.ended(playing: false, at: at(0)) && !waiting.ended(playing: false, at: at(30)),
      "silence before the first sound never ends the line (waiting for the speaker lock)")

var line = SpeechEnd()
_ = line.ended(playing: true, at: at(0))
check(!line.ended(playing: false, at: at(1.0)) && !line.ended(playing: false, at: at(1.2)),
      "a pause shorter than 0.3 s is not the end")
_ = line.ended(playing: true, at: at(1.25))
check(!line.ended(playing: false, at: at(2.0)), "quiet starts over after the voice comes back")
check(line.ended(playing: false, at: at(2.31)), "0.3 s of quiet after speech is the end")

// --- A line that goes quiet and never exits, as `say` did ---
//
// A child speaks one line at volume 0, prints "ended" when its voice
// stops, and stays alive. The end must be seen while it still runs.
// Core Audio keeps a process's output running about 2.7 s after its last
// sample, so "seen" means within that tail plus the 0.3 s quiet window.

let speaker = """
ObjC.import("AppKit"); ObjC.import("Foundation");
var s = $.NSSpeechSynthesizer.alloc.initWithVoice($()); s.volume = 0;
s.startSpeakingString($("A muted test line that plays for a second or two."));
function spin() { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02)); }
while (!s.isSpeaking) spin();
while (s.isSpeaking) spin();
$.NSFileHandle.fileHandleWithStandardOutput.writeData($("ended\\n").dataUsingEncoding($.NSUTF8StringEncoding));
$.NSThread.sleepForTimeInterval(20);
"""
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
p.arguments = ["-l", "JavaScript", "-e", speaker]
let out = Pipe()
p.standardOutput = out
p.standardError = FileHandle.nullDevice
var voiceStopped: Date?
out.fileHandleForReading.readabilityHandler = { h in
    if String(decoding: h.availableData, as: UTF8.self).contains("ended") { voiceStopped = Date() }
}
try p.run()

var end = SpeechEnd()
var heardAny = false
var detected: Date?
let deadline = Date().addingTimeInterval(15)
while Date() < deadline, detected == nil {
    let playing = AudioOutput.playing(pid: p.processIdentifier)
    heardAny = heardAny || playing
    if end.ended(playing: playing, at: Date()) { detected = Date() }
    Thread.sleep(forTimeInterval: 0.1)
}
let stillRunning = p.isRunning
p.terminate()

if !heardAny {
    print("skip no audio output device: the muted line was never heard")
} else if let detected, let voiceStopped {
    let lag = detected.timeIntervalSince(voiceStopped)
    check(stillRunning, "the process was still running when the end was seen")
    check(lag < 4, String(format: "the end was seen %.2f s after the voice stopped (< 4 s)", lag))
} else {
    check(false, "the end was seen (detected: \(detected != nil), voice stopped: \(voiceStopped != nil))")
}

exit(failures == 0 ? 0 : 1)
