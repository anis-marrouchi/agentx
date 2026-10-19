import type { Output } from "../../src/native/macos/run"

// An in-memory remindctl 0.1.1 for tests: the subcommands and flags the
// macOS adapter uses, behaving the way the real tool does where it
// matters: a value that starts with "-" is an error, an unknown list is an
// error, a due time keeps only the minute, and an id matches by a prefix
// of at least four characters, in any case.

interface Item { id: string; title: string; notes?: string; dueDate?: string; isCompleted: boolean; listName: string; priority: string }

export function fakeRemindctl(lists: string[] = []): Output & { items: Item[]; lists: string[] } {
  const items: Item[] = []
  let next = 1
  const fn = (async (_file: string, args: string[]) => {
    const [verb, ...rest] = args
    const opts: Record<string, string | true> = {}
    const pos: string[] = []
    const flags = new Set(["--json", "--no-input", "--force", "--clear-due", "--create"])
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if (flags.has(a)) opts[a] = true
      else if (a.startsWith("--")) {
        const v = rest[++i]
        if (v === undefined || v.startsWith("-")) throw new Error(`Missing value for option ${a.slice(2)}`)
        opts[a] = v
      } else pos.push(a)
    }
    const find = (id: string) => {
      const it = id.length >= 4 ? items.find((r) => r.id.toLowerCase().startsWith(id.toLowerCase())) : undefined
      if (!it) throw new Error(`Reminder not found: ${id}`)
      return it
    }
    const due = (v: string) => new Date(Math.floor(new Date(v).getTime() / 60_000) * 60_000).toISOString()
    const known = (list: unknown) => {
      if (!lists.includes(String(list))) throw new Error(`List not found: "${list}".`)
      return String(list)
    }
    switch (verb) {
      case "list":
        if (pos[0] && opts["--create"]) { lists.push(pos[0]); return JSON.stringify([{ id: `L-${lists.length}`, title: pos[0], reminderCount: 0, overdueCount: 0 }]) }
        return JSON.stringify(lists.map((title, i) => ({ id: `L-${i}`, title, reminderCount: 0, overdueCount: 0 })))
      case "show":
        return JSON.stringify(items.filter((r) => r.listName === known(opts["--list"])))
      case "add": {
        known(opts["--list"])
        const it: Item = { id: `FAKE-${next++}-0000`, title: String(opts["--title"]), notes: (opts["--notes"] as string) || undefined, isCompleted: false, listName: String(opts["--list"]), priority: (opts["--priority"] as string) ?? "none" }
        if (opts["--due"]) it.dueDate = due(opts["--due"] as string)
        items.push(it)
        return JSON.stringify(it)
      }
      case "edit": {
        const it = find(pos[0])
        if (opts["--title"] !== undefined) it.title = opts["--title"] as string
        if (opts["--notes"] !== undefined) it.notes = opts["--notes"] as string
        if (opts["--due"]) it.dueDate = due(opts["--due"] as string)
        if (opts["--clear-due"]) delete it.dueDate
        return JSON.stringify(it)
      }
      case "complete":
        find(pos[0]).isCompleted = true
        return "[]"
      case "delete":
        items.splice(items.indexOf(find(pos[0])), 1)
        return "1"
      default:
        throw new Error(`fake remindctl: no ${verb}`)
    }
  }) as Output & { items: Item[]; lists: string[] }
  fn.items = items
  fn.lists = lists
  return fn
}
