// The planner's side of live teach: its instructions, and reading its
// reply. Kept apart so live-teach.ts is only the lesson loop.

import { speakable } from "./sentences"
import type { ScreenView, StepAction } from "./live-teach"

export interface Plan { target: number | null; action: StepAction; text: string | null; say: string }

const ACTIONS: StepAction[] = ["point", "highlight", "click", "type", "key", "wait_for_user", "done"]

export function teachSystemPrompt(persona: string, listener: string): string {
  return [
    persona,
    "",
    `[LIVE TEACH] You are teaching ${listener} an app on ${listener}'s screen, one step at a time, out loud. ` +
      "Each turn you get what is on screen now (id, role, label) and what happened so far. Give exactly ONE next step. " +
      "Pick TARGET only from the ids listed; if what is needed is not on screen, pick none and say where to look. " +
      "For a keyboard shortcut use ACTION key with TEXT like shift+. or cmd+d (the target can be none). " +
      "In a drawing app, clicking the canvas with a shape or text tool places one there. " +
      "SAY sounds like a friend at the keyboard, not a tutorial: one sentence, two at most, under thirty words, plain words, no ids, no markdown. " +
      "Lead with the purpose, then the action and where it is: 'to add a LUT, right-click that node labeled zero one'. " +
      "Your cursor is already on the target, so say 'that' and say where it sits (top right, bottom center, left sidebar); do not recite long labels. " +
      "When it helps, say what they will see next ('you'll see a LUT option in that menu'), then stop. " +
      "Contractions are fine (you'll, that's, I'd). No greetings, no praise or filler (perfect, great, excellent, good), no 'now let's' or 'let me', no step numbers, never 'simply' or 'just'. " +
      `If ${listener} asks a question, answer that question in the SAY and point if pointing helps; do not jump ahead to other steps. ` +
      "If asked to choose, choose: 'I'd go with X', with one reason taken from what is on screen. Do not list options. " +
      `In teach mode, after pointing, use wait_for_user and let ${listener} do it; do not narrate the next step early. ` +
      "Never end with a yes/no question. Never claim something happened unless the screen shows it. " +
      "When the goal is reached, ACTION is done: say so in one line and, if it fits, name one thing worth trying next.",
    "Reply with exactly these lines and nothing else:",
    "TARGET: <id or none>",
    "ACTION: point | highlight | click | type | key | wait_for_user | done",
    "TEXT: <text to type, or the keys for key>",
    "SAY: <what you say>",
  ].join("\n")
}

/** Read the planner's reply; anything malformed becomes a spoken wait. */
export function parsePlan(reply: string, ids: Set<number>): Plan {
  const field = (k: string) => new RegExp(`^\\s*${k}\\s*:\\s*(.*)$`, "im").exec(reply)?.[1]?.trim() ?? ""
  const id = Number.parseInt(field("TARGET"), 10)
  const action = field("ACTION").toLowerCase().replace(/\s+/g, "_") as StepAction
  const text = field("TEXT")
  return {
    target: Number.isFinite(id) && ids.has(id) ? id : null,
    action: ACTIONS.includes(action) ? action : "wait_for_user",
    text: text && !/^(none|n\/a|-)$/i.test(text) ? text : null,
    say: speakable(field("SAY")) || speakable(reply.replace(/^\s*(TARGET|ACTION|TEXT)\s*:.*$/gim, "")),
  }
}

/** What the bubble shows while the voice says the whole line: the
 *  target's name when it is short, otherwise a pointer phrase. Nothing
 *  when there is no target to point at. */
export function bubbleText(label: string | null): string {
  if (label === null) return ""
  const l = label.trim()
  return l && l.length <= 24 ? l : "this one"
}

export function screenSignature(s: ScreenView): string {
  return [s.app, s.window ?? "", ...s.candidates.map((c) => `${c.role}|${c.label}|${c.value ?? ""}`)].join("\n")
}

/**
 * Control `id` of an earlier read, found again in a fresh one, or null
 * when it is gone. Ids are per read, so the match is by role and label;
 * when several match, the one nearest where it was.
 */
export function findControl(before: ScreenView, id: number, after: ScreenView): number | null {
  const c = before.candidates.find((x) => x.id === id)
  if (!c) return null
  const matches = after.candidates.filter((x) => x.role === c.role && x.label === c.label)
  const was = before.rectOf(id)
  if (matches.length <= 1 || !was) return matches[0]?.id ?? null
  const dist = (m: { id: number }) => {
    const r = after.rectOf(m.id)
    return r ? Math.hypot(r.x - was.x, r.y - was.y) : Infinity
  }
  return matches.reduce((a, b) => (dist(b) < dist(a) ? b : a)).id
}
