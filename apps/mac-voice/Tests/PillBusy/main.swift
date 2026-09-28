// Tests for PillBusy: which agents get a mini orb in the pill, in what
// state, and how the row is laid out. Run with ../../test.sh.
import CoreGraphics
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

typealias Snap = PillBusy.Snapshot

// --- Who is busy, and doing what ---

check(PillBusy.items(Snap(), order: []).isEmpty, "nothing in flight: no orbs")

var two = Snap()
two.inFlight = ["writer": 1, "planner-agent": 1]
let items = PillBusy.items(two, order: [])
check(items.map(\.agentID) == ["planner-agent", "writer"], "two agents asked back to back: two orbs")
check(items.allSatisfy { $0.activity == .thinking && $0.queued == 0 }, "both thinking, none queued")

var mixed = Snap()
mixed.inFlight = ["writer": 1, "ops-agent": 1]
mixed.waiting = ["writer": 2, "researcher-agent": 1]
mixed.playing = "planner-agent"
mixed.toSpeak = ["ops-agent", "", "ops-agent"]
let m = PillBusy.items(mixed, order: [])
let by = Dictionary(uniqueKeysWithValues: m.map { ($0.agentID, $0) })
check(by["planner-agent"]?.activity == .speaking, "the agent being spoken for is speaking")
check(by["ops-agent"]?.activity == .answering, "an answer waiting in the queue is answering, over thinking")
check(by["writer"]?.activity == .thinking && by["writer"]?.queued == 2, "thinking with two more questions queued")
check(by["researcher-agent"]?.activity == .queued && by["researcher-agent"]?.queued == 1,
      "only a question waiting: queued")
check(m.count == 4 && by[""] == nil, "an empty queue id is nobody")

var both = Snap()
both.inFlight = ["writer": 2]
both.playing = "writer"
let w = PillBusy.items(both, order: [])[0]
check(w.activity == .speaking && w.queued == 1, "speaking one answer while the next is asked: speaking, one queued")

// --- Order is stable ---

let first = PillBusy.items(two, order: ["writer"])
check(first.map(\.agentID) == ["writer", "planner-agent"], "an orb already shown keeps its place")
var three = two
three.inFlight["archivist"] = 1
check(PillBusy.items(three, order: first.map(\.agentID)).map(\.agentID) == ["writer", "planner-agent", "archivist"],
      "a new busy agent joins at the end")
var done = three
done.inFlight["writer"] = nil
check(PillBusy.items(done, order: ["writer", "planner-agent", "archivist"]).map(\.agentID) == ["planner-agent", "archivist"],
      "a finished agent leaves; the others keep their order")

// --- When the row shows ---

check(PillBusy.showsRow(items, mainAgent: "writer", mainActive: true), "two busy: the row shows")
check(!PillBusy.showsRow([], mainAgent: "writer", mainActive: false), "none busy: no row")
let one = [PillBusy.Item(agentID: "writer", activity: .thinking, queued: 0)]
check(!PillBusy.showsRow(one, mainAgent: "writer", mainActive: true), "one busy and it is the main orb's turn: no row")
check(PillBusy.showsRow(one, mainAgent: "planner-agent", mainActive: true),
      "one busy while the main orb shows another agent: the row shows")
check(PillBusy.showsRow(one, mainAgent: "writer", mainActive: false),
      "a question still out while the pill is idle: the row shows")
let speaking = [PillBusy.Item(agentID: "writer", activity: .speaking, queued: 0)]
check(!PillBusy.showsRow(speaking, mainAgent: "writer", mainActive: false), "one line being spoken alone: no row")

// --- Layout ---

check(PillBusy.rowWidth(0) == 0, "no orbs take no room")
check(PillBusy.rowWidth(1) == PillBusy.diameter, "one orb is one diameter wide")
check(PillBusy.rowWidth(3) == 3 * PillBusy.diameter + 2 * PillBusy.gap, "three orbs and two gaps")
check(PillBusy.diameter >= 14 && PillBusy.diameter <= 16, "a mini orb is 14 to 16 points")
check(PillBusy.shown(4) == (4, 0) && PillBusy.shown(6) == (3, 3), "past four, three orbs and +3")
check(PillBusy.rowWidth(9) == PillBusy.rowWidth(3) + PillBusy.gap + PillBusy.overflowWidth,
      "and the +n takes a fixed width")
check(PillBusy.rowWidth(20) == PillBusy.rowWidth(5) && PillBusy.rowWidth(20) <= 90, "the row stays compact however many are busy")
check(PillBusy.orbOffsets(3) == [0, PillBusy.diameter + PillBusy.gap, 2 * (PillBusy.diameter + PillBusy.gap)],
      "orbs are evenly spaced")

// --- Tooltip ---

let tip = PillBusy.tooltip(name: "Planner", node: "server", item: .init(agentID: "planner-agent", activity: .thinking, queued: 2))
check(tip == "Planner on server · thinking, 2 more queued", "the tooltip names the agent, its node and state (\(tip))")
check(PillBusy.tooltip(name: "Writer", node: nil, item: .init(agentID: "writer", activity: .speaking, queued: 0))
        == "Writer · speaking", "no node, no queue: name and state")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
