import { Command } from "commander"
import { execFile, spawn, type ChildProcess } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs"
import { resolve, join } from "path"
import { tmpdir } from "os"
import chalk from "chalk"
import { askSeat } from "@/decisions/seat"
import {
  UI_ELEMENT_SEAT,
  uiElementQuestions,
  uiElementState,
  toSelection,
  type UICandidate,
  type UIElementAnswers,
  type PriorAttempt,
} from "@/decisions/seats/ui-element"
import { HELPER, readScreen, rectFor } from "@/computer-use/screen"
import { verify as verifyClaim } from "@/computer-use/verify"
import { LESSONS, type Lesson, type LessonStep } from "@/teach/lessons"
import { loadDaemonConfig } from "@/daemon/config"
import { pickVoiceId, resolveAgentVoice } from "@/voice/agent-voice"
import { elevenLabsKey } from "@/voice/speaker"

const run = promisify(execFile)

// --- `agentx teach <lesson>` — talk and point, at the same time ---
//
// The difference between this and `agentx point` is when the talking
// happens. An assistant that works in silence and then reports is a tool;
// one that says what it is about to show you WHILE showing you is
// something you can learn from. So each step speaks first, then points at
// the thing it just named, and the label stays on screen while the next
// sentence plays.
//
// Lessons may point, click, type, and press keys. Actions require a fresh
// readiness check and failures stop the lesson.





