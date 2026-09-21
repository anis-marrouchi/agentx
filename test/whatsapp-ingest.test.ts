import { describe, it, expect, beforeEach } from "vitest"
import {
  transformContact,
  transformGroupMeta,
  transformDm,
  transformGroupMessages,
  resolveScope,
  runSweep,
  hashProfile,
  type ContactRead,
  type ChatRead,
  type GroupRead,
  type MessageRead,
  type WhatsAppSource,
  type IngestConfig,
  type EntryStore,
} from "../src/wiki/ingest-whatsapp"
import type { WikiEntry } from "../src/wiki/types"

// --- Test fixtures ---

const contactAlex: ContactRead = {
  jid: "10000000000@s.whatsapp.net",
  phone: "10000000000",
  pushName: "Alex",
  savedName: "Alex Rivera",
  status: "Doing AgentX work",
  updatedAt: "2026-04-21T10:00:00.000Z",
}
const contactOther: ContactRead = {
  jid: "19999999999@s.whatsapp.net",
  phone: "19999999999",
  pushName: "Other",
  updatedAt: "2026-04-21T10:00:00.000Z",
}
const groupAcme: GroupRead = {
  jid: "120363000000000001@g.us",
  subject: "Acme Team",
  description: "Internal coordination",
  owner: contactAlex.jid,
  members: [
    { jid: contactAlex.jid, admin: "superadmin" },
    { jid: contactOther.jid },
  ],
  memberCount: 2,
}
const dmChat: ChatRead = {
  jid: contactAlex.jid,
  name: "Alex Rivera",
  isGroup: false,
}
const groupChat: ChatRead = {
  jid: groupAcme.jid,
  name: "Acme Team",
  isGroup: true,
}

const tsNow = () => new Date("2026-04-21T12:00:00.000Z")

// --- Mock source ---

function makeSource(overrides: Partial<WhatsAppSource> = {}): WhatsAppSource {
  return {
    isConnected: () => true,
    listContacts: () => [contactAlex, contactOther],
    listChats: () => [dmChat, groupChat],
    getContactProfile: async (jid) =>
      [contactAlex, contactOther].find((c) => c.jid === jid) ?? null,
    getGroupMetadata: async (jid) => (jid === groupAcme.jid ? groupAcme : null),
    getHistory: async () => [],
    ...overrides,
  }
}

// --- Mock store ---

class MemoryStore implements EntryStore {
  entries: WikiEntry[] = []
  addEntry(entry: WikiEntry): string {
    this.entries.push(entry)
    return `${entry.date}_${entry.id}.md`
  }
}

const baseConfig: IngestConfig = {
  enabled: true,
  mode: "metadata-only",
  allowContacts: [],
  allowGroups: [],
  denyContacts: [],
  denyGroups: [],
  messageCap: 50,
  historyDays: 30,
  contactRefreshDays: 7,
  throttle: { minMsBetweenCalls: 0, maxCallsPerMinute: 9999, maxChatsPerSweep: 100 },
  retentionDays: 0,
}

describe("transformContact", () => {
  it("produces a stable id keyed to JID + date", () => {
    const a = transformContact(contactAlex, "devops-agent", tsNow())
    const b = transformContact(contactAlex, "devops-agent", tsNow())
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^wa-contact-[a-f0-9]{10}-\d{8}$/)
  })

  it("different contacts produce different ids", () => {
    const a = transformContact(contactAlex, "devops-agent", tsNow())
    const b = transformContact(contactOther, "devops-agent", tsNow())
    expect(a.id).not.toBe(b.id)
  })

  it("sets source and sourceContext correctly", () => {
    const entry = transformContact(contactAlex, "devops-agent", tsNow())
    expect(entry.source).toBe("whatsapp:contact")
    expect(entry.sourceContext).toBe(contactAlex.jid)
    expect(entry.agentId).toBe("devops-agent")
  })

  it("includes saved name and status in content but never message bodies", () => {
    const entry = transformContact(contactAlex, "devops-agent", tsNow())
    expect(entry.content).toContain("Alex Rivera")
    expect(entry.content).toContain("Doing AgentX work")
    expect(entry.content).not.toContain("message")
  })
})

