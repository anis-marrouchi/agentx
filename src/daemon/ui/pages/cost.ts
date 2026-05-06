import { renderShell, type TopbarPeer } from ".."

// --- /admin/cost — token-spend dashboard ---
//
// Replaces the standalone `agentx usage serve` (port 4201) at full fidelity.
// Six KPIs with sparklines + WoW deltas, hero stacked-cost canvas, token mix
// card with cache-savings chip, top-agent leaderboard, cache efficiency
// gauge, daily detail table with filter chips, CSV export, and a range
// selector (7/14/30/90/all). Backed by /api/admin/observability/cost which
// now returns full per-day per-category breakdown + per-agent model+tokens.
// Theme follows the dashboard's CSS variables — no separate palette.

export interface CostPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderCostPage(opts: CostPageOpts = {}): string {
  const body = `<div class="ax-cost">
  <header class="ax-cost__head">
    <div>
      <h1>Cost</h1>
      <p class="ax-cost__sub"><span class="ax-cost__live"></span>Anthropic spend across all agents. Last ingest <span id="cost-last" class="ax-mono">—</span>.</p>
    </div>
    <div class="ax-cost__controls">
      <div class="ax-seg" id="cost-range" role="tablist">
        <button data-r="7">7d</button>
        <button data-r="14">14d</button>
        <button data-r="30" class="active">30d</button>
        <button data-r="90">90d</button>
        <button data-r="all">All</button>
      </div>
      <a class="ax-cost__export" id="cost-export" href="#">Export CSV</a>
    </div>
  </header>

  <section class="ax-cost__kpis" id="cost-kpis"></section>

  <section class="ax-cost__hero">
    <div class="ax-cost__card">
      <div class="ax-cost__card-head">
        <div>
          <div class="ax-cost__card-title">Cost over time</div>
          <div class="ax-cost__card-sub">Daily spend, stacked by token category</div>
        </div>
        <div class="ax-cost__legend">
          <span><i class="sw sw-input"></i>Input</span>
          <span><i class="sw sw-output"></i>Output</span>
          <span><i class="sw sw-cr"></i>Cache read</span>
          <span><i class="sw sw-cw"></i>Cache write</span>
        </div>
      </div>
      <div class="ax-cost__hero-wrap">
        <div class="ax-cost__hero-overlay">
          <div><div class="v ax-mono" id="cost-hero-total">$0</div><div class="l">Total · range</div></div>
          <div><div class="v ax-mono" id="cost-hero-peak">$0</div><div class="l">Peak day</div></div>
          <div><div class="v ax-mono" id="cost-hero-avg">$0</div><div class="l">Daily avg</div></div>
        </div>
        <canvas id="cost-hero" class="ax-cost__hero-canvas"></canvas>
      </div>
    </div>

    <div class="ax-cost__card ax-cost__mix">
      <div class="ax-cost__card-head">
        <div>
          <div class="ax-cost__card-title">Token mix</div>
          <div class="ax-cost__card-sub">Volume by category · range</div>
        </div>
      </div>
      <div id="cost-mix"></div>
      <div class="ax-cost__saved">
        <div class="l">Estimated savings from cache</div>
        <div class="v ax-mono" id="cost-saved">$0</div>
      </div>
    </div>
  </section>

  <section class="ax-cost__row2">
    <div class="ax-cost__card">
      <div class="ax-cost__card-head">
        <div>
          <div class="ax-cost__card-title">Top agents by spend</div>
          <div class="ax-cost__card-sub">Ranked across the selected range</div>
        </div>
      </div>
      <div class="ax-cost__agents" id="cost-agents"></div>
    </div>

    <div class="ax-cost__card">
      <div class="ax-cost__card-head">
        <div>
          <div class="ax-cost__card-title">Cache efficiency</div>
          <div class="ax-cost__card-sub">Hit rate and avoided input cost</div>
        </div>
        <span class="ax-cost__health" id="cost-health">—</span>
      </div>
      <div class="ax-cost__gauge">
        <div class="ax-cost__dial">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="58" stroke="var(--ax-surface-2)" stroke-width="12" fill="none"/>
            <circle id="cost-arc" cx="70" cy="70" r="58" stroke="var(--ax-accent)" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="364" stroke-dashoffset="364" transform="rotate(-90 70 70)"/>
          </svg>
          <div class="ax-cost__readout"><div class="num ax-mono" id="cost-hit">0%</div><div class="lbl">Hit rate</div></div>
        </div>
        <div class="ax-cost__cstats">
          <div><div class="lbl">Cache reads</div><div class="val ax-mono" id="cost-cr">0 <span>tok</span></div></div>
          <div><div class="lbl">Cache writes</div><div class="val ax-mono" id="cost-cw">0 <span>tok</span></div></div>
          <div><div class="lbl">Reuse multiplier</div><div class="val ax-mono" id="cost-mult">0×</div></div>
          <div><div class="lbl">Avoided input</div><div class="val ax-mono" id="cost-avoided">0</div></div>
        </div>
      </div>
    </div>
  </section>

  <section class="ax-cost__card ax-cost__table-card">
    <div class="ax-cost__table-head">
      <div>
        <div class="ax-cost__card-title">Daily detail</div>
        <div class="ax-cost__card-sub">Per-day breakdown with agent attribution</div>
      </div>
      <div class="ax-cost__chips" id="cost-filter">
        <button class="active" data-f="all">All days</button>
        <button data-f="weekdays">Weekdays</button>
        <button data-f="over10">&gt; $10</button>
      </div>
    </div>
    <div class="ax-cost__table-scroll">
      <table class="ax-cost__table">
        <thead>
          <tr>
            <th>Date</th><th class="num">Tasks</th><th>Mix</th>
            <th class="num">Input</th><th class="num">Output</th>
            <th class="num">Cache R</th><th class="num">Cache W</th>
            <th class="num">Cost</th><th>Top agents</th>
          </tr>
        </thead>
        <tbody id="cost-tbody"></tbody>
      </table>
    </div>
  </section>
</div>`

