import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { blockedAddress, guardedFetch, refusedUrl, type HostLookup } from "../src/requests/checkers/fetch-guard"
import { checkUrl } from "../src/requests/checkers/url"
import { forgeCommitReader, type ForgeItem, type ForgeReader } from "../src/requests/checkers/issue"
import { checkProofLink, claimedRef, proofVerify } from "../src/requests/proof-link"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"

// #2122: proof links are opened, behind a guard against private addresses.
// No network: every fetch and every DNS answer is mocked.

const dns = (table: Record<string, string[]>): HostLookup => async (host) => {
  if (!(host in table)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
  return table[host]
}
const PUBLIC = dns({ "docs.example.com": ["93.184.216.34"], "site.example.org": ["2606:4700::1111"] })

/** A fetch that records what it was asked and answers from a table. */
function server(routes: Record<string, () => Response>) {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(url)
    const route = routes[url]
    if (!route) throw new Error(`no route for ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { fetch: f, asked }
}
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })

describe("fetch guard (#2122)", () => {
  it("refuses loopback, private, link-local, CGNAT and IPv6 ULA addresses", () => {
    for (const ip of ["127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fd12:3456:789a::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1"]) {
      expect(blockedAddress(ip), ip).toMatch(/private, loopback or link-local/)
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(blockedAddress(ip), ip).toBeNull()
  })

  it("refuses local names, IP literals and names that resolve to a private address, and non-http links", async () => {
    const lookup = dns({ "intranet.example.com": ["93.184.216.34", "10.0.0.5"], "ula.example.com": ["fd00::5"] })
    expect(await refusedUrl(new URL("http://localhost:18800/"), lookup)).toMatch(/local name/)
    expect(await refusedUrl(new URL("http://printer.local/"), lookup)).toMatch(/local name/)
    expect(await refusedUrl(new URL("http://127.0.0.1/"), lookup)).toMatch(/loopback/)
    expect(await refusedUrl(new URL("http://[::1]:8080/"), lookup)).toMatch(/loopback/)
    expect(await refusedUrl(new URL("http://[fd00::1]/"), lookup)).toMatch(/private/)
    expect(await refusedUrl(new URL("http://169.254.169.254/latest/meta-data"), lookup)).toMatch(/link-local/)
    // Every address counts, not only the first.
    expect(await refusedUrl(new URL("https://intranet.example.com/"), lookup)).toMatch(/intranet.example.com resolves to 10.0.0.5/)
    expect(await refusedUrl(new URL("https://ula.example.com/"), lookup)).toMatch(/fd00::5/)
    expect(await refusedUrl(new URL("ftp://docs.example.com/"), lookup)).toMatch(/not http/)
    expect(await refusedUrl(new URL("https://docs.example.com/"), PUBLIC)).toBeNull()
  })

  it("never fetches a refused address", async () => {
    const s = server({})
    const f = guardedFetch({ fetch: s.fetch, lookup: PUBLIC })
    await expect(f("http://127.0.0.1:18800/api")).rejects.toThrow(/refused/)
    expect(s.asked).toEqual([])
  })

  it("follows a public redirect, and refuses one to localhost or a private address", async () => {
    const s = server({
      "https://docs.example.com/a": redirect("/b"),
      "https://docs.example.com/b": () => new Response("ok", { status: 200 }),
      "https://docs.example.com/to-local": redirect("http://localhost:18800/secret"),
      "https://docs.example.com/to-private": redirect("http://[fd00::1]/"),
      "https://docs.example.com/to-meta": redirect("http://169.254.169.254/latest"),
    })
    const f = guardedFetch({ fetch: s.fetch, lookup: PUBLIC })
    expect((await f("https://docs.example.com/a")).status).toBe(200)
    await expect(f("https://docs.example.com/to-local")).rejects.toThrow(/refused: localhost is a local name \(redirected to http:\/\/localhost:18800\/secret\)/)
    await expect(f("https://docs.example.com/to-private")).rejects.toThrow(/refused/)
    await expect(f("https://docs.example.com/to-meta")).rejects.toThrow(/refused/)
    expect(s.asked).not.toContain("http://localhost:18800/secret")
    expect(s.asked.some((u) => u.includes("169.254") || u.includes("fd00"))).toBe(false)
  })

  it("the URL check reads a refused address as unverifiable", async () => {
    const s = server({ "https://docs.example.com/r": redirect("http://127.0.0.1/") })
    const r = await checkUrl({ kind: "url", url: "https://docs.example.com/r" }, { fetch: guardedFetch({ fetch: s.fetch, lookup: PUBLIC }) })
    expect(r.verdict).toBe("unverifiable")
    expect(r.detail).toMatch(/refused/)
  })
})

const reader = (items: Record<string, ForgeItem | { error: string }>): ForgeReader & { calls: string[] } => {
  const calls: string[] = []
  const f = (async (provider, ref) => {
    const key = `${provider}:${ref.project}${ref.mr && provider === "gitlab" ? "!" : "#"}${ref.number}`
    calls.push(key)
    return items[key] ?? { error: "not found (or not visible to the connector)" }
  }) as ForgeReader & { calls: string[] }
  f.calls = calls
  return f
}

describe("checkProofLink: forge links read through the API (#2122)", () => {
  const forge = reader({
    "github:acme/app#12": { state: "merged", url: "https://github.com/acme/app/pull/12" },
    "github:acme/app#13": { state: "open", url: "https://github.com/acme/app/pull/13" },
    "gitlab:g/app!3": { state: "merged", url: "https://gitlab.example.com/g/app/-/merge_requests/3" },
    "gitlab:g/app#9": { state: "open", url: "https://gitlab.example.com/g/app/-/issues/9" },
  })
  const ctx = { forge, gitlabUrl: "https://gitlab.example.com", fetch: (async () => { throw new Error("no page fetch for a forge link") }) as unknown as typeof fetch }

  it("verifies a merged pull request the claim says is merged", async () => {
    expect(await checkProofLink("https://github.com/acme/app/pull/12", "PR merged", ctx)).toEqual({ state: "verified", detail: "https://github.com/acme/app/pull/12 is merged" })
    expect((await checkProofLink("https://github.com/acme/app/pull/12/files", "merged", ctx)).state).toBe("verified")
    expect((await checkProofLink("https://gitlab.example.com/g/app/-/merge_requests/3", "MR merged", ctx)).state).toBe("verified")
  })

  it("fails a pull request that is not merged when the claim says merged", async () => {
    const r = await checkProofLink("https://github.com/acme/app/pull/13", "merged the fix", ctx)
    expect(r).toEqual({ state: "failed", detail: "https://github.com/acme/app/pull/13 is open" })
  })

  it("verifies an issue that exists when the claim names no state", async () => {
    expect(await checkProofLink("https://gitlab.example.com/g/app/-/issues/9", "opened the issue", ctx)).toEqual({ state: "verified", detail: "https://gitlab.example.com/g/app/-/issues/9 is open" })
  })

  it("is unverifiable when the connector cannot see it, or there is none", async () => {
    expect((await checkProofLink("https://github.com/acme/private/issues/1", "done", ctx)).state).toBe("unverifiable")
    expect((await checkProofLink("https://github.com/acme/app/pull/12", "merged", {})).state).toBe("unverifiable")
  })

  it("reads a commit through the API", async () => {
    const api = server({
      "https://api.github.com/repos/acme/app/commits/abc1234": () => Response.json({ sha: "abc1234def5678", html_url: "https://github.com/acme/app/commit/abc1234def5678" }),
    })
    const commit = forgeCommitReader({ github: { apiUrl: "https://api.github.com", token: "t" } }, api.fetch)
    expect(await checkProofLink("https://github.com/acme/app/commit/abc1234", "pushed", { commit })).toEqual({ state: "verified", detail: "https://github.com/acme/app/commit/abc1234def5678 is commit abc1234def56" })
    expect((await checkProofLink("https://github.com/acme/app/commit/fff9999", "pushed", { commit })).state).toBe("unverifiable")
  })

  it("opens a GitLab-style link on another host as a plain page", async () => {
    const page = server({ "https://other.example.org/g/app/-/issues/9": () => new Response("issue", { status: 200 }) })
    const before = forge.calls.length
    const r = await checkProofLink("https://other.example.org/g/app/-/issues/9", "done", { ...ctx, fetch: page.fetch })
    expect(r.state).toBe("verified")
    expect(page.asked).toEqual(["https://other.example.org/g/app/-/issues/9"])
    expect(forge.calls.length).toBe(before)
  })
})

describe("checkProofLink: other links through the URL check (#2122)", () => {
  it("verifies a page that answers 2xx and holds the ref the claim names", async () => {
    const s = server({ "https://docs.example.com/release": () => new Response("Released in abc1234f, see #42", { status: 200 }) })
    const fetch = guardedFetch({ fetch: s.fetch, lookup: PUBLIC })
    expect(await checkProofLink("https://docs.example.com/release", "deployed abc1234f", { fetch })).toEqual({ state: "verified", detail: 'https://docs.example.com/release answered with "abc1234f"' })
    expect((await checkProofLink("https://docs.example.com/release", "shipped #42", { fetch })).state).toBe("verified")
  })

  it("fails a page that is missing, or does not hold the ref", async () => {
    const s = server({
      "https://docs.example.com/gone": () => new Response("no", { status: 404 }),
      "https://docs.example.com/release": () => new Response("Released", { status: 200 }),
    })
    const fetch = guardedFetch({ fetch: s.fetch, lookup: PUBLIC })
    expect(await checkProofLink("https://docs.example.com/gone", "done", { fetch })).toEqual({ state: "failed", detail: "https://docs.example.com/gone answered HTTP 404" })
    expect((await checkProofLink("https://docs.example.com/release", "shipped #42", { fetch })).state).toBe("failed")
  })

  it("is unverifiable for a private link, a timeout, or no link at all", async () => {
    const fetch = guardedFetch({ fetch: server({}).fetch, lookup: PUBLIC })
    expect((await checkProofLink("http://192.168.1.10/report", "done", { fetch })).state).toBe("unverifiable")
    expect((await checkProofLink("https://docs.example.com/slow", "done", { fetch: (async () => { throw new Error("The operation was aborted due to timeout") }) as unknown as typeof fetch })).state).toBe("unverifiable")
    expect((await checkProofLink("see the drive folder", "done", { fetch })).state).toBe("unverifiable")
    expect((await checkProofLink("file:///etc/passwd", "done", { fetch })).state).toBe("unverifiable")
  })

  it("takes a sha or an issue number from the claim, not a plain number", () => {
    expect(claimedRef("fixed in 9f3e2a1b")).toBe("9f3e2a1b")
    expect(claimedRef("closes #2122")).toBe("#2122")
    expect(claimedRef("merged !17")).toBe("!17")
    expect(claimedRef("took 1234567 ms")).toBeNull()
    expect(claimedRef("done")).toBeNull()
  })
})

describe("settle records what the link check found (#2122)", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  let tmp: string
  let db: Database.Database
  let store: RequestStore

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-proof-link-"))
    db = new Database(path.join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    const tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "ship the fix", fullMessage: "ship the fix",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const forge = reader({
    "github:acme/app#12": { state: "merged", url: "https://github.com/acme/app/pull/12" },
    "github:acme/app#13": { state: "open", url: "https://github.com/acme/app/pull/13" },
  })

  it("a link that checks out is recorded verified", async () => {
    const link = "https://github.com/acme/app/pull/12"
    const verify = proofVerify(await checkProofLink(link, "merged", { forge }))
    store.progress("req-t1", 5_500)
    expect(store.settle("req-t1", link, "Handed work came back done.", 6_000, verify)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({
      state: "done", closedBy: "settle", verifyState: "verified", verifiedAt: 6_000,
      verifyDetail: "Handed work came back done. Link checked: https://github.com/acme/app/pull/12 is merged",
    })
  })

  it("a link that does not check out stays unverified, with the reason", async () => {
    const link = "https://github.com/acme/app/pull/13"
    const verify = proofVerify(await checkProofLink(link, "merged", { forge }))
    store.progress("req-t1", 5_500)
    expect(store.settle("req-t1", link, "Handed work came back done.", 6_000, verify)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({
      state: "done", verifyState: "unverified", verifiedAt: null,
      verifyDetail: "Handed work came back done. Link did not check out: https://github.com/acme/app/pull/13 is open",
    })
  })

  it("without a check, settle is unverified as before", () => {
    store.progress("req-t1", 5_500)
    expect(store.settle("req-t1", "https://github.com/acme/app/pull/12", "Handed work came back done.", 6_000)).toBe(true)
    expect(store.get("req-t1")).toMatchObject({ verifyState: "unverified", verifyDetail: "Handed work came back done.", verifiedAt: null })
  })
})
