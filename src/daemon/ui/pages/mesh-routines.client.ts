// Routines section of the /mesh Operations view: every schedule and every
// cron/hook-triggered workflow on every node, in one table, with the
// staleness verdict computed daemon-side (src/daemon/routines.ts).
//
// It does not poll on its own. The Operations script already fetches the
// fleet snapshot every few seconds and announces each one as an
// `mx:snapshot` event; this view renders from that, so adding it costs no
// extra request per tick.
//
// Plain ES5 inside a TS template literal — no backslash escapes (they are
// consumed before reaching the browser). Uses window.MX for the drawer and
// formatters.

export const MESH_ROUTINES_CSS = `
.mx-rt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:12px}
.mx-rt-wrap{border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-lg);background:var(--ax-surface);overflow-x:auto}
.mx-rt-wrap > .mx-empty{border:0}
.mx-rt{width:100%;border-collapse:collapse;font-size:12px}
.mx-rt th,.mx-rt td{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--ax-border)}
.mx-rt thead th{font:600 10px var(--ax-mono);letter-spacing:.05em;text-transform:uppercase;color:var(--ax-muted);background:var(--ax-surface-2)}
.mx-rt tbody:last-child tr:last-child td{border-bottom:0}
.mx-rt-node th{background:var(--ax-surface-2);font-size:12px;font-weight:600}
.mx-rt-node small{margin-left:8px;font:400 10px var(--ax-mono);color:var(--ax-muted)}
.mx-rt-node[data-offline="1"] th{color:var(--mx-crit)}
.mx-rt-msg td{color:var(--ax-muted);font-size:11px}
.mx-rt-name{display:block;max-width:240px;padding:0;border:0;background:none;color:var(--ax-text);font:600 12px var(--ax-font);text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-rt-name:hover{color:var(--ax-accent)}
.mx-rt-name:focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px;border-radius:2px}
.mx-rt-sub{display:block;font:10px var(--ax-mono);color:var(--ax-muted)}
.mx-rt code{font:11px var(--ax-mono);color:var(--ax-text-2);word-break:break-word}
.mx-rt-muted{color:var(--ax-muted)}
.mx-rt tr[data-attn="critical"] td:first-child{box-shadow:inset 3px 0 0 var(--mx-crit)}
.mx-rt tr[data-attn="warning"] td:first-child{box-shadow:inset 3px 0 0 var(--mx-warn)}
.mx-rt tr[data-attn="info"] td:first-child{box-shadow:inset 3px 0 0 var(--ax-border-2)}
.mx-rt tr[data-enabled="0"] td{color:var(--ax-muted)}
.mx-flags{display:flex;flex-wrap:wrap;gap:4px}
.mx-flag{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border:1px solid var(--ax-border-2);border-radius:var(--ax-radius-pill);font:600 10px var(--ax-mono);color:var(--ax-text-2);white-space:nowrap}
.mx-flag i{width:8px;height:8px;font-style:normal;flex:0 0 auto}
.mx-flag--critical i{background:var(--mx-crit);border-radius:1px;transform:rotate(45deg)}
.mx-flag--warning i{background:var(--mx-warn);clip-path:polygon(50% 0,100% 100%,0 100%)}
.mx-flag--info i{border:1.5px solid var(--ax-muted);border-radius:50%;box-sizing:border-box}
.mx-flag--ok i{background:var(--mx-good);border-radius:50%}
.mx-rt-cap{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mx-rt-why{margin:0;padding:0;list-style:none;display:grid;gap:8px;font-size:12px}
@media(max-width:860px){
  .mx-rt thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .mx-rt,.mx-rt tbody,.mx-rt tr,.mx-rt td,.mx-rt th{display:block;width:100%;box-sizing:border-box}
  .mx-rt tr{border-bottom:1px solid var(--ax-border);padding:6px 0}
  .mx-rt td{border:0;padding:3px 12px;display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px}
  .mx-rt td::before{content:attr(data-label);font:10px var(--ax-mono);text-transform:uppercase;letter-spacing:.05em;color:var(--ax-muted)}
  .mx-rt td:first-child{display:block}.mx-rt td:first-child::before{content:none}
  .mx-rt-msg td{display:block}.mx-rt-msg td::before{content:none}
  .mx-rt-name{max-width:100%}
}
`

