import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import * as lib from "../scripts/contrib-votes-lib.mjs"

const { countVotes, isVotable, rank, renderPage, renderReadmeBlock, replaceBlock, README_START, README_END } = lib
const settings = JSON.parse(readFileSync(new URL("../contrib/voting.json", import.meta.url), "utf8"))
const reacted = "2026-09-20T00:00:00Z"
const accounts = new Map([
  ["old", "2020-01-01T00:00:00Z"],
  ["author", "2020-01-01T00:00:00Z"],
  ["fresh", "2026-09-15T00:00:00Z"], // 5 days old when reacting
  ["week", "2026-09-13T00:00:00Z"], // exactly 7 days
])

describe("countVotes", () => {
  it("excludes the author, bots, and accounts under the minimum age at reaction time", () => {
    const reactions = [
      { login: "old", type: "User", createdAt: reacted },
      { login: "old", type: "User", createdAt: reacted },
      { login: "author", type: "User", createdAt: reacted },
      { login: "fresh", type: "User", createdAt: reacted },
      { login: "week", type: "User", createdAt: reacted },
      { login: "helper", type: "Bot", createdAt: reacted },
      { login: "renovate[bot]", type: "User", createdAt: reacted },
      { login: "unknown", type: "User", createdAt: reacted },
    ]
    expect(countVotes({ author: "author" }, reactions, accounts, { minAccountAgeDays: 7 })).toBe(2)
    expect(countVotes({ author: "author" }, reactions, accounts, { minAccountAgeDays: 1 })).toBe(3)
  })
})

describe("ranking", () => {
  it("leaves bugs out of voting", () => {
    expect(isVotable({ labels: ["bug", "needs-repro"] }, settings)).toBe(false)
    expect(isVotable({ labels: ["enhancement"] }, settings)).toBe(true)
  })

  it("sorts by votes, older issue first on a tie, and drops zero-vote issues", () => {
    const ranked = rank([
      { number: 9, votes: 3 }, { number: 4, votes: 3 }, { number: 7, votes: 8 }, { number: 1, votes: 0 },
    ])
    expect(ranked.map((i: any) => i.number)).toEqual([7, 4, 9])
  })
})

describe("rendering", () => {
  const issue = (number: number, votes: number) => ({ number, votes, title: `Req | ${number}`, url: `https://x/${number}` })

  it("README block shows the top N with at least minVotes", () => {
    const ranked = [issue(1, 9), issue(2, 7), issue(3, 5), issue(4, 4)]
    const block = renderReadmeBlock(ranked, { minVotes: 5, topN: 2 }, "https://page")
    expect(block).toContain("[#1](https://x/1)")
    expect(block).toContain("[#2](https://x/2)")
    expect(block).not.toContain("#3")
    expect(block).toContain("Req \\| 1")
    expect(block).toContain("[Full ranked list](https://page)")
  })

  it("README block invites votes when nothing qualifies", () => {
    expect(renderReadmeBlock([issue(1, 4)], { minVotes: 5, topN: 5 }, "p")).toContain("No request has 5 votes yet")
  })

  it("replaces only the text between the markers, and fails without them", () => {
    const text = `a\n${README_START}\nold\n${README_END}\nb`
    expect(replaceBlock(text, "new")).toBe(`a\n${README_START}\nnew\n${README_END}\nb`)
    expect(() => replaceBlock("no markers", "x")).toThrow(/markers/)
  })

  it("the page lists everything ranked and follows the docs rule endings", () => {
    const page = renderPage([issue(1, 9), issue(2, 1)], settings, "2026-09-28")
    expect(page).toContain("last changed on 2026-09-28")
    expect(page).toContain("[#2](https://x/2)")
    expect(page.indexOf("## Check it worked")).toBeLessThan(page.indexOf("## If something is wrong"))
  })

  it("the README in the repo has the markers", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    expect(() => replaceBlock(readme, "x")).not.toThrow()
  })
})
