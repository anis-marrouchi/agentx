import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import { HELPER } from "./screen"

const run = promisify(execFile)

// --- Looking at the screen, as opposed to reading it ---
//
// Three ways to find out what is on a screen, and they answer different
// questions:
//
//   accessibility tree   what EXISTS, and where. Structured and exact.
//                        Silent about anything an app does not publish.
//   OCR                  what is WRITTEN, and where. Local and cheap.
//                        Says nothing about anything that is not text.
//   this file            what it LOOKS LIKE. A recording indicator, a
//                        spinner, a toggle that is on, a red badge, a
//                        window that is covering another one.
//
// The third was missing and the gap was not academic. A lesson told Screen
// Studio to start recording; Screen Studio did not start recording; the
// tree reported one element and OCR read the picker's labels, so nothing
// in the pipeline could tell the difference between "recording" and "not
// recording". The run continued and reported success. An instruction whose
// effect cannot be observed is an instruction that cannot be trusted, and
// every verification we had was really a check that a function returned.
//
// The cost of this one is real — pixels leave the machine — so it is not
// the default sense. The tree is tried first, then OCR, and this is for
// the questions neither can answer.
//
// It reports an OBSERVATION, not a verdict. A vision model asked "is it
// recording" will very often say yes because an app that records is on
// screen, which is a guess about the world dressed as a reading of the
// pixels. So it is asked to name the visible evidence, and to answer
// `unclear` when the deciding detail is not in frame. Turning that
// observation into a calibrated probability is a separate step, in
// seats/screen-state.ts, because those are separate skills.

export type Region =
  | { kind: "window" }
  | { kind: "screen"; index?: number }
  | { kind: "menubar"; index?: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number }

export interface Shot {
  path: string
  region: { x: number; y: number; width: number; height: number }
  bytes: number
}

export interface Sighting {
  question: string
  /** What is visible, factually, in the captured region. */
  observation: string
  /** The specific visual detail the answer rests on. Empty when none was
   *  found — which is the honest outcome when a question cannot be
   *  settled by looking. */
  evidence: string
  /** The vision model's plain reading. NOT calibrated: it is one model's
   *  yes or no, and the caller should prefer the seat's probability when
   *  one is available. */
  reading: "yes" | "no" | "unclear"
  shot: Shot
  model: string
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number }
}

/** Total pixels allowed in an image sent to the model.
 *
 *  A budget on AREA rather than width, because cost tracks area and a
 *  width cap shrinks small regions for no saving. A menu bar strip
 *  (2880x52 here) passes through untouched; a full Retina screen (5.2M
 *  pixels) gets scaled to fit.
 *
 *  Resolution is not only a cost knob. Measured on this machine: macOS
 *  draws the screen-recording indicator as a ~6 point dot, and halving
 *  the resolution of a menu bar capture is the difference between a dot
 *  and a smudge. Keep what is cheap to keep. */
const MAX_PIXELS = 1_200_000

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"

/** Vision-capable and quick. Overridable because this is the kind of
 *  choice that should not need a code change to revisit. */
export const DEFAULT_VISION_MODEL =
  process.env.AGENTX_VISION_MODEL ?? "anthropic/claude-sonnet-5"

/** Capture a region to a downscaled PNG. */
export async function capture(region: Region = { kind: "window" }, maxPixels = MAX_PIXELS): Promise<Shot> {
  if (!existsSync(HELPER)) throw new Error("helper not built — run apps/mac-helper/build.sh")

  const out = join(tmpdir(), `agentx-look-${Date.now()}.png`)
  const args = ["capture", "--out", out, "--max-pixels", String(maxPixels)]
  if (region.kind === "menubar") args.push("--menubar")
  if (region.kind === "screen") args.push("--screen-full")
  if (region.kind === "screen" || region.kind === "menubar") {
    if (region.index !== undefined) args.push("--screen", String(region.index))
  }
  if (region.kind === "rect") {
    args.push("--x", String(region.x), "--y", String(region.y),
              "--w", String(region.width), "--h", String(region.height))
  }

  const { stdout } = await run(HELPER, args)
  const res = JSON.parse(stdout) as {
    ok: boolean
    error?: string
    path: string
    region: { x: number; y: number; w: number; h: number }
  }
  if (!res.ok) throw new Error(res.error ?? "capture failed")

  const bytes = readFileSync(res.path).length
  return {
    path: res.path,
    region: { x: res.region.x, y: res.region.y, width: res.region.w, height: res.region.h },
    bytes,
  }
}

