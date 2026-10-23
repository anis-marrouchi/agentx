import { spawn } from "child_process"
import { claudeCliEnv } from "@/utils/workspace-env"

/** One model call: prompt in, text out. Tests pass their own. */
export type ModelCall = (prompt: string, model: string, timeoutMs: number) => Promise<string>

/**
 * One `claude -p` call with no tools. The prompt carries wiki text and
 * lines read from outside systems, so no built-in tool, MCP server, hook
 * or settings file is loaded: an instruction hidden in that text has
 * nothing to run, write or send with. No shell either: the prompt goes
 * in on stdin.
 */
export const claudeModelCall: ModelCall = async (prompt, model, timeoutMs) => (await claudeCall(prompt, model, timeoutMs)).text

/** What the calls of a metered ModelCall spent. */
export interface ModelSpend {
  calls: number
  usd: number
  /** Calls whose reply named no cost: `usd` then counts low. */
  unpriced: number
}

/** claudeModelCall, adding each call's reported cost to `spend`. */
export function meteredModelCall(spend: ModelSpend): ModelCall {
  return async (prompt, model, timeoutMs) => {
    spend.calls++
    let reply: { text: string; costUsd?: number }
    try {
      reply = await claudeCall(prompt, model, timeoutMs)
    } catch (err) {
      // A call that failed (timeout, non-zero exit, model error) may still
      // have spent: its cost is unknown, not zero.
      spend.unpriced++
      throw err
    }
    const { text, costUsd } = reply
    if (costUsd === undefined) spend.unpriced++
    else spend.usd += costUsd
    return text
  }
}

async function claudeCall(prompt: string, model: string, timeoutMs: number): Promise<{ text: string; costUsd?: number }> {
  const args = ["-p", "-", "--output-format", "json", "--max-turns", "1", "--model", model,
    "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true}', "--setting-sources", "", "--no-session-persistence"]
  const out = await new Promise<string>((ok, fail) => {
    const child = spawn("claude", args, { env: claudeCliEnv(), stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })
    child.on("error", (err) => { clearTimeout(timer); fail(err) })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) ok(stdout)
      else fail(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`))
    })
    child.stdin.end(prompt)
  })
  try {
    const envelope = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: unknown }
    if (envelope.is_error) throw new Error(`model error: ${String(envelope.result).slice(0, 200)}`)
    const cost = envelope.total_cost_usd
    return { text: String(envelope.result ?? ""), costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined }
  } catch (err) {
    if (err instanceof SyntaxError) return { text: out }
    throw err
  }
}

/** The first JSON object in a model reply, or null. */
export function firstJsonObject(reply: string): Record<string, unknown> | null {
  const m = reply.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0])
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}
