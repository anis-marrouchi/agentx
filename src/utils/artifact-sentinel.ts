import { extname } from "path"

// --- Files an agent declares in its answer: <agentx-artifact> ---
//
// One mechanism for every surface that shows files an agent created. The
// agent saves the file in its workspace and ends its answer with one
// sentinel per file:
//
//   <agentx-artifact>{"filename":"charts/sales.png","mime":"image/png"}</agentx-artifact>
//
// The daemon's web chat (POST /chat) returns them as `artifacts`; the phone
// app registers them per conversation and serves them through
// /api/app/files/:id (app-files.ts). Closed sentinels are always stripped
// from the text people read or hear, including malformed ones. An unclosed
// tag is only cut when the answer itself was cut off: a finished answer may
// mention the tag in prose.

export interface DeclaredArtifact {
  /** As the agent wrote it: a path relative to its workspace. */
  filename: string
  /** As the agent declared it. Serving goes by the file extension instead. */
  mime: string
  /** The web chat's coarse kind, kept for its callers. */
  type: "image" | "pdf" | "text" | "file"
}

const SENTINEL = /<agentx-artifact>([\s\S]*?)<\/agentx-artifact>/gi
/** A sentinel cut off mid-way (a stopped or broken answer). */
const DANGLING = /<agentx-artifact>[\s\S]*$/i

/** The text without its sentinels, and the files they declare, in order.
 *  Files past `max` are stripped but not returned. `cutOff` marks a stopped
 *  or failed answer, whose half-written sentinel is stripped as well. */
export function extractArtifacts(text: string, max = Infinity, cutOff = false): { text: string; artifacts: DeclaredArtifact[] } {
  const artifacts: DeclaredArtifact[] = []
  const raw = String(text ?? "")
  // Text without a sentinel comes back exactly as it was (a partial answer
  // keeps its trailing space).
  if (!/<agentx-artifact>/i.test(raw)) return { text: raw, artifacts }
  const clean = raw.replace(SENTINEL, (_full, inner: string) => {
    try {
      const parsed = JSON.parse(inner.trim())
      if (parsed && typeof parsed.filename === "string" && typeof parsed.mime === "string" && artifacts.length < max) {
        const mime: string = parsed.mime
        const type = mime.startsWith("image/") ? "image"
          : mime === "application/pdf" ? "pdf"
          : mime.startsWith("text/") ? "text"
          : "file"
        artifacts.push({ type, filename: parsed.filename, mime })
      }
    } catch { /* malformed: dropped from the text all the same */ }
    return ""
  })
  return { text: (cutOff ? clean.replace(DANGLING, "") : clean).trim(), artifacts }
}

/** An answer from an agent with rich messages off (#259): each sentinel
 *  becomes its file's name as text, so nothing is silently lost, and a web
 *  picture becomes an ordinary link. Code is left as written. `cutOff`
 *  drops an unclosed tag, as in extractArtifacts. */
export function plainAnswer(text: string, cutOff = false): string {
  const raw = String(text ?? "")
  let named = raw
  if (/<agentx-artifact>/i.test(raw)) {
    const replaced = raw.replace(SENTINEL, (_full, inner: string) => {
      try {
        const parsed = JSON.parse(inner.trim())
        return parsed && typeof parsed.filename === "string" ? parsed.filename : ""
      } catch { return "" }
    })
    named = (cutOff ? replaced.replace(DANGLING, "") : replaced).trim()
  }
  return named.replace(/```[\s\S]*?```|`[^`\n]*`|!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m: string, alt?: string, src?: string) =>
    alt === undefined || src === undefined ? m : `[${alt || src}](${src})`)
}

/** What may be served, by extension. SVG is an image but can carry script,
 *  so it is only ever served as a download. */
export const ARTIFACT_TYPES: Readonly<Record<string, { mime: string; kind: "image" | "audio" | "video" | "file" }>> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".svg": { mime: "image/svg+xml", kind: "file" },
  ".pdf": { mime: "application/pdf", kind: "file" },
  ".txt": { mime: "text/plain; charset=utf-8", kind: "file" },
  ".md": { mime: "text/markdown; charset=utf-8", kind: "file" },
  ".csv": { mime: "text/csv; charset=utf-8", kind: "file" },
  ".json": { mime: "application/json", kind: "file" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
}

export const ARTIFACT_LIMITS = {
  /** Largest file served. */
  bytes: 20 * 1024 * 1024,
  /** Files kept from one answer. */
  perMessage: 20,
  /** Longest declared path. */
  pathChars: 512,
} as const

/** The served type of a declared path, or null when it may not be served. */
export function artifactType(filename: string): { mime: string; kind: "image" | "audio" | "video" | "file" } | null {
  return ARTIFACT_TYPES[extname(filename).toLowerCase()] ?? null
}

/** What an agent on the phone app is told, once per fresh session. */
export const APP_ATTACH_HINT = [
  "[Phone app: showing files]",
  "To show the owner a file you created (a chart, a screenshot, a PDF, a recording), save or copy it into .agentx/outbox/ in your workspace and end your reply with one line per file:",
  '<agentx-artifact>{"filename":".agentx/outbox/<name.ext>","mime":"<mime/type>"}</agentx-artifact>',
  "Files outside your workspace (/tmp, your home folder) are refused. Outbox files are removed after 7 days.",
  "The line is removed from the text. Images show in the reply, audio and video get a player, other files an Open link. Allowed: png, jpg, gif, webp, svg, pdf, txt, md, csv, json, mp3, m4a, wav, mp4, webm; up to 20 MB and 20 files per reply.",
  "A picture already on the web can go inline as ![what it shows](https://...).",
].join("\n")

/** The attach note for one turn: on the phone app, when a session starts,
 *  unless the agent has rich messages off (#259). */
export function appAttachHint(channel: string, sessionStarts: boolean, richMessages: boolean | undefined): string | undefined {
  return channel === "app" && sessionStarts && richMessages !== false ? APP_ATTACH_HINT : undefined
}
