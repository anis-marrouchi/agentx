import { createServer } from "http"
import { readdirSync } from "fs"
import { TokenTracker, type DailyUsage, type AgentUsage, type DailyReport } from "./token-tracker"

// --- Usage Dashboard: zero-dep web UI for token cost tracking ---

export function startUsageDashboard(port: number = 4201): void {
  const tracker = new TokenTracker()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`)
    const path = url.pathname

    res.setHeader("Access-Control-Allow-Origin", "*")

    if (path === "/api/usage") {
      const from = url.searchParams.get("from") || ""
      const to = url.searchParams.get("to") || ""
      const data = loadUsageRange(tracker, from, to)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(data))
      return
    }

    if (path === "/api/usage.csv") {
      const from = url.searchParams.get("from") || ""
      const to = url.searchParams.get("to") || ""
      const rows = loadUsageRange(tracker, from, to)
      const header = "date,tasks,input,output,cache_read,cache_create,cost_usd,top_agent"
      const body = rows.map((d) => {
        const top = Object.entries(d.agents).sort(([, a], [, b]) => b.cost - a.cost)[0]
        return [d.date, d.tasks, d.input, d.output, d.cacheRead, d.cacheCreate, d.cost.toFixed(6), top ? top[0] : ""].join(",")
      }).join("\n")
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="agentx-usage-${Date.now()}.csv"`,
      })
      res.end(header + "\n" + body + "\n")
      return
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderDashboard())
  })

  server.listen(port, () => {
    console.log(`\n  Usage dashboard: http://localhost:${port}\n`)
  })
}

// --- Data loading ---

interface UsageDay {
  date: string
  tasks: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
  agents: Record<string, { tasks: number; cost: number; input: number; output: number; cacheRead: number; cacheCreate: number; model?: string }>
}

function loadUsageRange(tracker: TokenTracker, from: string, to: string): UsageDay[] {
  const dir = tracker["dir"] // access private dir for file listing
  const files: string[] = []

  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      const date = f.replace(".json", "")
      if (from && date < from) continue
      if (to && date > to) continue
      files.push(date)
    }
  } catch {
    return []
  }

  files.sort()

  return files.map((date) => {
    const usage = tracker.getDate(date)
    if (!usage) return null

    let tasks = 0, input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0
    const agents: UsageDay["agents"] = {}

    for (const [id, agent] of Object.entries(usage.agents)) {
      const agentCost = TokenTracker.calculateCost(agent)
      // Token displays sum tier1 + tier2 so operators see the REAL volume
      // they paid for. Tier2 tokens (from requests >200K input) are billed
      // at 1.5×, but they're still tokens processed — hiding them made
      // low-display/high-cost days look inconsistent on the dashboard.
      const aInput = (agent.inputTokens || 0) + (agent.tier2InputTokens || 0)
      const aOutput = (agent.outputTokens || 0) + (agent.tier2OutputTokens || 0)
      const aCacheRead = (agent.cacheReadTokens || 0) + (agent.tier2CacheReadTokens || 0)
      const aCacheCreate = (agent.cacheCreateTokens || 0) + (agent.tier2CacheCreateTokens || 0)
      tasks += agent.tasks
      input += aInput
      output += aOutput
      cacheRead += aCacheRead
      cacheCreate += aCacheCreate
      cost += agentCost
      agents[id] = {
        tasks: agent.tasks,
        cost: agentCost,
        input: aInput,
        output: aOutput,
        cacheRead: aCacheRead,
        cacheCreate: aCacheCreate,
        model: agent.model,
      }
    }

    return { date, tasks, input, output, cacheRead, cacheCreate, cost, agents }
  }).filter((d): d is UsageDay => d !== null && d.tasks > 0)
}

// --- HTML rendering ---

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage · AgentX</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <div class="brand-mark">§</div>
    <div class="brand-path"><b>agentx</b><span class="slash">/</span><b>observability</b><span class="slash">/</span>usage</div>
  </div>
  <div class="env-badge" id="envBadge">local</div>
  <div class="topbar-right">
    <a class="backlink" href="/" id="backToMain" title="Back to dashboard">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      <span>Dashboard</span>
    </a>
    <div class="theme-switch" role="tablist" aria-label="Theme">
      <button data-t="dark" class="active">Dark</button>
      <button data-t="midnight">Midnight</button>
    </div>
  </div>
</header>

