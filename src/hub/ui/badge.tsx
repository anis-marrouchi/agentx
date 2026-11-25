// From shadcn/ui (MIT, see NOTICE.md), restyled on the AgentX tokens.
import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"
import { cn } from "./cn"

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        ok: "border-transparent bg-ok/15 text-ok-ink",
        warn: "border-transparent bg-warn/20 text-warn-ink",
        err: "border-transparent bg-destructive/12 text-err-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
