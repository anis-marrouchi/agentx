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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX Usage Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="header">
  <h1>AgentX Usage Dashboard</h1>
  <div class="filters">
    <label>From <input type="date" id="from"></label>
    <label>To <input type="date" id="to"></label>
    <button onclick="load()">Apply</button>
    <button onclick="setRange(7)">7d</button>
    <button onclick="setRange(14)">14d</button>
    <button onclick="setRange(30)">30d</button>
    <button onclick="setRange(0)">All</button>
  </div>
</div>

<div class="stats" id="stats"></div>

<div class="grid">
  <div class="card">
    <h2>Cost Over Time</h2>
    <canvas id="costChart" height="260"></canvas>
  </div>
  <div class="card">
    <h2>Tokens Over Time</h2>
    <canvas id="tokenChart" height="260"></canvas>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Cost Per Agent</h2>
    <canvas id="agentChart" height="260"></canvas>
  </div>
  <div class="card">
    <h2>Token Breakdown</h2>
    <canvas id="breakdownChart" height="260"></canvas>
  </div>
</div>

<div class="card">
  <h2>Daily Detail</h2>
  <table id="table">
    <thead>
      <tr><th>Date</th><th>Tasks</th><th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th><th>Cost</th><th>Top Agent</th></tr>
    </thead>
    <tbody></tbody>
  </table>
</div>

