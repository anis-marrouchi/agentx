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
/* Open pushes the page over rather than covering it: a drawer that hides the
   rows you are asking about is worse than no drawer. Below 900px there is no
   room to give, so it overlays. */
body.ax-as-open{padding-right:var(--ax-as-w)}
@media (max-width:900px){body.ax-as-open{padding-right:0}}
.ax-as{position:fixed;top:0;right:0;height:100vh;width:var(--ax-as-w);max-width:92vw;z-index:61;
  display:flex;flex-direction:column;background:var(--ax-surface);
  border-left:var(--ax-border-w) solid var(--ax-border);
  transform:translateX(100%);transition:transform 160ms ease}
.ax-as.is-open{transform:translateX(0)}
@media (prefers-reduced-motion:reduce){.ax-as{transition:none}}
.ax-as__grip{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:col-resize;
  background:transparent}
.ax-as__grip:hover,.ax-as__grip:focus-visible{background:var(--ax-accent)}
.ax-as__head{display:flex;align-items:center;gap:8px;padding:12px 14px;
  border-bottom:var(--ax-border-w) solid var(--ax-border)}
.ax-as__title{font-size:13px;font-weight:600;flex:1}
.ax-as__x{background:none;border:none;color:var(--ax-text-2);cursor:pointer;font:inherit;
  font-size:18px;line-height:1;padding:0 4px}
.ax-as__icon{background:var(--ax-surface-2);border:1px solid var(--ax-border-2);color:var(--ax-text-2);
  cursor:pointer;font:inherit;font-size:11.5px;font-weight:600;padding:3px 9px;
  border-radius:var(--ax-radius-pill)}
.ax-as__icon:hover{color:var(--ax-text);background:var(--ax-surface-3)}
.ax-as__icon.is-on{background:var(--ax-blue-t);border-color:var(--ax-blue-e);color:var(--ax-blue-d)}
.ax-as__hist{border-bottom:var(--ax-border-w) solid var(--ax-border);max-height:44vh;overflow:auto}
.ax-as__hist-empty{padding:12px 14px;font-size:12px;color:var(--ax-text-2)}
.ax-as__hist-list{list-style:none;margin:0;padding:0}
.ax-as__hist-list li{display:flex;align-items:center;gap:8px;padding:9px 14px;
  border-bottom:1px solid var(--ax-border);cursor:pointer}
