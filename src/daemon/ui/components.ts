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

/** Sizes (orca-design C24): `sm` is h-8, `xs` h-6; `icon-9/8/7/6` are square
 *  icon buttons of that Tailwind size. An icon size shows only `icon`; the
 *  label stays on the button for screen readers and becomes its tooltip. */
export type BtnSize = "sm" | "xs" | "icon-9" | "icon-8" | "icon-7" | "icon-6"

export interface BtnOpts {
  type?: "button" | "submit"
  primary?: boolean
  ghost?: boolean
  danger?: boolean
  size?: BtnSize
  /** A lucide SVG drawn before the label. */
  icon?: string
  /** Shortcut letter for an icon button's tooltip chip ("K" shows ⌘K or Ctrl+K). */
  shortcut?: string
  id?: string
  disabled?: boolean
  extraClass?: string
  onclick?: string
  /** Raw attributes, already escaped by the caller. */
  extraAttrs?: string
}

export function btn(label: string, opts: BtnOpts = {}): string {
  const iconOnly = !!opts.size && opts.size.indexOf("icon") === 0
  const classes = ["ax-btn",
    opts.primary ? "ax-btn--primary" : "",
    opts.ghost ? "ax-btn--ghost" : "",
    opts.danger ? "ax-btn--danger" : "",
    opts.size ? "ax-btn--" + opts.size : "",
    opts.extraClass || "",
  ].filter(Boolean).join(" ")
  const attrs = [
    `type="${opts.type || "button"}"`,
    `class="${classes}"`,
    `data-slot="button"`,
    opts.size ? `data-size="${opts.size}"` : "",
    iconOnly ? tip(label, opts.shortcut) : "",
    opts.id ? `id="${esc(opts.id)}"` : "",
    opts.disabled ? "disabled" : "",
    opts.onclick ? `onclick="${esc(opts.onclick)}"` : "",
    opts.extraAttrs || "",
  ].filter(Boolean).join(" ")
  const text = iconOnly ? `<span class="ax-sr">${esc(label)}</span>` : esc(label)
  return `<button ${attrs}>${opts.icon || ""}${text}</button>`
}

// --- Tooltip (orca-design C14) ---
//
// Attributes for any control: components.client.ts shows the label above it
// after 600ms (at once on keyboard focus), with an optional shortcut chip.
// The tooltip only names the control; its accessible name stays on the
// control itself (an sr-only label or its own text).

export function tip(label: string, shortcut?: string): string {
  return `data-tip="${esc(label)}"` + (shortcut ? ` data-tip-key="${esc(shortcut)}"` : "")
}

// --- Lucide icons these helpers draw (lucide-static, ISC) ---
//
// Inline, so the helpers here stay self-contained: a page that draws in the
// browser can ship them with injectFns() (with esc and the helpers they
// call). The test checks the paths against lucide-static. The rest of the
// set: pages/hub-lucide.ts.

