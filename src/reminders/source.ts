import { execFile } from "child_process"

// --- Apple Reminders through remindctl ---
//
// remindctl (Homebrew) is the same tool the mac-pim skill uses, so the
// daemon and the skill see the same lists. The first call from the daemon's
// process triggers the macOS Reminders permission prompt.

export interface Reminder {
  id: string
  title: string
  notes?: string
  /** ISO time; absent for reminders without a due date. */
  dueDate?: string
  isCompleted: boolean
  listName?: string
}

export interface ReminderSource {
  /** Open (not completed) reminders in one list. */
  listOpen(list: string): Promise<Reminder[]>
  /** Tick one off, by full id. */
  complete(id: string): Promise<void>
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args[0]}: ${(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })
}

export function remindctlSource(command = "remindctl"): ReminderSource {
  return {
    async listOpen(list) {
      const raw = await run(command, ["show", "all", "--list", list, "--json", "--no-input"])
      const items = JSON.parse(raw.trim() || "[]")
      if (!Array.isArray(items)) throw new Error(`${command} show: expected a JSON array`)
      return items.filter((r: Reminder) => r && typeof r.id === "string" && !r.isCompleted)
    },
    async complete(id) {
      await run(command, ["complete", id, "--json", "--no-input"])
    },
  }
}
