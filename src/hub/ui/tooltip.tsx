// From shadcn/ui (MIT, see NOTICE.md), on Radix Tooltip, restyled on the AgentX tokens.
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import * as React from "react"
import { cn } from "./cn"
import { hubPortal } from "./portal"

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal container={hubPortal()}>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn("z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-float", className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = "TooltipContent"
