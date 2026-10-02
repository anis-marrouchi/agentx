// The one look for every docs diagram: white ground, black text, AgentX blue,
// steps that appear in order and then stay. See CONTRIBUTING.md › Diagrams.
// Each diagram is a spec file next to this one; `pnpm docs:diagrams` builds them.

export const C = {
  ground: "#FFFFFF",
  ink: "#0B0D12",
  body: "#475569",
  rule: "#E2E8F0",
  accent: "#1A66FF",
  accentSoft: "#C7D9FF",
  tintBlue: "#F3F7FF",
  tintGrey: "#F6F7F9",
  warn: "#B45309",
  stop: "#DC2626",
  done: "#0F766E",
}

export const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif"

// Seconds between two steps appearing, and between two numbers pulsing.
const STEP = 0.32
const PULSE = 0.7

const STYLE = `
text { font-family: ${FONT}; fill: ${C.ink}; }
.h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
.sub { font-size: 16px; fill: ${C.body}; }
.legend { font-size: 14px; font-weight: 600; }
.band { font-size: 12.5px; font-weight: 700; letter-spacing: 0.12em; fill: ${C.accent}; }
.band.warn { fill: ${C.warn}; }
.title { font-size: 17px; font-weight: 650; }
.note { font-size: 14px; fill: ${C.body}; }
.rowname { font-size: 15px; font-weight: 600; }
.symptom { font-size: 15.5px; font-weight: 650; }
.state { font-size: 12.5px; font-weight: 600; }
.num { font-size: 14.5px; font-weight: 700; fill: #fff; }
.pill { font-size: 13px; font-weight: 700; fill: #fff; }
.wintitle { font-size: 13.5px; font-weight: 600; fill: ${C.body}; }
.card { fill: #fff; stroke: ${C.rule}; stroke-width: 1.25; filter: url(#soft); }
.card.accent { stroke: ${C.accentSoft}; }
.card.win { stroke: ${C.ink}; stroke-width: 1.5; }
.link { fill: none; stroke: ${C.accent}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.wrap { fill: none; stroke: ${C.accent}; stroke-width: 2; stroke-linecap: round; stroke-dasharray: 100; animation: draw 0.9s ease-in-out backwards; }
.rise { animation: rise 0.55s cubic-bezier(.2,.7,.2,1) backwards; }
.fade { animation: fade 0.4s ease-out backwards; }
.pulse { transform-box: fill-box; transform-origin: center; opacity: 0; animation: pulse var(--cycle) ease-out infinite; }
.blink { animation: blink 1.6s ease-in-out infinite; }
@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
@keyframes pulse { 0% { opacity: .7; transform: scale(1); } 9% { opacity: 0; transform: scale(1.9); } 100% { opacity: 0; transform: scale(1.9); } }
@keyframes blink { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .rise, .fade, .wrap, .pulse, .blink { animation: none; } }
`

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const f = n => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const at = s => `style="animation-delay:${s.toFixed(2)}s"`

function text(x, y, s, cls, anchor = "start") {
  return `<text x="${f(x)}" y="${f(y)}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`
}

/**
 * Start a diagram. `margin` is the left and right inset of the content;
 * every method takes plain numbers in the SVG's own units. The default width
 * and the type sizes go together: at the docs column width the text stays
 * readable, and a diagram up to 1300 high prints on one A4 page.
 */
