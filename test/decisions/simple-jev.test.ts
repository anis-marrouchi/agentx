import { describe, it, expect, vi } from "vitest"
import { createSimpleJevBackend } from "../../src/decisions/backends/simple-jev"
import { registerBuiltinDecisionBackends } from "../../src/decisions"
import {
  _resetDecisionBackendsForTesting,
  getDecisionBackend,
} from "../../src/decisions/backend"
import { choice, noul, score } from "../../src/decisions/questions"
import { normalizedNegEntropy } from "../../src/decisions/normalize"
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../../src/decisions/types"

const questions = {
  route: choice({ billing: "money", technical: "engineering" }),
  refund: noul("Does the customer ask for money back?"),
  urgency: score(["calm", "annoyed", "furious"]),
}

/** A response in simple-jev's documented shape. */
const body = {
  model: "featherless-ai/Qwen3.8-27B-classifier",
  answers: {
    route: { type: "choice", choice: "billing", confidence: 0.95, probabilities: { billing: 0.95, technical: 0.05 } },
    refund: { type: "noul", noul: 0.9 },
    urgency: {
      type: "score", score: 1.1, confidence: 0.6,
      probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
      legend: { "0": "calm", "1": "annoyed", "2": "furious" },
    },
  },
  usage: { input_tokens: 699, output_tokens: 2 },
}

function mockFetch(handler: (url: string, init: any) => any) {
  return vi.fn(async (url: any, init: any) => handler(String(url), init)) as any
}

function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("simple-jev backend", () => {
  it("posts state and questions to /classifier", async () => {
    let seen: any = null
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1",
      model: "m1",
      fetchImpl: mockFetch((url, init) => {
        seen = { url, body: JSON.parse(init.body) }
        return ok(body)
      }),
    })

    await backend.decide({ state: "I was charged twice", questions })

    expect(seen.url).toBe("http://jev.test/v1/classifier")
    expect(seen.body.model).toBe("m1")
    expect(seen.body.state).toBe("I was charged twice")
    expect(Object.keys(seen.body.questions).sort()).toEqual(["refund", "route", "urgency"])
    // Their wire format takes our question objects unchanged.
    expect(seen.body.questions.route.criteria).toEqual({ billing: "money", technical: "engineering" })
  })

  it("recomputes confidence instead of trusting theirs", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(() => ok(body)),
    })
    const res = await backend.decide({ state: "x", questions })
    const route = res.answers.route as ChoiceAnswer

    // simple-jev reports the largest probability (0.95). That is not
    // comparable across option counts, so we use normalized entropy.
    expect(route.pMax).toBeCloseTo(0.95, 10)
    expect(route.confidence).toBeCloseTo(normalizedNegEntropy({ billing: 0.95, technical: 0.05 }), 10)
    expect(route.confidence).not.toBeCloseTo(0.95, 2)
    expect(route.choice).toBe("billing")
  })

  it("carries score and noul through with our own derivations", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(() => ok(body)),
    })
    const res = await backend.decide({ state: "x", questions })

    const urgency = res.answers.urgency as ScoreAnswer
    expect(urgency.score).toBeCloseTo(1.0, 10) // 0*0.2 + 1*0.6 + 2*0.2
    expect(urgency.legend).toEqual({ "0": "calm", "1": "annoyed", "2": "furious" })
    expect((res.answers.refund as NoulAnswer).noul).toBe(0.9)
    expect("confidence" in res.answers.refund).toBe(false)
  })

  it("reports logits as the source and never pools with verbalized rows", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(() => ok(body)),
    })
    expect(backend.capabilities.probabilitySource).toBe("logits")
    // Reading real logits is not the same as being calibrated to correctness,
    // and simple-jev says so about its own output.
    expect(backend.capabilities.calibratedProbabilities).toBe(false)

    const res = await backend.decide({ state: "x", questions })
    expect(res.meta.structureMode).toBe("logprobs")
    expect(res.usage).toEqual({ inputTokens: 699, outputTokens: 2 })
  })

  it("rejects more options than the server accepts, before spending a call", async () => {
    const fetchImpl = mockFetch(() => ok(body))
    const backend = createSimpleJevBackend({ baseUrl: "http://jev.test/v1", model: "m1", fetchImpl })
    const criteria: Record<string, null> = {}
    for (let i = 0; i < 60; i++) criteria[`opt${i}`] = null

    await expect(
      backend.decide({ state: "x", questions: { big: choice(criteria) } }),
    ).rejects.toThrow(/at most 50 choice options, got 60/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("fails loudly on contract drift rather than retrying", async () => {
    const fetchImpl = mockFetch(() => ok({ ...body, answers: { route: { type: "choice" } } }))
    const backend = createSimpleJevBackend({ baseUrl: "http://jev.test/v1", model: "m1", fetchImpl })

    await expect(backend.decide({ state: "x", questions })).rejects.toThrow(
      /contract drift, not a model slip/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1) // no correction round
  })

  it("surfaces an HTTP error with the server's detail", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(() => new Response("model not available", { status: 404 })),
    })
    await expect(backend.decide({ state: "x", questions })).rejects.toThrow(
      /simple-jev 404: model not available/,
    )
  })

  it("truncates an oversized state and says so", async () => {
    let sent = ""
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1", maxStateChars: 100,
      fetchImpl: mockFetch((_u, init) => {
        sent = JSON.parse(init.body).state
        return ok(body)
      }),
    })
    const res = await backend.decide({ state: "x".repeat(5000), questions })
    expect(res.meta.stateTruncated).toBe(true)
    expect(sent.length).toBeLessThan(200)
  })

  it("sends a bearer token when one is configured", async () => {
    process.env.JEV_TEST_KEY = "sk-test"
    let headers: any = null
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1", apiKeyEnv: "JEV_TEST_KEY",
      fetchImpl: mockFetch((_u, init) => {
        headers = init.headers
        return ok(body)
      }),
    })
    await backend.decide({ state: "x", questions })
    expect(headers.Authorization).toBe("Bearer sk-test")
    delete process.env.JEV_TEST_KEY
  })

  it("supplies instructions the server requires but our contract makes optional", async () => {
    // Found by the live test, not the mocks: simple-jev rejects a question
    // with no `instructions` (422), while TypeSafe's own SDK types mark the
    // field optional. One question set has to run on every backend or the
    // whole comparison falls apart, so the backend adapts.
    let sent: any = null
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch((_u, init) => {
        sent = JSON.parse(init.body).questions
        return ok(body)
      }),
    })

    await backend.decide({
      state: "x",
      questions: {
        route: choice({ billing: null, technical: null }), // no instructions
        refund: noul("Does the customer ask for money back?"), // has them
      },
    })

    expect(sent.route.instructions).toBe("Which option best fits?")
    expect(sent.refund.instructions).toBe("Does the customer ask for money back?")
  })

  it("does not mutate the caller's questions, which are what get recorded", async () => {
    const original = { route: choice({ billing: null, technical: null }) }
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(() => ok({ ...body, answers: { route: body.answers.route } })),
    })
    await backend.decide({ state: "x", questions: original })
    expect(original.route.instructions).toBeUndefined()
  })

  it("requires a model id rather than guessing one", async () => {
    const backend = createSimpleJevBackend({ baseUrl: "http://jev.test/v1" })
    await expect(backend.decide({ state: "x", questions })).rejects.toThrow(/needs a model id/)
  })

  it("cancels in flight when the caller aborts", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "http://jev.test/v1", model: "m1",
      fetchImpl: mockFetch(
        (_u, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
          }),
      ),
    })
    const controller = new AbortController()
    const pending = backend.decide({ state: "x", questions, abortSignal: controller.signal })
    const assertion = expect(pending).rejects.toThrow(/Abort/i)
    controller.abort()
    await assertion
  })
})

