import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)')
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64')
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const raw = Buffer.from(ciphertext, 'base64')
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Invalid ciphertext')
  }
  const iv = raw.subarray(0, IV_LENGTH)
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH).toString('base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  let plain = decipher.update(encrypted, 'base64', 'utf8')
  plain += decipher.final('utf8')
  return plain
}

export function encryptCredentials(obj: Record<string, string>): string {
  return encrypt(JSON.stringify(obj))
}

export function decryptCredentials(blob: string): Record<string, string> {
  return JSON.parse(decrypt(blob))
}

export function maskCredentials(_raw: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const key of Object.keys(_raw)) {
    masked[key] = '••••••••'
  }
  return masked
}
