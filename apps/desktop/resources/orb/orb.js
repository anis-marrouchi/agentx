// The orb page (#2265): hold the orb (or the talk key) to talk, let go to
// send. It records here, shows the words as they come, and plays the answer;
// the app (orb-voice.ts) writes the words down, sends them and reads the
// answer, and tells this page what to show.
//
// Live words (Hakim C11): while recording, the whole take so far goes for a
// rolling pass every 2.5 s, one at a time (the next waits for the app's
// answer to the last, matched by pass id), and only for the first 30 s; past that the pill shows the level
// meter and the final pass writes it all down on release. The numbers are
// LIVE_WORDS_* in src/orb-flow.ts; keep both in step.
//
// For screenshots and checks the state can also come from the address:
// orb.html?state=thinking&title=…&text=…&level=0.6
"use strict"
;(() => {
  const STATES = ["idle", "listening", "thinking", "speaking", "callback"]
  const CAP_MS = 30000
  const EVERY_MS = 2500
  const MAX_MS = 120000
  const bridge = window.agentxOrb || null
  const $ = (id) => document.getElementById(id)
  const stage = $("stage")
  const orb = $("orb")
  let shown = { state: "idle" }

  /** @param {{state?: string, title?: string, text?: string, unread?: number, level?: number}} s */
  function render(s) {
    shown = s
    const state = STATES.includes(s.state) ? s.state : "idle"
    stage.dataset.state = state
    $("title").textContent = s.title || ""
    $("text").textContent = s.text || ""
    $("pill").hidden = !s.title && !s.text
    $("actions").hidden = state !== "callback"
    const unread = Math.max(0, Math.floor(Number(s.unread) || 0))
    $("unread").hidden = unread === 0
    $("unread").textContent = unread > 99 ? "99+" : String(unread)
    const label = { callback: "Answer the call", speaking: "Stop", thinking: "Stop" }[state] || "Hold to talk"
    orb.setAttribute("aria-label", label)
    orb.title = label
    if (s.level !== undefined) level(s.level)
    fit()
  }
  function level(v) {
    document.documentElement.style.setProperty("--level", String(Math.min(1, Math.max(0, Number(v) || 0))))
  }

  // The window takes the size of what is shown, no more (transparent space
  // would still catch clicks meant for the apps beneath).
  function fit() {
    if (!bridge) return
    const r = stage.getBoundingClientRect()
    bridge.resize(Math.ceil(r.width), Math.ceil(r.height))
  }

  // --- Recording ---
  let rec = null // { mr, stream, chunks, t0, lastPass, busy, ctx, raf, timer, stopped }
  let wanted = false // held now; a release before the microphone opened cancels
  let opening = false // the microphone is being opened (getUserMedia not settled)

  function meterOf(stream, onLevel) {
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Uint8Array(an.fftSize)
    let raf = 0
    const tick = () => {
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return { ctx, stop: () => (cancelAnimationFrame(raf), ctx.close().catch(() => {})) }
  }

  function take() {
    const type = (rec && rec.mr.mimeType) || "audio/webm"
    return new Blob(rec.chunks, { type })
  }

  async function startTalk() {
    if (rec || wanted) return
    wanted = true
    if (opening) {
      // Pressed again while the microphone still opens: that take goes on.
      render({ state: "listening", text: "" })
      return
    }
    stopPlaying(false)
    bridge?.begin()
    render({ state: "listening", text: "" })
    let stream
    opening = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      opening = false
      wanted = false
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError")
      render({ state: "idle", title: denied ? "The microphone is blocked" : "Could not open the microphone", text: denied ? "Allow AgentX in the system's privacy settings." : "" })
      setTimeout(() => shown.state === "idle" && render({ state: "idle" }), 6000)
      return
    }
    opening = false
    if (!wanted) {
      // B1: let go before the microphone opened (on macOS the first time,
      // while the permission prompt is up): nothing was recorded. Close the
      // stream, end the turn begun above, and rest.
      stream.getTracks().forEach((t) => t.stop())
      bridge?.cancel()
      render({ state: "idle" })
      return
    }
    const mr = new MediaRecorder(stream)
    rec = { mr, stream, chunks: [], t0: Date.now(), lastPass: Date.now(), busy: 0, meter: null, timer: 0, words: "" }
    mr.ondataavailable = (e) => e.data && e.data.size && rec && rec.chunks.push(e.data)
    mr.start(500)
    rec.meter = meterOf(stream, (v) => {
      level(v)
      if (rec) maybePass()
    })
    rec.timer = setTimeout(() => stopTalk(), MAX_MS)
  }

  // C11: one pass at a time, every 2.5 s at most, only under the cap.
  function maybePass() {
    const ms = Date.now() - rec.t0
    if (ms > CAP_MS) {
      if (!rec.capped) {
        rec.capped = true
        render({ state: "listening", text: rec.words ? rec.words + " …" : "Still listening…" })
      }
      return
    }
    if (rec.busy || Date.now() - rec.lastPass < EVERY_MS || !rec.chunks.length || !bridge) return
    // rec.busy holds the id of the pass asked for; the app answers each id once.
    const id = ++passIds
    rec.busy = id
    rec.lastPass = Date.now()
    const r = rec
    take()
      .arrayBuffer()
      .then((buf) => bridge.partial(buf, r.mr.mimeType || "audio/webm", ms, id))
      .catch(() => {
        // N6: the take could not be read: free the next pass.
        if (r.busy === id) r.busy = 0
      })
  }
  let passIds = 0
  bridge?.onPartial((text, id) => {
    // An answer to an older pass (or an older take) is not this one's.
    if (!rec || rec.busy !== id) return
    rec.busy = 0
    if (text && !rec.capped) {
      rec.words = text
      render({ state: "listening", text })
    }
  })

  function stopTalk() {
    const held = wanted
    wanted = false
    if (!rec) {
      // B1: let go while the microphone still opens: rest now; startTalk
      // closes the stream and ends the turn when it settles.
      if (held && opening) render({ state: "idle" })
      return
    }
    const r = rec
    rec = null
    clearTimeout(r.timer)
    r.meter?.stop()
    level(0)
    const ms = Date.now() - r.t0
    r.mr.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || "audio/webm" })
      if (!bridge) return render({ state: "idle" })
      blob
        .arrayBuffer()
        .then((buf) => bridge.final(buf, blob.type, ms))
        .catch(() => {
          // N6: the take could not be read (nothing went to the app): say so.
          render({ state: "idle", title: "Could not read the recording", text: "Try again." })
          setTimeout(() => shown.state === "idle" && render({ state: "idle" }), 6000)
        })
    }
    r.mr.stop()
    render({ state: "thinking", text: r.words || "Writing it down…" })
  }

  // --- Playing the answer ---
  let player = null // { audio?, meter?, url? }

  function stopPlaying(tell) {
    if (player) {
      player.audio?.pause()
      player.meter?.stop()
      if (player.url) URL.revokeObjectURL(player.url)
      player = null
    }
    if (window.speechSynthesis) speechSynthesis.cancel()
    level(0)
    if (tell) bridge?.cancel()
  }

  bridge?.onPlay((p) => {
    stopPlaying(false)
    const done = () => {
      stopPlaying(false)
      bridge?.played()
    }
    if (p.audio) {
      const url = URL.createObjectURL(new Blob([p.audio], { type: p.type || "audio/mpeg" }))
      const audio = new Audio(url)
      player = { audio, url, meter: null }
      audio.onended = done
      audio.onerror = done
      try {
        const ctx = new AudioContext()
        const an = ctx.createAnalyser()
        const src = ctx.createMediaElementSource(audio)
        src.connect(an)
        an.connect(ctx.destination)
        const buf = new Uint8Array(an.fftSize)
        let raf = 0
        const tick = () => {
          an.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2
          level(Math.min(1, Math.sqrt(sum / buf.length) * 4))
          raf = requestAnimationFrame(tick)
        }
        tick()
        player.meter = { stop: () => (cancelAnimationFrame(raf), ctx.close().catch(() => {})) }
      } catch {
        // No meter: the bars still move on their own.
      }
      audio.play().catch(done)
      return
    }
    if (p.text && window.speechSynthesis && window.SpeechSynthesisUtterance) {
      const u = new SpeechSynthesisUtterance(p.text)
      u.onend = done
      u.onerror = done
      player = {}
      speechSynthesis.speak(u)
      return
    }
    done()
  })

  // --- The orb: hold to talk, drag to move, tap to stop ---
  // A move of more than 4 px drags the window; a press in idle records until
  // release; a press while the agent works or speaks stops it.
  let press = null
  orb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    orb.setPointerCapture(e.pointerId)
    const before = stage.dataset.state
    press = { x: e.screenX, y: e.screenY, dragging: false, before, holding: false }
    bridge?.dragStart()
    if (before === "speaking" || before === "thinking") {
      stopPlaying(true)
      press.stopped = true
      return
    }
    if (before === "idle") {
      // Talk only once it is clearly a hold, not the start of a drag.
      press.holdTimer = setTimeout(() => {
        if (press && !press.dragging) {
          press.holding = true
          startTalk()
        }
      }, 150)
    }
  })
  orb.addEventListener("pointermove", (e) => {
    if (!press) return
    const dx = e.screenX - press.x
    const dy = e.screenY - press.y
    if (!press.dragging && !press.holding && Math.hypot(dx, dy) > 4) {
      press.dragging = true
      clearTimeout(press.holdTimer)
    }
    if (press.dragging) bridge?.dragMove(dx, dy)
  })
  const release = () => {
    if (!press) return
    clearTimeout(press.holdTimer)
    if (press.holding) stopTalk()
    bridge?.dragEnd()
    press = null
  }
  orb.addEventListener("pointerup", release)
  orb.addEventListener("pointercancel", release)

  // Space or Enter on the focused orb: hold to talk, the keyboard way; Escape stops.
  orb.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault()
      const s = stage.dataset.state
      if (s === "speaking" || s === "thinking") stopPlaying(true)
      else if (s === "idle") startTalk()
    } else if (e.key === "Escape") {
      stopPlaying(true)
    }
  })
  orb.addEventListener("keyup", (e) => {
    if ((e.key === " " || e.key === "Enter") && (rec || wanted)) stopTalk()
  })

  // The talk key from the app (global-key.ts): hold mode gives start then
  // stop; press-twice gives the same two edges on two presses.
  bridge?.onTalk((edge) => (edge === "start" ? startTalk() : stopTalk()))

  const q = new URLSearchParams(location.search)
  render({ state: q.get("state") || "idle", title: q.get("title") || "", text: q.get("text") || "", unread: Number(q.get("unread")) || 0, level: Number(q.get("level")) || 0 })
  bridge?.onState(render)
})()