<div class="page">
  <div class="page-header">
    <div class="page-title">
      <h1>Token usage &amp; cost</h1>
      <p><span class="live-dot"></span>Live telemetry across all agents. Last ingest <span id="lastIngest" class="mono">—</span>.</p>
    </div>
    <div class="controls">
      <div class="segmented" id="rangeSeg">
        <button data-range="7">7d</button>
        <button data-range="14">14d</button>
        <button data-range="30" class="active">30d</button>
        <button data-range="90">90d</button>
        <button data-range="0">All</button>
      </div>
      <div class="date-picker" title="Range">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        <span id="rangeLabel">—</span>
      </div>
      <a class="btn-ghost" id="exportBtn" href="#">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export CSV
      </a>
    </div>
  </div>

  <div class="kpi-row" id="kpis"></div>

  <div class="hero-grid">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Cost over time</div>
          <div class="card-sub">Daily spend, stacked by token category</div>
        </div>
        <div class="card-meta">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:var(--input-c)"></span>Input</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--output-c)"></span>Output</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--cache-r-c)"></span>Cache read</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--cache-w-c)"></span>Cache write</span>
          </div>
        </div>
      </div>
      <div class="card-body hero-chart-wrap">
        <div class="hero-overlay">
          <div class="hero-stat"><div class="v mono" id="heroTotalCost">$0</div><div class="l">Total · range</div></div>
          <div class="hero-stat"><div class="v mono" id="heroPeak">$0</div><div class="l">Peak day</div></div>
          <div class="hero-stat"><div class="v mono" id="heroAvg">$0</div><div class="l">Daily avg</div></div>
        </div>
        <canvas id="heroChart" class="hero-canvas"></canvas>
      </div>
    </div>

    <div class="card dist-card">
      <div class="card-head" style="padding:0 0 10px">
        <div>
          <div class="card-title">Token mix</div>
          <div class="card-sub">Volume by category · range</div>
        </div>
      </div>
      <div id="distList"></div>
      <div class="saved-chip">
        <div class="l">Estimated savings from cache</div>
        <div class="v mono" id="savedChip">$0</div>
      </div>
    </div>
  </div>

  <div class="two-col">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Top agents by spend</div>
          <div class="card-sub">Ranked across the selected range</div>
        </div>
      </div>
      <div class="agent-list" id="agentList"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Cache efficiency</div>
          <div class="card-sub">Hit rate and avoided input cost</div>
        </div>
        <span class="env-badge" id="cacheHealth" style="border-color:color-mix(in oklch,var(--accent) 40%,var(--border))">
          <span style="color:var(--accent);font-weight:600">—</span>
        </span>
      </div>
      <div class="card-body">
        <div class="gauge">
          <div class="gauge-dial">
            <svg width="140" height="140" viewBox="0 0 140 140">
              <circle cx="70" cy="70" r="58" stroke="var(--surface-2)" stroke-width="12" fill="none"/>
              <circle id="gaugeArc" cx="70" cy="70" r="58" stroke="var(--accent)" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="364" stroke-dashoffset="364" transform="rotate(-90 70 70)"/>
            </svg>
            <div class="gauge-readout">
              <div class="num mono" id="gaugeNum">0%</div>
              <div class="lbl">Hit rate</div>
            </div>
          </div>
          <div class="cache-stats">
            <div class="cache-stat"><div class="lbl">Cache reads</div><div class="val mono" id="cacheReads">0 <span class="sub">tok</span></div></div>
            <div class="cache-stat"><div class="lbl">Cache writes</div><div class="val mono" id="cacheWrites">0 <span class="sub">tok</span></div></div>
            <div class="cache-stat"><div class="lbl">Reuse multiplier</div><div class="val mono" id="reuseMult">0×</div></div>
            <div class="cache-stat"><div class="lbl">Avoided input</div><div class="val mono" id="avoidedInput">0</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="card table-card">
    <div class="table-head">
      <div>
        <div class="card-title">Daily detail</div>
        <div class="card-sub">Per-day breakdown with agent attribution</div>
      </div>
      <div class="table-filters">
        <button class="filter-chip active" data-filter="all">All days</button>
        <button class="filter-chip" data-filter="weekdays">Weekdays</button>
        <button class="filter-chip" data-filter="over10">&gt; $10</button>
      </div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="num">Tasks</th>
            <th>Mix</th>
            <th class="num">Input</th>
            <th class="num">Output</th>
            <th class="num">Cache R</th>
            <th class="num">Cache W</th>
            <th class="num">Cost</th>
            <th>Top agents</th>
          </tr>
        </thead>
        <tbody id="dailyTbody"></tbody>
      </table>
    </div>
  </div>
</div>

