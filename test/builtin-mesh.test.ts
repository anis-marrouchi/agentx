import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  registerAllBuiltins,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"
import { setMesh, _resetMeshForTesting } from "../src/a2a/mesh-instance"

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
  _resetMeshForTesting()
})

afterEach(() => {
  _resetMeshForTesting()
})

describe("mesh.delegate", () => {
  it("rejects when mesh is not enabled", async () => {
    // No mesh registered. The action handler must error rather than
    // crash, so workflow conditional nodes can branch.
    await expect(runBuiltin("mesh.delegate", {
      peer: "remote-1",
      message: "hello",
    })).rejects.toThrow(/mesh not enabled/)
  })

  it("forwards to the singleton mesh's sendTask with the right args", async () => {
    let captured: any = null
    const fakeMesh = {
      sendTask: async (peer: string, text: string, agent?: string, opts?: any) => {
        captured = { peer, text, agent, opts }
        return "echo: " + text
      },
    }
    setMesh(fakeMesh as any)

    const out: any = await runBuiltin("mesh.delegate", {
      peer: "remote-1",
      agent: "atlas",
      message: "hi from a workflow",
      senderAgentId: "pm-mtgl",
      timeoutMs: 30_000,
    })

    expect(out).toEqual({ peer: "remote-1", agent: "atlas", response: "echo: hi from a workflow" })
    expect(captured.peer).toBe("remote-1")
    expect(captured.text).toBe("hi from a workflow")
    expect(captured.agent).toBe("atlas")
    expect(captured.opts.senderAgentId).toBe("pm-mtgl")
    expect(captured.opts.timeoutMs).toBe(30_000)
  })

  it("agent field is optional — null in the output when omitted", async () => {
    const fakeMesh = {
      sendTask: async () => "ok",
    }
    setMesh(fakeMesh as any)
    const out: any = await runBuiltin("mesh.delegate", { peer: "p1", message: "x" })
    expect(out.agent).toBeNull()
    expect(out.response).toBe("ok")
  })

  it("propagates sendTask errors verbatim", async () => {
    const fakeMesh = {
      sendTask: async () => { throw new Error('Peer "p1" /task timed out after 5s') },
    }
    setMesh(fakeMesh as any)
    await expect(runBuiltin("mesh.delegate", { peer: "p1", message: "x" }))
      .rejects.toThrow(/timed out after 5s/)
  })

  it("input validation rejects empty peer / empty message", async () => {
    setMesh({ sendTask: async () => "ok" } as any)
    await expect(runBuiltin("mesh.delegate", { peer: "", message: "x" })).rejects.toThrow()
    await expect(runBuiltin("mesh.delegate", { peer: "p", message: "" })).rejects.toThrow()
  })
})