describe("as a generic System One endpoint", () => {
  it("targets a different route and reports its own name", async () => {
    let url = ""
    const backend = createSimpleJevBackend({
      name: "jev",
      baseUrl: "https://openrouter.ai/api/alpha",
      path: "/decisions",
      model: "jev-latest",
      probabilitySource: "native",
      maxChoiceOptions: 255,
      fetchImpl: mockFetch((u) => {
        url = u
        return ok(body)
      }),
    })

    expect(backend.name).toBe("jev")
    expect(backend.capabilities.probabilitySource).toBe("native")
    // A claimed training objective is not a measured property.
    expect(backend.capabilities.calibratedProbabilities).toBe(false)

    const res = await backend.decide({ state: "x", questions })
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(res.meta.backend).toBe("jev")
    // structure_mode must track the mechanism, or calibration pools a
    // trained decision model with logit-reading over an untrained one.
    expect(res.meta.structureMode).toBe("native")
  })

  it("names itself in an error rather than saying simple-jev", async () => {
    const backend = createSimpleJevBackend({
      name: "jev", baseUrl: "https://openrouter.ai/api/alpha", path: "/decisions", model: "m",
      fetchImpl: mockFetch(() => new Response("nope", { status: 500 })),
    })
    await expect(backend.decide({ state: "x", questions })).rejects.toThrow(/^jev 500: nope/)
  })

  it("registers as a distinct backend with its own limits", async () => {
    _resetDecisionBackendsForTesting()
    registerBuiltinDecisionBackends()
    const jev = getDecisionBackend("jev")
    expect(jev.capabilities.maxChoiceOptions).toBe(255)
    expect(getDecisionBackend("simple-jev").capabilities.maxChoiceOptions).toBe(50)
    _resetDecisionBackendsForTesting()
  })
})

