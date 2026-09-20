import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// What to say out loud while an agent works.
//
// The widget was reading raw step text aloud, which produced things like
// "Still working. osascript -e tell application Calendar to get events".
// Nobody wants to hear a shell command. The fix is not a better string
// template — a template cannot tell "checking the calendar" from "deleting
// a branch", and those deserve different words.
//
// But Jev does not write text, it chooses. So the phrasing is written here
// in advance and Jev picks which one fits. That is the shape it is good at
// — a Choice over a known set — and it is the reason this is a sensible
// use of it rather than a fashionable one.
//
// The companion Noul matters as much as the Choice: most steps are not
// worth interrupting for. Reading a file is noise; waiting on a slow
// network call is worth a word. `worthSaying` is read FIRST.

export const VOICE_NARRATION_SEAT = "voice-narration"

/** The things an agent is ever doing, in words a person would use.
 *  Keys are what the model picks; values are what gets spoken. */
export const NARRATION_PHRASES: Record<string, string> = {
  calendar: "checking your calendar",
  email: "going through your email",
  messages: "reading your messages",
  files: "looking through your files",
  search: "searching for that",
  web: "looking it up online",
  code: "going through the code",
  git: "checking the repository",
  infrastructure: "checking the servers",
  writing: "writing that up",
  sending: "sending it",
  scheduling: "setting that up",
  data: "pulling the numbers together",
  waiting: "waiting on a slow response",
  other: "still on it",
}

export const voiceNarrationQuestions = {
  worthSaying: noul(
    "This step is worth interrupting the person to mention out loud.",
    {
      true:
        "It is slow, external, or a visible action with consequences — sending something, waiting on a service, a long search — so a person left in silence would wonder whether anything is happening.",
      false:
        "It is routine internal work: reading a file, a quick lookup, a check that takes a moment. Mentioning it is noise.",
    },
  ),
  doing: choice(
    Object.fromEntries(
      Object.entries(NARRATION_PHRASES).map(([k, v]) => [k, `The agent is ${v}.`]),
    ) as Record<keyof typeof NARRATION_PHRASES & string, string>,
    "What kind of work is this step?",
  ),
}

export type VoiceNarrationAnswers = AnswersFor<typeof voiceNarrationQuestions>

export interface NarrationInput {
  /** Tool name, e.g. Bash, Read, WebSearch. */
  tool: string
  /** The tool's arguments, already summarised. */
  detail: string
  /** Seconds the turn has been running — long waits justify more talking. */
  elapsedSeconds: number
}

export function narrationState(input: NarrationInput): StateValue {
  return {
    tool: input.tool,
    detail: clip(input.detail, 600),
    secondsWaiting: input.elapsedSeconds,
  }
}

export interface NarrationResult {
  /** The phrase to speak, or null when this step is not worth a word. */
  say: string | null
  category: string
  worth: number
}

/**
 * Turn the answers into something to say, or nothing.
 *
 * Silence is the default. The threshold is deliberately above a coin flip:
 * a needless interruption is more annoying than a missed one is confusing,
 * and the widget already shows every step on screen for anyone looking.
 */
export function toNarration(
  answers: VoiceNarrationAnswers,
  minWorth = 0.6,
): NarrationResult {
  const worth = (answers.worthSaying as NoulAnswer).noul
  const pick = answers.doing as ChoiceAnswer
  const category = pick.choice
  return {
    say: worth >= minWorth ? (NARRATION_PHRASES[category] ?? NARRATION_PHRASES.other) : null,
    category,
    worth,
  }
}

function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) : flat
}
