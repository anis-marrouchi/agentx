// --- /activity — what happened, as opposed to what to do -------------------
//
// The monitor answers "what needs me". This answers "what ran, where, and
// what did it decide". They are different questions and they get different
// pages: crowding both onto one screen wins neither.
//
// One substrate, several lane keys. Nothing is recomputed when the
// perspective changes — the runs are already in the browser, only the lane
// they hang from changes, so switching is instant and always consistent.

import { renderShell, type TopbarPeer } from ".."
import { injectFns } from "../inject"
import { buildTimeline, computeBands, packTracks } from "../../activity-timeline"

const ICON: Record<string, string> = {
  refresh: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V5M9 14h.01M15 14h.01"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mesh: '<circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><circle cx="12" cy="5" r="2.5"/><path d="M7 17.5l4-10M17 17.5l-4-10"/>',
  route: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
}
const svg = (d: string, s = 14) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" width="' + s + '" height="' + s + '" aria-hidden="true">' + d + "</svg>"

const PERSPECTIVES: Array<[string, string, string]> = [
  ["agent", "Agent", ICON.bot],
  ["client", "Client", ICON.user],
  ["project", "Project", ICON.folder],
  ["channel", "Channel", ICON.route],
  ["node", "Node", ICON.mesh],
]

export function renderActivityPage(opts: { peers?: TopbarPeer[] } = {}): string {
  return renderShell({
    title: "AgentX · Activity", activeTab: "activity", subtitle: "Activity", peers: opts.peers,
    body: `<div class="ac">

<div class="ac-head">
  <div>
    <div class="ac-kicker">Operations</div>
    <h1>What ran, where, and what it decided</h1>
    <p class="ac-sub">Every run on the mesh, from task traces. The axis breaks over silence &mdash; quiet stretches are labelled, not drawn.</p>
  </div>
  <div class="ac-tools">
    <div class="ac-seg" id="hours" role="radiogroup" aria-label="Window">
      ${[["6", "6h"], ["24", "24h"], ["72", "3d"], ["168", "7d"]].map(([v, t], i) =>
        `<button type="button" role="radio" data-value="${v}" aria-checked="${i === 1}"${i === 1 ? ' class="is-on"' : ""}>${t}</button>`).join("")}
    </div>
    <button class="ax-btn ax-btn--sm" id="refresh">${svg(ICON.refresh, 13)} Refresh</button>
  </div>
</div>

<div class="ac-bar">
  <span class="ac-lbl">Lanes by</span>
  <div class="ac-seg" id="persp" role="radiogroup" aria-label="Perspective">
    ${PERSPECTIVES.map(([v, t, ic], i) =>
      `<button type="button" role="radio" data-value="${v}" aria-checked="${i === 0}"${i === 0 ? ' class="is-on"' : ""}>${svg(ic, 13)}${t}</button>`).join("")}
  </div>
  <div class="ac-key">
    <span class="ac-k"><i class="ac-d ac-d--decision"></i>decision</span>
    <span class="ac-k"><i class="ac-d ac-d--warning"></i>warning</span>
    <span class="ac-k"><i class="ac-d ac-d--recommendation"></i>friction</span>
    <span class="ac-k"><i class="ac-d ac-d--later"></i>do later</span>
    <span class="ac-k">${svg(ICON.x, 11)}canceled</span>
  </div>
</div>

<p id="notice" role="status" aria-live="polite"></p>
<div id="tl" class="ac-tl"></div>
<div id="detail"></div>

</div>`,
    css: ACTIVITY_CSS,
    scripts: `<script>${injectFns({ computeBands, packTracks, buildTimeline })}` +
      `const ICON = ${JSON.stringify(ICON)};${ACTIVITY_SCRIPT}</script>`,
  })
}

