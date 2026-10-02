import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  IMPLICIT_OWNER, operatorPerson, peopleProblem, personName, personOfTurn, resolvePerson, type Person,
} from "../src/people/people"
import { openRequestsOf, runsOf } from "../src/people/activity"
import { peopleConfigSchema, daemonConfigSchema } from "../src/daemon/config"
import { rootInitiatorOf, propagatedRootOf } from "../src/a2a/initiator"
import { openDb, closeDb } from "../src/storage/sqlite"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { operatorContext } from "../src/requests/operator"

// People (#384): one identity per human across channels.

const sara: Person = { id: "sara", name: "Sara", role: "member", identities: ["gitlab:sara.b", "whatsapp:+216 20 123 456"] }
const anis: Person = { id: "anis", name: "Anis", role: "owner", identities: ["telegram:4242", "github:Anis-M"] }
const PEOPLE = [anis, sara]

describe("matching a sender to a person", () => {
  it("finds the same person from a GitLab login and from a WhatsApp number", () => {
    expect(resolvePerson(PEOPLE, "gitlab", { id: "group/app:issue:7", username: "sara.b" })?.id).toBe("sara")
    expect(resolvePerson(PEOPLE, "whatsapp", { id: "21620123456", username: "21620123456" })?.id).toBe("sara")
    expect(resolvePerson(PEOPLE, "whatsapp", { id: "21620123456@s.whatsapp.net" })?.id).toBe("sara")
  })

  it("ignores case, a leading @ and the account part of a channel", () => {
    expect(resolvePerson(PEOPLE, "github", { username: "anis-m" })?.id).toBe("anis")
    expect(resolvePerson(PEOPLE, "GitLab", { username: "@Sara.B" })?.id).toBe("sara")
    expect(resolvePerson(PEOPLE, "telegram@work", { id: "4242" })?.id).toBe("anis")
  })

  it("leaves a sender that matches nobody unknown", () => {
    expect(resolvePerson(PEOPLE, "gitlab", { username: "someone-else" })).toBeNull()
    expect(resolvePerson(PEOPLE, "telegram", {})).toBeNull()
    expect(resolvePerson([], "telegram", { id: "4242" })).toBeNull()
  })

  it("never matches an id from another channel", () => {
    expect(resolvePerson(PEOPLE, "github", { username: "sara.b" })).toBeNull()
    expect(resolvePerson(PEOPLE, "telegram", { id: "21620123456" })).toBeNull()
  })

  it("does not take the chat's number for the sender on WhatsApp", () => {
    // A message the account owner sends to Sara: `username` is Sara's number.
    expect(resolvePerson(PEOPLE, "whatsapp", { id: "21699000111@s.whatsapp.net", username: "21620123456" })).toBeNull()
  })
})

describe("the name shown for a stored person", () => {
  it("is the listed name, Owner for the built-in owner, else the id", () => {
    expect(personName(PEOPLE, "sara")).toBe("Sara")
    expect(personName([], IMPLICIT_OWNER)).toBe("Owner")
    expect(personName(PEOPLE, "gone")).toBe("gone")
  })
})