const SYSTEM = `You are reading a screenshot of a macOS screen to answer one question about what is CURRENTLY TRUE on it.

Report only what is visible in this image.

The failure that matters: an application that performs an action is on screen, and you report that the action is happening. Those are different claims. A recorder being open is not a recording in progress. A button existing is not a button that has been pressed. A dialog offering a choice is not a choice that was made.

State indicators are usually small and specific: a coloured dot, a pill or badge in the menu bar, an elapsed timer, a filled or highlighted toggle, a progress bar, a changed icon. If the question turns on such an indicator, say whether you can see it and what it looks like.

Answer "unclear" when the deciding detail is not in frame, too small to read, or covered. "unclear" is a useful answer. A confident guess is not.`

/** Ask a vision model what it sees. */
async function describe(question: string, shot: Shot, model: string, timeoutMs: number) {
  const apiKey = resolveOpenRouterKey()
  if (!apiKey) {
    throw new Error(
      "no OPENROUTER_API_KEY — looking at the screen needs a vision model (set it, or ~/.agentx/openrouter-key.txt)",
    )
  }

  const b64 = readFileSync(shot.path).toString("base64")
  const body = {
    model,
    max_tokens: 700,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `Question: ${question}\n\nThe image is the region ${describeRegion(shot)}.` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    system: SYSTEM,
    tools: [{
      type: "function",
      function: {
        name: "report",
        description: "Report what is visible and how it bears on the question",
        parameters: {
          type: "object",
          properties: {
            observation: {
              type: "string",
              description: "What is visible in the image, factually, in one or two sentences.",
            },
            evidence: {
              type: "string",
              description:
                "The specific visible detail that decides the question — where it is and what it looks like. Empty string if no such detail is visible.",
            },
            reading: {
              type: "string",
              enum: ["yes", "no", "unclear"],
              description: "Answer to the question, or unclear if the pixels do not settle it.",
            },
          },
          required: ["observation", "evidence", "reading"],
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "report" } },
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(OPENROUTER, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // OpenRouter attributes traffic by these; without them calls land
        // in an unnamed bucket and cost cannot be traced back here.
        "HTTP-Referer": "https://github.com/acme/agentx",
        "X-Title": "agentx",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`vision model ${res.status}: ${detail.slice(0, 300)}`)
  }

  const json = (await res.json()) as any
  const call = json?.choices?.[0]?.message?.tool_calls?.[0]
  if (!call?.function?.arguments) {
    throw new Error("vision model returned no structured report")
  }
  const parsed = JSON.parse(call.function.arguments) as {
    observation?: string
    evidence?: string
    reading?: string
  }
  const reading = parsed.reading === "yes" || parsed.reading === "no" ? parsed.reading : "unclear"
  return {
    observation: (parsed.observation ?? "").trim(),
    evidence: (parsed.evidence ?? "").trim(),
    reading: reading as Sighting["reading"],
    model: typeof json.model === "string" ? json.model : model,
    usage: {
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    },
  }
}

export interface LookOptions {
  region?: Region
  model?: string
  maxPixels?: number
  timeoutMs?: number
}

/** Capture a region and report what is visible, against one question. */
export async function look(question: string, opts: LookOptions = {}): Promise<Sighting> {
  const started = Date.now()
  const shot = await capture(opts.region ?? { kind: "window" }, opts.maxPixels ?? MAX_PIXELS)
  const seen = await describe(question, shot, opts.model ?? DEFAULT_VISION_MODEL, opts.timeoutMs ?? 45_000)
  return {
    question,
    observation: seen.observation,
    evidence: seen.evidence,
    reading: seen.reading,
    shot,
    model: seen.model,
    latencyMs: Date.now() - started,
    usage: seen.usage,
  }
}

function describeRegion(shot: Shot): string {
  const { x, y, width, height } = shot.region
  // 40 points tall and starting at the top is the menu bar, and saying so
  // helps: a bare strip of icons is much harder to place than a labelled one.
  if (y <= 1 && height <= 40) return "the macOS menu bar at the top of the screen"
  return `x=${Math.round(x)} y=${Math.round(y)} ${Math.round(width)}x${Math.round(height)} points`
}

let cachedKey: string | null | undefined
function resolveOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  if (cachedKey !== undefined) return cachedKey ?? undefined
  try {
    const raw = readFileSync(join(homedir(), ".agentx", "openrouter-key.txt"), "utf-8").trim()
    cachedKey = raw.length > 0 ? raw : null
  } catch {
    cachedKey = null
  }
  return cachedKey ?? undefined
}
