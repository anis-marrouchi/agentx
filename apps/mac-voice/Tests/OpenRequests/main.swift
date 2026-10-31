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

// --- Close, Undo and Close heard ---

var closing = OpenRequests()
let c1 = closing.add(agentID: "writer", question: "first", at: t0)
let c2 = closing.add(agentID: "ops", question: "second", at: at(1))
let c3 = closing.add(agentID: "researcher", question: "third", at: at(2))
closing.answered(c1, at: at(10)); closing.heard(c1)
closing.failed(c2, reason: "timed out", at: at(11))
check(OpenRequests.closeNeedsConfirm(closing.request(c3)!), "closing a thinking row asks first")
check(!OpenRequests.closeNeedsConfirm(closing.request(c1)!), "a heard row closes at once")
let gone = closing.close(c1)
check(gone?.id == c1 && closing.request(c1) == nil, "a closed row leaves the list")
closing.restore(gone!)
check(closing.requests.map(\.id) == [c1, c2, c3], "Undo puts it back in its place")
let swept = closing.closeHeard()
check(Set(swept.map(\.id)) == [c1, c2] && closing.requests.map(\.id) == [c3],
      "Close heard takes every heard answer and every failure, not a thinking row")
check(OpenRequests.closedNote(name: "Ops") == "Closed Ops’s request", "the line after a close")
check(OpenRequests.stillThinking(name: "Writer") == "Writer is still thinking"
      && OpenRequests.stopAgent(name: "Writer") == "Stop Writer", "the confirm's words")
check(OpenRequests.continueNote(name: "Ops") == "Ops · Hold ⌥Space to continue it", "a picked row says how to continue it")

// --- The daemon's list ---

func remote(_ key: String, _ agent: String, _ state: String, heard: Bool = false, sent: TimeInterval = 0) -> OpenRequests.Remote {
    OpenRequests.Remote(key: key, agentID: agent, question: "asked \(key)", sentAt: at(sent), since: at(sent + 1),
                        state: state, heard: heard, error: state == "failed" ? "AgentX restarted" : nil)
}

var synced = OpenRequests()
let mine = synced.add(agentID: "writer", question: "mine", at: at(5))
synced.setKey(mine, "rmine0001")
let pending = synced.add(agentID: "ops", question: "not on the daemon yet", at: at(6))
let joined = synced.sync([
    remote("rold00001", "ops", "answered", sent: 1),
    remote("rmine0001", "writer", "answered", heard: true, sent: 5),
    remote("rlost0001", "researcher", "failed", sent: 3),
])
check(joined.count == 2, "rows only the daemon has join the list (after the app restarted)")
check(synced.requests.map(\.question) == ["asked rold00001", "asked rlost0001", "mine", "not on the daemon yet"],
      "joined rows take their place by when they were sent")
check(synced.request(mine)?.heard == true, "heard on another client is heard here")
check(synced.request(mine)?.phase == .thinking, "a row this app runs keeps its own state until its answer is back")
check(synced.request(key: "rlost0001")?.phase == .failed("AgentX restarted"), "a joined row takes the daemon's state")
check(synced.request(pending) != nil, "a row the daemon doesn't have yet is left alone")
synced.sync([remote("rold00001", "ops", "answered", sent: 1)])
check(synced.request(mine) == nil && synced.request(key: "rlost0001") == nil,
      "a row the daemon no longer lists was closed elsewhere and leaves")
check(synced.request(key: "rold00001")?.local == false, "a joined row is not run by this app")
var found = OpenRequests()
found.sync([remote("rwait0001", "ops", "waiting")])
let next = found.startNext(for: "ops", at: at(9))
check(next != nil && found.request(next!)?.local == true, "a joined row waiting its turn is run by this app")