  const css = `
    .ax-cost{padding:24px 28px;max-width:1440px;margin:0 auto}
    .ax-cost__head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:20px}
    .ax-cost__head h1{font-family:var(--ax-font);font-weight:600;font-size:22px;letter-spacing:-0.015em;margin:0 0 6px}
    .ax-cost__sub{color:var(--ax-muted);font-size:12px;margin:0}
    .ax-cost__live{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ax-accent);margin-right:6px;vertical-align:middle;animation:ax-cost-pulse 2s ease-in-out infinite}
    @keyframes ax-cost-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
    .ax-cost__controls{display:flex;gap:8px;align-items:center}
    .ax-seg{display:inline-flex;padding:2px;background:var(--ax-surface);border:1px solid var(--ax-border);border-radius:8px}
    .ax-seg button{background:transparent;border:0;color:var(--ax-muted);padding:5px 10px;font-size:12px;font-weight:500;border-radius:6px;cursor:pointer;font-family:var(--ax-font);transition:color .12s,background .12s}
    .ax-seg button:hover{color:var(--ax-text)}
    .ax-seg button.active{background:var(--ax-surface-2);color:var(--ax-text)}
    .ax-cost__export{background:var(--ax-surface);color:var(--ax-text-2);border:1px solid var(--ax-border);padding:5px 12px;font-size:12px;font-weight:500;border-radius:8px;text-decoration:none}
    .ax-cost__export:hover{border-color:var(--ax-border-2);color:var(--ax-text);text-decoration:none}

    .ax-cost__card{background:var(--ax-surface);border:1px solid var(--ax-border);border-radius:var(--ax-radius-lg);display:flex;flex-direction:column;min-width:0}
    .ax-cost__card-head{padding:14px 18px 10px;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .ax-cost__card-title{font-size:13px;font-weight:600;letter-spacing:-0.005em}
    .ax-cost__card-sub{font-size:12px;color:var(--ax-muted);margin-top:2px}
    .ax-cost__legend{display:flex;gap:12px;flex-wrap:wrap}
    .ax-cost__legend span{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ax-text-2);font-weight:500}
    .ax-cost__legend .sw{width:8px;height:8px;border-radius:2px;display:inline-block}
    .sw-input{background:var(--ax-info)}
    .sw-output{background:var(--ax-accent)}
    .sw-cr{background:oklch(0.72 0.10 290)}
    .sw-cw{background:var(--ax-warn)}

    .ax-cost__kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:0;background:var(--ax-surface);border:1px solid var(--ax-border);border-radius:var(--ax-radius-lg);overflow:hidden;margin-bottom:16px}
    .ax-cost__kpi{padding:16px 18px;border-right:1px solid var(--ax-border);display:flex;flex-direction:column;gap:6px;min-width:0}
    .ax-cost__kpi:last-child{border-right:0}
    .ax-cost__kpi-label{font-size:10.5px;color:var(--ax-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600}
    .ax-cost__kpi-value{font-family:var(--ax-mono);font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.1;display:flex;align-items:baseline;gap:4px}
    .ax-cost__kpi-value .unit{font-size:12px;color:var(--ax-muted);font-weight:500;font-family:var(--ax-font)}
    .ax-cost__kpi--accent .ax-cost__kpi-value{color:var(--ax-accent)}
    .ax-cost__kpi-delta{font-size:11px;color:var(--ax-muted);font-weight:500}
    .ax-cost__kpi-delta--up{color:var(--ax-err)}
    .ax-cost__kpi-delta--down{color:var(--ax-accent)}
    .ax-cost__kpi-spark{height:22px;margin-top:auto;display:flex;align-items:flex-end;gap:1.5px}
    .ax-cost__kpi-spark .bar{flex:1;background:var(--ax-muted);border-radius:1px;min-height:2px;opacity:0.5}
    .ax-cost__kpi--accent .ax-cost__kpi-spark .bar{background:var(--ax-accent);opacity:0.6}
    .ax-cost__kpi-spark .bar:last-child{opacity:1;background:var(--ax-accent)}
    @media (max-width:1100px){.ax-cost__kpis{grid-template-columns:repeat(3,1fr)}.ax-cost__kpi{border-bottom:1px solid var(--ax-border)}.ax-cost__kpi:nth-child(3),.ax-cost__kpi:nth-last-child(-n+3){border-right:0}.ax-cost__kpi:nth-last-child(-n+3){border-bottom:0}}
    @media (max-width:680px){.ax-cost__kpis{grid-template-columns:repeat(2,1fr)}.ax-cost__kpi{border-right:1px solid var(--ax-border);border-bottom:1px solid var(--ax-border)}.ax-cost__kpi:nth-child(2n){border-right:0}}

    .ax-cost__hero{display:grid;grid-template-columns:1fr 320px;gap:16px;margin-bottom:16px}
    @media (max-width:1200px){.ax-cost__hero{grid-template-columns:1fr}}
    .ax-cost__hero-wrap{position:relative;padding:4px 18px 16px}
    .ax-cost__hero-canvas{width:100%;height:300px;display:block}
    .ax-cost__hero-overlay{position:absolute;top:8px;left:18px;display:flex;gap:22px;pointer-events:none}
    .ax-cost__hero-overlay .v{font-size:20px;font-weight:600;letter-spacing:-0.02em}
    .ax-cost__hero-overlay .l{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted);font-weight:600;margin-top:2px}

    .ax-cost__mix{padding:14px 18px 16px}
    .ax-cost__mix-row{display:grid;grid-template-columns:84px 1fr 92px;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed var(--ax-border)}
    .ax-cost__mix-row:last-of-type{border-bottom:0}
    .ax-cost__mix-label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ax-text-2);font-weight:500}
    .ax-cost__mix-dot{width:8px;height:8px;border-radius:2px}
    .ax-cost__mix-bar{position:relative;height:6px;background:var(--ax-surface-2);border-radius:3px;overflow:hidden}
    .ax-cost__mix-bar-fill{height:100%;border-radius:3px;transition:width .6s cubic-bezier(0.22,1,0.36,1)}
    .ax-cost__mix-val{font-family:var(--ax-mono);font-size:11px;color:var(--ax-text-2);text-align:right;font-weight:500}
    .ax-cost__saved{margin-top:14px;padding:10px 12px;background:color-mix(in oklch,var(--ax-accent) 14%,transparent);border:1px solid color-mix(in oklch,var(--ax-accent) 35%,transparent);border-radius:8px;display:flex;align-items:center;justify-content:space-between}
    .ax-cost__saved .l{font-size:11px;color:var(--ax-text-2)}
    .ax-cost__saved .v{font-size:14px;font-weight:600;color:var(--ax-accent)}

    .ax-cost__row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
    @media (max-width:1100px){.ax-cost__row2{grid-template-columns:1fr}}

    .ax-cost__agents{display:flex;flex-direction:column}
    .ax-cost__agent{display:grid;grid-template-columns:22px 1fr 60px 90px 90px;align-items:center;gap:12px;padding:10px 18px;border-top:1px solid var(--ax-border)}
    .ax-cost__agent:hover{background:var(--ax-bg-elev)}
    .ax-cost__agent-rank{font-family:var(--ax-mono);font-size:11px;color:var(--ax-muted);font-weight:500}
    .ax-cost__agent-namewrap{display:flex;align-items:center;gap:10px;min-width:0}
    .ax-cost__agent-ico{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0}
    .ax-cost__agent-name{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ax-cost__agent-model{font-size:10.5px;color:var(--ax-muted);margin-top:1px}
    .ax-cost__agent-tasks{font-family:var(--ax-mono);font-size:11.5px;color:var(--ax-text-2);text-align:right}
    .ax-cost__agent-bar{position:relative;height:5px;background:var(--ax-surface-2);border-radius:2px;overflow:hidden}
    .ax-cost__agent-bar-fill{height:100%;border-radius:2px;transition:width .7s cubic-bezier(0.22,1,0.36,1)}
    .ax-cost__agent-cost{font-family:var(--ax-mono);font-size:12.5px;font-weight:600;text-align:right;color:var(--ax-text)}
    .ax-cost__agent-cost .sub{display:block;font-size:10px;color:var(--ax-muted);font-weight:400;margin-top:1px}
    .ax-cost__health{display:inline-flex;align-items:center;gap:6px;padding:3px 8px 3px 6px;border:1px solid var(--ax-border);border-radius:999px;font-size:11px;color:var(--ax-accent);font-weight:600;background:var(--ax-surface)}

    .ax-cost__gauge{display:grid;grid-template-columns:140px 1fr;gap:24px;align-items:center;padding:14px 18px 18px}
    .ax-cost__dial{position:relative;width:140px;height:140px}
    .ax-cost__readout{position:absolute;inset:0;display:grid;place-items:center;text-align:center}
    .ax-cost__readout .num{font-size:24px;font-weight:600;letter-spacing:-0.02em}
    .ax-cost__readout .lbl{font-size:10px;color:var(--ax-muted);letter-spacing:0.06em;text-transform:uppercase;margin-top:2px}
    .ax-cost__cstats{display:flex;flex-direction:column;gap:10px}
    .ax-cost__cstats > div{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px dashed var(--ax-border);padding-bottom:8px}
    .ax-cost__cstats > div:last-child{border-bottom:0}
    .ax-cost__cstats .lbl{font-size:11px;color:var(--ax-muted);text-transform:uppercase;letter-spacing:0.05em}
    .ax-cost__cstats .val{font-size:14px;font-weight:600}
    .ax-cost__cstats .val span{font-size:10px;color:var(--ax-muted);margin-left:4px;font-weight:400}

    .ax-cost__table-card{padding-bottom:8px}
    .ax-cost__table-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;flex-wrap:wrap;gap:8px}
    .ax-cost__chips{display:flex;gap:6px}
    .ax-cost__chips button{background:transparent;border:1px solid var(--ax-border);color:var(--ax-muted);font-size:11px;padding:3px 10px;border-radius:999px;cursor:pointer;font-family:var(--ax-font);transition:color .12s,background .12s,border-color .12s}
    .ax-cost__chips button:hover,.ax-cost__chips button.active{color:var(--ax-text);background:var(--ax-surface-2);border-color:var(--ax-border-2)}
    .ax-cost__table-scroll{overflow-x:auto}
    .ax-cost__table{width:100%;border-collapse:collapse;font-size:12.5px}
    .ax-cost__table thead th{text-align:left;padding:8px 18px;background:var(--ax-bg-elev);border-top:1px solid var(--ax-border);border-bottom:1px solid var(--ax-border);font-size:10.5px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted);font-weight:500;white-space:nowrap}
    .ax-cost__table thead th.num,.ax-cost__table tbody td.num{text-align:right;font-family:var(--ax-mono)}
    .ax-cost__table tbody td{padding:10px 18px;border-bottom:1px solid var(--ax-border);color:var(--ax-text-2);vertical-align:middle;white-space:nowrap}
    .ax-cost__table tbody tr:hover td{background:var(--ax-bg-elev);color:var(--ax-text)}
    .ax-cost__table tbody tr:last-child td{border-bottom:0}
    .ax-cost__table .row-date{color:var(--ax-text);font-weight:500}
    .ax-cost__table .row-date .day{color:var(--ax-muted);font-weight:400;margin-left:6px;font-size:11px}
    .ax-cost__table .row-cost{color:var(--ax-accent);font-weight:600}
    .ax-cost__minibar{display:inline-flex;gap:1px;height:12px;width:80px;align-items:flex-end}
    .ax-cost__minibar span{flex:1;border-radius:1px;min-height:1px;display:block;height:100%}
    .ax-cost__chips-row{display:inline-flex;gap:4px;flex-wrap:wrap}
    .ax-cost__agent-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 7px 2px 5px;background:var(--ax-surface-2);border:1px solid var(--ax-border);border-radius:999px;font-size:10.5px;color:var(--ax-text-2)}
    .ax-cost__agent-chip i{width:6px;height:6px;border-radius:50%;display:inline-block}
    .ax-cost__empty{padding:32px 18px;text-align:center;color:var(--ax-muted);font-size:12px;font-style:italic}
  `

