// --- Glossary page ---
//
// Plain-English definitions of the terms that appear on every dashboard
// surface. Static; sourced from ui-labels.GLOSSARY.
//
// Small surface — could have lived inline in board-dashboard.ts, but
// having it as its own file keeps the "one route, one page module"
// convention and lets the `esc` helper come from ui/util instead of a
// local duplicate.

import { renderShell, esc, type TopbarPeer } from ".."
import { UI_LABELS, GLOSSARY } from "../../ui-labels"

export interface GlossaryPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderGlossaryPage(opts: GlossaryPageOpts = {}): string {
  const items = GLOSSARY.map((g) => {
    const alias = g.alias
      ? `<span class="alias" title="Schema key">${esc(g.alias)}</span>`
      : ""
    return `<article class="term"><h3>${esc(g.term)}${alias}</h3><p>${esc(g.definition)}</p></article>`
  }).join("")

  const body = `<h1>Plain-English glossary</h1>
  <p class="lead">What the terms on the dashboard mean. Schema keys (shown in the pill on the right of each term) are what you'd write in <code>agentx.json</code> — the dashboard just relabels them for readability.</p>
  ${items}`

  return renderShell({
    title: `${UI_LABELS.brand} · Glossary`,
    activeTab: "glossary",
    subtitle: "Glossary",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: GLOSSARY_PAGE_CSS,
  })
}

const GLOSSARY_PAGE_CSS = `
main { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 22px; margin: 0 0 6px; font-weight: 600; letter-spacing: -0.01em; }
.lead {
  color: var(--ax-muted); margin: 0 0 28px;
  font-size: 13px; line-height: 1.6;
}
.lead code {
  font-family: var(--ax-mono); font-size: 12px;
  background: var(--ax-surface); padding: 1px 6px; border-radius: 3px;
  border: 1px solid var(--ax-border);
}
article.term {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: 6px; padding: 16px 20px; margin: 10px 0;
}
article.term h3 {
  font-size: 14px; margin: 0 0 6px;
  display: flex; align-items: center; gap: 10px;
  font-weight: 600; letter-spacing: -0.005em;
}
article.term .alias {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ax-muted); background: var(--ax-bg);
  padding: 2px 7px; border-radius: 3px;
  font-weight: 500; font-family: var(--ax-mono);
  border: 1px solid var(--ax-border);
}
article.term p {
  margin: 0; color: var(--ax-text-2); font-size: 13px; line-height: 1.6;
}`
