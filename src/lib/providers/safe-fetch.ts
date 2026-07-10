export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  providerCode?: string
}

export interface SafeFetchResult {
  success: boolean
  status?: number
  contentType?: string
  data?: any
  errorCategory?: ErrorCategory
  errorMessage?: string
  requestId?: string
  referenceId?: string
  responseKeys?: string[]
}

export type ErrorCategory =
  | 'DNS'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'TLS'
  | 'HTTP_4xx'
  | 'HTTP_5xx'
  | 'NON_JSON'
  | 'MALFORMED_JSON'
  | 'NETWORK'
  | 'ABORTED'

function categorizeError(err: any, providerCode?: string): { category: ErrorCategory; message: string } {
  const msg = String(err?.message || err?.toString() || '')
  const code = err?.cause?.code || err?.code || ''

  if (err?.name === 'AbortError' || code === 'ETIMEDOUT' || msg.includes('timeout') || msg.includes('timed out')) {
    return { category: 'TIMEOUT', message: `${providerCode || 'Provider'} authentication timed out after 25 seconds.` }
  }
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('resolve')) {
    return { category: 'DNS', message: `Unable to resolve the ${providerCode || 'provider'} host.` }
  }
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED') || msg.includes('refused')) {
    return { category: 'CONNECTION_REFUSED', message: `${providerCode || 'Provider'} refused the connection.` }
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || msg.includes('TLS') || msg.includes('certificate') || msg.includes('self.signed')) {
    return { category: 'TLS', message: `TLS connection to ${providerCode || 'provider'} failed.` }
  }
  return { category: 'NETWORK', message: `${providerCode || 'Provider'} request failed: ${msg.substring(0, 200)}` }
}

function httpErrorMessage(status: number, providerCode?: string): string {
  const p = providerCode || 'Provider'
  switch (status) {
    case 400: return `${p} rejected the request (400 Bad Request).`
    case 401: return `${p} rejected the supplied credentials.`
    case 403: return `${p} account is not authorised for this operation.`
    case 404: return `${p} endpoint was not found.`
    case 429: return `${p} rate limit exceeded.`
    case 500: return `${p} returned an internal server error.`
    case 502: return `${p} gateway error.`
    case 503: return `${p} service is temporarily unavailable.`
    default: return `${p} returned HTTP ${status}.`
  }
}

export async function safeProviderFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 25000,
    providerCode,
  } = opts

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const fetchHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `OneSIM-${providerCode || 'Provider'}/1.0`,
      ...headers,
    }

    // Mask Authorization for logging
    const safeHeaders: Record<string, string> = { ...fetchHeaders }
    if (safeHeaders.Authorization) safeHeaders.Authorization = 'Bearer ••••'
    console.log(`[SAFE_FETCH] ${method} ${url} headers=${JSON.stringify(safeHeaders)}`)

    const response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body,
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const responseContentType = response.headers.get('content-type') || ''
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-correlation-id') || undefined
    const referenceId = response.headers.get('x-reference-id') || undefined

    const responseText = await response.text()
    let data: any
    try {
      data = JSON.parse(responseText)
    } catch {
      if (responseText.trim().startsWith('<')) {
        return {
          success: false,
          status: response.status,
          contentType: responseContentType,
          errorCategory: 'NON_JSON',
          errorMessage: `${providerCode || 'Provider'} returned an HTML response instead of JSON.`,
          requestId,
          referenceId,
        }
      }
      return {
        success: false,
        status: response.status,
        contentType: responseContentType,
        errorCategory: 'MALFORMED_JSON',
        errorMessage: `${providerCode || 'Provider'} returned an invalid JSON response.`,
        requestId,
        referenceId,
      }
    }

    const responseKeys = data && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data)
      : []

    console.log(`[SAFE_FETCH_RESPONSE] status=${response.status} contentType=${responseContentType} keys=${responseKeys.join(',')} requestId=${requestId || 'N/A'}`)

    if (!response.ok) {
      const category = response.status >= 500 ? 'HTTP_5xx' : 'HTTP_4xx'
      const providerMsg = data.message || data.errorMessage || data.error || ''
      return {
        success: false,
        status: response.status,
        contentType: responseContentType,
        errorCategory: category,
        errorMessage: providerMsg
          ? `${httpErrorMessage(response.status, providerCode)} ${providerMsg}`
          : httpErrorMessage(response.status, providerCode),
        data,
        requestId,
        referenceId,
        responseKeys,
      }
    }

    return {
      success: true,
      status: response.status,
      contentType: responseContentType,
      data,
      requestId,
      referenceId,
      responseKeys,
    }
  } catch (err: any) {
    clearTimeout(timeout)
    const { category, message } = categorizeError(err, providerCode)
    console.log(`[SAFE_FETCH_ERROR] category=${category} message=${message}`)
    return {
      success: false,
      errorCategory: category,
      errorMessage: message,
    }
  }
}
