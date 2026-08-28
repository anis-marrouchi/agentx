// Drill-down drawers for /mesh, exposed as window.MXD.
//
// Four entry points, all landing in the same drawer and all ending at the
// same place — one attempt and the tools it touched:
//
//   openDay          an activity column  → what ran that day → a conversation
//   openJob          a scatter bubble    → the job's attempt history
//   openConversation a thread row        → the whole life of one conversation
//   openRun          one attempt         → its step ledger
//
// Kept out of mesh-analytics.client.ts because that file is about drawing
// the overview; this one is about what happens after a click.
export const MESH_DRILL_SCRIPT = `<script>
window.MXD=(function(){
  function el(id){return document.getElementById(id)}
  function tz(){return -new Date().getTimezoneOffset()}
  function tiles(items){
    return '<div class="mx-stats">'+items.map(function(t){
      return '<div class="mx-stat"><b>'+MX.esc(t[0])+'</b><span>'+MX.esc(t[1])+'</span></div>';
    }).join('')+'</div>';
  }
  function miniBars(rows,color){
    if(!rows.length)return '<p class="mx-note">None recorded.</p>';
    var max=Math.max.apply(null,rows.map(function(r){return r[1]}))||1;
    return '<div class="mx-bars">'+rows.map(function(r){
      return '<div class="mx-bar"><span class="mx-bar__label">'+MX.esc(r[0])+'</span>'
        +'<span class="mx-bar__track"><span class="mx-bar__fill" style="width:'
        +Math.max(2,r[1]/max*100)+'%;background:'+color+';opacity:.6"></span></span>'
        +'<span class="mx-bar__val">'+MX.num(r[1])+'</span></div>';
    }).join('')+'</div>';
  }

  // --- One activity column ------------------------------------------
  //
  // The column the operator clicked belongs to ONE lane, so the drawer is
  // scoped to that lane by default. Opening the whole day from a Scheduled
  // column would answer a question nobody asked, and the numbers would not
  // match the bar that was clicked.
  var LANE_NAME={cron:'Scheduled',workflow:'Workflow',direct:'Direct'};
  function laneOf(channel){
    return channel==='cron'?'cron':channel==='workflow'?'workflow':'direct';
  }
  function openDay(day,lane){
    MX.open('Activity',day+(lane?' · '+(LANE_NAME[lane]||lane):''),
      '<div class="mx-detail"><div id="mx-day">'
      +'<div class="mx-empty">Loading '+MX.esc(day)+'...</div></div></div>');
    MX.get('/api/mesh/day?day='+encodeURIComponent(day)+'&tzOffset='+tz()+'&limit=60')
      .then(function(d){renderDay(d,lane)})
      .catch(function(e){var h=el('mx-day');if(h)h.innerHTML='<div class="mx-empty">'+MX.esc(e.message)+'</div>'});
  }

  /** Narrow a fleet day to one lane, using the same origin rule the lanes
   *  themselves are built with. Causes cannot be split this way — they are
   *  aggregated per day, not per channel — so they stay fleet-wide and say so. */
  function scopeDay(d,lane){
    if(!lane)return {scoped:d,all:d,lane:null};
    var origins=d.origins.filter(function(o){return laneOf(o.channel)===lane});
    var conversations=d.conversations.filter(function(c){return laneOf(c.channel)===lane});
    var totals={runs:0,errors:0,ms:0,inputTokens:0,outputTokens:0};
    origins.forEach(function(o){totals.runs+=o.runs;totals.errors+=o.errors;totals.ms+=o.ms});
    conversations.forEach(function(c){totals.inputTokens+=c.inputTokens;totals.outputTokens+=c.outputTokens});
    return {scoped:{day:d.day,nodes:d.nodes,totals:totals,origins:origins,causes:[],conversations:conversations},all:d,lane:lane};
  }
  function renderDay(full,lane){
    var host=el('mx-day');if(!host)return;
    var view=scopeDay(full,lane),d=view.scoped;
    if(!d.totals.runs){
      host.innerHTML='<div class="mx-empty">No '+MX.esc(lane?(LANE_NAME[lane]||lane).toLowerCase()+' ':'')
        +'work ran on '+MX.esc(d.day)+'.</div>';
      return;
    }
    var down=d.nodes.filter(function(n){return !n.ok});
    var html=tiles([
      ['Runs',MX.num(d.totals.runs)],
      ['Failed',MX.num(d.totals.errors)+' ('+MX.pct(d.totals.errors,d.totals.runs)+')'],
      ['Runtime',MX.dur(d.totals.ms)],
      ['Output',MX.num(d.totals.outputTokens)+' tok']
    ]);
    if(down.length)html+='<p class="mx-note">Missing '+MX.esc(down.map(function(n){return n.name}).join(', '))+' — these totals are partial.</p>';
    if(lane)html+='<p class="mx-note">Scoped to the '+MX.esc((LANE_NAME[lane]||lane).toLowerCase())
      +' lane you selected. The whole day ran '+MX.num(view.all.totals.runs)+' across every origin.</p>';
    html+=MX.section(lane?'Channels in this lane':'By origin',miniBars(d.origins.map(function(o){
      return [o.channel+(o.errors?' ('+o.errors+' failed)':''),o.runs]}),'var(--ax-accent)'));
    // Causes are grouped per day, not per channel, so they cannot be split
    // by lane without inventing an attribution. Show the day's, labelled.
    if(view.all.causes.length)html+=MX.section('Failures'+(lane?' (whole day)':''),
      miniBars(view.all.causes.map(function(c){return [MX.causeLabel(c.cause),c.count]}),'var(--mx-crit)'));
    // 60 is the fan-out cap per node, so a full list may be truncated —
    // label it rather than implying the day had exactly this many.
    var convCap=d.conversations.length>=60*Math.max(1,d.nodes.filter(function(n){return n.ok}).length);
    html+=MX.section('Conversations that day ('+(convCap?'busiest '+d.conversations.length:d.conversations.length)+')',
      '<div class="mx-convs">'+d.conversations.map(function(c,i){
        return '<button class="mx-conv" type="button" data-conv="'+i+'">'
          +'<span class="mx-conv__id"><b>'+MX.esc(c.agent)+'</b><span>'+MX.esc(c.channel)+' · '+MX.esc(c.chatId)+'</span></span>'
          +'<span class="mx-conv__meta">'+MX.plural(c.turns,'turn')+(c.errors?' · '+MX.num(c.errors)+' failed':'')
          +'<br>'+MX.dur(c.ms)+' · '+MX.num(c.outputTokens)+' tok out</span></button>';
      }).join('')+'</div><p class="mx-note">Ordered by runtime. Select one for its full history.</p>');
    host.innerHTML=html;
    host.querySelectorAll('[data-conv]').forEach(function(b){
      b.addEventListener('click',function(){openConversation(d.conversations[Number(b.dataset.conv)])});
    });
  }

  // --- One recurring job --------------------------------------------
  function openJob(j){
    var m=MX.verdict(j.verdict);
    MX.open('Recurring job',j.label,'<div class="mx-detail">'
      +'<div>'+MX.verdictChip(j.verdict)+'<p class="mx-note">'+MX.esc(m.why)+'</p></div>'
      +MX.fields([['Node',j.node],['Agent',j.agent],['Kind',j.kind],
        ['Runs',MX.num(j.runs)],['Succeeded',MX.num(j.okRuns)],['Failed',MX.num(j.errors)],
        ['Runtime',MX.hours(j.hours)],['Avg run',j.avgMinutes+' min'],
        ['Avg output',MX.num(Math.round(j.avgOutput))+' tokens'],['Last run',MX.when(j.lastAt)]])
      +'<div id="mx-drill">'+MX.section('Attempts','<div class="mx-empty">Loading attempts...</div>')+'</div></div>');
    MX.get('/api/mesh/job?node='+encodeURIComponent(j.nodeUrl)+'&kind='+encodeURIComponent(j.kind)
      +'&key='+encodeURIComponent(j.label)+'&limit=150')
      .then(function(r){renderRunGrid(j.nodeUrl,r.runs||[])})
      .catch(function(e){var t=el('mx-drill');if(t)t.innerHTML=MX.section('Attempts','<div class="mx-empty">'+MX.esc(e.message)+'</div>')});
  }

  // --- One conversation, whole life ---------------------------------
  function openConversation(c){
    MX.open('Conversation',c.agent,'<div class="mx-detail">'
      +MX.fields([['Node',c.node],['Channel',c.channel],['Conversation',c.chatId]])
      +'<div id="mx-conv"><div class="mx-empty">Loading summary...</div></div>'
      +'<div id="mx-drill">'+MX.section('Attempts','<div class="mx-empty">Loading attempts...</div>')+'</div></div>');
    var q='node='+encodeURIComponent(c.nodeUrl)+'&agent='+encodeURIComponent(c.agent)
      +'&channel='+encodeURIComponent(c.channel)+'&chat='+encodeURIComponent(c.chatId);
    MX.get('/api/mesh/conversation?'+q+'&tzOffset='+tz())
      .then(renderConversation)
      .catch(function(e){var h=el('mx-conv');if(h)h.innerHTML='<div class="mx-empty">'+MX.esc(e.message)+'</div>'});
    MX.get('/api/mesh/thread?'+q+'&limit=150')
      .then(function(r){renderRunGrid(c.nodeUrl,r.runs||[])})
      .catch(function(e){var t=el('mx-drill');if(t)t.innerHTML=MX.section('Attempts','<div class="mx-empty">'+MX.esc(e.message)+'</div>')});
  }
  function renderConversation(s){
    var host=el('mx-conv');if(!host)return;
    if(!s.found){host.innerHTML='<div class="mx-empty">No history for this conversation.</div>';return}
    // Cache reads are shown apart from fresh input on purpose: a long
    // thread is mostly cache, and one "tokens" number would make every
    // conversation look equally heavy.
    var html=tiles([
      ['Turns',MX.num(s.turns)],
      ['Failed',MX.num(s.errors)+(s.turns?' ('+MX.pct(s.errors,s.turns)+')':'')],
      ['Total time',MX.dur(s.totalMs)],
      ['Avg turn',MX.dur(s.avgMs)],
      ['Longest turn',MX.dur(s.maxMs)],
      ['Alive',MX.num(s.spanDays)+' days'],
      ['Used on',MX.num(s.activeDays)+' days'],
      ['Session cuts',MX.num(s.cuts.total)]
    ]);
    html+=MX.section('Tokens',tiles([
      ['Input',MX.num(s.inputTokens)],
      ['Output',MX.num(s.outputTokens)],
      ['Cache read',MX.num(s.cacheReadTokens)],
      ['Cache write',MX.num(s.cacheCreateTokens)]
    ])+'<p class="mx-note">Summed over every recorded turn. Cache reads are kept separate from fresh input.</p>');
    html+=MX.section('Span',MX.fields([
      ['First turn',MX.when(s.firstAt)],['Last turn',MX.when(s.lastAt)],
      ['Busiest day',s.busiestDay?s.busiestDay.day+' ('+MX.plural(s.busiestDay.turns,'turn')+')':'-'],
      ['Models',s.models.map(function(m){return m.model+' x'+m.turns}).join(', ')||'-']]));
    if(s.cuts.total)html+=MX.section('Session cuts',miniBars(s.cuts.byReason.map(function(r){
      return [r.reason,r.count]}),'var(--mx-warn)'));
    if(s.causes.length)html+=MX.section('Failure causes',miniBars(s.causes.map(function(c){
      return [MX.causeLabel(c.cause),c.count]}),'var(--mx-crit)'));
    html+=MX.section('Tools used',
      (s.tools.length?miniBars(s.tools.map(function(t){return [t.tool,t.used]}),'var(--ax-accent)')
        :'<p class="mx-note">No step ledger survived retention for this conversation.</p>')
      +'<p class="mx-note">Counted across the '+MX.num(s.toolRunsCounted)+' of '+MX.num(s.turns)
      +' turns whose steps are still retained.</p>');
    host.innerHTML=html;
  }

  // --- Attempts, then one attempt -----------------------------------
  function renderRunGrid(nodeUrl,runs){
    var host=el('mx-drill');if(!host)return;
    if(!runs.length){host.innerHTML=MX.section('Attempts','<div class="mx-empty">No individual attempts retained.</div>');return}
    var cells=runs.map(function(r,i){
      var c=r.status==='ok'?'var(--mx-good)':r.status==='timeout'?'var(--mx-warn)':'var(--mx-crit)';
      return '<button class="mx-run" type="button" data-run="'+i+'" aria-pressed="false" style="background:'+c+'"'
        +' title="'+MX.esc(new Date(r.startedAt).toLocaleString()+' · '+r.status+' · '+MX.dur(r.durationMs))+'"'
        +' aria-label="'+MX.esc(new Date(r.startedAt).toLocaleString()+', '+r.status)+'"></button>';
    }).join('');
    // Deliberately NOT windowed: "has this ever succeeded?" is a question
    // about all of history. The counters above it ARE windowed, so say so.
    var capped=runs.length>=150;
    host.innerHTML=MX.section('Attempts ('+(capped?'latest 150':runs.length)+', newest first)',
      '<div class="mx-runs">'+cells+'</div>'
      +'<p class="mx-note">Full recorded history, not limited to the selected window. Select an attempt to see what it touched.</p>')
      +'<div id="mx-run-detail"></div>';
    host.querySelectorAll('[data-run]').forEach(function(b){
      b.addEventListener('click',function(){
        host.querySelectorAll('[data-run]').forEach(function(o){o.setAttribute('aria-pressed','false')});
        b.setAttribute('aria-pressed','true');
        openRun(nodeUrl,runs[Number(b.dataset.run)]);
      });
    });
  }
  function openRun(nodeUrl,run){
    var host=el('mx-run-detail');if(!host)return;
    host.innerHTML=MX.section('Attempt','<div class="mx-empty">Loading steps...</div>');
    MX.get('/api/mesh/run?node='+encodeURIComponent(nodeUrl)+'&task='+encodeURIComponent(run.taskId))
      .then(function(s){
        var touched='<div class="mx-touch">'
          +'<span'+(s.reads?'':' class="is-zero"')+'>'+s.reads+' read</span>'
          +'<span'+(s.writes?'':' class="is-zero"')+'>'+s.writes+' write</span>'
          +'<span'+(s.sends?'':' class="is-zero"')+'>'+s.sends+' send</span>'
          +s.tools.map(function(t){return '<span>'+MX.esc(t.tool)+' x'+t.used+(t.failed?' ('+t.failed+' failed)':'')+'</span>'}).join('')
          +'</div>';
        var steps=s.steps.length
          ? '<ul class="mx-steps">'+s.steps.map(function(st){
              return '<li data-err="'+(st.status==='error'?1:0)+'"><span class="mx-seq">'+st.seq+'</span>'
                +'<span>'+MX.esc(st.action||st.name)+'</span><span>'+(st.ms==null?'':MX.dur(st.ms))+'</span></li>'}).join('')+'</ul>'
          : '<div class="mx-empty">Steps for this attempt were pruned by retention. Its totals above are still exact.</div>';
        host.innerHTML=MX.section('Attempt '+run.taskId.slice(-8),
          MX.fields([['Started',MX.when(s.startedAt)],['Duration',MX.dur(s.durationMs)],
            ['Status',s.status],['Model',s.model||'default'],
            ['Output',MX.num(s.outputTokens||0)+' tokens'],
            ['Cause',s.cause?MX.causeLabel(s.cause):'-']])
          +'<p class="mx-note">What this attempt touched</p>'+touched)
          +MX.section('Steps',steps);
      })
      .catch(function(e){host.innerHTML=MX.section('Attempt','<div class="mx-empty">'+MX.esc(e.message)+'</div>')});
  }

  return {openDay:openDay,openJob:openJob,openConversation:openConversation};
})();
</script>`
