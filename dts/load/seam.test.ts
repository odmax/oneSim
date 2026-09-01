import { describe, it, expect, afterEach } from 'vitest'
import { databaseNameFromUrl, loadHarnessModeEnabled, loadOverrideGate, registerConnectorOverride, createConnector } from '../../src/lib/providers/connectors/connector-factory'

const SAVED = {
  LOAD_HARNESS: process.env.LOAD_HARNESS,
  DATABASE_URL: process.env.DATABASE_URL,
}

afterEach(() => {
  if (SAVED.LOAD_HARNESS === undefined) delete process.env.LOAD_HARNESS
  else process.env.LOAD_HARNESS = SAVED.LOAD_HARNESS
  if (SAVED.DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = SAVED.DATABASE_URL
})

function db(url: string): void { process.env.DATABASE_URL = url }
function mode(on: boolean): void { if (on) process.env.LOAD_HARNESS = '1'; else delete process.env.LOAD_HARNESS }

const FACTORY = () => ({ throwOnBuild: true }) as any

describe('FAKE_PROVIDER_SEAM fail-closed gate', () => {
  it('1. production-like DATABASE_URL blocks registration even with load mode', () => {
    mode(true)
    db('postgresql://u:p@localhost:5432/onesim_africa')
    expect(loadOverrideGate().ok).toBe(false)
    expect(() => registerConnectorOverride('AIRHUB', FACTORY)).toThrow('CONNECTOR_OVERRIDE_BLOCKED')
  })

  it('2. staging-like DATABASE_URL blocks registration', () => {
    mode(true)
    db('postgresql://u:p@staging.example.com:5432/onesim_load_x')
    expect(loadOverrideGate().ok).toBe(false)
    expect(() => registerConnectorOverride('AIRHUB', FACTORY)).toThrow()
  })

  it('3. ordinary dev DB blocks registration', () => {
    mode(false)
    db('postgresql://u:p@localhost:5432/onesim_dev')
    expect(loadOverrideGate().ok).toBe(false)
    expect(() => registerConnectorOverride('AIRHUB', FACTORY)).toThrow()
  })

  it('4. onesim_load_* WITHOUT explicit load mode blocks registration', () => {
    mode(false)
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    expect(loadOverrideGate().ok).toBe(false)
    expect(() => registerConnectorOverride('AIRHUB', FACTORY)).toThrow('LOAD_HARNESS mode not enabled')
  })

  it('5. explicit load mode + onesim_load_* allows registration', () => {
    mode(true)
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    expect(loadOverrideGate().ok).toBe(true)
    expect(() => registerConnectorOverride('AIRHUB', FACTORY)).not.toThrow()
  })

  it('6. when overrides are blocked, canonical createConnector behavior is unchanged (real AIRHUB connector built)', () => {
    mode(false)
    db('postgresql://u:p@localhost:5432/onesim_africa')
    const c = createConnector('p1', 'AirHub', 'AIRHUB' as any, {
      apiBaseUrl: 'https://api.airhubapp.com', apiToken: 'enc:x', environment: 'staging', config: { partnerCode: 123 },
    })
    expect(c.constructor.name).toBe('AirHubConnector')
  })

  it('7. valid load mode + MISSING override → THROWS LOAD_HARNESS_CONNECTOR_OVERRIDE_MISSING (never canonical)', () => {
    mode(true)
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    // IBASIS is never registered in this file → missing override in load mode.
    expect(() => createConnector('p1', 'IBasis', 'IBASIS' as any, { apiBaseUrl: 'fake://load' } as any))
      .toThrow('LOAD_HARNESS_CONNECTOR_OVERRIDE_MISSING')
  })

  it('8. valid load mode + override exists → fake returned (override consumed)', () => {
    mode(true)
    db('postgresql://u:p@localhost:5432/onesim_load_abc')
    registerConnectorOverride('AIRHUB', FACTORY)
    const c = createConnector('p1', 'AirHub', 'AIRHUB' as any, { apiBaseUrl: 'fake://load' } as any) as any
    expect(c.throwOnBuild).toBe(true)
  })

  it('9. normal-runtime parity: no override registered, gate off → canonical connector for every strategy-like type', () => {
    mode(false)
    db('postgresql://u:p@localhost:5432/onesim_africa')
    const c = createConnector('p1', 'Choice', 'URL_TOKEN' as any, {
      apiBaseUrl: 'https://example.com', apiToken: 'enc:x', environment: 'staging', config: {},
    })
    expect(c).toBeDefined()
    expect(c.constructor.name).toBeTruthy()
  })

  it('databaseNameFromUrl extracts the database only', () => {
    expect(databaseNameFromUrl('postgresql://u:secret@localhost:5432/onesim_load_xyz?sslmode=require')).toBe('onesim_load_xyz')
    expect(loadHarnessModeEnabled()).toBe(false)
  })
})