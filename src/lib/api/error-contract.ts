import { NextResponse } from 'next/server'
import crypto from 'crypto'

// ─────────────────────────────────────────────
// Public error codes
// ─────────────────────────────────────────────

export const API_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  ORDER_NOT_RETRYABLE: 'ORDER_NOT_RETRYABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

// ─────────────────────────────────────────────
// Request ID
// ─────────────────────────────────────────────

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

// ─────────────────────────────────────────────
// Standardized response helpers
// ─────────────────────────────────────────────

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: any; requestId: string }
}

export function apiError(code: ApiErrorCode, message: string, status: number, details?: any, requestId?: string): NextResponse<ApiErrorBody> {
  const rid = requestId || generateRequestId()
  const body: ApiErrorBody = { error: { code, message, requestId: rid } }
  if (details) (body.error as any).details = details

  return NextResponse.json(body, {
    status,
    headers: { 'X-Request-Id': rid },
  })
}

export function apiSuccess<T>(data: T, status = 200, requestId?: string): NextResponse<T & { requestId?: string }> {
  const response = { ...(data as any), requestId: requestId || generateRequestId() }
  return NextResponse.json(response, {
    status,
    headers: { 'X-Request-Id': response.requestId },
  })
}

export function apiValidationError(zodError: any, requestId?: string): NextResponse<ApiErrorBody> {
  return apiError('INVALID_REQUEST', 'Validation failed', 400, { validation: zodError }, requestId)
}
