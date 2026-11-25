// React side of the one live connection (live.ts).
import { useQuery } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react"
import { apiGet } from "./api"
import { LIVE_KEY, type LiveStatus, type LiveStream } from "./live"

const Ctx = createContext<LiveStream | null>(null)

export function LiveProvider({ stream, children }: { stream: LiveStream; children: ReactNode }) {
  return <Ctx.Provider value={stream}>{children}</Ctx.Provider>
}

function useStream(): LiveStream {
  const s = useContext(Ctx)
  if (!s) throw new Error("LiveProvider is missing")
  return s
}

/** The connection's state, for a "Reconnecting…" line. */
export function useLiveStatus(): LiveStatus {
  const s = useStream()
  return useSyncExternalStore(s.subscribe, s.getStatus)
}

/** The live snapshot: one read at first, then every pushed snapshot. Keeps
 *  the shared stream open while the component is on screen. */
export function useLiveSnapshot<T = unknown>() {
  const s = useStream()
  useEffect(() => s.acquire(), [s])
  return useQuery<T>({ queryKey: LIVE_KEY, queryFn: () => apiGet<T>("/api/live?quick=1"), staleTime: Infinity })
}
