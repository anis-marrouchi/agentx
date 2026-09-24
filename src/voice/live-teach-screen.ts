// The real screen for live teach: mac-helper's reader (accessibility tree,
// OCR fallback) and its point/click/type verbs. Kept apart from
// live-teach.ts so the lesson loop can be tested without a Mac.

import { execFile } from "child_process"
import { promisify } from "util"
import { HELPER, readScreen, rectFor } from "@/computer-use/screen"
import type { ScreenView, TeachDeps } from "./live-teach"

const run = promisify(execFile)

export async function readScreenView(): Promise<ScreenView> {
  const s = await readScreen({ max: 45 })
  return {
    app: s.app,
    window: s.window,
    candidates: s.candidates.map((c) => ({ id: c.id, role: c.role, label: c.label, value: c.value })),
    rectOf: (id) => rectFor(s, id),
  }
}

/** Run a helper verb; the helper answers JSON even when it refuses. */
async function helper(argv: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(HELPER, argv)
    const parsed = JSON.parse(stdout || "{}")
    return parsed.ok === false ? String(parsed.error ?? "refused") : null
  } catch (e: any) {
    try { return String(JSON.parse(e?.stdout || "{}").error ?? e?.message) } catch { return e?.message ?? "failed" }
  }
}

/** Press or type for real. The helper's own guards still apply: it will
 *  not click what something else covers, nor type into a send field. */
export const helperAct: TeachDeps["act"] = async ({ action, rect, label, text }) => {
  const where = ["--x", String(rect.x), "--y", String(rect.y), "--w", String(rect.width), "--h", String(rect.height)]
  const pointed = await helper(["point", ...where, "--label", label.slice(0, 40), "--hold", "0.3"])
  if (pointed) return { error: pointed }
  const clicked = await helper(["click", ...(label ? ["--expect", label.slice(0, 40)] : [])])
  if (clicked || action === "click") return { error: clicked }
  return { error: await helper(["type", "--text", text ?? ""]) }
}
