import chalk from "chalk"
import { execFile } from "child_process"
import { promisify } from "util"
import { createInterface } from "readline"
import { loadDaemonConfig } from "@/daemon/config"
import { talkSpeaker } from "@/voice/agent-voice"
import { HELPER } from "@/computer-use/screen"
import { LiveTeach, teachSystemPrompt, type TeachEvent, type TeachMode } from "@/voice/live-teach"
import { helperAct, readScreenView } from "@/voice/live-teach-screen"
import { PresenceOverlay, presenceLook } from "@/voice/presence"
import { SpeechOut } from "@/voice/speaker"
import { createLineModel } from "@/voice/talk-model"
import { DEFAULT_LISTENER } from "@/voice/talk"

// `agentx teach --live "goal"`: an unscripted lesson in this process. The
// daemon runs the same thing when a voice turn asks for it.

const run = promisify(execFile)

function print(e: TeachEvent): void {
  if (e.type === "step") console.log(`${chalk.cyan(`  ${e.n}. ${e.action}`)}${e.target ? chalk.dim(` "${e.target}"`) : ""}  ${e.say}`)
  else if (e.type === "changed") console.log(chalk.dim(`     ${e.changed ? "screen changed" : "no change"}`))
  else if (e.type === "acted") console.log(e.error ? chalk.red(`     failed: ${e.error}`) : chalk.dim("     done it"))
  else if (e.type === "replanned") console.log(chalk.yellow(`     screen changed, looking again: ${e.reason}`))
  else if (e.type === "door") console.log(chalk.cyan(`  you: ${e.text}`))
  else if (e.type === "error") console.log(chalk.red(`  error: ${e.error}`))
  else if (e.type === "end") console.log(chalk.dim(`  · ended (${e.reason})`))
}

/** The focused app's name, once it matches `name`; null on timeout. */
async function frontmostOnceIs(name: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms
  for (let i = 0; Date.now() < deadline; i++) {
    // Ask again now and then: an app still quitting ignores the first.
    if (i && i % 10 === 0) await run("open", ["-a", name]).catch(() => {})
    try {
      const app = (await readScreenView()).app
      if (app.toLowerCase() === name.replace(/\.app$/i, "").toLowerCase()) return app
    } catch { /* not readable yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

export async function runLiveTeach(goal: string, opts: { agent?: string; mode?: string; app?: string; config?: string; steps?: string }): Promise<void> {
  const config = loadDaemonConfig(opts.config)
  const agentId = opts.agent || process.env.AGENTX_VOICE_AGENT || config.node.defaultAgent
  if (!agentId || !config.agents[agentId]) throw new Error(`Unknown agent: ${agentId}`)
  const mode = (["teach", "watch", "act"].includes(opts.mode ?? "") ? opts.mode : "teach") as TeachMode
  let app: string | undefined
  if (opts.app) {
    // Bring the app forward and wait until it really is: the screen reader
    // reads the focused window, and a cold launch takes a while.
    await run("open", ["-a", opts.app])
    app = (await frontmostOnceIs(opts.app, 15_000)) ?? undefined
    if (!app) throw new Error(`${opts.app} did not come to the front`)
  }
  const speaker = talkSpeaker(agentId, config.agents, false)
  const listener = config.voice.listener ?? DEFAULT_LISTENER
  const look = presenceLook(agentId, config.agents[agentId])
  const t = new LiveTeach(
    { goal, app, mode, speaker, actionsAllowed: look.allowActions, maxSteps: Number(opts.steps) || undefined, listener },
    {
      readScreen: readScreenView,
      presence: new PresenceOverlay(look, HELPER, agentId),
      speech: new SpeechOut(),
      model: createLineModel({ system: teachSystemPrompt(speaker.persona, listener) }),
      act: helperAct,
    },
  )
  t.on(print)
  console.log(chalk.bold(`\n  ${look.name} teaches: ${goal}`) + chalk.dim(`  (${mode}${mode === "act" && !look.allowActions ? ", actions not allowed" : ""}; type to cut in, "stop" to end)\n`))
  const rl = createInterface({ input: process.stdin })
  rl.on("line", (l) => { if (l.trim()) t.door(l) })
  process.once("SIGINT", () => t.stop("interrupted"))
  await t.run()
  rl.close()
}