// A follow-up spoken with a row picked continues that row: no new row.
var follow = OpenRequests()
let f1 = follow.add(agentID: "writer", question: "draft the summary", at: at(0))
follow.answered(f1, at: at(30))
follow.heard(f1)
check(follow.follow(f1, with: "make it shorter", at: at(60)) == .ask, "a done row asks again at once")
check(follow.requests.count == 1, "the follow-up adds no row")
check(follow.request(f1)?.question == "make it shorter" && follow.request(f1)?.phase == .thinking
      && follow.request(f1)?.heard == false && follow.request(f1)?.since == at(60),
      "it thinks again with the new words, its new answer not heard")
check(follow.follow(f1, with: "and add a title", at: at(70)) == .after, "a thinking row keeps the words for after")
check(follow.follow(f1, with: "in French", at: at(71)) == .after && follow.request(f1)?.pending == "and add a title in French",
      "a second follow-up while thinking joins the first")
check(follow.takePending(f1, at: at(90)) && follow.request(f1)?.question == "and add a title in French"
      && follow.request(f1)?.phase == .thinking && follow.request(f1)?.pending == nil,
      "once the answer is back the kept words are asked")
check(!follow.takePending(f1, at: at(91)), "nothing kept: the answer is the row's")
follow.failed(f1, reason: "busy", at: at(100))
let f2 = follow.add(agentID: "writer", question: "another thing", at: at(110))
check(follow.follow(f1, with: "try again", at: at(120)) == .waits && follow.request(f1)?.phase == .waiting,
      "a done row waits when its agent has another request out")
check(follow.follow(f1, with: "please", at: at(121)) == .waits && follow.request(f1)?.question == "try again please",
      "a waiting row takes the words into its question")
check(follow.follow(999, with: "x", at: at(122)) == nil, "a row gone continues nothing")
check(follow.request(f2)?.phase == .thinking, "the other request is untouched")

// A row continued on another client: its new words, thinking, not heard.
var elsewhere = OpenRequests()
elsewhere.sync([remote("rcont0001", "ops", "answered", heard: true)])
let theirs = OpenRequests.Remote(key: "rcont0001", agentID: "ops", question: "and the night before?", sentAt: at(0),
                                 since: at(50), state: "thinking", heard: false, error: nil)
elsewhere.sync([theirs])
let cont = elsewhere.request(key: "rcont0001")
check(cont?.question == "and the night before?" && cont?.phase == .thinking && cont?.heard == false,
      "a row continued elsewhere shows its follow-up, thinking, not heard")

// More than five rows: one row per agent.
var grouping = OpenRequests()
for i in 0..<OpenRequests.flatUpTo { grouping.add(agentID: i < 3 ? "writer" : "ops", question: "q\(i)", at: at(Double(i))) }
check(!grouping.grouped, "five rows or fewer stay flat")
let g6 = grouping.add(agentID: "writer", question: "q5", at: at(5))
check(grouping.grouped, "a sixth row groups the list")
let groups = grouping.groups(newestLast: true)
check(groups.map(\.agentID) == ["ops", "writer"], "one group per agent, the newest activity last")
check(groups[1].requests.count == 4 && groups[0].requests.count == 2, "each group holds its agent's rows")
check(groups.allSatisfy { $0.id < 0 } && Set(groups.map(\.id)).count == 2, "group ids never clash with request ids")
check(grouping.groups(newestLast: false).map(\.agentID) == ["writer", "ops"], "newest first when the list is below")
check(grouping.rows(newestLast: true, agentID: "ops").map(\.agentID) == ["ops", "ops"], "opening an agent shows its rows")
check(OpenRequests.groupState(groups[1]) == "Thinking", "a group says what it is doing")
grouping.answered(g6, at: at(9))
check(OpenRequests.groupState(grouping.groups(newestLast: true)[1]) == "1 new", "new answers come first")
grouping.heard(g6)
for r in grouping.requests where r.isOpen { grouping.answered(r.id, at: at(10)); grouping.heard(r.id) }
check(OpenRequests.groupState(grouping.groups(newestLast: true)[0]) == "2 requests", "all heard: how many")
check(OpenRequests.requestsCount(1) == "1 request", "one request, singular")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
