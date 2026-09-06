import { Command } from "commander"
import { open } from "fs/promises"
import { registrationSchema, stopSchema } from "@/daemon/session-monitor"
import { configuredDaemonPort } from "@/attach/install"

export const monitor = new Command("monitor").description("Register external CLI sessions and report ended runs to the briefing")
const defaultUrl = process.env.AGENTX_DAEMON_URL || `http://127.0.0.1:${configuredDaemonPort()}`
async function post(url: string, path: string, body: unknown) {
  const token = process.env.MESH_TOKEN
  const res = await fetch(url.replace(/\/$/, "") + "/monitor/" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Monitor HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
}
monitor.command("register").requiredOption("--session <id>", "Native session ID")
  .requiredOption("--runtime <name>", "claude, codex, gemini, opencode, or another CLI")
  .requiredOption("--label <label>", "Human-readable task label").option("--url <url>", "Daemon URL", defaultUrl)
  .action(async opts => {
    try {
      await post(opts.url, "register", registrationSchema.parse({ id: opts.session, runtime: opts.runtime, label: opts.label }))
      console.log("Session registered. Report each stopped run with agentx monitor ended.")
    } catch (e: any) { console.error(e.message); process.exitCode = 1 }
  })
monitor.command("ended").requiredOption("--session <id>", "Registered session ID")
  .requiredOption("--run <id>", "Stable unique turn ID; reuse this ID when retrying delivery")
  .requiredOption("--transcript <file>", "Local transcript file; only the last 90 KB is submitted")
  .option("--url <url>", "Daemon URL", defaultUrl)
  .action(async opts => {
    try {
      const file = await open(opts.transcript, "r")
      let transcript: string
      try {
        const stat = await file.stat()
        if (!stat.isFile()) throw new Error("Transcript must be a regular file")
        const bytes = Math.min(stat.size, 90000)
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await file.read(buffer, 0, bytes, Math.max(0, stat.size - bytes))
        transcript = (stat.size > bytes ? "[Transcript truncated: last 90 KB only]\n" : "") + buffer.subarray(0, bytesRead).toString("utf8")
      } finally { await file.close() }
      await post(opts.url, "ended", stopSchema.parse({ sessionId: opts.session, runId: opts.run, transcript }))
      console.log("Run queued for review.")
    } catch (e: any) { console.error(e.message); process.exitCode = 1 }
  })
