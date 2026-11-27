// The orb page: shows one of the five states, sizes its window to what it
// shows, and lets the person drag the orb or hold it to talk.
//
// State comes from the app (window.agentxOrb, orb-preload.ts) and, for
// screenshots and checks, from the address: orb.html?state=thinking&text=…
// The live feed of states and words is PR 3 of #2265.
"use strict"
;(() => {
  const STATES = ["idle", "listening", "thinking", "speaking", "callback"]
  const bridge = window.agentxOrb || null
  const $ = (id) => document.getElementById(id)
  const stage = $("stage")
  const orb = $("orb")

  /** @param {{state?: string, title?: string, text?: string, unread?: number, level?: number}} s */
  function render(s) {
    const state = STATES.includes(s.state) ? s.state : "idle"
    stage.dataset.state = state
    $("title").textContent = s.title || ""
    $("text").textContent = s.text || ""
    $("pill").hidden = !s.title && !s.text
    $("actions").hidden = state !== "callback"
    const unread = Math.max(0, Math.floor(Number(s.unread) || 0))
    $("unread").hidden = unread === 0
    $("unread").textContent = unread > 99 ? "99+" : String(unread)
    orb.setAttribute("aria-label", state === "callback" ? "Answer the call" : "Hold to talk")
    document.documentElement.style.setProperty("--level", String(Math.min(1, Math.max(0, Number(s.level) || 0))))
    fit()
  }

  // The window takes the size of what is shown, no more (transparent space
  // would still catch clicks meant for the apps beneath).
  function fit() {
    if (!bridge) return
    const r = stage.getBoundingClientRect()
    bridge.resize(Math.ceil(r.width), Math.ceil(r.height))
  }

  // Press on the orb: a move of more than 4 px drags the window; otherwise
  // it is a hold, shown as listening until release.
  let press = null
  orb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    orb.setPointerCapture(e.pointerId)
    press = { x: e.screenX, y: e.screenY, dragging: false, before: stage.dataset.state }
    bridge?.dragStart()
    if (press.before === "idle") stage.dataset.state = "listening"
  })
  orb.addEventListener("pointermove", (e) => {
    if (!press) return
    const dx = e.screenX - press.x
    const dy = e.screenY - press.y
    if (!press.dragging && Math.hypot(dx, dy) > 4) {
      press.dragging = true
      stage.dataset.state = press.before
    }
    if (press.dragging) bridge?.dragMove(dx, dy)
  })
  const release = () => {
    if (!press) return
    if (!press.dragging) stage.dataset.state = press.before
    bridge?.dragEnd()
    press = null
  }
  orb.addEventListener("pointerup", release)
  orb.addEventListener("pointercancel", release)

  // Space or Enter on the focused orb: hold to talk, the keyboard way.
  orb.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat && stage.dataset.state === "idle") stage.dataset.state = "listening"
  })
  orb.addEventListener("keyup", (e) => {
    if ((e.key === " " || e.key === "Enter") && stage.dataset.state === "listening") stage.dataset.state = "idle"
  })

  const q = new URLSearchParams(location.search)
  render({ state: q.get("state") || "idle", title: q.get("title") || "", text: q.get("text") || "", unread: Number(q.get("unread")) || 0, level: Number(q.get("level")) || 0 })
  bridge?.onState(render)
})()
