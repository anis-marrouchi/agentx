import { useLayoutEffect, useRef, type ReactNode } from "react"

// AI Elements' Conversation: stays at the bottom while the reply streams,
// unless the reader scrolled up to read; then it leaves the scroll alone.
// The scroll box is the Task page's own output pane (the host element).
export function Conversation({ scroller, children, tick }: { scroller: HTMLElement; children: ReactNode; tick: number }) {
  const stick = useRef(true)
  useLayoutEffect(() => {
    const onScroll = () => { stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60 }
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => scroller.removeEventListener("scroll", onScroll)
  }, [scroller])
  useLayoutEffect(() => {
    if (stick.current) scroller.scrollTop = scroller.scrollHeight
  }, [tick, scroller])
  return <div className="axc-conv" role="log" aria-live="polite" aria-relevant="additions">{children}</div>
}
