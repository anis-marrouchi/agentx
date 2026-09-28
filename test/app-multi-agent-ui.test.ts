import { describe, expect, it } from "vitest"
import { renderAppPage, APP_SERVICE_WORKER } from "../src/daemon/ui/pages/app"
import { APP_CHAT_STRIP_SCRIPT } from "../src/daemon/ui/pages/app-chat-strip.client"
import { APP_CHAT_SHEETS_SCRIPT } from "../src/daemon/ui/pages/app-chat-sheets.client"
import { APP_CHAT_LOG_SCRIPT } from "../src/daemon/ui/pages/app-chat-log.client"
import { APP_CHAT_SCRIPT } from "../src/daemon/ui/pages/app-chat.client"
import { APP_ALERTS_SCRIPT } from "../src/daemon/ui/pages/app-alerts.client"
import { APP_VOICE_SCRIPT } from "../src/daemon/ui/pages/app-voice.client"
import { nextSpeech, queueSpeech, SPEECH_QUEUE_MAX, type SpeechItem } from "../src/daemon/ui/pages/app-speech-queue"
import { injectFns } from "../src/daemon/ui/inject"

// The phone side of juggling several agents (#265): the page scripts, and
// the speaking queue's rules.

const item = (key: string, announce?: string): SpeechItem => ({ key, conversationId: `c-${key}`, text: `answer ${key}`, ...(announce ? { announce } : {}) })

describe("the speaking queue", () => {
  it("says answers in the order they finished, one at a time", () => {
    let q: SpeechItem[] = []
    for (const k of ["a", "b", "c"]) q = queueSpeech(q, item(k)).queue
    const said: string[] = []
    let speaking = false
    // Nothing is taken while something is being said or recorded.
    expect(nextSpeech(q, true).item).toBeNull()
    for (let i = 0; i < 5; i++) {
      const r = nextSpeech(q, speaking)
      q = r.queue
      if (!r.item) break
      speaking = true
      said.push(r.item.key)
      // A new answer while speaking waits its turn.
      if (r.item.key === "a") q = queueSpeech(q, item("d")).queue
      expect(nextSpeech(q, speaking).item).toBeNull()
      speaking = false
    }
    expect(said).toEqual(["a", "b", "c", "d"])
  })

  it("never queues the same answer twice", () => {
    const q = queueSpeech([item("a")], item("a"))
    expect(q.queue).toHaveLength(1)
    expect(q.dropped).toEqual([])
  })

  it("keeps at most the cap and drops the oldest waiting answers", () => {
    let q: SpeechItem[] = []
    const dropped: string[] = []
    for (let i = 0; i < SPEECH_QUEUE_MAX + 2; i++) {
      const r = queueSpeech(q, item(String(i), `Agent ${i}`), SPEECH_QUEUE_MAX)
      q = r.queue
      dropped.push(...r.dropped.map((d) => d.key))
    }
    expect(q.map((x) => x.key)).toEqual(["2", "3", "4", "5", "6"])
    expect(dropped).toEqual(["0", "1"])
    expect(queueSpeech([], item("x"), 0).queue).toHaveLength(1) // a cap below 1 still says the newest
  })

  it("works the same once shipped to the page", () => {
    const g: any = {}
    new Function("globalThis", injectFns({ queueSpeech, nextSpeech }).replace(/const /g, "var "))(g)
    const r = g.queueSpeech([item("a")], item("b"), 1)
    expect(r.queue.map((x: SpeechItem) => x.key)).toEqual(["b"])
    expect(g.nextSpeech(r.queue, false).item.key).toBe("b")
  })
})

describe("page scripts", () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

  it("loads the strip after Chat and the voice bar, and every inline script parses", () => {
    const all = scripts(renderAppPage())
    const chat = all.findIndex((s) => s.includes("window.AXChat ="))
    const voice = all.findIndex((s) => s.includes("window.AXVoice ="))
    const strip = all.findIndex((s) => s.includes("window.AXStrip ="))
    expect(chat).toBeGreaterThanOrEqual(0)
    expect(strip).toBeGreaterThan(voice)
    const c = all[chat]
    expect(c.indexOf("window.AXChatLog =")).toBeLessThan(c.indexOf("window.AXChatLog({"))
    expect(c.indexOf("window.AXChatSheets =")).toBeLessThan(c.indexOf("window.AXChatSheets({"))
    expect(all[voice].indexOf("queueSpeech")).toBeLessThan(all[voice].indexOf("window.AXVoice ="))
    for (const s of all) expect(() => new Function(s)).not.toThrow()
  })

  it("hold no backslash, backtick or dollar-brace (they break inside the template literal)", () => {
    for (const s of [APP_CHAT_STRIP_SCRIPT, APP_CHAT_SHEETS_SCRIPT, APP_CHAT_LOG_SCRIPT, APP_CHAT_SCRIPT, APP_ALERTS_SCRIPT, APP_VOICE_SCRIPT]) {
      expect(s).not.toContain("\\")
      expect(s).not.toContain("`")
      expect(s).not.toContain("${")
    }
  })

  it("a notification's link opens its conversation", () => {
    // The worker hands an in-app link to the open app, or opens it.
    expect(APP_SERVICE_WORKER).toContain("postMessage({ type: 'agentx-open', url: target })")
    expect(APP_SERVICE_WORKER).toContain("openWindow(target)")
    // The tab bar leaves #chat=<id> alone, and Chat opens that conversation.
    expect(renderAppPage()).toContain("location.hash.split('=')[0]")
    const m = /var m = (\/.+\/)\.exec\(location\.hash\)/.exec(APP_CHAT_SCRIPT)!
    const re = new Function(`return ${m[1]}`)() as RegExp
    expect(re.exec("#chat=cmg1abc2def3")?.[1]).toBe("cmg1abc2def3")
    expect(re.test("#chat=../x")).toBe(false)
    expect(re.test("#alerts")).toBe(false)
  })
})