<script>${JS}</script>
</body>
</html>`
}

// --- Embedded CSS (mockup: cool-neutral dark + electric-lime accent) ---

const CSS = `
:root {
  --bg: oklch(0.16 0.01 250);
  --bg-elev: oklch(0.19 0.012 250);
  --surface: oklch(0.21 0.013 250);
  --surface-2: oklch(0.24 0.014 250);
  --border: oklch(0.28 0.015 250);
  --border-soft: oklch(0.24 0.012 250);
  --text: oklch(0.96 0.005 250);
  --text-2: oklch(0.78 0.01 250);
  --text-3: oklch(0.58 0.012 250);
  --text-4: oklch(0.42 0.012 250);
  --accent: oklch(0.86 0.19 128);
  --accent-dim: oklch(0.86 0.19 128 / 0.14);
  --accent-ink: oklch(0.22 0.05 128);
  --input-c: oklch(0.75 0.12 240);
  --output-c: oklch(0.78 0.13 180);
  --cache-r-c: oklch(0.72 0.10 290);
  --cache-w-c: oklch(0.78 0.13 60);
  --pos: oklch(0.82 0.16 150);
  --neg: oklch(0.72 0.19 25);
  --radius: 10px;
  --radius-sm: 6px;
  --radius-lg: 14px;
  --shadow-sm: 0 1px 0 oklch(1 0 0 / 0.03) inset, 0 1px 2px oklch(0 0 0 / 0.3);
}
html[data-theme="midnight"] { --bg: oklch(0.13 0.015 265); }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bg); }
body { color: var(--text); font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; line-height: 1.4; -webkit-font-smoothing: antialiased; min-height: 100vh; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
button, a { font-family: inherit; cursor: pointer; }
a { color: inherit; text-decoration: none; }

/* TOP BAR */
.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 20px; padding: 12px 24px; background: color-mix(in oklch, var(--bg) 88%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-soft); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
.brand-mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, var(--accent) 0%, oklch(0.78 0.14 160) 100%); display: grid; place-items: center; color: var(--accent-ink); font-weight: 800; font-size: 11px; box-shadow: 0 0 0 1px oklch(1 0 0 / 0.08), 0 2px 8px oklch(0.86 0.19 128 / 0.25); }
.brand-path { color: var(--text-3); font-weight: 400; }
.brand-path b { color: var(--text-2); font-weight: 500; }
.slash { color: var(--text-4); margin: 0 4px; }
.env-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 11px; color: var(--text-2); background: var(--surface); }
.env-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--pos); box-shadow: 0 0 0 2px oklch(0.82 0.16 150 / 0.2); }
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.backlink { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 12px; color: var(--text-2); border: 1px solid var(--border); border-radius: 7px; transition: all .12s; }
.backlink:hover { color: var(--text); border-color: var(--text-4); background: var(--surface); }
.backlink svg { width: 13px; height: 13px; }
.theme-switch { display: inline-flex; padding: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; }
.theme-switch button { background: transparent; border: 0; color: var(--text-3); padding: 3px 10px; font-size: 11px; font-weight: 500; border-radius: 5px; letter-spacing: 0.01em; transition: all .12s; }
.theme-switch button.active { background: var(--surface-2); color: var(--text); }

/* PAGE */
.page { max-width: 1440px; margin: 0 auto; padding: 24px 24px 80px; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 24px; }
.page-title h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; margin-bottom: 6px; }
.page-title p { font-size: 13px; color: var(--text-3); max-width: 540px; }
.page-title .live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: middle; animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.controls { display: flex; gap: 8px; align-items: center; }
.segmented { display: inline-flex; padding: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.segmented button { background: transparent; border: 0; color: var(--text-3); padding: 5px 10px; font-size: 12px; font-weight: 500; border-radius: 6px; transition: all .12s; }
.segmented button.active { background: var(--surface-2); color: var(--text); box-shadow: 0 1px 0 oklch(1 0 0 / 0.04) inset, 0 1px 2px oklch(0 0 0 / 0.2); }
.segmented button:hover:not(.active) { color: var(--text); }
.date-picker { display: inline-flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; font-size: 12px; color: var(--text-2); }
.date-picker svg { width: 13px; height: 13px; color: var(--text-3); }
.btn-ghost { background: var(--surface); color: var(--text-2); border: 1px solid var(--border); padding: 5px 12px; font-size: 12px; font-weight: 500; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; }
.btn-ghost:hover { border-color: var(--text-4); color: var(--text); }
.btn-ghost svg { width: 13px; height: 13px; }

/* KPI ROW */
.kpi-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 20px; box-shadow: var(--shadow-sm); }
.kpi { padding: 18px 20px; border-right: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 8px; position: relative; min-width: 0; }
.kpi:last-child { border-right: 0; }
.kpi-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; }
.kpi-value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; display: flex; align-items: baseline; gap: 4px; }
.kpi-value .unit { font-size: 13px; color: var(--text-3); font-weight: 500; }
.kpi-accent .kpi-value { color: var(--accent); }
.kpi-delta { font-size: 11px; display: inline-flex; align-items: center; gap: 3px; color: var(--text-3); font-weight: 500; }
.kpi-delta.up { color: var(--neg); }
.kpi-delta.down { color: var(--pos); }
.kpi-delta svg { width: 10px; height: 10px; }
.kpi-spark { height: 22px; margin-top: auto; display: flex; align-items: flex-end; gap: 1.5px; }
.kpi-spark .bar { flex: 1; background: var(--text-4); border-radius: 1px; min-height: 2px; opacity: 0.5; }
.kpi-accent .kpi-spark .bar { background: var(--accent); opacity: 0.7; }
.kpi-spark .bar:last-child { opacity: 1; background: var(--accent); }

