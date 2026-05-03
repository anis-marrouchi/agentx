import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { renderShell, type TopbarPeer } from "./ui"

// --- /admin/ledger — intent-ledger explorer ---
//
// Read-only window over .agentx/intent/ledger.sqlite. Same data the
// `agentx ledger` CLI commands surface (stats / events / divergences /
// active), but rendered as a single-page tab UI. Replay and lineage
// stay CLI-only for now — they're interactive enough that piping
// through dashboard JSON would lose value.

interface OpenedDb {
  db: Database.Database
  close: () => void
}

function openReadOnly(): OpenedDb | null {
  const path = resolve(process.cwd(), ".agentx/intent/ledger.sqlite")
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Parse `?since=24h|7d|1h` into a unix-ms cutoff. Returns undefined when
 *  unset so SQL queries omit the WHERE clause entirely. */
function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined
  const m = String(raw).trim().match(/^(\d+)\s*(s|m|h|d|w)?$/i)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = (m[2] || "h").toLowerCase()
  const ms = unit === "s" ? 1000
    : unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
    : unit === "d" ? 86_400_000
    : unit === "w" ? 7 * 86_400_000
    : 0
  return Date.now() - n * ms
}

export async function handleLedgerApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (!path.startsWith("/api/admin/ledger/")) return false
  const slug = path.replace(/^\/api\/admin\/ledger\//, "").split("?")[0]
  const opened = openReadOnly()
  if (!opened) {
    sendJson(res, 503, { error: "intent ledger not available", rows: [] })
    return true
  }
  try {
    const url = new URL(req.url || "/", "http://_")
    const since = parseSince(url.searchParams.get("since"))
    const source = url.searchParams.get("source") || ""
    const project = url.searchParams.get("project") || ""
    const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50

    if (slug === "stats") {
      const sinceClause = since !== undefined ? "WHERE ts >= @since" : ""
      const sinceClauseDecisions = since !== undefined ? "WHERE decided_at >= @since" : ""
      const eventsBySource = opened.db.prepare(
        `SELECT source, COUNT(*) AS n FROM intent_events ${sinceClause} GROUP BY source ORDER BY n DESC`,
      ).all({ since })
      const totalDecisions = (opened.db.prepare(
        `SELECT COUNT(*) AS n FROM intent_decisions ${sinceClauseDecisions}`,
      ).get({ since }) as { n: number }).n
      const decisionsByOutcome = opened.db.prepare(
        `SELECT outcome, COUNT(*) AS n FROM intent_decisions ${sinceClauseDecisions} GROUP BY outcome ORDER BY n DESC`,
      ).all({ since })
      const totalDivergences = (opened.db.prepare(
        `SELECT COUNT(*) AS n FROM intent_divergences ${sinceClause}`,
      ).get({ since }) as { n: number }).n
      const divergencesBySource = opened.db.prepare(
        `SELECT source, COUNT(*) AS n FROM intent_divergences ${sinceClause} GROUP BY source ORDER BY n DESC`,
      ).all({ since })
      const inFlight = (opened.db.prepare(`
        SELECT COUNT(*) AS n FROM intent_decisions d
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE d.outcome = 'dispatched' AND r.decision_event_id IS NULL
      `).get() as { n: number }).n
      sendJson(res, 200, {
        since: since ?? null,
        eventsBySource, totalDecisions, decisionsByOutcome,
        totalDivergences, divergencesBySource, inFlight,
      })
      return true
    }

    if (slug === "events") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (since !== undefined) { where.push("ts >= @since"); params.since = since }
      if (source) { where.push("source = @source"); params.source = source }
      if (project) { where.push("project = @project"); params.project = project }
      const sql = `
        SELECT id, ts, source, source_event_id, project, subject, intent
        FROM intent_events
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY ts DESC LIMIT @limit
      `
      sendJson(res, 200, { rows: opened.db.prepare(sql).all(params) })
      return true
    }

    if (slug === "divergences") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (since !== undefined) { where.push("ts >= @since"); params.since = since }
      if (source) { where.push("source = @source"); params.source = source }
      const sql = `
        SELECT ts, source, decided_by,
               legacy_agent_id, legacy_outcome, legacy_reason,
               ledger_agent_id, ledger_outcome, ledger_reason,
               event_id
        FROM intent_divergences
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY ts DESC LIMIT @limit
      `
      sendJson(res, 200, { rows: opened.db.prepare(sql).all(params) })
      return true
    }

    if (slug === "active") {
      const where: string[] = ["d.outcome = 'dispatched'", "r.decision_event_id IS NULL"]
      const params: Record<string, unknown> = { limit }
      if (source) { where.push("e.source = @source"); params.source = source }
      const sql = `
        SELECT e.id AS event_id, e.ts, e.source, e.project, e.subject, e.intent,
               d.decided_by, d.decided_at, d.agent_id, d.reason
        FROM intent_decisions d
        JOIN intent_events e ON e.id = d.event_id
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE ${where.join(" AND ")}
        ORDER BY d.decided_at DESC LIMIT @limit
      `
      sendJson(res, 200, { rows: opened.db.prepare(sql).all(params) })
      return true
    }

    sendJson(res, 404, { error: "unknown ledger slice", rows: [] })
    return true
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e), rows: [] })
    return true
  } finally {
    opened.close()
  }
}

