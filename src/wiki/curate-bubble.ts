// --- The floating chat bubble on a wiki page (#818) ---
//
// A circle at the bottom-right corner. Tapping it opens a chat scoped to
// the page that is open: the page is fixed here, so the owner's
// instruction needs no page name. Talks to /api/wiki/curate (served by
// the daemon, proxied by the dashboard). Vanilla JS, no build step.

export interface BubblePage {
  /** The wiki the page lives in (agent id). */
  agentId: string
  /** Page file inside that wiki. */
  path: string
  title: string
}

const CSS = `
.wc-root{--wc-bg:#fff;--wc-ink:#1b1f1e;--wc-muted:#5d6664;--wc-edge:#d9dedc;--wc-soft:#f3f5f4;--wc-accent:#2f6fde;--wc-on-accent:#fff;--wc-add:#e6f4ea;--wc-add-ink:#1e6b34;--wc-del:#fbe9e9;--wc-del-ink:#9b2c2c;
  font:14px/1.45 'IBM Plex Sans',system-ui,-apple-system,sans-serif;color:var(--wc-ink)}
[data-theme=dark] .wc-root{--wc-bg:#181c1b;--wc-ink:#e9eeec;--wc-muted:#a3adab;--wc-edge:#2c3331;--wc-soft:#1f2422;--wc-accent:#6b9cff;--wc-on-accent:#0b1020;--wc-add:#173823;--wc-add-ink:#9be3b0;--wc-del:#3b1d1d;--wc-del-ink:#f3a9a9}
.wc-fab{position:fixed;right:20px;bottom:20px;z-index:9990;width:52px;height:52px;border-radius:50%;border:0;background:var(--wc-accent);color:var(--wc-on-accent);box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer;display:grid;place-items:center}
.wc-fab:focus-visible,.wc-root button:focus-visible,.wc-root textarea:focus-visible{outline:3px solid var(--wc-accent);outline-offset:2px}
.wc-fab svg{width:24px;height:24px}
.wc-panel{position:fixed;right:20px;bottom:84px;z-index:9991;width:min(400px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 110px));display:flex;flex-direction:column;background:var(--wc-bg);border:1px solid var(--wc-edge);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.25);overflow:hidden}
.wc-panel[hidden],.wc-fab[hidden]{display:none}
.wc-head{display:flex;align-items:flex-start;gap:8px;padding:12px 14px;border-bottom:1px solid var(--wc-edge)}
.wc-head h2{margin:0;font-size:15px}
.wc-head p{margin:2px 0 0;color:var(--wc-muted);font-size:12px;word-break:break-word}
.wc-x{margin-left:auto;background:none;border:0;color:var(--wc-muted);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}
.wc-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.wc-empty{color:var(--wc-muted);font-size:13px}
.wc-msg{max-width:92%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.wc-owner{align-self:flex-end;background:var(--wc-accent);color:var(--wc-on-accent)}
.wc-agent{align-self:flex-start;background:var(--wc-soft)}
.wc-error{border:1px solid var(--wc-del-ink)}
.wc-who{display:block;font-size:11px;color:var(--wc-muted);margin-bottom:2px}
.wc-edit{margin-top:8px;padding-top:8px;border-top:1px solid var(--wc-edge);white-space:normal;font-size:13px}
.wc-edit details{margin:6px 0}
.wc-diff{margin:6px 0 0;padding:6px;max-height:220px;overflow:auto;background:var(--wc-bg);border:1px solid var(--wc-edge);border-radius:8px;font:12px/1.4 'IBM Plex Mono',ui-monospace,monospace;white-space:pre-wrap}
.wc-diff .a{display:block;background:var(--wc-add);color:var(--wc-add-ink)}
.wc-diff .d{display:block;background:var(--wc-del);color:var(--wc-del-ink);text-decoration:line-through}
.wc-diff .c{display:block;color:var(--wc-muted)}
.wc-src{margin:4px 0 0;padding-left:18px}
.wc-src a{color:var(--wc-accent)}
.wc-warn{color:var(--wc-del-ink)}
.wc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.wc-btn{border:1px solid var(--wc-edge);background:var(--wc-bg);color:var(--wc-ink);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
.wc-form{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--wc-edge)}
.wc-form textarea{flex:1;resize:none;min-height:40px;max-height:140px;padding:8px 10px;border:1px solid var(--wc-edge);border-radius:10px;background:var(--wc-bg);color:var(--wc-ink);font:inherit}
.wc-send{border:0;border-radius:10px;padding:0 14px;background:var(--wc-accent);color:var(--wc-on-accent);font:inherit;font-weight:600;cursor:pointer}
.wc-send:disabled{opacity:.5;cursor:default}
.wc-dots::after{content:'…';animation:wc-blink 1.2s steps(4) infinite}
@keyframes wc-blink{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'…'}}
@media (max-width:600px){.wc-panel{right:8px;left:8px;bottom:80px;width:auto;max-height:calc(100vh - 100px)}.wc-fab{right:14px;bottom:14px}}
@media (prefers-reduced-motion:reduce){.wc-dots::after{animation:none;content:'…'}}
`

