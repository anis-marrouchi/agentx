// Tests for the floor (#924): what the daemon sends, what the app does
// while someone holds it, and the menu's row. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

func decode(_ json: String) -> FloorState? {
    try? JSONDecoder().decode(FloorState.self, from: Data(json.utf8))
}

let free = decode(#"{"seq":0,"held":false,"holder":null,"agentId":null,"sound":false,"hide":false,"since":null,"expiresAt":null,"ended":null}"#)
check(free == FloorState.free, "a free floor, as the daemon sends it")
check(free?.holdsAnswers == false && free?.closesOpenMicrophone == false && free?.hidesEverything == false,
      "a free floor holds nothing back")
check(FloorState.free.menuTitle(now: 0) == nil, "and has no row in the menu")

let tour = decode(#"{"seq":3,"held":true,"holder":"Product tour","agentId":null,"sound":true,"hide":false,"since":1000000,"expiresAt":1120000,"ended":null}"#)!
check(tour.holdsAnswers, "a held floor: an answer waits")
check(tour.closesOpenMicrophone, "a holder that plays sound: the microphone does not open by itself")
check(!tour.hidesEverything, "a demo leaves the character on screen")
check(tour.menuTitle(now: 1000) == "Product tour holds the floor (up to 2 min)", "the menu says who holds it and for how long")
check(tour.menuTitle(now: 1075) == "Product tour holds the floor (up to 45 s)", "in seconds near the end")

let quiet = decode(#"{"seq":4,"held":true,"holder":"Slides","sound":false,"hide":false,"expiresAt":1120000}"#)!
check(quiet.holdsAnswers && !quiet.closesOpenMicrophone, "a silent holder: answers wait, the microphone may open")

let recording = decode(#"{"seq":5,"held":true,"holder":"Screen recording","sound":false,"hide":true,"expiresAt":1120000}"#)!
check(recording.hidesEverything, "a recording: the character and every bubble are out")

check(tour.at(1119) == tour, "held until its time")
let over = tour.at(1120)
check(!over.held && over.seq == 3 && !over.closesOpenMicrophone, "past its time it is free, whatever the daemon last said")

check(decode(#"{"error":"Not found"}"#) == nil, "anything else is not a floor: the watcher takes it for free")

exit(failures == 0 ? 0 : 1)