// Live check against the public demo. Off by default: it is rate limited to
// 2 RPS and the state below is synthetic on purpose — no fleet data leaves
// the machine for a third-party endpoint.
const live = process.env.AGENTX_SIMPLE_JEV_LIVE === "1"
describe.skipIf(!live)("simple-jev — live demo", () => {
  it("returns a logit-shaped distribution", async () => {
    const backend = createSimpleJevBackend({
      baseUrl: "https://simple-jev-demo-api.featherless.ai/v1",
      model: "featherless-ai/Qwen3.8-27B-classifier",
      timeoutMs: 60_000,
    })
    const res = await backend.decide({
      state: "The nightly deploy cron has failed four days running with exit code 1, but every run record says success:true",
      questions: {
        cause: choice({
          infrastructure: "The machine or network is at fault",
          "application-bug": "The deployed code is at fault",
          "monitoring-gap": "The failure is real but reported as success",
        }),
      },
    })
    const cause = res.answers.cause as ChoiceAnswer
    expect(cause.choice).toBe("monitoring-gap")
    // A verbalized distribution lands on round numbers; a logit one does not.
    expect(Object.values(cause.probabilities).some((p) => p > 0 && p < 0.001)).toBe(true)
    expect(res.usage.outputTokens).toBeLessThan(10)
  }, 90_000)
})

// Live check against Jev through OpenRouter. Off by default: it costs real
// money (about $2e-05 a call) and needs OPENROUTER_API_KEY. The state is
// synthetic on purpose — no fleet data goes to a third party.
const liveJev = process.env.AGENTX_JEV_LIVE === "1" && Boolean(process.env.OPENROUTER_API_KEY)
describe.skipIf(!liveJev)("jev via OpenRouter — live", () => {
  it("answers all three primitives and is the real TypeSafe model", async () => {
    _resetDecisionBackendsForTesting()
    registerBuiltinDecisionBackends()
    const backend = getDecisionBackend("jev")

    const res = await backend.decide({
      state: "The nightly deploy cron has failed four days running with exit code 1, but every run record says success:true",
      questions: {
        cause: choice({
          infrastructure: "The machine or network is at fault",
          "application-bug": "The deployed code is at fault",
          "monitoring-gap": "The failure is real but reported as success",
        }),
        page: noul("Should a human be paged right now?"),
        severity: score(["trivial", "annoying", "serious", "critical"]),
      },
      timeoutMs: 60_000,
    })

    expect(res.model).toMatch(/jev/i)
    expect((res.answers.cause as ChoiceAnswer).choice).toBe("monitoring-gap")
    expect((res.answers.page as NoulAnswer).noul).toBeGreaterThan(0.5)
    expect((res.answers.severity as ScoreAnswer).score).toBeGreaterThan(1)
    expect(res.meta.backend).toBe("jev")
    _resetDecisionBackendsForTesting()
  }, 90_000)
})

// Live check against TypeSafe direct. Needs TYPESAFE_API_KEY; the state is
// synthetic on purpose.
const liveTypesafe =
  process.env.AGENTX_TYPESAFE_LIVE === "1" && Boolean(process.env.TYPESAFE_API_KEY)
describe.skipIf(!liveTypesafe)("typesafe direct — live", () => {
  it("round-trips all three primitives on /v1/systemone", async () => {
    _resetDecisionBackendsForTesting()
    registerBuiltinDecisionBackends()
    const backend = getDecisionBackend("typesafe")

    const res = await backend.decide({
      state: "The nightly deploy cron has failed four days running with exit code 1, but every run record says success:true",
      questions: {
        cause: choice({
          infrastructure: "The machine or network is at fault",
          "application-bug": "The deployed code is at fault",
          "monitoring-gap": "The failure is real but reported as success",
        }),
        page: noul("Should a human be paged right now?"),
        severity: score(["trivial", "annoying", "serious", "critical"]),
      },
      timeoutMs: 60_000,
    })

    expect(res.model).toMatch(/jev/i)
    expect(res.meta.backend).toBe("typesafe")
    expect(res.meta.structureMode).toBe("native")
    expect((res.answers.cause as ChoiceAnswer).choice).toBe("monitoring-gap")
    expect((res.answers.page as NoulAnswer).noul).toBeGreaterThan(0.5)
    // Severity lands between "serious" and "critical", not on an integer.
    const sev = (res.answers.severity as ScoreAnswer).score
    expect(sev).toBeGreaterThan(2)
    expect(sev).toBeLessThan(3)
    _resetDecisionBackendsForTesting()
  }, 90_000)
})
