// Generates the #2101 mock screens into the folder given as argv[2].
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const out = process.argv[2]
const I = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h4a2 2 0 0 1 2 2v7"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6"/>',
  chart: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>',
  link: '<path d="M7 17 17 7M8 7h9v9"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  ax: '<path d="M4 20 12 4l8 16M7.5 13h9"/>',
}
const ic = (n, s = '') => `<svg class="ic" viewBox="0 0 24 24" ${s}>${I[n]}</svg>`
const doc = (title, theme, body) => `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="mock.css"></head><body>${body}</body></html>`

const sidebar = (cur) => `<aside class="side">
 <div class="tl"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>${ic('ax')}AgentX</b><span style="margin-left:auto" class="muted">${ic('panel')}</span></div>
 <div class="search">${ic('search')} Search requests, agents, runs <span class="mono" style="margin-left:auto">⌘K</span></div>
 <nav class="nav">
  <a class="${cur === 'needs' ? 'cur' : ''}">${ic('inbox')} Needs you <span class="badge" style="background:var(--question);color:#fff">3</span></a>
  <a class="${cur === 'jobs' ? 'cur' : ''}">${ic('list')} Jobs <span class="badge">12</span></a>
  <a>${ic('clock')} Schedules</a>
  <a>${ic('flow')} Workflows</a>
 </nav>
 <div class="grp"><span class="cap">Requests</span><span class="muted">${ic('plus')}</span></div>
 <div class="node">${ic('server')} MacBook-Local <span class="badge">4</span></div>
 <div class="agent"><span class="dot d-work"></span> coder</div>
 <div class="req ${cur === 'thread' ? 'cur' : ''}"><div class="t"><span class="dot d-work"></span> Restyle the phone app</div><div class="s"><span>step 3 of 5 · build</span><span class="mono">4m</span></div></div>
 <div class="req"><div class="t"><span class="dot d-ok"></span> Fix the plan nudge</div><div class="s"><span>done · PR merged</span><span class="mono">2h</span></div></div>
 <div class="agent"><span class="dot d-q"></span> pm</div>
 <div class="req"><div class="t"><span class="dot d-q"></span> Review the design note</div><div class="s"><span>waiting on you</span><span class="mono">12m</span></div></div>
 <div class="agent"><span class="dot d-idle"></span> devops</div>
 <div class="req"><div class="t"><span class="dot d-un"></span> Release 0.251.0</div><div class="s"><span>queued</span><span class="mono">1h</span></div></div>
 <div class="node" style="margin-top:10px">${ic('server')} cloud-server <span class="badge">2</span></div>
 <div class="agent"><span class="dot d-ok"></span> main</div>
 <div class="req"><div class="t"><span class="dot d-ok"></span> Weekly cost report</div><div class="s"><span>done</span><span class="mono">6h</span></div></div>
 <div class="side-foot">${ic('gear')}${ic('users')}${ic('chart')}<span style="margin-left:auto">${ic('bell')}</span></div>
</aside>`
const status = `<div class="status"><span><span class="dot d-work"></span> 3 agents working</span><span><span class="bar"><i style="width:42%"></i></span>queue 42%</span><span>today $4.12 of $20</span><span>2 nodes online</span><span style="margin-left:auto" class="mono">v0.251.0</span></div>`