export const ACTIVITY_CSS = `
.ac{max-width:1440px;margin:0 auto;padding:22px 24px 48px}
.ac :focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px;border-radius:4px}
.ac-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:14px}
.ac-kicker{font-family:var(--ax-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;
  color:var(--ax-text-2);font-weight:600}
.ac h1{font-size:22px;font-weight:600;letter-spacing:-0.015em;margin:5px 0 0}
.ac-sub{font-size:13px;color:var(--ax-text-2);margin:5px 0 0;max-width:66ch;line-height:1.5}
.ac-tools{display:flex;align-items:center;gap:10px;flex:none;padding-top:6px}
.ac-bar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:var(--ax-surface);
  border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-lg);
  padding:11px 16px;box-shadow:var(--ax-shadow);margin-bottom:14px}
.ac-lbl{font-family:var(--ax-mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;
  color:var(--ax-text-2);font-weight:600}
.ac-seg{display:flex;border:var(--ax-border-w) solid var(--ax-border-2);border-radius:var(--ax-radius);
  overflow:hidden;background:var(--ax-bg)}
.ac-seg button{background:transparent;border:none;border-right:1px solid var(--ax-border);
  color:var(--ax-text-2);font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;cursor:pointer;
  white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.ac-seg button:last-child{border-right:none}
.ac-seg button:hover{color:var(--ax-text);background:var(--ax-surface-2)}
.ac-seg button.is-on{background:var(--ax-blue-t);color:var(--ax-blue-d)}
.ac-key{display:flex;align-items:center;gap:13px;margin-left:auto;flex-wrap:wrap}
.ac-k{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ax-text-2)}
.ac-d{width:9px;height:9px;flex:none}
.ac-d--decision{background:var(--ax-blue-d);transform:rotate(45deg)}
.ac-d--warning{background:var(--ax-amber-ink);clip-path:polygon(50% 0,100% 100%,0 100%)}
.ac-d--recommendation{background:var(--ax-green-d);border-radius:50%}
.ac-d--later{border:2px solid var(--ax-text-2);border-radius:2px}

.ac-tl{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);box-shadow:var(--ax-shadow);overflow:hidden}
.ac-row{display:flex;align-items:stretch;border-bottom:1px solid var(--ax-border);position:relative}
.ac-row:last-child{border-bottom:none}
.ac-row--hd{background:var(--ax-surface-2);border-bottom:var(--ax-border-w) solid var(--ax-border)}
.ac-gut{width:186px;flex:none;display:flex;align-items:center;gap:9px;padding:8px 12px;
  border-right:var(--ax-border-w) solid var(--ax-border);min-width:0}
.ac-gut b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.ac-gut i{font-style:normal;font-family:var(--ax-mono);font-size:10px;color:var(--ax-text-2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.ac-bands{flex:1;display:flex;min-width:0}
.ac-band{position:relative;min-width:0}
.ac-band--hd{display:flex;align-items:center;justify-content:center;font-family:var(--ax-mono);
  font-size:10px;color:var(--ax-text-2);font-weight:600;padding:7px 0}
.ac-gap{width:44px;flex:none;
  background-image:repeating-linear-gradient(45deg,var(--ax-surface-2) 0 3px,transparent 3px 7px)}
.ac-gap--hd{display:flex;align-items:center;justify-content:center;background-image:none;
  border-left:1px dashed var(--ax-border-2);border-right:1px dashed var(--ax-border-2);
  font-family:var(--ax-mono);font-size:9px;color:var(--ax-text-2);font-weight:600}
.ac-run{position:absolute;height:20px;border-radius:5px;background:var(--ax-blue);
  border:1px solid var(--ax-blue-d);cursor:pointer;padding:0}
.ac-run:hover{filter:brightness(1.08)}
.ac-run.is-sel{outline:2px solid var(--ax-text);outline-offset:1px}
.ac-run--failed{background:var(--ax-red);border-color:var(--ax-red-ink)}
.ac-run--canceled{background:transparent;border:1.5px dashed var(--ax-red-ink);height:14px;margin-top:3px}
.ac-run--running{background:var(--ax-green);border-color:var(--ax-green-d)}
.ac-mk{position:absolute;top:1px;width:9px;height:9px;transform:translateX(-50%);pointer-events:none}
.ac-empty{padding:40px;text-align:center;color:var(--ax-text-2);font-size:13px}

.ac-det{margin-top:14px;background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);box-shadow:var(--ax-shadow);padding:15px 17px}
.ac-det__h{display:flex;align-items:center;gap:9px;margin-bottom:11px;flex-wrap:wrap}
.ac-det__t{font-size:14px;font-weight:600}
.ac-kv{display:grid;grid-template-columns:80px minmax(0,1fr);gap:5px 12px;font-size:12.5px}
.ac-kv dt{font-family:var(--ax-mono);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;
  color:var(--ax-text-2);font-weight:600;padding-top:2px}
.ac-kv dd{margin:0;color:var(--ax-text);min-width:0;overflow-wrap:anywhere}
.ac-find{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--ax-border);
  font-size:12.5px;line-height:1.45}
.ac-chip{display:inline-flex;align-items:center;gap:5px;border-radius:var(--ax-radius-pill);padding:2px 9px;
  font-size:11.5px;font-weight:600;border:1px solid var(--ax-border-2);background:var(--ax-surface-2);
  color:var(--ax-text-2)}
#notice{margin:0 0 12px;font-size:12.5px;color:var(--ax-text-2)}
#notice:not(:empty){padding:9px 13px;border-radius:var(--ax-radius-sm);background:var(--ax-surface-2);
  border:var(--ax-border-w) solid var(--ax-border)}
@media (max-width:900px){.ac-gut{width:120px}.ac-key{display:none}}
`

