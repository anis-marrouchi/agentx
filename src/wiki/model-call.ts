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
export const claudeModelCall: ModelCall = async (prompt, model, timeoutMs) => {
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
    const envelope = JSON.parse(out) as { result?: string; is_error?: boolean }
    if (envelope.is_error) throw new Error(`model error: ${String(envelope.result).slice(0, 200)}`)
    return String(envelope.result ?? "")
  } catch (err) {
    if (err instanceof SyntaxError) return out
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
