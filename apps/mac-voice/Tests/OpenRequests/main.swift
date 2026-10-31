// Tests for OpenRequests: the open-requests list (#1455), from sent to
// heard, and the words its rows and the pill show. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

// --- Send and move on ---

var list = OpenRequests()
let w1 = list.add(agentID: "writer", question: "draft the note for the June release", at: t0)
let r1 = list.add(agentID: "researcher", question: "compare the two plans", at: at(5))
check(list.request(w1)?.phase == .thinking && list.request(r1)?.phase == .thinking,
      "two agents asked back to back: both think at once")
let w2 = list.add(agentID: "writer", question: "and a shorter one", at: at(8))
check(list.request(w2)?.phase == .waiting, "a second request for a busy agent waits its turn")
check(list.waiting == ["writer": 1], "the pill counts it as waiting for Writer")
check(list.startNext(for: "writer", at: at(9)) == nil, "nothing starts while Writer still thinks")

list.answered(w1, at: at(70))
check(list.request(w1)?.phase == .answered && list.request(w1)?.heard == false, "an answer back is not heard yet")
check(list.newCount == 1 && list.readyAgents == ["writer"], "one new, Writer's")
check(list.startNext(for: "writer", at: at(70)) == w2, "Writer's next request goes when the first answers")
check(list.request(w2)?.phase == .thinking && list.request(w2)?.since == at(70), "it thinks from then")
check(list.waiting.isEmpty, "nothing waits any more")

list.failed(r1, reason: "The calendar didn’t answer in time.", at: at(80))
check(list.newCount == 2 && list.failedAgents == ["researcher"], "a failure is new too, and named for the pill")

// --- Heard ---

list.heard(w1)
check(list.request(w1)?.heard == true && list.newCount == 1 && list.readyAgents.isEmpty, "heard: no longer new")
check(list.request(w1) != nil, "a heard row stays in the list")

var many = OpenRequests()
var ids: [Int] = []
for i in 0..<(OpenRequests.keptHeard + 3) {
    let id = many.add(agentID: "a\(i)", question: "q\(i)", at: at(Double(i)))
    many.answered(id, at: at(Double(i) + 1))
    ids.append(id)
}
let open = many.add(agentID: "a0", question: "still thinking", at: at(100))
for id in ids { many.heard(id) }
check(many.requests.filter(\.heard).count == OpenRequests.keptHeard, "only the newest heard rows are kept")
check(many.request(ids[0]) == nil && many.request(ids.last!) != nil, "the oldest heard leave first")
check(many.request(open)?.phase == .thinking, "a request still thinking never leaves by itself")

var dropped = OpenRequests()
let d = dropped.add(agentID: "writer", question: "hmm", at: t0)
dropped.remove(d)
check(dropped.requests.isEmpty, "words the daemon took for something else leave no row")

// --- Rows, in order ---

let rowsUp = list.rows(newestLast: true).map(\.id)
check(rowsUp == [w1, r1, w2], "above the pill: oldest at the top, newest next to the pill")
check(list.rows(newestLast: false).map(\.id) == [w2, r1, w1], "below the pill: newest at the top, next to it")
check(list.firstSelection == r1, "the keyboard lands on the oldest new answer")
var none = OpenRequests()
check(none.firstSelection == nil, "an empty list selects nothing")
let only = none.add(agentID: "ops", question: "x", at: t0)
check(none.firstSelection == only, "nothing new: the newest row")

// --- Keyboard ---

check(OpenRequests.move(nil, by: 1, in: [4, 5, 6]) == 4, "↓ with nothing selected: the top row")
check(OpenRequests.move(nil, by: -1, in: [4, 5, 6]) == 6, "↑ with nothing selected: the bottom row")
check(OpenRequests.move(5, by: 1, in: [4, 5, 6]) == 6, "↓ moves down")
check(OpenRequests.move(6, by: 1, in: [4, 5, 6]) == 6, "↓ stops at the bottom")
check(OpenRequests.move(4, by: -1, in: [4, 5, 6]) == 4, "↑ stops at the top")
check(OpenRequests.move(9, by: 1, in: [4, 5, 6]) == 4, "a row that left: start again from the top")
check(OpenRequests.move(nil, by: 1, in: []) == nil, "no rows: nothing to select")