const thread = `<main class="main">
 <div class="tabs"><div class="tab cur"><span class="dot d-work"></span> Restyle the phone app <span class="muted">×</span></div><div class="tab">${ic('file')} app.ts</div><div class="tab">${ic('plus')}</div></div>
 <div class="thread"><div class="col">
  <div class="me">Restyle the phone app to the new layout, same look as desktop.</div>
  <div class="worked">Worked for 38s ›</div>
  <div class="say">I wrote a 5-step plan. <b>pm</b> reviews the design note, then I build, <b>devops</b> releases.</div>
  <div class="card"><div class="h"><span class="dot d-ok"></span> Step 2 · Review the design note <b>pm</b> ${ic('link')}<span class="r">21:42 ✓</span></div><div class="b">Design note accepted. Build both screens from one style file.</div></div>
  <div class="worked">Worked for 4m 12s ›</div>
  <div class="tool">${ic('file')} Read <span class="mono">src/daemon/ui/tokens.ts</span></div>
  <div class="tool">${ic('file')} Edited <span class="mono">src/daemon/ui/pages/app.ts</span><span style="margin-left:auto;color:var(--ok)" class="mono">+48 −112</span></div>
  <div class="card"><div class="h"><span class="dot d-work"></span> Step 3 · Build desktop and phone restyle <b>coder</b><span class="r">running</span></div><div class="b">Tests 61 of 61 pass. Opening the pull request next.</div></div>
 </div></div>
 <div class="comp"><div class="p">Ask anything, @ to mention an agent, / for commands</div><div class="row">${ic('plus')}<span>coder ▾</span><span style="margin-left:auto">${ic('mic')}</span><span class="send">${ic('up')}</span></div></div>
</main>`
const right = `<aside class="right">
 <div class="rtabs"><span class="cur">Plan</span><span>Proofs</span><span>Files</span><span>Checks</span></div>
 <div class="rsec"><div class="cap" style="margin-bottom:8px">Plan · 5 steps</div>
  <div class="step done"><span class="n">✓</span><div>Design note<div class="muted" style="font-size:12px">dev · note link</div></div></div>
  <div class="step done"><span class="n">✓</span><div>Review of the design note<div class="muted" style="font-size:12px">pm · accepted</div></div></div>
  <div class="step act"><span class="n">3</span><div>Build desktop and phone restyle<div class="muted" style="font-size:12px">coder · due 11-25 18:00</div></div></div>
  <div class="step"><span class="n">4</span><div>Release and install<div class="muted" style="font-size:12px">devops</div></div></div>
  <div class="step"><span class="n">5</span><div>Live check<div class="muted" style="font-size:12px">pm</div></div></div>
 </div>
 <div class="rsec" style="border-top:1px solid var(--border)"><div class="cap" style="margin-bottom:8px">Proofs</div>
  <div class="tool" style="padding:4px 0">${ic('link')} Design note comment</div>
  <div class="tool" style="padding:4px 0">${ic('check')} Tests 61/61</div>
 </div>
</aside>`
writeFileSync(join(out, 'd1-hub-dark.html'), doc('Hub dark', 'dark', `<div class="win">${sidebar('thread')}${thread}${right}${status}</div>`))
writeFileSync(join(out, 'd2-hub-light.html'), doc('Hub light', '', `<div class="win">${sidebar('thread')}${thread}${right}${status}</div>`))

const decs = [
  ['pm', 'd-q', 'Accept the design note for the desktop and phone restyle?', ['Accept', 'Ask for changes']],
  ['devops', 'd-q', 'Release 0.251.0 to both computers tonight?', ['Yes, release', 'Wait']],
  ['sales', 'd-q', 'Send the follow-up email to the lead from Tuesday?', ['Send', 'Edit first', 'Skip']],
]
const needs = `<main class="main"><div class="pagehead">${ic('inbox')} Needs you <span class="badge">3</span></div>
 <div class="set" style="max-width:760px">${decs.map(([a, d, q, acts]) => `<div class="dec"><div class="who"><span class="dot ${d}"></span><b style="color:var(--fg)">${a}</b> asks · 12m ago</div><div class="q">${q}</div><div class="acts">${acts.map((x, i) => `<button class="btn ${i === 0 ? 'primary' : i === acts.length - 1 ? 'ghost' : ''}">${x}</button>`).join('')}</div></div>`).join('')}</div></main>`
writeFileSync(join(out, 'd3-needs-you.html'), doc('Needs you', 'dark', `<div class="win page">${sidebar('needs')}${needs}${status}</div>`))

const row = (l, s, c) => `<div class="sr"><div class="l">${l}${s ? `<small>${s}</small>` : ''}</div>${c}</div>`
const settings = `<main class="main"><div class="pagehead">${ic('gear')} Settings</div><div class="set">
 <div><h2>Appearance</h2><div class="sg">${row('Theme', 'Follows the computer unless you pick one.', '<span class="sel">System ▾</span>')}${row('Text size', '', '<span class="sel">14 px ▾</span>')}${row('Compact lists', 'Smaller rows in the sidebar.', '<span class="sw off"></span>')}</div></div>
 <div><h2>Notifications</h2><div class="sg">${row('Desk cards', 'Ask me on the phone when an agent needs a decision.', '<span class="sw"></span>')}${row('Quiet hours', '22:00 to 07:00', '<span class="sel">On ▾</span>')}</div></div>
 <div><h2>Agents</h2><div class="sg">${row('Default agent', '', '<span class="sel">devops ▾</span>')}${row('Daily cost limit', 'Agents stop and ask when it is reached.', '<span class="sel">$20 ▾</span>')}</div></div>
</div></main>`
writeFileSync(join(out, 'd4-settings.html'), doc('Settings', '', `<div class="win page">${sidebar('')}${settings}${status}</div>`))