describe("transformGroupMeta", () => {
  it("caps the member roster to avoid huge entries", () => {
    const many: GroupRead = {
      ...groupAcme,
      members: Array.from({ length: 200 }, (_, i) => ({ jid: `${i}@s.whatsapp.net` })),
      memberCount: 200,
    }
    const entry = transformGroupMeta(many, "devops-agent", tsNow())
    // 50 members + "…and X more" summary line
    expect(entry.content).toContain("…and 150 more")
  })

  it("stable id keyed to group JID + date", () => {
    const a = transformGroupMeta(groupAcme, "devops-agent", tsNow())
    const b = transformGroupMeta(groupAcme, "devops-agent", tsNow())
    expect(a.id).toBe(b.id)
  })
})

describe("transformDm / transformGroupMessages", () => {
  const msgs: MessageRead[] = [
    { id: "MSG-1", fromJid: contactAlex.jid, fromMe: false, timestamp: 1713700000, text: "hey" },
    { id: "MSG-2", fromJid: contactAlex.jid, fromMe: true, timestamp: 1713700010, text: "hi" },
  ]

  it("returns null for empty message arrays", () => {
    expect(transformDm(dmChat, contactAlex, [], "a", tsNow())).toBeNull()
    expect(transformGroupMessages(groupChat, groupAcme, [], "a", tsNow())).toBeNull()
  })

  it("id includes the last message id so new messages → new entry", () => {
    const a = transformDm(dmChat, contactAlex, msgs, "devops-agent", tsNow())!
    const msgs2 = [...msgs, { id: "MSG-3", fromJid: contactAlex.jid, fromMe: false, timestamp: 1713700020, text: "ok" }]
    const b = transformDm(dmChat, contactAlex, msgs2, "devops-agent", tsNow())!
    expect(a.id).not.toBe(b.id)
  })

  it("same messages → same id (idempotent rewrite)", () => {
    const a = transformDm(dmChat, contactAlex, msgs, "devops-agent", tsNow())!
    const b = transformDm(dmChat, contactAlex, msgs, "devops-agent", tsNow())!
    expect(a.id).toBe(b.id)
  })

  it("renders media without the original text", () => {
    const mediaMsgs: MessageRead[] = [{
      id: "M1", fromJid: contactAlex.jid, fromMe: false, text: "",
      media: { kind: "image", caption: "sunset" },
    }]
    const entry = transformDm(dmChat, contactAlex, mediaMsgs, "a", tsNow())!
    expect(entry.content).toContain("[image: sunset]")
  })
})

describe("resolveScope", () => {
  let source: WhatsAppSource
  beforeEach(() => { source = makeSource() })

  it("returns empty when disabled", () => {
    expect(resolveScope({ ...baseConfig, enabled: false }, source)).toHaveLength(0)
  })

  it("returns empty when enabled but allowlists are empty (default-deny)", () => {
    expect(resolveScope(baseConfig, source)).toHaveLength(0)
  })

  it("includes a contact matched by phone substring", () => {
    // A substring of the first fixture's number only — the second is
    // 1999999… so a match here proves substring matching, not "any contact".
    const cfg = { ...baseConfig, allowContacts: ["00000"] }
    const targets = resolveScope(cfg, source)
    expect(targets).toHaveLength(1)
    expect(targets[0].jid).toBe(contactAlex.jid)
  })

  it("respects `+` prefix in allowlist entries", () => {
    const cfg = { ...baseConfig, allowContacts: ["+10000000000"] }
    const targets = resolveScope(cfg, source)
    expect(targets).toHaveLength(1)
  })

  it("deny wins over allow", () => {
    const cfg = {
      ...baseConfig,
      allowContacts: ["10000000000"],
      denyContacts: ["10000000000"],
    }
    expect(resolveScope(cfg, source)).toHaveLength(0)
  })

  it("matches groups by JID substring", () => {
    const cfg = { ...baseConfig, allowGroups: ["120363000000000001"] }
    const targets = resolveScope(cfg, source)
    expect(targets).toHaveLength(1)
    expect(targets[0].kind).toBe("group")
  })
})

