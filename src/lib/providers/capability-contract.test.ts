import { describe, it, expect } from 'vitest'
import { UrlTokenConnector } from '@/lib/providers/connectors/url-token-connector'
import { AirHubConnector } from '@/lib/providers/connectors/airhub-connector'
import { UsMatrixConnector } from '@/lib/providers/connectors/usmatrix-connector'
import { IbasisConnector } from '@/lib/providers/connectors/ibasis-connector'
import { TelnaConnector } from '@/lib/providers/connectors/telna-connector'
import type { ConnectorCapabilities, IProviderConnector } from '@/lib/providers/connectors/connector-interface'

/**
 * Provider capability → implemented-method contract.
 *
 * A connector that declares a capability true MUST implement the corresponding
 * operation method(s). Exceptions are documented explicitly below:
 *
 *  - `installationLookup`/`installationLookupHistorical` may be served by
 *    `getQRCode` on connectors whose QR op is the install-data carrier (AirHub,
 *    iBASIS) and by `lookupInstallationData` where present (Choice/US-Matrix).
 *    Either method is a valid implementor.
 *  - `webhooks` is implemented by the external provider-webhook-processor, NOT by
 *    a connector method (iBASIS). Documented exception.
 *  - `customPackageCreation` requires BOTH getCustomPackageDefinition and
 *    createCustomPackage.
 */
const METHOD_REQUIREMENTS: Partial<Record<keyof ConnectorCapabilities, (keyof IProviderConnector)[]>> = {
  purchase: ['activateESIM'],
  statusLookup: ['getStatus'],
  usageLookup: ['getUsage'],
  topUp: ['topUpESIM'],
  suspend: ['suspendESIM'],
  resume: ['resumeESIM'],
  balance: ['getBalance'],
  customPackageCreation: ['getCustomPackageDefinition', 'createCustomPackage'],
}

const INSTALL_METHODS: (keyof IProviderConnector)[] = ['lookupInstallationData', 'getQRCode']

function newConnector(Cls: { providerId: string; name?: string } & IProviderConnector & { new (providerId: string, name?: string): any }, providerId: string, name = 'Test'): any {
  return new Cls(providerId, name)
}

function assertCapabilityHasMethod(caps: ConnectorCapabilities | undefined, key: keyof ConnectorCapabilities, connector: any) {
  // UNDEFINED/absent → no requirement (legacy). Only assert when declared truthy.
  const declared = caps?.[key]
  if (declared !== true) return

  const requireMethods = METHOD_REQUIREMENTS[key]
  if (requireMethods) {
    for (const m of requireMethods) {
      expect(typeof connector[m as string], `${connector.constructor.name}.capabilities.${key}=true requires ${m}`).toBe('function')
    }
    return
  }

  // installation* family — either lookupInstallationData or getQRCode.
  if (key === 'installationLookup' || key === 'installationLookupHistorical' || key === 'installationDataAtPurchase') {
    const hasInstallMethod = INSTALL_METHODS.some(m => typeof connector[m] === 'function')
    expect(hasInstallMethod, `${connector.constructor.name}.capabilities.${key}=true requires lookupInstallationData or getQRCode`).toBe(true)
    return
  }

  // Unhandled capability — should not occur; fail loudly to force review.
  expect(`Untracked capability ${key} declared true`).toBe('tracked-and-documented')
}

describe('Provider capability → method contract', () => {
  it('CHOICE (UrlTokenConnector)', () => {
    const c = newConnector(UrlTokenConnector, 'c-1', 'Choice')
    const caps = c.capabilities as ConnectorCapabilities
    for (const key of Object.keys(METHOD_REQUIREMENTS) as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    for (const key of ['installationLookup', 'installationLookupHistorical', 'installationDataAtPurchase'] as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
  })

  it('AIRHUB (AirHubConnector)', () => {
    const c = newConnector(AirHubConnector, 'a-1', 'AirHub')
    const caps = c.capabilities as ConnectorCapabilities
    for (const key of Object.keys(METHOD_REQUIREMENTS) as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    for (const key of ['installationLookup', 'installationLookupHistorical', 'installationDataAtPurchase'] as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
  })

  it('US-MATRIX (UsMatrixConnector)', () => {
    const c = newConnector(UsMatrixConnector, 'u-1', 'US-Matrix')
    const caps = c.capabilities as ConnectorCapabilities
    for (const key of Object.keys(METHOD_REQUIREMENTS) as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    for (const key of ['installationLookup', 'installationLookupHistorical', 'installationDataAtPurchase'] as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
  })

  it('IBASIS (IbasisConnector)', () => {
    const c = newConnector(IbasisConnector, 'i-1', 'iBASIS')
    const caps = c.capabilities as ConnectorCapabilities
    for (const key of Object.keys(METHOD_REQUIREMENTS) as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    for (const key of ['installationLookup', 'installationLookupHistorical', 'installationDataAtPurchase'] as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    // webhooks:true is intentionally handled by the external provider-webhook
    // processor, not a connector method — documented exception.
    expect(caps.webhooks).toBe(true)
  })

  it('TELNA (TelnaConnector)', () => {
    const c = newConnector(TelnaConnector, 't-1', 'Telna')
    const caps = c.capabilities as ConnectorCapabilities
    for (const key of Object.keys(METHOD_REQUIREMENTS) as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    for (const key of ['installationLookup', 'installationLookupHistorical', 'installationDataAtPurchase'] as (keyof ConnectorCapabilities)[]) assertCapabilityHasMethod(caps, key, c)
    expect(caps.purchase).toBe(true) // explicit, contract-verified
    expect(caps.suspend).toBe(false) // documented exception: no safe exact mapping
    expect(caps.resume).toBe(false)
  })
})