  const script = `
  (function(){
    var state = { data: null, range: 30, filter: 'all' };

    function fmtTok(n){ if(!n)return '0'; if(n>=1e9)return (n/1e9).toFixed(2)+'B'; if(n>=1e6)return (n/1e6).toFixed(2)+'M'; if(n>=1e3)return (n/1e3).toFixed(1)+'K'; return String(Math.round(n)); }
    function fmtCost(n,d){ if(d==null)d=2; if(!isFinite(n))n=0; if(Math.abs(n)>=10000)return '$'+(n/1000).toFixed(1)+'K'; if(n===0)return '$0'; if(Math.abs(n)<0.01)return '$'+n.toFixed(4); return '$'+n.toFixed(d); }
    function fmtDate(iso){ var dt=new Date(iso+'T00:00:00'); return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
    function fmtDay(iso){ var dt=new Date(iso+'T00:00:00'); return dt.toLocaleDateString(undefined,{weekday:'short'}); }
    function isWeekday(iso){ var dt=new Date(iso+'T00:00:00'); var d=dt.getDay(); return d!==0 && d!==6; }
    function esc(s){ return String(s||'').replace(/[&<>"']/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
    function getCss(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

    var COL_INPUT  = function(){ return getCss('--ax-info') || '#7aa6e0'; };
    var COL_OUTPUT = function(){ return getCss('--ax-accent') || '#6ec4a7'; };
    var COL_CR     = function(){ return 'oklch(0.72 0.10 290)'; };
    var COL_CW     = function(){ return getCss('--ax-warn') || '#d4a437'; };

    /* deterministic per-agent color — hashed hue, OKLCH-stable across themes. */
    var agentColorCache = {};
    function agentColor(id){
      if (agentColorCache[id]) return agentColorCache[id];
      var h = 0;
      for (var i=0;i<id.length;i++) h = ((h<<5)-h+id.charCodeAt(i))|0;
      var hue = Math.abs(h) % 360;
      var c = 'oklch(0.74 0.13 ' + hue + ')';
      agentColorCache[id] = c;
      return c;
    }

    /* Range selector */
    document.querySelectorAll('#cost-range button').forEach(function(b){
      b.addEventListener('click', function(){
        document.querySelectorAll('#cost-range button').forEach(function(x){ x.classList.remove('active'); });
        b.classList.add('active');
        var r = b.getAttribute('data-r');
        state.range = r;
        load();
      });
    });
    /* Filter chips */
    document.querySelectorAll('#cost-filter button').forEach(function(c){
      c.addEventListener('click', function(){
        document.querySelectorAll('#cost-filter button').forEach(function(x){ x.classList.remove('active'); });
        c.classList.add('active');
        state.filter = c.getAttribute('data-f');
        renderTable();
      });
    });
    /* Export CSV */
    document.getElementById('cost-export').addEventListener('click', function(e){
      e.preventDefault();
      window.location.href = '/api/admin/observability/cost.csv?range=' + encodeURIComponent(state.range);
    });

    async function load(){
      try {
        var r = await fetch('/api/admin/observability/cost?range=' + encodeURIComponent(state.range), { credentials: 'same-origin' });
        state.data = await r.json();
        render();
      } catch (e) { console.error('cost fetch failed', e); }
    }

    function render(){
      if (!state.data) return;
      renderKPIs();
      renderHero();
      renderMix();
      renderAgents();
      renderCacheGauge();
      renderTable();
      var li = document.getElementById('cost-last');
      var days = state.data.days || [];
      li.textContent = days.length ? days[days.length-1].date : '—';
    }

    function kpi(opts){
      var sparks = opts.sparks || [];
      var max = 0; for (var i=0;i<sparks.length;i++){ if (sparks[i] > max) max = sparks[i]; }
      var bars = sparks.map(function(v){ var h = max>0 ? Math.max(2,(v/max)*100) : 2; return '<div class="bar" style="height:'+h+'%"></div>'; }).join('');
      var deltaHtml = '';
      if (opts.delta != null && isFinite(opts.delta) && opts.delta !== 0) {
        var up = opts.delta > 0;
        var cls = up ? 'ax-cost__kpi-delta--up' : 'ax-cost__kpi-delta--down';
        var arrow = up ? '\\u25B2' : '\\u25BC';
        deltaHtml = '<div class="ax-cost__kpi-delta '+cls+'">'+arrow+' '+(Math.abs(opts.delta)*100).toFixed(1)+'% vs prev 7d</div>';
      } else if (opts.sub) {
        deltaHtml = '<div class="ax-cost__kpi-delta">'+esc(opts.sub)+'</div>';
      }
      var unit = opts.unit ? '<span class="unit">'+esc(opts.unit)+'</span>' : '';
      return '<div class="ax-cost__kpi '+(opts.accent?'ax-cost__kpi--accent':'')+'">'
        + '<div class="ax-cost__kpi-label">'+esc(opts.label)+'</div>'
        + '<div class="ax-cost__kpi-value">'+opts.value+unit+'</div>'
        + deltaHtml
        + '<div class="ax-cost__kpi-spark">'+bars+'</div>'
        + '</div>';
    }

    function renderKPIs(){
      var d = state.data; var days = d.days || []; var k = d.kpis || {};
      var sparkCost   = days.map(function(x){ return x.cost; });
      var sparkTasks  = days.map(function(x){ return x.tasks; });
      var sparkTok    = days.map(function(x){ return x.input + x.output + x.cacheRead + x.cacheCreate; });
      var sparkHit    = days.map(function(x){ var d2 = x.cacheRead + x.input; return d2>0 ? (x.cacheRead/d2)*100 : 0; });
      var sparkPerTask= days.map(function(x){ return x.tasks>0 ? x.cost/x.tasks : 0; });
      document.getElementById('cost-kpis').innerHTML = [
        kpi({ label:'Total spend',     value: fmtCost(k.spendRange||0),       sparks: sparkCost,   delta: k.spendDeltaWoW, accent: true }),
        kpi({ label:'Daily average',   value: fmtCost(k.avgDailyRange||0),    sparks: sparkCost,   sub: '/ day' }),
        kpi({ label:'Tasks run',       value: (k.tasksRange||0).toLocaleString(), sparks: sparkTasks,  delta: k.tasksDeltaWoW }),
        kpi({ label:'Tokens processed',value: fmtTok(k.tokensRange||0),       sparks: sparkTok,    sub: 'tok' }),
        kpi({ label:'Cache hit rate',  value: ((k.cacheHitRange||0)*100).toFixed(0)+'%', sparks: sparkHit }),
        kpi({ label:'Cost / task',     value: fmtCost(k.costPerTaskRange||0,3), sparks: sparkPerTask }),
      ].join('');
    }

    /* Hero stacked-bar chart on canvas. Each bar's segment heights are
       derived from cost shares per category (cost × tokens_in_cat / total_tokens). */
    function setupCanvas(id){
      var canvas = document.getElementById(id);
      var dpr = window.devicePixelRatio || 1;
      var rect = canvas.parentElement.getBoundingClientRect();
      var w = rect.width;
      var h = canvas.clientHeight || 300;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      return { ctx: ctx, w: w, h: h };
    }
    function roundRect(ctx, x, y, w, h, r){
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
    function renderHero(){
      var c = setupCanvas('cost-hero'); var ctx = c.ctx, w = c.w, h = c.h;
      var data = state.data.days || [];
      var totalEl = document.getElementById('cost-hero-total');
      var peakEl = document.getElementById('cost-hero-peak');
      var avgEl = document.getElementById('cost-hero-avg');
      if (!data.length){
        ctx.fillStyle = getCss('--ax-muted'); ctx.font = '12px '+getCss('--ax-font'); ctx.textAlign = 'center';
        ctx.fillText('No usage data in this range', w/2, h/2);
        totalEl.textContent = '$0'; peakEl.textContent = '$0'; avgEl.textContent = '$0';
        return;
      }
      var pad = { t: 70, r: 16, b: 28, l: 48 };
      var cw = w - pad.l - pad.r;
      var ch = h - pad.t - pad.b;

      var series = data.map(function(d){
        var tot = d.input + d.output + d.cacheRead + d.cacheCreate;
        if (!tot) return { input:0, output:0, cacheR:0, cacheW:0, total: d.cost };
        return {
          input: d.cost * (d.input / tot),
          output: d.cost * (d.output / tot),
          cacheR: d.cost * (d.cacheRead / tot),
          cacheW: d.cost * (d.cacheCreate / tot),
          total: d.cost,
        };
      });
      var maxTot = Math.max.apply(null, series.map(function(s){return s.total;}).concat([0.001]));

      ctx.font = '10.5px '+getCss('--ax-mono');
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var i = 0; i <= 4; i++){
        var v = (maxTot / 4) * i;
        var y = pad.t + ch - (i / 4) * ch;
        ctx.strokeStyle = getCss('--ax-border');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, y + 0.5); ctx.lineTo(pad.l + cw, y + 0.5); ctx.stroke();
        ctx.fillStyle = getCss('--ax-muted');
        ctx.fillText(fmtCost(v, 0), pad.l - 8, y);
      }
      ctx.fillStyle = getCss('--ax-muted');
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = '10.5px '+getCss('--ax-font');
      var nLabels = Math.min(7, data.length);
      for (var j = 0; j < nLabels; j++){
        var idx = Math.round((j / Math.max(1, nLabels - 1)) * (data.length - 1));
        var x = pad.l + (idx / Math.max(1, data.length - 1)) * cw;
        ctx.fillText(fmtDate(data[idx].date), x, pad.t + ch + 10);
      }
      var cats = [
        { k:'input',  c: COL_INPUT() },
        { k:'output', c: COL_OUTPUT() },
        { k:'cacheR', c: COL_CR() },
        { k:'cacheW', c: COL_CW() },
      ];
      var barW = Math.max(2, (cw / data.length) * 0.7);
      var gap  = cw / data.length;
      data.forEach(function(d, i){
        var s = series[i];
        var x = pad.l + i * gap + (gap - barW) / 2;
        var yOff = 0;
        cats.forEach(function(cat, ci){
          var v = s[cat.k];
          var barH = (v / maxTot) * ch;
          var y = pad.t + ch - yOff - barH;
          ctx.fillStyle = cat.c;
          var radius = ci === cats.length - 1 ? 2 : 0;
          roundRect(ctx, x, y, barW, barH + 0.5, radius);
          ctx.fill();
          yOff += barH;
        });
      });

      var total = series.reduce(function(s, p){ return s + p.total; }, 0);
      var peak = Math.max.apply(null, series.map(function(p){ return p.total; }));
      var avg = total / Math.max(1, series.length);
      totalEl.textContent = fmtCost(total);
      peakEl.textContent = fmtCost(peak);
      avgEl.textContent = fmtCost(avg);
    }

    function renderMix(){
      var data = state.data.days || [];
      var tot = { input:0, output:0, cacheRead:0, cacheCreate:0 };
      data.forEach(function(d){ tot.input+=d.input; tot.output+=d.output; tot.cacheRead+=d.cacheRead; tot.cacheCreate+=d.cacheCreate; });
      var grand = tot.input + tot.output + tot.cacheRead + tot.cacheCreate;
      var items = [
        { lbl:'Input', v: tot.input, c: COL_INPUT() },
        { lbl:'Output', v: tot.output, c: COL_OUTPUT() },
        { lbl:'Cache read', v: tot.cacheRead, c: COL_CR() },
        { lbl:'Cache write', v: tot.cacheCreate, c: COL_CW() },
      ];
      var max = Math.max.apply(null, items.map(function(i){ return i.v; }).concat([1]));
      document.getElementById('cost-mix').innerHTML = items.map(function(it){
        var pct = grand > 0 ? (it.v / grand * 100) : 0;
        var barPct = (it.v / max) * 100;
        return '<div class="ax-cost__mix-row">'
          + '<div class="ax-cost__mix-label"><span class="ax-cost__mix-dot" style="background:'+it.c+'"></span>'+esc(it.lbl)+'</div>'
          + '<div class="ax-cost__mix-bar"><div class="ax-cost__mix-bar-fill" style="width:'+barPct+'%;background:'+it.c+'"></div></div>'
          + '<div class="ax-cost__mix-val">'+fmtTok(it.v)+' · '+pct.toFixed(0)+'%</div>'
          + '</div>';
      }).join('');
      // Rough cache savings: cache-read tokens priced at ~10% of input rate (sonnet).
      var savedCost = (tot.cacheRead * 0.9) / 1e6 * 3;
      document.getElementById('cost-saved').textContent = fmtCost(savedCost);
    }

    function renderAgents(){
      var rows = (state.data.perAgent || []).slice(0, 12);
      var max = rows[0] ? rows[0].cost : 1;
      var container = document.getElementById('cost-agents');
      if (!rows.length){ container.innerHTML = '<div class="ax-cost__empty">No agent activity in this range.</div>'; return; }
      container.innerHTML = rows.map(function(a, i){
        var c = agentColor(a.agent_id);
        var initials = a.agent_id.split('-').map(function(s){ return s[0]||''; }).join('').slice(0,2).toUpperCase();
        var iconBg = 'color-mix(in oklch, ' + c + ' 22%, var(--ax-surface-2))';
        var barPct = (a.cost / max) * 100;
        return '<div class="ax-cost__agent">'
          + '<div class="ax-cost__agent-rank">'+String(i+1).padStart(2,'0')+'</div>'
          + '<div class="ax-cost__agent-namewrap">'
            + '<div class="ax-cost__agent-ico" style="background:'+iconBg+';color:'+c+'">'+esc(initials)+'</div>'
            + '<div style="min-width:0">'
              + '<div class="ax-cost__agent-name">'+esc(a.agent_id)+'</div>'
              + (a.model ? '<div class="ax-cost__agent-model">'+esc(a.model)+'</div>' : '')
            + '</div>'
          + '</div>'
          + '<div class="ax-cost__agent-tasks">'+(a.tasks||0).toLocaleString()+'</div>'
          + '<div class="ax-cost__agent-bar"><div class="ax-cost__agent-bar-fill" style="width:'+barPct+'%;background:'+c+'"></div></div>'
          + '<div class="ax-cost__agent-cost">'+fmtCost(a.cost)+'<span class="sub">'+fmtTok(a.tokens||0)+' tok</span></div>'
        + '</div>';
      }).join('');
    }

    function renderCacheGauge(){
      var data = state.data.days || [];
      var tot = data.reduce(function(s,d){ return { r: s.r + d.cacheRead, w: s.w + d.cacheCreate, i: s.i + d.input }; }, { r:0, w:0, i:0 });
      var hit = (tot.r + tot.i) > 0 ? (tot.r / (tot.r + tot.i)) * 100 : 0;
      var circ = 2 * Math.PI * 58;
      var offset = circ - (hit / 100) * circ;
      var arc = document.getElementById('cost-arc');
      arc.style.strokeDasharray = circ.toFixed(1);
      arc.style.strokeDashoffset = circ.toFixed(1);
      requestAnimationFrame(function(){
        arc.style.transition = 'stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)';
        arc.style.strokeDashoffset = offset.toFixed(1);
      });
      document.getElementById('cost-hit').textContent = hit.toFixed(0) + '%';
      document.getElementById('cost-cr').innerHTML = fmtTok(tot.r) + ' <span>tok</span>';
      document.getElementById('cost-cw').innerHTML = fmtTok(tot.w) + ' <span>tok</span>';
      var mult = tot.w > 0 ? (tot.r / tot.w) : 0;
      document.getElementById('cost-mult').textContent = mult.toFixed(1) + '\\u00D7';
      document.getElementById('cost-avoided').textContent = fmtTok(tot.r);
      var label = hit >= 60 ? 'Healthy' : hit >= 30 ? 'Warming up' : 'Cold';
      document.getElementById('cost-health').textContent = label;
    }

    function renderTable(){
      var tbody = document.getElementById('cost-tbody');
      var data = state.data ? state.data.days || [] : [];
      var rows = data.slice().reverse();
      if (state.filter === 'weekdays') rows = rows.filter(function(r){ return isWeekday(r.date); });
      else if (state.filter === 'over10') rows = rows.filter(function(r){ return r.cost > 10; });
      if (!rows.length){ tbody.innerHTML = '<tr><td colspan="9" class="ax-cost__empty">No rows match this filter.</td></tr>'; return; }
      tbody.innerHTML = rows.map(function(d){
        var tot = d.input + d.output + d.cacheRead + d.cacheCreate || 1;
        var mix = [
          { v: d.input, c: COL_INPUT() },
          { v: d.output, c: COL_OUTPUT() },
          { v: d.cacheRead, c: COL_CR() },
          { v: d.cacheCreate, c: COL_CW() },
        ];
        var mixHtml = mix.map(function(m){ return '<span style="flex:'+(m.v/tot)+';background:'+m.c+'"></span>'; }).join('');
        var topAgents = Object.keys(d.agents || {}).map(function(id){ return [id, d.agents[id]]; }).sort(function(a,b){ return b[1].cost - a[1].cost; }).slice(0, 3);
        var chips = topAgents.map(function(pair){
          return '<span class="ax-cost__agent-chip"><i style="background:'+agentColor(pair[0])+'"></i>'+esc(pair[0])+'</span>';
        }).join('');
        return '<tr>'
          + '<td class="row-date">'+fmtDate(d.date)+'<span class="day">'+fmtDay(d.date)+'</span></td>'
          + '<td class="num">'+(d.tasks||0).toLocaleString()+'</td>'
          + '<td><div class="ax-cost__minibar">'+mixHtml+'</div></td>'
          + '<td class="num">'+fmtTok(d.input)+'</td>'
          + '<td class="num">'+fmtTok(d.output)+'</td>'
          + '<td class="num">'+fmtTok(d.cacheRead)+'</td>'
          + '<td class="num">'+fmtTok(d.cacheCreate)+'</td>'
          + '<td class="num row-cost">'+fmtCost(d.cost)+'</td>'
          + '<td><div class="ax-cost__chips-row">'+chips+'</div></td>'
        + '</tr>';
      }).join('');
    }

    window.addEventListener('resize', function(){ if (state.data) renderHero(); });
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
