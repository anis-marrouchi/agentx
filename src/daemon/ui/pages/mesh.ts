import { renderShell, type TopbarPeer } from "../index";

export function renderMeshPage(opts: { peers?: TopbarPeer[] }): string {
  return renderShell({
    title: "AgentX · Mesh Operations",
    activeTab: "mesh",
    subtitle: "Operations",
    peers: opts.peers,
    body: `<div class="mx-page">
  <header class="mx-head">
    <div>
      <p class="mx-kicker">Mesh control plane</p>
      <h1>Operational posture</h1>
      <p id="mx-updated" class="mx-muted" aria-live="polite">Connecting to the fleet...</p>
    </div>
    <div class="mx-health" id="mx-health"></div>
  </header>

  <section aria-labelledby="mx-auto-title">
    <div class="mx-section-head">
      <div><p class="mx-kicker">Today</p><h2 id="mx-auto-title">Automations</h2></div>
      <div class="mx-legend"><span><i class="ok"></i>Passed</span><span><i class="bad"></i>Failed</span><span><i class="wait"></i>Waiting</span></div>
    </div>
    <div class="mx-runs" id="mx-runs"><div class="mx-empty">Loading schedules...</div></div>
  </section>

  <div class="mx-grid">
    <section aria-labelledby="mx-active-title">
      <div class="mx-section-head"><div><p class="mx-kicker">Now</p><h2 id="mx-active-title">Activity provenance</h2></div><span class="mx-count" id="mx-active-count">0 active</span></div>
      <div class="mx-list" id="mx-active"><div class="mx-empty">No activity loaded.</div></div>
    </section>
    <section aria-labelledby="mx-nodes-title">
      <div class="mx-section-head"><div><p class="mx-kicker">Fleet</p><h2 id="mx-nodes-title">Nodes</h2></div><span class="mx-count" id="mx-node-count">0 nodes</span></div>
      <div class="mx-list" id="mx-nodes"><div class="mx-empty">No nodes loaded.</div></div>
    </section>
  </div>

  <section aria-labelledby="mx-agents-title">
    <div class="mx-section-head"><div><p class="mx-kicker">Inventory</p><h2 id="mx-agents-title">Agents and skills</h2></div><span class="mx-count" id="mx-agent-count">0 agents</span></div>
    <div class="mx-agent-grid" id="mx-agents"><div class="mx-empty">No agents loaded.</div></div>
  </section>
</div>
<div class="mx-scrim" id="mx-scrim" hidden></div>
<aside class="mx-drawer" id="mx-drawer" aria-labelledby="mx-drawer-title" aria-hidden="true">
  <button class="mx-close" id="mx-close" type="button" aria-label="Close details">Close</button>
  <p class="mx-kicker" id="mx-drawer-kicker">Details</p>
  <h2 id="mx-drawer-title">Selection</h2>
  <div id="mx-drawer-body"></div>
</aside>`,
    css: MESH_CSS,
    scripts: MESH_SCRIPT,
  });
}

