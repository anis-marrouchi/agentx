// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import hub from "../dist/hub.js"

const BASE = "http://127.0.0.1:4202"

test("dashboard URL: env, default, and bad values", () => {
  assert.equal(hub.dashboardUrl({}), BASE)
  assert.equal(hub.dashboardUrl({ AGENTX_DASHBOARD_URL: "http://localhost:5000/" }), "http://localhost:5000")
  assert.equal(hub.dashboardUrl({ AGENTX_DASHBOARD_URL: "file:///etc/passwd" }), BASE)
  assert.equal(hub.dashboardUrl({ AGENTX_DASHBOARD_URL: "not a url" }), BASE)
  assert.equal(hub.hubUrl(BASE), BASE + "/hub")
})

test("only the dashboard's own origin stays in the window", () => {
  assert.equal(hub.isDashboardOrigin(BASE + "/hub?x=1", BASE), true)
  assert.equal(hub.isDashboardOrigin("http://127.0.0.1:4203/hub", BASE), false)
  assert.equal(hub.isDashboardOrigin("http://localhost:4202/hub", BASE), false)
  assert.equal(hub.opensOutside("https://github.com/x", BASE), true)
  assert.equal(hub.opensOutside("mailto:a@example.com", BASE), true)
  assert.equal(hub.opensOutside("file:///etc/hosts", BASE), false)
  assert.equal(hub.opensOutside(BASE + "/wall", BASE), false)
})

test("microphone only, dashboard only", () => {
  assert.equal(hub.allowsMedia(BASE + "/hub", BASE, ["audio"]), true)
  assert.equal(hub.allowsMedia(BASE + "/hub", BASE, ["audio", "video"]), false)
  assert.equal(hub.allowsMedia(BASE + "/hub", BASE, ["video"]), false)
  assert.equal(hub.allowsMedia(BASE + "/hub", BASE, []), false)
  assert.equal(hub.allowsMedia("https://example.com", BASE, ["audio"]), false)
})
