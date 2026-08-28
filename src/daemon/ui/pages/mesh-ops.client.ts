// Operations view for /mesh — the live fleet snapshot that predates the
// analytics views: today's scheduled attempts, what is running right now,
// node reachability, and the agent/skill inventory.
//
// Unchanged in substance; it now shares the drawer and formatters with the
// other views through window.MX instead of carrying its own copies.
export const MESH_OPS_SCRIPT = `<script>
(function(){
  var showAll=document.getElementById('mx-show-all'),expanded=false;
  var esc=MX.esc;
  function initials(v){return String(v||'?').split(/[-_ ]+/).slice(0,2).map(function(x){return x.charAt(0)}).join('').toUpperCase()}
  function badge(status){
    var kind=(status==='success'||status==='active'||status==='online')?'ax-badge--live'
      :(status==='failed'||status==='timeout'||status==='offline')?'ax-badge--err'
      :status==='retrying'?'ax-badge--warn':'ax-badge--ghost';
    return '<span class="ax-badge '+kind+'">'+esc(status)+'</span>';
  }
  function avatar(text,variant){return '<span class="ax-avatar '+(variant?'ax-avatar--'+variant:'')+'">'+esc(initials(text))+'</span>'}
  function item(info,actions,attrs,variant){
    var tag=info.href?'a':'button';
    return '<'+tag+' class="ax-row-card mx-item" '+(info.href?'href="'+info.href+'"':'type="button"')+' '+(attrs||'')+'>'
      +avatar(info.avatar||info.title,variant)
      +'<span class="ax-row-card__info"><span class="ax-name">'+esc(info.title)
      +(info.slug?' <span class="ax-slug">'+esc(info.slug)+'</span>':'')+'</span>'
      +'<span class="ax-sub">'+info.sub+'</span></span>'
      +'<span class="ax-row-card__actions">'+(actions||'')+'</span></'+tag+'>';
  }
  function detail(data){
    return '<div class="mx-detail">'+MX.fields(data.fields)+(data.note?'<pre>'+esc(data.note)+'</pre>':'')+'</div>';
  }
  showAll.addEventListener('click',function(){
    expanded=!expanded;
    document.querySelectorAll('#mx-runs .mx-item').forEach(function(el,i){el.hidden=!expanded&&i>=8});
    showAll.textContent=expanded?'Show less':'Show all';
  });

  function render(s){
    var nodes=s.nodes||[],reachable=nodes.filter(function(n){return n.reachable});
    var agents=reachable.flatMap(function(n){return (n.agents||[]).map(function(a){return {node:n,agent:a}})});
    var tasks=agents.flatMap(function(x){return (x.agent.runningTasks||[]).map(function(t){return {node:x.node,agent:x.agent,task:t}})});
    var runs=reachable.flatMap(function(n){return (n.cronRuns||[]).map(function(r){return {node:n,run:r}})});
    var failed=runs.filter(function(x){return x.run.status!=='success'}).length;
    MX.setHealth(0,reachable.length+'/'+nodes.length,reachable.length===nodes.length?'ok':'warn');
    MX.setHealth(1,tasks.length,tasks.length?'ok':'off');
    MX.setHealth(2,failed,failed?'warn':'off');
    document.getElementById('mx-updated').textContent='Fleet snapshot '+new Date(s.ts).toLocaleTimeString()
      +' · '+Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById('mx-active-count').textContent=tasks.length+' active';
    document.getElementById('mx-node-count').textContent=nodes.length+' nodes';
    document.getElementById('mx-agent-count').textContent=agents.length+' agents';
    renderRuns(reachable);renderTasks(tasks);renderNodes(nodes);renderAgents(agents);
  }
  function renderRuns(nodes){
    var cards=[];
    nodes.forEach(function(n){(n.crons||[]).forEach(function(job){
      var history=(n.cronRuns||[]).filter(function(r){return r.jobId===job.id}),latest=history[0];
      var status=!job.enabled?'disabled':latest?latest.status:job.retryPending?'retrying':'waiting';
      var summary=latest?(latest.errorSummary||latest.responseSummary||'No summary')
        :(job.enabled?'No attempt persisted today':'Schedule disabled');
      var agent=(n.agents||[]).find(function(a){return a.id===job.agent});
      cards.push({node:n,job:job,run:latest,status:status,summary:summary,agent:agent});
    })});
    var root=document.getElementById('mx-runs');
    document.getElementById('mx-run-count').textContent=cards.length+' schedules';
    showAll.hidden=cards.length<=8;
    if(!cards.length){root.innerHTML='<div class="mx-empty">No schedules reported by reachable nodes.</div>';return}
    root.innerHTML=cards.map(function(x,i){
      var sub='<code>'+esc(x.job.agent)+'</code><span>'+esc(x.job.schedule)+'</span>'
        +'<span class="mx-summary">'+esc(x.summary)+'</span>';
      var variant=x.status==='success'?'teal':(x.status==='failed'||x.status==='timeout')?'coral':'plain';
      return item({title:x.job.id,slug:x.node.name,sub:sub},badge(x.status),
        'data-run="'+i+'"'+(!expanded&&i>=8?' hidden':''),variant);
    }).join('');
    root.querySelectorAll('[data-run]').forEach(function(el){
      el.addEventListener('click',function(){
        var x=cards[Number(el.dataset.run)],runtime=(x.agent&&x.agent.tier)||'unknown';
        var model=x.job.model||(x.agent&&x.agent.model);
        MX.open('Automation',x.job.id,detail({fields:[
          ['Node',x.node.name],['Agent',x.job.agent],['Runtime',runtime],
          ['Model',x.job.model?model:(model?model+' (inherited)':'default')],
          ['Status',x.status],['Schedule',x.job.schedule],['Timezone',x.job.timezone||'local'],
          ['Started',x.run?new Date(x.run.startedAt).toLocaleString():'Not today'],
          ['Duration',x.run?MX.dur(x.run.duration):'-'],
          ['Retry',x.run&&x.run.isRetry?'Attempt '+x.run.retryAttempt:'No'],
          ['Task ID',(x.run&&x.run.taskId)||'-'],['Session ID',(x.run&&x.run.sessionId)||'-']
        ],note:x.summary}));
      });
    });
  }
  function renderTasks(tasks){
    var root=document.getElementById('mx-active');
    if(!tasks.length){root.innerHTML='<div class="mx-empty">The mesh is idle.</div>';return}
    root.innerHTML=tasks.map(function(x){
      var href='/tasks/'+encodeURIComponent(x.task.id)+'?node='+encodeURIComponent(x.node.url)
        +'&agent='+encodeURIComponent(x.agent.id)+'&name='+encodeURIComponent(x.agent.name)
        +'&channel='+encodeURIComponent(x.task.channel||'unknown');
      var sub='<code>'+esc(x.node.name)+' / '+esc(x.task.channel||'unknown')+'</code>'
        +'<span class="mx-summary">'+esc(x.task.messagePreview||'Working')+'</span>';
      return item({href:href,title:x.agent.name,slug:x.task.sender?'by '+x.task.sender:'',sub:sub},
        '<span class="mx-node-meta">'+esc(MX.age(x.task.startedAt))+'</span>','','blue');
    }).join('');
  }
  function renderNodes(nodes){
    var root=document.getElementById('mx-nodes');
    root.innerHTML=nodes.map(function(n,i){
      var active=(n.agents||[]).reduce(function(v,a){return v+(a.active||0)},0);
      var sub='<span>'+esc(n.reachable?n.agents.length+' agents · '+active+' active':n.error||'unreachable')+'</span>';
      var status=n.reachable?(active?'active':'online'):'offline';
      return item({title:n.name,slug:n.id,sub:sub},badge(status),'data-node="'+i+'"',n.reachable?'teal':'coral');
    }).join('');
    root.querySelectorAll('[data-node]').forEach(function(el){
      el.addEventListener('click',function(){
        var n=nodes[Number(el.dataset.node)];
        MX.open('Fleet node',n.name,detail({fields:[
          ['Status',n.reachable?'Reachable':'Unreachable'],['URL',n.url],
          ['Agents',(n.agents||[]).length],['Schedules',(n.crons||[]).length],
          ['Uptime',n.uptimeSec?Math.floor(n.uptimeSec/60)+' minutes':'-']
        ],note:n.error||''}));
      });
    });
  }
  function renderAgents(items){
    var root=document.getElementById('mx-agents');
    if(!items.length){root.innerHTML='<div class="mx-empty">No agent inventory available.</div>';return}
    root.innerHTML=items.map(function(x,i){
      var a=x.agent;
      var sub='<code>'+esc(a.tier)+' · '+esc(a.model||'default model')+'</code>'
        +'<span>'+esc(a.skillCount==null?'skills unavailable':a.skillCount+' skills')+' · '+esc(a.total||0)+' tasks</span>';
      return item({title:a.name,slug:x.node.name,sub:sub},badge(a.active?'active':'idle'),'data-agent="'+i+'"',a.active?'blue':'plain');
    }).join('');
    root.querySelectorAll('[data-agent]').forEach(function(el){
      el.addEventListener('click',function(){
        var x=items[Number(el.dataset.agent)],a=x.agent;
        var history='/agents/'+encodeURIComponent(a.id)+'/history?node='+encodeURIComponent(x.node.url)
          +'&name='+encodeURIComponent(a.name);
        MX.open('Agent inventory',a.name,detail({fields:[
          ['Node',x.node.name],['Agent ID',a.id],['Runtime',a.tier],['Model',a.model||'default'],
          ['Skills',a.skillCount==null?'Unavailable until node upgrade':a.skillCount],
          ['Active tasks',a.active||0],['Total tasks',a.total||0],['Errors',a.errors||0]
        ],note:(a.lastSummary&&a.lastSummary.text)||''})
          +'<a class="mx-link" href="'+history+'">Open activity history</a>');
      });
    });
  }
  function load(){
    var date=new Date().toLocaleDateString('en-CA');
    var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
    MX.get('/api/mesh?date='+encodeURIComponent(date)+'&timezone='+encodeURIComponent(tz))
      .then(render)
      .catch(function(e){document.getElementById('mx-updated').textContent='Fleet snapshot unavailable: '+e.message});
  }
  load();setInterval(load,5000);
})();
</script>`
