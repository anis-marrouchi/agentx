// --- Facts the node owns: never kept in agent memory (#1531) ---
//
// The node reports its own machine, programs, Claude account limits and
// running work live (GET /api/node, the agentx_node tool). A copy of one
// of those in memory is how an hour-old "weekly limit, resets tomorrow"
// note was repeated as true after the account had recovered. So:
//   - memory writers refuse usage-limit, reset and hold notes
//     (MemoryStore.addMemory, the rotation memo);
//   - one already stored is rendered with a stale marker that sends the
//     agent to agentx_node;
//   - the prompt rule below tells agents to answer from the tool, with
//     its check time.
//
// A line counts only when it is about Claude, this node or its plan:
// a hold pattern (agentx's own words), or a live-state pattern (limit
// hit, window resets, rate-limited) on a line that also names a Claude
// subject. "nginx rate limit 10r/s", "Supabase email limit 4/hour" or
// "extra usage stays off" are lasting facts about other systems or
// decisions, and stay in memory. Window names count as Claude words
// (5h, 7-day, five_hour), spelled-out durations ("7 days") do not.

const SUBJECT = /\b(?:claude|anthropic|opus|sonnet|haiku|codex|five[_ -]hour|seven[_ -]day|5(?:h|-hour)|7(?:d|-day)|weekly (?:limits?|windows?|caps?)|usage limits?|session limits?|plan windows?)\b/i

const LIVE_STATE: RegExp[] = [
  // "limit … resets 10-30 17:00", "the window resets at 17:00"
  /\b(?:limits?|windows?|quotas?|caps?|allowance)\b[^.\n]{0,60}\bresets?\b/i,
  /\bresets?\b[^.\n]{0,40}\b(?:limits?|windows?|quotas?)\b/i,
  // "limit reached / hit / exceeded / lifted", "window rejected"
  /\b(?:limits?|windows?) (?:is |was |has been |got )?(?:reached|hit|exceeded|exhausted|lifted|used up|rejected)\b/i,
  /\b(?:hit|reached|exceeded) (?:the |its |our |a )?(?:\w+ )?limit\b/i,
  // "rate-limited", "quota exceeded", "out of usage"
  /\brate[- ]limited\b/i,
  /\bquotas? (?:is |was )?(?:exceeded|reached|hit|exhausted|used up)\b/i,
  /\bout of (?:usage|quota|credits)\b/i,
]

// Holds are agentx's own state: "plan hold", "cold dispatches are held".
const HOLDS: RegExp[] = [
  /\b(?:plan|provider|claude|quota|usage)[- ]holds?\b/i,
  /\bdispatch(?:es)? (?:are |is |were )?held\b/i,
]

/** True when the text states a Claude usage limit, its reset or a hold. */
export function isNodeFact(text: string): boolean {
  return text.split("\n").some((line) =>
    HOLDS.some((re) => re.test(line)) || (SUBJECT.test(line) && LIVE_STATE.some((re) => re.test(line))))
}

/** Rendered before a stored note of that kind. */
export const NODE_FACT_STALE_TAG = "STALE (limits change hourly; check agentx_node) "

/** The prompt rule: answer environment and account facts from the node. */
export const NODE_FACTS_RULE =
  "- Facts about this machine (OS, version, CPU, memory, disk, installed programs and versions), the Claude account " +
  "(usage limits, resets, holds) or the work running now: call the agentx_node tool first and answer from it, quoting " +
  "its check time (\"no limit holds work, checked 10:42 UTC\"). Never answer these from memory, notes or earlier messages: they go stale within hours."