export interface LedgerPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderLedgerPage(opts: LedgerPageOpts = {}): string {
  const body = `<div class="ax-led">
  <header class="ax-led__head">
    <h1>Intent ledger</h1>
    <p class="ax-led__sub">Read-only view over <code>.agentx/intent/ledger.sqlite</code> — same source as <code>agentx ledger</code>. Replay and lineage live in the CLI for now.</p>
    <nav class="ax-led__tabs" role="tablist">
      <button class="ax-led__tab is-active" data-tab="stats" role="tab">Stats</button>
      <button class="ax-led__tab" data-tab="events" role="tab">Events</button>
      <button class="ax-led__tab" data-tab="divergences" role="tab">Divergences</button>
      <button class="ax-led__tab" data-tab="active" role="tab">In-flight</button>
    </nav>
    <div class="ax-led__filters">
      <label>Since
        <select id="led-since">
          <option value="">all-time</option>
          <option value="1h">last 1h</option>
          <option value="24h" selected>last 24h</option>
          <option value="7d">last 7d</option>
          <option value="30d">last 30d</option>
        </select>
      </label>
      <label>Source
        <input id="led-source" type="text" placeholder="telegram, gitlab, mesh, …" />
      </label>
      <label>Limit
        <input id="led-limit" type="number" min="1" max="500" value="50" />
      </label>
      <button id="led-refresh" type="button">Refresh</button>
    </div>
  </header>

  <section class="ax-led__pane is-active" data-pane="stats">
    <div class="ax-led__kpis" id="led-stats-kpis"></div>
    <div class="ax-led__split">
      <div class="ax-led__card"><h3>Events by source</h3><table class="ax-led__table"><thead><tr><th>source</th><th class="num">count</th></tr></thead><tbody id="led-stats-events"></tbody></table></div>
      <div class="ax-led__card"><h3>Decisions by outcome</h3><table class="ax-led__table"><thead><tr><th>outcome</th><th class="num">count</th></tr></thead><tbody id="led-stats-decisions"></tbody></table></div>
      <div class="ax-led__card"><h3>Divergences by source</h3><table class="ax-led__table"><thead><tr><th>source</th><th class="num">count</th></tr></thead><tbody id="led-stats-divergences"></tbody></table></div>
    </div>
  </section>

  <section class="ax-led__pane" data-pane="events">
    <div class="ax-led__table-wrap"><table class="ax-led__table">
      <thead><tr><th>at</th><th>source</th><th>intent</th><th>project</th><th>subject</th><th class="mono small">id</th></tr></thead>
      <tbody id="led-events"></tbody>
    </table></div>
    <p class="ax-led__empty" id="led-events-empty" hidden>(no rows)</p>
  </section>

  <section class="ax-led__pane" data-pane="divergences">
    <p class="ax-led__hint">When the legacy router and the ledger disagree on what to dispatch — agentx logs both decisions and the difference here. A growing count means the new ledger is observing edge cases the old code path missed (or vice versa); investigate.</p>
    <div class="ax-led__table-wrap"><table class="ax-led__table">
      <thead><tr><th>at</th><th>source</th><th>decided by</th><th>legacy → agent</th><th>ledger → agent</th><th>reason</th></tr></thead>
      <tbody id="led-divergences"></tbody>
    </table></div>
    <p class="ax-led__empty" id="led-divergences-empty" hidden>(no rows)</p>
  </section>

  <section class="ax-led__pane" data-pane="active">
    <p class="ax-led__hint">Decisions where the dispatch landed but no resolution row exists yet. Long-lived rows here are the operationally interesting ones — they're the running tasks.</p>
    <div class="ax-led__table-wrap"><table class="ax-led__table">
      <thead><tr><th>started</th><th>source</th><th>agent</th><th>intent</th><th>subject</th><th>reason</th></tr></thead>
      <tbody id="led-active"></tbody>
    </table></div>
    <p class="ax-led__empty" id="led-active-empty" hidden>(no rows)</p>
  </section>
</div>`

