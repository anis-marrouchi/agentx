import { spawn } from "child_process"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

// --- Whisper transcription drivers ---
//
// Two backends share one tiny interface so the call-side code doesn't care:
//   - "mlx"     → spawns `mlx_whisper` CLI (Apple Silicon native, fast, free)
//   - "openai"  → POSTs WAV to /v1/audio/transcriptions (works anywhere, paid)
//   - "auto"    → tries mlx first; falls back to openai if mlx isn't available
//
// Each backend takes a 16kHz mono WAV buffer and returns transcript text.
// Errors return null instead of throwing so a single bad chunk doesn't take
// down a long call.

export type WhisperBackend = "auto" | "mlx" | "openai"

export interface WhisperOptions {
  backend: WhisperBackend
  /** Whisper model name (mlx) or model id (openai). Default "small". */
  model?: string
  /** Language hint (BCP-47). "auto" lets the model detect. */
  language?: string
  log: (...args: unknown[]) => void
}

export class Whisper {
  private opts: WhisperOptions
  /** Cached probe of which backend actually works. Set on first use. */
  private resolvedBackend: "mlx" | "openai" | null = null

  constructor(opts: WhisperOptions) {
    this.opts = opts
  }

  /** Transcribe a 16kHz mono WAV buffer. Returns trimmed text or null on
   *  failure. Errors are logged once at the call site — never thrown. */
  async transcribe(wav: Buffer): Promise<string | null> {
    const backend = await this.resolveBackend()
    if (!backend) {
      this.opts.log("[whisper] no backend available — chunk dropped")
      return null
    }
    try {
      const text = backend === "mlx"
        ? await this.transcribeMlx(wav)
        : await this.transcribeOpenAI(wav)
      const trimmed = text?.trim() ?? ""
      return trimmed || null
    } catch (e: any) {
      this.opts.log(`[whisper:${backend}] transcription failed: ${e.message}`)
      return null
    }
  }

  /** Decide once which backend to use and cache the answer. */
  private async resolveBackend(): Promise<"mlx" | "openai" | null> {
    if (this.resolvedBackend) return this.resolvedBackend
    const target = this.opts.backend
    if (target === "mlx") {
      this.resolvedBackend = (await this.probeMlx()) ? "mlx" : null
    } else if (target === "openai") {
      this.resolvedBackend = process.env.OPENAI_API_KEY ? "openai" : null
    } else {
      // auto: prefer mlx (no network, no spend)
      if (await this.probeMlx()) this.resolvedBackend = "mlx"
      else if (process.env.OPENAI_API_KEY) this.resolvedBackend = "openai"
    }
    if (!this.resolvedBackend) {
      this.opts.log(`[whisper] backend resolution failed (target=${target}, OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "set" : "unset"})`)
    } else {
      this.opts.log(`[whisper] using backend: ${this.resolvedBackend}`)
    }
    return this.resolvedBackend
  }

  private async probeMlx(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("mlx_whisper", ["--help"], { stdio: "ignore" })
      child.on("error", () => resolve(false))
      child.on("exit", (code) => resolve(code === 0))
    })
  }

  private async transcribeMlx(wav: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentx-whisper-"))
    const wavPath = join(dir, "chunk.wav")
    try {
      await writeFile(wavPath, wav)
      const args = [
        "--model", this.opts.model || "small",
        "--output-format", "txt",
        "--output-dir", dir,
      ]
      if (this.opts.language && this.opts.language !== "auto") {
        args.push("--language", this.opts.language)
      }
      args.push(wavPath)
      const text = await runProcess("mlx_whisper", args)
      // mlx_whisper writes <basename>.txt to the output dir AND echoes to stdout
      // depending on version. Prefer stdout if non-empty.
      if (text.trim()) return text
      // Fallback: read the .txt file
      const { readFile } = await import("fs/promises")
      try {
        return await readFile(join(dir, "chunk.txt"), "utf-8")
      } catch { return "" }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async transcribeOpenAI(wav: Buffer): Promise<string> {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error("OPENAI_API_KEY not set")
    // multipart/form-data without a third-party lib — Node 18+ has FormData/Blob globally.
    const fd = new FormData()
    fd.set("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav")
    fd.set("model", this.opts.model || "whisper-1")
    if (this.opts.language && this.opts.language !== "auto") {
      fd.set("language", this.opts.language)
    }
    fd.set("response_format", "text")
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`)
    }
    return await res.text()
  }
}

function runProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => { out += d.toString() })
    child.stderr.on("data", (d) => { err += d.toString() })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`))
    })
  })
}