describe("who a turn belongs to", () => {
  it("with no people listed, this machine's surfaces are the owner and other senders are unknown", () => {
    expect(personOfTurn([], operatorContext({ channel: "voice", sender: "Anis" }))).toEqual({ id: IMPLICIT_OWNER, role: "owner" })
    expect(personOfTurn([], operatorContext({ channel: "dashboard" }))).toEqual({ id: IMPLICIT_OWNER, role: "owner" })
    expect(personOfTurn([], { channel: "telegram", sender: "Anis", senderId: "4242" })).toBeNull()
  })

  it("names the owner on this machine's surfaces only for a turn the daemon marked (#393)", () => {
    // What a caller of /task can send: the channel, and nothing the daemon vouches for.
    expect(personOfTurn([], { channel: "dashboard" })).toBeNull()
    expect(personOfTurn(PEOPLE, JSON.parse(JSON.stringify(operatorContext({ channel: "app", sender: "phone" }))))).toBeNull()
  })

  it("stamps the listed person, and the listed owner on this machine's surfaces", () => {
    expect(personOfTurn(PEOPLE, { channel: "gitlab", sender: "Sara B", senderId: "g/app:issue:7", senderUsername: "sara.b" })).toEqual({ id: "sara", role: "member" })
    expect(personOfTurn(PEOPLE, operatorContext({ channel: "app", sender: "phone" }))).toEqual({ id: "anis", role: "owner" })
  })

  it("does not match a display name", () => {
    expect(personOfTurn(PEOPLE, { channel: "telegram", sender: "4242", senderId: "999" })).toBeNull()
    expect(personOfTurn(PEOPLE, { channel: "gitlab", sender: "sara.b" })).toBeNull()
  })

  it("gives no person to turns software starts", () => {
    expect(personOfTurn(PEOPLE, { channel: "cron", sender: "cron:daily" })).toBeNull()
    // An agent's comment posted with the owner's account.
    expect(personOfTurn(PEOPLE, { channel: "github", sender: "agent:coder", senderUsername: "anis-m" })).toBeNull()
    expect(personOfTurn(PEOPLE, undefined)).toBeNull()
  })

  it("ignores a person a caller wrote into the context", () => {
    expect(personOfTurn(PEOPLE, { channel: "telegram", sender: "x", senderId: "999", person: "anis" })).toBeNull()
  })

  it("cannot tell two owners apart on this machine's surfaces", () => {
    const two = [anis, { ...sara, role: "owner" as const }]
    expect(operatorPerson(two)).toBeNull()
    expect(personOfTurn(two, operatorContext({ channel: "voice" }))).toBeNull()
    expect(personOfTurn(two, { channel: "telegram", senderId: "4242" })?.id).toBe("anis")
  })

  it("travels with the root across a delegation and a mesh peer", () => {
    const root = rootInitiatorOf({ channel: "whatsapp", chatId: "c1", sender: "Sara", person: "sara" }, "front")
    expect(root.person).toBe("sara")
    const overTheWire = JSON.parse(JSON.stringify({ channel: "a2a", sender: "agent:front", initiator: root }))
    expect(propagatedRootOf(overTheWire)?.person).toBe("sara")
    // The id is kept; the role is not taken from this node's list, because
    // a root is written by whoever sent the task.
    expect(personOfTurn(PEOPLE, overTheWire)).toEqual({ id: "sara" })
    expect(personOfTurn([], overTheWire)).toEqual({ id: "sara" })
    // A root that names a listed owner, or the built-in owner, gets no role.
    const forged = (person: string) => ({ channel: "a2a", initiator: { kind: "human", channel: "telegram", person } })
    const owners = [{ id: "anis", name: "Anis", role: "owner" as const, identities: ["telegram:4242"] }]
    expect(personOfTurn(owners, forged("anis"))).toEqual({ id: "anis" })
    expect(personOfTurn([], forged("owner"))).toEqual({ id: "owner" })
    // A root with no person stays unknown on every hop.
    const unknown = { channel: "a2a", sender: "agent:front", initiator: rootInitiatorOf({ channel: "telegram", chatId: "c", sender: "X" }, "front") }
    expect(personOfTurn(PEOPLE, unknown)).toBeNull()
  })
})

describe("the people setting", () => {
  it("is empty by default", () => {
    expect(peopleConfigSchema.parse(undefined)).toEqual([])
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: {} }).people).toEqual([])
  })

  it("defaults a person to member with no identities", () => {
    expect(peopleConfigSchema.parse([{ id: "sara", name: "Sara" }])).toEqual([{ id: "sara", name: "Sara", role: "member", identities: [], agents: [], deny: { tools: [], skills: [] } }])
  })

  it("refuses a person listed twice, a shared identity and an identity with no channel", () => {
    expect(peopleProblem(PEOPLE)).toBeNull()
    expect(peopleConfigSchema.safeParse([sara, { ...sara, name: "Other" }]).success).toBe(false)
    // The same number written two ways.
    expect(peopleProblem([sara, { id: "sam", name: "Sam", role: "guest", identities: ["whatsapp:21620123456"] }])).toMatch(/both "sara" and "sam"/)
    expect(peopleConfigSchema.safeParse([{ id: "sam", name: "Sam", identities: ["sam"] }]).success).toBe(false)
    expect(peopleProblem([{ id: IMPLICIT_OWNER, name: "X", role: "member", identities: [] }])).toMatch(/owner role/)
  })
})

