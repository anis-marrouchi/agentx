import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { HookRegistry } from "../src/hooks/registry"
import { loadHooks } from "../src/hooks/loader"
import { createWorkflowHookHandlers } from "../src/workflows/hooks"

// noqta/noqta#581: the config reload cleared every hook and loaded only the
// disk ones back, so the workflow engine's in-process handlers were gone and
// no chat message started a channel-triggered workflow until a restart.

function diskHook(name: string) {
  return { name, type: "command" as const, command: "true", priority: 10, enabled: true }
}

describe("HookRegistry.clearLoaded", () => {
  it("keeps in-process handlers and drops the disk hooks", () => {
    const hooks = new HookRegistry()
    hooks.registerHandler("pre:channel-message", "workflows:pre:channel-message", async () => ({}), 50)
    hooks.register("pre:channel-message", diskHook("disk-a"))
    hooks.register("post:response", diskHook("disk-b"))

    hooks.clearLoaded()

    expect(hooks.has("pre:channel-message")).toBe(true)
    expect(hooks.has("post:response")).toBe(false)
    expect(hooks.size()).toBe(1)
  })

  it("a chat message still reaches the workflow dispatcher after a reload", async () => {
    const dispatch = vi.fn(async () => ({ claimed: [], runs: [] }))
    const resumeFromReply = vi.fn(async () => null)
    const hooks = new HookRegistry()
    const handlers = createWorkflowHookHandlers({ dispatch, resumeFromReply } as any)
    for (const [event, handler] of Object.entries(handlers)) {
      if (handler) hooks.registerHandler(event as any, `workflows:${event}`, handler, 50)
    }

    // What the daemon's config reload does (no disk hooks in this test).
    hooks.clearLoaded()

    const msg = {
      id: "641", channel: "telegram", accountId: "devops", text: "yes, deploy approved",
      sender: { id: "1816212449", name: "Anis" },
    }
    expect(hooks.has("pre:channel-message")).toBe(true)
    await hooks.execute("pre:channel-message", { event: "pre:channel-message", msg } as any)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({ trigger: { source: "telegram-message", chat: "1816212449" } })
  })

  it("a reload that changes nothing about hooks keeps the engine's hooks", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "agentx-hooks-reload-"))
    try {
      writeFileSync(path.join(cwd, "agentx.config.json"), JSON.stringify({
        hooks: { "pre:channel-message": [diskHook("disk-a")], "post:response": [diskHook("disk-b")] },
      }))
      const dispatch = vi.fn(async () => ({ claimed: [], runs: [] }))
      const hooks = new HookRegistry()
      // Daemon start: disk hooks, then the engine's handlers.
      loadHooks(cwd, hooks)
      const handlers = createWorkflowHookHandlers({ dispatch, resumeFromReply: vi.fn(async () => null) } as any)
      for (const [event, handler] of Object.entries(handlers)) {
        if (handler) hooks.registerHandler(event as any, `workflows:${event}`, handler, 50)
      }
      const before = hooks.size()

      // The daemon's reload step 6, twice, with the hooks config unchanged.
      for (let i = 0; i < 2; i++) {
        hooks.clearLoaded()
        loadHooks(cwd, hooks)
      }

      expect(hooks.size()).toBe(before)
      const msg = { id: "1", channel: "telegram", accountId: "devops", text: "yes", sender: { id: "42", name: "A" } }
      await hooks.execute("pre:channel-message", { event: "pre:channel-message", msg } as any)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