// --- Picking a row ---

check(OpenRequests.pick(list.request(w2)!) == .nothing, "a thinking row has nothing to hear yet")
check(OpenRequests.pick(list.request(w1)!) == .show, "a heard row shows its text again")
var fresh = OpenRequests()
let f = fresh.add(agentID: "ops", question: "backups?", at: t0)
fresh.answered(f, at: at(3))
check(OpenRequests.pick(fresh.request(f)!) == .listen, "an unheard answer plays")
check(OpenRequests.pick(list.request(r1)!) == .reason("The calendar didn’t answer in time."), "a failure says why")

// --- Words ---

check(OpenRequests.firstWords("check   last night’s\nbackups finished") == "Check last night’s backups finished",
      "first words: one line, capitalised")
let long = OpenRequests.firstWords("compare the two plans for the spring trip and tell me which one is cheaper overall", max: 30)
check(long == "Compare the two plans for the…", "cut at a word, with an ellipsis (\(long))")
check(OpenRequests.firstWords("") == "", "nothing heard: nothing shown")
check(OpenRequests.clock(20) == "0:20" && OpenRequests.clock(72) == "1:12" && OpenRequests.clock(725) == "12:05", "the thinking clock")
check(OpenRequests.ago(10) == "now" && OpenRequests.ago(130) == "2 min" && OpenRequests.ago(7300) == "2 h", "how long ago")

check(OpenRequests.stateWords(list.request(w2)!, now: at(142)) == "Thinking, 1:12", "thinking counts from when it started")
check(OpenRequests.stateWords(fresh.request(f)!, now: at(10)) == "Answer ready", "an answer not heard")
check(OpenRequests.stateWords(list.request(w1)!, now: at(200)) == "Heard", "an answer heard")
check(OpenRequests.stateWords(list.request(r1)!, now: at(200)) == "Couldn’t answer", "a failure")
var waits = OpenRequests()
waits.add(agentID: "ops", question: "a", at: t0)
let second = waits.add(agentID: "ops", question: "b", at: t0)
check(OpenRequests.stateWords(waits.request(second)!, now: t0) == "Waiting its turn", "waiting behind another")

var vo = OpenRequests()
let v = vo.add(agentID: "ops", question: "Check last night’s backups finished?", at: t0)
vo.answered(v, at: at(30))
let said = OpenRequests.voiceOver(name: "Ops", vo.request(v)!, now: at(125))
check(said == "Ops. Answer ready, not heard. You asked: check last night’s backups finished. 2 minutes ago.",
      "VoiceOver reads a row as drawn (\(said))")
let thinkingSaid = OpenRequests.voiceOver(name: "Writer", list.request(w2)!, now: at(140))
check(thinkingSaid == "Writer. Thinking, 1 minute. You asked: and a shorter one. 2 minutes ago.",
      "VoiceOver for a thinking row (\(thinkingSaid))")

check(OpenRequests.newBadge(1) == "1 new", "the pill's badge")
check(OpenRequests.readyNote(name: "Ops") == "Ops answered · hover or ⌘⌥O to hear it", "the pill's line when an answer waits")

// --- Follow-up stays in its request ---

var fu = OpenRequests()
let q = fu.add(agentID: "writer", question: "draft the note", at: t0)
fu.answered(q, at: at(30))
check(fu.followUp(q, question: "make it shorter", at: at(40)) == .ask, "a follow-up on an answer is asked at once")
check(fu.requests.count == 1, "a follow-up adds no row")
check(fu.request(q)?.question == "make it shorter" && fu.request(q)?.turns == 2, "the row asks the new words, its second turn")
check(fu.request(q)?.phase == .thinking && fu.request(q)?.since == at(40), "it thinks again from then")
check(fu.request(q)?.sentAt == t0 && fu.rows(newestLast: true).map(\.id) == [q], "the row keeps its place")
check(fu.newCount == 0, "the answer it continued is no longer new")

check(fu.followUp(q, question: "and friendlier", at: at(45)) == .afterAnswer, "a follow-up while it thinks waits for the answer")
check(fu.request(q)?.pending == "and friendlier" && fu.requests.count == 1, "kept in the same row")
check(fu.askPending(q, at: at(60)), "the answer back: the follow-up goes")
check(fu.request(q)?.question == "and friendlier" && fu.request(q)?.phase == .thinking && fu.request(q)?.pending == nil,
      "in place of that answer, still one row")
