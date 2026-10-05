import * as React from "react"
import { cn } from "@/lib/utils"

export interface EmptyStateProps {
  /** Icon element (e.g. a lucide icon) or emoji. */
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Optional action element (button/link). */
  action?: React.ReactNode
  className?: string
}

/**
 * Consistent empty/zero-state block. Presentation only.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center",
        className
      )}
    >
      {icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
