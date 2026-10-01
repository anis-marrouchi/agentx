import type Database from "better-sqlite3"
import { getEventBus } from "@/events/bus"
import { RequestStore } from "./store"
import { RequestTracker, type RequestSettings } from "./tracker"

// --- Hook the request tracker to the daemon's event bus (#356) ---

export interface AttachedRequests {
  store: RequestStore
  tracker: RequestTracker
  detach: () => void
}

export function attachRequests(
  db: Database.Database,
  settings: () => RequestSettings,
  log: (msg: string) => void,
): AttachedRequests {
  const store = new RequestStore(db)
  const tracker = new RequestTracker(store, settings, log)
  const bus = getEventBus()
  const started = tracker.taskStarted.bind(tracker)
  const completed = tracker.taskCompleted.bind(tracker)
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  return {
    store,
    tracker,
    detach: () => {
      bus.off("task:started", started)
      bus.off("task:completed", completed)
    },
  }
}
