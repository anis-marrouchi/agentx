// Activity + Lifetime views for /mesh. Reads GET /api/mesh/analytics
// (fleet-merged) and drills into a single node through the /api/mesh/{job,
// thread,run} proxies.
//
// Every number rendered here comes from the operational SQLite of some
// node. Nothing is modelled, smoothed, or extrapolated: when a series is
// empty the panel says so instead of drawing a plausible shape.
export const MESH_ANALYTICS_SCRIPT = `<script>
(function(){
  var LANES=[
    {id:'cron',name:'Scheduled',hint:'cron jobs'},
    {id:'workflow',name:'Workflow',hint:'dataflow runs'},
    {id:'direct',name:'Direct',hint:'chat, API, git hosts'}
  ];
  var state={days:30,data:null,channel:'all',threadLimit:25};
  var tip=null;

  function el(id){return document.getElementById(id)}
  function showTip(host,html,ev){
    if(!tip){tip=document.createElement('div');tip.className='mx-tip';document.body.appendChild(tip)}
    tip.innerHTML=html;tip.style.display='block';
    var pad=14,w=tip.offsetWidth,h=tip.offsetHeight;
    var x=Math.min(window.innerWidth-w-8,Math.max(8,ev.clientX+pad));
    var y=Math.max(8,ev.clientY-h-pad);
    tip.style.position='fixed';tip.style.left=x+'px';tip.style.top=y+'px';
  }
  function hideTip(){if(tip)tip.style.display='none'}

  // --- Activity lanes: one small multiple per origin. Each lane is a
  // single series scaled to ITS OWN peak, so a 2,400-run workflow day
  // cannot flatten a 60-run cron day. The peak is printed next to the
  // lane name — without it a self-scaled lane would be misleading.
  function renderLanes(d){
    var root=el('mx-lanes');
    if(!d.days.length){root.innerHTML='<div class="mx-empty">No runs recorded in this window.</div>';el('mx-axis').innerHTML='';return}
    root.innerHTML=LANES.map(function(lane){
      var ok=[],fail=[],peak=0,tot=0,totFail=0;
      d.days.forEach(function(day){
        var b=day[lane.id]||[0,0];
        ok.push(b[0]);fail.push(b[1]);
        peak=Math.max(peak,b[0]+b[1]);tot+=b[0]+b[1];totFail+=b[1];
      });
      var cols=d.days.map(function(day,i){
        var total=ok[i]+fail[i];
        if(!total)return '<button class="mx-col" type="button" data-lane="'+lane.id+'" data-i="'+i+'" aria-label="'+MX.esc(day.day)+': no runs. Open this day"><i class="is-empty"></i></button>';
        var hOk=Math.max(total?2:0,Math.round(ok[i]/peak*54));
        var hFail=fail[i]?Math.max(2,Math.round(fail[i]/peak*54)):0;
        return '<button class="mx-col" type="button" data-lane="'+lane.id+'" data-i="'+i+'"'
          +' aria-label="'+MX.esc(day.day)+': '+total+' runs, '+fail[i]+' failed. Open this day">'
          +(hFail?'<i class="is-fail" style="height:'+hFail+'px"></i>':'')
          +'<i class="is-base" style="height:'+hOk+'px;background:var(--mx-lane-'+lane.id+')"></i>'
          +'</button>';
      }).join('');
      return '<div class="mx-lane">'
        +'<div class="mx-lane__name"><span class="mx-lane__swatch" style="background:var(--mx-lane-'+lane.id+')"></span>'
        +'<div>'+MX.esc(lane.name)+'<div class="mx-lane__peak">peak '+MX.num(peak)+'/day</div></div></div>'
        +'<div class="mx-cols">'+cols+'</div>'
        +'<div class="mx-lane__tot"><b>'+MX.num(tot)+'</b>'+MX.num(totFail)+' failed</div></div>';
    }).join('');
    el('mx-axis').innerHTML='<span>'+MX.esc(d.days[0].day)+'</span><span>'+MX.esc(d.days[d.days.length-1].day)+'</span>';
    root.querySelectorAll('.mx-col').forEach(function(b){
      function show(ev){
        var lane=b.dataset.lane,day=d.days[Number(b.dataset.i)],v=day[lane]||[0,0];
        showTip(b,'<b>'+MX.esc(day.day)+'</b><dl><dt>Ran</dt><dd>'+MX.num(v[0]+v[1])+'</dd>'
          +'<dt>Failed</dt><dd>'+MX.num(v[1])+'</dd><dt>Origin</dt><dd>'+MX.esc(lane)+'</dd></dl>'
          +'<p class="mx-tip__hint">Select for the full day</p>',ev);
      }
      b.addEventListener('mousemove',show);
      b.addEventListener('focus',function(){var r=b.getBoundingClientRect();show({clientX:r.left,clientY:r.top})});
      b.addEventListener('mouseleave',hideTip);b.addEventListener('blur',hideTip);
      b.addEventListener('click',function(){hideTip();MXD.openDay(d.days[Number(b.dataset.i)].day,b.dataset.lane)});
    });
  }

  // --- Where it breaks: one bar per origin channel, total runs with the
  // failed share drawn on top of the same track. One measure, one hue.
  function renderOrigins(d){
    var root=el('mx-origins');
    if(!d.origins.length){root.innerHTML='<div class="mx-empty">No runs in this window.</div>';return}
    var max=d.origins[0].runs||1;
    root.innerHTML=d.origins.map(function(o,i){
      var w=Math.max(2,o.runs/max*100),fw=o.runs?o.errors/o.runs*w:0;
      return '<button class="mx-bar" type="button" data-origin="'+i+'">'
        +'<span class="mx-bar__label">'+MX.esc(o.channel)+'</span>'
        +'<span class="mx-bar__track"><span class="mx-bar__fill" style="width:'+w+'%;background:var(--ax-accent);opacity:.35"></span>'
        +(fw?'<span class="mx-bar__fail" style="left:'+(w-fw)+'%;width:'+fw+'%"></span>':'')+'</span>'
        +'<span class="mx-bar__val">'+MX.num(o.runs)+' <em>'+MX.pct(o.errors,o.runs)+' failed</em></span></button>';
    }).join('');
    root.querySelectorAll('[data-origin]').forEach(function(b){
      b.addEventListener('click',function(){
        var o=d.origins[Number(b.dataset.origin)];
        MX.open('Origin',o.channel,'<div class="mx-detail">'+MX.fields([
          ['Runs',MX.num(o.runs)],['Failed',MX.num(o.errors)],
          ['Failure rate',MX.pct(o.errors,o.runs)],['Runtime',MX.hours(o.hours)],
          ['Window',d.windowDays===0?'today so far':'last '+d.windowDays+' days']
        ])+'<p class="mx-note">Failure rate is computed over every recorded attempt on this channel, retries included. Runtime is the sum of measured task durations, not wall-clock.</p></div>');
      });
    });
  }

  // --- Why it fails: counts per cause class. Single series, single hue.
  function renderCauses(d){
    var root=el('mx-causes');
    if(!d.causes.length){root.innerHTML='<div class="mx-empty">No failures in this window.</div>';return}
    var max=d.causes[0].count||1,total=d.causes.reduce(function(v,c){return v+c.count},0);
    root.innerHTML=d.causes.map(function(c,i){
      return '<button class="mx-bar" type="button" data-cause="'+i+'">'
        +'<span class="mx-bar__label">'+MX.esc(MX.causeLabel(c.cause))+'</span>'
        +'<span class="mx-bar__track"><span class="mx-bar__fill" style="width:'+Math.max(2,c.count/max*100)+'%;background:var(--mx-crit);opacity:.7"></span></span>'
        +'<span class="mx-bar__val">'+MX.num(c.count)+' <em>'+MX.pct(c.count,total)+'</em></span></button>';
    }).join('');
    var known=d.causes.filter(function(c){return c.cause!=='other'}).reduce(function(v,c){return v+c.count},0);
    el('mx-cause-note').textContent=(known===total
      ? 'All '+MX.num(total)+' failures matched a known cause class.'
      : MX.pct(known,total)+' of '+MX.num(total)+' failures matched a known cause class.')
      +' None of them are the agent reasoning badly — they are the environment the agent runs in.';
    root.querySelectorAll('[data-cause]').forEach(function(b){
      b.addEventListener('click',function(){
        var c=d.causes[Number(b.dataset.cause)];
        MX.open('Failure cause',MX.causeLabel(c.cause),'<div class="mx-detail">'+MX.fields([
          ['Occurrences',MX.num(c.count)],['Share of failures',MX.pct(c.count,total)],
          ['Agents hit',c.agents.join(', ')||'-']
        ])+(c.example?MX.section('Representative error','<pre>'+MX.esc(c.example)+'</pre>'):'')+'</div>');
      });
    });
  }

  // --- Effort vs output. x = total runtime, y = mean output tokens on
  // SUCCESSFUL runs. Both log-scaled because both span four orders of
  // magnitude. The shaded band is the literal zombie rule, drawn so the
  // classification is visible rather than asserted.
  function renderScatter(d){
    var root=el('mx-scatter'),jobs=d.jobs.filter(function(j){return j.runs>0});
    if(!jobs.length){root.innerHTML='<div class="mx-empty">No recurring jobs ran in this window.</div>';return}
        // R is a deliberate right gutter, not just padding: points near the
    // maximum runtime are exactly the ones that most need a direct label.
    var W=820,H=340,L=54,R=74,T=18,B=38;
    var mins=function(j){return Math.max(j.hours*60,0.5)};
    var lx=function(m){return Math.log10(m)};
    var ly=function(t){return Math.log10(Math.max(t,0)+1)};
    var x0=lx(0.5),x1=Math.max(lx(60),Math.max.apply(null,jobs.map(function(j){return lx(mins(j))})));
    var y1=Math.max(ly(100),Math.max.apply(null,jobs.map(function(j){return ly(j.avgOutput)})));
    var px=function(m){return L+(lx(m)-x0)/(x1-x0)*(W-L-R)};
    var py=function(t){return H-B-ly(t)/y1*(H-T-B)};
    var g='';
    [1,10,60,600,6000].forEach(function(m){
      if(lx(m)<x0||lx(m)>x1)return;
      var gx=px(m),lbl=m<60?m+'m':(m/60)+'h';
      g+='<line x1="'+gx+'" y1="'+T+'" x2="'+gx+'" y2="'+(H-B)+'" stroke="var(--mx-grid)" stroke-width="1"/>'
        +'<text x="'+gx+'" y="'+(H-B+16)+'" text-anchor="middle">'+lbl+'</text>';
    });
    [0,10,100,1000,10000].forEach(function(t){
      if(ly(t)>y1)return;
      var gy=py(t);
      g+='<line x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'" stroke="var(--mx-grid)" stroke-width="1"/>'
        +'<text x="'+(L-8)+'" y="'+(gy+3)+'" text-anchor="end">'+MX.num(t)+'</text>';
    });
    var bandTop=py(25);
    var band='<rect x="'+L+'" y="'+bandTop+'" width="'+(W-L-R)+'" height="'+(H-B-bandTop)+'" fill="var(--mx-serious)" opacity=".08"/>'
      +'<text x="'+(W-R-4)+'" y="'+(bandTop+13)+'" text-anchor="end">under 25 tokens returned</text>';

    // Direct labels for every job that is not healthy — but only where one
    // fits. Candidates are tried right, left, above, below; a label that
    // still collides is dropped rather than stacked into an unreadable
    // smear. Hover and keyboard focus still name every point.
    var taken=[],marks='',labels='';
    function fits(b){
      for(var i=0;i<taken.length;i++){var t=taken[i];
        if(b.x<t.x+t.w&&t.x<b.x+b.w&&b.y<t.y+t.h&&t.y<b.y+b.h)return false}
      return true;
    }
    // Pass 1: every mark, and every mark's footprint, so a label placed in
    // pass 2 can never be dropped behind a point drawn after it.
    var placed=jobs.map(function(j,i){
      var r=Math.max(4,Math.min(15,Math.sqrt(j.runs)*1.1));
      return {j:j,i:i,r:r,cx:px(mins(j)),cy:py(j.avgOutput)};
    });
    placed.forEach(function(o){
      taken.push({x:o.cx-o.r,y:o.cy-o.r,w:o.r*2,h:o.r*2});
      marks+='<g class="mx-pt" tabindex="0" role="button" data-job="'+o.i+'"'
        +' aria-label="'+MX.esc(o.j.label+', '+MX.verdict(o.j.verdict).label+', '+o.j.runs+' runs, '+Math.round(o.j.avgOutput)+' tokens average output')+'">'
        +MX.mark(o.j.verdict,o.cx,o.cy,o.r)+'</g>';
    });
    // Pass 2: label the jobs that need acting on, worst runtime first.
    placed.filter(function(o){return o.j.verdict!=='healthy'})
      .sort(function(a,b){return b.j.hours-a.j.hours})
      .forEach(function(o){
        // Roboto Mono at 10px advances ~6.1px per character; the estimate
        // must over- rather than under-shoot or two labels touch.
        var w=o.j.label.length*6.2+10,h=13;
        var spots=[[o.cx+o.r+5,o.cy-h/2],[o.cx-o.r-5-w,o.cy-h/2],[o.cx-w/2,o.cy-o.r-4-h],[o.cx-w/2,o.cy+o.r+4]];
        for(var k=0;k<spots.length;k++){
          var b={x:spots[k][0],y:spots[k][1],w:w,h:h};
          if(b.x<L||b.x+w>W-2||b.y<T-6||b.y+h>H-B+2)continue;
          if(!fits(b))continue;
          taken.push(b);
          labels+='<text class="mx-lbl" x="'+b.x+'" y="'+(b.y+10)+'">'+MX.esc(o.j.label)+'</text>';
          break;
        }
      });
    root.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Runtime against output for every recurring job">'
      +band+g
      +'<line x1="'+L+'" y1="'+(H-B)+'" x2="'+(W-R)+'" y2="'+(H-B)+'" stroke="var(--ax-border-2)" stroke-width="2"/>'
      +'<text x="'+L+'" y="'+(H-6)+'">total runtime in window</text>'
      +'<text x="'+(L-8)+'" y="'+(T-5)+'" text-anchor="end">tokens</text>'
      +marks+labels+'</svg>';
    el('mx-scatter-legend').innerHTML=['healthy','fragile','zombie','never-succeeded'].map(function(v){
      var m=MX.verdict(v);
      return '<span><svg viewBox="-8 -8 16 16">'+MX.mark(v,0,0,6)+'</svg>'+MX.esc(m.label)+' — '+MX.esc(m.why)+'</span>';
    }).join('');
    root.querySelectorAll('[data-job]').forEach(function(gEl){
      var j=jobs[Number(gEl.dataset.job)];
      function show(ev){showTip(gEl,'<b>'+MX.esc(j.label)+'</b>'+MX.esc(j.agent)+' on '+MX.esc(j.node)
        +'<dl><dt>Verdict</dt><dd>'+MX.esc(MX.verdict(j.verdict).label)+'</dd>'
        +'<dt>Runs</dt><dd>'+MX.num(j.runs)+'</dd><dt>Failed</dt><dd>'+MX.num(j.errors)+'</dd>'
        +'<dt>Runtime</dt><dd>'+MX.hours(j.hours)+'</dd><dt>Avg run</dt><dd>'+j.avgMinutes+'m</dd>'
        +'<dt>Avg output</dt><dd>'+MX.num(Math.round(j.avgOutput))+' tok</dd></dl>',ev)}
      gEl.addEventListener('mousemove',show);
      gEl.addEventListener('mouseleave',hideTip);gEl.addEventListener('blur',hideTip);
      gEl.addEventListener('focus',function(){var r=gEl.getBoundingClientRect();show({clientX:r.left,clientY:r.top})});
      gEl.addEventListener('click',function(){MXD.openJob(j)});
      gEl.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();MXD.openJob(j)}});
    });
  }

  function renderThreads(d){
    var root=el('mx-threads');
    var chans=['all'].concat(d.origins.map(function(o){return o.channel}));
    el('mx-thread-chips').innerHTML=chans.map(function(c){
      return '<button class="mx-chip" type="button" data-chan="'+MX.esc(c)+'" aria-pressed="'+(state.channel===c)+'">'+MX.esc(c==='all'?'All channels':c)+'</button>';
    }).join('');
    el('mx-thread-chips').querySelectorAll('[data-chan]').forEach(function(b){
      b.addEventListener('click',function(){state.channel=b.dataset.chan;state.threadLimit=25;renderThreads(d)});
    });
    var rows=d.threads.filter(function(t){return state.channel==='all'||t.channel===state.channel});
    if(!rows.length){root.innerHTML='<div class="mx-empty">No threads on this channel in the window.</div>';return}
    var t0=d.windowStart,t1=d.generatedAt,span=Math.max(1,t1-t0);
    var CUT={'tier-2':'var(--mx-warn)','max-turns':'var(--ax-accent)','stale':'var(--ax-muted)'};
    var shown=rows.slice(0,state.threadLimit);
    root.innerHTML=shown.map(function(t,i){
      var left=Math.max(0,(t.firstAt-t0)/span*100);
      var width=Math.min(100-left,Math.max(0.6,(t.lastAt-t.firstAt)/span*100));
      // Ticks sit at the real timestamp of each recorded cut. When a thread
      // has more cuts than the payload carries, the count says so.
      var ticks=(t.cuts||[]).map(function(c){
        var pos=(c.at-t0)/span*100;
        if(pos<0||pos>100)return '';
        return '<span class="mx-life__tick" style="left:'+pos+'%;background:'+(CUT[c.reason]||'var(--ax-muted)')+'"></span>';
      }).join('');
      var cutLabel=t.rotations>t.cutsShown
        ? MX.num(t.cutsShown)+' of '+MX.num(t.rotations)+' cuts'
        : MX.num(t.rotations)+' cuts';
      return '<button class="mx-life" type="button" data-thread="'+i+'">'
        +'<span class="mx-life__id"><b>'+MX.esc(t.agent)+'</b><span>'+MX.esc(t.channel)+' · '+MX.esc(t.chatId)+'</span></span>'
        +'<span class="mx-life__span"><span class="mx-life__track" style="left:'+left+'%;width:'+width+'%"></span>'+ticks+'</span>'
        +'<span class="mx-life__meta"><b>'+MX.num(t.runs)+'</b> runs · '+MX.num(t.errors)+' failed<br>'
        +MX.esc(cutLabel)+' · '+MX.age(t.lastAt)+'</span></button>';
    }).join('');
    if(rows.length>shown.length){
      root.innerHTML+='<button class="ax-btn ax-btn--ghost mx-show-all" id="mx-more-threads" type="button">Show '
        +Math.min(25,rows.length-shown.length)+' more of '+rows.length+'</button>';
      root.querySelector('#mx-more-threads').addEventListener('click',function(){
        state.threadLimit+=25;renderThreads(d);
      });
    }
    root.querySelectorAll('[data-thread]').forEach(function(b){
      b.addEventListener('click',function(){MXD.openConversation(shown[Number(b.dataset.thread)])});
    });
  }

  function renderRotations(d){
    var r=d.rotations,root=el('mx-rotations');
    if(!r.total){root.innerHTML='<div class="mx-empty">No session cuts recorded in this window.</div>';return}
    var max=r.byReason[0]?r.byReason[0].count:1;
    var avg=r.tokenSamples?Math.round(r.tokenSum/r.tokenSamples):0;
    root.innerHTML=r.byReason.map(function(x){
      return '<div class="mx-bar"><span class="mx-bar__label">'+MX.esc(x.reason)+'</span>'
        +'<span class="mx-bar__track"><span class="mx-bar__fill" style="width:'+Math.max(2,x.count/max*100)+'%;background:var(--ax-accent);opacity:.45"></span></span>'
        +'<span class="mx-bar__val">'+MX.num(x.count)+' <em>'+MX.pct(x.count,r.total)+'</em></span></div>';
    }).join('');
    el('mx-rot-note').textContent=MX.num(r.total)+' session cuts. Where a token count was recorded, the average thread carried '
      +MX.num(avg)+' input tokens at the cut; the largest carried '+MX.num(r.maxTokens)+'.';
  }

  function renderNodes(d){
    var down=d.nodes.filter(function(n){return !n.ok});
    var txt='Merged from '+d.nodes.filter(function(n){return n.ok}).length+' of '+d.nodes.length+' nodes'
      +' · '+(d.windowDays===0?'today so far':'last '+d.windowDays+' days')
      +' · '+MX.num(d.totals.runs)+' runs, '+MX.num(d.totals.errors)+' failed'
      +' · steps retained for '+MX.num(d.retention.tracesWithSteps)+' of '+MX.num(d.retention.traces)+' runs';
    if(down.length)txt+=' · UNREACHABLE: '+down.map(function(n){return n.name+' ('+(n.error||'no answer')+')'}).join(', ');
    el('mx-analytics-updated').textContent=txt;
    var attention=d.jobs.filter(function(j){return j.verdict!=='healthy'}).length;
    MX.setHealth(3,attention,attention?'warn':'ok','Jobs needing review');
  }

  function render(d){
    state.data=d;
    d.windowStart=d.generatedAt-d.windowDays*86400000;
    renderNodes(d);renderLanes(d);renderOrigins(d);renderCauses(d);
    renderScatter(d);renderThreads(d);renderRotations(d);
  }

  function load(){
    el('mx-analytics-updated').textContent='Reading node histories...';
    MX.get('/api/mesh/analytics?days='+state.days+'&tzOffset='+(-new Date().getTimezoneOffset())+'&limit=80')
      .then(render)
      .catch(function(e){el('mx-analytics-updated').textContent='Analytics unavailable: '+e.message});
  }

  document.querySelectorAll('#mx-range button').forEach(function(b){
    b.addEventListener('click',function(){
      state.days=Number(b.dataset.days);
      document.querySelectorAll('#mx-range button').forEach(function(o){o.setAttribute('aria-pressed',String(o===b))});
      load();
    });
  });
  window.addEventListener('scroll',hideTip,{passive:true});
  load();
})();
</script>`
