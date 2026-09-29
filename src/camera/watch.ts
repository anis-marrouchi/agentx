import { lstatSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import type { VideoFrame } from "@/channels/webrtc-bot"
import type { CameraBotConfig } from "@/daemon/config"
import { FrameSampler, type Sampled } from "./sampler"
import { frameToPng, type I420Frame, type RgbaImage } from "./frame-image"

// --- An agent watches the phone camera (#325 phase 2) ---
//
// One watch per share: a server-side WebRTC bot receives the phone's video
// and a FrameSampler keeps only the newest frame. A frame reaches the agent
// in two ways, never as a stream:
//   - on demand: the owner taps "Look now" (look), or the agent asks for
//     the newest frame from inside its own turn (snapshot);
//   - by itself, every camera.bot.frameIntervalSeconds when that is set.
// A frame is written as a PNG under <workspace>/.agentx/camera/<callId>/
// and its absolute path goes in the agent's message, so a Claude Code
// tier agent opens it with its Read tool. Unless camera.bot.keepFrames is
// on, the folder is deleted when the watch ends. The watch ends when the
// phone stops, when the owner stops it, or after camera.bot.maxSessionMinutes.

export interface TurnSession {
  channel: string
  chatId: string
  sender: string
}

export interface FrameFile {
  /** Absolute path of the PNG. */
  path: string
  width: number
  height: number
  /** When the frame arrived, ms since the epoch. */
  takenAt: number
  /** Which received frame it is. */
  seq: number
}

export interface WatchReply {
  at: number
  /** What the owner asked, or null for a frame handed over by itself. */
  note: string | null
  text: string
  /** File name of the frame it answers. */
  frame: string
}

export interface WatchView {
  callId: string
  agentId: string
  agentName: string
  startedAt: number
  /** When the watch ends by itself. */
  until: number
  /** Frames received from the phone so far. */
  frames: number
  /** Frames handed to the agent so far. */
  looks: number
  replies: WatchReply[]
  session: TurnSession
  /** The camera ask this watch answers (phase 3), or null for a share the owner started. */
  callRecordId: string | null
}

export interface CameraBotHandle {
  close(reason: string): void
}

export type WatchResult<T> = { ok: true } & T | { ok: false; status: number; error: string }

export interface CameraWatchDeps {
  config: () => CameraBotConfig
  /** Open a video-receiving bot peer for this share. `onFrame` gets every
   *  decoded frame; `onClosed` fires once when the peer goes away. */
  startBot: (o: { callId: string; agentId: string; onFrame: (f: VideoFrame) => void; onClosed: (reason: string) => void }) => Promise<CameraBotHandle>
  /** The agent's workspace folder, or null for an agent that has none here. */
  workspaceOf: (agentId: string) => string | null
  /** The agent's display name, or null when there is no such agent. */
  agentName: (agentId: string) => string | null
  /** Run one turn of the agent in `session`; its reply, or null on error. */
  turn: (o: { agentId: string; message: string; session: TurnSession }) => Promise<string | null>
  /** Where a reply to a frame handed over by itself goes (the owner did not ask). */
  deliver?: (watch: WatchView, reply: WatchReply) => void | Promise<void>
  onEnded?: (watch: WatchView, reason: string) => void
  /** Native I420 → RGBA when available; the pure JavaScript one otherwise. */
  toRgba?: (f: I420Frame) => RgbaImage
  cwd?: () => string
  now?: () => number
  log?: (m: string) => void
}

export const NOTE_MAX = 300
const REPLIES_KEPT = 20
export const CALL_ID = /^[A-Za-z0-9_-]{4,64}$/
/** The session a share the owner started runs in: the same one the voice
 *  widget and calls use, so a spoken follow-up lands with the picture. */
export const defaultSession = (agentId: string): TurnSession => ({ channel: "voice", chatId: `voice:${agentId}`, sender: "Camera" })

/** The agent's message for one frame. */
export function framePrompt(o: { path: string; width: number; height: number; takenAt: number; note?: string | null }): string {
  const ask = o.note ? `The owner asks: "${o.note}"` : "Describe what you see, briefly."
  return "[Camera] The owner is showing you their phone camera. " +
    `The newest frame (${o.width}x${o.height} PNG, taken ${new Date(o.takenAt).toLocaleTimeString()}) is saved at:\n${o.path}\n` +
    `Open it with your Read tool and look at it. ${ask} Answer in two or three plain sentences, ` +
    "and say so if the picture is too dark or blurred to tell."
}

interface Watch {
  view: WatchView
  sampler: FrameSampler<VideoFrame>
  bot: CameraBotHandle
  dir: string
  timer: ReturnType<typeof setTimeout>
  /** Frame files written, by seq, so a look and a snapshot of the same frame share one file. */
  files: Map<number, FrameFile>
  ending: boolean
}

export class CameraWatchManager {
  private watches: Map<string, Watch> = new Map()

  constructor(private deps: CameraWatchDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private log(m: string): void { this.deps.log?.(`[camera] ${m}`) }

  /** Start watching a share: the phone will answer the bot's offer. */
  async start(input: { callId?: unknown; agentId?: unknown; session?: TurnSession; callRecordId?: string }): Promise<WatchResult<{ watch: WatchView }>> {
    const callId = String(input.callId ?? "")
    const agentId = String(input.agentId ?? "").trim()
    if (!CALL_ID.test(callId)) return { ok: false, status: 400, error: "callId must be 4 to 64 letters, digits, - or _" }
    const agentName = agentId ? this.deps.agentName(agentId) : null
    if (agentName === null) return { ok: false, status: 404, error: `Unknown agent: ${agentId || "(none)"}` }
    if (this.watches.has(callId)) return { ok: false, status: 409, error: "an agent is already watching this share" }
    if (this.forAgent(agentId)) return { ok: false, status: 409, error: `${agentId} is already watching a camera; stop that share first` }
    const workspace = this.deps.workspaceOf(agentId)
    if (!workspace) return { ok: false, status: 409, error: `${agentId} has no workspace to keep frames in` }
    let dir: string
    try {
      dir = this.frameDir(workspace, callId)
    } catch (e: any) {
      return { ok: false, status: 500, error: e?.message ?? String(e) }
    }

    const cfg = this.deps.config()
    const startedAt = this.now()
    const view: WatchView = {
      callId, agentId, agentName, startedAt, until: startedAt + cfg.maxSessionMinutes * 60_000,
      frames: 0, looks: 0, replies: [], session: input.session ?? defaultSession(agentId),
      callRecordId: input.callRecordId ?? null,
    }
    const sampler = new FrameSampler<VideoFrame>({
      intervalMs: cfg.frameIntervalSeconds * 1000,
      onSample: (s) => this.sample(callId, s),
      now: () => this.now(),
      log: (m) => this.log(m),
    })
    let bot: CameraBotHandle
    try {
      bot = await this.deps.startBot({
        callId, agentId,
        onFrame: (f) => { sampler.push(f); view.frames = sampler.received },
        onClosed: (reason) => this.stop(callId, reason),
      })
    } catch (e: any) {
      sampler.stop()
      return { ok: false, status: 502, error: `could not join the share: ${e?.message ?? e}` }
    }
    const timer = setTimeout(() => this.stop(callId, `time limit (${cfg.maxSessionMinutes} min)`), cfg.maxSessionMinutes * 60_000)
    timer.unref?.()
    this.watches.set(callId, { view, sampler, bot, dir, timer, files: new Map(), ending: false })
    sampler.start()
    this.log(`${agentId} is watching share ${callId}` + (cfg.frameIntervalSeconds ? ` (a frame every ${cfg.frameIntervalSeconds} s)` : " (frames on demand)"))
    return { ok: true, watch: this.snapshotView(view) }
  }

  /** The owner asks the agent what it sees. Runs one turn and returns the reply. */
  async look(callId: string, note?: unknown): Promise<WatchResult<{ reply: WatchReply; frame: FrameFile }>> {
    const w = this.watches.get(callId)
    if (!w) return { ok: false, status: 404, error: `No agent is watching share ${callId}` }
    const text = String(note ?? "").replace(/\s+/g, " ").trim()
    if (text.length > NOTE_MAX) return { ok: false, status: 413, error: `the note is over ${NOTE_MAX} characters` }
    const latest = w.sampler.take()
    if (!latest) return { ok: false, status: 409, error: "no picture has arrived from the phone yet" }
    const r = await this.handOver(w, latest, text || null)
    if (!r.ok) return r
    return { ok: true, reply: r.reply, frame: r.frame }
  }

  /** The agent, from inside its own turn, asks for the newest frame. The
   *  file stays until the watch ends: the agent reads it in that turn. */
  snapshot(agentId: string): WatchResult<{ frame: FrameFile; callId: string }> {
    const w = this.forAgent(agentId)
    if (!w) return { ok: false, status: 404, error: `No live camera share for ${agentId}. Ask the owner to show you (agentx camera ask).` }
    const latest = w.sampler.take()
    if (!latest) return { ok: false, status: 409, error: "no picture has arrived from the phone yet; try again in a moment" }
    try {
      const frame = this.writeFrame(w, latest)
      w.view.looks++
      return { ok: true, frame, callId: w.view.callId }
    } catch (e: any) {
      return { ok: false, status: 500, error: `could not save the frame: ${e?.message ?? e}` }
    }
  }

  /** End a watch. Idempotent; the bot's own close comes back through here. */
  stop(callId: string, reason = "stopped"): boolean {
    const w = this.watches.get(callId)
    if (!w || w.ending) return false
    w.ending = true
    this.watches.delete(callId)
    clearTimeout(w.timer)
    w.sampler.stop()
    try { w.bot.close(reason) } catch { /* already closed */ }
    if (!this.deps.config().keepFrames) {
      try { rmSync(w.dir, { recursive: true, force: true }) } catch (e: any) { this.log(`could not delete ${w.dir}: ${e?.message ?? e}`) }
    }
    this.log(`${w.view.agentId} stopped watching share ${callId} (${reason}; ${w.view.frames} frames, ${w.view.looks} looks)`)
    try { this.deps.onEnded?.(this.snapshotView(w.view), reason) } catch (e: any) { this.log(`onEnded threw: ${e?.message ?? e}`) }
    return true
  }

  get(callId: string): WatchView | undefined {
    const w = this.watches.get(callId)
    return w ? this.snapshotView(w.view) : undefined
  }

  active(): WatchView[] {
    return [...this.watches.values()].map((w) => this.snapshotView(w.view))
  }

  /** The watch this agent is on, if any. */
  watchingFor(agentId: string): WatchView | undefined {
    const w = this.forAgent(agentId)
    return w ? this.snapshotView(w.view) : undefined
  }

  shutdown(): void {
    for (const id of [...this.watches.keys()]) this.stop(id, "shutdown")
  }

  private forAgent(agentId: string): Watch | undefined {
    for (const w of this.watches.values()) if (w.view.agentId === agentId) return w
    return undefined
  }

  private snapshotView(v: WatchView): WatchView {
    return { ...v, replies: [...v.replies], session: { ...v.session } }
  }

  /** A frame handed over by itself, on the interval. */
  private async sample(callId: string, s: Sampled<VideoFrame>): Promise<void> {
    const w = this.watches.get(callId)
    if (!w) return
    const r = await this.handOver(w, s, null)
    if (!r.ok) { this.log(`interval frame for ${callId} not handed over: ${r.error}`); return }
    try { await this.deps.deliver?.(this.snapshotView(w.view), r.reply) }
    catch (e: any) { this.log(`deliver for ${callId} failed: ${e?.message ?? e}`) }
  }

  /** Write the frame, run the agent's turn on it, record the reply. */
  private async handOver(w: Watch, s: Sampled<VideoFrame>, note: string | null): Promise<WatchResult<{ reply: WatchReply; frame: FrameFile }>> {
    let frame: FrameFile
    try {
      frame = this.writeFrame(w, s)
    } catch (e: any) {
      return { ok: false, status: 500, error: `could not save the frame: ${e?.message ?? e}` }
    }
    w.view.looks++
    const message = framePrompt({ ...frame, note })
    let text: string | null
    try {
      text = await this.deps.turn({ agentId: w.view.agentId, message, session: w.view.session })
    } catch (e: any) {
      text = null
      this.log(`turn for ${w.view.callId} failed: ${e?.message ?? e}`)
    }
    if (!this.deps.config().keepFrames) this.forget(w, frame)
    if (!text?.trim()) return { ok: false, status: 502, error: `${w.view.agentName} did not answer` }
    const reply: WatchReply = { at: this.now(), note, text: text.trim(), frame: frame.path.slice(w.dir.length + 1) }
    w.view.replies.push(reply)
    if (w.view.replies.length > REPLIES_KEPT) w.view.replies.splice(0, w.view.replies.length - REPLIES_KEPT)
    return { ok: true, reply, frame }
  }

  /** The PNG for this frame; one file per received frame. */
  private writeFrame(w: Watch, s: Sampled<VideoFrame>): FrameFile {
    const have = w.files.get(s.seq)
    if (have) return have
    const { png, width, height } = frameToPng(s.frame, { maxEdge: this.deps.config().maxFrameEdge, toRgba: this.deps.toRgba })
    mkdirSync(w.dir, { recursive: true })
    const path = join(w.dir, `frame-${String(s.seq).padStart(6, "0")}.png`)
    writeFileSync(path, png)
    const file: FrameFile = { path, width, height, takenAt: s.receivedAt, seq: s.seq }
    w.files.set(s.seq, file)
    return file
  }

  /** Delete a frame the agent has finished with (keepFrames off). */
  private forget(w: Watch, frame: FrameFile): void {
    if (!w.files.delete(frame.seq)) return
    try { rmSync(frame.path, { force: true }) } catch { /* gone already */ }
  }

  /** <workspace>/.agentx/camera/<callId>, never through a linked `.agentx`. */
  private frameDir(workspace: string, callId: string): string {
    const root = resolve(this.deps.cwd?.() ?? process.cwd(), workspace)
    const link = lstatSync(join(root, ".agentx"), { throwIfNoEntry: false })
    if (link?.isSymbolicLink()) throw new Error(`${join(root, ".agentx")} is a link; frames are not written through it`)
    return join(root, ".agentx", "camera", callId)
  }
}
