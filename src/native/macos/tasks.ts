import type { NativeTask, NativeTasks } from "../types"
import { output as defaultOutput, type Output } from "./run"

// Apple Reminders through remindctl (Homebrew). It is the same tool the
// mac-pim skill uses, so the daemon and the skill see the same lists. The
// first call from the daemon's process triggers the macOS Reminders
// permission prompt.
//
// Every value travels as its own argv entry, never through a shell, so
// quotes and newlines arrive as typed. remindctl 0.1.1 reads any value
// that starts with "-" as an option (and a value equal to --help or
// --version runs that), and has no "--opt=value" form, so such a value
// gets an invisible zero-width space in front. Reminders keeps that
// character; listOpen takes it off again. A list name is a lookup key and
// cannot carry it, so a list name that starts with "-" is refused.
//
// Reminders keeps a due time to the minute, in this Mac's time zone:
// seconds are dropped.

const ZWSP = "\u200b"

/** A value remindctl takes literally. */
export function argValue(v: string): string {
  return v.startsWith("-") ? ZWSP + v : v
}

const unArg = (v: string | undefined): string | undefined => (v?.startsWith(ZWSP + "-") ? v.slice(1) : v)

function listName(list: string): string {
  if (!list.trim() || list.startsWith("-")) throw new Error(`Reminders list name "${list}" is not usable: it must not be empty or start with "-"`)
  return list
}

/** ISO to the minute, which is all Reminders keeps. */
const isoDue = (d: Date): string => new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")

export function macosTasks(command = "remindctl", exec: Output = defaultOutput): NativeTasks {
  return {
    async ensureList(list) {
      const raw = await exec(command, ["list", "--json", "--no-input"])
      const lists = JSON.parse(raw.trim() || "[]")
      if (!Array.isArray(lists)) throw new Error(`${command} list: expected a JSON array`)
      if (lists.some((l: { title?: string }) => l?.title === list)) return
      await exec(command, ["list", listName(list), "--create", "--json", "--no-input"])
    },
    async listOpen(list) {
      const raw = await exec(command, ["show", "all", "--list", listName(list), "--json", "--no-input"])
      const items = JSON.parse(raw.trim() || "[]")
      if (!Array.isArray(items)) throw new Error(`${command} show: expected a JSON array`)
      return items
        .filter((r: NativeTask) => r && typeof r.id === "string" && !r.isCompleted)
        .map((r: NativeTask) => ({ ...r, title: unArg(r.title) ?? "", ...(r.notes !== undefined ? { notes: unArg(r.notes) } : {}) }))
    },
    async add({ list, title, notes, due, priority }) {
      const args = ["add", "--title", argValue(title), "--list", listName(list), "--notes", argValue(notes)]
      if (due) args.push("--due", isoDue(due))
      if (priority && priority !== "none") args.push("--priority", priority)
      const raw = await exec(command, [...args, "--json", "--no-input"])
      let id: unknown
      try { id = JSON.parse(raw.trim())?.id } catch { id = undefined }
      if (typeof id !== "string" || !id) throw new Error(`${command} add: no reminder id in its answer`)
      return { id }
    },
    async update(id, patch) {
      const args = ["edit", id]
      if (patch.title !== undefined) args.push("--title", argValue(patch.title))
      if (patch.notes !== undefined) args.push("--notes", argValue(patch.notes))
      if (patch.due === null) args.push("--clear-due")
      else if (patch.due) args.push("--due", isoDue(patch.due))
      // remindctl refuses an edit that changes nothing; so does this.
      if (args.length === 2) return
      await exec(command, [...args, "--json", "--no-input"])
    },
    async complete(id) {
      await exec(command, ["complete", id, "--json", "--no-input"])
    },
    async remove(id) {
      await exec(command, ["delete", id, "--force", "--json", "--no-input"])
    },
  }
}