/* CARD */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); display: flex; flex-direction: column; min-width: 0; }
.card-head { padding: 14px 20px 10px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-title { font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
.card-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.card-head .card-meta { display: flex; align-items: center; gap: 10px; }
.card-body { padding: 4px 20px 18px; flex: 1; min-width: 0; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); font-weight: 500; }
.legend-swatch { width: 8px; height: 8px; border-radius: 2px; }

/* HERO GRID */
.hero-grid { display: grid; grid-template-columns: 1fr 320px; gap: 16px; margin-bottom: 16px; }
@media (max-width: 1200px) { .hero-grid { grid-template-columns: 1fr; } }
.hero-chart-wrap { position: relative; }
.hero-canvas { width: 100%; height: 300px; display: block; }
.hero-overlay { position: absolute; top: 14px; left: 20px; display: flex; gap: 22px; pointer-events: none; }
.hero-stat .v { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--text); }
.hero-stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); font-weight: 500; margin-top: 2px; }

/* DIST */
.dist-card { padding: 14px 18px 18px; }
.dist-row { display: grid; grid-template-columns: 80px 1fr 92px; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px dashed var(--border-soft); }
.dist-row:last-child { border-bottom: 0; }
.dist-label { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-2); font-weight: 500; }
.dist-dot { width: 8px; height: 8px; border-radius: 2px; }
.dist-bar { position: relative; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.dist-bar-fill { height: 100%; border-radius: 3px; transition: width .6s cubic-bezier(0.22,1,0.36,1); }
.dist-val { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-2); text-align: right; font-weight: 500; }
.saved-chip { margin-top: 16px; padding: 10px 12px; background: var(--accent-dim); border: 1px solid color-mix(in oklch, var(--accent) 35%, transparent); border-radius: 8px; display: flex; align-items: center; justify-content: space-between; }
.saved-chip .l { font-size: 11px; color: var(--text-2); }
.saved-chip .v { font-size: 14px; font-weight: 600; color: var(--accent); }

/* TWO COL */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
@media (max-width: 1100px) { .two-col { grid-template-columns: 1fr; } }

