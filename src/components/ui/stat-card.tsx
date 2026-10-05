import * as React from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "./skeleton"

export type StatAccent = "blue" | "green" | "navy" | "amber" | "red" | "slate"

const ACCENT_STYLES: Record<StatAccent, { icon: string; value: string }> = {
  blue: { icon: "bg-primary/10 text-primary", value: "text-foreground" },
  green: { icon: "bg-success/10 text-success", value: "text-foreground" },
  navy: { icon: "bg-navy/10 text-navy", value: "text-foreground" },
  amber: { icon: "bg-warning/10 text-warning", value: "text-foreground" },
  red: { icon: "bg-destructive/10 text-destructive", value: "text-foreground" },
  slate: { icon: "bg-muted text-muted-foreground", value: "text-foreground" },
}

export interface StatCardProps {
  label: string
  value: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  /** Optional trend/change text (e.g. "+12% this week"). */
  trend?: React.ReactNode
  /** Optional helper text under the value. */
  helper?: React.ReactNode
  accent?: StatAccent
  /** Renders a shimmer placeholder (no data fetching). */
  loading?: boolean
  className?: string
}

/**
 * KPI / metric card. Presentation only — the caller supplies all values.
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  helper,
  accent = "blue",
  loading = false,
  className,
}: StatCardProps) {
  const styles = ACCENT_STYLES[accent]

  if (loading) {
    return (
      <div className={cn("rounded-xl border border-border bg-card p-5 shadow-card", className)}>
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
        <Skeleton className="mt-3 h-7 w-28" />
        <Skeleton className="mt-3 h-3 w-32" />
      </div>
    )
  }

  return (
    <div className={cn("rounded-xl border border-border bg-card p-5 shadow-card transition-shadow hover:shadow-card-hover", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", styles.icon)}>
            <Icon className="h-5 w-5" />
          </span>
        )}
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tracking-tight", styles.value)}>{value}</p>
      {(trend || helper) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          {trend && <span className="font-medium text-foreground/80">{trend}</span>}
          {helper && <span>{helper}</span>}
        </div>
      )}
    </div>
  )
}
