// --- Making the video, off the Mac ---
//
// Rendering an episode is heavy (headless Chrome, frame by frame, then
// ffmpeg), so it never runs on a Mac: either the command runs on the render
// server itself (--render-here), or it ships the episode folder to one over
// SSH (--render-on <host>) and brings the video back. Two passes:
//
//   1. voice.sh   one voice-over file per screen, with HyperFrames' local
//                 text-to-speech (Kokoro). No account, nothing sent out.
//   2. render.sh  the composition, retimed to the real voice lengths, to
//                 episode.mp4.
//
// Both scripts are written into the episode folder, so a render that
// failed can be run again by hand on the server.

import { spawn } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { compositionHtml } from "./composition"
import { retime, type Episode } from "./episode"
import { isDay, isEpisodeId } from "./store"
import { isMac } from "@/native"

/** Pinned so a render is the same on every server. */
export const HYPERFRAMES = "hyperframes@0.8.207"
export const GSAP = "gsap@3.12.5"

export interface RenderOpts {
  /** An SSH host (an alias from ~/.ssh/config or user@host); none renders here. */
  host?: string
  /** For tests: the platform the refusal checks. */
  platform?: NodeJS.Platform
  /** For tests: runs a command and its stdin, returns its stdout. */
  exec?: Exec
  log?: (line: string) => void
}

export type Exec = (cmd: string, args: string[], input?: Buffer) => Promise<Buffer>

export function checkHost(host: string): string {
  if (!/^[A-Za-z0-9._@-]+$/.test(host) || host.startsWith("-")) throw new Error(`not an SSH host: ${host}`)
  return host
}

/** Why this machine may not render, or null when it may. */
export function refuseHere(platform: NodeJS.Platform = process.platform): string | null {
  return isMac(platform)
    ? "renders never run on a Mac: use --render-on <host> to render on the render server"
    : null
}

const header = (what: string) => `#!/bin/sh
# ${what}. Written by \`agentx tv make\` (#1471); safe to run again.
set -eu
cd "$(dirname "$0")"
[ -f "$HOME/.agentx-tv/env" ] && . "$HOME/.agentx-tv/env"
HF="\${HYPERFRAMES:-npx --yes ${HYPERFRAMES}}"
$HF telemetry disable >/dev/null 2>&1 || true
`

export function voiceScript(voice: string): string {
  return header("Voice-over, one file per screen") + `for f in vo/*.txt; do
  b="\${f%.txt}"
  $HF tts --text-file "$f" -o "$b.wav" --voice "${voice.replace(/[^\w-]/g, "")}" --json > "$b.json"
done
`
}

export function renderScript(): string {
  const pkg = GSAP.replace("@", "-")
  return header("The video") + `if [ ! -f gsap.min.js ]; then
  npm pack ${GSAP} --silent >/dev/null
  tar -xzf ${pkg}.tgz package/dist/gsap.min.js
  mv package/dist/gsap.min.js gsap.min.js
  rm -rf package ${pkg}.tgz
fi
$HF render . -o episode.mp4 -q looks --quiet
`
}

/** Seconds of each screen's voice-over, from the tts --json files. */
export function voiceLengths(dir: string, ep: Episode): Array<number | undefined> {
  return ep.screens.map((sc) => {
    try {
      const lines = readFileSync(join(dir, "vo", `${sc.id}.json`), "utf8").trim().split("\n")
      const j = JSON.parse(lines.filter((l) => l.startsWith("{")).at(-1) ?? "{}")
      return j.ok && typeof j.durationSeconds === "number" ? j.durationSeconds : undefined
    } catch {
      return undefined
    }
  })
}

/** The episode retimed to its real voice-over, with each screen's file. */
export function withVoice(ep: Episode, lengths: Array<number | undefined>): Episode {
  const screens = retime(ep.screens, lengths).map((sc, i) => (lengths[i] != null ? { ...sc, audio: `vo/${sc.id}.wav` } : sc))
  const last = screens.at(-1)
  return { ...ep, screens, durationSec: last ? Math.round((last.start + last.duration) * 10) / 10 : 0 }
}

const run: Exec = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] })
  const out: Buffer[] = []
  let err = ""
  p.stdout.on("data", (c) => out.push(c))
  p.stderr.on("data", (c) => { err = (err + c).slice(-4000) })
  p.on("error", reject)
  p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${args[0] ?? ""} exited ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`))))
  p.stdin.end(input ?? Buffer.alloc(0))
})

/** Voice and render one saved episode. Returns it with its video set. */
export async function renderEpisode(dir: string, ep: Episode, opts: RenderOpts = {}): Promise<Episode> {
  const exec = opts.exec ?? run
  const log = opts.log ?? (() => {})
  const host = opts.host ? checkHost(opts.host) : undefined
  if (!host) {
    const why = refuseHere(opts.platform)
    if (why) throw new Error(why)
  }
  // Both go into shell commands on the server.
  if (!isDay(ep.day) || !isEpisodeId(ep.id)) throw new Error(`bad episode address: ${ep.day}/${ep.id}`)
  const started = Date.now()
  const remote = `.agentx-tv/${ep.day}/${ep.id}`
  const tar = (files: string[]) => exec("tar", ["-C", dir, "-cf", "-", ...files])
  const push = async (files: string[]) => {
    if (host) await exec("ssh", [host, `mkdir -p ${remote} && tar -C ${remote} -xf -`], await tar(files))
  }
  const sh = (script: string) => (host ? exec("ssh", [host, `sh ${remote}/${script}`]) : exec("sh", [join(dir, script)]))
  const pull = async (pattern: string) => {
    if (host) await exec("tar", ["-C", dir, "-xf", "-"], await exec("ssh", [host, `cd ${remote} && tar -cf - ${pattern}`]))
  }

  mkdirSync(join(dir, "vo"), { recursive: true })
  for (const sc of ep.screens) writeFileSync(join(dir, "vo", `${sc.id}.txt`), sc.say + "\n")
  writeFileSync(join(dir, "voice.sh"), voiceScript(ep.voice))
  log(`voice-over: ${ep.screens.length} lines ${host ? `on ${host}` : "here"}`)
  await push(["voice.sh", "vo"])
  await sh("voice.sh")
  await pull("vo/*.json")

  const lengths = voiceLengths(dir, ep)
  if (lengths.some((l) => l == null)) throw new Error(`voice-over failed for ${lengths.filter((l) => l == null).length} screens; see ${join(dir, "vo")}`)
  const voiced = withVoice(ep, lengths)
  writeFileSync(join(dir, "index.html"), compositionHtml(voiced))
  writeFileSync(join(dir, "render.sh"), renderScript())
  log(`render: ${voiced.durationSec}s of video ${host ? `on ${host}` : "here"}`)
  await push(["index.html", "render.sh"])
  await sh("render.sh")
  await pull("episode.mp4")
  if (!existsSync(join(dir, "episode.mp4"))) throw new Error("the render finished without episode.mp4")

  return { ...voiced, video: "episode.mp4", render: { at: new Date().toISOString(), host: host ?? "here", seconds: Math.round((Date.now() - started) / 1000) } }
}
