/**
 * iBASIS subscriber mapper.
 *
 * Normalizes raw iBASIS subscriber payloads (GET/POST/PATCH /api/v1/subscribers)
 * into app-level fields. Provider field names never leak outside this module.
 */

export interface IbasisSubscriberInput {
  username: string
  firstName?: string
  middleName?: string
  lastName?: string
  phoneNumber?: string
  email?: string
  dateOfBirth?: string
}

export interface MappedIbasisSubscriber {
  providerSubscriberId: string
  username: string
  firstName: string | null
  middleName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  dateOfBirth: string | null
  rawData: Record<string, unknown>
}

/** Builds the iBASIS request body for subscriber create/update (provider field names only here). */
export function toIbasisSubscriberPayload(input: IbasisSubscriberInput, patch = false): Record<string, unknown> {
  const payload: Record<string, unknown> = { username: input.username }
  const fields: Array<[keyof IbasisSubscriberInput, string]> = [
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['lastName', 'last_name'],
    ['phoneNumber', 'phone_number'],
    ['email', 'email'],
    ['dateOfBirth', 'date_of_birth'],
  ]
  for (const [src, dst] of fields) {
    const val = input[src]
    if (val !== undefined && val !== null && val !== '') payload[dst] = val
  }
  // PATCH semantics: username is typically read-only on update.
  if (patch) delete payload.username
  return payload
}

export function mapIbasisSubscriber(raw: any): MappedIbasisSubscriber | null {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id
  if (id === undefined || id === null || String(id).trim() === '') return null

  const str = (v: any): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

  return {
    providerSubscriberId: String(id),
    username: str(raw.username) || '',
    firstName: str(raw.first_name),
    middleName: str(raw.middle_name),
    lastName: str(raw.last_name),
    email: str(raw.email),
    phone: str(raw.phone_number),
    dateOfBirth: str(raw.date_of_birth),
    rawData: raw as Record<string, unknown>,
  }
}

/** Stable dedupe key for a subscriber, used to avoid duplicate provider subscriber records. */
export function subscriberDedupeKey(input: { username?: string; email?: string }): string {
  const key = (input.username || input.email || '').trim().toLowerCase()
  return key
}
