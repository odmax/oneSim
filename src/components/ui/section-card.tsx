import * as React from "react"
import { cn } from "@/lib/utils"

export interface SectionCardProps {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned header actions. */
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

/**
 * Card with a consistent header (title/description/actions) and body.
 * Presentation only. Built on plain tokens so it stays layout-agnostic.
 */
export function SectionCard({ title, description, actions, children, className, bodyClassName }: SectionCardProps) {
  const hasHeader = title || description || actions
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-card", className)}>
      {hasHeader && (
        <header className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  )
}
