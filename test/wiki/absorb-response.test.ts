import { afterEach, describe, expect, it } from "vitest"
import { absorbModel, parseAbsorbResponse } from "../../src/wiki/absorb-response"

const article = (content: string) => ({
  path: "events/review.md",
  title: "Review",
  tags: ["review"],
  content,
  sources: ["mukvy4eo"],
})

describe("parseAbsorbResponse", () => {
  it("reads articles and gaps", () => {
    const reply = JSON.stringify({ articles: [article("ok")], gaps: ["Voice app"] })
    expect(parseAbsorbResponse(reply)).toEqual({ articles: [article("ok")], gaps: ["Voice app"] })
  })

  // The 2026-10-07 A/B: a faithful article quoted "`${`" from the review,
  // the old brace counter saw one `{` too many, and the run ended with
  // "Unbalanced JSON" for both models.
  it("is not thrown by braces inside article text", () => {
    const content = "- **Locked-page inline script:** no backslashes, backticks or `${`."
    const reply = `Here are the articles:\n${JSON.stringify({ articles: [article(content)], gaps: [] })}\nDone.`
    const parsed = parseAbsorbResponse(reply)
    expect("error" in parsed).toBe(false)
    if (!("error" in parsed)) expect(parsed.articles[0].content).toBe(content)
  })

  it("reads a fenced reply whose article text has its own code fence", () => {
    const content = "Repro:\n```bash\necho \"${HOME}\"\n```"
    const reply = "```json\n" + JSON.stringify({ articles: [article(content)], gaps: [] }) + "\n```"
    const parsed = parseAbsorbResponse(reply)
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.articles[0].content).toBe(content)
  })

  it("accepts a legacy bare array", () => {
    expect(parseAbsorbResponse(JSON.stringify([article("x")]))).toEqual({ articles: [article("x")], gaps: [] })
  })

  it("reports a reply with no JSON", () => {
    expect(parseAbsorbResponse("I could not do that.")).toEqual({ error: "no JSON found in response" })
  })

  it("reports truncated JSON", () => {
    expect(parseAbsorbResponse('{"articles": [{"path": "a.md"')).toEqual({ error: "no parseable JSON in response" })
  })
})

describe("absorbModel", () => {
  const saved = process.env.AGENTX_WIKI_ABSORB_MODEL
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTX_WIKI_ABSORB_MODEL
    else process.env.AGENTX_WIKI_ABSORB_MODEL = saved
  })

  it("defaults to sonnet", () => {
    delete process.env.AGENTX_WIKI_ABSORB_MODEL
    expect(absorbModel()).toBe("sonnet")
  })

  it("takes the environment, and --model over it", () => {
    process.env.AGENTX_WIKI_ABSORB_MODEL = "opus"
    expect(absorbModel()).toBe("opus")
    expect(absorbModel("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5[1m]")
  })

  it("refuses anything that is not a model name", () => {
    expect(() => absorbModel("sonnet'; rm -rf ~; '")).toThrow(/not a model name/)
  })
})
