// Tests for CallModel: when the pill rings, when it stops, and what ends a
// call. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let a = IncomingCall(id: "call-a", agentId: "writer", reason: "Pick a date", urgency: "normal")
let b = IncomingCall(id: "call-b", agentId: "ops", reason: "Prod is down", urgency: "urgent")

// --- Ringing ---

check(CallModel.action(ringing: nil, calls: [], canRing: true) == .none, "nothing ringing, no calls: nothing")
check(CallModel.action(ringing: nil, calls: [a, b], canRing: true) == .ring(a), "free: the oldest call rings")
check(CallModel.action(ringing: nil, calls: [a], canRing: false) == .none, "busy: the call waits on the daemon")
check(CallModel.action(ringing: "call-a", calls: [a, b], canRing: true) == .none, "still ringing: keep going, no second ring")
check(CallModel.action(ringing: "call-a", calls: [b], canRing: true) == .stop, "gone from the daemon: stop")
check(CallModel.action(ringing: "call-a", calls: [], canRing: false) == .stop, "missed while busy: stop")

// --- What the poll tells the daemon (#408) ---

check(CallModel.pollQuery(ringing: nil, canRing: true) == "", "free: the poll says nothing")
check(CallModel.pollQuery(ringing: nil, canRing: false) == "?busy=1", "in a turn: busy, so a new call waits")
check(CallModel.pollQuery(ringing: "call-a", canRing: true) == "?busy=1&showing=call-a", "ringing: busy for other calls, showing this one")
check(CallModel.pollQuery(ringing: "call-a", canRing: false) == "?busy=1&showing=call-a", "ringing during a turn: still showing it")

// --- Decoding the daemon's poll ---

let json = #"{"calls":[{"id":"call-a","agentId":"writer","reason":"Pick a date","urgency":"normal","status":"ringing","createdAt":1}],"ringSound":"Submarine","ringSeconds":45}"#
let decoded = try? JSONDecoder().decode(RingingCalls.self, from: Data(json.utf8))
check(decoded?.calls == [a] && decoded?.ringSound == "Submarine" && decoded?.ringSeconds == 45, "GET /calls/ringing decodes")

// --- Hanging up by voice ---

for phrase in ["hang up", "Bye.", "goodbye", "Good bye!", "end the call", "talk to you later", "bye bye"] {
    check(CallModel.isHangUp(phrase), "\"\(phrase)\" hangs up")
}
for phrase in ["don't hang up yet", "bye the way, one more thing", "say goodbye to the client"] {
    check(!CallModel.isHangUp(phrase), "\"\(phrase)\" does not")
}

check(CallModel.ringingText(name: "Writer", reason: "Pick a date") == "Writer is calling · Pick a date", "names the caller")
check(CallModel.laterChoices == [5, 15, 30], "later: 5, 15 or 30 minutes")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