/* AGENT LEADERBOARD */
.agent-list { display: flex; flex-direction: column; }
.agent-row { display: grid; grid-template-columns: 22px 1fr 60px 90px 90px; align-items: center; gap: 12px; padding: 10px 20px; border-top: 1px solid var(--border-soft); transition: background .12s; }
.agent-row:hover { background: var(--bg-elev); }
.agent-rank { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-4); font-weight: 500; }
.agent-name-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-ico { width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
.agent-name { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-model { font-size: 10.5px; color: var(--text-3); margin-top: 1px; }
.agent-tasks { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-2); text-align: right; }
.agent-bar-wrap { position: relative; height: 5px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.agent-bar-fill { height: 100%; border-radius: 2px; transition: width .7s cubic-bezier(0.22,1,0.36,1); }
.agent-cost { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; font-weight: 600; text-align: right; color: var(--text); }
.agent-cost .sub { display: block; font-size: 10px; color: var(--text-3); font-weight: 400; margin-top: 1px; }

/* GAUGE */
.gauge { display: grid; grid-template-columns: 140px 1fr; gap: 24px; align-items: center; padding: 6px 0 4px; }
.gauge-dial { position: relative; width: 140px; height: 140px; }
.gauge-readout { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
.gauge-readout .num { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.gauge-readout .lbl { font-size: 10px; color: var(--text-3); letter-spacing: 0.06em; text-transform: uppercase; margin-top: 2px; }
.cache-stats { display: flex; flex-direction: column; gap: 10px; }
.cache-stat { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px dashed var(--border-soft); padding-bottom: 8px; }
.cache-stat:last-child { border-bottom: 0; }
.cache-stat .lbl { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; }
.cache-stat .val { font-size: 14px; font-weight: 600; }
.cache-stat .val .sub { font-size: 10px; color: var(--text-3); margin-left: 4px; font-weight: 400; }

/* TABLE */
.table-card { margin-top: 16px; }
.table-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px 12px; }
.table-filters { display: flex; gap: 6px; }
.filter-chip { background: transparent; border: 1px solid var(--border); color: var(--text-3); font-size: 11px; padding: 3px 10px; border-radius: 999px; transition: all .12s; }
.filter-chip:hover, .filter-chip.active { color: var(--text); background: var(--surface-2); border-color: var(--text-4); }
.table-scroll { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data-table thead th { text-align: left; padding: 8px 20px; background: var(--bg-elev); border-top: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); font-weight: 500; white-space: nowrap; }
.data-table thead th.num, .data-table tbody td.num { text-align: right; font-family: 'JetBrains Mono', monospace; }
.data-table tbody td { padding: 10px 20px; border-bottom: 1px solid var(--border-soft); color: var(--text-2); vertical-align: middle; white-space: nowrap; }
.data-table tbody tr:hover td { background: var(--bg-elev); color: var(--text); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.row-date { color: var(--text); font-weight: 500; }
.row-date .day { color: var(--text-3); font-weight: 400; margin-left: 6px; font-size: 11px; }
.row-cost { color: var(--accent); font-weight: 600; }
.minibar { display: inline-flex; gap: 1px; height: 12px; width: 80px; align-items: flex-end; }
.minibar span { flex: 1; border-radius: 1px; min-height: 1px; display: block; height: 100%; }
.agent-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.agent-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px 2px 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; font-size: 10.5px; color: var(--text-2); }
.agent-chip .d { width: 6px; height: 6px; border-radius: 50%; }
.empty { padding: 40px 20px; text-align: center; color: var(--text-3); font-size: 13px; }

@media (max-width: 1024px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
  .kpi:nth-child(3) { border-right: 0; }
  .kpi { border-bottom: 1px solid var(--border-soft); }
  .kpi:nth-last-child(-n+3) { border-bottom: 0; }
}
@media (max-width: 680px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
  .kpi { border-right: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft); }
  .kpi:nth-child(2n) { border-right: 0; }
}
`

// --- Embedded JavaScript ---

const JS = `
/* ---- state ---- */
let data = [];
let currentRange = 30;
let tableFilter = 'all';

/* ---- formatters ---- */
function fmtTok(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n, digits) {
  if (digits === undefined) digits = 2;
  if (!isFinite(n)) n = 0;
  if (n >= 10000) return '$' + (n/1000).toFixed(1) + 'K';
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(digits);
}
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}
function isWeekday(iso) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/* deterministic color per agent id — hashed hue around the cool palette */
const AGENT_COLOR_CACHE = {};
function agentColor(id) {
  if (AGENT_COLOR_CACHE[id]) return AGENT_COLOR_CACHE[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const c = 'oklch(0.74 0.13 ' + hue + ')';
  AGENT_COLOR_CACHE[id] = c;
  return c;
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ---- theme ---- */
(function initTheme() {
  try {
    const saved = localStorage.getItem('ax-usage-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
})();
document.querySelectorAll('.theme-switch button').forEach(b => {
  b.addEventListener('click', () => {
    const t = b.dataset.t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('ax-usage-theme', t); } catch (e) {}
    document.querySelectorAll('.theme-switch button').forEach(x => x.classList.toggle('active', x === b));
  });
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  b.classList.toggle('active', b.dataset.t === cur);
});

/* back-to-dashboard: link to the same host at the main-dashboard port */
(function wireBack() {
  const a = document.getElementById('backToMain');
  if (a) a.href = window.location.protocol + '//' + window.location.hostname + ':4202/';
})();

/* ---- fetch ---- */
function rangeToParams() {
  const params = new URLSearchParams();
  if (currentRange > 0) {
    const to = new Date();
    const from = new Date(Date.now() - currentRange * 86400000);
    params.set('from', from.toISOString().slice(0,10));
    params.set('to', to.toISOString().slice(0,10));
  }
  return params;
}
async function load() {
  const params = rangeToParams();
  try {
    const res = await fetch('/api/usage?' + params);
    data = await res.json();
  } catch (e) { data = []; }
  render();
}

/* ---- range segmented + export ---- */
document.querySelectorAll('#rangeSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    currentRange = parseInt(b.dataset.range, 10);
    load();
  });
});
document.querySelectorAll('.filter-chip').forEach(c => {
  c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    tableFilter = c.dataset.filter;
    renderTable();
  });
});
document.getElementById('exportBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const params = rangeToParams();
  window.location.href = '/api/usage.csv?' + params;
});

