#!/usr/bin/env node
// Speech-to-text benchmark for AgentX Voice: mlx-whisper against Parakeet
// on the same clips, in English, French and Arabic. See
// docs/dashboard/voice.md#compare-the-local-engines.
//
//   node scripts/voice-stt-bench/index.mjs [--out DIR] [--clips DIR] [--fleurs N] [--no-synth]
//                                          [--turn-only | --stt-only]
//
// Clips are synthesised with the macOS `say` voices (nothing to license,
// nothing personal) and each is also mixed with room noise at 10 dB SNR.
// --clips adds your own recordings: NAME.wav (16 kHz mono 16-bit) next to
// NAME.txt (what was said) and optionally NAME.lang ("en", "fr", "ar").
// --fleurs N adds N real read-speech clips per language from FLEURS.
// --turn-only runs just the end-of-turn check; --stt-only skips it.
//
// Needs: mlx_whisper (AGENTX_MLX_WHISPER, default ~/.local/bin/mlx_whisper)
// and agentx-voice-local from apps/mac-voice/build.sh (AGENTX_VOICE_LOCAL),
// with the Parakeet model fetched. Prints a Markdown table; writes every
// transcript to DIR/results.json.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { pooledWer, wer } from "./wer.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const out = opt("--out", join(tmpdir(), "agentx-voice-stt-bench"))
const extra = opt("--clips", "")
const synth = !args.includes("--no-synth")
const fleursCount = Number(opt("--fleurs", "0")) || 0
const mlx = process.env.AGENTX_MLX_WHISPER || join(homedir(), ".local/bin/mlx_whisper")
const mlxModel = process.env.AGENTX_MLX_MODEL || "mlx-community/whisper-large-v3-turbo"
const local = process.env.AGENTX_VOICE_LOCAL
  || join(here, "../../apps/mac-voice/build/AgentX Voice.app/Contents/MacOS/agentx-voice-local")

// Neutral sentences: no names, numbers or places a transcriber could spell
// several ways.
const SENTENCES = {
  en: [
    "Please remind me to water the plants when I get home this evening.",
    "The meeting has been moved to the afternoon because the room is not ready.",
    "Can you summarize the last three messages and tell me which one needs an answer first?",
    "Open the report, check the totals, and send me a short note if anything looks wrong.",
    "It started raining just as we left the building, so we waited under the bridge for a while.",
  ],
  fr: [
    "Rappelle-moi d'arroser les plantes quand je rentre ce soir.",
    "La réunion a été déplacée à l'après-midi parce que la salle n'est pas prête.",
    "Peux-tu résumer les trois derniers messages et me dire lequel demande une réponse en premier ?",
    "Ouvre le rapport, vérifie les totaux et envoie-moi une courte note si quelque chose semble faux.",
    "Il a commencé à pleuvoir juste au moment où nous sommes sortis, alors nous avons attendu sous le pont.",
  ],
  ar: [
    "ذكرني أن أسقي النباتات عندما أعود إلى البيت هذا المساء.",
    "تم نقل الاجتماع إلى فترة بعد الظهر لأن القاعة ليست جاهزة.",
    "هل يمكنك تلخيص الرسائل الثلاث الأخيرة وإخباري أيها يحتاج إلى رد أولا؟",
    "افتح التقرير وتحقق من المجاميع وأرسل لي ملاحظة قصيرة إذا بدا شيء خاطئا.",
    "بدأ المطر يهطل عندما غادرنا المبنى فانتظرنا تحت الجسر قليلا.",
  ],
}
const VOICES = { en: ["Samantha", "Daniel"], fr: ["Thomas", "Jacques"], ar: ["Majed"] }

// --- WAV ---

function readWav(path) {
  const b = readFileSync(path)
  let o = 12
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4)
    const size = b.readUInt32LE(o + 4)
    if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - o - 8) / 2)
      const s = new Float32Array(n)
      for (let i = 0; i < n; i++) s[i] = b.readInt16LE(o + 8 + i * 2) / 32768
      return s
    }
    o += 8 + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}

function writeWav(path, samples) {
  const b = Buffer.alloc(44 + samples.length * 2)
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8)
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  }
  writeFileSync(path, b)
}

