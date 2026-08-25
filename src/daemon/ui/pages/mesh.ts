import {
  healthStrip,
  pageHead,
  renderShell,
  sectionHead,
  type TopbarPeer,
} from "../index";

const ICONS = {
  schedules: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h3l2-6 4 12 2-6h5"/></svg>`,
  nodes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M7 8l4 8M17 8l-4 8"/></svg>`,
  agents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>`,
};

export function renderMeshPage(opts: { peers?: TopbarPeer[] }): string {
  const chrome =
    pageHead({
      kicker: "Operations",
      title: "Mesh operations",
      lead: `Fleet health, active work, and today's scheduled outcomes across every reachable AgentX node.`,
    }) +
    healthStrip([
      { kind: "off", num: "-", label: "Nodes online" },
      { kind: "off", num: "-", label: "Tasks running" },
      { kind: "off", num: "-", label: "Failed today" },
      { kind: "off", num: "-", label: "Skills installed" },
    ]).replace(
      '<div class="ax-health-strip">',
      `<div class="ax-health-strip" id="mx-health">`,
    );

  const body = `${chrome}<main class="mx-content">
  <p id="mx-updated" class="mx-updated" aria-live="polite">Connecting to the fleet...</p>

  <section class="mx-section" aria-labelledby="mx-auto-title">
    ${sectionHead({
      icon: ICONS.schedules,
      title: "Today's automations",
      lead: "Persisted attempts are authoritative. Select a schedule to inspect its latest result and runtime.",
      actionHtml: `<div class="mx-section-actions"><span class="ax-tab-count" id="mx-run-count">0 schedules</span><button class="ax-btn ax-btn--ghost mx-show-all" id="mx-show-all" type="button" hidden>Show all</button></div>`,
    }).replace("<h2>", `<h2 id="mx-auto-title">`)}
    <div class="ax-stack" id="mx-runs"><div class="mx-empty">Loading schedules...</div></div>
  </section>

  <div class="mx-columns">
    <section class="mx-section" aria-labelledby="mx-active-title">
      ${sectionHead({
        icon: ICONS.activity,
        title: "Activity provenance",
        lead: "Who initiated current work and where it is running.",
        actionHtml: `<span class="ax-tab-count" id="mx-active-count">0 active</span>`,
      }).replace("<h2>", `<h2 id="mx-active-title">`)}
      <div class="ax-stack" id="mx-active"><div class="mx-empty">No activity loaded.</div></div>
    </section>

    <section class="mx-section" aria-labelledby="mx-nodes-title">
      ${sectionHead({
        icon: ICONS.nodes,
        title: "Nodes",
        lead: "Reachability and capacity across the fleet.",
        actionHtml: `<span class="ax-tab-count" id="mx-node-count">0 nodes</span>`,
      }).replace("<h2>", `<h2 id="mx-nodes-title">`)}
      <div class="ax-stack" id="mx-nodes"><div class="mx-empty">No nodes loaded.</div></div>
    </section>
  </div>

  <section class="mx-section" aria-labelledby="mx-agents-title">
    ${sectionHead({
      icon: ICONS.agents,
      title: "Agents and skills",
      lead: "Runtime, model, installed skills, and task totals by node.",
      actionHtml: `<span class="ax-tab-count" id="mx-agent-count">0 agents</span>`,
    }).replace("<h2>", `<h2 id="mx-agents-title">`)}
    <div class="mx-agent-grid" id="mx-agents"><div class="mx-empty">No agents loaded.</div></div>
  </section>
</main>
<div class="mx-scrim" id="mx-scrim" hidden></div>
<aside class="mx-drawer" id="mx-drawer" aria-labelledby="mx-drawer-title" aria-hidden="true">
  <header class="mx-drawer__head">
    <div><div class="ax-kicker" id="mx-drawer-kicker">Details</div><h2 id="mx-drawer-title">Selection</h2></div>
    <button class="ax-btn ax-btn--ghost" id="mx-close" type="button" aria-label="Close details">Close</button>
  </header>
  <div class="mx-drawer__body" id="mx-drawer-body"></div>
</aside>`;

  return renderShell({
    title: "AgentX · Mesh Operations",
    activeTab: "mesh",
    subtitle: "Operations",
    peers: opts.peers,
    noMain: true,
    body,
    css: MESH_CSS,
    scripts: MESH_SCRIPT,
  });
}

