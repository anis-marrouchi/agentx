import { beforeAll, describe, expect, it } from "vitest"
import { computeFunnel, formatShare, funnelGroupValues, funnelSteps, parseFunnel, type FunnelNumber } from "../src/numbers/funnel"
import { funnelsOf, numbersHubReply } from "../src/numbers/hub-api"
import { numbersConfigSchema } from "../src/daemon/config"
import { numFunnelHtml, numFunnelsPageHtml, numSwitchHtml, type HubNumber } from "../src/daemon/ui/pages/wall-numbers"

// Funnels (#1826 N4): an ordered list of numbers, the conversion at each
// step, the biggest drop marked, a tag filter and group by tag.

const W = { periodStart: Date.parse("2026-11-02T00:00:00Z"), periodEnd: Date.parse("2026-11-09T00:00:00Z") }
const n = (id: string, value: number | null, tags: string[] = [], unit: string | null = null): FunnelNumber & HubNumber => ({
  id, name: id.replace(/-/g, " "), unit, tags, latest: { value, ...W },
  ownerAgent: "marketer", target: null, rhythm: "weekly", source: { kind: "manual" }, status: value === null ? "no_reading" : "no_target", statusWords: "", node: "node-a",
})

describe("funnel math", () => {
  const spec = { name: "Client journey", steps: ["visits", "signups", "trials", "paid"] }

  it("gives the conversion at each step and marks the biggest drop", () => {
    const r = computeFunnel(spec, [n("visits", 10000), n("signups", 800), n("trials", 400), n("paid", 100)], [])
    expect(r.steps.map((s) => s.value)).toEqual([10000, 800, 400, 100])
    expect(r.steps.map((s) => s.conversion)).toEqual([null, 0.08, 0.5, 0.25])
    expect(r.dropAt).toBe(1)
    expect(r.steps.map((s) => s.biggestDrop)).toEqual([false, true, false, false])
    expect(r.overall).toBe(0.01)
    expect(r.mixedWindows).toBe(false)
  })

  it("never counts a step with no reading as 0: it and the next have no conversion", () => {
    const r = computeFunnel(spec, [n("visits", 10000), n("signups", null), n("trials", 400), n("paid", 100)], [])
    expect(r.steps[1].value).toBeNull()
    expect(r.steps.map((s) => s.conversion)).toEqual([null, null, null, 0.25])
    expect(r.dropAt).toBe(3)
    // A step whose number is missing has no value either.
    expect(computeFunnel(spec, [n("visits", 5), n("paid", 1)], []).steps[1]).toMatchObject({ value: null, numbers: [], missing: [] })
  })

  it("does not mark a rise, and no drop when every step rises or is flat", () => {
    const r = computeFunnel({ name: "x", steps: ["a", "b"] }, [n("a", 10), n("b", 12)], [])
    expect(r.dropAt).toBe(-1)
    expect(r.steps[1].conversion).toBe(1.2)
    // From 0, there is no conversion.
    expect(computeFunnel({ name: "x", steps: ["a", "b"] }, [n("a", 0), n("b", 0)], []).steps[1].conversion).toBeNull()
  })

  it("sums every number with a step's tag, narrowed by the tags picked, and lists the groups of a tag kind", () => {
    const nums = [
      n("visits-video", 6000, ["step:visit", "channel:video"]), n("visits-mail", 4000, ["step:visit", "channel:mail"]),
      n("signups-video", 300, ["step:signup", "channel:video"]), n("signups-mail", 500, ["step:signup", "channel:mail"]),
      n("other", 7, ["channel:video"]),
    ]
    const spec2 = { name: "By step", steps: [{ name: "Visits", tag: "step:visit" }, { name: "Sign-ups", tag: "step:signup" }] }
    expect(computeFunnel(spec2, nums, []).steps.map((s) => [s.name, s.value])).toEqual([["Visits", 10000], ["Sign-ups", 800]])
    const video = computeFunnel(spec2, nums, ["channel:video"])
    expect(video.steps.map((s) => s.value)).toEqual([6000, 300])
    expect(video.steps[1].conversion).toBe(0.05)
    expect(funnelGroupValues(spec2, nums, "channel")).toEqual(["mail", "video"])
    // A number-id step drops out when its number lacks a tag picked.
    expect(computeFunnel({ name: "x", steps: ["visits-video", "signups-mail"] }, nums, ["channel:video"]).steps[1].value).toBeNull()
  })

  it("names steps by the step's name, else the number's name, and flags mixed windows", () => {
    const later = { ...n("b", 5), latest: { value: 5, periodStart: W.periodEnd, periodEnd: W.periodEnd + 7 * 864e5 } }
    const r = computeFunnel({ name: "x", steps: [{ name: "First", number: "a" }, "b"] }, [n("a", 10), later], [])
    expect(r.steps.map((s) => s.name)).toEqual(["First", "b"])
    expect(r.mixedWindows).toBe(true)
    expect(funnelSteps({ name: "x", steps: ["a", { tag: "Step:Paid" }] })).toEqual([{ name: "", number: "a" }, { name: "", tag: "step:paid" }])
  })

  it("writes shares as percents", () => {
    expect([formatShare(0.08), formatShare(0.625), formatShare(0.0125), formatShare(null)]).toEqual(["8%", "63%", "1.3%", "—"])
  })
})