export const teach = new Command()
  .name("teach")
  .description("walk through something on screen, speaking and pointing as it goes")
  .argument("[lesson]", "lesson id (omit to list)")
  .option("--voice <id>", "ElevenLabs voice id (overrides the agent's)")
  .option("--agent <id>", "speak in this agent's voice (default: AGENTX_VOICE_AGENT or node.defaultAgent)")
  .option("--no-speak", "point only, print the narration")
  .option("--no-hud", "skip the on-screen callout")
  .option("--record", "record the screen (screencapture) around the lesson")
  .option("--record-dir <path>", "where to write the recording")
  .action(async (lessonId: string | undefined, opts) => {
    if (!lessonId) {
      console.log(chalk.bold("\n  lessons\n"))
      for (const l of LESSONS) {
        console.log(`  ${chalk.cyan(l.id.padEnd(22))} ${l.title}`)
        console.log(`  ${" ".repeat(22)} ${chalk.dim(l.appHint)}\n`)
      }
      return
    }
    const lesson = LESSONS.find((l) => l.id === lessonId)
    if (!lesson) {
      console.log(chalk.red(`  no lesson "${lessonId}" — run \`agentx teach\` to list them`))
      process.exit(1)
    }
    if (!existsSync(HELPER)) {
      console.log(chalk.red("  helper not built — run apps/mac-helper/build.sh"))
      process.exit(1)
    }

    const voiceId = opts.speak === false ? undefined : lessonVoice(opts.voice, opts.agent)

    console.log(chalk.bold(`\n  ${lesson.title}`))
    console.log(chalk.dim(`  ${lesson.appHint}\n`))

    try {
      if (lesson.start) {
        await run("/usr/bin/open", openArgs(lesson.start))
        await sleep(2000)
        await requireReady(lesson.start.ready)
      }
    } catch (e: any) {
      console.log(chalk.red(`  setup stopped: ${e?.message ?? e}`))
      process.exitCode = 3
      return
    }

    // Recording uses screencapture, not Screen Studio.
    //
    // Screen Studio's ⌘⌥3 DOES fire — it opens a picker, with a "Start
    // Recording" window and a display highlighter. But the picker needs
    // confirming, Return does not confirm it, and the window exposes no
    // accessibility children at all (it is Electron, like VS Code), so
    // there is nothing to locate and click. Driving it would mean clicking
    // blind at a hardcoded offset, which breaks the first time the app
    // moves a button.
    //
    // screencapture ships with macOS, takes a path, and either produces a
    // file or does not. Opt-in either way: a tool that silently starts
    // capturing the screen is not one anybody should have to think twice
    // about.
    let recorder: ChildProcess | null = null
    let recordingPath: string | null = null
    if (opts.record) {
      recordingPath = join(
        opts.recordDir || process.cwd(),
        `teach-${lesson.id}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.mov`,
      )
      console.log(chalk.dim(`  recording → ${recordingPath}`))
      // -v video, -x silent (no shutter sound in the take), -C shows the
      // cursor, which is the entire point of a pointing lesson.
      recorder = spawn("/usr/sbin/screencapture", ["-v", "-x", "-C", recordingPath], {
        stdio: ["pipe", "ignore", "ignore"],
      })
      // The first frames land before capture is actually running.
      await sleep(2000)
    }

    // A callout that persists while the speech moves on. Spawned once and
    // fed lines, not respawned per step — a fresh window each time would
    // flash and lose its place.
    const hud: ChildProcess | null = opts.hud === false
      ? null
      : spawn(HELPER, ["hud"], { stdio: ["pipe", "ignore", "ignore"] })
    // `avoid` carries the rectangle about to be highlighted, so the
    // callout steps out of its way. Without it the callout sat on top of
    // the very control the lesson was pointing at — invisible to a click,
    // and completely in the way of a person.
    const setState = (
      title: string, body: string, state: string,
      avoid?: { x: number; y: number; w: number; h: number },
    ) => {
      try {
        hud?.stdin?.write(JSON.stringify({ title, body, state, avoid }) + "\n")
      } catch { /* HUD is optional */ }
    }

    // What has been tried on this screen, carried between lookups.
    const attempts: PriorAttempt[] = []
    /** Set when a verify step refused to confirm, so the ending does not
     *  claim success and the exit code says so. */
    let stopped = false

    try {
    for (const [i, step] of lesson.steps.entries()) {
      console.log(`  ${chalk.dim(String(i + 1).padStart(2))}  ${step.say}`)
      setState(`Step ${i + 1} of ${lesson.steps.length}`, step.say, "talking")

      if (step.click || step.type || step.key) {
        if (!step.before) throw new Error(`Step ${i + 1} needs a before claim`)
        await requireReady(step.before)
      }

      // Speak first, then point. Saying "look at the search box" AFTER
      // highlighting it is backwards — the eye has already moved and the
      // sentence arrives as confirmation instead of direction.
      const speaking = opts.speak === false
        ? Promise.resolve()
        : speak(step.say, voiceId)

      // Locate while the sentence is still playing, so the highlight
      // lands as the sentence ends rather than after a pause.
      const target = step.find ? await locate(step.find, attempts) : null
      if (step.find && !target) {
        attempts.push({ tried: step.find, changed: false, note: "not found on screen" })
        // Say so rather than silently skipping: a lesson that points at
        // nothing and carries on is worse than one that admits the screen
        // is not where it expected.
        await speaking
        throw new Error(`Could not find "${step.find}"; stopped before acting`)
      }
      await speaking

      if (target) {
        setState(`Step ${i + 1} of ${lesson.steps.length}`, step.say, "pointing",
                 { x: target.x, y: target.y, w: target.width, h: target.height })
        await run(HELPER, [
          "point",
          "--x", String(target.x), "--y", String(target.y),
          "--w", String(target.width), "--h", String(target.height),
          "--label", step.label ?? step.find ?? "",
          // Short hold when something follows immediately — the highlight
          // should not still be up while text is being typed elsewhere.
          "--hold", String(step.click || step.type ? 0.5 : step.holdSeconds ?? 2.6),
        ])
        if (step.click) {
          const { error: err, changed } = await act(["click"])
          if (err) throw new Error(err)
          // What actually happened feeds the next lookup, so a control
          // that did nothing is not chosen again.
          attempts.push({
            tried: step.label ?? step.find ?? "control",
            changed: changed !== false,
            note: err ?? undefined,
          })
          if (changed === false) {
            console.log(chalk.yellow(`      · clicked, but the screen did not change`))
          }
          // Clicking a link navigates. Give the page a beat, then the next
          // step re-reads the screen rather than acting on a stale tree.
          await sleep(step.afterClickWaitMs ?? 1500)
        }
      }

      // Errors here are REPORTED, never swallowed.
      //
      // These calls used to end in .catch(() => {}), so the focus gate
      // refusing to type looked exactly like typing successfully: the
      // lesson narrated "watch me type this", typed nothing, and carried
      // on. A safety check whose refusal is invisible teaches the operator
      // that the feature is broken rather than that it was protected.
      if (step.type) {
        await requireReady(step.before!)
        setState(`Step ${i + 1} of ${lesson.steps.length}`, step.type, "typing")
        const { error: err } = await act(["type", "--text", step.type])
        if (err) {
          console.log(chalk.red(`      ✗ ${err}`))
          setState("Blocked", err, "waiting")
          attempts.push({ tried: `type into ${step.label ?? "the field"}`, changed: false, note: err })
          throw new Error(err)
        }
      }
      if (step.key) {
        await requireReady(step.before!)
        setState(`Step ${i + 1} of ${lesson.steps.length}`, `↵ ${step.key}`, "typing")
        const { error: err } = await act(["key", "--name", step.key])
        if (err) {
          console.log(chalk.red(`      ✗ ${err}`))
          setState("Blocked", err, "waiting")
          attempts.push({ tried: `press ${step.key}`, changed: false, note: err })
          throw new Error(err)
        }
      }
      if (!target && !step.type && !step.key) await sleep((step.holdSeconds ?? 1.2) * 1000)
      else if (step.holdSeconds) await sleep(step.holdSeconds * 1000)

      // Did it actually work?
      //
      // Everything above reports whether a CALL succeeded. This is the
      // only thing in the loop that asks whether the screen agrees, and it
      // runs last so the page has settled. A refuted or inconclusive claim
      // stops the lesson: continuing would narrate a result nobody
      // verified, which is the failure this whole path exists to prevent.
      if (step.verify) {
        setState(`Step ${i + 1} of ${lesson.steps.length}`, "Checking that worked…", "waiting")
        let checked
        try {
          checked = await verifyClaim(step.verify)
        } catch (e: any) {
          checked = null
          console.log(chalk.yellow(`      ? could not check: ${e?.message ?? e}`))
        }
        if (!checked && !step.verifyOptional) throw new Error(`Could not verify: ${step.verify}`)
        if (checked) {
          const mark = checked.outcome === "confirmed" ? chalk.green("✓")
            : checked.outcome === "refuted" ? chalk.red("✗") : chalk.yellow("?")
          console.log(`      ${mark} ${chalk.dim(checked.reason)}`)
          if (!checked.ok && !step.verifyOptional) {
            setState("Stopped", `That did not work: ${step.verify}`, "waiting")
            console.log(chalk.red(`\n  stopping: could not confirm — ${step.verify}`))
            console.log(chalk.dim(`  ${checked.reason}`))
            console.log(chalk.dim(`  screenshot: ${checked.sighting.shot.path}`))
            await sleep(2500)
            try { hud?.stdin?.end() } catch { /* already gone */ }
            stopped = true
            break
          }
        }
      }
    }
    } catch (e: any) {
      stopped = true
      console.log(chalk.red(`  stopping: ${e?.message ?? e}`))
      setState("Stopped", String(e?.message ?? e), "waiting")
    } finally {
      if (stopped) { try { hud?.stdin?.end() } catch { /* already gone */ } }
    }
    if (!stopped) {
      setState("Done", lesson.title, "done")
      await sleep(1200)
      try { hud?.stdin?.end() } catch { /* already gone */ }
    }

    if (recorder && recordingPath) {
      // screencapture -v stops cleanly on SIGINT and finalises the file;
      // SIGTERM leaves an unplayable container.
      recorder.kill("SIGINT")
      await sleep(2500)
      try {
        const { size } = statSync(recordingPath)
        console.log(chalk.green(`  recorded ${(size / 1_048_576).toFixed(1)} MB → ${recordingPath}`))
      } catch {
        console.log(chalk.yellow("  recording produced no file — check Screen Recording permission"))
      }
    }
    // The recording is finalised either way — a take of the failure is
    // more useful than no take at all.
    if (stopped) {
      console.log(chalk.red(`  lesson stopped before the end.\n`))
      process.exitCode = 3
      return
    }
    console.log(chalk.green(`\n  done.\n`))
  })

