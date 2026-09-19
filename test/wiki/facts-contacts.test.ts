import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { describe, expect, it } from "vitest"
import { createContactsSource, factsFrom, loadContacts, namesOf } from "../../src/wiki/facts"

const write = (contacts: unknown): string => {
  const dir = mkdtempSync(resolve(tmpdir(), "contacts-"))
  const p = resolve(dir, "contacts.json")
  writeFileSync(p, JSON.stringify({ contacts }))
  return p
}

const alex = {
  id: "alex",
  name: "Alex Rivera",
  aliases: ["Alex", "alex.rivera"],
  channels: { telegram: "818540323", gitlab: "alex-rivera", whatsapp: "21600000000@s.whatsapp.net" },
}

describe("namesOf", () => {
  it("answers to the name, the id and every alias", () => {
    expect(namesOf(alex)).toEqual(expect.arrayContaining(["alex rivera", "alex", "alexrivera"]))
  })

  it("skips blanks rather than indexing an empty key", () => {
    expect(namesOf({ name: "", aliases: ["  "] })).toEqual([])
  })
})

describe("factsFrom", () => {
  it("unpacks a WhatsApp JID into a number and a country", () => {
    // A reader wants the number, not the routing address it is embedded in.
    const f = factsFrom(alex)
    expect(f.whatsapp).toBe("21600000000@s.whatsapp.net")
    expect(f.phone).toBe("+21600000000")
    expect(f.country).toBe("Tunisia")
  })

  it("normalises a handle to @form", () => {
    expect(factsFrom(alex).gitlab).toBe("@alex-rivera")
    expect(factsFrom({ channels: { github: "@already" } }).github).toBe("@already")
  })

  it("never presents a numeric Telegram id as a contact value", () => {
    const f = factsFrom(alex)
    expect(f.telegramId).toBe("818540323")
    expect(f.telegram).toBeUndefined()
  })

  it("keeps a Telegram @handle, which is reachable", () => {
    expect(factsFrom({ channels: { telegram: "@alex" } }).telegram).toBe("@alex")
  })

  it("accepts a bare phone channel and derives the country", () => {
    const f = factsFrom({ channels: { phone: "+33000000000" } })
    expect(f.phone).toBe("+33000000000")
    expect(f.country).toBe("France")
  })

  it("passes through an unknown channel rather than dropping it", () => {
    expect(factsFrom({ channels: { signal: "abc" } }).signal).toBe("abc")
  })

  it("ignores empty channel values", () => {
    expect(factsFrom({ channels: { gitlab: "   " } })).toEqual({})
  })
})

describe("loadContacts", () => {
  it("returns nothing for a missing or corrupt file instead of throwing", () => {
    expect(loadContacts("/nope/contacts.json")).toEqual([])
    const dir = mkdtempSync(resolve(tmpdir(), "contacts-"))
    const p = resolve(dir, "contacts.json")
    writeFileSync(p, "{ not json")
    expect(loadContacts(p)).toEqual([])
  })
})

describe("contacts source", () => {
  it("resolves by alias, which no directory can do", () => {
    // The whole reason the registry outranks the directories.
    const src = createContactsSource({ path: write([alex]) })
    return src.lookup([{ name: "alex.rivera" }]).then((r) => {
      expect(r).toHaveLength(1)
      expect(r[0].name).toBe("Alex Rivera")
      expect(r[0].fuzzy).toBe(true)
      expect(r[0].fields.phone).toBe("+21600000000")
    })
  })

  it("marks an exact-name hit as not fuzzy", async () => {
    const src = createContactsSource({ path: write([alex]) })
    expect((await src.lookup([{ name: "Alex Rivera" }]))[0].fuzzy).toBe(false)
  })

  it("returns nothing for someone not in the registry", async () => {
    const src = createContactsSource({ path: write([alex]) })
    expect(await src.lookup([{ name: "Dana Okonkwo" }])).toEqual([])
  })

  it("does not emit the same contact twice for two aliases in one batch", async () => {
    const src = createContactsSource({ path: write([alex]) })
    expect(await src.lookup([{ name: "Alex" }, { name: "alex.rivera" }])).toHaveLength(1)
  })

  it("reports a missing registry with the shape to create", async () => {
    const why = await createContactsSource({ path: "/nope/contacts.json" }).available()
    expect(why?.kind).toBe("not-configured")
    expect(why?.hint).toContain("contacts")
  })

  it("reports an empty registry rather than claiming to be healthy", async () => {
    expect((await createContactsSource({ path: write([]) }).available())?.kind).toBe("not-configured")
  })

  it("is healthy with at least one contact", async () => {
    expect(await createContactsSource({ path: write([alex]) }).available()).toBeNull()
  })
})

describe("source precedence", () => {
  it("puts the hand-maintained registry ahead of the directories", async () => {
    const { defaultSources } = await import("../../src/wiki/facts")
    expect(defaultSources().map((s) => s.name)).toEqual(["contacts", "wacli", "gitlab", "gog"])
  })
})
