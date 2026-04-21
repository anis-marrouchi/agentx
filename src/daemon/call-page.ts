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
  const botName = qs.get("bot") || null;  // e.g. ?bot=atlas → invite server-side bot

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Multi-peer state. For a pair call there's one entry (the human). When a
  // server-side bot joins, a second entry is added whose `isPrimary=false`
  // so we don't overwrite the remote video with the bot's (silent) stream.
  let state = null; // { es, localStream, cfg, primary, callId, peers: Map<name, {pc, isPrimary}> }

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

  /** Build an RTCPeerConnection for a specific remote peer. Primary peer
   *  drives the remote video tile; non-primary peers (bots) just receive. */
  function createPeer(peerName, isPrimary) {
    const pc = new RTCPeerConnection({ iceServers: state.cfg.iceServers });
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    pc.ontrack = (ev) => {
      if (isPrimary) {
        $("remote").srcObject = ev.streams[0];
        $("remoteLabel").textContent = peerName;
      }
      log("track from " + peerName + (isPrimary ? " (primary)" : " (bot)"), "ok");
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      sendSignal({
        kind: "ice",
        callId: state.callId, from: state.cfg.localName, to: peerName,
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        },
      });
    };
    pc.onconnectionstatechange = () => {
      log("pc[" + peerName + "] state: " + pc.connectionState);
    };
    state.peers.set(peerName, { pc, isPrimary });
    return pc;
  }

  async function handleInboundSignal(sig) {
    if (sig.callId !== state.callId) return;
    if (sig.kind === "hangup") {
      log("<- hangup from " + sig.from, "err");
      teardown();
      return;
    }
    // Find or lazy-create the PC for this remote.
    let entry = state.peers.get(sig.from);
    if (!entry && sig.kind === "offer") {
      // New peer offering — create a non-primary PC. The `to` field in the
      // signal is us; we treat the sender as a new peer. Only an offer can
      // introduce a new peer; answer/ice without a PC is a stale signal.
      log("new peer offering: " + sig.from);
      createPeer(sig.from, /* isPrimary */ false);
      entry = state.peers.get(sig.from);
    }
    if (!entry) {
      log("signal from unknown peer " + sig.from + " kind=" + sig.kind + " (dropped)", "err");
      return;
    }
    const { pc } = entry;
    try {
      if (sig.kind === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await sendSignal({ kind: "answer", callId: state.callId, from: state.cfg.localName, to: sig.from, sdp: ans.sdp });
        log("<- offer from " + sig.from + " → answered");
      } else if (sig.kind === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
        log("<- answer from " + sig.from);
      } else if (sig.kind === "ice") {
        await pc.addIceCandidate(sig.candidate);
      }
    } catch (err) {
      log(sig.kind + " handling error from " + sig.from + ": " + err.message, "err");
    }
  }

  async function join(e) {
    e?.preventDefault();
    const cfg = state?.cfg || await loadConfig();
    if (!cfg) return;

    const to = $("to").value.trim();
    const callId = $("callId").value.trim();
    if (!to || !callId) return;

    log("joining call " + callId + " with peer=" + to + (botName ? " + bot=" + botName : ""));

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (err) {
      log("getUserMedia failed: " + err.message, "err");
      return;
    }
    $("local").srcObject = localStream;

    state = { cfg, localStream, callId, primary: to, peers: new Map(), es: null };

    // Subscribe to inbound signals BEFORE sending any offer so we don't miss
    // the answer or ICE candidates from the callee. The broker's 30s buffer
    // also covers late subscribes.
    const esUrl = "/webrtc/events?callId=" + encodeURIComponent(callId) + "&as=" + encodeURIComponent(cfg.localName);
    const es = new EventSource(esUrl);
    state.es = es;
    es.addEventListener("signal", (evt) => {
      let sig; try { sig = JSON.parse(evt.data); } catch { return; }
      handleInboundSignal(sig);
    });
    es.addEventListener("ready", () => log("signaling SSE ready", "ok"));
    es.onerror = () => log("signaling SSE error (will reconnect)", "err");

    // Create the primary PC to the human peer.
    const primaryPc = createPeer(to, /* isPrimary */ true);

    // Deterministic caller role between us and the human peer. If we're
    // smaller, we offer; otherwise we wait for the offer (handled in
    // handleInboundSignal).
    const isCaller = norm(cfg.localName) < norm(to);
    log(isCaller ? "role: caller (will offer to " + to + ")" : "role: callee (waiting for offer from " + to + ")");
    if (isCaller) {
      await sendSignal({ kind: "ring", callId, from: cfg.localName, to });
      try {
        const offer = await primaryPc.createOffer();
        await primaryPc.setLocalDescription(offer);
        await sendSignal({ kind: "offer", callId, from: cfg.localName, to, sdp: offer.sdp });
        log("-> offer sent to " + to, "ok");
      } catch (err) {
        log("offer failed: " + err.message, "err");
      }
    }

    // If a bot is requested, ask this daemon to spawn it. The bot will join
    // as a separate peer; the existing signal handler creates its PC when
    // its offer arrives.
    if (botName) {
      try {
        const r = await fetch("/webrtc/bot/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId, target: cfg.localName, agentId: botName }),
        });
        if (r.ok) log("bot '" + botName + "' invited", "ok");
        else log("bot invite failed: " + r.status, "err");
      } catch (err) {
        log("bot invite error: " + err.message, "err");
      }
    }

    $("joinBtn").disabled = true;
    $("hangupBtn").disabled = false;
  }

  function teardown() {
    if (!state) return;
    for (const { pc } of state.peers.values()) { try { pc.close(); } catch {} }
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
    // Send hangup to every active peer (human + any bots).
    for (const peerName of state.peers.keys()) {
      try {
        await sendSignal({ kind: "hangup", callId: state.callId, from: state.cfg.localName, to: peerName });
      } catch { /* best effort */ }
    }
    log("-> hangup sent to " + state.peers.size + " peer(s)");
    teardown();
  }

  $("form").addEventListener("submit", join);
  $("hangupBtn").addEventListener("click", hangup);
  loadConfig();
})();
</script>
</body>
</html>`;