const MESH_CSS = `
.mx-content{max-width:1040px;margin:0 auto;padding:0 24px 56px}
.mx-updated{margin:0 0 24px;color:var(--ax-muted);font-size:11px;font-family:var(--ax-mono)}
.mx-section{margin-bottom:32px}.mx-section .ax-section-head{margin-bottom:14px}
.mx-section-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.mx-show-all{padding:4px 9px;font-size:11px;border-radius:var(--ax-radius-sm)}
.mx-columns{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr);gap:24px}
.mx-agent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mx-item{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;text-align:left;color:var(--ax-text);font:inherit;text-decoration:none;cursor:pointer}
.mx-item:hover,.mx-item:focus-visible{border-color:var(--ax-accent);text-decoration:none;outline:none}
.mx-item[hidden]{display:none}.mx-item .ax-avatar{width:34px;height:34px;border-radius:var(--ax-radius-sm)}
.mx-item .ax-row-card__actions{flex-shrink:0}.mx-item .ax-sub{min-width:0}.mx-item .ax-sub code{font:11px var(--ax-mono);color:var(--ax-muted)}
.mx-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ax-muted)}
.mx-node-meta{font:11px var(--ax-mono);color:var(--ax-muted)}
.mx-empty{padding:28px 18px;text-align:center;color:var(--ax-muted);font-size:12px;border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);background:var(--ax-surface)}
.mx-link{display:inline-block;margin-top:14px;color:var(--ax-accent);font-size:12px;font-weight:600;text-decoration:none}.mx-link:hover{text-decoration:underline}
.mx-scrim{position:fixed;inset:0;background:color-mix(in oklch,var(--ax-bg) 55%,black);z-index:29}
.mx-drawer{position:fixed;z-index:30;top:0;right:0;width:min(440px,calc(100vw - 20px));height:100vh;box-sizing:border-box;background:var(--ax-surface);border-left:var(--ax-border-w) solid var(--ax-border-2);transform:translateX(102%);transition:transform 180ms ease;overflow:auto;box-shadow:-12px 0 36px rgba(0,0,0,.2)}
.mx-drawer.is-open{transform:translateX(0)}.mx-drawer__head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;background:var(--ax-surface);border-bottom:var(--ax-border-w) solid var(--ax-border);z-index:1}
.mx-drawer__head .ax-kicker{font:10px var(--ax-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ax-muted);margin-bottom:4px}.mx-drawer__head h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}.mx-drawer__head .ax-btn{padding:6px 10px;font-size:11px;box-shadow:none}
.mx-drawer__body{padding:20px}.mx-detail{display:grid;gap:16px}.mx-detail dl{display:grid;grid-template-columns:100px 1fr;gap:9px 12px;margin:0;font-size:12px}.mx-detail dt{color:var(--ax-muted);font-family:var(--ax-mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em}.mx-detail dd{margin:0;word-break:break-word}.mx-detail pre{margin:0;padding:14px;background:var(--ax-bg);border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-sm);white-space:pre-wrap;font:11px/1.55 var(--ax-mono)}
@media(max-width:760px){.mx-content{padding:0 16px 40px}.mx-columns,.mx-agent-grid{grid-template-columns:1fr}.mx-section{margin-bottom:26px}.mx-section .ax-section-head{gap:12px}.mx-section .ax-section-head__icon{width:38px;height:38px}.mx-section .ax-section-head__text .ax-lead{display:none}.mx-item .ax-row-card__actions{align-self:flex-start}.mx-summary{max-width:56vw}}
@media(prefers-reduced-motion:reduce){.mx-drawer{transition:none}}
`;

