// Scenarios for the JEV session-continuity benchmark. See bench-jev.ts.
//
// These are hand-written, not replayed from real traffic, for two reasons.
// One, the harness has to be re-runnable by anyone and comparable across
// runs, which a live transcript is not. Two, .agentx/sessions holds real
// conversations — names, numbers, hosts — and this file is in a public
// repo. Everything below is synthetic.
//
// WHAT A SCENARIO HAS TO CONTAIN.
//
// The session-continuity seat can only rotate EARLY: when no mechanical
// trigger fired, it may still decide the new request is a different piece
// of work and drop the transcript. So a scenario that never changes
// subject gives the seat nothing to do, and a scenario that changes
// subject every turn flatters it — real chats do both, and the seat has
// to tell them apart.
//
// Hence `expect` on every turn. A benchmark that reported only tokens
// would rank "rotate on every turn" as the best possible policy, which is
// precisely the amnesia failure the seat's own header warns about. The
// harness scores rotations against these labels and reports correctness
// next to cost, so a cheap-but-amnesiac arm loses.

export type Expectation = "continue" | "rotate"

export interface BenchTurn {
  message: string
  /** What the seat SHOULD do before dispatching this turn.
   *
   *  "continue" — resuming is right. A rotation here is amnesia: the
   *  request leans on something said earlier and a fresh session cannot
   *  answer it.
   *
   *  "rotate" — a genuinely new piece of work. Resuming here replays a
   *  transcript the answer does not need, which is the cache-read bill
   *  the seat exists to cut.
   *
   *  Absent on the first turn of a conversation: there is nothing to
   *  resume, so the seat is never consulted. */
  expect?: Expectation
  note?: string
}

export interface BenchScenario {
  name: string
  description: string
  turns: BenchTurn[]
}

/** The main case: three unrelated subjects, each with real follow-ups.
 *  Half the turns must resume, half should rotate — so neither a
 *  rotate-always nor a never-rotate policy can win on correctness. */
const mixedSubjects: BenchScenario = {
  name: "mixed-subjects",
  description:
    "12 turns over three unrelated subjects with genuine follow-ups inside each. " +
    "5 clean subject changes, 6 turns that depend on earlier context.",
  turns: [
    { message: "Explain what a write-ahead log is and why databases use one.", note: "opening turn — seat not consulted" },

    { message: "Does that apply to SQLite specifically, or only to client-server databases?", expect: "continue", note: "'that' refers to the WAL answer" },
    { message: "What happens to the log during a crash halfway through a commit?", expect: "continue", note: "same subject, deeper" },

    { message: "Separate question — what is the difference between a semaphore and a mutex?", expect: "rotate", note: "explicit topic change, signposted" },
    { message: "Give me a case where using the wrong one causes a deadlock.", expect: "continue", note: "needs the semaphore/mutex answer" },

    { message: "New topic: how does HTTP connection keep-alive interact with load balancers?", expect: "rotate", note: "explicit topic change" },
    { message: "Why would that cause uneven traffic distribution across backends?", expect: "continue", note: "'that' = keep-alive behaviour" },
    { message: "What header controls how long the connection stays open?", expect: "continue", note: "same subject" },

    { message: "Unrelated: what is the CAP theorem?", expect: "rotate", note: "explicit topic change" },

    { message: "Which of the three does a typical SQL replica set give up?", expect: "continue", note: "'the three' = C, A, P" },

    { message: "Different question entirely — what does the `finally` block guarantee in a try/catch?", expect: "rotate", note: "explicit topic change" },
    { message: "Does it still run if the try block calls process.exit?", expect: "continue", note: "'it' = the finally block" },
  ],
}

/** The control. Nothing here should ever rotate. An arm that rotates in
 *  this scenario is buying its token savings with amnesia, and the
 *  scenario exists to make that visible rather than cheap. */
const singleThread: BenchScenario = {
  name: "single-thread",
  description:
    "8 turns on one continuous task. Every turn after the first depends on the last. " +
    "Correct behaviour is zero rotations — this measures the seat's false-positive rate.",
  turns: [
    { message: "I want to add retry logic to an HTTP client. Where should it live?" },
    { message: "Use exponential backoff. What base and multiplier would you pick?", expect: "continue" },
    { message: "Add jitter to that.", expect: "continue", note: "two words — meaningless without the backoff answer" },
    { message: "Which status codes should it retry on?", expect: "continue" },
    { message: "What about 429 specifically?", expect: "continue" },
    { message: "Does the Retry-After header change your answer there?", expect: "continue" },
    { message: "Now write the whole thing up as a short spec.", expect: "continue", note: "'the whole thing' = all six turns above" },
    { message: "Add a section on what should NOT be retried.", expect: "continue" },
  ],
}

/** The hard case. Short, unsignposted switches — no "new topic:" prefix to
 *  lean on — mixed with terse acknowledgments. This is what real chat
 *  traffic looks like and where a keyword heuristic falls over. */
const terseSwitches: BenchScenario = {
  name: "terse-switches",
  description:
    "10 short turns with unsignposted subject changes and one-word follow-ups. " +
    "No lexical cue marks the boundaries — the hardest case for the seat.",
  turns: [
    { message: "What does a bloom filter give you that a hash set doesn't?" },
    { message: "And the cost?", expect: "continue", note: "three words, entirely dependent" },
    { message: "How do you pick the number of hash functions?", expect: "continue" },
    { message: "What's the difference between a container and a VM?", expect: "rotate", note: "no signpost, but completely unrelated" },
    { message: "Which one boots faster?", expect: "continue" },
    { message: "Why?", expect: "continue", note: "one word" },
    { message: "How does TCP slow start work?", expect: "rotate", note: "no signpost" },
    { message: "Over a satellite link?", expect: "continue" },
    { message: "Is CSS grid or flexbox better for a page layout?", expect: "rotate", note: "no signpost" },
    { message: "For a single row of buttons?", expect: "continue" },
  ],
}

export const SCENARIOS: BenchScenario[] = [mixedSubjects, singleThread, terseSwitches]

export function getScenario(name: string): BenchScenario | undefined {
  return SCENARIOS.find((s) => s.name === name)
}
