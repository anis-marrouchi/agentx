// --- Ask an agent, from wherever you are ----------------------------------
//
// A handle on the right edge of every dashboard page opens a drawer that
// dispatches to an agent on any node in the mesh. What makes it worth having
// over a terminal is context: each page publishes what it is currently
// showing via `window.axPageContext`, and that travels with the message. So
// "why is this stuck?" on the Monitor means the client filter, the bucket
// counts and the visible actions — not a question the agent has to
// interrogate you for.
//
// Pages opt in by assigning window.axPageContext = () => ({ ... }). Pages
// that do not still get the path and tab.

export const ASSISTANT_CSS = `
.ax-as-handle{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:60;
  display:flex;align-items:center;gap:6px;writing-mode:vertical-rl;
  background:var(--ax-surface);color:var(--ax-text);cursor:pointer;
  border:var(--ax-border-w) solid var(--ax-border);border-right:none;
  border-radius:var(--ax-radius) 0 0 var(--ax-radius);padding:14px 7px;
  font:inherit;font-size:12px;font-weight:600;box-shadow:var(--ax-shadow)}
.ax-as-handle:hover{background:var(--ax-surface-2)}
.ax-as{position:fixed;top:0;right:0;height:100vh;width:min(420px,92vw);z-index:61;
  display:flex;flex-direction:column;background:var(--ax-surface);
  border-left:var(--ax-border-w) solid var(--ax-border);
  transform:translateX(100%);transition:transform 160ms ease}
.ax-as.is-open{transform:translateX(0)}
@media (prefers-reduced-motion:reduce){.ax-as{transition:none}}
.ax-as__head{display:flex;align-items:center;gap:8px;padding:12px 14px;
  border-bottom:var(--ax-border-w) solid var(--ax-border)}
.ax-as__title{font-size:13px;font-weight:600;flex:1}
.ax-as__x{background:none;border:none;color:var(--ax-text-2);cursor:pointer;font:inherit;
  font-size:18px;line-height:1;padding:0 4px}
.ax-as__pick{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--ax-border)}
.ax-as__pick select{flex:1;min-width:0;font:inherit;font-size:12px;padding:5px 8px;
  border-radius:var(--ax-radius-sm);border:var(--ax-border-w) solid var(--ax-border-2);
  background:var(--ax-bg);color:var(--ax-text)}
.ax-as__ctx{padding:8px 14px;font-size:11.5px;color:var(--ax-text-2);
  border-bottom:1px solid var(--ax-border);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ax-as__ctx code{font-family:var(--ax-mono);font-size:11px}
.ax-as__log{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.ax-as__msg{font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;
  padding:9px 12px;border-radius:var(--ax-radius);border:var(--ax-border-w) solid var(--ax-border)}
.ax-as__msg--me{background:var(--ax-blue-t);border-color:var(--ax-blue-e);align-self:flex-end;max-width:88%}
.ax-as__msg--them{background:var(--ax-surface-2)}
.ax-as__msg--err{background:var(--ax-red-t);border-color:var(--ax-red-e);color:var(--ax-red-ink)}
.ax-as__empty{color:var(--ax-text-2);font-size:12.5px;line-height:1.5}
.ax-as__foot{padding:10px 14px;border-top:var(--ax-border-w) solid var(--ax-border);
  display:flex;gap:8px;align-items:flex-end}
.ax-as__foot textarea{flex:1;resize:none;font:inherit;font-size:13px;padding:8px 10px;
  min-height:38px;max-height:140px;border-radius:var(--ax-radius-sm);
  border:var(--ax-border-w) solid var(--ax-border-2);background:var(--ax-bg);color:var(--ax-text)}
`