const MESH_SCRIPT = `<script>
(function(){
  var drawer=document.getElementById('mx-drawer'),scrim=document.getElementById('mx-scrim'),close=document.getElementById('mx-close'),showAll=document.getElementById('mx-show-all'),expanded=false;
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function age(v){if(!v)return 'unknown';var s=Math.max(0,(Date.now()-new Date(v).getTime())/1000);if(s<60)return Math.floor(s)+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
  function duration(ms){if(!Number.isFinite(ms))return '-';return ms<1000?ms+'ms':(ms/1000).toFixed(ms<10000?1:0)+'s'}
  function initials(v){return String(v||'?').split(/[-_ ]+/).slice(0,2).map(function(x){return x.charAt(0)}).join('').toUpperCase()}
  function badge(status){var kind=(status==='success'||status==='active'||status==='online')?'ax-badge--live':(status==='failed'||status==='timeout'||status==='offline')?'ax-badge--err':status==='retrying'?'ax-badge--warn':'ax-badge--ghost';return '<span class="ax-badge '+kind+'">'+esc(status)+'</span>'}
  function avatar(text,variant){return '<span class="ax-avatar '+(variant?'ax-avatar--'+variant:'')+'">'+esc(initials(text))+'</span>'}
  function item(info,actions,attrs,variant){return '<'+(info.href?'a':'button')+' class="ax-row-card mx-item" '+(info.href?'href="'+info.href+'"':'type="button"')+' '+(attrs||'')+'>'+avatar(info.avatar||info.title,variant)+'<span class="ax-row-card__info"><span class="ax-name">'+esc(info.title)+(info.slug?' <span class="ax-slug">'+esc(info.slug)+'</span>':'')+'</span><span class="ax-sub">'+info.sub+'</span></span><span class="ax-row-card__actions">'+(actions||'')+'</span></'+(info.href?'a':'button')+'>'}
  function openDrawer(kicker,title,html){document.getElementById('mx-drawer-kicker').textContent=kicker;document.getElementById('mx-drawer-title').textContent=title;document.getElementById('mx-drawer-body').innerHTML=html;drawer.classList.add('is-open');drawer.setAttribute('aria-hidden','false');scrim.hidden=false;close.focus()}
  function closeDrawer(){drawer.classList.remove('is-open');drawer.setAttribute('aria-hidden','true');scrim.hidden=true}
  close.addEventListener('click',closeDrawer);scrim.addEventListener('click',closeDrawer);document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
  showAll.addEventListener('click',function(){expanded=!expanded;document.querySelectorAll('#mx-runs .mx-item').forEach(function(el,i){el.hidden=!expanded&&i>=8});showAll.textContent=expanded?'Show less':'Show all'});
  function detail(data){var fields=data.fields.map(function(f){return '<dt>'+esc(f[0])+'</dt><dd>'+esc(f[1])+'</dd>'}).join('');var note=data.note?'<pre>'+esc(data.note)+'</pre>':'';return '<div class="mx-detail"><dl>'+fields+'</dl>'+note+'</div>'}
  function setHealth(index,num,kind){var card=document.querySelectorAll('#mx-health .ax-health-card')[index];if(!card)return;card.querySelector('.ax-hc-num').textContent=String(num);card.querySelector('.ax-hc-dot').className='ax-hc-dot ax-hc-dot--'+kind}
  function render(s){var nodes=s.nodes||[],reachable=nodes.filter(function(n){return n.reachable}),agents=reachable.flatMap(function(n){return (n.agents||[]).map(function(a){return {node:n,agent:a}})}),tasks=agents.flatMap(function(x){return (x.agent.runningTasks||[]).map(function(t){return {node:x.node,agent:x.agent,task:t}})}),runs=reachable.flatMap(function(n){return (n.cronRuns||[]).map(function(r){return {node:n,run:r}})}),failed=runs.filter(function(x){return x.run.status!=='success'}).length,skills=agents.reduce(function(v,x){return v+(x.agent.skillCount||0)},0);
    setHealth(0,reachable.length+'/'+nodes.length,reachable.length===nodes.length?'ok':'warn');setHealth(1,tasks.length,tasks.length?'ok':'off');setHealth(2,failed,failed?'warn':'off');setHealth(3,skills,skills?'ok':'off');
    document.getElementById('mx-updated').textContent='Last fleet snapshot '+new Date(s.ts).toLocaleTimeString()+' · '+Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById('mx-active-count').textContent=tasks.length+' active';document.getElementById('mx-node-count').textContent=nodes.length+' nodes';document.getElementById('mx-agent-count').textContent=agents.length+' agents';renderRuns(reachable);renderTasks(tasks);renderNodes(nodes);renderAgents(agents);
  }
  function renderRuns(nodes){var cards=[];nodes.forEach(function(n){(n.crons||[]).forEach(function(job){var history=(n.cronRuns||[]).filter(function(r){return r.jobId===job.id}),latest=history[0],status=!job.enabled?'disabled':latest?latest.status:job.retryPending?'retrying':'waiting',summary=latest?(latest.errorSummary||latest.responseSummary||'No summary'):(job.enabled?'No attempt persisted today':'Schedule disabled'),agent=(n.agents||[]).find(function(a){return a.id===job.agent});cards.push({node:n,job:job,run:latest,status:status,summary:summary,agent:agent})})});var root=document.getElementById('mx-runs');document.getElementById('mx-run-count').textContent=cards.length+' schedules';showAll.hidden=cards.length<=8;if(!cards.length){root.innerHTML='<div class="mx-empty">No schedules reported by reachable nodes.</div>';return}root.innerHTML=cards.map(function(x,i){var sub='<code>'+esc(x.job.agent)+'</code><span>'+esc(x.job.schedule)+'</span><span class="mx-summary">'+esc(x.summary)+'</span>';return item({title:x.job.id,slug:x.node.name,sub:sub},badge(x.status),'data-run="'+i+'"'+(!expanded&&i>=8?' hidden':''),x.status==='success'?'teal':(x.status==='failed'||x.status==='timeout')?'coral':'plain')}).join('');root.querySelectorAll('[data-run]').forEach(function(el){el.addEventListener('click',function(){var x=cards[Number(el.dataset.run)],runtime=x.agent&&x.agent.tier||'unknown',model=x.job.model||(x.agent&&x.agent.model),modelLabel=x.job.model?model:model+' (inherited)';openDrawer('Automation',x.job.id,detail({fields:[['Node',x.node.name],['Agent',x.job.agent],['Runtime',runtime],['Model',modelLabel||'default'],['Status',x.status],['Schedule',x.job.schedule],['Timezone',x.job.timezone||'local'],['Started',x.run?new Date(x.run.startedAt).toLocaleString():'Not today'],['Duration',x.run?duration(x.run.duration):'-'],['Retry',x.run&&x.run.isRetry?'Attempt '+x.run.retryAttempt:'No'],['Task ID',x.run&&x.run.taskId||'-'],['Session ID',x.run&&x.run.sessionId||'-']],note:x.summary}))})})}
  function renderTasks(tasks){var root=document.getElementById('mx-active');if(!tasks.length){root.innerHTML='<div class="mx-empty">The mesh is idle.</div>';return}root.innerHTML=tasks.map(function(x){var href='/tasks/'+encodeURIComponent(x.task.id)+'?node='+encodeURIComponent(x.node.url)+'&agent='+encodeURIComponent(x.agent.id)+'&name='+encodeURIComponent(x.agent.name)+'&channel='+encodeURIComponent(x.task.channel||'unknown'),sub='<code>'+esc(x.node.name)+' / '+esc(x.task.channel||'unknown')+'</code><span class="mx-summary">'+esc(x.task.messagePreview||'Working')+'</span>';return item({href:href,title:x.agent.name,slug:x.task.sender?'by '+x.task.sender:'',sub:sub},'<span class="mx-node-meta">'+esc(age(x.task.startedAt))+'</span>','', 'blue')}).join('')}
  function renderNodes(nodes){var root=document.getElementById('mx-nodes');root.innerHTML=nodes.map(function(n,i){var active=(n.agents||[]).reduce(function(v,a){return v+(a.active||0)},0),sub='<span>'+esc(n.reachable?n.agents.length+' agents · '+active+' active':n.error||'unreachable')+'</span>',status=n.reachable?(active?'active':'online'):'offline';return item({title:n.name,slug:n.id,sub:sub},badge(status),'data-node="'+i+'"',n.reachable?'teal':'coral')}).join('');root.querySelectorAll('[data-node]').forEach(function(el){el.addEventListener('click',function(){var n=nodes[Number(el.dataset.node)];openDrawer('Fleet node',n.name,detail({fields:[['Status',n.reachable?'Reachable':'Unreachable'],['URL',n.url],['Agents',(n.agents||[]).length],['Schedules',(n.crons||[]).length],['Uptime',n.uptimeSec?Math.floor(n.uptimeSec/60)+' minutes':'-']],note:n.error||''}))})})}
  function renderAgents(items){var root=document.getElementById('mx-agents');if(!items.length){root.innerHTML='<div class="mx-empty">No agent inventory available.</div>';return}root.innerHTML=items.map(function(x,i){var a=x.agent,sub='<code>'+esc(a.tier)+' · '+esc(a.model||'default model')+'</code><span>'+esc(a.skillCount==null?'skills unavailable':a.skillCount+' skills')+' · '+esc(a.total||0)+' tasks</span>';return item({title:a.name,slug:x.node.name,sub:sub},badge(a.active?'active':'idle'),'data-agent="'+i+'"',a.active?'blue':'plain')}).join('');root.querySelectorAll('[data-agent]').forEach(function(el){el.addEventListener('click',function(){var x=items[Number(el.dataset.agent)],a=x.agent,history='/agents/'+encodeURIComponent(a.id)+'/history?node='+encodeURIComponent(x.node.url)+'&name='+encodeURIComponent(a.name);openDrawer('Agent inventory',a.name,detail({fields:[['Node',x.node.name],['Agent ID',a.id],['Runtime',a.tier],['Model',a.model||'default'],['Skills',a.skillCount==null?'Unavailable until node upgrade':a.skillCount],['Active tasks',a.active||0],['Total tasks',a.total||0],['Errors',a.errors||0]],note:a.lastSummary&&a.lastSummary.text||''})+'<a class="mx-link" href="'+history+'">Open activity history</a>')})})}
  function load(){var date=new Date().toLocaleDateString('en-CA'),tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';fetch('/api/mesh?date='+encodeURIComponent(date)+'&timezone='+encodeURIComponent(tz)).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(render).catch(function(e){document.getElementById('mx-updated').textContent='Fleet snapshot unavailable: '+e.message})}
  load();setInterval(load,5000);
})();
</script>`;