check(!fu.askPending(q, at: at(61)), "nothing more to ask")

var busyAgent = OpenRequests()
let a1 = busyAgent.add(agentID: "ops", question: "backups?", at: t0)
busyAgent.answered(a1, at: at(5))
let a2 = busyAgent.add(agentID: "ops", question: "disk space?", at: at(6))
check(busyAgent.followUp(a1, question: "which ones failed?", at: at(7)) == .waits, "its agent busy with another: the follow-up waits")
check(busyAgent.request(a1)?.phase == .waiting && busyAgent.requests.count == 2, "waiting, in its own row")
busyAgent.answered(a2, at: at(20))
check(busyAgent.startNext(for: "ops", at: at(20)) == a1, "and goes when the other answers")

var queued = OpenRequests()
queued.add(agentID: "ops", question: "a", at: t0)
let b = queued.add(agentID: "ops", question: "b", at: t0)
check(queued.followUp(b, question: "and c", at: at(1)) == .waits && queued.request(b)?.question == "b and c",
      "a follow-up on a waiting request joins its words")
check(queued.followUp(99, question: "x", at: t0) == nil, "a row that left: no follow-up")

var failedOne = OpenRequests()
let fl = failedOne.add(agentID: "ops", question: "a", at: t0)
failedOne.failed(fl, reason: "Timed out.", at: at(5))
check(failedOne.followUp(fl, question: "try again", at: at(6)) == .ask && failedOne.request(fl)?.phase == .thinking,
      "a follow-up on a failure asks again")

// --- By agent past five ---

var g = OpenRequests()
var gids: [Int] = []
for (i, who) in ["writer", "ops", "writer", "researcher", "ops"].enumerated() {
    gids.append(g.add(agentID: who, question: "q\(i)", at: at(Double(i))))
}
check(!g.isGrouped && g.firstEntry == g.firstSelection, "five requests: the list stays flat")
let six = g.add(agentID: "writer", question: "q5", at: at(5))
check(g.isGrouped, "six: one row per agent")
let up = g.groups(newestLast: true)
check(up.map(\.agentID) == ["researcher", "ops", "writer"], "agents by their latest request, newest next to the pill")
check(g.groups(newestLast: false).map(\.agentID) == ["writer", "ops", "researcher"], "below the pill: newest at the top")
check(up.last?.requests.map(\.id) == [gids[0], gids[2], six] && up.last?.latest.id == six, "an agent's row holds its requests")
check(Set(up.map(\.id)).count == 3 && up.allSatisfy { $0.id < 0 }, "agent rows have their own ids, never a request's")
check(g.agent(ofGroup: up[0].id) == "researcher" && g.agent(ofGroup: 5) == nil, "an agent row's id names its agent")
check(g.rows(for: "ops", newestLast: false).map(\.id) == [gids[4], gids[1]], "an agent's requests, newest at the top below the pill")

g.answered(gids[0], at: at(30))
check(g.groups(newestLast: true).map(\.agentID) == ["researcher", "ops", "writer"], "an answer moves no agent row")
check(g.firstEntry == g.groupIDs["writer"], "the keyboard lands on the agent with the oldest new answer")
let writer = g.groups(newestLast: true).last!
check(OpenRequests.groupState(writer, now: at(40)) == "3 requests · 1 answer ready", "an agent's row says what waits (\(OpenRequests.groupState(writer, now: at(40))))")
let ops = g.groups(newestLast: true)[1]
check(OpenRequests.groupState(ops, now: at(64)) == "2 requests · Thinking, 1:03", "or that it thinks")
check(OpenRequests.groupVoiceOver(name: "Writer", writer, now: at(40)) == "Writer. 3 requests, 1 answer ready. Latest: q5. Opens Writer’s requests.",
      "VoiceOver for an agent's row")
let id7 = g.add(agentID: "ops", question: "q6", at: at(50))
check(g.groups(newestLast: true).map(\.agentID) == ["researcher", "writer", "ops"], "a new request moves its agent next to the pill")
g.followUp(gids[0], question: "more", at: at(60))
check(g.requests.count == 7 && g.request(id7) != nil, "a follow-up in a grouped list adds no row either")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