/* ---- KPIs ---- */
function renderKPIs() {
  const totalCost = data.reduce((s,d) => s + d.cost, 0);
  const totalTasks = data.reduce((s,d) => s + d.tasks, 0);
  const totalInput = data.reduce((s,d) => s + d.input, 0);
  const totalOutput = data.reduce((s,d) => s + d.output, 0);
  const totalCacheR = data.reduce((s,d) => s + d.cacheRead, 0);
  const totalCacheW = data.reduce((s,d) => s + d.cacheCreate, 0);
  const avgDaily = data.length ? totalCost / data.length : 0;
  const hitRate = (totalCacheR + totalInput) > 0 ? (totalCacheR / (totalCacheR + totalInput) * 100) : 0;
  const costPerTask = totalTasks > 0 ? totalCost / totalTasks : 0;

  const L = data.length;
  const last7 = data.slice(Math.max(0, L-7)).reduce((s,d)=>s+d.cost,0);
  const prev7 = data.slice(Math.max(0, L-14), Math.max(0, L-7)).reduce((s,d)=>s+d.cost,0);
  const wow = prev7 > 0 ? ((last7 - prev7) / prev7 * 100) : 0;
  const taskLast = data.slice(Math.max(0, L-7)).reduce((s,d)=>s+d.tasks,0);
  const taskPrev = data.slice(Math.max(0, L-14), Math.max(0, L-7)).reduce((s,d)=>s+d.tasks,0);
  const taskDelta = taskPrev > 0 ? ((taskLast-taskPrev)/taskPrev*100) : 0;

  const kpis = [
    { label: 'Total spend', value: fmtCost(totalCost), delta: wow, deltaLabel: 'vs prev 7d', sparks: data.map(d=>d.cost), accent: true },
    { label: 'Daily average', value: fmtCost(avgDaily), sub: '/ day', sparks: data.map(d=>d.cost) },
    { label: 'Tasks run', value: totalTasks.toLocaleString(), delta: taskDelta, deltaLabel: 'vs prev 7d', sparks: data.map(d=>d.tasks) },
    { label: 'Tokens processed', value: fmtTok(totalInput + totalOutput + totalCacheR + totalCacheW), sub: 'tok', sparks: data.map(d => d.input + d.output + d.cacheRead + d.cacheCreate) },
    { label: 'Cache hit rate', value: hitRate.toFixed(0) + '%', sparks: data.map(d => d.cacheRead / Math.max(1, d.cacheRead + d.input) * 100) },
    { label: 'Cost / task', value: fmtCost(costPerTask, 3), sparks: data.map(d => d.cost / Math.max(1, d.tasks)) },
  ];

  document.getElementById('kpis').innerHTML = kpis.map(k => {
    const max = Math.max.apply(null, k.sparks.concat([0.0001]));
    const bars = k.sparks.map(v => '<div class="bar" style="height:' + Math.max(2, (v/max)*100) + '%"></div>').join('');
    let deltaHtml = '';
    if (k.delta !== undefined) {
      const up = k.delta > 0;
      const cls = up ? 'up' : 'down';
      const arrow = up
        ? '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 7l3-3 3 3M5 4v5"/></svg>'
        : '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3l3 3 3-3M5 6V1"/></svg>';
      deltaHtml = '<div class="kpi-delta ' + cls + '">' + arrow + Math.abs(k.delta).toFixed(1) + '% ' + k.deltaLabel + '</div>';
    }
    const sub = k.sub ? '<span class="unit">' + k.sub + '</span>' : '';
    return '<div class="kpi ' + (k.accent ? 'kpi-accent' : '') + '">' +
      '<div class="kpi-label">' + k.label + '</div>' +
      '<div class="kpi-value mono">' + k.value + sub + '</div>' +
      deltaHtml +
      '<div class="kpi-spark">' + bars + '</div>' +
    '</div>';
  }).join('');
}

/* ---- Hero stacked bar chart ---- */
function setupCanvas(id, hOverride) {
  const canvas = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const w = rect.width;
  const h = hOverride || canvas.clientHeight || 260;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function roundRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h); ctx.lineTo(x, y+h);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}
function renderHero() {
  const { ctx, w, h } = setupCanvas('heroChart', 300);
  if (!data.length) {
    ctx.fillStyle = getCss('--text-3');
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('No usage data in this range', w/2, h/2);
    document.getElementById('heroTotalCost').textContent = '$0';
    document.getElementById('heroPeak').textContent = '$0';
    document.getElementById('heroAvg').textContent = '$0';
    return;
  }
  const pad = { t: 70, r: 16, b: 28, l: 48 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  const series = data.map(d => {
    const tot = d.input + d.output + d.cacheRead + d.cacheCreate;
    if (!tot) return { input:0, output:0, cacheR:0, cacheW:0, total: d.cost };
    return {
      input:  d.cost * (d.input / tot),
      output: d.cost * (d.output / tot),
      cacheR: d.cost * (d.cacheRead / tot),
      cacheW: d.cost * (d.cacheCreate / tot),
      total:  d.cost,
    };
  });
  const maxTot = Math.max.apply(null, series.map(s=>s.total).concat([0.001]));

  ctx.font = '10.5px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (maxTot / 4) * i;
    const y = pad.t + ch - (i / 4) * ch;
    ctx.strokeStyle = getCss('--border-soft');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y + 0.5); ctx.lineTo(pad.l + cw, y + 0.5); ctx.stroke();
    ctx.fillStyle = getCss('--text-4');
    ctx.fillText(fmtCost(v, 0), pad.l - 8, y);
  }

  ctx.fillStyle = getCss('--text-3');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10.5px Inter';
  const nLabels = Math.min(7, data.length);
  for (let i = 0; i < nLabels; i++) {
    const idx = Math.round((i / (nLabels - 1 || 1)) * (data.length - 1));
    const x = pad.l + (idx / Math.max(1, data.length - 1)) * cw;
    ctx.fillText(fmtDate(data[idx].date), x, pad.t + ch + 10);
  }

  const catOrder = [
    { k: 'input',  color: getCss('--input-c') },
    { k: 'output', color: getCss('--output-c') },
    { k: 'cacheR', color: getCss('--cache-r-c') },
    { k: 'cacheW', color: getCss('--cache-w-c') },
  ];
  const barW = Math.max(2, (cw / data.length) * 0.7);
  const gap  = cw / data.length;

  data.forEach((d, i) => {
    const s = series[i];
    const x = pad.l + i * gap + (gap - barW) / 2;
    let yOff = 0;
    catOrder.forEach((c, ci) => {
      const v = s[c.k];
      const barH = (v / maxTot) * ch;
      const y = pad.t + ch - yOff - barH;
      ctx.fillStyle = c.color;
      const radius = ci === catOrder.length - 1 ? 2 : 0;
      roundRect(ctx, x, y, barW, barH + 0.5, radius);
      ctx.fill();
      yOff += barH;
    });
  });

  const total = series.reduce((s, p) => s + p.total, 0);
  const peak = Math.max.apply(null, series.map(p => p.total));
  const avg = total / Math.max(1, series.length);
  document.getElementById('heroTotalCost').textContent = fmtCost(total);
  document.getElementById('heroPeak').textContent = fmtCost(peak);
  document.getElementById('heroAvg').textContent = fmtCost(avg);
}