  const css = `
    .ax-led{padding:24px 28px;max-width:1240px;margin:0 auto}
    .ax-led__head h1{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:20px;letter-spacing:-0.01em;margin:0 0 6px}
    .ax-led__sub{color:var(--ax-muted);font-size:12px;margin:0 0 12px}
    .ax-led__tabs{display:flex;gap:2px;border-bottom:1px solid var(--ax-border);margin-bottom:12px;align-items:center}
    .ax-led__tab{font:inherit;font-size:12px;background:none;border:0;border-bottom:2px solid transparent;color:var(--ax-muted);padding:8px 12px;cursor:pointer}
    .ax-led__tab:hover{color:var(--ax-text)}
    .ax-led__tab.is-active{color:var(--ax-text);border-bottom-color:var(--ax-accent,#3a7bd5)}
    .ax-led__filters{display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}
    .ax-led__filters label{font-size:11px;color:var(--ax-muted);display:inline-flex;align-items:center;gap:6px}
    .ax-led__filters input,.ax-led__filters select{font-family:'IBM Plex Mono',monospace;font-size:12px;padding:4px 8px;background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:4px;color:var(--ax-fg)}
    .ax-led__filters button{font-size:11px;padding:5px 11px;border-radius:4px;border:1px solid var(--ax-border);background:var(--ax-bg);color:var(--ax-fg);cursor:pointer}
    .ax-led__filters button:hover{background:var(--ax-surface)}
    .ax-led__pane{display:none}
    .ax-led__pane.is-active{display:block}
    .ax-led__kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
    .ax-led__kpi{background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:6px;padding:10px 12px}
    .ax-led__kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ax-muted);font-weight:600;margin-bottom:4px}
    .ax-led__kpi-value{font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:600}
    .ax-led__split{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
    .ax-led__card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:6px;padding:12px 14px}
    .ax-led__card h3{font-family:'IBM Plex Sans',sans-serif;font-size:12px;font-weight:600;margin:0 0 8px;color:var(--ax-fg);text-transform:uppercase;letter-spacing:0.04em}
    .ax-led__table{width:100%;border-collapse:collapse;font-size:11px;font-family:'IBM Plex Mono',monospace}
    .ax-led__table thead th{text-align:left;padding:5px 7px;border-bottom:1px solid var(--ax-border);font-weight:500;color:var(--ax-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.04em}
    .ax-led__table tbody td{padding:5px 7px;border-bottom:1px solid var(--ax-border);vertical-align:top}
    .ax-led__table tr:hover td{background:var(--ax-surface)}
    .ax-led__table .num{text-align:right;font-variant-numeric:tabular-nums}
    .ax-led__table .small{color:var(--ax-muted);font-size:10px}
    .ax-led__table .mono{font-family:'IBM Plex Mono',monospace}
    .ax-led__table-wrap{overflow-x:auto;max-height:calc(100vh - 280px);overflow-y:auto;border:1px solid var(--ax-border);border-radius:6px}
    .ax-led__empty{color:var(--ax-muted);font-style:italic;padding:18px 0;margin:0}
    .ax-led__hint{color:var(--ax-muted);font-size:11px;margin:0 0 8px}
    .ax-led__pill{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;background:var(--ax-bg);border:1px solid var(--ax-border)}
    .ax-led__pill--err{color:var(--ax-err,#e74c3c);border-color:rgba(231,76,60,0.5)}
    .ax-led__pill--ok{color:#2ecc71}
  `

