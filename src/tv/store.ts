// --- Where episodes are kept ---
//
//   ~/.agentx/tv/<YYYY-MM-DD>/<episode id>/
//     episode.json   the script, screen by screen (episode.ts)
//     index.html     the HyperFrames composition, once rendered
//     vo/            the voice-over, one file per screen
//     episode.mp4    the video, once rendered
//
// AGENTX_TV_DIR moves the whole folder (the tests use it). A day's
// line-up is every episode in its folder, in the order they were made.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Episode } from "./episode"

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export const isDay = (s: string) => DAY.test(s)
export const isEpisodeId = (s: string) => ID.test(s)

export function tvRoot(): string {
  return process.env.AGENTX_TV_DIR || join(homedir(), ".agentx", "tv")
}

export function episodeDir(day: string, id: string, root = tvRoot()): string {
  if (!isDay(day) || !isEpisodeId(id)) throw new Error(`bad episode address: ${day}/${id}`)
  return join(root, day, id)
}

export function saveEpisode(ep: Episode, root = tvRoot()): string {
  const dir = episodeDir(ep.day, ep.id, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "episode.json"), JSON.stringify(ep, null, 2) + "\n")
  return dir
}

function readEpisode(dir: string): Episode | null {
  try {
    const ep = JSON.parse(readFileSync(join(dir, "episode.json"), "utf8")) as Episode
    // A video counts only once it is on disk; a render that died leaves none.
    if (ep.video && (!/^[\w-]+\.mp4$/.test(ep.video) || !existsSync(join(dir, ep.video)))) delete ep.video
    return ep
  } catch {
    return null
  }
}

/** Every episode made on a day, oldest first. */
export function lineup(day: string, root = tvRoot()): Episode[] {
  if (!isDay(day)) return []
  const dir = join(root, day)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(isEpisodeId)
    .map((id) => readEpisode(join(dir, id)))
    .filter((e): e is Episode => !!e)
    .sort((a, b) => a.madeAt.localeCompare(b.madeAt))
}

/** Days that have at least one episode, newest first. */
export function episodeDays(root = tvRoot(), limit = 60): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => isDay(d) && statSync(join(root, d)).isDirectory() && lineup(d, root).length > 0)
    .sort()
    .reverse()
    .slice(0, limit)
}

/** The video file of one episode, or null when there is none. */
export function videoFile(day: string, id: string, root = tvRoot()): string | null {
  if (!isDay(day) || !isEpisodeId(id)) return null
  const ep = readEpisode(join(root, day, id))
  return ep?.video ? join(root, day, id, ep.video) : null
}