describe("runSweep", () => {
  it("emits metadata-only entries for contacts + groups in scope", async () => {
    const source = makeSource()
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "devops-agent", now: tsNow(),
      config: {
        ...baseConfig,
        allowContacts: ["10000000000"],
        allowGroups: ["120363000000000001"],
      },
    })
    expect(report.scannedContacts).toBe(1)
    expect(report.scannedGroups).toBe(1)
    expect(report.wroteContacts).toBe(1)
    expect(report.wroteGroups).toBe(1)
    expect(report.wroteDmWindows).toBe(0)
    expect(store.entries).toHaveLength(2)
  })

  it("dry-run: returns planned entries, writes nothing", async () => {
    const source = makeSource()
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "devops-agent", now: tsNow(), dryRun: true,
      config: { ...baseConfig, allowContacts: ["10000000000"] },
    })
    expect(store.entries).toHaveLength(0)
    expect(report.dryRunEntries).toHaveLength(1)
  })

  it("aborts when source not connected (non-dry-run)", async () => {
    const source = makeSource({ isConnected: () => false })
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "a", config: { ...baseConfig, allowContacts: ["216"] }, now: tsNow(),
    })
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].message).toMatch(/not connected/i)
  })

  it("mode=messages pulls a bounded DM window and writes it", async () => {
    const msgs: MessageRead[] = [
      { id: "M1", fromJid: contactAlex.jid, fromMe: false, timestamp: 1713700000, text: "hey" },
    ]
    const source = makeSource({ getHistory: async () => msgs })
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "a", now: tsNow(),
      config: { ...baseConfig, mode: "messages", allowContacts: ["10000000000"], historyDays: 10_000 },
    })
    expect(report.wroteDmWindows).toBe(1)
    expect(store.entries).toHaveLength(2)
    const dm = store.entries.find((e) => e.source === "whatsapp:dm")!
    expect(dm.content).toContain("hey")
  })

  it("respects maxChatsPerSweep cap", async () => {
    const source = makeSource()
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "a", now: tsNow(),
      config: {
        ...baseConfig,
        allowContacts: ["10000000000", "10000000000"],
        allowGroups: ["120363000000000001"],
        throttle: { ...baseConfig.throttle, maxChatsPerSweep: 2 },
      },
    })
    // Cap trims to 2 targets — we care that we don't process all three.
    expect(report.scannedContacts + report.scannedGroups).toBe(2)
  })

  it("per-target errors are captured without aborting the sweep", async () => {
    const source = makeSource({
      getGroupMetadata: async () => { throw new Error("boom") },
    })
    const store = new MemoryStore()
    const report = await runSweep({
      source, store, agentId: "a", now: tsNow(),
      config: {
        ...baseConfig,
        allowContacts: ["10000000000"],
        allowGroups: ["120363000000000001"],
      },
    })
    expect(report.wroteContacts).toBe(1)  // contact still processed
    expect(report.errors).toHaveLength(1) // group errored
    expect(report.errors[0].jid).toBe(groupAcme.jid)
  })
})

describe("hashProfile", () => {
  it("stable for unchanged profile", () => {
    expect(hashProfile(contactAlex)).toBe(hashProfile(contactAlex))
  })
  it("changes when status changes", () => {
    const a = hashProfile(contactAlex)
    const b = hashProfile({ ...contactAlex, status: "new status" })
    expect(a).not.toBe(b)
  })
})
