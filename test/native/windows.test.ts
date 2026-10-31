import { describe, expect, it, vi } from "vitest"
import { loadNativeAdapter } from "../../src/native"
import { windowsAdapter } from "../../src/native/windows"
import { POWERSHELL_APP_ID, toastScript } from "../../src/native/windows/banner"
import { idleSecondsFromMs } from "../../src/native/windows/idle"
import { psArgs, psString } from "../../src/native/windows/powershell"
import { runNativeContract } from "./contract"

// #1594: the Windows adapter. PowerShell and the helper are faked, so this
// runs on any OS in CI.

const HELPER = "C:\\Users\\u\\AppData\\Local\\Programs\\AgentX\\agentx-helper.exe"
const MEDIA = "C:\\Windows\\Media"
const WAVS = ["tada.wav", "Windows Notify System Generic.wav", "chimes.wav", "desktop.ini"]
const fakeIo = (over: Record<string, unknown> = {}) => ({
  run: vi.fn(async () => true),
  capture: vi.fn(async () => '{"authorization":"authorized","alertStyle":"banner"}'),
  helper: HELPER as string | null,
  media: MEDIA,
  exists: (p: string) => WAVS.some((w) => p === `${MEDIA}\\${w}`),
  list: () => WAVS,
  ...over,
})

/** The script PowerShell was handed, decoded from -EncodedCommand. */
const script = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le")

runNativeContract("windows", () => windowsAdapter({}, fakeIo()))

describe("Windows adapter (#1594)", () => {
  it("is what win32 gets on auto", () => {
    expect(loadNativeAdapter({}, { platform: "win32", io: fakeIo() }).os).toBe("windows")
    expect(loadNativeAdapter({ native: { adapter: "none" } }, { platform: "win32" }).os).toBe("none")
  })

  it("offers banners, sounds and idle time, and no tasks, notes or Focus", async () => {
    const a = windowsAdapter({}, fakeIo())
    expect([a.banner, a.sound, a.idle].every(Boolean)).toBe(true)
    expect([a.tasks, a.notes, a.focus]).toEqual([undefined, undefined, undefined])
    expect((await a.describe()).problems.join(" ")).toMatch(/no Windows adapter/)
  })

  it("posts a banner through the helper, else a PowerShell toast", async () => {
    const io = fakeIo()
    expect(await windowsAdapter({}, io).banner!.post({ title: "t", message: "m" })).toBe("posted")
    expect(io.run.mock.calls[0]).toEqual([HELPER, ["notify", "--title", "t", "--message", "m"]])

    const bare = fakeIo({ helper: null })
    expect(await windowsAdapter({}, bare).banner!.post({ title: "Deploy", message: "done" })).toBe("posted")
    const [file, args] = bare.run.mock.calls[0] as unknown as [string, string[]]
    expect(file).toBe("powershell.exe")
    expect(script(args)).toContain("CreateTextNode('Deploy')")
    expect(script(args)).toContain(POWERSHELL_APP_ID)

    const down = fakeIo({ run: vi.fn(async () => false) })
    expect(await windowsAdapter({}, down).banner!.post({ title: "t", message: "m" })).toBe("failed")
  })

  it("hands the helper a title or message that starts with -- as the flag's value", async () => {
    const io = fakeIo()
    await windowsAdapter({}, io).banner!.post({ title: "--message", message: "--help" })
    expect(io.run.mock.calls[0]).toEqual([HELPER, ["notify", "--title", "--message", "--message", "--help"]])
  })

  it("keeps quotes in a banner from becoming PowerShell", () => {
    const s = toastScript("it's", "a ’curly’ $(Remove-Item x)")
    expect(s).toContain("CreateTextNode('it''s')")
    expect(s).toContain("CreateTextNode('a ’’curly’’ $(Remove-Item x)')")
    expect(psString("‘x‚‛")).toBe("'‘‘x‚‚‛‛'")
    // The script never sits on the command line as text.
    expect(psArgs("Write-Output 1").join(" ")).not.toContain("Write-Output")
  })

  it("reads the helper's banner permission, or missing without one", async () => {
    const io = fakeIo({ capture: vi.fn(async () => '{"authorization":"denied"}') })
    expect(await windowsAdapter({}, io).banner!.status()).toBe("not-allowed")
    expect(await windowsAdapter({}, fakeIo({ helper: null })).banner!.status()).toBe("missing")
  })

  it("plays system .wav files by name only", async () => {
    const io = fakeIo()
    const sound = windowsAdapter({}, io).sound!
    expect(sound.has("tada")).toBe(true)
    expect(sound.has("..\\..\\x")).toBe(false)
    expect(await sound.names()).toEqual(["Windows Notify System Generic", "chimes", "tada"])
    await sound.play("tada", 0.5)
    expect(script(io.run.mock.calls[0]![1] as string[])).toContain("SoundPlayer 'C:\\Windows\\Media\\tada.wav'")
    await sound.play("tada", 0)
    await sound.play("C:\\evil", 1)
    expect(io.run).toHaveBeenCalledTimes(1)
  })

  it("turns GetLastInputInfo milliseconds into seconds", async () => {
    expect(idleSecondsFromMs("65432\r\n")).toBe(65)
    expect(idleSecondsFromMs("")).toBeNull()
    expect(idleSecondsFromMs("-1")).toBeNull()
    expect(await windowsAdapter({}, fakeIo({ capture: vi.fn(async () => "3000") })).idle!.seconds()).toBe(3)
    expect(await windowsAdapter({}, fakeIo({ capture: vi.fn(async () => null) })).idle!.seconds()).toBeNull()
  })
})