function say(voice, text, path) {
  const aiff = path.replace(/\.wav$/, ".aiff")
  execFileSync("/usr/bin/say", ["-v", voice, "-o", aiff, text])
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, path])
  return readWav(path)
}

const rms = (s) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / Math.max(s.length, 1))

/** Room noise: pink-ish hiss with a low hum and the odd clatter. Seeded. */
export function roomNoise(n, seed = 1) {
  let x = seed >>> 0
  const rand = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const s = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < n; i++) {
    const w = rand()
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    s[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2 + 0.05 * Math.sin((2 * Math.PI * 100 * i) / 16000)
  }
  // A clatter (cup, keyboard) every second or so.
  for (let at = 4000; at < n; at += 12000 + Math.floor((rand() + 1) * 6000)) {
    for (let i = 0; i < 800 && at + i < n; i++) s[at + i] += rand() * 0.8 * Math.exp(-i / 150)
  }
  return s
}

function mix(speech, noiseRms, seed) {
  const noise = roomNoise(speech.length, seed)
  const k = noiseRms / (rms(noise) || 1)
  return speech.map((v, i) => v + noise[i] * k)
}

// --- Clips ---

// Real read speech from FLEURS (Google, CC-BY-4.0), through the Hugging
// Face dataset viewer: the first N validation clips per language.
const FLEURS = { en: "en_us", fr: "fr_fr", ar: "ar_eg" }