describe("runs and requests carry the person", () => {
  let tmp: string
  beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-people-")) })
  afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

  it("shows a person's GitLab and WhatsApp turns together, and nothing for an unknown sender", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      const turn = (taskId: string, ctx: Record<string, unknown>) => {
        const person = personOfTurn(PEOPLE, ctx)
        const at = new Date().toISOString()
        const base = { agentId: "front", channel: String(ctx.channel), chatId: String(ctx.chatId) }
        bus.emit("task:started", { ...base, messagePreview: `ask ${taskId}`, at, taskId, ...(person ? { person } : {}) })
        bus.emit("task:completed", { ...base, durationMs: 5, at, taskId })
      }
      turn("T-gitlab", { channel: "gitlab", chatId: "g/app:issue:7", sender: "Sara B", senderUsername: "sara.b" })
      turn("T-whatsapp", { channel: "whatsapp", chatId: "21620123456", sender: "Sara", senderId: "21620123456" })
      turn("T-stranger", { channel: "whatsapp", chatId: "21655000000", sender: "Sara", senderId: "21655000000" })

      expect(runsOf(db, "sara").map((r) => r.taskId).sort()).toEqual(["T-gitlab", "T-whatsapp"])
      expect(runsOf(db, "anis")).toEqual([])
      const rows = db.prepare("SELECT person FROM task_history ORDER BY chat_id").all() as Array<{ person: string | null }>
      expect(rows.map((r) => r.person)).toEqual(["sara", null, "sara"])
      expect((db.prepare("SELECT person FROM task_traces WHERE task_id = 'T-stranger'").get() as any).person).toBeNull()
    } finally { dispose() }
  })

  it("records a listed owner's request on an outside channel without a `from` list", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const store = new RequestStore(db)
    const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }
    const tracker = new RequestTracker(store, () => settings, () => {}, () => 1_000)
    const start = (taskId: string, ctx: Record<string, unknown>) => {
      const person = personOfTurn(PEOPLE, ctx)
      tracker.taskStarted({
        agentId: "front", channel: String(ctx.channel), chatId: "c1", taskId, messagePreview: "do it", at: "",
        humanRoot: true, sender: { name: String(ctx.sender), id: ctx.senderId as string, username: ctx.senderUsername as string },
        ...(person ? { person } : {}),
      })
    }
    start("T-owner", { channel: "telegram", sender: "Anis", senderId: "4242" })
    start("T-member", { channel: "gitlab", sender: "Sara B", senderUsername: "sara.b" })
    start("T-stranger", { channel: "telegram", sender: "Anis", senderId: "999" })

    expect(store.get("req-T-owner")?.person).toBe("anis")
    // Requests are the owner's for now (#356): a member's turn is not one.
    expect(store.get("req-T-member")).toBeNull()
    expect(store.get("req-T-stranger")).toBeNull()

    store.link("req-T-owner", "delegation", "dlg-1", 1_000)
    store.progress("req-T-owner", 1_000)
    expect(openRequestsOf(db, "anis").map((r) => r.id)).toEqual(["req-T-owner"])
    expect(openRequestsOf(db, "sara")).toEqual([])
  })

  it("adds the person column to a requests table made before it existed", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    db.exec("CREATE TABLE requests (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT, agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attention_reason TEXT, notified_at INTEGER, question TEXT, closed_at INTEGER, evidence TEXT, close_reason TEXT)")
    expect(openRequestsOf(db, "anis")).toEqual([])
    const store = new RequestStore(db)
    store.addCandidate({ id: "r1", runId: "T1", channel: "telegram", chatId: "c", agentId: "a", text: "x", now: 1, person: "anis" })
    expect(store.get("r1")?.person).toBe("anis")
  })
})
