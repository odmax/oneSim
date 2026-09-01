import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrismaDb = vi.hoisted(() => ({
  business: { findUnique: vi.fn() },
  apiRequestLog: { count: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrismaDb }))

import { prisma } from '@/lib/prisma'
import { checkRateLimit, addRateLimitHeaders } from './logging'
import { NextResponse } from 'next/server'

const mock = vi.mocked(prisma)

beforeEach(() => { vi.clearAllMocks() })

describe('rate limit policy (Phase 6.1 — null means unlimited)', () => {
  it('null/unset rateLimitPerMinute → NO ceiling (allowed always, limit null)', async () => {
    mock.business.findUnique.mockResolvedValue({ rateLimitPerMinute: null })
    mock.apiRequestLog.count.mockResolvedValue(100_000)
    const r = await checkRateLimit('biz-1')
    expect(r.allowed).toBe(true)
    expect(r.limit).toBeNull()
    expect(r.remaining).toBeNull()
  })

  it('explicit positive limit is enforced', async () => {
    mock.business.findUnique.mockResolvedValue({ rateLimitPerMinute: 60 })
    mock.apiRequestLog.count.mockResolvedValue(50)
    const r = await checkRateLimit('biz-1')
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(60)
    expect(r.remaining).toBe(10)
  })

  it('explicit limit reached → rejected', async () => {
    mock.business.findUnique.mockResolvedValue({ rateLimitPerMinute: 60 })
    mock.apiRequestLog.count.mockResolvedValue(60)
    const r = await checkRateLimit('biz-1')
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  it('explicit 100 limit behaves independently', async () => {
    mock.business.findUnique.mockResolvedValue({ rateLimitPerMinute: 100 })
    mock.apiRequestLog.count.mockResolvedValue(100)
    const r = await checkRateLimit('biz-1')
    expect(r.allowed).toBe(false)
    expect(r.limit).toBe(100)
  })

  it('zero limit is treated as NO ceiling (not an aggressive 0-limit lockout)', async () => {
    mock.business.findUnique.mockResolvedValue({ rateLimitPerMinute: 0 })
    mock.apiRequestLog.count.mockResolvedValue(0)
    const r = await checkRateLimit('biz-1')
    expect(r.allowed).toBe(true)
    expect(r.limit).toBeNull()
  })

  it('addRateLimitHeaders skips headers when limit is null (unlimited)', () => {
    const res = NextResponse.json({}, { status: 200 })
    const out = addRateLimitHeaders(res, { limit: null, remaining: null })
    expect(out.headers.get('X-RateLimit-Limit')).toBeNull()
    expect(out.headers.get('X-RateLimit-Remaining')).toBeNull()
  })

  it('addRateLimitHeaders sets headers for an enforced limit', () => {
    const res = NextResponse.json({}, { status: 200 })
    const out = addRateLimitHeaders(res, { limit: 60, remaining: 3, resetAt: new Date(1750000000) })
    expect(out.headers.get('X-RateLimit-Limit')).toBe('60')
    expect(out.headers.get('X-RateLimit-Remaining')).toBe('3')
  })
})