async function fleurs(n) {
  const dir = join(out, "fleurs")
  mkdirSync(dir, { recursive: true })
  const list = []
  for (const [lang, config] of Object.entries(FLEURS)) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=google/fleurs&config=${config}&split=validation&offset=0&length=${n}`
    // The dataset viewer answers 502 now and then while it warms up.
    let res
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url)
      if (res.ok || attempt === 4) break
      await new Promise((r) => setTimeout(r, 3000 * attempt))
    }
    if (!res.ok) throw new Error(`FLEURS ${config}: HTTP ${res.status}`)
    const { rows } = await res.json()
    for (const { row } of rows) {
      const name = `fleurs-${lang}-${row.id}`
      const path = join(dir, `${name}.wav`)
      if (!existsSync(path)) {
        const audio = await fetch(row.audio[0].src)
        if (!audio.ok) throw new Error(`FLEURS ${name}: HTTP ${audio.status}`)
        const raw = join(dir, `${name}.src.wav`)
        writeFileSync(raw, Buffer.from(await audio.arrayBuffer()))
        execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw, path])
      }
      list.push({ name, lang, path, reference: row.raw_transcription, condition: "FLEURS read speech" })
    }
  }
  return list
}

function clips() {
  const dir = join(out, "clips")
  mkdirSync(dir, { recursive: true })
  const list = []
  if (synth) {
    let seed = 7
    for (const [lang, sentences] of Object.entries(SENTENCES)) {
      sentences.forEach((text, i) => {
        const voice = VOICES[lang][i % VOICES[lang].length]
        const name = `${lang}-${i + 1}`
        const clean = join(dir, `${name}-clean.wav`)
        const speech = existsSync(clean) ? readWav(clean) : say(voice, text, clean)
        list.push({ name: `${name}-clean`, lang, path: clean, reference: text, condition: "clean" })
        const noisy = join(dir, `${name}-noisy.wav`)
        if (!existsSync(noisy)) writeWav(noisy, mix(speech, rms(speech) / Math.sqrt(10), seed++))
        list.push({ name: `${name}-noisy`, lang, path: noisy, reference: text, condition: "noisy 10 dB" })
      })
    }
  }
  if (extra) {
    for (const f of readdirSync(extra).filter((f) => f.endsWith(".wav"))) {
      const stem = join(extra, f.slice(0, -4))
      if (!existsSync(`${stem}.txt`)) continue
      const lang = existsSync(`${stem}.lang`) ? readFileSync(`${stem}.lang`, "utf8").trim() : "?"
      list.push({ name: basename(stem), lang, path: join(extra, f), reference: readFileSync(`${stem}.txt`, "utf8").trim(), condition: "recorded" })
    }
  }
  return list
}

// --- End of turn ---
//
// A sentence said in two halves with a pause between them, then 3 s of the
// room, at three room loudnesses. The turn must not end in the pause and
// must end 1.2 s or so after the last word.

const TURN_SENTENCES = {
  en: ["Samantha", "Open the report and check the totals,", "then send me a short note if anything looks wrong."],
  fr: ["Thomas", "Ouvre le rapport et vérifie les totaux,", "puis envoie-moi une courte note si quelque chose semble faux."],
  ar: ["Majed", "افتح التقرير وتحقق من المجاميع", "ثم أرسل لي ملاحظة قصيرة إذا بدا شيء خاطئا."],
}
const ROOMS = [["quiet room", 0.003], ["busy room", 0.012], ["loud room", 0.03]]
const PAUSES = [0.6, 1.0]

const trim = (s) => {
  let a = 0, b = s.length
  while (a < b && Math.abs(s[a]) < 0.01) a++
  while (b > a && Math.abs(s[b - 1]) < 0.01) b--
  return s.slice(a, b)
}
const scaled = (s, target) => { const k = target / (rms(s) || 1); return s.map((v) => v * k) }

function turnBench() {
  const dir = join(out, "turn")
  mkdirSync(dir, { recursive: true })
  const rows = []
  let seed = 101
  for (const [lang, [voice, a, b]] of Object.entries(TURN_SENTENCES)) {
    const first = scaled(trim(say(voice, a, join(dir, `${lang}-a.wav`))), 0.08)
    const second = scaled(trim(say(voice, b, join(dir, `${lang}-b.wav`))), 0.08)
    for (const pauseS of PAUSES) {
      const pause = new Float32Array(Math.round(pauseS * 16000))
      const tail = new Float32Array(3 * 16000)
      const speech = Float32Array.from([...first, ...pause, ...second, ...tail])
      const lastWord = (first.length + pause.length + second.length) / 16000
      for (const [room, level] of ROOMS) {
        const path = join(dir, `${lang}-pause${pauseS}-${room.replace(" ", "-")}.wav`)
        writeWav(path, mix(speech, level, seed++))
        const r = spawnSync(local, ["turn", path], { encoding: "utf8" })
        if (r.status !== 0) throw new Error(`agentx-voice-local turn failed: ${r.stderr}`)
        const [vad, volume] = r.stdout.trim().split("\n").map((l) => JSON.parse(l))
        rows.push({ lang, pause: pauseS, room, lastWord, vad: vad.turnEndedAt, volume: volume.turnEndedAt })
      }
    }
  }
  const verdict = (t, lastWord) =>
    t == null ? "never ended (held open)"
      : t < lastWord ? `cut off ${(lastWord - t).toFixed(1)} s early`
        : `ended ${(t - lastWord).toFixed(2)} s after the last word`
  const lines = [
    "| Language | Pause mid-sentence | Room | Silero VAD | Volume threshold (old) |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.lang} | ${r.pause} s | ${r.room} | ${verdict(r.vad, r.lastWord)} | ${verdict(r.volume, r.lastWord)} |`),
  ]
  writeFileSync(join(out, "turn.json"), JSON.stringify(rows, null, 2))
  return lines.join("\n")
}

// --- Engines ---

/** As the app runs it: one mlx_whisper process per turn. */
function mlxPerCall(clip) {
  const t = performance.now()
  const r = spawnSync(mlx, ["--model", mlxModel, "--output-format", "txt", "--output-dir", dirname(clip.path), clip.path], { encoding: "utf8" })
  const ms = performance.now() - t
  const txt = clip.path.replace(/\.wav$/, ".txt")
  const text = existsSync(txt) ? readFileSync(txt, "utf8").trim() : ""
  return { ms, text, error: r.status === 0 && text ? undefined : (r.stderr || r.stdout).slice(-300) }
}

