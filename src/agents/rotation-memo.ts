import { execFile } from "child_process"
import type { AgentDef } from "@/daemon/config"
import { buildAgentEnv, stripAnthropicApiKey } from "@/utils/workspace-env"

// --- Pre-rotation memo extraction ---
//
// Just before agentx clears `claudeSessionId` (tier-2 / max-turns / stale
// rotation), we ask the dying Claude session to dump the facts and
// decisions it should carry forward. The agent has full working-memory
// of its tool-use history at this moment — the only chance to capture
// it before --resume is dropped and the next turn starts with a blank
// session.
//
// The memo persists into MemoryStore, where the existing findRelevant
// path injects it into future turns naturally. No new wiring on the
// read side; one-shot LLM call on the write side.
//
// Hard rule: never block rotation. Timeout, errors, empty memos all
// mean "skip this round of memo capture". Memory continuity is a
// best-effort enhancement, not a correctness requirement.

const MEMO_TIMEOUT_MS = 30_000
const MEMO_MODEL = "haiku" // cheapest fast model — memo is summarisation, not reasoning

const MEMO_PROMPT =
  "You are about to lose this working session due to context-size rotation. " +
  "Before that happens, write a compact memo of what you should carry forward " +
  "to your next session on the same conversation.\n\n" +
  "Include only durable facts a future turn would otherwise have to rediscover:\n" +
  "- Names, handles, agent ids, telegram/whatsapp/gitlab usernames\n" +
  "- File paths, URLs, project namespaces, ssh hosts, ports\n" +
  "- Decisions made and their reasoning\n" +
  "- Open tasks or commitments to follow up on\n" +
  "- Identifiers (issue numbers, PR numbers, ticket ids) the user referred to\n\n" +
  "Format: 3-12 short bullet points. Each ≤120 chars. No prose, no preamble, " +
  "no header. If the session was uninformative or just casual chat, reply with " +
  "exactly the literal text \"(no memo)\".\n\n" +
  "Begin the memo now."

export interface RotationMemoResult {
  /** The extracted memo text, or null when extraction failed/skipped. */
  memo: string | null
  /** Why we skipped or what happened — "ok", "timeout", "error", "empty", "no-resume". */
  reason: string
  /** Wall-clock time spent in the extractor. */
  durationMs: number
}

/** Ask the dying Claude session for a carry-forward memo. Spawns one
 *  short claude CLI call with --resume on the about-to-be-dropped
 *  session id, asks for a compact memo, returns the text. Never throws
 *  — every failure mode resolves with `memo=null` so the caller can
 *  proceed with the rotation regardless. */
export async function extractRotationMemo(
  agent: AgentDef,
  resumeSessionId: string | undefined,
): Promise<RotationMemoResult> {
  const start = Date.now()
  if (!resumeSessionId) {
    return { memo: null, reason: "no-resume", durationMs: 0 }
  }

  const args: string[] = [
    "-p", MEMO_PROMPT,
    "--output-format", "json",
    "--resume", resumeSessionId,
    "--model", MEMO_MODEL,
  ]
  if (agent.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions")
  }

  const env = stripAnthropicApiKey(buildAgentEnv(agent.workspace))

  return new Promise<RotationMemoResult>((resolve) => {
    let settled = false
    const finish = (memo: string | null, reason: string) => {
      if (settled) return
      settled = true
      resolve({ memo, reason, durationMs: Date.now() - start })
    }

    const child = execFile(
      "claude",
      args,
      {
        cwd: agent.workspace,
        env,
        timeout: MEMO_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1 MB; the memo itself is tiny
      },
      (err, stdout, _stderr) => {
        if (err) {
          // execFile signals timeout via signal SIGTERM + err.killed
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            return finish(null, "timeout")
          }
          return finish(null, `error:${err.message.slice(0, 80)}`)
        }
        try {
          const data = JSON.parse(stdout || "{}")
          // claude -p --output-format json yields { result, ... }
          const text = typeof data.result === "string" ? data.result.trim() : ""
          if (!text || text === "(no memo)") return finish(null, "empty")
          // Defensive cap: memos > 4 KB are almost certainly the LLM
          // ignoring instructions and dumping prose. Truncate.
          const capped = text.length > 4096 ? text.slice(0, 4096) + "…" : text
          return finish(capped, "ok")
        } catch {
          return finish(null, "parse-error")
        }
      },
    )
    child.on("error", () => finish(null, "spawn-error"))
  })
}
