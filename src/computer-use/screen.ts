import { homedir } from "node:os"
import { resolveHelper } from "@/desktop/install"
import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import { resolve } from "path"
import { buildCandidates, type RawElement } from "./candidates"
import type { UICandidate } from "@/decisions/seats/ui-element"

const run = promisify(execFile)

export const HELPER = resolveHelper(process.cwd(), homedir(), process.env.AGENTX_MAC_HELPER)

// --- Reading the screen, with a fallback that changes what is possible ---
//
// The accessibility tree is the primary surface: structured, verifiable,
// and it distinguishes a button from its own caption. Its failure mode is
// that some apps expose nothing at all, and an empty tree is
// indistinguishable from a screen with nothing on it.
//
// Measured on the same VS Code window, at the same moment:
//
//   accessibility tree   5 elements, 3 controls, 1 of them labelled
//   OCR                  133 readable strings
//
// That is the difference between "this app cannot be driven" and "this
// app can be driven". So when the tree comes back thin, the pixels get
// read — locally, by Apple's Vision framework, with nothing uploaded.
//
// OCR candidates are marked, not silently mixed in. Text is weaker
// evidence than a control: it says what is written and where, and nothing
// about whether it can be pressed. A caller that needs to click should
// prefer a real element when one exists.

export interface ScreenRead {
  app: string
  window: string | null
  candidates: UICandidate[]
  elements: Array<RawElement>
  /** True when OCR was consulted because the tree was too thin. */
  usedOCR: boolean
  /** Screen rects for OCR-derived candidates, keyed by candidate id. */
  ocrRects: Map<number, { x: number; y: number; width: number; height: number }>
}

/** Below this many usable candidates, the tree is not worth trusting on
 *  its own. Six is enough for a real toolbar and far more than the one
 *  labelled control VS Code offers. */
const THIN_TREE = 6

export async function readScreen(opts: { max?: number; ocr?: boolean } = {}): Promise<ScreenRead> {
  if (!existsSync(HELPER)) throw new Error("helper not built — run apps/mac-helper/build.sh")

  const { stdout } = await run(HELPER, ["read", "--max", "400"])
  const snap = JSON.parse(stdout) as {
    app: string
    window?: string | null
    elements: RawElement[]
  }
  const candidates = buildCandidates(snap.elements, opts.max ?? 60)
  const ocrRects = new Map<number, { x: number; y: number; width: number; height: number }>()

  const wantOCR = opts.ocr !== false && candidates.length < THIN_TREE
  if (!wantOCR) {
    return {
      app: snap.app, window: snap.window ?? null,
      candidates, elements: snap.elements, usedOCR: false, ocrRects,
    }
  }

  try {
    const { stdout: raw } = await run(HELPER, ["ocr"], { maxBuffer: 8 * 1024 * 1024 })
    const read = JSON.parse(raw) as {
      hits: Array<{ text: string; x: number; y: number; width: number; height: number; confidence: number }>
    }
    // Ids continue past the tree's, so a candidate id still identifies
    // exactly one thing across both sources.
    let nextId = Math.max(0, ...snap.elements.map((e) => e.id)) + 1
    const textCandidates: UICandidate[] = []
    for (const hit of read.hits) {
      // Low-confidence OCR is usually icon edges read as punctuation.
      if (hit.confidence < 0.5 || hit.text.length < 2) continue
      const id = nextId++
      ocrRects.set(id, { x: hit.x, y: hit.y, width: hit.width, height: hit.height })
      textCandidates.push({
        id,
        // A distinct role, so the model is told this is text that was READ
        // off the screen rather than a control the app declared.
        role: "OCRText",
        label: hit.text,
        value: null,
        enabled: true,
      })
      if (textCandidates.length >= (opts.max ?? 60)) break
    }
    return {
      app: snap.app, window: snap.window ?? null,
      candidates: [...candidates, ...textCandidates],
      elements: snap.elements, usedOCR: textCandidates.length > 0, ocrRects,
    }
  } catch {
    // OCR is the fallback; if it fails the tree's answer still stands.
    return {
      app: snap.app, window: snap.window ?? null,
      candidates, elements: snap.elements, usedOCR: false, ocrRects,
    }
  }
}

/** Resolve a chosen candidate id to a screen rect, from either source. */
export function rectFor(
  read: ScreenRead,
  id: number,
): { x: number; y: number; width: number; height: number } | null {
  const el = read.elements.find((e) => e.id === id)
  if (el) return { x: el.x, y: el.y, width: el.width, height: el.height }
  return read.ocrRects.get(id) ?? null
}
