// --- Shared UI components ---
//
// Small helpers that return HTML strings. Used by every page to produce
// consistent badges, cards, form rows, buttons without copy-pasting.
//
// ### Philosophy
//
// - Pure functions: `string` in, `string` out. No classes, no DSL, no JSX.
// - Caller composes: `cardHtml(children)` not `Card({children})`.
// - Null/undefined opts render an empty string, so conditional composition
//   just inlines: `${badge(...) ?? ""}` without wrapper ifs.
// - Variants are flat classnames, not object props: `badge("LIVE", "live")`
//   not `badge({label: "LIVE", variant: "live"})`. Cheaper to read, easier
//   to grep for.

import { esc } from "./util"

// --- Dots (status indicators) ---

export type DotKind = "ok" | "live" | "warn" | "err" | "off" | undefined

export function dot(kind?: DotKind, pulse = false): string {
  const classes = ["ax-dot", kind ? `ax-dot--${kind}` : "", pulse ? "ax-dot--pulse" : ""]
    .filter(Boolean).join(" ")
  return `<span class="${classes}"></span>`
}

// --- Badges (small pill labels) ---

export type BadgeKind = "accent" | "live" | "warn" | "err" | "ghost" | "mono" | undefined

export function badge(label: string, kind?: BadgeKind, extraClass = ""): string {
  const classes = ["ax-badge", kind ? `ax-badge--${kind}` : "", extraClass]
    .filter(Boolean).join(" ")
  return `<span class="${classes}">${esc(label)}</span>`
}

// --- Buttons ---

export interface BtnOpts {
  type?: "button" | "submit"
  primary?: boolean
  ghost?: boolean
  danger?: boolean
  id?: string
  disabled?: boolean
  extraClass?: string
  onclick?: string
}

export function btn(label: string, opts: BtnOpts = {}): string {
  const classes = ["ax-btn",
    opts.primary ? "ax-btn--primary" : "",
    opts.ghost ? "ax-btn--ghost" : "",
    opts.danger ? "ax-btn--danger" : "",
    opts.extraClass || "",
  ].filter(Boolean).join(" ")
  const attrs = [
    `type="${opts.type || "button"}"`,
    `class="${classes}"`,
    opts.id ? `id="${esc(opts.id)}"` : "",
    opts.disabled ? "disabled" : "",
    opts.onclick ? `onclick="${esc(opts.onclick)}"` : "",
  ].filter(Boolean).join(" ")
  return `<button ${attrs}>${esc(label)}</button>`
}

// --- Stat cards (the "NUMBER + label" strip) ---

export interface StatOpts {
  label: string
  value: string
  sub?: string
  kind?: "live" | "warn" | "err"
}

export function stat(opts: StatOpts): string {
  const cls = opts.kind ? `ax-stat ax-stat--${opts.kind}` : "ax-stat"
  return `<div class="${cls}">
    <div class="ax-stat__label">${esc(opts.label)}</div>
    <div class="ax-stat__value">${esc(opts.value)}</div>
    ${opts.sub ? `<div class="ax-stat__sub">${esc(opts.sub)}</div>` : ""}
  </div>`
}

export function statStrip(stats: StatOpts[]): string {
  return `<div class="ax-statstrip">${stats.map(stat).join("")}</div>`
}

// --- Form field (label + input/textarea/select) ---

export interface FieldOpts {
  name: string
  label: string
  hint?: string
  type?: "text" | "password" | "email" | "url" | "number" | "textarea" | "select"
  value?: string
  placeholder?: string
  pattern?: string
  required?: boolean
  readonly?: boolean
  rows?: number
  options?: Array<{ value: string; label: string; selected?: boolean }>
  extraAttrs?: string
}

export function field(opts: FieldOpts): string {
  const labelHtml = `<label>${esc(opts.label)}${
    opts.hint ? ` <span class="ax-hint">${opts.hint}</span>` : ""
  }</label>`
  let controlHtml = ""
  const common = [
    `name="${esc(opts.name)}"`,
    opts.required ? "required" : "",
    opts.readonly ? "readonly" : "",
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : "",
    opts.extraAttrs || "",
  ].filter(Boolean).join(" ")

  if (opts.type === "textarea") {
    controlHtml = `<textarea ${common} rows="${opts.rows || 3}">${esc(opts.value || "")}</textarea>`
  } else if (opts.type === "select" && opts.options) {
    const options = opts.options.map(o =>
      `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`
    ).join("")
    controlHtml = `<select ${common}>${options}</select>`
  } else {
    const type = opts.type || "text"
    controlHtml = `<input type="${type}" ${common}`
      + (opts.value !== undefined ? ` value="${esc(opts.value)}"` : "")
      + (opts.pattern ? ` pattern="${esc(opts.pattern)}"` : "")
      + " />"
  }
  return `<div class="ax-field">${labelHtml}${controlHtml}</div>`
}

export function row(children: string[]): string {
  return `<div class="ax-row">${children.join("")}</div>`
}

// --- Cards ---

export function card(content: string, extraClass = ""): string {
  return `<div class="ax-card${extraClass ? " " + extraClass : ""}">${content}</div>`
}

export function stepCard(num: number | string, title: string, body: string): string {
  return `<section class="ax-step">
    <div class="ax-step__head"><span class="ax-step__num">${esc(String(num))}</span>${esc(title)}</div>
    ${body}
  </section>`
}

// --- Small layout helpers ---

export function spacer(height = 12): string {
  return `<div style="height:${height}px"></div>`
}
