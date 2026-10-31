import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { createServer, type Server } from "net"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { literalSecretProblems, loadDaemonConfig, mailSenderSchema } from "../src/daemon/config"
import { sendSystemMail, senderSummary, testMail } from "../src/mail/sender"

// The system mail sender (#1478): secrets only from .env, and one send
// through a fake SMTP server. Nothing reaches a real provider.

interface Received { auth: string; from: string; to: string[]; data: string }

/** A plain SMTP server that takes AUTH PLAIN and keeps what it got. */
function fakeSmtp(): Promise<{ server: Server; port: number; got: Received[] }> {
  const got: Received[] = []
  const server = createServer((sock) => {
    const cur: Received = { auth: "", from: "", to: [], data: "" }
    let inData = false
    let buf = ""
    sock.write("220 fake ESMTP\r\n")
    sock.on("data", (chunk) => {
      buf += chunk.toString()
      let i: number
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) {
          if (line === ".") { inData = false; got.push({ ...cur }); sock.write("250 queued as fake-1\r\n") }
          else cur.data += line + "\n"
          continue
        }
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === "EHLO") sock.write("250-fake\r\n250 AUTH PLAIN\r\n")
        else if (cmd === "AUTH") { cur.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString(); sock.write("235 ok\r\n") }
        else if (cmd === "MAIL") { cur.from = line; sock.write("250 ok\r\n") }
        else if (cmd === "RCPT") { cur.to.push(line); sock.write("250 ok\r\n") }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n") }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end() }
        else sock.write("250 ok\r\n")
      }
    })
  })
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    done({ server, port: (server.address() as { port: number }).port, got })
  }))
}

const NODE = { node: { id: "n", name: "n" } }
const SENDER = { kind: "smtp", from: "no-reply@mg.example.com", host: "127.0.0.1", user: "${AGENTX_MAIL_USER}", password: "${AGENTX_MAIL_PASSWORD}" }

describe("literalSecretProblems", () => {
  it("accepts ${VAR} references and no sender", () => {
    expect(literalSecretProblems({ mail: { sender: SENDER } })).toEqual([])
    expect(literalSecretProblems({})).toEqual([])
  })

  it("refuses a literal login or password, without echoing it", () => {
    const problems = literalSecretProblems({ mail: { sender: { ...SENDER, user: "postmaster@mg.example.com", password: "s3cret" } } })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/^mail\.sender\.user: put the value in \.env/)
    expect(problems.join(" ")).not.toContain("s3cret")
    expect(problems.join(" ")).not.toContain("postmaster@")
  })

  it("refuses a value that only embeds a reference", () => {
    expect(literalSecretProblems({ mail: { sender: { ...SENDER, password: "x${AGENTX_MAIL_PASSWORD}" } } })).toHaveLength(1)
  })
})

describe("loadDaemonConfig with mail.sender", () => {
  let dir: string
  const cwd = process.cwd()
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ax-mail-")) })
  afterEach(() => {
    process.chdir(cwd)
    delete process.env.AGENTX_MAIL_USER
    delete process.env.AGENTX_MAIL_PASSWORD
    rmSync(dir, { recursive: true, force: true })
  })

  it("fills the login from .env and the defaults", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ ...NODE, mail: { sender: SENDER } }))
    writeFileSync(join(dir, ".env"), "AGENTX_MAIL_USER=postmaster@mg.example.com\nAGENTX_MAIL_PASSWORD=pw\n")
    process.chdir(dir)
    const s = loadDaemonConfig(join(dir, "agentx.json")).mail.sender!
    expect(s.user).toBe("postmaster@mg.example.com")
    expect(s.password).toBe("pw")
    expect(s.port).toBe(587)
    expect(s.secure).toBe(false)
    expect(s.name).toBe("AgentX")
  })

  it("refuses to load a literal password", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ ...NODE, mail: { sender: { ...SENDER, password: "s3cret" } } }))
    process.chdir(dir)
    expect(() => loadDaemonConfig(join(dir, "agentx.json"))).toThrow(/mail\.sender\.password: put the value in \.env/)
  })

  it("leaves mail.sender unset when absent", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(NODE))
    process.chdir(dir)
    expect(loadDaemonConfig(join(dir, "agentx.json")).mail.sender).toBeUndefined()
  })
})

describe("sendSystemMail", () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>
  beforeEach(async () => { smtp = await fakeSmtp() })
  afterEach(() => new Promise<void>((done) => smtp.server.close(() => done())))

  it("sends one mail with the sender's address, the login and an auto-generated header", async () => {
    const s = mailSenderSchema.parse({ ...SENDER, name: "Example Wall", port: smtp.port, user: "postmaster@mg.example.com", password: "pw" })
    const id = await sendSystemMail(s, testMail("dana@example.com", s))
    expect(id).toBeTruthy()
    expect(smtp.got).toHaveLength(1)
    const m = smtp.got[0]
    expect(m.auth).toBe("\0postmaster@mg.example.com\0pw")
    expect(m.from).toContain("<no-reply@mg.example.com>")
    expect(m.to).toEqual(["RCPT TO:<dana@example.com>"])
    expect(m.data).toContain("From: Example Wall <no-reply@mg.example.com>")
    expect(m.data).toContain("Subject: Example Wall: test mail")
    expect(m.data).toContain("Auto-Submitted: auto-generated")
  })

  it("never shows the login or password in the summary", () => {
    const s = mailSenderSchema.parse({ ...SENDER, port: 2525, user: "postmaster@mg.example.com", password: "pw" })
    expect(senderSummary(s)).toBe("AgentX <no-reply@mg.example.com> via 127.0.0.1:2525")
  })
})