const MESH_CSS = `
body{margin:0;background:var(--ax-bg);color:var(--ax-text);font-family:var(--ax-font)}
main{max-width:1500px;margin:0 auto;padding:28px 28px 64px}
.mx-page{display:grid;gap:34px}.mx-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}
.mx-kicker{margin:0 0 6px;color:var(--ax-accent);font:600 10px/1 var(--ax-mono);letter-spacing:.14em;text-transform:uppercase}
h1,h2{margin:0;letter-spacing:-.03em}h1{font-size:clamp(30px,4vw,54px);line-height:.95}h2{font-size:22px}
.mx-muted{margin:10px 0 0;color:var(--ax-muted);font-size:12px}.mx-health{display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:8px}
.mx-stat{min-width:90px;padding:12px 14px;background:var(--ax-surface);border:2px solid var(--ax-border-2);border-radius:var(--ax-radius-sm);box-shadow:var(--ax-shadow);text-align:right}
.mx-stat strong{display:block;font:700 24px/1 var(--ax-mono)}.mx-stat span{color:var(--ax-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
.mx-section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:12px}.mx-count{color:var(--ax-muted);font:11px var(--ax-mono)}
.mx-legend{display:flex;gap:12px;color:var(--ax-muted);font:10px var(--ax-mono)}.mx-legend span{display:flex;align-items:center;gap:5px}.mx-legend i{width:7px;height:7px;border-radius:50%}
.ok{background:var(--ax-ok)}.bad{background:var(--ax-err)}.wait{background:var(--ax-muted)}
.mx-runs{display:flex;gap:9px;overflow-x:auto;padding:0 0 7px;scroll-snap-type:x proximity}
.mx-run{position:relative;flex:0 0 210px;scroll-snap-align:start;text-align:left;min-height:118px;padding:14px;background:var(--ax-surface);border:2px solid var(--ax-border-2);border-radius:var(--ax-radius-sm);box-shadow:var(--ax-shadow);color:inherit;font:inherit;cursor:pointer;overflow:hidden}
.mx-run:hover,.mx-run:focus-visible{border-color:var(--ax-accent);transform:translateY(-1px)}.mx-run__top{display:flex;justify-content:space-between;gap:8px}.mx-run__node{font:10px var(--ax-mono);color:var(--ax-muted)}
.mx-status{width:9px;height:9px;border-radius:50%;margin-top:2px;flex:none}.mx-run h3{margin:18px 0 4px;font-size:15px}.mx-run p{margin:0;color:var(--ax-muted);font:10px/1.4 var(--ax-mono)}
.mx-peek{position:absolute;inset:auto 0 0;padding:10px 14px;background:var(--ax-text);color:var(--ax-bg);font-size:11px;line-height:1.35;transform:translateY(101%);transition:transform .16s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-run:hover .mx-peek,.mx-run:focus-visible .mx-peek{transform:translateY(0)}
.mx-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr);gap:28px}.mx-list{display:grid;gap:8px}
.mx-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 14px;background:var(--ax-surface);border:1px solid var(--ax-border);border-radius:var(--ax-radius-sm);color:inherit;text-decoration:none}
button.mx-row{width:100%;font:inherit;text-align:left;cursor:pointer}.mx-row:hover,.mx-row:focus-visible{border-color:var(--ax-border-2);background:var(--ax-surface-2)}
.mx-dot{width:8px;height:8px;border-radius:50%;background:var(--ax-ok);box-shadow:0 0 0 3px color-mix(in oklch,var(--ax-ok) 15%,transparent)}.mx-dot.off{background:var(--ax-err);box-shadow:none}.mx-dot.busy{background:var(--ax-accent)}
.mx-row strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mx-row small{display:block;margin-top:3px;color:var(--ax-muted);font:10px var(--ax-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mx-row time{color:var(--ax-muted);font:10px var(--ax-mono)}
.mx-agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:8px}.mx-agent{padding:13px 14px;background:var(--ax-surface);border:1px solid var(--ax-border);border-radius:var(--ax-radius-sm);color:inherit;text-decoration:none}
.mx-agent{font:inherit;text-align:left;cursor:pointer}.mx-agent:hover,.mx-agent:focus-visible{border-color:var(--ax-accent)}.mx-agent__top{display:flex;justify-content:space-between;gap:8px}.mx-agent strong{font-size:13px}.mx-agent code{color:var(--ax-muted);font-size:9px}.mx-agent p{margin:8px 0 0;color:var(--ax-muted);font:10px/1.4 var(--ax-mono)}
.mx-link{display:inline-block;margin-top:4px;color:var(--ax-accent);font-weight:600;text-decoration:none}.mx-link:hover{text-decoration:underline}
.mx-empty{padding:24px;border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-sm);color:var(--ax-muted);font-size:12px;text-align:center;grid-column:1/-1}
.mx-scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:29}.mx-drawer{position:fixed;z-index:30;top:0;right:0;width:min(440px,calc(100vw - 24px));height:100vh;box-sizing:border-box;padding:76px 28px 28px;background:var(--ax-surface);border-left:2px solid var(--ax-border-2);transform:translateX(102%);transition:transform .2s ease;overflow:auto;box-shadow:-12px 0 40px rgba(0,0,0,.18)}
.mx-drawer.is-open{transform:translateX(0)}.mx-close{position:absolute;right:20px;top:20px;padding:7px 11px;border:1px solid var(--ax-border-2);border-radius:8px;background:transparent;color:var(--ax-text);font:11px var(--ax-mono);cursor:pointer}
.mx-detail{margin-top:22px;display:grid;gap:16px}.mx-detail dl{display:grid;grid-template-columns:100px 1fr;gap:8px;margin:0;font-size:12px}.mx-detail dt{color:var(--ax-muted)}.mx-detail dd{margin:0;word-break:break-word}.mx-detail pre{margin:0;padding:14px;background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:10px;white-space:pre-wrap;font:11px/1.55 var(--ax-mono)}
@media(max-width:800px){main{padding:22px 14px 48px}.mx-head{align-items:flex-start;flex-direction:column}.mx-health{width:100%;grid-template-columns:repeat(2,1fr)}.mx-grid{grid-template-columns:1fr}.mx-section-head{align-items:flex-start}.mx-legend{display:none}}
@media(prefers-reduced-motion:reduce){.mx-run,.mx-peek,.mx-drawer{transition:none}}
`;

