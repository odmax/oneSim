import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock prisma before any imports
vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogEvent: {
      create: vi.fn().mockResolvedValue({ id: 'db-evt-1' }),
      findMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    providerPackage: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    catalogPipelineRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    catalogPipelineStage: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}))

vi.mock('@/lib/auth/config', () => ({
  authOptions: {},
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
  default: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
  recordPipelineStage: vi.fn(),
}))

import { catalogEventBus } from './event-bus'
import { emitEvent, getRecentEvents, clearRecentEvents } from './dispatcher'
import { getServerSession } from 'next-auth'
import type { CatalogEvent } from './types'

describe('Catalog Event Bus', () => {
  beforeEach(() => {
    catalogEventBus.clear()
    clearRecentEvents()
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' },
    } as any)
  })

  afterEach(() => {
    catalogEventBus.clear()
  })

  describe('subscribe and publish', () => {
    it('calls subscribed handler on publish', async () => {
      const handler = vi.fn()
      catalogEventBus.subscribe('PACKAGE_UPDATED', handler)

      const event: CatalogEvent = {
        eventId: 'test-1',
        timestamp: new Date().toISOString(),
        eventType: 'PACKAGE_UPDATED',
        providerId: 'prov-1',
        providerCode: 'TEST',
        packageId: 'pkg-1',
        comparableKey: 'local:NG:5GB:30',
        changedFields: ['sellingPrice'],
        trigger: 'USER_ACTION',
        userId: 'admin-1',
        metadata: {},
      }

      await catalogEventBus.publish(event)
      expect(handler).toHaveBeenCalledWith(event)
    })

    it('does not call handler for different event type', async () => {
      const handler = vi.fn()
      catalogEventBus.subscribe('PACKAGE_CREATED', handler)

      const event: CatalogEvent = {
        eventId: 'test-2',
        timestamp: new Date().toISOString(),
        eventType: 'PACKAGE_UPDATED',
        providerId: null,
        providerCode: null,
        packageId: null,
        comparableKey: null,
        changedFields: [],
        trigger: 'SYSTEM',
        userId: null,
        metadata: {},
      }

      await catalogEventBus.publish(event)
      expect(handler).not.toHaveBeenCalled()
    })

    it('calls subscribeAll handler for all event types', async () => {
      const handler = vi.fn()
      catalogEventBus.subscribeAll(handler)

      await catalogEventBus.publish({
        eventId: 'test-3', timestamp: new Date().toISOString(),
        eventType: 'PACKAGE_CREATED', providerId: null, providerCode: null,
        packageId: null, comparableKey: null, changedFields: [], trigger: 'SYSTEM',
        userId: null, metadata: {},
      })

      await catalogEventBus.publish({
        eventId: 'test-4', timestamp: new Date().toISOString(),
        eventType: 'PROVIDER_SYNC_COMPLETED', providerId: null, providerCode: null,
        packageId: null, comparableKey: null, changedFields: [], trigger: 'SYSTEM',
        userId: null, metadata: {},
      })

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  describe('debounce', () => {
    it('deduplicates events for same comparableKey', async () => {
      vi.useFakeTimers()
      const handler = vi.fn()
      catalogEventBus.subscribe('PACKAGE_PRICING_CHANGED', handler)

      emitEvent({
        eventType: 'PACKAGE_PRICING_CHANGED',
        providerId: 'prov-1', providerCode: 'TEST',
        packageId: 'pkg-1', comparableKey: 'local:NG:5GB:30',
        changedFields: ['sellingPrice'],
      })

      emitEvent({
        eventType: 'PACKAGE_PRICING_CHANGED',
        providerId: 'prov-1', providerCode: 'TEST',
        packageId: 'pkg-2', comparableKey: 'local:NG:5GB:30',
        changedFields: ['sellingPrice'],
      })

      vi.advanceTimersByTime(100)
      await vi.runAllTimersAsync()

      expect(handler).toHaveBeenCalledTimes(1)
      const calledEvent = handler.mock.calls[0][0] as CatalogEvent
      expect(calledEvent.comparableKey).toBe('local:NG:5GB:30')
      expect(calledEvent.packageId).toBe('pkg-2')

      vi.useRealTimers()
    })

    it('deduplicates events for different groups separately', async () => {
      vi.useFakeTimers()
      const handler = vi.fn()
      catalogEventBus.subscribe('PACKAGE_PRICING_CHANGED', handler)

      emitEvent({
        eventType: 'PACKAGE_PRICING_CHANGED',
        providerId: 'prov-1', providerCode: 'TEST',
        packageId: 'pkg-1', comparableKey: 'local:NG:5GB:30',
        changedFields: ['sellingPrice'],
      })

      emitEvent({
        eventType: 'PACKAGE_PRICING_CHANGED',
        providerId: 'prov-1', providerCode: 'TEST',
        packageId: 'pkg-3', comparableKey: 'local:NG:10GB:30',
        changedFields: ['sellingPrice'],
      })

      vi.advanceTimersByTime(100)
      await vi.runAllTimersAsync()

      expect(handler).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })
  })

  describe('emitEvent', () => {
    it('creates event with correct fields', async () => {
      const handler = vi.fn()
      catalogEventBus.subscribe('PACKAGE_CREATED', handler)

      emitEvent({
        eventType: 'PACKAGE_CREATED',
        providerId: 'prov-1', providerCode: 'TEST',
        packageId: 'pkg-new', comparableKey: 'local:NG:5GB:30',
        changedFields: ['name', 'dataGB'],
        trigger: 'USER_ACTION', userId: 'admin-1',
        metadata: { packageName: 'Test Plan' },
      })

      // Flush debounce
      catalogEventBus.flushDebounced()

      expect(handler).toHaveBeenCalled()
      const evt = handler.mock.calls[0][0] as CatalogEvent
      expect(evt.eventType).toBe('PACKAGE_CREATED')
      expect(evt.providerId).toBe('prov-1')
      expect(evt.packageId).toBe('pkg-new')
      expect(evt.changedFields).toEqual(['name', 'dataGB'])
      expect(evt.trigger).toBe('USER_ACTION')
      expect(evt.userId).toBe('admin-1')
      expect(evt.eventId).toBeTruthy()
      expect(evt.timestamp).toBeTruthy()
    })
  })

  describe('event bus handlers count', () => {
    it('tracks handler count correctly', () => {
      expect(catalogEventBus.handlerCount()).toBe(0)

      catalogEventBus.subscribe('PACKAGE_UPDATED', vi.fn())
      expect(catalogEventBus.handlerCount()).toBe(1)

      catalogEventBus.subscribeAll(vi.fn())
      expect(catalogEventBus.handlerCount()).toBe(13)

      catalogEventBus.clear()
      expect(catalogEventBus.handlerCount()).toBe(0)
    })
  })
})
