import { describe, it, expect } from 'vitest'
import {
  toIbasisSubscriberPayload,
  mapIbasisSubscriber,
  subscriberDedupeKey,
} from './ibasis-subscriber-mapper'

describe('toIbasisSubscriberPayload', () => {
  it('maps app fields to provider field names', () => {
    const payload = toIbasisSubscriberPayload({
      username: 'jane.doe',
      firstName: 'Jane',
      lastName: 'Doe',
      phoneNumber: '+15551234567',
      email: 'jane@example.com',
      dateOfBirth: '1990-01-01',
    })
    expect(payload).toEqual({
      username: 'jane.doe',
      first_name: 'Jane',
      last_name: 'Doe',
      phone_number: '+15551234567',
      email: 'jane@example.com',
      date_of_birth: '1990-01-01',
    })
  })

  it('omits empty optional fields', () => {
    const payload = toIbasisSubscriberPayload({ username: 'u1' })
    expect(payload).toEqual({ username: 'u1' })
  })

  it('omits username for PATCH semantics', () => {
    const payload = toIbasisSubscriberPayload({ username: 'u1', email: 'a@b.com' }, true)
    expect(payload).toEqual({ email: 'a@b.com' })
  })
})

describe('mapIbasisSubscriber', () => {
  it('normalizes a raw subscriber payload', () => {
    const mapped = mapIbasisSubscriber({
      id: 42,
      username: 'jane.doe',
      first_name: 'Jane',
      middle_name: 'Q',
      last_name: 'Doe',
      phone_number: '+15551234567',
      email: 'jane@example.com',
      date_of_birth: '1990-01-01',
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.providerSubscriberId).toBe('42')
    expect(mapped!.firstName).toBe('Jane')
    expect(mapped!.middleName).toBe('Q')
    expect(mapped!.lastName).toBe('Doe')
    expect(mapped!.phone).toBe('+15551234567')
    expect(mapped!.email).toBe('jane@example.com')
  })

  it('returns null when id is missing', () => {
    expect(mapIbasisSubscriber({ username: 'x' })).toBeNull()
    expect(mapIbasisSubscriber({ id: '' })).toBeNull()
    expect(mapIbasisSubscriber(null)).toBeNull()
  })

  it('treats empty strings as null but keeps rawData', () => {
    const mapped = mapIbasisSubscriber({ id: 's1', username: 'u1', first_name: '', email: '  ' })
    expect(mapped!.firstName).toBeNull()
    expect(mapped!.email).toBeNull()
    expect(mapped!.rawData).toEqual({ id: 's1', username: 'u1', first_name: '', email: '  ' })
  })
})

describe('subscriberDedupeKey', () => {
  it('builds a stable lower-cased key', () => {
    expect(subscriberDedupeKey({ username: '  Jane.Doe ' })).toBe('jane.doe')
    expect(subscriberDedupeKey({ email: 'JANE@EXAMPLE.COM' })).toBe('jane@example.com')
    expect(subscriberDedupeKey({})).toBe('')
  })
})
