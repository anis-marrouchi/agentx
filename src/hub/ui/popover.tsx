// From shadcn/ui (MIT, see NOTICE.md), on Radix Popover, restyled on the AgentX tokens.
// It opens in the Hub's own portal host (portal.ts), so its styles apply.
import * as PopoverPrimitive from "@radix-ui/react-popover"
import * as React from "react"
import { cn } from "./cn"
import { hubPortal } from "./portal"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal container={hubPortal()}>
    <PopoverPrimitive.Content
      ref={ref}
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-float outline-none",
        "origin-(--radix-popover-content-transform-origin) data-[state=open]:animate-ax-pop-in data-[state=closed]:animate-ax-pop-out",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = "PopoverContent"
