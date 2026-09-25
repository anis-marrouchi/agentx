import chalk from "chalk"
import { execFile } from "child_process"
import { copyFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import { promisify } from "util"
import { loadDaemonConfig } from "@/daemon/config"
import { HELPER } from "@/computer-use/screen"
import { PresenceOverlay, presenceLook } from "@/voice/presence"
import { createLineModel } from "@/voice/talk-model"
import { drawLive, type DrawEvent } from "@/teach/draw"
import { drawSystemPrompt } from "@/teach/draw-plan"
import { TldrawApi, TLDRAW_SERVER_JSON } from "@/teach/tldraw-api"

// `agentx teach --live "goal" --mode draw`: the agent plans an illustration
// in one model turn and draws it into a new tldraw offline document, with
// its presence cursor moving over each shape as it appears.

const run = promisify(execFile)
export const DRAW_MODEL = "claude-sonnet-5"

function print(e: DrawEvent): void {
  if (e.type === "planned") console.log(chalk.dim(`     planned ${e.n}: ${e.el.kind} ${e.el.id} at ${(e.atMs / 1000).toFixed(1)} s`))
  else if (e.type === "drawn") console.log(`${chalk.cyan(`  ${e.n}. ${e.el.kind} ${e.el.id}`)}  ${e.el.say}${chalk.dim(`  (${(e.ms / 1000).toFixed(1)} s)`)}`)
  else if (e.type === "skipped") console.log(chalk.yellow(`     skipped: ${e.line}`))
  else console.log(chalk.red(`  error: ${e.error}`))
}

async function ensureTldraw(): Promise<void> {
  if (existsSync(TLDRAW_SERVER_JSON)) return
  await run("open", ["-a", "tldraw offline"])
  for (let i = 0; i < 40 && !existsSync(TLDRAW_SERVER_JSON); i++) await new Promise((r) => setTimeout(r, 500))
  if (!existsSync(TLDRAW_SERVER_JSON)) throw new Error("tldraw offline did not start")
}

export async function runLiveDraw(goal: string, opts: { agent?: string; config?: string; model?: string; out?: string }): Promise<void> {
  const config = loadDaemonConfig(opts.config)
  const agentId = opts.agent || process.env.AGENTX_VOICE_AGENT || config.node.defaultAgent
  if (!agentId || !config.agents[agentId]) throw new Error(`Unknown agent: ${agentId}`)
  const model = opts.model || DRAW_MODEL
  const out = resolve(opts.out || join(homedir(), "Documents"))
  const look = presenceLook(agentId, config.agents[agentId])

  // Warm the model while the document opens; its first turn waits for it.
  const line = createLineModel({ system: drawSystemPrompt(), model })
  const presence = new PresenceOverlay(look, HELPER, agentId)
  const api = new TldrawApi()
  try {
    await ensureTldraw()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
    const doc = await api.createDoc(`agentx-draw-${stamp}`, out)
    // The new window mounts its editor a moment after the file opens.
    await new Promise((r) => setTimeout(r, 800))
    console.log(chalk.bold(`\n  ${look.name} draws: ${goal}`) + chalk.dim(`  (${model}, ${doc.filePath})\n`))

    const ac = new AbortController()
    process.once("SIGINT", () => ac.abort())
    const r = await drawLive(goal, { api, presence, model: line }, { docId: doc.id, signal: ac.signal }, print)

    await api.exec(doc.id, "await helpers.saveDoc(); return true")
    const shot = await api.search<{ filePath: string }>(`return await api.getScreenshot(${JSON.stringify(doc.id)}, { size: 'full' })`)
    const picture = doc.filePath ? doc.filePath.replace(/\.tldraw$/, ".jpg") : join(out, `agentx-draw-${stamp}.jpg`)
    copyFileSync(shot.filePath, picture)

    console.log(chalk.bold(`\n  ${r.steps} steps in ${(r.totalMs / 1000).toFixed(1)} s`) + chalk.dim(
      `  (first shape planned at ${r.firstLineMs === null ? "–" : (r.firstLineMs / 1000).toFixed(1)} s, plan done at ${(r.planMs / 1000).toFixed(1)} s)`))
    console.log(chalk.dim(`  ${doc.filePath}\n  ${picture}\n`))
  } finally {
    line.close()
    presence.close()
  }
}
