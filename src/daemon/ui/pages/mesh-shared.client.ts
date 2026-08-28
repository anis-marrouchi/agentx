// Browser helpers shared by the mesh page's three views. Loaded once,
// before the view scripts, and exposed as `window.MX`.
//
// No build step (CLAUDE.md: zero-build dashboard stack), so this is a
// plain string of ES5-compatible browser JS. Avoid backslash escapes —
// inside a TS template literal they are eaten before reaching the browser.
export const MESH_SHARED_SCRIPT = `<script>
window.MX=(function(){
  var ENT={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return ENT[c]})}
  function num(v){return Number(v||0).toLocaleString()}
  /** "1 turn" / "2 turns" — a count reads as sloppy without it. */
  function plural(n,one,many){return num(n)+' '+(Number(n)===1?one:(many||one+'s'))}
  function pct(part,total){return total?Math.round(part/total*1000)/10+'%':'0%'}
  function age(v){if(!v)return 'unknown';var s=Math.max(0,(Date.now()-new Date(v).getTime())/1000);
    if(s<60)return Math.floor(s)+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';
    if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
  function dur(ms){if(!Number.isFinite(ms)||ms==null)return '-';
    if(ms<1000)return ms+'ms';if(ms<60000)return (ms/1000).toFixed(1)+'s';
    if(ms<3600000)return (ms/60000).toFixed(1)+'m';return (ms/3600000).toFixed(1)+'h'}
  function hours(h){return h>=1?h.toFixed(1)+'h':Math.round(h*60)+'m'}
  function day(iso){var p=String(iso||'').split('-');return p.length===3?p[2]+'/'+p[1]:iso}
  function when(ms){return ms?new Date(ms).toLocaleString():'-'}

  var drawer,scrim,closeBtn,lastFocus=null;
  function mount(){
    drawer=document.getElementById('mx-drawer');
    scrim=document.getElementById('mx-scrim');
    closeBtn=document.getElementById('mx-close');
    if(!drawer)return;
    closeBtn.addEventListener('click',close);
    scrim.addEventListener('click',close);
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&drawer.classList.contains('is-open'))close()});
  }
  function open(kicker,title,html){
    lastFocus=document.activeElement;
    document.getElementById('mx-drawer-kicker').textContent=kicker;
    document.getElementById('mx-drawer-title').textContent=title;
    document.getElementById('mx-drawer-body').innerHTML=html;
    drawer.classList.add('is-open');drawer.setAttribute('aria-hidden','false');
    scrim.hidden=false;closeBtn.focus();
  }
  function close(){
    if(!drawer)return;
    drawer.classList.remove('is-open');drawer.setAttribute('aria-hidden','true');
    scrim.hidden=true;
    if(lastFocus&&lastFocus.focus)lastFocus.focus();
  }
  function body(){return document.getElementById('mx-drawer-body')}

  /** Definition list from [label, value] pairs. Values are escaped. */
  function fields(pairs){
    return '<dl>'+pairs.map(function(f){
      return '<dt>'+esc(f[0])+'</dt><dd>'+esc(f[1])+'</dd>'}).join('')+'</dl>';
  }
  function section(title,html){return '<div><h3>'+esc(title)+'</h3>'+html+'</div>'}

  /** Verdicts carry a colour AND a shape AND a label — never colour alone. */
  var VERDICT={
    'healthy':{label:'Healthy',color:'var(--mx-good)',shape:'circle',
      why:'Output tracks the runtime it spends.'},
    'fragile':{label:'Fragile',color:'var(--mx-warn)',shape:'circle',
      why:'At least 30% of attempts fail.'},
    'zombie':{label:'No real output',color:'var(--mx-serious)',shape:'square',
      why:'Succeeds, runs a minute or more, returns under 25 tokens.'},
    'never-succeeded':{label:'Never succeeded',color:'var(--mx-crit)',shape:'triangle',
      why:'Every recorded attempt failed. Still scheduled.'}
  };
  function verdict(v){return VERDICT[v]||VERDICT.healthy}
  function mark(v,x,y,r){
    var c=verdict(v).color;
    if(verdict(v).shape==='square')
      return '<rect class="mx-mark" x="'+(x-r)+'" y="'+(y-r)+'" width="'+(r*2)+'" height="'+(r*2)+'" rx="2" fill="'+c+'"/>';
    if(verdict(v).shape==='triangle')
      return '<path d="M '+x+' '+(y-r*1.15)+' L '+(x+r*1.1)+' '+(y+r*0.8)+' L '+(x-r*1.1)+' '+(y+r*0.8)+' Z" fill="'+c+'"/>';
    return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+c+'"/>';
  }
  function verdictChip(v){
    var d=verdict(v);
    return '<span class="mx-verdict"><i style="background:'+d.color+'"></i>'+esc(d.label)+'</span>';
  }

  var CAUSE={
    auth:'Authentication / entitlement',
    quota:'Usage limit reached',
    connectivity:'Network or DNS',
    overload:'Provider overloaded',
    timeout:'Ran past its time limit',
    crash:'Runtime crashed',
    misconfig:'Configuration or missing binary',
    other:'Unclassified'
  };
  function causeLabel(id){return CAUSE[id]||id}

  /** Health-strip cards are written by whichever view owns the number, so
   *  the setter lives here rather than in one of them. */
  function setHealth(index,value,kind,label){
    var card=document.querySelectorAll('#mx-health .ax-health-card')[index];
    if(!card)return;
    card.querySelector('.ax-hc-num').textContent=String(value);
    card.querySelector('.ax-hc-dot').className='ax-hc-dot ax-hc-dot--'+kind;
    if(label){var l=card.querySelector('.ax-hc-lbl');if(l)l.textContent=label}
  }

  function get(url){
    return fetch(url,{headers:{Accept:'application/json'}}).then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
  }

  mount();
  return {esc:esc,num:num,plural:plural,pct:pct,age:age,dur:dur,hours:hours,day:day,when:when,
    open:open,close:close,body:body,fields:fields,section:section,
    verdict:verdict,verdictChip:verdictChip,mark:mark,causeLabel:causeLabel,
    setHealth:setHealth,get:get};
})();
</script>`
