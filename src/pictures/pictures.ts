import { createHash } from "crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage } from "http"

// --- Profile pictures for agents and people (#1425) ---
//
// Every member of the org may have one picture: an agent (agentx.json
// `agents`) or a person (agentx.json `people`). It is set by hand (Settings
// for an agent, People for a person) or by an agent for itself
// (`agentx agent picture set <file>`). Every path goes through
// preparePicture: PNG, JPEG or WebP only, 1 MB at most, re-encoded to a
// 512×512 square WebP. Re-encoding drops EXIF, GPS and every other
// metadata block, and anything hidden after the image data.
//
// The pictures live under the daemon's folder, never in agentx.json:
//   .agentx/pictures/agent/<id>.<version>.webp
//   .agentx/pictures/person/<id>.<version>.webp
// The version is the start of the picture's sha256, so a new picture is a
// new address: browsers keep a picture for good and a change shows on the
// next page load, with no restart. The CLI, the daemon and the dashboard
// are separate processes; each reads the folder.

export type PictureKind = "agent" | "person"
export const PICTURE_KINDS: readonly PictureKind[] = ["agent", "person"]

/** The largest file accepted, before re-encoding. */
export const PICTURE_MAX_BYTES = 1024 * 1024
/** The side of the square every picture is re-encoded to. */
export const PICTURE_SIDE = 512
export const PICTURE_TYPE = "image/webp"
/** The daemon route an agent sets its own picture through. */
export const AGENT_PICTURE_PATH = "/api/agent-picture"

/** Agent and person ids, as agentx.json allows them. */
export const PICTURE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const VERSION = /^[0-9a-f]{16}$/
const FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.([0-9a-f]{16})\.webp$/

export class PictureError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function picturesDir(root: string, kind?: PictureKind): string {
  return kind ? resolve(root, ".agentx", "pictures", kind) : resolve(root, ".agentx", "pictures")
}

/** The format the first bytes say, or why the file is refused. */
export function sniffPicture(bytes: Buffer): "png" | "jpeg" | "webp" {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp"
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 512)).trimStart().toLowerCase()
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || head.startsWith("<!doctype svg")) {
    throw new PictureError("SVG pictures are not accepted. Use a PNG, JPEG or WebP file.")
  }
  throw new PictureError("That file is not a picture. Use a PNG, JPEG or WebP file.")
}

function sizeText(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`
}

type Sharp = typeof import("sharp")
let sharpLoad: Promise<Sharp> | null = null
/** sharp is an optional dependency: a machine without it can still run
 *  everything else, and says so when a picture is set. */
function loadSharp(): Promise<Sharp> {
  sharpLoad ??= import("sharp").then((m) => ((m as any).default ?? m) as Sharp).catch((e) => {
    sharpLoad = null
    throw new PictureError(`Pictures need the "sharp" package, which is not installed here (${e?.message ?? e}). Reinstall AgentX, or run: npm install -g sharp`, 503)
  })
  return sharpLoad
}

/**
 * Check a picture and re-encode it: a square WebP with no metadata, cut
 * from the middle of the original. Throws PictureError with words for the
 * person who sent it.
 */
export async function preparePicture(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length) throw new PictureError("The file is empty. Use a PNG, JPEG or WebP picture.")
  if (bytes.length > PICTURE_MAX_BYTES) {
    throw new PictureError(`The picture is ${sizeText(bytes.length)}; the limit is 1 MB. Make it smaller and try again.`, 413)
  }
  sniffPicture(bytes)
  const sharp = await loadSharp()
  try {
    return await sharp(bytes, { failOn: "error", limitInputPixels: 50_000_000 })
      .rotate() // turn it the way the camera said, before that note is dropped
      .resize(PICTURE_SIDE, PICTURE_SIDE, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer()
  } catch (e: any) {
    throw new PictureError(`The picture could not be read (${String(e?.message ?? e).split("\n")[0]}). Try another file.`)
  }
}

function checkId(kind: PictureKind, id: string): void {
  if (!PICTURE_KINDS.includes(kind)) throw new PictureError(`unknown kind "${kind}"`)
  if (!PICTURE_ID.test(id)) throw new PictureError(`"${id}" is not a valid ${kind} id`)
}

function filesOf(root: string, kind: PictureKind): { id: string; version: string; name: string }[] {
  let names: string[]
  try { names = readdirSync(picturesDir(root, kind)) } catch { return [] }
  return names.flatMap((name) => {
    const m = name.match(FILE)
    return m ? [{ id: m[1], version: m[2], name }] : []
  })
}

/** Every picture of one kind: id -> version. */
export function listPictures(root: string, kind: PictureKind): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of filesOf(root, kind)) out[f.id] = f.version
  return out
}

export function pictureVersion(root: string, kind: PictureKind, id: string): string | null {
  return filesOf(root, kind).find((f) => f.id === id)?.version ?? null
}

/** Where a page loads the picture from. */
export function pictureUrl(kind: PictureKind, id: string, version: string): string {
  return `/api/pictures/${kind}/${encodeURIComponent(id)}?v=${version}`
}

/** The picture's bytes, when `version` is the current one. */
export function readPicture(root: string, kind: PictureKind, id: string, version: string): Buffer | null {
  if (!PICTURE_KINDS.includes(kind) || !PICTURE_ID.test(id) || !VERSION.test(version)) return null
  const path = resolve(picturesDir(root, kind), `${id}.${version}.webp`)
  try { return readFileSync(path) } catch { return null }
}

/** Re-encode `bytes` and make it the picture of `id`, replacing any older one. */
export async function setPicture(root: string, kind: PictureKind, id: string, bytes: Buffer): Promise<{ version: string; url: string }> {
  checkId(kind, id)
  const out = await preparePicture(bytes)
  const version = createHash("sha256").update(out).digest("hex").slice(0, 16)
  const dir = picturesDir(root, kind)
  mkdirSync(dir, { recursive: true })
  const name = `${id}.${version}.webp`
  const tmp = resolve(dir, `.${name}.${process.pid}.tmp`)
  writeFileSync(tmp, out)
  renameSync(tmp, resolve(dir, name))
  for (const f of filesOf(root, kind)) if (f.id === id && f.name !== name) rmSync(resolve(dir, f.name), { force: true })
  return { version, url: pictureUrl(kind, id, version) }
}

/** Remove the picture of `id`: the initials show again. False when it had none. */
export function removePicture(root: string, kind: PictureKind, id: string): boolean {
  checkId(kind, id)
  const dir = picturesDir(root, kind)
  const mine = filesOf(root, kind).filter((f) => f.id === id)
  for (const f of mine) rmSync(resolve(dir, f.name), { force: true })
  return mine.length > 0
}

/** Read a request body, refusing one over `max` bytes without keeping it. */
export function readPictureBody(req: IncomingMessage, max = PICTURE_MAX_BYTES): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > max) { over = true; chunks.length = 0 } else if (!over) chunks.push(c)
    })
    req.on("end", () => over
      ? fail(new PictureError(`The picture is ${sizeText(size)}; the limit is 1 MB. Make it smaller and try again.`, 413))
      : done(Buffer.concat(chunks)))
    req.on("error", fail)
  })
}
