import type { Presence, Rect } from "@/voice/presence"
import type { LineModel } from "@/voice/talk-model"
import type { TldrawApi } from "./tldraw-api"
import { CANVAS, LineSplitter, parseDrawLine, type DrawEl } from "./draw-plan"

// --- Drawing a planned illustration into tldraw offline, live ---
//
// Each element is one /exec request that creates the shape and grows it
// in over GROW_MS, while the agent's presence cursor glides along the
// same path, so it still reads as the agent drawing. The model's plan
// streams in; drawing starts on its first complete line.

export type DrawEvent =
  | { type: "planned"; n: number; el: DrawEl; atMs: number }
  | { type: "drawn"; n: number; el: DrawEl; ms: number }
  | { type: "skipped"; line: string }
  | { type: "error"; error: string }

export interface DrawResult { steps: number; totalMs: number; firstLineMs: number | null; planMs: number }

export interface DrawDeps {
  api: Pick<TldrawApi, "exec">
  presence: Presence
  model: Pick<LineModel, "reply">
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface DrawOpts {
  docId: string
  /** Shortest time one element takes on screen, so its caption can be read. */
  stepMs?: number
  /** Namespaces shape ids, so a second drawing in the same doc can't collide. */
  runTag?: string
  signal?: AbortSignal
}

const GROW_MS = 500

/** Page → screen (accessibility coordinates) for the canvas as framed. */
export interface Frame { ox: number; oy: number; scale: number }

export const frameSnippet = (inset: number) => `
editor.zoomToBounds({ x: 0, y: 0, w: ${CANVAS.w}, h: ${CANVAS.h} }, { inset: ${inset}, immediate: true })
const o = editor.pageToScreen({ x: 0, y: 0 }), e = editor.pageToScreen({ x: ${CANVAS.w}, y: 0 })
const chrome = window.outerHeight - window.innerHeight
return { ox: window.screenX + o.x, oy: window.screenY + chrome + o.y, scale: (e.x - o.x) / ${CANVAS.w} }`

export function toScreen(f: Frame, x: number, y: number, w = 0, h = 0): Rect {
  return { x: f.ox + x * f.scale, y: f.oy + y * f.scale, width: w * f.scale, height: h * f.scale }
}

/** Rough page-space box of a text element, for aiming the cursor. */
export function textBox(el: { text: string; size: string; x: number; y: number }): { x: number; y: number; w: number; h: number } {
  const px = { s: 18, m: 24, l: 32, xl: 44 }[el.size] ?? 32
  return { x: el.x, y: el.y, w: el.text.length * px * 0.6, h: px * 1.3 }
}

/** The /exec body that draws one element, animated. */
export function drawSnippet(el: DrawEl, tag: string): string {
  const id = (s: string) => JSON.stringify(`${tag}-${s}`)
  const common = `const { createShapeId, toRichText } = await import('tldraw')
const el = ${JSON.stringify(el)}
const frames = 10, wait = () => new Promise((r) => setTimeout(r, ${Math.round(GROW_MS / 10)}))
const ease = (t) => 1 - Math.pow(1 - t, 3)`
  if (el.kind === "geo") return `${common}
const id = createShapeId(${id(el.id)})
editor.createShape({ id, type: 'geo', x: el.x, y: el.y, props: { geo: el.geo, w: 1, h: 1, color: el.color, fill: el.fill } })
for (let i = 1; i <= frames; i++) {
  const t = ease(i / frames)
  editor.updateShape({ id, type: 'geo', props: { w: Math.max(1, el.w * t), h: Math.max(1, el.h * t) } })
  await wait()
}
if (el.label) editor.updateShape({ id, type: 'geo', props: { richText: toRichText(el.label) } })
return id`
  if (el.kind === "text") return `${common}
const id = createShapeId(${id(el.id)})
editor.createShape({ id, type: 'text', x: el.x, y: el.y, props: { richText: toRichText(''), size: el.size, color: el.color, font: el.font } })
for (let i = 1; i <= frames; i++) {
  editor.updateShape({ id, type: 'text', props: { richText: toRichText(el.text.slice(0, Math.ceil(el.text.length * i / frames))) } })
  await wait()
}
return id`
  return `${common}
const arrow = helpers.createArrowBetweenShapes(createShapeId(${id(el.from)}), createShapeId(${id(el.to)}), el.label ? { richText: toRichText(el.label) } : {})
const aid = typeof arrow === 'string' ? arrow : arrow?.id
if (aid) editor.updateShape({ id: aid, type: 'arrow', props: { color: el.color } })
return aid ?? null`
}

/** Where the cursor starts and ends while an element is drawn. */
function path(el: DrawEl, placed: Map<string, { x: number; y: number; w: number; h: number }>): [Box, Box] {
  if (el.kind === "geo") return [pt(el.x, el.y), pt(el.x + el.w, el.y + el.h)]
  if (el.kind === "text") { const b = textBox(el); return [pt(b.x, b.y + b.h / 2), pt(b.x + b.w, b.y + b.h / 2)] }
  const a = placed.get(el.from)!, b = placed.get(el.to)!
  return [pt(a.x + a.w / 2, a.y + a.h / 2), pt(b.x + b.w / 2, b.y + b.h / 2)]
}
type Box = { x: number; y: number; w: number; h: number }
const pt = (x: number, y: number): Box => ({ x, y, w: 0, h: 0 })

export async function drawLive(goal: string, deps: DrawDeps, opts: DrawOpts, emit: (e: DrawEvent) => void = () => {}): Promise<DrawResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const stepMs = opts.stepMs ?? 1500
  const tag = opts.runTag ?? now().toString(36)
  const t0 = now()
  const frame = await deps.api.exec<Frame>(opts.docId, frameSnippet(60))

