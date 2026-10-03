// --- Phone app: Chat's message log ---
//
// Loaded before APP_CHAT_SCRIPT, which calls window.AXChatLog once with the
// log element and gets back the helpers that draw bubbles: the user's
// messages (and follow-ups waiting to be sent), the agent's answers with
// their tools, files and agentx:ui extras, and a whole saved conversation.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_LOG_SCRIPT = `
window.AXChatLog = function (o) {
  var V = o.V, log = o.log, empty = o.empty, NOTES = o.notes;
  function scrollDown() { var m = log; if (m) m.scrollTop = m.scrollHeight; }
  function clear() { log.innerHTML = ''; empty.hidden = false; }
  function bubble(cls) {
    var el = document.createElement('div');
    el.className = 'cx-msg ' + cls;
    log.appendChild(el);
    empty.hidden = true;
    return el;
  }
  // A newer message ends the quick replies of the answers above it.
  function userMsg(text) { V.retire(log); var el = bubble('cx-user'); el.textContent = text; return el; }
  // A follow-up that waits for the agent to finish.
  function queuedMsg(text) { var q = userMsg(text); q.classList.add('cx-queued'); return { text: text, el: q }; }
  function agentMsg() {
    V.retire(log);
    var el = bubble('cx-agent');
    el.innerHTML = '<div class="md cx-typing">Thinking…</div><div class="cx-files"></div><div class="cx-ui"></div><p class="cx-note" hidden></p>';
    return el;
  }
  function setBody(el, text) { el.replaceChild(V.md(text), el.querySelector('.md')); }
  function setNote(el, text, bad) {
    var n = el.querySelector('.cx-note');
    n.hidden = !text; n.textContent = text || ''; n.className = 'cx-note' + (bad ? ' cx-bad' : '');
  }
  function renderUi(el, ui) { V.renderUi(el.querySelector('.cx-ui'), ui, o.send); }
  function renderFiles(el, files) { V.renderFiles(el.querySelector('.cx-files'), files); }
  // Returns the bubble a running turn streams into, or null.
  function renderConversation(conv) {
    clear();
    (conv.messages || []).forEach(function (m) {
      if (m.role === 'user') { userMsg(m.content); return; }
      var el = agentMsg();
      setBody(el, m.content || '');
      V.setTools(el, m.tools);
      renderFiles(el, m.files);
      renderUi(el, m.ui);
      if (m.status && m.status !== 'done') setNote(el, m.error || NOTES[m.status] || '', m.status === 'error');
    });
    var live = null;
    if (conv.running) {
      // What the agent has written so far; the live stream carries on from it.
      live = agentMsg();
      if (conv.partial && conv.partial.text) setBody(live, V.preview(conv.partial.text, conv.partial.plain));
      V.setTools(live, conv.partial && conv.partial.tools);
      setNote(live, NOTES.running);
    }
    // Follow-ups typed while it answers stay below, waiting to be sent.
    o.queue().forEach(function (x) { log.appendChild(x.el); });
    scrollDown();
    return live;
  }
  function flash(text) {
    var el = bubble('cx-agent');
    el.innerHTML = '<p class="cx-note cx-bad"></p>';
    el.firstChild.textContent = text;
    scrollDown();
  }
  return { scrollDown: scrollDown, clear: clear, userMsg: userMsg, queuedMsg: queuedMsg, agentMsg: agentMsg, setBody: setBody,
    setNote: setNote, renderUi: renderUi, renderFiles: renderFiles, renderConversation: renderConversation, flash: flash };
};
`
