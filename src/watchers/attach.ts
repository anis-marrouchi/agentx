import type Database from "better-sqlite3"
import { getEventBus } from "@/events/bus"
import { WatcherStore } from "./store"
import { TaskWatcher, type WatcherDeps } from "./watcher"

// --- Hook the task watcher to the daemon's event bus (#1030) ---

export interface AttachedWatchers {
  store: WatcherStore
  watcher: TaskWatcher
  detach: () => void
}

export function attachWatchers(
  db: Database.Database,
  deps: Omit<WatcherDeps, "store" | "traceStep">,
): AttachedWatchers {
  const store = new WatcherStore(db)
  const bus = getEventBus()
  const watcher = new TaskWatcher({
    ...deps,
    store,
    traceStep: (taskId, agentId, summary) =>
      bus.emit("task:step", { taskId, agentId, name: "watcher", status: "ok", outputSummary: summary, at: new Date().toISOString() }),
  })
  const started = (p: Parameters<TaskWatcher["taskStarted"]>[0]) => { void watcher.taskStarted(p) }
  const completed = (p: Parameters<TaskWatcher["taskCompleted"]>[0]) => { void watcher.taskCompleted(p) }
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  return {
    store,
    watcher,
    detach: () => {
      bus.off("task:started", started)
      bus.off("task:completed", completed)
    },
  }
}