const MESH_SCRIPT = `<script>
(function(){
  var state = null;
  var drawer = document.getElementById('mx-drawer');
  var scrim = document.getElementById('mx-scrim');
  var close = document.getElementById('mx-close');
  function esc(v){return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function age(v){if(!v)return 'unknown';var s=Math.max(0,(Date.now()-new Date(v).getTime())/1000);if(s<60)return Math.floor(s)+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
  function duration(ms){if(!Number.isFinite(ms))return '-';return ms<1000?ms+'ms':(ms/1000).toFixed(ms<10000?1:0)+'s'}
  function statusColor(s){return s==='success'?'var(--ax-ok)':(s==='failed'||s==='timeout')?'var(--ax-err)':'var(--ax-muted)'}
  function openDrawer(kicker,title,html){document.getElementById('mx-drawer-kicker').textContent=kicker;document.getElementById('mx-drawer-title').textContent=title;document.getElementById('mx-drawer-body').innerHTML=html;drawer.classList.add('is-open');drawer.setAttribute('aria-hidden','false');scrim.hidden=false;close.focus()}
  function closeDrawer(){drawer.classList.remove('is-open');drawer.setAttribute('aria-hidden','true');scrim.hidden=true}
  close.addEventListener('click',closeDrawer);scrim.addEventListener('click',closeDrawer);document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
  function detail(data){var fields=data.fields.map(function(f){return '<dt>'+esc(f[0])+'</dt><dd>'+esc(f[1])+'</dd>'}).join('');var note=data.note?'<pre>'+esc(data.note)+'</pre>':'';return '<div class="mx-detail"><dl>'+fields+'</dl>'+note+'</div>'}
  function render(s){state=s;var nodes=s.nodes||[];var reachable=nodes.filter(function(n){return n.reachable});var agents=reachable.flatMap(function(n){return (n.agents||[]).map(function(a){return {node:n,agent:a}})});var tasks=agents.flatMap(function(x){return (x.agent.runningTasks||[]).map(function(t){return {node:x.node,agent:x.agent,task:t}})});var runs=reachable.flatMap(function(n){return (n.cronRuns||[]).map(function(r){return {node:n,run:r}})});
    var failed=runs.filter(function(x){return x.run.status!=='success'}).length;var skillTotal=agents.reduce(function(v,x){return v+(x.agent.skillCount||0)},0);
    document.getElementById('mx-health').innerHTML=[['Nodes',reachable.length+'/'+nodes.length],['Active',tasks.length],['Failures',failed],['Skills',skillTotal]].map(function(v){return '<div class="mx-stat"><strong>'+esc(v[1])+'</strong><span>'+esc(v[0])+'</span></div>'}).join('');
    document.getElementById('mx-updated').textContent='Updated '+new Date(s.ts).toLocaleTimeString()+' · '+Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById('mx-active-count').textContent=tasks.length+' active';document.getElementById('mx-node-count').textContent=nodes.length+' nodes';document.getElementById('mx-agent-count').textContent=agents.length+' agents';
    renderRuns(reachable);renderTasks(tasks);renderNodes(nodes);renderAgents(agents);
  }
  function renderRuns(nodes){var cards=[];nodes.forEach(function(n){(n.crons||[]).forEach(function(job){var history=(n.cronRuns||[]).filter(function(r){return r.jobId===job.id});var latest=history[0];var status=!job.enabled?'disabled':latest?latest.status:job.retryPending?'retrying':'waiting';var summary=latest?(latest.errorSummary||latest.responseSummary||'No summary'):(job.enabled?'No attempt persisted today':'Schedule disabled');cards.push({node:n,job:job,run:latest,status:status,summary:summary})})});var root=document.getElementById('mx-runs');if(!cards.length){root.innerHTML='<div class="mx-empty">No schedules reported by reachable nodes.</div>';return}root.innerHTML=cards.map(function(x,i){return '<button class="mx-run" type="button" data-run="'+i+'"><span class="mx-run__top"><span class="mx-run__node">'+esc(x.node.name)+'</span><i class="mx-status" style="background:'+statusColor(x.status)+'"></i></span><h3>'+esc(x.job.id)+'</h3><p>'+esc(x.job.agent)+' · '+esc(x.job.schedule)+'</p><span class="mx-peek">'+esc(x.summary)+'</span></button>'}).join('');root.querySelectorAll('[data-run]').forEach(function(el){el.addEventListener('click',function(){var x=cards[Number(el.dataset.run)];openDrawer('Automation',x.job.id,detail({fields:[['Node',x.node.name],['Agent',x.job.agent],['Status',x.status],['Schedule',x.job.schedule],['Timezone',x.job.timezone||'local'],['Started',x.run?new Date(x.run.startedAt).toLocaleString():'Not today'],['Duration',x.run?duration(x.run.duration):'-'],['Retry',x.run&&x.run.isRetry?'Attempt '+x.run.retryAttempt:'No'],['Task ID',x.run&&x.run.taskId||'-'],['Session ID',x.run&&x.run.sessionId||'-']],note:x.summary}))})});
  }
  function renderTasks(tasks){var root=document.getElementById('mx-active');if(!tasks.length){root.innerHTML='<div class="mx-empty">The mesh is idle.</div>';return}root.innerHTML=tasks.map(function(x,i){return '<a class="mx-row" href="/tasks/'+encodeURIComponent(x.task.id)+'?node='+encodeURIComponent(x.node.url)+'&agent='+encodeURIComponent(x.agent.id)+'&name='+encodeURIComponent(x.agent.name)+'&channel='+encodeURIComponent(x.task.channel||'unknown')+'"><i class="mx-dot busy"></i><span><strong>'+esc(x.agent.name)+' · '+esc(x.task.messagePreview||'Working')+'</strong><small>'+esc(x.node.name)+' / '+esc(x.task.channel||'unknown')+(x.task.sender?' / initiated by '+esc(x.task.sender):'')+'</small></span><time>'+esc(age(x.task.startedAt))+'</time></a>'}).join('')}
  function renderNodes(nodes){var root=document.getElementById('mx-nodes');root.innerHTML=nodes.map(function(n,i){var active=(n.agents||[]).reduce(function(v,a){return v+(a.active||0)},0);return '<button class="mx-row" type="button" data-node="'+i+'"><i class="mx-dot '+(n.reachable?(active?'busy':''):'off')+'"></i><span><strong>'+esc(n.name)+'</strong><small>'+esc(n.reachable?(n.agents.length+' agents · '+active+' active'):(n.error||'unreachable'))+'</small></span><time>'+esc(n.uptimeSec?Math.floor(n.uptimeSec/3600)+'h up':'-')+'</time></button>'}).join('');root.querySelectorAll('[data-node]').forEach(function(el){el.addEventListener('click',function(){var n=nodes[Number(el.dataset.node)];openDrawer('Fleet node',n.name,detail({fields:[['Status',n.reachable?'Reachable':'Unreachable'],['URL',n.url],['Agents',(n.agents||[]).length],['Schedules',(n.crons||[]).length],['Uptime',n.uptimeSec?Math.floor(n.uptimeSec/60)+' minutes':'-']],note:n.error||''}))})})}
  function renderAgents(items){var root=document.getElementById('mx-agents');if(!items.length){root.innerHTML='<div class="mx-empty">No agent inventory available.</div>';return}root.innerHTML=items.map(function(x,i){var a=x.agent;return '<button class="mx-agent" type="button" data-agent="'+i+'"><span class="mx-agent__top"><strong>'+esc(a.name)+'</strong><code>'+esc(x.node.name)+'</code></span><p>'+esc(a.tier)+' · '+esc(a.model||'default model')+'<br>'+esc(a.skillCount==null?'skills unavailable':a.skillCount+' skills')+' · '+esc(a.total||0)+' tasks</p></button>'}).join('');root.querySelectorAll('[data-agent]').forEach(function(el){el.addEventListener('click',function(){var x=items[Number(el.dataset.agent)],a=x.agent;var history='/agents/'+encodeURIComponent(a.id)+'/history?node='+encodeURIComponent(x.node.url)+'&name='+encodeURIComponent(a.name);openDrawer('Agent inventory',a.name,detail({fields:[['Node',x.node.name],['Agent ID',a.id],['Runtime',a.tier],['Model',a.model||'default'],['Skills',a.skillCount==null?'Unavailable until node upgrade':a.skillCount],['Active tasks',a.active||0],['Total tasks',a.total||0],['Errors',a.errors||0]],note:a.lastSummary&&a.lastSummary.text||''})+'<a class="mx-link" href="'+history+'">Open activity history</a>')})})}
  function load(){var date=new Date().toLocaleDateString('en-CA');var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';fetch('/api/mesh?date='+encodeURIComponent(date)+'&timezone='+encodeURIComponent(tz)).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(render).catch(function(e){document.getElementById('mx-updated').textContent='Fleet snapshot unavailable: '+e.message})}
  load();setInterval(load,5000);
})();
</script>`;