describe("where a funnel is set up: numbers.funnels in agentx.json", () => {
  it("accepts ids, {number} and {tag} steps and refuses a bad funnel", () => {
    expect(parseFunnel({ name: "Journey", steps: ["a", { number: "b", name: "B" }, { name: "Paid", tag: "step:paid" }] }))
      .toEqual({ name: "Journey", steps: ["a", { name: "B", number: "b" }, { name: "Paid", tag: "step:paid" }] })
    expect(parseFunnel({ name: "x", steps: ["a"] })).toHaveProperty("error")
    expect(parseFunnel({ steps: ["a", "b"] })).toHaveProperty("error")
    expect(parseFunnel({ name: "x", steps: ["a", { number: "b", tag: "t" }] })).toHaveProperty("error")
    expect(numbersConfigSchema.safeParse({ funnels: { journey: { name: "Journey", steps: ["a", "b"] } } }).success).toBe(true)
    const bad = numbersConfigSchema.safeParse({ funnels: { journey: { name: "Journey", steps: ["a"] } } })
    expect(bad.success).toBe(false)
    // None set up: nothing changes.
    expect(numbersConfigSchema.parse({}).funnels).toBeUndefined()
  })

  it("sends the funnels with the Hub's numbers, leaving a bad one out", () => {
    const raw = { journey: { name: "Journey", steps: ["a", "b"] }, broken: { name: "x", steps: [] } }
    expect(funnelsOf(raw)).toEqual([{ id: "journey", name: "Journey", steps: ["a", "b"] }])
    expect(numbersHubReply(null, Date.now(), raw)).toEqual({ count: 0, numbers: [], funnels: [{ id: "journey", name: "Journey", steps: ["a", "b"] }] })
    expect(numbersHubReply(null, Date.now()).funnels).toEqual([])
  })
})

describe("the Funnels view", () => {
  // In the browser these are injected globals beside the view's functions.
  beforeAll(() => Object.assign(globalThis, { computeFunnel, formatShare, funnelGroupValues, funnelSteps }))

  const nums = [
    n("visits-video", 6000, ["step:visit", "channel:video"], "visits"), n("visits-mail", 4000, ["step:visit", "channel:mail"], "visits"),
    n("signups-video", 300, ["step:signup", "channel:video"], "sign-ups"), n("signups-mail", 500, ["step:signup", "channel:mail"], "sign-ups"),
    n("paid-video", 60, ["step:paid", "channel:video"], "clients"), n("paid-mail", null, ["step:paid", "channel:mail"], "clients"),
  ]
  const funnel = { id: "journey", name: "Client journey", node: "node-a", steps: [{ name: "Visits", tag: "step:visit" }, { name: "Sign-ups", tag: "step:signup" }, { name: "Paid", tag: "step:paid" }] }

  it("draws each step with its value, conversion and the biggest drop marked", () => {
    const html = numFunnelHtml(funnel, nums, ["channel:video"], "", false)
    expect(html).toContain('<span class="wfn__name">Visits</span><b>6,000 visits</b>')
    expect(html).toContain("5% of the step before <span class=\"wfn__drop\">biggest drop</span>")
    expect(html).toContain("20% of the step before")
    expect(html).toContain("1% from first to last step")
    expect(html.match(/class="wfn__step is-drop"/g)).toHaveLength(1)
  })

  it("shows a step with a failed read as no reading, with no conversion", () => {
    const html = numFunnelHtml(funnel, nums, ["channel:mail"], "channel: mail", false)
    expect(html).toContain('<li class="wfn__step is-none"><div class="wfn__row"><span class="wfn__name">Paid</span><b>no reading</b>')
    expect(html).toContain("no conversion: a step has no reading")
    expect(html).toContain("no reading for paid-mail")
    expect(html).not.toMatch(/<b>0( clients)?<\/b>/)
  })

  it("groups by a tag kind and filters by tags", () => {
    const page = numFunnelsPageHtml({ list: nums, funnels: [funnel], tags: [], by: "channel", missed: [] })
    expect(page).toContain('aria-label="Funnel: channel: mail, Client journey"')
    expect(page).toContain('aria-label="Funnel: channel: video, Client journey"')
    expect(page).toContain('<option value="channel" selected>tag channel</option>')
    const one = numFunnelsPageHtml({ list: nums, funnels: [funnel], tags: ["channel:video"], by: "channel", missed: [] })
    expect(one).not.toContain("channel: mail,")
    expect(one).toContain('data-ntag="channel:video" aria-pressed="true"')
  })

  it("says how to set one up when there is none, and has a Numbers / Funnels switch", () => {
    expect(numFunnelsPageHtml({ list: nums, funnels: [], tags: [], by: "", missed: [] })).toContain("numbers.funnels")
    expect(numSwitchHtml("funnels")).toContain('data-nview="funnels" aria-selected="true" class="is-on">Funnels')
  })
})
