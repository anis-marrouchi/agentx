// --- Browser page for P2P A/V calls ---
//
// Served by the daemon at GET /call when channels.webrtc.enabled is true.
// Media flows browser↔browser via WebRTC; agentx only carries the
// SDP/ICE/hangup signals on the control plane.
//
// The page is intentionally framework-free and self-contained so it can be
// served as a single response.

export const CALL_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentX Call</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0e1116; color: #e6edf3; }
    header { padding: 10px 14px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    header h1 { font-size: 15px; margin: 0; font-weight: 600; }
    header .sp { flex: 1; }
    main { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px; }
    video { width: 100%; aspect-ratio: 16 / 9; background: #161b22; border-radius: 6px; object-fit: cover; }
    .tile { position: relative; }
    .tile .label { position: absolute; top: 6px; left: 8px; font-size: 11px; background: rgba(0,0,0,.55); padding: 2px 6px; border-radius: 3px; }
    form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, select, button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 6px 10px; font: inherit; }
    button { cursor: pointer; }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #da3633; border-color: #f85149; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    #log { padding: 8px 14px; max-height: 160px; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; border-top: 1px solid #21262d; color: #8b949e; }
    #log .err { color: #f85149; }
    #log .ok { color: #56d364; }
    .status { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #30363d; }
    .status.ok { background: #1f6f3d; color: #aff5b4; }
    .status.err { background: #6e2b2b; color: #ffabab; }
  </style>
</head>
<body>
  <header>
    <h1>AgentX&nbsp;/&nbsp;P2P Call</h1>
    <span id="selfName" class="status">…</span>
    <span class="sp"></span>
    <form id="form">
      <input id="to" placeholder="peer name" required autocomplete="off" />
      <input id="callId" placeholder="call id" required autocomplete="off" />
      <button type="submit" id="joinBtn" class="primary">Join</button>
      <button type="button" id="hangupBtn" class="danger" disabled>Hang up</button>
    </form>
  </header>
  <main>
    <div class="tile"><video id="local" autoplay playsinline muted></video><span class="label">You</span></div>
    <div class="tile"><video id="remote" autoplay playsinline></video><span class="label" id="remoteLabel">Remote</span></div>
  </main>
  <div id="log"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const log = (msg, cls) => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
    $("log").appendChild(line);
    $("log").scrollTop = $("log").scrollHeight;
  };

  const qs = new URLSearchParams(location.search);
  if (qs.get("to")) $("to").value = qs.get("to");
  $("callId").value = qs.get("callId") || Math.random().toString(36).slice(2, 10);

  let state = null; // { pc, es, localStream, iceServers, selfName, to, callId }

  async function loadConfig() {
    const r = await fetch("/webrtc/config");
    if (!r.ok) {
      log("webrtc signaling is not enabled on this daemon (" + r.status + ")", "err");
      $("selfName").textContent = "disabled";
      $("selfName").className = "status err";
      $("joinBtn").disabled = true;
      return null;
    }
    const cfg = await r.json();
    $("selfName").textContent = cfg.localName;
    $("selfName").className = "status ok";
    return cfg;
  }

  async function sendSignal(signal) {
    const r = await fetch("/webrtc/signal/out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signal),
    });
    if (!r.ok) log("send " + signal.kind + " -> " + signal.to + " failed: " + r.status, "err");
  }

  async function join(e) {
    e?.preventDefault();
    const cfg = state?.cfg || await loadConfig();
    if (!cfg) return;

    const to = $("to").value.trim();
    const callId = $("callId").value.trim();
    if (!to || !callId) return;

    log("joining call " + callId + " with peer=" + to);

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (err) {
      log("getUserMedia failed: " + err.message, "err");
      return;
    }
    $("local").srcObject = localStream;

    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.ontrack = (ev) => {
      $("remote").srcObject = ev.streams[0];
      $("remoteLabel").textContent = to;
      log("remote track received", "ok");
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      sendSignal({
        kind: "ice",
        callId, from: cfg.localName, to,
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        },
      });
    };
    pc.onconnectionstatechange = () => {
      log("pc state: " + pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        log("connection " + pc.connectionState, "err");
      }
    };

    // Subscribe to inbound signals BEFORE sending the offer so we don't miss
    // the answer or ICE candidates from the callee.
    const esUrl = "/webrtc/events?callId=" + encodeURIComponent(callId) + "&as=" + encodeURIComponent(cfg.localName);
    const es = new EventSource(esUrl);
    es.addEventListener("signal", async (evt) => {
      let sig; try { sig = JSON.parse(evt.data); } catch { return; }
      if (sig.callId !== callId) return;
      if (sig.kind === "offer") {
        log("<- offer from " + sig.from);
        await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await sendSignal({ kind: "answer", callId, from: cfg.localName, to: sig.from, sdp: ans.sdp });
      } else if (sig.kind === "answer") {
        log("<- answer from " + sig.from);
        await pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
      } else if (sig.kind === "ice") {
        try { await pc.addIceCandidate(sig.candidate); }
        catch (err) { log("addIceCandidate: " + err.message, "err"); }
      } else if (sig.kind === "hangup") {
        log("<- hangup from " + sig.from, "err");
        teardown();
      }
    });
    es.addEventListener("ready", () => log("signaling SSE ready", "ok"));
    es.onerror = () => log("signaling SSE error (will reconnect)", "err");

    // Deterministic caller selection to avoid glare: compare the two peer
    // names lexicographically (normalized — case/punctuation-insensitive) and
    // only the smaller name side sends the offer. The other side waits for
    // the offer to arrive. With the daemon's 30s signal buffer, this still
    // works if the caller joins before the callee.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isCaller = norm(cfg.localName) < norm(to);
    log(isCaller ? "role: caller (will offer)" : "role: callee (waiting for offer)");
    if (isCaller) {
      // Ring first so the callee's channels (Telegram, Slack, ...) light up
      // even if their browser isn't open yet. Ring isn't fanned out over
      // SSE — it's purely an out-of-band notification.
      await sendSignal({ kind: "ring", callId, from: cfg.localName, to });
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ kind: "offer", callId, from: cfg.localName, to, sdp: offer.sdp });
        log("-> offer sent to " + to, "ok");
      } catch (err) {
        log("offer failed: " + err.message, "err");
      }
    }

    state = { pc, es, localStream, cfg, to, callId };
    $("joinBtn").disabled = true;
    $("hangupBtn").disabled = false;
  }

  function teardown() {
    if (!state) return;
    try { state.pc.close(); } catch {}
    try { state.es.close(); } catch {}
    try { state.localStream.getTracks().forEach(t => t.stop()); } catch {}
    $("local").srcObject = null;
    $("remote").srcObject = null;
    $("joinBtn").disabled = false;
    $("hangupBtn").disabled = true;
    state = null;
  }

  async function hangup() {
    if (!state) return;
    await sendSignal({ kind: "hangup", callId: state.callId, from: state.cfg.localName, to: state.to });
    log("-> hangup sent");
    teardown();
  }

  $("form").addEventListener("submit", join);
  $("hangupBtn").addEventListener("click", hangup);
  loadConfig();
})();
</script>
</body>
</html>`;
