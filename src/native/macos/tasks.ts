import type { NativeTask, NativeTasks } from "../types"
import { output as defaultOutput, type Output } from "./run"

// Apple Reminders through remindctl (Homebrew). It is the same tool the
// mac-pim skill uses, so the daemon and the skill see the same lists. The
// first call from the daemon's process triggers the macOS Reminders
// permission prompt.

const notYet = (verb: string) => () => Promise.reject(new Error(`Reminders ${verb} is not built yet (#1062 step 4)`))

export function macosTasks(command = "remindctl", exec: Output = defaultOutput): NativeTasks {
  return {
    async listOpen(list) {
      const raw = await exec(command, ["show", "all", "--list", list, "--json", "--no-input"])
      const items = JSON.parse(raw.trim() || "[]")
      if (!Array.isArray(items)) throw new Error(`${command} show: expected a JSON array`)
      return items.filter((r: NativeTask) => r && typeof r.id === "string" && !r.isCompleted)
    },
    async complete(id) {
      await exec(command, ["complete", id, "--json", "--no-input"])
    },
    add: notYet("add"),
    update: notYet("update"),
    remove: notYet("remove"),
  }
}
