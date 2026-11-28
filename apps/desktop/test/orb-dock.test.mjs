// Guard: the orb window must not take AgentX out of the macOS Dock.
// orb-window.ts imports electron, so the call is checked in the source.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const src = readFileSync(fileURLToPath(new URL("../src/orb-window.ts", import.meta.url)), "utf8")

test("every setVisibleOnAllWorkspaces call keeps the app a normal Dock app", () => {
  const calls = src.match(/setVisibleOnAllWorkspaces\([^)]*\)/g) ?? []
  assert.ok(calls.length > 0, "orb-window.ts calls setVisibleOnAllWorkspaces")
  for (const call of calls) {
    assert.match(call, /skipTransformProcessType:\s*true/, `missing skipTransformProcessType: ${call}`)
    assert.match(call, /visibleOnFullScreen:\s*true/, `orb must still float over full-screen apps: ${call}`)
  }
})