/* ---- Distribution + savings chip ---- */
function renderDistribution() {
  const tot = { input:0, output:0, cacheRead:0, cacheCreate:0 };
  data.forEach(d => { tot.input += d.input; tot.output += d.output; tot.cacheRead += d.cacheRead; tot.cacheCreate += d.cacheCreate; });
  const grand = tot.input + tot.output + tot.cacheRead + tot.cacheCreate;
  const items = [
    { lbl: 'Input',       v: tot.input,       c: 'var(--input-c)' },
    { lbl: 'Output',      v: tot.output,      c: 'var(--output-c)' },
    { lbl: 'Cache read',  v: tot.cacheRead,   c: 'var(--cache-r-c)' },
    { lbl: 'Cache write', v: tot.cacheCreate, c: 'var(--cache-w-c)' },
  ];
  const max = Math.max.apply(null, items.map(i => i.v).concat([1]));
  document.getElementById('distList').innerHTML = items.map(it => {
    const pct = grand > 0 ? (it.v / grand * 100) : 0;
    const barPct = (it.v / max) * 100;
    return '<div class="dist-row">' +
      '<div class="dist-label"><span class="dist-dot" style="background:' + it.c + '"></span>' + it.lbl + '</div>' +
      '<div class="dist-bar"><div class="dist-bar-fill" style="width:' + barPct + '%;background:' + it.c + '"></div></div>' +
      '<div class="dist-val">' + fmtTok(it.v) + ' · ' + pct.toFixed(0) + '%</div>' +
    '</div>';
  }).join('');
  // rough savings: cache-read tokens priced at ~10% of input. Matches mockup formula.
  const savedCost = (tot.cacheRead * 0.9) / 1e6 * 3;
  document.getElementById('savedChip').textContent = fmtCost(savedCost);
}