.ax-as__hist-list li:hover{background:var(--ax-surface-2)}
.ax-as__hist-list li.is-on{background:var(--ax-blue-t)}
.ax-as__hist-t{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ax-as__hist-m{font-family:var(--ax-mono);font-size:10.5px;color:var(--ax-text-2);flex:none}
.ax-as__hist-x{background:none;border:none;color:var(--ax-text-2);cursor:pointer;font-size:15px;
  line-height:1;padding:0 2px;flex:none}
.ax-as__pending{opacity:0.75}
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
  <div class="ax-as__grip" id="ax-as-grip" role="separator" aria-orientation="vertical"
       tabindex="0" aria-label="Resize panel — arrow keys adjust"></div>
  <div class="ax-as__head">
    <span class="ax-as__title" id="ax-as-title">Ask an agent</span>
    <button class="ax-as__icon" id="ax-as-hist" title="Past conversations">History</button>
    <button class="ax-as__icon" id="ax-as-new" title="Start a new conversation">New</button>
    <button class="ax-as__x" id="ax-as-close" title="Close">&times;</button>
  </div>
  <div class="ax-as__hist" id="ax-as-hist-panel" hidden>
    <div class="ax-as__hist-empty" id="ax-as-hist-empty">No past conversations yet.</div>
    <ul class="ax-as__hist-list" id="ax-as-hist-list"></ul>
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

const WMIN=320,WMAX=760;
function setWidth(px){
const w=Math.max(WMIN,Math.min(WMAX,Math.round(px)));
document.documentElement.style.setProperty('--ax-as-w',w+'px');
try{localStorage.setItem('ax-assistant-w',String(w))}catch{}
}
try{const w=Number(localStorage.getItem('ax-assistant-w'));if(w)setWidth(w)}catch{}

function open(v){
document.body.classList.toggle('ax-as-open',v);
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
// A page that names itself makes the raw path noise, and tab just
// repeats the nav — so drop both when the page supplies its own name.
const shownCtx={...c};
if(shownCtx.page){delete shownCtx.path;delete shownCtx.tab;}
const bits=Object.entries(shownCtx).filter(([k,v])=>v!=null&&v!=='').slice(0,4)
 .map(([k,v])=>'<code>'+esc(k)+'='+esc(typeof v==='object'?(Array.isArray(v)?v.length+' items':JSON.stringify(v).slice(0,28)):v)+'</code>');
$('ax-as-ctx').innerHTML='Sending with your question: '+(bits.join(' ')||'<code>this page</code>');
}

/* --- Conversation state ---------------------------------------------------
   The thread lives on the daemon; the page only remembers which one it was
   looking at. That is what survives a navigation: a turn started here keeps
   running even after this page is gone, and the answer is waiting in the
   thread when you come back. */
let threadId=null, poll=null;
try{threadId=localStorage.getItem('ax-assistant-thread')||null}catch{}
function setThread(id){
threadId=id;
try{id?localStorage.setItem('ax-assistant-thread',id):localStorage.removeItem('ax-assistant-thread')}catch{}
}

function bubble(m){
const el=document.createElement('div');
const kind=m.role==='user'?'me':(m.status==='error'?'err':'them');
el.className='ax-as__msg ax-as__msg--'+kind+(m.status==='pending'?' ax-as__pending':'');
el.textContent=m.status==='pending'?'Thinking…':(m.content||'(no reply)');
return el;
}
function renderMessages(msgs){
const log=$('ax-as-log');
log.innerHTML='';
if(!msgs.length){
 log.innerHTML='<p class="ax-as__empty">Ask about what is on this page. What you are looking at &mdash; the page, its filters and the rows in view &mdash; goes with the question.</p>';
 return;
}
for(const m of msgs)log.appendChild(bubble(m));
log.scrollTop=log.scrollHeight;
}

async function loadThread(id,{quiet}={}){
if(!id){renderMessages([]);$('ax-as-title').textContent='Ask an agent';return;}
try{
 const r=await fetch('/api/assistant/thread?id='+encodeURIComponent(id));
 if(!r.ok){setThread(null);renderMessages([]);return;}
 const d=await r.json();
 $('ax-as-title').textContent=d.thread.title||'Ask an agent';
 if(d.thread.agentId)$('ax-as-agent').value=d.thread.agentId;
 renderMessages(d.messages||[]);
 const pending=(d.messages||[]).some(m=>m.status==='pending');
 clearTimeout(poll);
 if(pending)poll=setTimeout(()=>loadThread(id,{quiet:true}),1500);
 else if(!quiet)loadHistory();
}catch(e){}
}

async function loadHistory(){
try{
 const r=await fetch('/api/assistant/threads');
 const d=await r.json();
 const list=d.threads||[];
 $('ax-as-hist-empty').hidden=list.length>0;
 $('ax-as-hist-list').innerHTML=list.map(t=>
  '<li data-thread="'+esc(t.id)+'"'+(t.id===threadId?' class="is-on"':'')+'>'
  +'<span class="ax-as__hist-t">'+esc(t.title)+'</span>'
  +'<span class="ax-as__hist-m">'+esc(t.agentId)+'</span>'
  +'<button class="ax-as__hist-x" data-del="'+esc(t.id)+'" title="Delete">&times;</button></li>').join('');
}catch(e){}
}

$('ax-as-hist').onclick=()=>{
const panel2=$('ax-as-hist-panel');
const show=panel2.hidden;
panel2.hidden=!show;
$('ax-as-hist').classList.toggle('is-on',show);
if(show)loadHistory();
};
$('ax-as-new').onclick=()=>{
setThread(null);renderMessages([]);$('ax-as-title').textContent='Ask an agent';
$('ax-as-hist-panel').hidden=true;$('ax-as-hist').classList.remove('is-on');
$('ax-as-input').focus();
};
$('ax-as-hist-list').addEventListener('click',async e=>{
const del=e.target.closest('[data-del]');
if(del){e.stopPropagation();
 await fetch('/api/assistant/delete',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({threadId:del.dataset.del})});
 if(del.dataset.del===threadId){setThread(null);renderMessages([]);}
 loadHistory();return;}
const li=e.target.closest('[data-thread]');
if(!li)return;
setThread(li.dataset.thread);
$('ax-as-hist-panel').hidden=true;$('ax-as-hist').classList.remove('is-on');
loadThread(threadId);loadHistory();
});

async function send(){
const input=$('ax-as-input'); const text=input.value.trim();
if(!text||busy)return;
const agent=$('ax-as-agent').value;
if(!agent&&!threadId){add('err','Pick an agent first.');return;}
busy=true; $('ax-as-send').disabled=true;
input.value='';
try{
 const r=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({threadId:threadId||undefined,agentId:agent,node:$('ax-as-node').value||undefined,
   message:text,context:pageContext()})});
 const d=await r.json();
 if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));
 setThread(d.threadId);
 await loadThread(d.threadId);
}catch(e){add('err',e.message);}
finally{busy=false;$('ax-as-send').disabled=false;input.focus();}
}

$('ax-as-send').onclick=send;
$('ax-as-input').addEventListener('keydown',e=>{
if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send();}});

/* Restore whatever was in flight when the last page unloaded. */
loadThread(threadId);loadHistory();
})();
`