<script>${JS}</script>
</body>
</html>`
}

// --- Embedded CSS ---

const CSS = `
:root {
  --bg: #0f1117;
  --card: #1a1d27;
  --border: #2a2d3a;
  --text: #e1e4ed;
  --muted: #8b8fa3;
  --accent: #6366f1;
  --green: #22c55e;
  --orange: #f59e0b;
  --red: #ef4444;
  --blue: #3b82f6;
  --purple: #a855f7;
  --cyan: #06b6d4;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
h1 { font-size: 20px; font-weight: 600; }
h2 { font-size: 14px; font-weight: 500; color: var(--muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.filters label { font-size: 13px; color: var(--muted); }
.filters input { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
.filters button { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.15s; }
.filters button:hover { background: var(--accent); border-color: var(--accent); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.stat .value { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
.stat .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.stat .delta { font-size: 12px; margin-top: 4px; }
.stat .delta.up { color: var(--red); }
.stat .delta.down { color: var(--green); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
canvas { width: 100% !important; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
tr:hover td { background: rgba(99, 102, 241, 0.05); }
.cost { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.tok { font-variant-numeric: tabular-nums; }
`

// --- Embedded JavaScript ---

const JS = `
let data = [];

function fmtTok(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return String(n);
}
function fmtCost(n) { return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2); }

function setRange(days) {
  if (days === 0) {
    document.getElementById('from').value = '';
    document.getElementById('to').value = '';
  } else {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    document.getElementById('from').value = from.toISOString().slice(0,10);
    document.getElementById('to').value = to.toISOString().slice(0,10);
  }
  load();
}

async function load() {
  const from = document.getElementById('from').value;
  const to = document.getElementById('to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await fetch('/api/usage?' + params);
  data = await res.json();
  render();
}

function render() {
  renderStats();
  renderCostChart();
  renderTokenChart();
  renderAgentChart();
  renderBreakdownChart();
  renderTable();
}

function renderStats() {
  const el = document.getElementById('stats');
  const totalCost = data.reduce((s,d) => s + d.cost, 0);
  const totalTasks = data.reduce((s,d) => s + d.tasks, 0);
  const totalInput = data.reduce((s,d) => s + d.input, 0);
  const totalOutput = data.reduce((s,d) => s + d.output, 0);
  const totalCacheR = data.reduce((s,d) => s + d.cacheRead, 0);
  const totalCacheW = data.reduce((s,d) => s + d.cacheCreate, 0);
  const cacheRatio = (totalCacheR + totalCacheW) > 0 ? (totalCacheR / (totalCacheR + totalCacheW) * 100).toFixed(0) : '0';
  const avgDaily = data.length > 0 ? totalCost / data.length : 0;

  // Delta: compare last day vs previous
  let delta = '';
  if (data.length >= 2) {
    const last = data[data.length-1].cost;
    const prev = data[data.length-2].cost;
    if (prev > 0) {
      const pct = ((last - prev) / prev * 100).toFixed(0);
      const cls = last > prev ? 'up' : 'down';
      const arrow = last > prev ? '\\u2191' : '\\u2193';
      delta = '<div class="delta ' + cls + '">' + arrow + ' ' + Math.abs(pct) + '% vs prev day</div>';
    }
  }

  el.innerHTML =
    stat(fmtCost(totalCost), 'Total Cost', delta) +
    stat(fmtCost(avgDaily), 'Avg Daily Cost', '') +
    stat(totalTasks.toLocaleString(), 'Total Tasks', '') +
    stat(fmtTok(totalInput + totalOutput), 'Tokens (I/O)', '') +
    stat(fmtTok(totalCacheR), 'Cache Reads', '') +
    stat(cacheRatio + '%', 'Cache Hit Rate', '') +
    stat(data.length.toString(), 'Days Tracked', '');
}

function stat(value, label, extra) {
  return '<div class="stat"><div class="value">' + value + '</div><div class="label">' + label + '</div>' + extra + '</div>';
}

// --- Canvas chart helpers ---
function drawLine(ctx, points, w, h, color, fill) {
  if (points.length < 2) return;
  const max = Math.max(...points, 0.001);
  const pad = { t: 10, r: 10, b: 30, l: 50 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((v, i) => {
    const x = pad.l + (i / (points.length - 1)) * cw;
    const y = pad.t + ch - (v / max) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (fill) {
    ctx.lineTo(pad.l + cw, pad.t + ch);
    ctx.lineTo(pad.l, pad.t + ch);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // Y axis labels
  ctx.fillStyle = '#8b8fa3';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = pad.t + ch - (i / 4) * ch;
    ctx.fillText(v >= 1000 ? fmtTok(v) : v < 0.01 ? v.toFixed(4) : v.toFixed(2), pad.l - 6, y + 4);
    ctx.strokeStyle = '#2a2d3a';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
  }

  // X axis labels (first, middle, last)
  ctx.fillStyle = '#8b8fa3';
  ctx.textAlign = 'center';
  if (data.length > 0) {
    const labels = [0, Math.floor(data.length/2), data.length-1];
    labels.forEach(i => {
      if (i < data.length) {
        const x = pad.l + (i / (points.length - 1)) * cw;
        ctx.fillText(data[i].date.slice(5), x, pad.t + ch + 18);
      }
    });
  }
}

function drawBars(ctx, items, w, h, colors) {
  if (items.length === 0) return;
  const max = Math.max(...items.map(i => i.value), 0.001);
  const pad = { t: 10, r: 10, b: 60, l: 60 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const barW = Math.min(40, (cw / items.length) * 0.7);
  const gap = cw / items.length;

  items.forEach((item, i) => {
    const barH = (item.value / max) * ch;
    const x = pad.l + i * gap + (gap - barW) / 2;
    const y = pad.t + ch - barH;
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 3);
    ctx.fill();

    // Label
    ctx.fillStyle = '#8b8fa3';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.translate(x + barW/2, pad.t + ch + 12);
    ctx.rotate(-0.4);
    ctx.fillText(item.label.length > 14 ? item.label.slice(0,12) + '..' : item.label, 0, 0);
    ctx.restore();

    // Value on top
    ctx.fillStyle = '#e1e4ed';
    ctx.textAlign = 'center';
    ctx.fillText(item.fmt, x + barW/2, y - 6);
  });
}

function drawStacked(ctx, series, labels, w, h, colors) {
  if (labels.length === 0) return;
  const pad = { t: 10, r: 10, b: 30, l: 50 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  // Calculate totals for max
  const totals = labels.map((_, i) => series.reduce((s, sr) => s + sr.values[i], 0));
  const max = Math.max(...totals, 1);

  const barW = Math.min(30, (cw / labels.length) * 0.7);
  const gap = cw / labels.length;

  labels.forEach((_, li) => {
    let yOffset = 0;
    series.forEach((sr, si) => {
      const val = sr.values[li];
      const barH = (val / max) * ch;
      const x = pad.l + li * gap + (gap - barW) / 2;
      const y = pad.t + ch - yOffset - barH;
      ctx.fillStyle = colors[si % colors.length];
      ctx.fillRect(x, y, barW, barH);
      yOffset += barH;
    });
  });

  // Legend
  ctx.font = '11px -apple-system, sans-serif';
  series.forEach((sr, i) => {
    const x = pad.l + i * 100;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(x, h - 16, 10, 10);
    ctx.fillStyle = '#8b8fa3';
    ctx.textAlign = 'left';
    ctx.fillText(sr.name, x + 14, h - 7);
  });

  // X axis
  ctx.fillStyle = '#8b8fa3';
  ctx.textAlign = 'center';
  if (data.length > 0) {
    [0, Math.floor(labels.length/2), labels.length-1].forEach(i => {
      if (i < labels.length) {
        const x = pad.l + (i / Math.max(labels.length-1,1)) * cw;
        ctx.fillText(labels[i].slice(5), x, pad.t + ch + 18);
      }
    });
  }
}

function setupCanvas(id) {
  const canvas = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width - 40; // account for card padding
  const h = canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function renderCostChart() {
  const { ctx, w, h } = setupCanvas('costChart');
  const points = data.map(d => d.cost);
  drawLine(ctx, points, w, h, '#6366f1', 'rgba(99,102,241,0.1)');
}

function renderTokenChart() {
  const { ctx, w, h } = setupCanvas('tokenChart');
  const labels = data.map(d => d.date);
  drawStacked(ctx, [
    { name: 'Input', values: data.map(d => d.input) },
    { name: 'Output', values: data.map(d => d.output) },
    { name: 'Cache R', values: data.map(d => d.cacheRead) },
    { name: 'Cache W', values: data.map(d => d.cacheCreate) },
  ], labels, w, h, ['#3b82f6', '#22c55e', '#06b6d4', '#f59e0b']);
}

function renderAgentChart() {
  const { ctx, w, h } = setupCanvas('agentChart');
  const agentTotals = {};
  data.forEach(d => {
    for (const [id, a] of Object.entries(d.agents)) {
      agentTotals[id] = (agentTotals[id] || 0) + a.cost;
    }
  });
  const items = Object.entries(agentTotals)
    .sort(([,a],[,b]) => b - a)
    .slice(0, 10)
    .map(([id, cost]) => ({ label: id, value: cost, fmt: fmtCost(cost) }));
  drawBars(ctx, items, w, h, ['#6366f1','#3b82f6','#06b6d4','#22c55e','#f59e0b','#ef4444','#a855f7','#ec4899']);
}

function renderBreakdownChart() {
  const { ctx, w, h } = setupCanvas('breakdownChart');
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  data.forEach(d => { totals.input += d.input; totals.output += d.output; totals.cacheRead += d.cacheRead; totals.cacheCreate += d.cacheCreate; });
  const items = [
    { label: 'Input', value: totals.input, fmt: fmtTok(totals.input) },
    { label: 'Output', value: totals.output, fmt: fmtTok(totals.output) },
    { label: 'Cache Read', value: totals.cacheRead, fmt: fmtTok(totals.cacheRead) },
    { label: 'Cache Write', value: totals.cacheCreate, fmt: fmtTok(totals.cacheCreate) },
  ];
  drawBars(ctx, items, w, h, ['#3b82f6','#22c55e','#06b6d4','#f59e0b']);
}

function renderTable() {
  const tbody = document.querySelector('#table tbody');
  tbody.innerHTML = data.slice().reverse().map(d => {
    const top = Object.entries(d.agents).sort(([,a],[,b]) => b.cost - a.cost)[0];
    const topStr = top ? top[0] + ' (' + fmtCost(top[1].cost) + ')' : '-';
    return '<tr>' +
      '<td>' + d.date + '</td>' +
      '<td>' + d.tasks + '</td>' +
      '<td class="tok">' + fmtTok(d.input) + '</td>' +
      '<td class="tok">' + fmtTok(d.output) + '</td>' +
      '<td class="tok">' + fmtTok(d.cacheRead) + '</td>' +
      '<td class="tok">' + fmtTok(d.cacheCreate) + '</td>' +
      '<td class="cost">' + fmtCost(d.cost) + '</td>' +
      '<td>' + topStr + '</td>' +
      '</tr>';
  }).join('');
}

// Auto-load last 30 days
setRange(30);
`

export default startUsageDashboard
