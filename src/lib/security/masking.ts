export function maskSecret(value: string | null | undefined, visibleChars: number = 4): string {
  if (!value) return ''
  if (value.length <= visibleChars * 2) return '*'.repeat(value.length)
  return value.slice(0, visibleChars) + '*'.repeat(Math.min(value.length - visibleChars * 2, 20)) + value.slice(-visibleChars)
}

export function maskSensitiveFields(obj: any, sensitiveKeys: string[] = []): any {
  if (!obj || typeof obj !== 'object') return obj
  const defaultKeys = ['password', 'apiKey', 'apiToken', 'token', 'secret', 'keyHash', 'authorization', 'x-api-key', 'bearer', 'refreshToken', 'access_token', 'api_key']

  const masked = Array.isArray(obj) ? [...obj] : { ...obj }

  for (const key of Object.keys(masked)) {
    const keyLower = key.toLowerCase()
    const isSensitive = sensitiveKeys.some(sk => keyLower.includes(sk.toLowerCase())) || defaultKeys.some(dk => keyLower.includes(dk))
    if (isSensitive && typeof masked[key] === 'string') {
      masked[key] = maskSecret(masked[key])
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      masked[key] = maskSensitiveFields(masked[key], sensitiveKeys)
    }
  }

  return masked
}

export function sanitizeRequestBody(body: any): any {
  return maskSensitiveFields(body, ['password', 'apiKey', 'token', 'secret'])
}

export function sanitizeResponseBody(body: any): any {
  return maskSensitiveFields(body, ['apiToken', 'token', 'secret', 'keyHash', 'activationCode'])
}

export function maskAuthHeader(header: string | null): string {
  if (!header) return ''
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7)
    return `Bearer ${maskSecret(token, 6)}`
  }
  if (header.startsWith('Basic ')) return 'Basic ****'
  return maskSecret(header, 6)
}