export const ASSISTANT_HTML = `
<button class="ax-as-handle" id="ax-as-handle" aria-expanded="false" aria-controls="ax-as">Ask an agent</button>
<aside class="ax-as" id="ax-as" aria-label="Ask an agent" aria-hidden="true">
  <div class="ax-as__head">
    <span class="ax-as__title">Ask an agent</span>
    <button class="ax-as__x" id="ax-as-close" title="Close">&times;</button>
  </div>
  <div class="ax-as__pick">
    <select id="ax-as-agent" aria-label="Agent"><option value="">Loading agents&hellip;</option></select>
    <select id="ax-as-node" aria-label="Node"><option value="">This node</option></select>
  </div>
  <div class="ax-as__ctx" id="ax-as-ctx"></div>
  <div class="ax-as__log" id="ax-as-log">
    <p class="ax-as__empty">Ask about what is on this page. What you are looking at &mdash; the page, its filters and the rows in view &mdash; goes with the question.</p>
  </div>
  <div class="ax-as__foot">
    <textarea id="ax-as-input" rows="1" placeholder="e.g. why is the Hasanah work stuck?"></textarea>
    <button class="ax-btn ax-btn--primary ax-btn--sm" id="ax-as-send">Send</button>
  </div>
</aside>`

export const ASSISTANT_SCRIPT = String.raw`
(function(){
const $=id=>document.getElementById(id);
const panel=$('ax-as'), handle=$('ax-as-handle');
if(!panel||!handle)return;
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let busy=false;

function open(v){
panel.classList.toggle('is-open',v);
panel.setAttribute('aria-hidden',String(!v));
handle.setAttribute('aria-expanded',String(v));
try{localStorage.setItem('ax-assistant-open',v?'1':'0')}catch{}
if(v){paintCtx();$('ax-as-input').focus();}
}
handle.onclick=()=>open(!panel.classList.contains('is-open'));
$('ax-as-close').onclick=()=>open(false);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.classList.contains('is-open'))open(false);});
try{if(localStorage.getItem('ax-assistant-open')==='1')open(true)}catch{}

/* What the agent is told about where you are. Pages publish their own slice;
   everything else still gets the path, so the question is never contextless. */
function pageContext(){
const base={path:location.pathname,tab:document.querySelector('.ax-topbar__tab.is-active')?.textContent?.trim()||null};
try{ if(typeof window.axPageContext==='function') return {...base,...(window.axPageContext()||{})}; }catch(e){}
return base;
}
function paintCtx(){
const c=pageContext();
const bits=Object.entries(c).filter(([k,v])=>v!=null&&v!=='').slice(0,4)
 .map(([k,v])=>'<code>'+esc(k)+'='+esc(typeof v==='object'?(Array.isArray(v)?v.length+' items':JSON.stringify(v).slice(0,28)):v)+'</code>');
$('ax-as-ctx').innerHTML='Sending with your question: '+(bits.join(' ')||'<code>this page</code>');
}

function add(kind,text){
const log=$('ax-as-log');
const empty=log.querySelector('.ax-as__empty'); if(empty)empty.remove();
const el=document.createElement('div');
el.className='ax-as__msg ax-as__msg--'+kind;
el.textContent=text;
log.appendChild(el); log.scrollTop=log.scrollHeight;
return el;
}

fetch('/api/agents').then(r=>r.json()).then(d=>{
const list=(d.agents||d||[]).map(a=>a.id||a.name).filter(Boolean);
$('ax-as-agent').innerHTML=list.length
 ?list.map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join('')
 :'<option value="">no agents</option>';
}).catch(()=>{$('ax-as-agent').innerHTML='<option value="">agents unavailable</option>';});

fetch('/api/monitor').then(r=>r.json()).then(d=>{
const ns=(d.nodes||[]).filter(n=>n.ok);
if(ns.length>1)$('ax-as-node').innerHTML=ns.map(n=>'<option value="'+esc(n.url)+'">'+esc(n.name)+'</option>').join('');
}).catch(()=>{});

async function send(){
const input=$('ax-as-input'); const text=input.value.trim();
if(!text||busy)return;
const agent=$('ax-as-agent').value;
if(!agent){add('err','Pick an agent first.');return;}
busy=true; $('ax-as-send').disabled=true;
add('me',text); input.value='';
const pending=add('them','Thinking…');
try{
 const r=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({agentId:agent,node:$('ax-as-node').value||undefined,message:text,context:pageContext()})});
 const d=await r.json();
 if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));
 pending.textContent=d.reply||'(no reply)';
}catch(e){pending.className='ax-as__msg ax-as__msg--err';pending.textContent=e.message;}
finally{busy=false;$('ax-as-send').disabled=false;input.focus();}
}
$('ax-as-send').onclick=send;
$('ax-as-input').addEventListener('keydown',e=>{
if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send();}});
})();
`
