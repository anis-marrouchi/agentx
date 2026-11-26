// The React Hub's frame for stage 1 (#2218 part 3): it draws the page the
// hash names when React owns it, and nothing otherwise (the old Hub does).
import { Suspense } from "react"
import type { HubBoot } from "./boot"
import { ConnectionLine } from "./ConnectionLine"
import { hubRegistry } from "./registry"
import { reactPageFor, useHashParams } from "./router"
// Straight from the parts, not the ./ui barrel: the barrel would pull every
// kit part (cmdk, Select, Popover) into the first load.
import { Skeleton } from "./ui/misc"
import { TooltipProvider } from "./ui/tooltip"

export function App({ boot }: { boot: HubBoot }) {
  const params = useHashParams()
  const page = reactPageFor(params, boot.pages)
  const Page = page ? hubRegistry.pageComponent(page) : undefined
  if (!Page) return null
  return (
    <TooltipProvider delayDuration={300}>
      <div className="ax-hub" data-hub-page={page}>
        <ConnectionLine />
        <Suspense fallback={<div className="flex flex-col gap-3 p-4"><Skeleton className="h-6 w-48" /><Skeleton className="h-24 w-full" /></div>}>
          <Page params={params} />
        </Suspense>
      </div>
    </TooltipProvider>
  )
}