export const ACTIVITY_SCRIPT = String.raw`
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ic=(n,s)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="'+(s||14)+'" height="'+(s||14)+'" aria-hidden="true">'+ICON[n]+'</svg>';
let runs=[],marks=[],persp='agent',hours='24',selected=null,busy=false;

function fmtDur(ms){if(!ms)return '0s';if(ms<1000)return ms+'ms';const s=Math.round(ms/1000);
if(s<60)return s+'s';const m=Math.floor(s/60);return m+'m '+(s%60)+'s';}
function fmtGap(ms){const m=Math.round(ms/60000);if(m<60)return m+'m';const h=Math.floor(m/60);
return h+'h'+(m%60?' '+(m%60)+'m':'');}
function clock(ms){return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}

/* The lane a run hangs from. Only this changes between perspectives — the
   runs themselves are already loaded, so switching never refetches. */
function lane(r){
if(persp==='agent')return {key:r.agentId+'|'+(r.channel||''),label:r.agentId,sub:r.channel||''};
if(persp==='client')return {key:r.clientId||'unmapped',label:r.clientId||'unmapped',sub:''};
if(persp==='project')return {key:r.project||('('+(r.channel||'none')+')'),label:r.project||('no project'),sub:r.channel||''};
if(persp==='channel')return {key:r.channel||'none',label:r.channel||'none',sub:''};
return {key:r.node||'this node',label:r.node||'this node',sub:''};
}

function render(){
if(!runs.length){$('tl').innerHTML='<div class="ac-empty">Nothing ran in this window.</div>';$('detail').innerHTML='';return;}
const t=buildTimeline(runs.map(r=>{const l=lane(r);
 return {id:r.id,laneKey:l.key,laneLabel:l.label,laneSub:l.sub,startedAt:r.startedAt,
  durationMs:r.durationMs||0,status:r.status,label:r.preview||''};}),marks);
const cells=(inner)=>t.bands.map((b,i)=>
 (i?'<div class="ac-gap'+inner.gapCls+'">'+(inner.gap?fmtGap(t.gaps[i-1]):'')+'</div>':'')
 +'<div class="ac-band'+inner.cls+'" style="flex:'+b.weight.toFixed(4)+'">'+inner.body(b,i)+'</div>').join('');

let html='<div class="ac-row ac-row--hd"><div class="ac-gut"><i>'+t.lanes.length+' lanes &middot; '+runs.length+' runs</i></div>'
 +'<div class="ac-bands">'+cells({cls:' ac-band--hd',gapCls:' ac-gap--hd',gap:true,
   body:b=>clock(b.from)+' &ndash; '+clock(b.to)})+'</div></div>';

for(const ln of t.lanes){
 const h=10+ln.tracks*24;
 html+='<div class="ac-row" style="height:'+h+'px"><div class="ac-gut"><span style="min-width:0"><b>'+esc(ln.label)+'</b>'
  +(ln.sub?'<i>'+esc(ln.sub)+'</i>':'')+'</span></div><div class="ac-bands">'
  +cells({cls:'',gapCls:'',gap:false,body:(b,bi)=>ln.runs.filter(r=>r.band===bi).map(r=>{
    const top=5+r.track*24;
    const cls=r.status==='failed'?' ac-run--failed':r.status==='canceled'?' ac-run--canceled'
      :(r.status==='running'||r.status==='in-flight')?' ac-run--running':'';
    const mk=r.marks.map(m=>'<span class="ac-mk ac-d ac-d--'+m.kind+'" style="left:'+r.left.toFixed(3)+'%;top:'+(top-11)+'px"></span>').join('');
    return mk+'<button class="ac-run'+cls+(selected===r.id?' is-sel':'')+'" data-run="'+esc(r.id)+'"'
     +' style="left:'+r.left.toFixed(3)+'%;width:'+r.width.toFixed(3)+'%;top:'+top+'px"'
     +' title="'+esc(r.laneLabel+' · '+clock(r.startedAt)+' · '+fmtDur(r.durationMs))+'"></button>';
   }).join('')})
  +'</div></div>';
}
$('tl').innerHTML=html;
$('tl').querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>{selected=b.dataset.run;render();detail();});
detail();
}

const KIND={decision:'Decision taken for you',warning:'Warning',recommendation:'Avoidable round trip',later:'For later'};
function detail(){
const r=runs.find(x=>x.id===selected);
if(!r){$('detail').innerHTML='';return;}
const found=marks.filter(m=>m.runId===r.id);
$('detail').innerHTML='<div class="ac-det"><div class="ac-det__h">'
 +'<span class="ac-det__t">'+esc(r.preview||'(no prompt recorded)')+'</span>'
 +'<span class="ac-chip">'+esc(r.status)+'</span></div>'
 +'<dl class="ac-kv">'
 +'<dt>When</dt><dd>'+clock(r.startedAt)+' &middot; took '+fmtDur(r.durationMs||0)+'</dd>'
 +'<dt>Who</dt><dd>'+esc(r.agentId)+(r.node?' on '+esc(r.node):'')+'</dd>'
 +'<dt>Where</dt><dd>'+esc(r.channel||'&mdash;')+(r.chatId?' &middot; '+esc(r.chatId):'')+'</dd>'
 +'<dt>For</dt><dd>'+esc(r.clientId||'unmapped')+'</dd></dl>'
 +(found.length?found.map(m=>'<div class="ac-find"><i class="ac-d ac-d--'+m.kind+'" style="margin-top:4px"></i>'
   +'<span><b>'+esc(KIND[m.kind]||m.kind)+'.</b> '+esc(m.text)+'</span></div>').join('')
   :'<div class="ac-find" style="color:var(--ax-text-2)">No review findings for this run.</div>')
 +'</div>';
}

async function load(){
if(busy)return;busy=true;$('refresh').disabled=true;
try{
 const r=await fetch('/api/monitor');if(!r.ok)throw Error('HTTP '+r.status);
 const nodes=(await r.json()).nodes.filter(n=>n.ok);
 runs=[];marks=[];
 for(const n of nodes){
  try{
   const a=await fetch('/api/monitor/activity?node='+encodeURIComponent(n.url)+'&hours='+hours);
   if(!a.ok)continue;
   const d=await a.json();
   for(const run of d.runs||[])runs.push({...run,node:d.node||n.name});
   for(const m of d.marks||[])marks.push(m);
  }catch{}
 }
 $('notice').textContent='';
 render();
}catch(e){$('notice').textContent=e.message;}
finally{busy=false;$('refresh').disabled=false;}
}

function paint(id,v){for(const b of $(id).children){const on=b.dataset.value===v;
b.classList.toggle('is-on',on);b.setAttribute('aria-checked',String(on));}}
$('persp').addEventListener('click',e=>{const b=e.target.closest('button[data-value]');if(!b)return;
persp=b.dataset.value;paint('persp',persp);selected=null;render();});
$('hours').addEventListener('click',e=>{const b=e.target.closest('button[data-value]');if(!b)return;
hours=b.dataset.value;paint('hours',hours);load();});
$('refresh').onclick=load;
load();
`
