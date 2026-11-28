// --- Phone app: the Chat tab's Plan and Proofs (#2101 phone C1) ---
//
// What the tabs under the Chat header show, as the Hub chat header does
// (wall-chat-head.client.ts): Plan lists the steps of the requests the
// agent has or has a step in, and who has each; Proofs lists the steps done
// with their proof link. The rows come from GET /api/app/requests
// (app-requests.ts). Both functions are shipped to the page as their own
// text (inject.ts), so they call nothing outside themselves.

import type { AppReq } from "../../app-requests"

/** Plan: each request's summary, then its steps numbered, done and active marked. */
export function appPlanHtml(items: AppReq[], who: string, esc: (s: unknown) => string): string {
  const reqs = (items || []).filter((r) => r.steps && r.steps.length)
  if (!reqs.length) return '<p class="chp-empty">' + esc(who) + " has no plan on an open request.</p>"
  return reqs.map((r) => {
    const steps = r.steps.map((s) => {
      const st = s.state === "done" ? "is-done" : s.state === "active" ? "is-active" : s.state === "blocked" ? "is-blocked" : ""
      const by = s.agentId ? s.agentId + (s.state ? " · " + s.state : "") : s.state || ""
      return '<li class="' + st + '"><span class="chp-no">' + (st === "is-done" ? "✓" : esc(s.idx)) + "</span><span><b>" + esc(s.name) + "</b>" + (by ? "<small>" + esc(by) + "</small>" : "") + "</span></li>"
    }).join("")
    return '<section class="chp-req"><h3>' + esc(r.summary || r.id) + "</h3><ol>" + steps + "</ol></section>"
  }).join("")
}

/** Proofs: every step done, with its proof as a link when it is one. */
export function appProofsHtml(items: AppReq[], who: string, esc: (s: unknown) => string): string {
  const rows: string[] = []
  for (const r of items || []) {
    for (const s of r.steps || []) {
      if (s.state !== "done") continue
      const ev = String(s.evidence || "")
      const proof = /^https?:[/][/]/.test(ev)
        ? '<a href="' + esc(ev) + '" target="_blank" rel="noopener">' + esc(ev) + "</a>"
        : ev ? "<span>" + esc(ev) + "</span>" : '<span class="chp-none">No proof given</span>'
      rows.push("<li><b>" + esc(s.name) + "</b><small>" + esc(r.summary || r.id) + "</small>" + proof + "</li>")
    }
  }
  if (!rows.length) return '<p class="chp-empty">No step of ' + esc(who) + "'s open requests is done yet.</p>"
  return '<ul class="chp-proofs">' + rows.join("") + "</ul>"
}
