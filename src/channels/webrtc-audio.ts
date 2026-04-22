import type { AudioFrame } from "./webrtc-bot"

// --- Audio buffer with energy-threshold VAD + WAV serialization ---
//
// AudioFrame in: signed 16-bit PCM at the source rate (typically 48kHz from
// WebRTC). Whisper wants 16kHz mono, so we downsample on flush and emit a
// minimal WAV (RIFF) buffer. VAD is energy-threshold on the source samples;
// a chunk closes when we observe a `silenceMs` gap of below-threshold energy
// after at least `minSpeechMs` of speech.
//
// Sufficient for v1 (single speaker per channel, no diarization). Later
// upgrades: swap in webrtcvad / silero-vad, add streaming partial transcripts.

export interface AudioBufferOptions {
  /** Energy threshold (RMS over the int16 range, normalized to [0,1]).
   *  ~0.012 catches normal speech without firing on background noise. */
  energyThreshold?: number
  /** Continuous silence (ms) before closing a chunk. 400ms ≈ pause. */
  silenceMs?: number
  /** Minimum total speech (ms) before a chunk is eligible to close. */
  minSpeechMs?: number
  /** Hard upper bound on chunk length so very long monologues still flush. */
  maxChunkMs?: number
  log: (...args: unknown[]) => void
  /** Fired with a 16kHz mono WAV buffer once a chunk closes. */
  onChunk: (wav: Buffer, durationMs: number) => void | Promise<void>
}

const DEFAULTS = {
  energyThreshold: 0.012,
  silenceMs: 400,
  minSpeechMs: 600,
  maxChunkMs: 15_000,
}

interface ActiveChunk {
  /** Samples accumulated at the source rate, mono (channel-mixed if needed). */
  samples: Int16Array[]
  totalSamples: number
  sourceRate: number
  startedAt: number
  /** Wall-clock ms of the most recent above-threshold frame. */
  lastVoiceAt: number
}

export class AudioChunker {
  private opts: Required<Omit<AudioBufferOptions, "log" | "onChunk">> & Pick<AudioBufferOptions, "log" | "onChunk">
  private active: ActiveChunk | null = null
  private silenceTimer?: ReturnType<typeof setInterval>

  constructor(opts: AudioBufferOptions) {
    this.opts = {
      energyThreshold: opts.energyThreshold ?? DEFAULTS.energyThreshold,
      silenceMs: opts.silenceMs ?? DEFAULTS.silenceMs,
      minSpeechMs: opts.minSpeechMs ?? DEFAULTS.minSpeechMs,
      maxChunkMs: opts.maxChunkMs ?? DEFAULTS.maxChunkMs,
      log: opts.log,
      onChunk: opts.onChunk,
    }
    // Periodic check so the chunk closes even if frames stop arriving
    // (track ended mid-speech, peer dropped, etc.).
    this.silenceTimer = setInterval(() => this.maybeClose(), 100)
  }

  /** Feed a single inbound audio frame. Frames are typically ~10ms each at
   *  48kHz, so this fires often. Cheap path. */
  push(frame: AudioFrame): void {
    const mono = mixToMono(frame.samples, frame.channelCount)
    const energy = rmsNormalized(mono)
    const isSpeech = energy >= this.opts.energyThreshold

    if (!this.active) {
      if (!isSpeech) return  // Don't open a chunk on silence.
      this.active = {
        samples: [],
        totalSamples: 0,
        sourceRate: frame.sampleRate,
        startedAt: frame.receivedAt,
        lastVoiceAt: frame.receivedAt,
      }
    }

    this.active.samples.push(mono)
    this.active.totalSamples += mono.length
    if (isSpeech) this.active.lastVoiceAt = frame.receivedAt
  }

  private maybeClose(): void {
    if (!this.active) return
    const now = Date.now()
    const ageMs = now - this.active.startedAt
    const silenceFor = now - this.active.lastVoiceAt
    const speechMs = ageMs - silenceFor
    if (ageMs >= this.opts.maxChunkMs) {
      this.flush("max-duration")
      return
    }
    if (speechMs >= this.opts.minSpeechMs && silenceFor >= this.opts.silenceMs) {
      this.flush("silence-gap")
    }
  }

  /** Force-close the active chunk and emit it (or do nothing if no audio). */
  flush(reason = "manual"): void {
    if (!this.active) return
    const chunk = this.active
    this.active = null
    const ageMs = Date.now() - chunk.startedAt
    if (chunk.totalSamples === 0) return
    const merged = concatInt16(chunk.samples, chunk.totalSamples)
    const downsampled = downsampleTo16k(merged, chunk.sourceRate)
    const wav = encodeWav(downsampled, 16_000)
    this.opts.log(`audio chunk closed (${reason}, ${ageMs}ms, ${(downsampled.length / 16000).toFixed(2)}s) — ${wav.length} bytes`)
    void this.opts.onChunk(wav, ageMs)
  }

  shutdown(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = undefined
    this.flush("shutdown")
  }
}

// --- Pure helpers ---

function mixToMono(samples: Int16Array, channels: number): Int16Array {
  if (channels === 1) return samples
  const out = new Int16Array(samples.length / channels)
  for (let i = 0, j = 0; i < samples.length; i += channels, j++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[i + c]
    out[j] = sum / channels
  }
  return out
}

function rmsNormalized(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples.length)
}

function concatInt16(parts: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Linear-interpolation downsample. Adequate for speech intelligibility;
 *  not audiophile-grade but Whisper is robust to it. */
function downsampleTo16k(samples: Int16Array, sourceRate: number): Int16Array {
  if (sourceRate === 16_000) return samples
  const ratio = sourceRate / 16_000
  const outLen = Math.floor(samples.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(lo + 1, samples.length - 1)
    const t = src - lo
    out[i] = (1 - t) * samples[lo] + t * samples[hi]
  }
  return out
}

/** Minimal RIFF/WAVE encoder for 16-bit PCM mono. */
function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)        // fmt chunk size
  header.writeUInt16LE(1, 20)         // PCM
  header.writeUInt16LE(1, 22)         // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)  // byte rate
  header.writeUInt16LE(2, 32)         // block align
  header.writeUInt16LE(16, 34)        // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2)
  return Buffer.concat([header, data])
}
