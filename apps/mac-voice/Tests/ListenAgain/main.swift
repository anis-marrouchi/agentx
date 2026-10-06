// Tests for ListenAgain: the answer's speaker button (#492). Run with
// ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

check(ListenAgain.click(replaying: false, text: "The build passed.") == .speak, "a click speaks the answer")
check(ListenAgain.click(replaying: true, text: "The build passed.") == .stop, "a click while it plays stops it")
check(ListenAgain.click(replaying: true, text: nil) == .stop, "stopping needs no answer")
check(ListenAgain.click(replaying: false, text: nil) == .nothing, "no answer: nothing to say")
check(ListenAgain.click(replaying: false, text: "  \n") == .nothing, "a blank answer: nothing to say")

check(ListenAgain.look(replaying: false) == ("speaker.wave.2", "Listen again"), "idle: a speaker, \"Listen again\"")
check(ListenAgain.look(replaying: true).label == "Stop listening", "playing: the button says it stops")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
