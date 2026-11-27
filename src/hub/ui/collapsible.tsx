// From shadcn/ui (MIT, see NOTICE.md), on Radix Collapsible.
// A section that folds from its header: chevron first, title, count
// (orca-design C22). No motion: folding is frequent, so it is instant.
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import * as React from "react"

export const Collapsible = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>, React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>((props, ref) => <CollapsiblePrimitive.Root ref={ref} data-slot="collapsible" {...props} />)
Collapsible.displayName = "Collapsible"

export const CollapsibleTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>((props, ref) => <CollapsiblePrimitive.Trigger ref={ref} data-slot="collapsible-trigger" {...props} />)
CollapsibleTrigger.displayName = "CollapsibleTrigger"

export const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>, React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>((props, ref) => <CollapsiblePrimitive.Content ref={ref} data-slot="collapsible-content" {...props} />)
CollapsibleContent.displayName = "CollapsibleContent"
