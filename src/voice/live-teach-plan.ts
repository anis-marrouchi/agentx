// The planner's side of live teach: its instructions, and reading its
// reply. Kept apart so live-teach.ts is only the lesson loop.

import { speakable } from "./sentences"
import type { ScreenView, StepAction } from "./live-teach"

export interface Plan { target: number | null; action: StepAction; text: string | null; say: string }

const ACTIONS: StepAction[] = ["point", "highlight", "click", "type", "wait_for_user", "done"]

export function teachSystemPrompt(persona: string, listener: string): string {
  return [
    persona,
    "",
    `[LIVE TEACH] You are teaching ${listener} an app on ${listener}'s screen, one step at a time, out loud. ` +
      "Each turn you get what is on screen now (id, role, label) and what happened so far. Give exactly ONE next step. " +
      "Pick TARGET only from the ids listed; if what is needed is not on screen, pick none and say where to look. " +
      "SAY is one or two short spoken sentences in your own manner: what to do and why, plain words, no ids, no markdown. " +
      "Never claim something happened unless the screen shows it. When the goal is reached, ACTION is done.",
    "Reply with exactly these lines and nothing else:",
    "TARGET: <id or none>",
    "ACTION: point | highlight | click | type | wait_for_user | done",
    "TEXT: <text to type, only for type>",
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

export function screenSignature(s: ScreenView): string {
  return [s.app, s.window ?? "", ...s.candidates.map((c) => `${c.role}|${c.label}|${c.value ?? ""}`)].join("\n")
}
