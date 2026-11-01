import { statSync } from "fs"
import { basename } from "path"
import { ARTIFACT_LIMITS, artifactType, extractArtifacts } from "@/utils/artifact-sentinel"
import { APP_FILES_PATH, resolveArtifact } from "./app-files-api"

// --- Files in a voice answer, for the Mac widget (#1670) ---
//
// The same <agentx-artifact> lines the phone app shows (artifact-sentinel.ts).
// /ask strips them from what is shown and spoken, and lists each file with
// the daemon path that serves it: GET /app-files, which the widget reaches
// over loopback. A file that can't be served here (missing, outside the
// workspace, too large, a type that isn't served, or on another computer)
// is listed without a url, so the widget says it is not available instead
// of showing the tag.

export interface VoiceArtifact {
  name: string
  mime: string
  kind: "image" | "audio" | "video" | "file"
  /** Relative to the daemon, or null when this daemon can't serve it. */
  url: string | null
}

/** The answer without its sentinels, and the files they declare. `workspace`
 *  is null for an agent on another computer. */
export function voiceArtifacts(
  text: string, agentId: string, workspace: string | null, cwd = process.cwd(),
): { text: string; artifacts: VoiceArtifact[] } {
  const { text: clean, artifacts } = extractArtifacts(text, ARTIFACT_LIMITS.perMessage)
  return {
    text: clean,
    artifacts: artifacts.map((a) => {
      const name = basename(a.filename)
      const found = workspace ? resolveArtifact(workspace, a.filename, cwd) : null
      if (!found?.ok || !servable(found.path)) {
        return { name, mime: a.mime, kind: artifactType(a.filename)?.kind ?? "file", url: null }
      }
      const qs = new URLSearchParams({ agent: agentId, file: a.filename })
      return { name, mime: found.mime, kind: found.kind as VoiceArtifact["kind"], url: `${APP_FILES_PATH}?${qs}` }
    }),
  }
}

function servable(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size <= ARTIFACT_LIMITS.bytes
  } catch { return false }
}