const sb = `<div class="sb"><span>9:41</span><span>●●● ▮</span></div>`
const bnav = (cur) => `<div class="bnav">${[['chat', 'Chat'], ['list', 'Requests'], ['inbox', 'Desk'], ['bell', 'Alerts'], ['users', 'Fleet']].map(([i, l]) => `<div class="${cur === l ? 'cur' : ''}">${ic(i)}${l}${l === 'Desk' ? '<span class="pip">3</span>' : ''}</div>`).join('')}</div>`
const p1 = `<div class="phone">${sb}<div class="ph"><span class="rb">${ic('back')}</span><div class="c"><b>Restyle the phone app</b><small><span class="dot d-work"></span> coder · step 3 of 5</small></div><span class="rb">${ic('more')}</span></div>
 <div class="ptabs"><span class="cur"><span class="dot d-work"></span> Chat</span><span>Plan</span><span>Proofs</span><span>Files</span></div>
 <div class="pbody"><div class="me">Restyle the phone app to the new layout, same look as desktop.</div>
  <div class="worked" style="font-size:12px">Worked for 38s ›</div>
  <div class="say">I wrote a 5-step plan. <b>pm</b> reviews the design note, then I build.</div>
  <div class="card"><div class="h" style="font-size:12px"><span class="dot d-ok"></span> Step 2 · <b>pm</b><span class="r">21:42</span></div><div class="b" style="font-size:13px">Design note accepted. Build both screens from one style file.</div></div>
  <div class="tool" style="font-size:12px">${ic('file')} Edited <span class="mono">app.ts</span><span style="margin-left:auto;color:var(--ok)" class="mono">+48 −112</span></div>
  <div class="card"><div class="h" style="font-size:12px"><span class="dot d-work"></span> Step 3 · <b>coder</b><span class="r">running</span></div><div class="b" style="font-size:13px">Tests 61 of 61 pass. Opening the pull request next.</div></div>
 </div>
 <div class="pcomp"><div class="p">Ask anything, @ to mention an agent</div><div class="row"><span class="rb" style="width:28px;height:28px">${ic('plus')}</span><span>coder ▾</span><span style="margin-left:auto">${ic('mic')}</span><span class="send">${ic('up')}</span></div></div>${bnav('Chat')}</div>`
writeFileSync(join(out, 'p1-chat-dark.html'), doc('Phone chat', 'dark', p1))

const pr = (d, t, s, r) => `<div class="prow"><span class="dot ${d}" style="margin-top:6px"></span><div class="m"><b>${t}</b><small>${s}</small></div><span class="r mono">${r}</span></div>`
const p2 = `<div class="phone">${sb}<div class="ph"><span class="rb">${ic('search')}</span><div class="c"><b>Requests</b><small>6 open · 2 computers</small></div><span class="rb">${ic('plus')}</span></div>
 <div class="pbody list"><div class="node">${ic('server')} MacBook-Local <span class="badge">4</span></div>
 ${pr('d-work', 'Restyle the phone app', 'coder · step 3 of 5 · build', '4m')}${pr('d-q', 'Review the design note', 'pm · waiting on you', '12m')}${pr('d-un', 'Release 0.251.0', 'devops · queued', '1h')}${pr('d-ok', 'Fix the plan nudge', 'coder · done', '2h')}
 <div class="node">${ic('server')} cloud-server <span class="badge">2</span></div>${pr('d-ok', 'Weekly cost report', 'main · done', '6h')}${pr('d-work', 'Check the client site', 'main · step 1 of 2', '9m')}
 </div>${bnav('Requests')}</div>`
writeFileSync(join(out, 'p2-requests-light.html'), doc('Phone requests', '', p2))

const p3 = `<div class="phone">${sb}<div class="ph"><span class="rb">${ic('inbox')}</span><div class="c"><b>Desk</b><small>3 need you</small></div><span class="rb">${ic('more')}</span></div>
 <div class="pbody">${decs.map(([a, d, q, acts]) => `<div class="dec" style="padding:14px"><div class="who"><span class="dot ${d}"></span><b style="color:var(--fg)">${a}</b> · 12m</div><div class="q" style="font-size:14px">${q}</div><div class="acts">${acts.map((x, i) => `<button class="btn ${i === 0 ? 'primary' : i === acts.length - 1 ? 'ghost' : ''}">${x}</button>`).join('')}</div></div>`).join('')}</div>${bnav('Desk')}</div>`
writeFileSync(join(out, 'p3-desk-dark.html'), doc('Phone desk', 'dark', p3))
console.log('ok')
