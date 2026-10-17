// Pure checks behind the UI evidence check (scripts/ui-evidence.mjs). No I/O
// here: callers pass the changed paths, PR body and labels in, and get a
// verdict back. Unit-tested in test/ui-evidence.test.ts. The quality report
// (#988) can call evaluate() on fetched PRs to count evidence and overrides.
import { matchesAny } from "./docs-gate-lib.mjs"

/** Changed paths that count as UI under config.paths / config.ignorePaths. */
export const uiPaths = (paths, config) =>
  paths.filter((p) => matchesAny(p, config.paths) && !matchesAny(p, config.ignorePaths ?? []))

/**
 * The body of the first heading named config.heading (any level, case
 * insensitive), up to the next heading of the same or a higher level.
 * HTML comments are dropped first, so template hints never count. Fenced
 * code is kept out of heading detection. Returns null when there is none.
 */
export function evidenceSection(body = "", heading = "Evidence") {
  const lines = stripComments(body).split(/\r?\n/)
  const name = heading.toLowerCase()
  let level = 0
  let fence = false
  const out = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (level) {
      if (h && h[1].length <= level) break
      out.push(line)
    } else if (h && h[2].toLowerCase() === name) level = h[1].length
  }
  return level ? out.join("\n") : null
}

const stripComments = (text) => text.replace(/<!--[\s\S]*?(-->|$)/g, "")

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g
// Markdown link or image targets and src="…" attributes, to catch
// repo-relative paths such as docs/public/screenshots/x.png.
const TARGET_RE = /\]\(\s*<?([^)\s>]+)|\bsrc\s*=\s*["']([^"']+)["']/g

/** Images or videos in `text`: GitHub attachments, or links with a media extension. */
export function findMedia(text, config) {
  const ext = new RegExp(`\\.(${config.mediaExtensions.join("|")})$`, "i")
  const attachments = (config.attachmentPatterns ?? []).map((p) => new RegExp(p))
  const isMedia = (target) => {
    const path = target.replace(/[?#].*$/, "")
    return ext.test(path) || attachments.some((re) => re.test(target))
  }
  const candidates = new Set(text.match(URL_RE) ?? [])
  for (const m of text.matchAll(TARGET_RE)) candidates.add(m[1] ?? m[2])
  return [...candidates].map((c) => c.replace(/[.,;:!]+$/, "")).filter(isMedia)
}

/**
 * The verdict for one PR. `files` are changed paths (strings); `pr` is
 * { body, labels }. Returns { status, title, summary, uiFiles, media, reason }
 * where status is "skipped" (no UI path), "passed", "overridden" or "failed".
 */
export function evaluate({ files, pr, config }) {
  const uiFiles = uiPaths(files, config)
  const base = { uiFiles, media: [], reason: null }
  if (!uiFiles.length)
    return { ...base, status: "skipped", title: "No UI paths changed", summary: "This PR changes no UI paths, so it needs no evidence." }

  const listed = `UI paths changed (${uiFiles.length}):\n${uiFiles.slice(0, 20).map((f) => `- ${f}`).join("\n")}${uiFiles.length > 20 ? `\n- … and ${uiFiles.length - 20} more` : ""}`
  const body = stripComments(pr.body ?? "")
  const { label, reasonPattern } = config.override
  const hasLabel = (pr.labels ?? []).includes(label)
  const reason = body.split(/\r?\n/).find((l) => new RegExp(reasonPattern).test(l))?.trim() ?? null
  if (hasLabel && reason)
    return { ...base, reason, status: "overridden", title: "Overridden: no UI evidence needed", summary: `Override by the \`${label}\` label.\n\nReason: ${reason}\n\n${listed}` }

  const section = evidenceSection(body, config.heading)
  const media = section == null ? [] : findMedia(section, config)
  if (media.length)
    return { ...base, media, status: "passed", title: `Evidence found (${media.length})`, summary: `Evidence under "## ${config.heading}":\n${media.map((m) => `- ${m}`).join("\n")}\n\n${listed}` }

  const missing =
    section == null
      ? `The PR description has no "## ${config.heading}" heading.`
      : `The "## ${config.heading}" section has no image or video.`
  const fix = hasLabel
    ? `The \`${label}\` label is set, but the description has no line of its own matching "UI evidence: not needed because <reason>".`
    : reason
      ? `The description gives a reason to skip evidence, but only a maintainer can approve it with the \`${label}\` label.`
      : `Add a screenshot or recording under "## ${config.heading}": drag the file into the description, or link a ${config.mediaExtensions.map((e) => `.${e}`).join("/")} file. If users see no difference, ask a maintainer for the \`${label}\` label and add a line "UI evidence: not needed because <reason>".`
  return { ...base, reason, status: "failed", title: "UI evidence missing", summary: `${missing} ${fix}\n\n${listed}` }
}