  const known = new Set<string>()
  const placed = new Map<string, Box>()
  const queue: DrawEl[] = []
  let planDone = false, planMs = 0, firstLineMs: number | null = null, planError: string | null = null
  let wake: (() => void) | null = null
  const nudge = () => { wake?.(); wake = null }

  const accept = (line: string) => {
    const el = parseDrawLine(line, known)
    if (!el) { if (line.trim()) emit({ type: "skipped", line: line.slice(0, 120) }); return }
    known.add(el.id)
    firstLineMs ??= now() - t0
    queue.push(el)
    emit({ type: "planned", n: known.size, el, atMs: now() - t0 })
    nudge()
  }
  const plan = (async () => {
    const split = new LineSplitter()
    try {
      for await (const chunk of deps.model.reply(`Draw: ${goal}`, opts.signal)) split.push(chunk).forEach(accept)
      split.flush().forEach(accept)
    } catch (e: any) {
      planError = e?.message ?? String(e)
    } finally {
      planMs = now() - t0
      planDone = true
      nudge()
    }
  })()

  let steps = 0
  for (;;) {
    if (opts.signal?.aborted) break
    const el = queue.shift()
    if (!el) {
      if (planDone) break
      await new Promise<void>((r) => { wake = r })
      continue
    }
    if (el.kind === "arrow" && !(placed.has(el.from) && placed.has(el.to))) {
      emit({ type: "error", error: `${el.id}: an end was not drawn` })
      continue
    }
    const started = now()
    const [from, to] = path(el, placed)
    deps.presence.say(el.say)
    deps.presence.moveTo(toScreen(frame, from.x, from.y))
    await sleep(250)
    deps.presence.moveTo(toScreen(frame, to.x, to.y))
    try {
      await deps.api.exec(opts.docId, drawSnippet(el, tag))
    } catch (e: any) {
      emit({ type: "error", error: `${el.id}: ${e?.message ?? e}` })
      continue
    }
    placed.set(el.id, el.kind === "geo" ? el : el.kind === "text" ? textBox(el) : pt(0, 0))
    steps++
    emit({ type: "drawn", n: steps, el, ms: now() - started })
    const left = stepMs - (now() - started)
    if (left > 0) await sleep(left)
  }
  await plan
  if (planError) emit({ type: "error", error: `plan: ${planError}` })
  deps.presence.park()
  return { steps, totalMs: now() - t0, firstLineMs, planMs }
}
