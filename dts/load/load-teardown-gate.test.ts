import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * H1 — destructive seed cleanup self-gate (Phase 4.1).
 *
 * teardownLoadSeed must throw BEFORE the first deleteMany unless the process is
 * in an explicit load mode + onesim_load_* DB + non-staging/prod host + the
 * active Prisma connection is bound to that exact load DB.
 */

const mockDb = vi.hoisted(() => ({
  eSIMPackage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  packagePriceSnapshot: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  providerPackage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  business: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  provider: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  $queryRawUnsafe: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: mockDb,
}))

import { teardownLoadSeed, connectorTypeForStrategy } from './load-seed'
import { FakeConnector } from './fake-provider-driver'
import { PROVIDER_STRATEGIES } from './scenarios'

const SAVED = {
  LOAD_HARNESS: process.env.LOAD_HARNESS,
  DATABASE_URL: process.env.DATABASE_URL,
}

function db(url: string): void { process.env.DATABASE_URL = url }
function mode(on: boolean): void { if (on) process.env.LOAD_HARNESS = '1'; else delete process.env.LOAD_HARNESS }

beforeEach(() => {
  vi.clearAllMocks()
  mode(true)
})

afterEach(() => {
  if (SAVED.LOAD_HARNESS === undefined) delete process.env.LOAD_HARNESS
  else process.env.LOAD_HARNESS = SAVED.LOAD_HARNESS
  if (SAVED.DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = SAVED.DATABASE_URL
})

const deletedAny = () =>
  mockDb.eSIMPackage.deleteMany.mock.calls.length + mockDb.packagePriceSnapshot.deleteMany.mock.calls.length +
  mockDb.providerPackage.deleteMany.mock.calls.length + mockDb.business.deleteMany.mock.calls.length +
  mockDb.provider.deleteMany.mock.calls.length

describe('teardownLoadSeed destructive-cleanup self-gate', () => {
  it('blocks when LOAD_HARNESS mode is not enabled (before any DB read/mutation)', async () => {
    mode(false)
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    await expect(teardownLoadSeed()).rejects.toThrow('TEARDOWN_GATE')
    expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(deletedAny()).toBe(0)
  })

  it('blocks an ordinary/dev target (onesim_africa)', async () => {
    db('postgresql://u:p@localhost:5432/onesim_africa')
    await expect(teardownLoadSeed()).rejects.toThrow('TEARDOWN_GATE')
    expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(deletedAny()).toBe(0)
  })

  it('blocks a staging-like host even with a onesim_load_* name', async () => {
    db('postgresql://u:p@staging.example.com:5432/onesim_load_x')
    await expect(teardownLoadSeed()).rejects.toThrow('TEARDOWN_GATE')
    expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(deletedAny()).toBe(0)
  })

  it('blocks a production-like host even with a onesim_load_* name', async () => {
    db('postgresql://u:p@prod-db.example.com:5432/onesim_load_x')
    await expect(teardownLoadSeed()).rejects.toThrow('TEARDOWN_GATE')
    expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(deletedAny()).toBe(0)
  })

  it('blocks a load-name mismatch (binding drift) before deleteMany', async () => {
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    // Active connection is actually a different DB.
    mockDb.$queryRawUnsafe.mockResolvedValue([{ db: 'onesim_load_other' }])
    await expect(teardownLoadSeed()).rejects.toThrow('HARNESS_DB_MISBIND')
    expect(deletedAny()).toBe(0)
  })

  it('allows exactly a valid onesim_load_* binding (deleteMany proceeds)', async () => {
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    mockDb.$queryRawUnsafe.mockResolvedValue([{ db: 'onesim_load_abc' }])
    await teardownLoadSeed()
    expect(deletedAny()).toBeGreaterThan(0)
    expect(mockDb.eSIMPackage.deleteMany).toHaveBeenCalled()
  })
})

describe('harness strategy → fake driver coverage (no real HTTP path)', () => {
  it('every PRODUCTION strategy maps to a connector type the fake driver can back', () => {
    for (const strategy of PROVIDER_STRATEGIES) {
      const connectorType = connectorTypeForStrategy(strategy)
      expect(typeof connectorType).toBe('string')
      expect(connectorType.length).toBeGreaterThan(0)
      // FakeConnector is pure in-memory and deterministic per scenario.
      const fake = new FakeConnector(connectorType, 'SUCCESS_SYNC')
      expect(fake).toBeDefined()
      expect(typeof fake.activateESIM).toBe('function')
      expect(typeof fake.getStatus).toBe('function')
    }
  })
})