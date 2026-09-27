// Mesh feed for the Operations view (#166): the newest events on the
// primary daemon's bus, which already holds every mesh peer's own events
// (src/events/peer-feed.ts). One read covers the fleet; the dashboard
// does not fan out, or each peer event would show twice.
//
// Compact by default: the newest few rows, filter chips, and the full
// envelope (root, ref, time) only in the drawer.
//
// Plain ES5 inside a TS template literal: no backslashes, no template
// placeholders, no backticks (they collapse before reaching the browser).

export const MESH_FEED_FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "peers", label: "Other machines" },
  { id: "announce", label: "Announcements" },
  { id: "problems", label: "Problems" },
]

export const MESH_FEED_SCRIPT = `<script>
(function(){
  var root=document.getElementById('mx-feed');
  if(!root)return;
  var esc=MX.esc,filter='all',expanded=false,events=[],local='',SHOWN=8;
  var more=document.getElementById('mx-feed-more');
  try{var saved=localStorage.getItem('mx-feed-filter');if(saved)filter=saved}catch(e){}
  var chips=Array.prototype.slice.call(document.querySelectorAll('[data-feed-filter]'));
  function pressChips(){chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.feedFilter===filter))})}
  chips.forEach(function(c){c.addEventListener('click',function(){
    filter=c.dataset.feedFilter;pressChips();render();
    try{localStorage.setItem('mx-feed-filter',filter)}catch(e){}
  })});
  pressChips();
  more.addEventListener('click',function(){expanded=!expanded;render()});

  function initials(v){return String(v||'?').split(/[-_. ]+/).slice(0,2).map(function(x){return x.charAt(0)}).join('').toUpperCase()}
  function problem(e){
    return e.type==='feed:down'||e.type==='feed:gap'||e.type==='failed'||e.type==='timeout'
      ||e.type==='lost'||(e.type==='task:completed'&&/^failed/.test(e.summary||''));
  }
  function label(e){
    if(e.kind==='announce')return 'Announcement';
    if(e.type==='feed:down')return 'Unreachable';
    if(e.type==='feed:up')return 'Back';
    if(e.type==='feed:gap')return 'Gap';
    if(e.type==='lost')return 'Lost';
    if(problem(e))return 'Failed';
    return e.kind;
  }
  function badge(e){
    var kind=problem(e)?'ax-badge--err':e.kind==='announce'?'ax-badge--warn':e.type==='feed:up'?'ax-badge--live':'ax-badge--ghost';
    return '<span class="ax-badge '+kind+'">'+esc(label(e))+'</span>';
  }
  function keep(e){
    if(filter==='peers')return e.node!==local;
    if(filter==='announce')return e.kind==='announce';
    if(filter==='problems')return problem(e);
    return true;
  }
  function render(){
    var list=events.filter(keep).slice().reverse();
    document.getElementById('mx-feed-count').textContent=MX.plural(list.length,'event');
    more.hidden=list.length<=SHOWN;
    more.textContent=expanded?'Show less':'Show all';
    if(!list.length){root.innerHTML='<div class="mx-empty">'+(events.length?'Nothing matches this filter.':'No events yet.')+'</div>';return}
    var shown=expanded?list:list.slice(0,SHOWN);
    root.innerHTML=shown.map(function(e,i){
      var who=e.agentId?'<code>'+esc(e.agentId)+'</code>':'';
      return '<button type="button" class="ax-row-card mx-item" data-feed="'+i+'">'
        +'<span class="ax-avatar '+(e.node===local?'ax-avatar--plain':'ax-avatar--blue')+'">'+esc(initials(e.node))+'</span>'
        +'<span class="ax-row-card__info"><span class="ax-name">'+esc(e.node)
        +(e.node===local?' <span class="ax-slug">this machine</span>':'')+'</span>'
        +'<span class="ax-sub">'+who+'<span class="mx-summary">'+esc(e.summary||e.type)+'</span></span></span>'
        +'<span class="ax-row-card__actions">'+badge(e)+'<span class="mx-node-meta">'+esc(MX.age(e.at))+'</span></span></button>';
    }).join('');
    root.querySelectorAll('[data-feed]').forEach(function(el){
      el.addEventListener('click',function(){
        var e=shown[Number(el.dataset.feed)];
        MX.open('Mesh event',label(e)+' on '+e.node,'<div class="mx-detail">'+MX.fields([
          ['Machine',e.node],['Kind',e.kind],['Type',e.type],['Agent',e.agentId||'-'],
          ['Time',new Date(e.at).toLocaleString()],['Record',e.ref||'-'],['Root',e.rootId]
        ])+'<pre>'+esc(e.summary||'')+'</pre></div>');
      });
    });
  }
  function load(){
    MX.get('/api/mesh/feed?limit=50').then(function(r){
      events=r.events||[];local=r.node||'';render();
    }).catch(function(e){
      root.innerHTML='<div class="mx-empty">Mesh feed unavailable: '+esc(e.message)+'</div>';
    });
  }
  load();setInterval(load,5000);
})();
</script>`