// Runs in the browser. Reads its page from #wc-data.
const SCRIPT = `
(function(){
  var root=document.getElementById('wc-root'); if(!root) return;
  var cfg=JSON.parse(document.getElementById('wc-data').textContent);
  var fab=root.querySelector('.wc-fab'), panel=root.querySelector('.wc-panel'), log=root.querySelector('.wc-log');
  var form=root.querySelector('.wc-form'), input=form.querySelector('textarea'), send=form.querySelector('.wc-send');
  var sub=root.querySelector('.wc-sub'), timer=null, busy=false, openKey='wc-open:'+cfg.agent+'/'+cfg.path;
  function q(){return cfg.endpoint+'?agent='+encodeURIComponent(cfg.agent)+'&path='+encodeURIComponent(cfg.path)}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function isUrl(s){return /^https?:\\/\\/\\S+$/.test(s.split(/\\s/)[0])}
  function setOpen(o){panel.hidden=!o;fab.setAttribute('aria-expanded',String(o));try{sessionStorage.setItem(openKey,o?'1':'')}catch(e){}
    if(o){load();setTimeout(function(){input.focus()},0)}else{stop();fab.focus()}}
  function stop(){if(timer){clearTimeout(timer);timer=null}}
  function api(method,url,body){return fetch(url,{method:method,headers:{'Content-Type':'application/json'},credentials:'same-origin',body:body?JSON.stringify(body):undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})}
  function render(state){
    sub.textContent=(state.curator||'The agent')+' edits “'+(state.title||cfg.title)+'”'+(state.readOnly?' · read-only copy':'');
    log.textContent='';
    var msgs=state.messages||[];
    if(!msgs.length){log.appendChild(el('p','wc-empty','Tell the agent what to do with this page, for example “find their contact details” or “rewrite the summary”. Every change is saved as a new version you can restore.'))}
    msgs.forEach(function(m){
      var b=el('div','wc-msg '+(m.role==='owner'?'wc-owner':'wc-agent')+(m.status==='error'?' wc-error':''));
      if(m.role==='agent'){b.appendChild(el('span','wc-who',m.agent||'agent'))}
      if(m.status==='pending'){var p=el('span','wc-dots','Working');b.appendChild(p)}
      else b.appendChild(document.createTextNode(m.text));
      if(m.edit&&(m.edit.added||m.edit.removed)){
        var e=el('div','wc-edit');
        e.appendChild(el('strong',null,'Page changed: +'+m.edit.added+' / −'+m.edit.removed+' lines'+(m.edit.restored?' (restored)':'')));
        var d=el('details');d.appendChild(el('summary',null,'What changed'));
        var pre=el('div','wc-diff');
        (m.edit.diff||[]).forEach(function(l){pre.appendChild(el('span',l.op==='+'?'a':l.op==='-'?'d':'c',(l.op===' '?'  ':l.op+' ')+l.text))});
        d.appendChild(pre);e.appendChild(d);
        if(m.edit.sources&&m.edit.sources.length){
          e.appendChild(el('span',null,'Sources'));var ul=el('ul','wc-src');
          m.edit.sources.forEach(function(s){var li=el('li');if(isUrl(s)){var a=el('a',null,s);a.href=s.split(/\\s/)[0];a.target='_blank';a.rel='noopener noreferrer';li.appendChild(a)}else li.textContent=s;ul.appendChild(li)});
          e.appendChild(ul);
        } else e.appendChild(el('div','wc-warn','No sources were cited for this change.'));
        var acts=el('div','wc-actions');
        var show=el('button','wc-btn','Show the updated page');show.type='button';show.onclick=function(){location.reload()};acts.appendChild(show);
        if(m.edit.version&&!m.edit.restored&&!state.readOnly){var r=el('button','wc-btn','Restore the previous version');r.type='button';
          r.onclick=function(){if(!confirm('Put the page back as it was before this change?'))return;r.disabled=true;
            api('POST',cfg.endpoint+'/restore',{agent:cfg.agent,path:cfg.path,version:m.edit.version}).then(function(){location.reload()}).catch(function(err){r.disabled=false;alert(err.message)})};
          acts.appendChild(r)}
        e.appendChild(acts);b.appendChild(e);
      }
      log.appendChild(b);
    });
    busy=msgs.some(function(m){return m.status==='pending'});
    send.disabled=busy||state.readOnly||state.enabled===false;
    input.disabled=!!state.readOnly||state.enabled===false;
    if(state.enabled===false)log.appendChild(el('p','wc-empty','The page curator is turned off.'));
    log.scrollTop=log.scrollHeight;
    stop();if(busy&&!panel.hidden)timer=setTimeout(load,2000);
  }
  function load(){api('GET',q()).then(render).catch(function(err){log.textContent='';log.appendChild(el('p','wc-warn','Could not reach the agent: '+err.message))})}
  fab.addEventListener('click',function(){setOpen(panel.hidden)});
  root.querySelector('.wc-x').addEventListener('click',function(){setOpen(false)});
  panel.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();setOpen(false)}});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit()}});
  form.addEventListener('submit',function(e){e.preventDefault();var t=input.value.trim();if(!t||busy)return;send.disabled=true;
    api('POST',cfg.endpoint,{agent:cfg.agent,path:cfg.path,message:t}).then(function(){input.value='';load()}).catch(function(err){send.disabled=false;alert(err.message)})});
  // Shown only when the daemon says the curator is on for this page.
  api('GET',q()).then(function(state){if(state.enabled===false)return;fab.hidden=false;
    try{if(sessionStorage.getItem(openKey))setOpen(true)}catch(e){}}).catch(function(){});
})();
`

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M12 8.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>`

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

/** Markup, style and script for the bubble, inserted before </body>. */
export function curatorBubble(page: BubblePage, endpoint = "/api/wiki/curate"): string {
  // JSON inside <script> must not close the tag.
  const data = JSON.stringify({ agent: page.agentId, path: page.path, title: page.title, endpoint }).replace(/</g, "\\u003c")
  return `<style>${CSS}</style>
<div class="wc-root" id="wc-root">
<button class="wc-fab" type="button" hidden aria-label="Ask an agent to curate this page" aria-expanded="false" aria-controls="wc-panel" title="Curate this page">${ICON}</button>
<section class="wc-panel" id="wc-panel" role="dialog" aria-label="Curate this page" hidden>
<div class="wc-head"><div><h2>Curate this page</h2><p class="wc-sub">${esc(page.title)}</p></div><button class="wc-x" type="button" aria-label="Close">×</button></div>
<div class="wc-log" aria-live="polite"></div>
<form class="wc-form"><textarea rows="2" aria-label="Instruction for the agent" placeholder="What should change on this page?"></textarea><button class="wc-send" type="submit">Send</button></form>
</section>
</div>
<script type="application/json" id="wc-data">${data}</script>
<script>${SCRIPT}</script>`
}

/** Put the bubble on a rendered page. */
export function withCuratorBubble(html: string, page: BubblePage, endpoint?: string): string {
  const bubble = curatorBubble(page, endpoint)
  return html.includes("</body>") ? html.replace(/<\/body>(?![\s\S]*<\/body>)/, `${bubble}\n</body>`) : html + bubble
}