/** mlx-whisper with the model already in memory: its best case. */
function mlxWarm(list) {
  const python = readFileSync(mlx, "utf8").split("\n")[0].replace(/^#!/, "").trim()
  const code = [
    "import json, sys, time, mlx_whisper",
    "m = sys.argv[1]",
    "mlx_whisper.transcribe(sys.argv[2], path_or_hf_repo=m)",
    "for p in sys.argv[2:]:",
    "    t = time.time(); r = mlx_whisper.transcribe(p, path_or_hf_repo=m)",
    "    print(json.dumps({'file': p, 'ms': (time.time() - t) * 1000, 'text': r['text'].strip()}), flush=True)",
  ].join("\n")
  const r = spawnSync(python, ["-c", code, mlxModel, ...list.map((c) => c.path)], { encoding: "utf8", maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error(`mlx-whisper (warm) failed: ${r.stderr.slice(-500)}`)
  return new Map(r.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((o) => [o.file, o]))
}

/** Parakeet in one process, as the app keeps it loaded. */
function parakeet(list) {
  const r = spawnSync(local, ["transcribe", ...list.map((c) => c.path)], { encoding: "utf8", maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error(`agentx-voice-local failed: ${r.stderr.slice(-500)}`)
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l))
  return { loadMs: lines.find((l) => l.event === "loaded")?.ms, byFile: new Map(lines.filter((l) => l.file).map((l) => [l.file, l])) }
}

// --- Run ---

async function main() {
  mkdirSync(out, { recursive: true })
  if (!existsSync(mlx)) throw new Error(`mlx_whisper not found at ${mlx}`)
  if (!existsSync(local)) throw new Error(`agentx-voice-local not found at ${local}; run apps/mac-voice/build.sh`)
  if (!args.includes("--stt-only")) {
    console.log("## End of turn\n")
    console.log(turnBench())
    console.log("")
    if (args.includes("--turn-only")) return
  }
  console.log("## Speech to text\n")
  const list = [...clips(), ...(fleursCount ? await fleurs(fleursCount) : [])]
  const seconds = (c) => readWav(c.path).length / 16000
  process.stderr.write(`${list.length} clips in ${join(out, "clips")}\n`)

  // Parakeet twice: the first run also compiles the models for this Mac.
  const cold = parakeet(list.slice(0, 1))
  const pk = parakeet(list)
  const warm = mlxWarm(list)
  const rows = []
  for (const c of list) {
    const call = mlxPerCall(c)
    const w = warm.get(c.path)
    const p = pk.byFile.get(c.path)
    const audio = seconds(c)
    rows.push({ ...c, audio,
      mlxCall: { ms: call.ms, text: call.text, wer: wer(c.reference, call.text), error: call.error },
      mlxWarm: { ms: w?.ms, text: w?.text ?? "", wer: wer(c.reference, w?.text ?? "") },
      parakeet: { ms: p?.ms, text: p?.text ?? "", wer: wer(c.reference, p?.text ?? ""), error: p?.error },
    })
    process.stderr.write(`${c.name}: whisper ${Math.round(call.ms)} ms, parakeet ${p?.ms} ms\n`)
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ parakeetLoadMs: { first: cold.loadMs, cached: pk.loadMs }, rows }, null, 2))

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
  const groups = new Map()
  for (const r of rows) {
    const k = `${r.lang}|${r.condition}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const lines = [
    "| Language | Audio | Clips | mlx-whisper per call (as the app runs it) | mlx-whisper warm | Parakeet warm | WER mlx-whisper | WER Parakeet |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const [k, rs] of groups) {
    const [lang, condition] = k.split("|")
    const pw = (key) => pooledWer(rs.map((r) => ({ reference: r.reference, hypothesis: r[key].text })))
    const ms = (key) => `${Math.round(mean(rs.map((r) => r[key].ms ?? 0)))} ms`
    lines.push(`| ${lang} | ${condition}, ${mean(rs.map((r) => r.audio)).toFixed(1)} s | ${rs.length} | ${ms("mlxCall")} | ${ms("mlxWarm")} | ${ms("parakeet")} | ${(pw("mlxWarm") * 100).toFixed(1)}% | ${(pw("parakeet") * 100).toFixed(1)}% |`)
  }
  lines.push("", `Parakeet model load: ${cold.loadMs} ms for this run's first process, ${pk.loadMs} ms for the next (once per app launch). The very first load after a download also prepares the model for the Neural Engine, which took about 30 s on an M2.`)
  lines.push(`mlx-whisper model: ${mlxModel}. Transcripts: ${join(out, "results.json")}`)
  console.log(lines.join("\n"))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message); process.exit(1) })