export const MESH_ROUTINES_SCRIPT = `<script>
(function(){
  var root=document.getElementById('mx-routines');
  var bar=document.getElementById('mx-rt-filter');
  var count=document.getElementById('mx-rt-count');
  if(!root||!bar)return;
  var esc=MX.esc,rows=[],last=null,filter='all';
  try{filter=localStorage.getItem('mx-rt-filter')||'all'}catch(e){}
  var LABEL={failing:'Failing','overdue':'Overdue','dormant':'Dormant','never-ran':'Never ran','disabled-long':'Disabled long'};
  var SEVERITY={failing:'critical','overdue':'warning','dormant':'warning','never-ran':'warning','disabled-long':'info'};

  function until(iso){
    if(!iso)return '-';var s=(new Date(iso).getTime()-Date.now())/1000;
    if(s<=0)return 'due';if(s<3600)return 'in '+Math.ceil(s/60)+'m';
    if(s<86400)return 'in '+Math.round(s/3600)+'h';return 'in '+Math.round(s/86400)+'d';
  }
  function flagChip(f,r){
    var sev=SEVERITY[f.reason]||'info';
    var text=LABEL[f.reason]||f.reason;
    if(f.reason==='failing')text+=' x'+r.consecutiveFailures;
    return '<span class="mx-flag mx-flag--'+sev+'" title="'+esc(f.detail)+'"><i aria-hidden="true"></i>'+esc(text)+'</span>';
  }
  function health(r){
    if(r.flags&&r.flags.length)return '<span class="mx-flags">'+r.flags.map(function(f){return flagChip(f,r)}).join('')+'</span>';
    return r.enabled?'<span class="mx-flag mx-flag--ok"><i aria-hidden="true"></i>OK</span>':'<span class="mx-rt-muted">-</span>';
  }
  function trigger(r){
    var t=r.trigger||{};
    if(r.kind==='schedule')return '<code>'+esc(t.schedule||'?')+'</code>'+(t.timezone&&t.timezone!=='UTC'?' <span class="mx-rt-sub">'+esc(t.timezone)+'</span>':'');
    var f=(t.filters||[]);
    return '<code>'+esc(t.event||'?')+'</code>'+(f.length?'<span class="mx-rt-sub">'+esc(f.join(' · '))+'</span>':'');
  }
  function lastRun(r){
    if(!r.lastRun)return '<span class="mx-rt-muted">never</span>';
    return esc(r.lastRun.status)+' <span class="mx-rt-sub">'+esc(MX.age(r.lastRun.at))+'</span>';
  }
  function matches(r){
    if(filter==='attention')return !!r.attention;
    if(filter==='schedule'||filter==='event')return r.kind===filter;
    return true;
  }
  function cell(label,html){return '<td data-label="'+label+'">'+html+'</td>'}

  function render(s){
    last=s;rows=[];
    var nodes=s.nodes||[],total=0,attention=0,html='';
    nodes.forEach(function(n){
      var list=n.reachable&&Array.isArray(n.routines)?n.routines:[];
      total+=list.length;
      attention+=list.filter(function(r){return r.attention==='critical'||r.attention==='warning'}).length;
      var shown=list.filter(matches);
      var needs=list.filter(function(r){return !!r.attention}).length;
      var headNote=!n.reachable?'unreachable':!Array.isArray(n.routines)?'not reported'
        :MX.plural(list.length,'routine')+(needs?' · '+needs+' flagged':'');
      html+='<tbody><tr class="mx-rt-node"'+(n.reachable?'':' data-offline="1"')+'><th colspan="8" scope="rowgroup">'
        +esc(n.name)+'<small>'+esc(headNote)+'</small></th></tr>';
      if(!n.reachable){
        html+='<tr class="mx-rt-msg"><td colspan="8">Routines unknown while this node is unreachable'+(n.error?' ('+esc(n.error)+')':'')+'.</td></tr>';
      }else if(!Array.isArray(n.routines)){
        html+='<tr class="mx-rt-msg"><td colspan="8">This node does not report routines yet. Its schedules still appear under Today&#39;s automations.</td></tr>';
      }else if(!shown.length){
        html+='<tr class="mx-rt-msg"><td colspan="8">'+(list.length?'Nothing matches this filter.':'No schedules or triggered workflows.')+'</td></tr>';
      }
      shown.forEach(function(r){
        var i=rows.push({node:n,routine:r})-1;
        html+='<tr'+(r.attention?' data-attn="'+r.attention+'"':'')+' data-enabled="'+(r.enabled?1:0)+'">'
          +'<td><button type="button" class="mx-rt-name" data-rt="'+i+'" title="'+esc(r.name)+'">'+esc(r.name)+'</button>'
          +'<span class="mx-rt-sub">'+esc(r.source==='cron'?'cron job':'workflow')+'</span></td>'
          +cell('Kind',esc(r.kind))
          +cell('Trigger',trigger(r))
          +cell('Agent',r.agent?'<code>'+esc(r.agent)+'</code>':'<span class="mx-rt-muted">-</span>')
          +cell('State',esc(r.state))
          +cell('Next',r.kind==='schedule'?esc(until(r.nextRunAt)):'<span class="mx-rt-muted">on event</span>')
          +cell('Last run',lastRun(r))
          +cell('Health',health(r))
          +'</tr>';
      });
      html+='</tbody>';
    });
    count.textContent=MX.plural(total,'routine');
    count.textContent+=attention?' · '+attention+' flagged':'';
    root.innerHTML=nodes.length
      ?'<table class="mx-rt"><caption class="mx-rt-cap">Routines by node</caption><thead><tr>'
        +'<th scope="col">Routine</th><th scope="col">Kind</th><th scope="col">Trigger</th><th scope="col">Agent</th>'
        +'<th scope="col">State</th><th scope="col">Next</th><th scope="col">Last run</th><th scope="col">Health</th>'
        +'</tr></thead>'+html+'</table>'
      :'<div class="mx-empty">No nodes in the fleet snapshot.</div>';
  }

  function openRoutine(x){
    var r=x.routine,t=r.trigger||{};
    var fields=[['Node',x.node.name],['Routine ID',r.id],['Source',r.source==='cron'?'Cron job':'Workflow'],
      ['Kind',r.kind],['State',r.state],['Agent',r.agent||'-']];
    if(r.kind==='schedule')fields.push(['Schedule',t.schedule||'-'],['Timezone',t.timezone||'UTC'],
      ['Next fire',r.nextRunAt?new Date(r.nextRunAt).toLocaleString():'-']);
    else fields.push(['Event',t.event||'-'],['Filters',(t.filters||[]).join(', ')||'none']);
    fields.push(['Last run',r.lastRun?r.lastRun.status+', '+new Date(r.lastRun.at).toLocaleString():'Never'],
      ['Last success',r.lastSuccessAt?new Date(r.lastSuccessAt).toLocaleString():'-'],
      ['Failures in a row',r.consecutiveFailures],['Runs inspected',r.sampledRuns]);
    var flags=(r.flags||[]).length
      ?'<ul class="mx-rt-why">'+r.flags.map(function(f){return '<li>'+flagChip(f,r)+' '+esc(f.detail)+'</li>'}).join('')+'</ul>'
      :'<p class="mx-note">No staleness signal.</p>';
    MX.open('Routine',r.name,'<div class="mx-detail">'+MX.fields(fields)
      +MX.section('Signals',flags)
      +(r.lastRun&&r.lastRun.summary?MX.section('Last error',
        '<pre>'+esc(r.lastRun.summary)+'</pre>'):'')+'</div>');
  }

  root.addEventListener('click',function(e){
    var el=e.target.closest?e.target.closest('[data-rt]'):null;
    if(el&&rows[Number(el.dataset.rt)])openRoutine(rows[Number(el.dataset.rt)]);
  });
  function syncBar(){
    bar.querySelectorAll('[data-rt-filter]').forEach(function(b){
      b.setAttribute('aria-pressed',String(b.dataset.rtFilter===filter))});
  }
  bar.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('[data-rt-filter]'):null;
    if(!b)return;
    filter=b.dataset.rtFilter;syncBar();
    try{localStorage.setItem('mx-rt-filter',filter)}catch(err){}
    if(last)render(last);
  });
  if(!bar.querySelector('[data-rt-filter="'+filter+'"]'))filter='all';
  syncBar();
  document.addEventListener('mx:snapshot',function(e){render(e.detail||{})});
})();
</script>`