/* ---- Agent leaderboard ---- */
function renderAgents() {
  const totals = {};
  data.forEach(d => {
    for (const id in d.agents) {
      const a = d.agents[id];
      if (!totals[id]) totals[id] = { cost:0, tasks:0, input:0, output:0, cacheR:0, cacheW:0, model: a.model || '' };
      totals[id].cost += a.cost; totals[id].tasks += a.tasks;
      totals[id].input += a.input; totals[id].output += a.output;
      totals[id].cacheR += a.cacheRead; totals[id].cacheW += a.cacheCreate;
      if (a.model) totals[id].model = a.model;
    }
  });
  const items = Object.keys(totals).map(id => [id, totals[id]]).sort((a,b) => b[1].cost - a[1].cost).slice(0, 12);
  const max = items[0] ? items[0][1].cost : 1;
  const container = document.getElementById('agentList');
  if (!items.length) { container.innerHTML = '<div class="empty">No agent activity</div>'; return; }
  container.innerHTML = items.map((pair, i) => {
    const id = pair[0], a = pair[1];
    const c = agentColor(id);
    const initials = id.split('-').map(s => s[0]).join('').slice(0,2).toUpperCase();
    const iconBg = 'color-mix(in oklch, ' + c + ' 22%, var(--surface-2))';
    const barPct = (a.cost / max) * 100;
    return '<div class="agent-row">' +
      '<div class="agent-rank">' + String(i+1).padStart(2,'0') + '</div>' +
      '<div class="agent-name-wrap">' +
        '<div class="agent-ico" style="background:' + iconBg + ';color:' + c + '">' + initials + '</div>' +
        '<div style="min-width:0">' +
          '<div class="agent-name">' + id + '</div>' +
          (a.model ? '<div class="agent-model">' + a.model + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="agent-tasks">' + a.tasks.toLocaleString() + '</div>' +
      '<div class="agent-bar-wrap"><div class="agent-bar-fill" style="width:' + barPct + '%;background:' + c + '"></div></div>' +
      '<div class="agent-cost">' + fmtCost(a.cost) + '<span class="sub">' + fmtTok(a.input + a.output + a.cacheR + a.cacheW) + ' tok</span></div>' +
    '</div>';
  }).join('');
}

/* ---- Cache gauge ---- */
function renderCache() {
  const tot = data.reduce((s,d) => ({ r: s.r + d.cacheRead, w: s.w + d.cacheCreate, i: s.i + d.input }), { r:0, w:0, i:0 });
  const hit = (tot.r + tot.i) > 0 ? tot.r / (tot.r + tot.i) * 100 : 0;
  const circ = 2 * Math.PI * 58;
  const offset = circ - (hit / 100) * circ;
  const arc = document.getElementById('gaugeArc');
  arc.style.strokeDasharray = circ.toFixed(1);
  arc.style.strokeDashoffset = circ.toFixed(1);
  requestAnimationFrame(() => {
    arc.style.transition = 'stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)';
    arc.style.strokeDashoffset = offset.toFixed(1);
  });
  document.getElementById('gaugeNum').textContent = hit.toFixed(0) + '%';
  document.getElementById('cacheReads').innerHTML = fmtTok(tot.r) + ' <span class="sub">tok</span>';
  document.getElementById('cacheWrites').innerHTML = fmtTok(tot.w) + ' <span class="sub">tok</span>';
  const mult = tot.w > 0 ? (tot.r / tot.w) : 0;
  document.getElementById('reuseMult').textContent = mult.toFixed(1) + '×';
  document.getElementById('avoidedInput').textContent = fmtTok(tot.r);
  const healthLabel = hit >= 60 ? 'Healthy' : hit >= 30 ? 'Warming up' : 'Cold';
  document.getElementById('cacheHealth').innerHTML = '<span style="color:var(--accent);font-weight:600">' + healthLabel + '</span>';
}

/* ---- Daily table ---- */
function renderTable() {
  const tbody = document.getElementById('dailyTbody');
  let rows = data.slice().reverse();
  if (tableFilter === 'weekdays') rows = rows.filter(r => isWeekday(r.date));
  else if (tableFilter === 'over10') rows = rows.filter(r => r.cost > 10);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No rows match this filter.</td></tr>'; return; }
  tbody.innerHTML = rows.map(d => {
    const tot = d.input + d.output + d.cacheRead + d.cacheCreate || 1;
    const mix = [
      { v: d.input,       c: 'var(--input-c)' },
      { v: d.output,      c: 'var(--output-c)' },
      { v: d.cacheRead,   c: 'var(--cache-r-c)' },
      { v: d.cacheCreate, c: 'var(--cache-w-c)' },
    ];
    const mixHtml = mix.map(m => '<span style="flex:' + (m.v/tot) + ';background:' + m.c + '"></span>').join('');
    const topAgents = Object.keys(d.agents).map(id => [id, d.agents[id]]).sort((a,b) => b[1].cost - a[1].cost).slice(0, 3);
    const chips = topAgents.map(pair => {
      const id = pair[0];
      return '<span class="agent-chip"><span class="d" style="background:' + agentColor(id) + '"></span>' + id + '</span>';
    }).join('');
    return '<tr>' +
      '<td class="row-date">' + fmtDate(d.date) + '<span class="day">' + fmtDay(d.date) + '</span></td>' +
      '<td class="num">' + d.tasks.toLocaleString() + '</td>' +
      '<td><div class="minibar">' + mixHtml + '</div></td>' +
      '<td class="num">' + fmtTok(d.input) + '</td>' +
      '<td class="num">' + fmtTok(d.output) + '</td>' +
      '<td class="num">' + fmtTok(d.cacheRead) + '</td>' +
      '<td class="num">' + fmtTok(d.cacheCreate) + '</td>' +
      '<td class="num row-cost">' + fmtCost(d.cost) + '</td>' +
      '<td>' + chips + '</td>' +
    '</tr>';
  }).join('');
}

/* ---- meta chrome ---- */
function updateRangeLabel() {
  const el = document.getElementById('rangeLabel');
  const li = document.getElementById('lastIngest');
  const badge = document.getElementById('envBadge');
  if (badge) badge.textContent = window.location.hostname;
  if (!data.length) { el.textContent = 'No data'; if (li) li.textContent = '—'; return; }
  el.textContent = fmtDate(data[0].date) + ' – ' + fmtDate(data[data.length - 1].date);
  if (li) li.textContent = data[data.length - 1].date;
}

/* ---- main render ---- */
function render() {
  updateRangeLabel();
  renderKPIs();
  renderHero();
  renderDistribution();
  renderAgents();
  renderCache();
  renderTable();
}

window.addEventListener('resize', () => { renderHero(); });

/* initial */
load();
`

export default startUsageDashboard
