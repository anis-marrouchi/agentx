// --- Phone app: the Live sheet (#2103 PR B) ---
//
// Vanilla browser JS inlined into /app (app.ts), after the Fleet script.
// Opened from a running task's "Watch" button on the Activity tab
// (app-fleet.client.ts) as window.AXLive.open(task). It follows the task
// through GET /api/app/tasks/stream: step names, state and the latest text,
// each cut to 160 characters by the server. Send and Stop go through the
// existing POST /api/app/tasks/{followup,cancel}. Stop needs a second tap.
//
// fetch, not EventSource: EventSource hides the status, and a 403 (live
// control off) or 404 (task ended) must show as words, not a silent retry.
// A dropped stream is retried once, then the sheet says it lost the
// connection.
//
// Uses liveSseFrames, liveReduce and liveLabel (app-live-logic.ts, injected).
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_LIVE_SCRIPT = `
(function () {
  var sheet = document.createElement('dialog');
  sheet.className = 'fx-sheet lv-sheet';
  sheet.setAttribute('aria-labelledby', 'lv-title');
  sheet.innerHTML = '<form method="dialog"><div class="fx-row"><h3 id="lv-title"></h3><span id="lv-age" class="fx-muted"></span></div>' +
    '<p id="lv-where" class="fx-muted"></p>' +
    '<p id="lv-ask" class="lv-ask"></p>' +
    '<p id="lv-state" class="ax-af-state lv-state" role="status" aria-live="polite"></p>' +
    '<p id="lv-text" class="lv-text"></p>' +
    '<p id="lv-more" class="fx-muted" hidden></p>' +
    '<label id="lv-field"><span>Send to the agent</span><textarea id="lv-input" rows="2"></textarea></label>' +
    '<p id="lv-error" class="fx-error" role="alert"></p>' +
    '<div class="fx-actions"><button value="close" class="fx-btn" formnovalidate>Close</button>' +
    '<button type="button" id="lv-stop" class="fx-btn fx-danger-o">Stop</button>' +
    '<button type="button" id="lv-send" class="fx-btn fx-primary">Send</button></div></form>';
  document.body.appendChild(sheet);
  if (window.AXSheet) window.AXSheet(sheet);

  var $ = function (id) { return document.getElementById(id); };
  var task = null, view = null, ctl = null, retried = false, stopArmed = 0, gen = 0;

  function fresh() { return { phase: 'connecting', step: '', steps: 0, text: '', final: '', more: '' }; }
  function draw() {
    $('lv-state').textContent = liveLabel(view);
    var st = { running: 'running', done: 'done', failed: 'error', lost: 'error' }[view.phase];
    if (st) $('lv-state').setAttribute('data-state', st); else $('lv-state').removeAttribute('data-state');
    var over = view.phase === 'done' || view.phase === 'failed' || view.phase === 'ended';
    $('lv-text').textContent = over ? (view.final || view.text || '') : view.text;
    $('lv-more').hidden = !(over && view.more && view.phase !== 'ended');
    $('lv-more').textContent = view.more;
    $('lv-field').hidden = over || view.phase === 'lost';
    $('lv-send').hidden = over || view.phase === 'lost';
    $('lv-stop').hidden = over || view.phase === 'lost';
  }
  function api(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; }); });
  }

  function connect(my) {
    ctl = new AbortController();
    var q = '?taskId=' + encodeURIComponent(task.taskId) + '&agentId=' + encodeURIComponent(task.agentId);
    fetch('/api/app/tasks/stream' + q, { credentials: 'same-origin', signal: ctl.signal }).then(function (r) {
      if (my !== gen) return;
      if (!r.ok || !r.body) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (my !== gen) return;
          if (r.status === 404) { view = liveReduce(view, 'end', { state: 'ended' }); draw(); return; }
          view.phase = 'lost'; draw();
          $('lv-error').textContent = b.error || ('Could not follow this task (HTTP ' + r.status + ').');
        });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (x) {
          if (my !== gen) return;
          if (x.done) return dropped(my);
          var out = liveSseFrames(buf + dec.decode(x.value, { stream: true }));
          buf = out.rest;
          out.frames.forEach(function (f) {
            var d = {}; try { d = JSON.parse(f.data); } catch (e) { return; }
            view = liveReduce(view, f.event, d);
          });
          draw();
          return pump();
        });
      }
      return pump();
    }).catch(function () { if (my === gen) dropped(my); });
  }
  function dropped(my) {
    if (view.phase === 'done' || view.phase === 'failed' || view.phase === 'ended') return;
    if (!retried) { retried = true; view.phase = 'connecting'; draw(); setTimeout(function () { if (my === gen) connect(my); }, 1500); return; }
    view.phase = 'lost'; draw();
  }

  function open(t) {
    gen++;
    if (ctl) try { ctl.abort(); } catch (e) {}
    task = t; view = fresh(); retried = false; stopArmed = 0;
    $('lv-title').textContent = t.agentName;
    $('lv-where').textContent = t.nodeName + ' · ' + t.channel;
    $('lv-ask').textContent = t.preview || '';
    $('lv-input').value = '';
    $('lv-error').textContent = '';
    $('lv-stop').textContent = 'Stop';
    draw();
    if (sheet.showModal) sheet.showModal();
    connect(gen);
  }
  sheet.addEventListener('close', function () { gen++; if (ctl) try { ctl.abort(); } catch (e) {} });

  $('lv-send').addEventListener('click', function () {
    var text = $('lv-input').value.trim();
    if (!text) { $('lv-input').focus(); return; }
    $('lv-error').textContent = '';
    $('lv-send').disabled = true;
    api('/api/app/tasks/followup', { taskId: task.taskId, message: text }).then(function () {
      $('lv-input').value = '';
      $('lv-error').textContent = 'Sent. The agent reads it after the current step.';
    }).catch(function (e) { $('lv-error').textContent = e.message; })
      .then(function () { $('lv-send').disabled = false; });
  });
  // Stop asks once more: the first tap arms it for 4 seconds.
  $('lv-stop').addEventListener('click', function () {
    if (!stopArmed || Date.now() - stopArmed > 4000) {
      stopArmed = Date.now();
      $('lv-stop').textContent = 'Tap again to stop';
      setTimeout(function () { if (stopArmed && Date.now() - stopArmed >= 4000) { stopArmed = 0; $('lv-stop').textContent = 'Stop'; } }, 4100);
      return;
    }
    stopArmed = 0;
    $('lv-stop').disabled = true;
    api('/api/app/tasks/cancel', { taskId: task.taskId }).then(function () {
      $('lv-stop').textContent = 'Stopped';
    }).catch(function (e) { $('lv-error').textContent = e.message; $('lv-stop').textContent = 'Stop'; })
      .then(function () { $('lv-stop').disabled = false; });
  });

  window.AXLive = { open: open };
})();
`

export const APP_LIVE_CSS = `
.lv-ask { color: var(--ax-text); }
.lv-state { margin: 8px 0 4px; }
.lv-text { min-height: 2.9em; white-space: normal; overflow-wrap: anywhere; color: var(--ax-text-2); }
`
