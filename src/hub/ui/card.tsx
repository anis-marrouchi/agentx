// From shadcn/ui (MIT, see NOTICE.md), restyled on the AgentX tokens.
import * as React from "react"
import { cn } from "./cn"

type DivProps = React.HTMLAttributes<HTMLDivElement>

export const Card = ({ className, ...p }: DivProps) =>
  <div className={cn("rounded-lg border border-border bg-card text-card-foreground", className)} {...p} />
export const CardHeader = ({ className, ...p }: DivProps) =>
  <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...p} />
export const CardTitle = ({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) =>
  <h3 className={cn("text-sm font-semibold leading-tight", className)} {...p} />
export const CardDescription = ({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) =>
  <p className={cn("text-xs text-muted-foreground", className)} {...p} />
export const CardContent = ({ className, ...p }: DivProps) =>
  <div className={cn("p-4 pt-2", className)} {...p} />
export const CardFooter = ({ className, ...p }: DivProps) =>
  <div className={cn("flex items-center gap-2 p-4 pt-0", className)} {...p} />
