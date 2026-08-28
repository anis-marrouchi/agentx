// Page CSS for /mesh. Kept out of mesh.ts so the page module stays a
// readable assembly of sections rather than a wall of declarations.
//
// Chart colours live here as page-scoped tokens, defined for BOTH themes.
// Two families, deliberately separated:
//   --mx-lane-*   one hue per activity lane. Each lane is its own small
//                 multiple with a single series, so no categorical palette
//                 is in play and none needs validating.
//   --mx-good/warn/serious/crit  the reserved STATUS ramp, used only for
//                 state (a job's verdict, a failed run). Never for identity.
// Verdicts also carry a distinct marker shape and a direct label, so the
// status ramp is never the only thing distinguishing them.
export const MESH_CSS = `
.mx-content{max-width:1180px;margin:0 auto;padding:0 24px 56px}
.mx-updated{margin:0;color:var(--ax-muted);font-size:11px;font-family:var(--ax-mono)}
.mx-section{margin-bottom:28px}.mx-section .ax-section-head{margin-bottom:14px}
.mx-section-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.mx-show-all{padding:4px 9px;font-size:11px;border-radius:var(--ax-radius-sm)}
.mx-columns{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr);gap:24px}
.mx-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.mx-agent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}

/* --- chart tokens ------------------------------------------------- */
/* Scoped to the document root, not .mx-content: the details drawer is a
   sibling of <main> and needs the same status ramp for its run cells.
   Matches how tokens.ts carries the theme (data-theme on <html>). */
:root{
  --mx-lane-cron:#3B82F6;--mx-lane-workflow:#C2255C;--mx-lane-direct:#0E9594;
  --mx-good:#22B573;--mx-warn:#FFB300;--mx-serious:#E8590C;--mx-crit:#F23A3A;
  --mx-grid:var(--ax-border);--mx-track:var(--ax-surface-3);
}
[data-theme="dark"]{
  --mx-lane-cron:#4A86E8;--mx-lane-workflow:#DB3E77;--mx-lane-direct:#159B8B;
  --mx-good:#4ED89B;--mx-warn:#FFC948;--mx-serious:#FF922B;--mx-crit:#FF6B6B;
}

/* --- toolbar ------------------------------------------------------- */
.mx-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 22px}
.mx-tabs{display:flex;gap:0;border:var(--ax-border-w) solid var(--ax-border-2);border-radius:var(--ax-radius-pill);padding:3px;background:var(--ax-surface)}
.mx-tab{border:0;background:transparent;color:var(--ax-text-2);font:600 12px var(--ax-font);padding:6px 14px;border-radius:var(--ax-radius-pill);cursor:pointer}
.mx-tab[aria-selected="true"]{background:var(--ax-accent);color:#fff}
.mx-tab:focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px}
.mx-range{display:flex;gap:6px;margin-left:auto}
.mx-range button{border:var(--ax-border-w) solid var(--ax-border-2);background:var(--ax-surface);color:var(--ax-text-2);font:600 11px var(--ax-mono);padding:5px 10px;border-radius:var(--ax-radius-sm);cursor:pointer}
.mx-range button[aria-pressed="true"]{border-color:var(--ax-accent);color:var(--ax-accent)}
.mx-view[hidden]{display:none}

/* --- activity lanes ------------------------------------------------ */
.mx-lane{display:grid;grid-template-columns:132px minmax(0,1fr) 92px;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--ax-border)}
.mx-lane:last-child{border-bottom:0}
.mx-lane__name{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600}
.mx-lane__swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.mx-lane__peak{font:10px var(--ax-mono);color:var(--ax-muted);margin-top:2px}
.mx-lane__tot{text-align:right;font:11px var(--ax-mono);color:var(--ax-text-2)}
.mx-lane__tot b{display:block;font-size:15px;font-family:var(--ax-font);color:var(--ax-text)}
.mx-cols{display:flex;align-items:flex-end;gap:2px;height:56px}
.mx-col{flex:1 1 0;min-width:2px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;background:none;border:0;padding:0;border-radius:3px;cursor:pointer}
.mx-col:hover,.mx-col:focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px}
.mx-col i{display:block;font-style:normal;border-radius:3px 3px 0 0}
.mx-col i.is-base{border-radius:0 0 3px 3px}
.mx-col i.is-fail{background:var(--mx-crit)}
.mx-col i.is-empty{height:2px;background:var(--ax-border);border-radius:1px}
.mx-axis{display:flex;justify-content:space-between;font:10px var(--ax-mono);color:var(--ax-muted);padding:6px 0 0 146px}
.mx-note{margin:12px 0 0;font-size:11px;color:var(--ax-muted);line-height:1.55}

/* --- horizontal bar lists ------------------------------------------ */
.mx-bars{display:grid;gap:9px}
.mx-bar{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;background:none;border:0;padding:2px 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:var(--ax-radius-sm)}
.mx-bar:hover .mx-bar__label,.mx-bar:focus-visible .mx-bar__label{color:var(--ax-accent)}
.mx-bar:focus-visible{outline:2px solid var(--ax-accent);outline-offset:3px}
.mx-bar__label{font-size:12px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}
.mx-bar__track{position:relative;height:14px;border-radius:4px;background:var(--mx-track);overflow:hidden}
.mx-bar__fill{position:absolute;inset:0 auto 0 0;border-radius:4px}
.mx-bar__fail{position:absolute;top:0;bottom:0;border-radius:4px;background:var(--mx-crit);box-shadow:-2px 0 0 var(--ax-surface)}
.mx-bar__val{font:11px var(--ax-mono);color:var(--ax-text-2);white-space:nowrap}
.mx-bar__val em{font-style:normal;color:var(--ax-muted)}

/* --- scatter -------------------------------------------------------- */
.mx-scatter{position:relative;overflow-x:auto}
/* Below ~700px the plot would shrink its 10px axis labels into noise, so
   it keeps a legible minimum and scrolls inside its own container rather
   than forcing the page to scroll sideways. */
.mx-scatter svg{display:block;width:100%;min-width:660px;height:340px;overflow:visible}
.mx-scatter text{font:10px var(--ax-mono);fill:var(--ax-muted)}
.mx-scatter .mx-pt{cursor:pointer}
.mx-scatter .mx-pt:hover circle,.mx-scatter .mx-pt:hover path,.mx-scatter .mx-pt:hover rect.mx-mark{stroke:var(--ax-text);stroke-width:2}
.mx-scatter .mx-lbl{fill:var(--ax-text-2);font-size:10px}
.mx-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px}
.mx-legend span{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--ax-text-2)}
.mx-legend svg{width:12px;height:12px;overflow:visible}
.mx-tip{position:absolute;z-index:5;pointer-events:none;min-width:170px;padding:9px 11px;border:var(--ax-border-w) solid var(--ax-border-2);border-radius:var(--ax-radius-sm);background:var(--ax-surface);box-shadow:var(--ax-shadow-lg);font-size:11px;line-height:1.5}
.mx-tip b{display:block;font-size:12px;margin-bottom:3px}
.mx-tip dl{display:grid;grid-template-columns:auto auto;gap:2px 10px;margin:4px 0 0;font-family:var(--ax-mono);font-size:10px}
.mx-tip dt{color:var(--ax-muted)}.mx-tip dd{margin:0;text-align:right}

/* --- lifetime ------------------------------------------------------- */
.mx-life{display:grid;grid-template-columns:minmax(150px,200px) minmax(0,1fr) 158px;align-items:center;gap:14px;width:100%;padding:9px 8px;background:none;border:0;border-radius:var(--ax-radius-sm);color:inherit;font:inherit;text-align:left;cursor:pointer}
.mx-life:hover,.mx-life:focus-visible{background:var(--ax-surface-2);outline:none}
.mx-life__id{min-width:0}
.mx-life__id b{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-life__id span{display:block;font:10px var(--ax-mono);color:var(--ax-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-life__span{position:relative;height:20px}
.mx-life__track{position:absolute;top:8px;height:4px;border-radius:2px;background:var(--ax-accent);opacity:.55}
.mx-life__tick{position:absolute;top:2px;width:2px;height:16px;border-radius:1px}
.mx-life__meta{text-align:right;font:10px var(--ax-mono);color:var(--ax-muted)}
.mx-life__meta b{font-family:var(--ax-font);font-size:13px;color:var(--ax-text)}
.mx-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.mx-chip{border:var(--ax-border-w) solid var(--ax-border);background:var(--ax-surface);color:var(--ax-text-2);font:600 11px var(--ax-font);padding:4px 11px;border-radius:var(--ax-radius-pill);cursor:pointer}
.mx-chip[aria-pressed="true"]{border-color:var(--ax-accent);color:var(--ax-accent)}

/* --- run grid + step list (drawer) --------------------------------- */
#mx-drill{display:grid;gap:16px}
.mx-runs{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0 4px}
.mx-run{width:15px;height:15px;border-radius:3px;border:0;padding:0;cursor:pointer}
.mx-run:focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px}
.mx-run[aria-pressed="true"]{box-shadow:0 0 0 2px var(--ax-surface),0 0 0 4px var(--ax-text)}
.mx-touch{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0}
.mx-touch span{border:1px solid var(--ax-border-2);border-radius:var(--ax-radius-pill);padding:2px 9px;font:10px var(--ax-mono);color:var(--ax-text-2)}
.mx-touch span.is-zero{color:var(--ax-muted);opacity:.7}
.mx-steps{margin:0;padding:0;list-style:none;max-height:260px;overflow:auto;border:1px solid var(--ax-border);border-radius:var(--ax-radius-sm)}
.mx-steps li{display:grid;grid-template-columns:30px 1fr auto;gap:8px;padding:5px 9px;font:10px var(--ax-mono);border-bottom:1px solid var(--ax-border)}
.mx-steps li:last-child{border-bottom:0}
.mx-steps li[data-err="1"]{background:var(--ax-red-t)}
.mx-steps .mx-seq{color:var(--ax-muted)}

/* --- shared bits ---------------------------------------------------- */
.mx-item{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;text-align:left;color:var(--ax-text);font:inherit;text-decoration:none;cursor:pointer}
.mx-item:hover,.mx-item:focus-visible{border-color:var(--ax-accent);text-decoration:none;outline:none}
.mx-item[hidden]{display:none}.mx-item .ax-avatar{width:34px;height:34px;border-radius:var(--ax-radius-sm)}
.mx-item .ax-row-card__actions{flex-shrink:0}.mx-item .ax-sub{min-width:0}
.mx-item .ax-sub code{font:11px var(--ax-mono);color:var(--ax-muted)}
.mx-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ax-muted)}
.mx-node-meta{font:11px var(--ax-mono);color:var(--ax-muted)}
.mx-empty{padding:28px 18px;text-align:center;color:var(--ax-muted);font-size:12px;border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);background:var(--ax-surface)}
.mx-link{display:inline-block;margin-top:14px;color:var(--ax-accent);font-size:12px;font-weight:600;text-decoration:none}
.mx-link:hover{text-decoration:underline}
.mx-scrim{position:fixed;inset:0;background:color-mix(in oklch,var(--ax-bg) 55%,black);z-index:29}
.mx-drawer{position:fixed;z-index:30;top:0;right:0;width:min(520px,calc(100vw - 20px));height:100vh;box-sizing:border-box;background:var(--ax-surface);border-left:var(--ax-border-w) solid var(--ax-border-2);transform:translateX(102%);transition:transform 180ms ease;overflow:auto;box-shadow:-12px 0 36px rgba(0,0,0,.2)}
.mx-drawer.is-open{transform:translateX(0)}
.mx-drawer__head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;background:var(--ax-surface);border-bottom:var(--ax-border-w) solid var(--ax-border);z-index:1}
.mx-drawer__head .ax-kicker{font:10px var(--ax-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ax-muted);margin-bottom:4px}
.mx-drawer__head h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.mx-drawer__head .ax-btn{padding:6px 10px;font-size:11px;box-shadow:none}
.mx-drawer__body{padding:20px}
.mx-detail{display:grid;gap:16px}
.mx-detail h3{margin:0 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--ax-muted);font-family:var(--ax-mono)}
.mx-detail dl{display:grid;grid-template-columns:118px 1fr;gap:9px 12px;margin:0;font-size:12px}
.mx-detail dt{color:var(--ax-muted);font-family:var(--ax-mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.mx-detail dd{margin:0;word-break:break-word}
.mx-detail pre{margin:0;padding:14px;background:var(--ax-bg);border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-sm);white-space:pre-wrap;font:11px/1.55 var(--ax-mono)}
.mx-verdict{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:12px}
.mx-verdict i{width:10px;height:10px;border-radius:2px;font-style:normal}

@media(max-width:860px){
  .mx-content{padding:0 16px 40px}
  .mx-columns,.mx-agent-grid,.mx-two{grid-template-columns:1fr}
  .mx-section{margin-bottom:24px}
  .mx-lane{grid-template-columns:1fr;gap:6px}
  .mx-lane__tot{text-align:left}
  .mx-axis{padding-left:0}
  .mx-bar{grid-template-columns:96px minmax(0,1fr)}
  .mx-bar__val{grid-column:1 / -1;text-align:right}
  .mx-life{grid-template-columns:1fr;gap:8px}
  .mx-life__meta{text-align:left}
  .mx-section .ax-section-head__text .ax-lead{display:none}
  .mx-summary{max-width:56vw}
}
@media(prefers-reduced-motion:reduce){.mx-drawer{transition:none}}
`