export function axIcon(name: "refresh-cw" | "ellipsis", size = 16): string {
  const body = name === "refresh-cw"
    ? '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
    : '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
  return `<svg class="lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
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

// ============================================================================
// Settings-page primitives (from the Stitch redesign)
// ============================================================================

/** Page head — kicker + h1 + lead. Lives outside <main> so it can span wider. */
export interface PageHeadOpts {
  kicker?: string
  title: string
  lead?: string
}
export function pageHead(opts: PageHeadOpts): string {
  return `<div class="ax-page-head">
    ${opts.kicker ? `<div class="ax-kicker">${esc(opts.kicker)}</div>` : ""}
    <h1>${esc(opts.title)}</h1>
    ${opts.lead ? `<p class="ax-lead">${opts.lead}</p>` : ""}
  </div>`
}

/** 4-up health strip: colour-coded status cards across the top of a page. */
export interface HealthCardOpts {
  kind?: "ok" | "warn" | "off"
  num: string
  label: string
}
export function healthCard(opts: HealthCardOpts): string {
  const kind = opts.kind || "off"
  return `<div class="ax-health-card">
    <div class="ax-hc-dot ax-hc-dot--${kind}"></div>
    <div class="ax-hc-txt">
      <div class="ax-hc-num">${esc(opts.num)}</div>
      <div class="ax-hc-lbl">${esc(opts.label)}</div>
    </div>
  </div>`
}
export function healthStrip(cards: HealthCardOpts[]): string {
  return `<div class="ax-health-strip">${cards.map(healthCard).join("")}</div>`
}

/**
 * "What is this?" banner. Renders a dismissable explanatory box for users
 * meeting a tab for the first time. Pass raw HTML for body — short runs
 * with <b> and <code> are the intended style.
 */
export interface WitOpts {
  bodyHtml: string
  /** Persist the dismissal under this key in localStorage. Optional. */
  persistKey?: string
  icon?: string
}
export function witBanner(opts: WitOpts): string {
  const attr = opts.persistKey ? ` data-wit="${esc(opts.persistKey)}"` : ""
  return `<div class="ax-wit"${attr}>
    <span class="ax-wit__icon">${esc(opts.icon || "?")}</span>
    <div>${opts.bodyHtml}</div>
    <button class="ax-wit__dismiss" onclick="this.parentElement.style.display='none'">×</button>
  </div>`
}

/**
 * Section header with icon chip + title + lead + optional right-aligned
 * action. Icon is raw SVG so the caller picks the glyph; feed a 24x24
 * stroked Feather-style icon for best fit.
 */
export interface SectionHeadOpts {
  icon: string
  title: string
  lead?: string
  actionHtml?: string
}
export function sectionHead(opts: SectionHeadOpts): string {
  return `<div class="ax-section-head">
    <div class="ax-section-head__icon">${opts.icon}</div>
    <div class="ax-section-head__text">
      <h2>${esc(opts.title)}</h2>
      ${opts.lead ? `<p class="ax-lead">${esc(opts.lead)}</p>` : ""}
    </div>
    ${opts.actionHtml || ""}
  </div>`
}

/** One avatar (orca-design recipe 2, C6): a 28px muted square with the
 *  initials of `name`. It sits beside the name, so it is hidden from
 *  screen readers. */
export function avatar(name: string): string {
  const words = String(name || "").trim().split(/[\s._-]+/).filter(Boolean)
  const initials = words.slice(0, 2).map((w) => w.charAt(0)).join("").toUpperCase()
  return `<span class="ax-avatar" data-slot="avatar" aria-hidden="true">${esc(initials)}</span>`
}

/**
 * Status pill with coloured dot — "live", "idle", "receiving", "stale".
 * Different from {@link badge}: pill has a rounded shape (10px radius) and
 * a leading dot. Prefer for attached-to-name status labels.
 */
export type PillKind = "ok" | "warn" | "off" | "info" | "plain"
export function pill(label: string, kind: PillKind = "plain", withDot = true): string {
  const cls = kind === "plain" ? "ax-pill" : `ax-pill ax-pill--${kind}`
  const dot = withDot && kind !== "plain" && kind !== "off" ? `<span class="ax-pill__dot"></span>` : ""
  return `<span class="${cls}">${dot}${esc(label)}</span>`
}

/**
 * Row card with colored avatar + info + actions + optional expandable
 * details section. Details are hidden behind `.is-open` on the card;
 * toggleCard() on the client flips it.
 */
export interface RowCardOpts {
  avatarHtml?: string
  /** Left block: title + pills + sub-line. Raw HTML. */
  infoHtml: string
  /** Right-aligned action cluster. Raw HTML (usually btns). */
  actionsHtml?: string
  /** Collapsible details. When provided, the card is collapsible. */
  detailsHtml?: string
  /** Initial open state. Default false. */
  open?: boolean
  /** Extra classes on the card wrapper. */
  extraClass?: string
}
export function rowCard(opts: RowCardOpts): string {
  const cls = ["ax-row-card", opts.open ? "is-open" : "", opts.extraClass || ""]
    .filter(Boolean).join(" ")
  return `<div class="${cls}">
    <div class="ax-row-card__top">
      ${opts.avatarHtml || ""}
      <div class="ax-row-card__info">${opts.infoHtml}</div>
      ${opts.actionsHtml ? `<div class="ax-row-card__actions">${opts.actionsHtml}</div>` : ""}
    </div>
    ${opts.detailsHtml ? `<div class="ax-row-card__details">${opts.detailsHtml}</div>` : ""}
  </div>`
}

/**
 * Channel/webhook-style connector card — big logo, name, status pill,
 * description, foot row. Clickable (caller attaches onclick / wraps
 * in <a>).
 */
export interface ConnectorOpts {
  logoHtml: string
  name: string
  sub: string
  statusHtml?: string
  desc: string
  footLeft?: string
  footCta?: string
  isOn?: boolean
  onclick?: string
  extraStyle?: string
}
export function connector(opts: ConnectorOpts): string {
  const cls = opts.isOn ? "ax-connector is-on" : "ax-connector"
  const onclick = opts.onclick ? ` onclick="${esc(opts.onclick)}"` : ""
  const style = opts.extraStyle ? ` style="${esc(opts.extraStyle)}"` : ""
  return `<div class="${cls}"${onclick}${style}>
    <div class="ax-connector__top">
      ${opts.logoHtml}
      <div class="ax-connector__meta">
        <div class="ax-connector__name">${esc(opts.name)}</div>
        <div class="ax-connector__sub">${esc(opts.sub)}</div>
      </div>
      ${opts.statusHtml ? `<div class="ax-connector__status">${opts.statusHtml}</div>` : ""}
    </div>
    <div class="ax-connector__desc">${opts.desc}</div>
    <div class="ax-connector__foot">
      <span>${esc(opts.footLeft || "")}</span>
      ${opts.footCta
        ? `<span class="ax-connector__cta">${esc(opts.footCta)} <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 2l4 4-4 4"/></svg></span>`
        : ""}
    </div>
  </div>`
}

/** Empty state used when a tab has nothing yet. It always offers the
 *  next step (orca-design C15): `actionHtml` is required. */
export interface EmptyOpts {
  title: string
  desc?: string
  actionHtml: string
}
export function emptyState(opts: EmptyOpts): string {
  return `<div class="ax-empty-card" data-slot="empty" style="text-align:center;padding:42px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)">
    <h3 style="margin:0 0 4px;color:var(--ax-text);font-size:15px;font-weight:600">${esc(opts.title)}</h3>
    ${opts.desc ? `<p style="margin:0 0 16px;font-size:13px;line-height:1.55;max-width:380px;margin-left:auto;margin-right:auto">${esc(opts.desc)}</p>` : ""}
    ${opts.actionHtml}
  </div>`
}

/** A failed load, said where it happened, with Retry beside it (C15).
 *  `retry` is the Retry button's attributes, e.g. `data-act="reload"`. */
export function errorLine(message: string, retry: string): string {
  return `<div class="ax-error" data-slot="error" role="alert"><span>${esc(message)}</span>` +
    btn("Retry", { ghost: true, size: "sm", icon: axIcon("refresh-cw", 14), extraAttrs: retry }) + "</div>"
}

/** Grey shapes of the content while it loads (P8): `rows` (avatar and two
 *  lines) or `cards`. CSS shows them only after 400ms, so a fast load
 *  never flashes them. */
export function skeleton(kind: "rows" | "cards", count = 3): string {
  const lines = '<span class="ax-skel__line"></span><span class="ax-skel__line ax-skel__line--short"></span>'
  const one = kind === "rows"
    ? `<div class="ax-skel__row"><span class="ax-skel__av"></span><span class="ax-skel__lines">${lines}</span></div>`
    : `<div class="ax-skel__card">${lines}</div>`
  let items = ""
  for (let i = 0; i < count; i++) items += one
  return `<div class="ax-skel ax-skel--${kind}" data-slot="skeleton" role="status" aria-busy="true"><span class="ax-sr">Loading</span>${items}</div>`
}

/** One item of a row's `...` menu. `attrs` are its raw attributes. */
export interface MenuItem {
  label: string
  attrs?: string
  danger?: boolean
}

/** A row's rare actions behind `...` (C12). Destructive items go last,
 *  after a separator. components.client.ts opens it, moves focus with the
 *  arrow keys and closes it on Esc, a pick or a click outside. */
export function rowMenu(label: string, items: MenuItem[]): string {
  const item = (m: MenuItem) => `<button type="button" role="menuitem" tabindex="-1" class="ax-menu__item${m.danger ? " ax-menu__item--danger" : ""}"${m.attrs ? " " + m.attrs : ""}>${esc(m.label)}</button>`
  const safe = items.filter((m) => !m.danger).map(item).join("")
  const risky = items.filter((m) => m.danger).map(item).join("")
  return `<div class="ax-menu" data-slot="dropdown-menu">` +
    btn(label, { ghost: true, size: "icon-7", icon: axIcon("ellipsis", 14), extraAttrs: 'aria-haspopup="menu" aria-expanded="false"' }) +
    `<div class="ax-menu__content" data-slot="dropdown-menu-content" role="menu" aria-label="${esc(label)}" hidden>` +
    safe + (safe && risky ? '<div class="ax-menu__sep" role="separator"></div>' : "") + risky + "</div></div>"
}

/** One tab of {@link tabs}. `controls` is the id of the panel it shows. */
export interface TabItem {
  value: string
  label: string
  count?: number
  selected?: boolean
  controls?: string
}

/** The one tabs / segmented control (E2, C16): `aria-selected`, one tab
 *  in the Tab order, arrow keys, Home and End (components.client.ts). On a
 *  change the list fires `ax-tab` with `detail.value`. */
export function tabs(label: string, items: TabItem[]): string {
  let on = items.findIndex((t) => t.selected)
  if (on < 0) on = 0
  return `<div class="ax-tabs" data-slot="tabs-list" role="tablist" aria-label="${esc(label)}">` + items.map((t, i) =>
    `<button type="button" role="tab" class="ax-tabs__tab" data-slot="tabs-trigger" data-value="${esc(t.value)}" aria-selected="${i === on}" tabindex="${i === on ? 0 : -1}"` +
    (t.controls ? ` aria-controls="${esc(t.controls)}"` : "") + `>${esc(t.label)}` +
    (typeof t.count === "number" ? `<span class="ax-tabs__n">${t.count}</span>` : "") + "</button>",
  ).join("") + "</div>"
}

/** Mini-label used to divide sections inside a tab. */
export interface SecLabelOpts {
  label: string
  rightHtml?: string
}
export function secLabel(opts: SecLabelOpts): string {
  return `<div class="ax-sec-label"><h3>${esc(opts.label)}</h3>${opts.rightHtml || ""}</div>`
}

/** Toast element + helper script. Include once per page that uses it. */
export const TOAST_HTML = `<div class="ax-toast" id="ax-toast">
  <svg class="ax-toast__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
  <span id="ax-toast-msg">Copied</span>
</div>`
export const TOAST_SCRIPT = `
  let __axToastTimer;
  window.showToast = function(msg) {
    const el = document.getElementById('ax-toast');
    const m = document.getElementById('ax-toast-msg');
    if (!el || !m) return;
    m.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(__axToastTimer);
    __axToastTimer = setTimeout(function(){ el.classList.remove('is-show'); }, 1800);
  };
  window.copyText = function(_btn, text) {
    try { navigator.clipboard.writeText(text); } catch (e) {}
    window.showToast('Copied to clipboard');
  };`

/** Client script that wires `.ax-row-card` expand/collapse on any button
 *  that calls `toggleCard(this)`. Include once per page. */
export const ROW_CARD_SCRIPT = `
  window.toggleCard = function(btn) {
    const card = btn.closest('.ax-row-card');
    if (card) card.classList.toggle('is-open');
  };`