/** `cleanWindow` opens a throwaway Chrome profile in app mode. An everyday
 *  window's tabs, bookmarks and extensions fill the screen reader's
 *  candidate budget before the page does, and would end up in recordings.
 *  The window starts below the HUD's top-centre band: over a page's top
 *  navigation, the callout hides the tabs the lesson is looking for. */
export function openArgs(start: NonNullable<Lesson["start"]>): string[] {
  if (!start.cleanWindow) return ["-a", start.app, start.url]
  return [
    "-na", start.app, "--args",
    `--user-data-dir=${join(tmpdir(), "agentx-teach-chrome")}`,
    "--no-first-run", "--no-default-browser-check",
    "--window-position=0,200", "--window-size=1440,680",
    `--app=${start.url}`,
  ]
}

async function requireReady(claim: string): Promise<void> {
  const result = await verifyClaim(claim)
  if (!result.ok) throw new Error(`Not ready: ${claim}. ${result.reason}`)
}

/** Run a helper verb. Returns the error message, or null on success, plus
 *  whether the screen actually changed when the verb reports it. */
async function act(argv: string[]): Promise<{ error: string | null; changed?: boolean }> {
  try {
    const { stdout } = await run(HELPER, argv)
    const parsed = JSON.parse(stdout || "{}")
    if (parsed.ok === false) return { error: String(parsed.error ?? "refused") }
    return { error: null, changed: parsed.changed }
  } catch (e: any) {
    // A non-zero exit still carries the JSON on stdout.
    try {
      const parsed = JSON.parse(e?.stdout || "{}")
      if (parsed.error) return { error: String(parsed.error) }
    } catch { /* not JSON */ }
    return { error: e?.message ?? "failed" }
  }
}