export function createDiagram({ width = 920, height, title, desc, margin = 44 }) {
  const out = []
  const x0 = margin
  const x1 = width - margin
  let steps = 0

  // One numbered step card. `who` picks the number's colour: "accent" for the
  // reader of the page, "ink" for the other person.
  function card(x, y, w, h, { title: lines, note = [], who = "accent" }) {
    steps += 1
    const delay = steps * STEP
    const colour = who === "accent" ? C.accent : C.ink
    const bx = x + 26
    const by = y + 28
    const g = [`<g class="rise" ${at(delay)}>`]
    g.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="14" class="card${who === "accent" ? " accent" : ""}"/>`)
    g.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="15" fill="none" stroke="${colour}" stroke-width="2" class="pulse" data-step="${steps}"/>`)
    g.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="15" fill="${colour}"/>`)
    g.push(text(bx, by + 5, steps, "num", "middle"))
    lines.forEach((line, i) => g.push(text(x + 16, y + 72 + i * 21, line, "title")))
    const ny = y + 72 + lines.length * 21 + 1
    note.forEach((line, i) => g.push(text(x + 16, ny + i * 17, line, "note")))
    g.push("</g>")
    out.push(g.join("\n"))
    return { cx: x + w / 2, top: y, bottom: y + h, at: delay }
  }

  function arrow(xa, xb, y, delay) {
    out.push(
      `<g class="fade" ${at(delay + 0.15)}><path d="M${f(xa + 3)} ${f(y)} H${f(xb - 5)}" class="link"/>` +
        `<path d="M${f(xb - 9)} ${f(y - 4)} L${f(xb - 4)} ${f(y)} L${f(xb - 9)} ${f(y + 4)}" class="link"/></g>`,
    )
  }

  const d = {
    x0,
    x1,
    /** Seconds at which the last step so far appears; use it to time extras. */
    get now() {
      return steps * STEP
    },

    /** Title, one-line summary, and a legend of [colour, label] pairs. */
    header(heading, sub, legend = []) {
      out.push(text(x0, 56, heading, "h1"))
      if (sub) out.push(text(x0, 82, sub, "sub"))
      legend.forEach(([colour, label], i) => {
        out.push(`<circle cx="${x1 - 172}" cy="${50 + i * 24}" r="7" fill="${colour}"/>` + text(x1 - 158, 55 + i * 24, label, "legend"))
      })
    },

    /** A tinted background strip that groups one row. `dx` shifts its label. */
    band(y, h, label, { tint = C.tintBlue, dx = 0 } = {}) {
      out.push(`<rect x="20" y="${y}" width="${width - 40}" height="${h}" rx="20" fill="${tint}"/>`)
      out.push(text(x0 + dx, y + 28, label, "band"))
    },

    /** A row of step cards joined by arrows. Returns one anchor per card. */
    row(items, y, { h = 136, gap = 20, from = x0, to = x1, who } = {}) {
      const w = (to - from - gap * (items.length - 1)) / items.length
      return items.map((item, i) => {
        const x = from + i * (w + gap)
        const anchor = card(x, y, w, h, { ...item, who: who ?? item.who })
        if (i) arrow(x - gap, x, y + h / 2, anchor.at - STEP)
        return anchor
      })
    },

    /** The line that carries the flow from the end of one row to the start of the next. */
    wrap(fromCard, toX, toY, { label } = {}) {
      const xa = fromCard.cx
      const ya = fromCard.bottom
      // Rows in two bands leave a label line above the lower one; the turn sits in the gap between the bands.
      const mid = toY - ya > 60 ? (ya + toY) / 2 - 12 : (ya + toY) / 2
      const delay = fromCard.at + 0.3
      const p = `M${f(xa)} ${f(ya)} V${f(mid - 10)} Q${f(xa)} ${f(mid)} ${f(xa - 10)} ${f(mid)} H${f(toX + 10)} Q${f(toX)} ${f(mid)} ${f(toX)} ${f(mid + 10)} V${f(toY - 4)}`
      out.push(`<path d="${p}" class="wrap" pathLength="100" ${at(delay)}/>`)
      out.push(`<path d="M${f(toX - 5)} ${f(toY - 9)} L${f(toX)} ${f(toY - 3)} L${f(toX + 5)} ${f(toY - 9)}" class="link fade" ${at(delay + 0.9)}/>`)
      if (label) {
        const w = 24 + String(label).length * 6.5
        out.push(
          `<g class="fade" ${at(delay + 0.3)}><rect x="${f(xa - 30 - w)}" y="${f(mid - 11)}" width="${f(w)}" height="22" rx="11" fill="${C.accent}"/>` +
            text(xa - 30 - w / 2, mid + 4.5, label, "pill", "middle") +
            "</g>",
        )
      }
    },

    /** A callout with a coloured bar on its left: the exception to the flow. */
    callout(x, y, w, { title: heading, note, colour = C.stop, delay = d.now }) {
      out.push(
        `<g class="rise" ${at(delay)}><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="68" rx="14" class="card"/>` +
          `<rect x="${f(x)}" y="${f(y)}" width="6" height="68" rx="3" fill="${colour}"/>` +
          text(x + 22, y + 29, heading, "title") +
          text(x + 22, y + 51, note, "note") +
          "</g>",
      )
    },

    /** A small app window with rows of [name, state, colour]: what the reader ends up seeing. */
    window(x, y, w, h, { title: heading, rows, delay = d.now }) {
      const g = [`<g class="rise" ${at(delay)}>`, `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="14" class="card win"/>`, `<path d="M${f(x)} ${f(y + 34)} H${f(x + w)}" stroke="${C.rule}"/>`]
      for (let i = 0; i < 3; i++) g.push(`<circle cx="${f(x + 18 + i * 14)}" cy="${f(y + 17)}" r="4" fill="#CBD5E1"/>`)
      g.push(text(x + w / 2, y + 22, heading, "wintitle", "middle"), "</g>")
      out.push(g.join("\n"))
      rows.forEach(([name, state, colour], i) => {
        const ry = y + 64 + i * 56
        const pw = Math.round(24 + state.length * 6.8)
        out.push(
          `<g class="rise" ${at(delay + 0.5 + i * 0.35)}>` +
            text(x + 18, ry, name, "rowname") +
            `<rect x="${f(x + 18)}" y="${f(ry + 9)}" width="${pw}" height="22" rx="11" fill="${colour}" fill-opacity="0.1"/>` +
            `<circle cx="${f(x + 29)}" cy="${f(ry + 20)}" r="3.5" fill="${colour}"${i === 0 ? ' class="blink"' : ""}/>` +
            `<text x="${f(x + 38)}" y="${f(ry + 24.5)}" class="state" style="fill:${colour}">${esc(state)}</text>` +
            (i < rows.length - 1 ? `<path d="M${f(x + 18)} ${f(ry + 43)} H${f(x + w - 18)}" stroke="${C.rule}"/>` : "") +
            "</g>",
        )
      })
    },

    /** A titled list of [heading, line] pairs with a coloured dot, in `columns`: what to do when it fails. */
    list(x, y, { title: heading, items, columns = 1, colour = C.warn, delay = d.now }) {
      const colWidth = (x1 - x) / columns
      out.push(`<g class="rise" ${at(delay)}>` + text(x, y, heading, "band warn") + "</g>")
      items.forEach(([name, line], i) => {
        const lx = x + (i % columns) * colWidth
        const ly = y + 32 + Math.floor(i / columns) * 52
        out.push(`<g class="rise" ${at(delay + 0.2 + i * 0.25)}><circle cx="${f(lx + 5)}" cy="${f(ly - 5.5)}" r="4" fill="${colour}"/>` + text(lx + 18, ly, name, "symptom") + text(lx + 18, ly + 20, line, "note") + "</g>")
      })
    },

    /** The finished file. Numbers pulse one after the other once everything is drawn. */
    svg() {
      const settle = steps * STEP + 2
      const cycle = (steps * PULSE).toFixed(1)
      const body = out.join("\n").replace(/class="pulse" data-step="(\d+)"/g, (_, n) => `class="pulse" ${at(settle + Number(n) * PULSE)}`)
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d" style="--cycle:${cycle}s">\n` +
        `<title id="t">${esc(title)}</title>\n<desc id="d">${esc(desc)}</desc>\n` +
        `<defs><filter id="soft" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="${C.ink}" flood-opacity="0.07"/></filter></defs>\n` +
        `<style>${STYLE}</style>\n<rect width="${width}" height="${height}" rx="24" fill="${C.ground}"/>\n${body}\n</svg>\n`
      )
    },
  }
  return d
}
