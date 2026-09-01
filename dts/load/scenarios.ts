export type Scenario =
  | 'SUCCESS_SYNC'
  | 'ASYNC_ACCEPTED'
  | 'LONG_PENDING'
  | 'EXPLICIT_REJECT'
  | 'RATE_LIMITED'
  | 'HTTP_500'
  | 'TIMEOUT_PRE_ACCEPT'
  | 'TIMEOUT_POST_ACCEPT'
  | 'MALFORMED_RESPONSE'
  | 'DUPLICATE_SUCCESS'
  | 'DELAYED_ACTIVE'
  | 'PARTIAL_QUANTITY'

export const SCENARIOS: Scenario[] = [
  'SUCCESS_SYNC', 'ASYNC_ACCEPTED', 'LONG_PENDING', 'EXPLICIT_REJECT', 'RATE_LIMITED', 'HTTP_500',
  'TIMEOUT_PRE_ACCEPT', 'TIMEOUT_POST_ACCEPT', 'MALFORMED_RESPONSE', 'DUPLICATE_SUCCESS', 'DELAYED_ACTIVE', 'PARTIAL_QUANTITY',
]

export interface ScenarioContract {
  /** Deterministic final order state asserted by the harness for this scenario. */
  expectedOrderState: 'FULFILLED' | 'FAILED' | 'PROVIDER_RECONCILIATION' | 'PROCESSING' | 'PARTIALLY_FULFILLED' | 'UNKNOWN'
  /** Whether the scenario involves a background (async) polled provider operation. */
  asyncPolling: boolean
  /** Whether the activation returns success with a provider reference (accepted). */
  acceptedByProvider: boolean
  iccidCount: 'ALL' | 'NONE' | 'PARTIAL'
}

export const SCENARIO_CONTRACT: Record<Scenario, ScenarioContract> = {
  SUCCESS_SYNC: { expectedOrderState: 'FULFILLED', asyncPolling: false, acceptedByProvider: true, iccidCount: 'ALL' },
  ASYNC_ACCEPTED: { expectedOrderState: 'FULFILLED', asyncPolling: true, acceptedByProvider: true, iccidCount: 'ALL' },
  LONG_PENDING: { expectedOrderState: 'PROCESSING', asyncPolling: true, acceptedByProvider: true, iccidCount: 'NONE' },
  EXPLICIT_REJECT: { expectedOrderState: 'FAILED', asyncPolling: false, acceptedByProvider: false, iccidCount: 'NONE' },
  RATE_LIMITED: { expectedOrderState: 'FAILED', asyncPolling: false, acceptedByProvider: false, iccidCount: 'NONE' },
  HTTP_500: { expectedOrderState: 'FAILED', asyncPolling: false, acceptedByProvider: false, iccidCount: 'NONE' },
  TIMEOUT_PRE_ACCEPT: { expectedOrderState: 'PROVIDER_RECONCILIATION', asyncPolling: false, acceptedByProvider: false, iccidCount: 'NONE' },
  TIMEOUT_POST_ACCEPT: { expectedOrderState: 'FULFILLED', asyncPolling: true, acceptedByProvider: true, iccidCount: 'ALL' },
  MALFORMED_RESPONSE: { expectedOrderState: 'PROVIDER_RECONCILIATION', asyncPolling: false, acceptedByProvider: false, iccidCount: 'NONE' },
  DUPLICATE_SUCCESS: { expectedOrderState: 'FULFILLED', asyncPolling: false, acceptedByProvider: true, iccidCount: 'ALL' },
  DELAYED_ACTIVE: { expectedOrderState: 'FULFILLED', asyncPolling: true, acceptedByProvider: true, iccidCount: 'ALL' },
  PARTIAL_QUANTITY: { expectedOrderState: 'PARTIALLY_FULFILLED', asyncPolling: true, acceptedByProvider: true, iccidCount: 'PARTIAL' },
}

/** Purchase-capable connector strategies the harness can drive (repo-wired). */
export const PROVIDER_STRATEGIES = [
  'AIRHUB', 'CHOICE', 'IBASIS', 'TELNA', 'TELNA_SEAMLESS', 'USMATRIX', 'STANDARD', 'HEADER_TOKEN',
] as const
export type ProviderStrategy = typeof PROVIDER_STRATEGIES[number]