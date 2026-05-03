import { renderShell, type TopbarPeer } from ".."

// --- /admin/cost — token-spend dashboard ---
//
// Replaces the standalone `agentx usage serve` command (port 4201) and
// the Cost tab inside Observability. Backed by the same
// /api/admin/observability/cost endpoint — no new server-side code.
// Operators get one place to look for spend/tier-2 trends; one less
// process and port to keep track of.

export interface CostPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderCostPage(opts: CostPageOpts = {}): string {
  const body = `<div class="ax-cost">
  <header class="ax-cost__head">
    <h1>Cost</h1>
    <p class="ax-cost__sub">Anthropic spend across all agents over the last 30 days. Rates: Opus $15/$75 per M, Sonnet $3/$15, Haiku $0.25/$1.25 (input/output).</p>
  </header>

  <section class="ax-cost__pane">
    <div class="ax-obs__kpis" id="cost-kpis"></div>
    <div class="ax-obs__card">
      <h3>30-day spend trend</h3>
      <div id="cost-trend" class="ax-obs__chart ax-obs__chart--cost"></div>
    </div>
    <div class="ax-obs__card">
      <h3>Per-agent cost (30 days)</h3>
      <table class="ax-obs__table">
        <thead><tr><th>Agent</th><th class="num">Tasks</th><th class="num">Spend</th><th class="num">Tier-2 surcharge</th></tr></thead>
        <tbody id="cost-agents"></tbody>
      </table>
      <p class="ax-obs__empty" id="cost-agents-empty" hidden>No usage in the last 30 days.</p>
    </div>
  </section>
</div>`

  const css = `
    .ax-cost{padding:24px 28px;max-width:1100px;margin:0 auto}
    .ax-cost__head h1{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:20px;letter-spacing:-0.01em;margin:0 0 6px}
    .ax-cost__sub{color:var(--ax-muted);font-size:12px;margin:0 0 18px}
    .ax-cost__pane{display:flex;flex-direction:column;gap:16px}
    .ax-obs__kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .ax-obs__kpi{background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:8px;padding:12px 14px}
    .ax-obs__kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ax-muted);font-weight:600;margin-bottom:6px}
    .ax-obs__kpi-value{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600}
    .ax-obs__kpi-sub{font-size:11px;color:var(--ax-muted);margin-top:4px}
    .ax-obs__delta{font-size:11px;color:var(--ax-muted)}
    .ax-obs__delta--up{color:var(--ax-success)}
    .ax-obs__delta--down{color:var(--ax-danger)}
    .ax-obs__card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:8px;padding:14px 16px}
    .ax-obs__card h3{font-family:'IBM Plex Sans',sans-serif;font-size:13px;font-weight:600;margin:0 0 10px;color:var(--ax-fg)}
    .ax-obs__table{width:100%;border-collapse:collapse;font-size:12px;font-family:'IBM Plex Mono',monospace}
    .ax-obs__table thead th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--ax-border);font-weight:500;color:var(--ax-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.04em}
    .ax-obs__table tbody td{padding:6px 8px;border-bottom:1px solid var(--ax-border)}
    .ax-obs__table .num{text-align:right;font-variant-numeric:tabular-nums}
    .ax-obs__table .small{font-size:11px;color:var(--ax-muted)}
    .ax-obs__empty{color:var(--ax-muted);font-size:12px;font-style:italic;margin:8px 0 0}
    .ax-obs__chart{display:flex;align-items:flex-end;gap:2px;height:120px;padding:8px 0}
    .ax-obs__chart--cost .bar{background:var(--ax-accent,#3a7bd5)}
    .ax-obs__chart .bar{flex:1;background:var(--ax-fg);opacity:0.4;min-width:4px;position:relative;border-radius:2px 2px 0 0}
    .ax-obs__chart .bar:hover{opacity:1}
    .ax-obs__chart .bar-label{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--ax-muted);white-space:nowrap}
  `

