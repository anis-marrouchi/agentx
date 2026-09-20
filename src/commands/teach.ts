import { Command } from "commander"
import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
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
} from "@/decisions/seats/ui-element"
import { buildCandidates } from "@/computer-use/candidates"
import { LESSONS, type Lesson, type LessonStep } from "@/teach/lessons"

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
// Deliberately read-only: it points, it never clicks or types. The person
// keeps the keyboard, which is what makes it teaching rather than a
// demonstration you watch.

const HELPER = resolve(
  process.cwd(),
  "apps/mac-helper/build/AgentX Helper.app/Contents/MacOS/agentx-mac-helper",
)



export const teach = new Command()
  .name("teach")
  .description("walk through something on screen, speaking and pointing as it goes")
  .argument("[lesson]", "lesson id (omit to list)")
  .option("--voice <id>", "ElevenLabs voice id")
  .option("--no-speak", "point only, print the narration")
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

    console.log(chalk.bold(`\n  ${lesson.title}`))
    console.log(chalk.dim(`  ${lesson.appHint}\n`))

    for (const [i, step] of lesson.steps.entries()) {
      console.log(`  ${chalk.dim(String(i + 1).padStart(2))}  ${step.say}`)

      // Speak first, then point. Saying "look at the search box" AFTER
      // highlighting it is backwards — the eye has already moved and the
      // sentence arrives as confirmation instead of direction.
      const speaking = opts.speak === false
        ? Promise.resolve()
        : speak(step.say, opts.voice)

      if (step.find) {
        // Read the screen while the sentence is still playing, so the
        // highlight lands as the sentence ends rather than after a pause.
        const target = await locate(step.find)
        await speaking
        if (target) {
          await run(HELPER, [
            "point",
            "--x", String(target.x), "--y", String(target.y),
            "--w", String(target.width), "--h", String(target.height),
            "--label", step.label ?? step.find,
            "--hold", String(step.holdSeconds ?? 2.6),
          ]).catch(() => {})
        } else {
          // Say so rather than silently skipping: a lesson that points at
          // nothing and carries on is worse than one that admits the
          // screen is not where it expected.
          console.log(chalk.yellow(`      (couldn't find "${step.find}" on screen — narrating only)`))
        }
      } else {
        await speaking
        await sleep((step.holdSeconds ?? 1.2) * 1000)
      }
    }
    console.log(chalk.green(`\n  done.\n`))
  })

interface Located { x: number; y: number; width: number; height: number }

/** Read the screen and ask which control the description names. */
async function locate(description: string): Promise<Located | null> {
  try {
    const { stdout } = await run(HELPER, ["read", "--max", "400"])
    const snap = JSON.parse(stdout) as {
      app: string
      window?: string | null
      elements: Array<UICandidate & Located>
    }
    const candidates: UICandidate[] = buildCandidates(snap.elements as never, 45)
    if (candidates.length < 2) return null

    const result = await askSeat(
      UI_ELEMENT_SEAT,
      uiElementState({ request: description, app: snap.app, window: snap.window, candidates }),
      uiElementQuestions(candidates),
      { features: { app: snap.app, via: "teach" } },
    )
    if (!result) return null
    const sel = toSelection(result.answers as UIElementAnswers, candidates)
    // The `present` Noul first, always — a Choice will name something even
    // when the thing is not on screen.
    if (sel.present < 0.5) return null
    const el = snap.elements.find((e) => e.id === sel.id)
    return el ? { x: el.x, y: el.y, width: el.width, height: el.height } : null
  } catch {
    return null
  }
}

/** ElevenLabs, falling back to `say` — the lesson matters more than the voice. */
async function speak(text: string, voiceId?: string): Promise<void> {
  const key = elevenLabsKey()
  if (key) {
    try {
      const voice = voiceId || process.env.AGENTX_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"
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

function elevenLabsKey(): string | null {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  for (const p of [
    `${process.env.HOME}/.elevenlabs/key`,
    `${process.env.HOME}/.agentx/elevenlabs-key.txt`,
  ]) {
    try {
      const v = readFileSync(p, "utf8").trim()
      if (v) return v
    } catch { /* next */ }
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export type { Lesson, LessonStep }