interface Located { x: number; y: number; width: number; height: number }

/** Read the screen and ask which control the description names.
 *
 *  Uses the same reader as `agentx point`, so a lesson gets the OCR
 *  fallback too. Before this, teach read the tree directly: it had the
 *  attempt history but no eyes, while point had eyes and no history, and
 *  neither had both. */
async function locate(description: string, priorAttempts: PriorAttempt[] = []): Promise<Located | null> {
  try {
    const screen = await readScreen({ max: 45 })
    if (screen.candidates.length < 2) return null

    const result = await askSeat(
      UI_ELEMENT_SEAT,
      uiElementState({
        request: description,
        app: screen.app,
        window: screen.window,
        candidates: screen.candidates,
        priorAttempts,
      }),
      uiElementQuestions(screen.candidates),
      { features: { app: screen.app, via: "teach", ocr: screen.usedOCR } },
    )
    if (!result) return null
    const sel = toSelection(result.answers as UIElementAnswers, screen.candidates)
    // The `present` Noul first, always — a Choice will name something even
    // when the thing is not on screen.
    if (sel.present < 0.5) return null
    return rectFor(screen, sel.id)
  } catch {
    return null
  }
}

/**
 * The same resolution the voice widget gets from /ask: --voice, then the
 * agent's configured voice, then AGENTX_VOICE_ID, then the default. No
 * readable agentx.json is not an error — the lesson still speaks.
 */
function lessonVoice(explicit?: string, agentId?: string): string {
  if (explicit) return pickVoiceId(explicit)
  try {
    const config = loadDaemonConfig()
    const id = agentId || process.env.AGENTX_VOICE_AGENT || config.node.defaultAgent
    if (id && !config.agents[id]) console.log(chalk.yellow(`  no agent "${id}" in agentx.json — using the default voice`))
    const agent = id ? config.agents[id] : undefined
    return pickVoiceId(null, id && agent ? resolveAgentVoice(id, agent).elevenlabsVoiceId : null)
  } catch (e: any) {
    console.log(chalk.dim(`  no agent voice (${String(e?.message ?? e).split("\n")[0]}) — using the default`))
    return pickVoiceId()
  }
}

/** ElevenLabs, falling back to `say` — the lesson matters more than the voice. */
async function speak(text: string, voiceId?: string): Promise<void> {
  const key = elevenLabsKey()
  if (key) {
    try {
      const voice = voiceId || pickVoiceId()
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
      })
      if (res.ok) {
        const file = join(tmpdir(), `agentx-teach-${Date.now()}.mp3`)
        writeFileSync(file, Buffer.from(await res.arrayBuffer()))
        await run("/usr/bin/afplay", [file])
        try { unlinkSync(file) } catch { /* temp file */ }
        return
      }
    } catch { /* fall through to say */ }
  }
  await run("/usr/bin/say", [text]).catch(() => {})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export type { Lesson, LessonStep }
