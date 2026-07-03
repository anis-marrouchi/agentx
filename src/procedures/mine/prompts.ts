import type { Candidate } from "../candidates"
import type { ActivityEpisode } from "./load"
import { actionClass } from "./cluster"

// --- Extraction prompt ---
// The LLM sees the user's own words plus a coarse activity outline — never
// raw tool names. Its job is to describe the recurring activity as the USER
// would: a named business/personal procedure with a trigger, inputs, and
// steps. The system that executed it is a black box.

/** Human-readable phrase per activity class, used in the outline shown to
 *  the LLM so even the outline is already black-box language. */
const CLASS_PHRASES: Record<string, string> = {
  email: "worked with email",
  message: "sent or read a chat message",
  web: "looked something up online",
  file: "worked with files or documents",
  shell: "ran a local processing step",
  delegate: "handed a subtask off",
  tracker: "updated the issue tracker",
  other: "did an internal step",
}

export function activityOutline(actions: string[]): string {
  const phrases: string[] = []
  for (const action of actions) {
    const phrase = CLASS_PHRASES[actionClass(action)] ?? CLASS_PHRASES.other
    if (phrases[phrases.length - 1] !== phrase) phrases.push(phrase)
  }
  return phrases.slice(0, 8).join(" → ") || "no visible actions"
}

export interface ClusterSample {
  candidate: Candidate
  episodes: ActivityEpisode[]
}

const MAX_EPISODES_PER_CLUSTER = 3
const MAX_MESSAGE_CHARS = 500
const MAX_TURN_CHARS = 200

export function buildExtractionPrompt(samples: ClusterSample[]): string {
  const sections = samples.map((s, i) => {
    const eps = s.episodes.slice(0, MAX_EPISODES_PER_CLUSTER).map((ep, j) => {
      const turns = ep.userTurns
        .slice(0, 3)
        .map((t) => `    - "${t.slice(0, MAX_TURN_CHARS)}"`)
        .join("\n")
      return [
        `  Occurrence ${j + 1} (${new Date(ep.startedAt).toISOString().slice(0, 10)}):`,
        `    Request: "${ep.userMessage.slice(0, MAX_MESSAGE_CHARS)}"`,
        turns ? `    Related things the user said:\n${turns}` : null,
        `    What happened, roughly: ${activityOutline(ep.actions)}`,
      ].filter(Boolean).join("\n")
    }).join("\n")
    return `### Pattern ${i + 1}\ncluster: ${s.candidate.key}\nseen: ${s.candidate.count} times (${s.candidate.firstSeen.slice(0, 10)} → ${s.candidate.lastSeen.slice(0, 10)})\n${eps}`
  }).join("\n\n")

  return `You are documenting a person's recurring work routines. Below are recurring activity patterns observed over time — each pattern is the same kind of request made several times, with a rough outline of what happened.

For each pattern, decide whether it is a genuine recurring procedure (a personal or business routine the person repeats) or noise (coincidental similarity, one-off chatter). Write a procedure for the genuine ones; skip the rest.

STRICT RULES for procedure text — violations get your output rejected:
1. Write everything from the PERSON's perspective. Whatever software or assistant executed the work is a black box — describe the activity, never the machinery.
2. FORBIDDEN words anywhere in id/title/trigger/steps/notes: tool or command names (bash, grep, curl, script, terminal, CLI, MCP, API, JSON, SQL, regex...), "agent", "assistant", "LLM", "AI", "model", "session", "prompt", "database", "daemon", "workflow".
3. Every step starts with an activity verb: Receive, Check, Open, Read, Download, Fill, Rename, Save, Prepare, Send, Reply, Verify, Notify, Archive, File, Forward...
4. The id/title name the person's OUTCOME (e.g. "process-zitouna-payment-notice", "Monthly report for the lab"), never the mechanism.
5. Keep stable concrete details verbatim: sender identities, destination folders, file naming conventions, recipients, schedules. Turn the parts that vary between occurrences into inputs, written like "<statement month>".
6. "trigger" is ONE sentence starting with "When ".
7. 3–8 steps. Each step is one concrete action a person could follow.

Reply with ONLY a JSON object, no prose before or after:
{
  "procedures": [
    {
      "cluster": "<the cluster value given above — copy it exactly>",
      "id": "<lower-kebab-case>",
      "title": "...",
      "trigger": "When ...",
      "inputs": ["<thing that varies>"],
      "expected": "<what done looks like>",
      "kpis": ["<optional measurable outcome>"],
      "tags": ["<domain tags like billing, reporting>"],
      "steps": ["<verb-first step>", "..."],
      "notes": "<optional caveats, empty string if none>"
    }
  ],
  "skipped": [
    { "cluster": "<cluster value>", "reason": "<why this is not a real procedure>" }
  ]
}

## Observed patterns

${sections}`
}
