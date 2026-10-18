import * as React from "react"
import { cn } from "@/lib/utils"
import { Badge, type BadgeVariant } from "./badge"

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

/**
 * Presentation-only status → tone mapping.
 * No business/domain logic; unknown statuses fall back to neutral.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  // success / live
  ACTIVE: "success",
  ACTIVATED: "success",
  INSTALLED: "success",
  PROVISIONED: "success",
  FULFILLED: "success",
  COMPLETED: "success",
  COMPLETE: "success",
  PAID: "success",
  APPROVED: "success",
  CONFIRMED: "success",
  HEALTHY: "success",
  CONNECTED: "success",
  DELIVERED: "success",
  RESOLVED: "success",
  GRANTED: "success",
  // warning / in-flight
  PENDING: "warning",
  PARTIAL: "warning",
  PARTIALLY_FULFILLED: "warning",
  AWAITING: "warning",
  PROCESSING: "warning",
  INSTALLING: "info",
  RESERVED: "info",
  PAYMENT_RESERVED: "info",
  PENDING_PROVIDER: "info",
  IN_PROGRESS: "info",
  OPEN: "info",
  INFO: "info",
  // danger / terminal-bad
  FAILED: "danger",
  ERROR: "danger",
  SUSPENDED: "danger",
  CANCELLED: "danger",
  CANCELED: "danger",
  EXPIRED: "danger",
  REJECTED: "danger",
  DECLINED: "danger",
  UNHEALTHY: "danger",
  // neutral / inert
  DRAFT: "neutral",
  REFUNDED: "neutral",
  CLOSED: "neutral",
  ARCHIVED: "neutral",
  INACTIVE: "neutral",
  DISABLED: "neutral",
  UNKNOWN: "neutral",
}

const TONE_TO_VARIANT: Record<StatusTone, BadgeVariant> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
}

const DOT_STYLES: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  neutral: "bg-muted-foreground/60",
}

function humanize(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ")
}

export interface StatusBadgeProps {
  /** Raw status value (used only for visual tone mapping). */
  status: string
  /** Override the visible label. */
  label?: React.ReactNode
  /** Force a tone instead of deriving it from `status`. */
  tone?: StatusTone
  /** Show a status dot (default true). */
  dot?: boolean
  className?: string
}

/**
 * Status pill. Presentation only — never queries the backend.
 */
export function StatusBadge({ status, label, tone, dot = true, className }: StatusBadgeProps) {
  const resolved: StatusTone = tone ?? STATUS_TONES[status?.toUpperCase?.()] ?? "neutral"
  return (
    <Badge variant={TONE_TO_VARIANT[resolved]} className={className}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT_STYLES[resolved])} aria-hidden="true" />}
      {label ?? humanize(status)}
    </Badge>
  )
}

export { STATUS_TONES }
