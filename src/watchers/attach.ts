import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import { WatcherStore } from "./store"
import { WatchCheckpoint, taskStartOf, type CheckpointDeps } from "./checkpoint"

// --- Hook the watcher checkpoint to the daemon's event bus (#1030) ---
//
// Attached whatever the setting says, so turning `watchers.enabled` on
// needs no restart: the checkpoint reads the setting on every event.

export interface AttachedWatchers {
  store: WatcherStore
  checkpoint: WatchCheckpoint
  detach: () => void
}

export function attachWatchers(
  db: Database.Database,
  deps: Omit<CheckpointDeps, "store">,
): AttachedWatchers {
  const store = new WatcherStore(db)
  const checkpoint = new WatchCheckpoint({ ...deps, store })
  const bus = getEventBus()
  const started = (e: AgentXEvents["task:started"]) => {
    try {
      if (!deps.settings().enabled) return
      const task = taskStartOf(e, deps.settings())
      if (task) void checkpoint.check(task)
    } catch (err: any) {
      // Runs inside the emitter of the task's own start: never throw there.
      deps.log(`[watchers] start of ${e.taskId}: ${err?.message ?? err}`)
    }
  }
  const completed = (e: AgentXEvents["task:completed"]) => {
    if (!deps.settings().enabled) return
    checkpoint.taskEnded(e).catch((err: any) => deps.log(`[watchers] end of ${e.taskId}: ${err?.message ?? err}`))
  }
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  return {
    store,
    checkpoint,
    detach: () => {
      bus.off("task:started", started)
      bus.off("task:completed", completed)
    },
  }
}
