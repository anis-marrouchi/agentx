import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "net"
import { busyPorts, cliCommand } from "../src/commands/demo-startup"

let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()))
  server = undefined
})

function listen(): Promise<number> {
  server = createServer((s) => s.end())
  return new Promise((done) => server!.listen(0, "127.0.0.1", () => done((server!.address() as any).port)))
}

async function freePort(): Promise<number> {
  const s = createServer()
  const port = await new Promise<number>((done) => s.listen(0, "127.0.0.1", () => done((s.address() as any).port)))
  await new Promise<void>((done) => s.close(() => done()))
  return port
}

describe("busyPorts", () => {
  it("names a port something already answers on, such as an earlier demo", async () => {
    const taken = await listen()
    const free = await freePort()
    expect(await busyPorts([taken, free])).toEqual([taken])
  })

  it("is empty when every port is free", async () => {
    expect(await busyPorts([await freePort()])).toEqual([])
  })
})

describe("cliCommand", () => {
  it("suggests npx when the demo was started with npx", () => {
    expect(cliCommand("/home/me/.npm/_npx/abc123/node_modules/agentix-cli/dist/cli.js", {})).toBe("npx agentix-cli")
    expect(cliCommand("/somewhere/bin/agentx", { npm_command: "exec" })).toBe("npx agentix-cli")
  })

  it("suggests node dist/cli.js from a source checkout", () => {
    expect(cliCommand("/home/me/agentx/dist/cli.js", {})).toBe("node dist/cli.js")
  })

  it("suggests agentx for an installed copy", () => {
    expect(cliCommand("/usr/local/bin/agentx", {})).toBe("agentx")
    expect(cliCommand("/usr/local/lib/node_modules/agentix-cli/dist/cli.js", {})).toBe("agentx")
  })
})
