// From shadcn/ui (MIT, see NOTICE.md), on Radix Tooltip, restyled on the AgentX tokens.
// A shortcut goes in as a Kbd child, which takes the tooltip's colours:
// <TooltipContent>Search <Kbd>⌘K</Kbd></TooltipContent>.
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import * as React from "react"
import { cn } from "./cn"
import { hubPortal } from "./portal"

/** 600ms before the first tooltip (orca-design); the next ones open at once. */
export function TooltipProvider({ delayDuration = 600, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

// Only a delayed open moves; an instant one (the pointer slid over from
// another tooltip) just appears.
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal container={hubPortal()}>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "z-50 flex w-fit items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-float",
        "origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-ax-pop-in data-[state=closed]:animate-ax-pop-out",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = "TooltipContent"