  const script = `
  (function(){
    function fmtNum(n){ return (n||0).toLocaleString(); }
    function fmtMoney(n){ if (n == null || isNaN(n)) return '$0'; if (n < 0.01) return '$' + n.toFixed(4); if (n < 1) return '$' + n.toFixed(3); if (n < 100) return '$' + n.toFixed(2); return '$' + Math.round(n).toLocaleString(); }
    function esc(s){ return String(s||'').replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
    function kpi(label, value, sub){
      return '<div class="ax-obs__kpi"><div class="ax-obs__kpi-label">' + esc(label) + '</div><div class="ax-obs__kpi-value">' + value + '</div>' + (sub ? '<div class="ax-obs__kpi-sub">' + sub + '</div>' : '') + '</div>';
    }
    function deltaMoney(n){
      if (Math.abs(n) < 0.001) return '<span class="ax-obs__delta">no change</span>';
      var arrow = n > 0 ? '\\u25B2' : '\\u25BC';
      var cls = n > 0 ? 'ax-obs__delta--down' : 'ax-obs__delta--up';
      return '<span class="ax-obs__delta ' + cls + '">' + arrow + ' ' + fmtMoney(Math.abs(n)) + ' vs yesterday</span>';
    }
    function bars(rows, xKey, valueKey){
      if (!rows || rows.length === 0) return '<div style="color:var(--ax-muted);font-size:11px;padding:20px 0">No data yet.</div>';
      var max = 0;
      rows.forEach(function(r){ if ((r[valueKey] || 0) > max) max = r[valueKey]; });
      if (max === 0) return '<div style="color:var(--ax-muted);font-size:11px;padding:20px 0">All zero.</div>';
      return rows.map(function(r){
        var h = Math.max(2, Math.round(((r[valueKey] || 0) / max) * 100));
        var label = fmtMoney(r[valueKey] || 0);
        var x = String(r[xKey] || '').slice(5);
        return '<div class="bar" style="height:' + h + '%" title="' + esc(x + ': ' + label) + '"></div>';
      }).join('');
    }

    async function load(){
      try {
        var r = await fetch('/api/admin/observability/cost', { credentials: 'same-origin' });
        var data = await r.json();
        render(data);
      } catch (e) {
        console.error('cost fetch failed', e);
      }
    }
    function render(data){
      if (!data) return;
      var k = data.kpis || {};
      document.getElementById('cost-kpis').innerHTML = [
        kpi('Today', fmtMoney(k.spendToday), deltaMoney(k.spendToday - (k.spendYesterday || 0))),
        kpi('Last 7 days', fmtMoney(k.spend7d), 'avg ' + fmtMoney(k.spend7d / 7) + '/day'),
        kpi('Last 30 days', fmtMoney(k.spend30d), 'avg ' + fmtMoney(k.spend30d / 30) + '/day'),
        kpi('Tier-2 surcharge today', fmtMoney(k.tier2Today), ((k.tier2PctToday || 0) * 100).toFixed(1) + '% of today\\u2019s spend'),
      ].join('');
      document.getElementById('cost-trend').innerHTML = bars(data.trend || [], 'day', 'spend');

      var rows = data.perAgent || [];
      var emptyEl = document.getElementById('cost-agents-empty');
      var bodyEl = document.getElementById('cost-agents');
      if (rows.length === 0) {
        emptyEl.hidden = false;
        bodyEl.innerHTML = '';
      } else {
        emptyEl.hidden = true;
        bodyEl.innerHTML = rows.map(function(r){
          return '<tr>'
            + '<td>' + esc(r.agent_id) + '</td>'
            + '<td class="num">' + fmtNum(r.tasks) + '</td>'
            + '<td class="num">' + fmtMoney(r.spend) + '</td>'
            + '<td class="num small" ' + (r.tier2 > 0 ? 'style="color:#bf8700"' : '') + '>' + fmtMoney(r.tier2) + '</td>'
            + '</tr>';
        }).join('');
      }
    }
    load();
    setInterval(load, 30000);
  })();
  `

  return renderShell({
    title: "AgentX · Cost",
    activeTab: "cost",
    subtitle: "Cost",
    body,
    css,
    scripts: `<script>${script}</script>`,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
  })
}
