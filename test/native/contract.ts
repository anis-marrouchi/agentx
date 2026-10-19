import { describe, expect, it } from "vitest"
import type { NativeAdapter } from "../../src/native"

// #1062: the cases every NativeAdapter passes, whatever the OS. An OS
// adapter's own test calls runNativeContract with a factory that fakes the
// OS programs, so the same cases run on any machine in CI. A faked task
// app must behave like the real one: what is added is listed until it is
// completed or removed.

const CAPABILITIES = ["tasks", "notes", "banner", "sound", "focus"] as const

export function runNativeContract(name: string, make: () => NativeAdapter): void {
  describe(`NativeAdapter contract: ${name}`, () => {
    it("names a known OS", () => {
      expect(["macos", "windows", "none"]).toContain(make().os)
    })

    it("describe() never throws and matches what the adapter offers", async () => {
      const adapter = make()
      const d = await adapter.describe()
      expect(d.os).toBe(adapter.os)
      for (const c of CAPABILITIES) expect(d[c], c).toBe(adapter[c] !== undefined)
      expect(Array.isArray(d.problems)).toBe(true)
    })

    it("adds, updates, completes and removes a task, when it has tasks", async () => {
      const { tasks } = make()
      if (!tasks) return
      // Task apps keep a due time to the minute.
      const due = new Date("2030-01-02T03:04:00Z")
      await tasks.ensureList("Contract")
      await tasks.ensureList("Contract")
      const { id } = await tasks.add({ list: "Contract", title: "Card: pick a date", notes: "line 1\nline \"2\"", due, priority: "high" })
      expect(typeof id).toBe("string")
      let open = await tasks.listOpen("Contract")
      expect(open).toEqual([expect.objectContaining({ id, title: "Card: pick a date", notes: "line 1\nline \"2\"", isCompleted: false })])
      expect(new Date(open[0].dueDate!).getTime()).toBe(due.getTime())

      await tasks.update(id, { title: "Card: pick a day", due: null })
      open = await tasks.listOpen("Contract")
      expect(open[0]).toMatchObject({ id, title: "Card: pick a day" })
      expect(open[0].dueDate).toBeUndefined()

      await tasks.complete(id)
      expect(await tasks.listOpen("Contract")).toEqual([])

      const second = await tasks.add({ list: "Contract", title: "-starts with a dash", notes: "--help" })
      expect(await tasks.listOpen("Contract")).toEqual([expect.objectContaining({ id: second.id, title: "-starts with a dash", notes: "--help" })])
      await tasks.remove(second.id)
      expect(await tasks.listOpen("Contract")).toEqual([])
    })

    it("explains every missing capability", async () => {
      const d = await make().describe()
      if (CAPABILITIES.some((c) => !d[c])) expect(d.problems.length).toBeGreaterThan(0)
    })
  })
}
