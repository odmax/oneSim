import * as React from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "./skeleton"

export interface ChartContainerProps {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Fixed chart body height (number = px, string = any CSS length). */
  height?: number | string
  /** Render a shimmer placeholder instead of children (loading-friendly). */
  loading?: boolean
  children?: React.ReactNode
  className?: string
}

/**
 * Presentation wrapper for charts. Does NOT import a charting library or fetch
 * data — callers render the chart (e.g. recharts) as children once dashboards
 * are implemented in a later phase.
 */
export function ChartContainer({
  title,
  description,
  actions,
  height = 280,
  loading = false,
  children,
  className,
}: ChartContainerProps) {
  const hasHeader = title || description || actions
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-card", className)}>
      {hasHeader && (
        <header className="flex flex-col gap-2 px-5 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5" style={{ minHeight: typeof height === "number" ? `${height}px` : height }}>
        {loading ? <Skeleton className="h-full w-full" /> : children}
      </div>
    </section>
  )
}