  const script = `
  (function(){
    var current = 'stats';
    function $(id){ return document.getElementById(id); }
    function esc(s){ if (s == null) return ''; return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function fmtTs(ms){ if (!ms) return ''; var d = new Date(Number(ms)); var pad = function(n){ return n < 10 ? '0' + n : n; }; return d.getMonth()+1 + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
    function fmtNum(n){ return (n||0).toLocaleString(); }
    function kpi(label, value){ return '<div class="ax-led__kpi"><div class="ax-led__kpi-label">' + esc(label) + '</div><div class="ax-led__kpi-value">' + value + '</div></div>'; }

    document.querySelectorAll('.ax-led__tab').forEach(function(t){
      t.addEventListener('click', function(){
        document.querySelectorAll('.ax-led__tab').forEach(function(x){ x.classList.toggle('is-active', x === t); });
        document.querySelectorAll('.ax-led__pane').forEach(function(p){ p.classList.toggle('is-active', p.dataset.pane === t.dataset.tab); });
        current = t.dataset.tab;
        load();
      });
    });
    $('led-refresh').addEventListener('click', load);
    $('led-since').addEventListener('change', load);
    $('led-source').addEventListener('change', load);
    $('led-limit').addEventListener('change', load);

    async function load(){
      var since = $('led-since').value;
      var source = $('led-source').value.trim();
      var limit = $('led-limit').value || 50;
      var qs = '?limit=' + encodeURIComponent(limit);
      if (since) qs += '&since=' + encodeURIComponent(since);
      if (source) qs += '&source=' + encodeURIComponent(source);
      try {
        var r = await fetch('/api/admin/ledger/' + current + qs, { credentials: 'same-origin' });
        var data = await r.json();
        render(current, data);
      } catch (e) {
        console.error('ledger fetch failed', e);
      }
    }
    function render(tab, data){
      if (tab === 'stats') return renderStats(data);
      if (tab === 'events') return renderEvents(data);
      if (tab === 'divergences') return renderDivergences(data);
      if (tab === 'active') return renderActive(data);
    }
    function renderStats(d){
      $('led-stats-kpis').innerHTML = [
        kpi('Decisions', fmtNum(d.totalDecisions)),
        kpi('Divergences', fmtNum(d.totalDivergences)),
        kpi('In-flight', fmtNum(d.inFlight)),
      ].join('');
      $('led-stats-events').innerHTML = (d.eventsBySource || []).map(function(r){
        return '<tr><td>' + esc(r.source) + '</td><td class="num">' + fmtNum(r.n) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="small">(none)</td></tr>';
      $('led-stats-decisions').innerHTML = (d.decisionsByOutcome || []).map(function(r){
        return '<tr><td>' + esc(r.outcome) + '</td><td class="num">' + fmtNum(r.n) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="small">(none)</td></tr>';
      $('led-stats-divergences').innerHTML = (d.divergencesBySource || []).map(function(r){
        return '<tr><td>' + esc(r.source) + '</td><td class="num">' + fmtNum(r.n) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="small">(none)</td></tr>';
    }
    function renderEvents(d){
      var rows = d.rows || [];
      $('led-events-empty').hidden = rows.length > 0;
      $('led-events').innerHTML = rows.map(function(r){
        return '<tr>' +
          '<td>' + esc(fmtTs(r.ts)) + '</td>' +
          '<td><span class="ax-led__pill">' + esc(r.source) + '</span></td>' +
          '<td>' + esc(r.intent || '') + '</td>' +
          '<td>' + esc(r.project || '') + '</td>' +
          '<td class="small">' + esc((r.subject || '').slice(0, 80)) + '</td>' +
          '<td class="small mono">' + esc((r.id || '').slice(0, 16)) + '</td>' +
        '</tr>';
      }).join('');
    }
    function renderDivergences(d){
      var rows = d.rows || [];
      $('led-divergences-empty').hidden = rows.length > 0;
      $('led-divergences').innerHTML = rows.map(function(r){
        var legacy = (r.legacy_outcome || '') + (r.legacy_agent_id ? ' → ' + r.legacy_agent_id : '');
        var ledger = (r.ledger_outcome || '') + (r.ledger_agent_id ? ' → ' + r.ledger_agent_id : '');
        var reason = (r.legacy_reason || r.ledger_reason || '').slice(0, 100);
        return '<tr>' +
          '<td>' + esc(fmtTs(r.ts)) + '</td>' +
          '<td><span class="ax-led__pill">' + esc(r.source) + '</span></td>' +
          '<td>' + esc(r.decided_by || '') + '</td>' +
          '<td>' + esc(legacy) + '</td>' +
          '<td>' + esc(ledger) + '</td>' +
          '<td class="small">' + esc(reason) + '</td>' +
        '</tr>';
      }).join('');
    }
    function renderActive(d){
      var rows = d.rows || [];
      $('led-active-empty').hidden = rows.length > 0;
      $('led-active').innerHTML = rows.map(function(r){
        return '<tr>' +
          '<td>' + esc(fmtTs(r.decided_at)) + '</td>' +
          '<td><span class="ax-led__pill">' + esc(r.source) + '</span></td>' +
          '<td>' + esc(r.agent_id || '') + '</td>' +
          '<td>' + esc(r.intent || '') + '</td>' +
          '<td class="small">' + esc((r.subject || '').slice(0, 80)) + '</td>' +
          '<td class="small">' + esc((r.reason || '').slice(0, 80)) + '</td>' +
        '</tr>';
      }).join('');
    }
    load();
  })();
  `

  return renderShell({
    title: "AgentX · Ledger",
    activeTab: "graph",
    subtitle: "Ledger",
    body,
    css,
    scripts: `<script>${script}</script>`,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
  })
}
