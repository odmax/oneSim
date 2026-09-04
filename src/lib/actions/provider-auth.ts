'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { invalidateProviderBalanceSnapshot } from '@/lib/services/providers/provider-balance'
import { getAdapterForType, authenticateProviderViaAdapter, isTemplateDrivenProvider, buildAdapter } from '@/lib/providers/adapter-manager'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { classifyError } from '@/lib/providers/connectors/connector-interface'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import { encryptToken } from '@/lib/encryption'
import { advanceCertificationTo, markCertificationFailed } from '@/lib/providers/certification-machine'

function getJsonString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = (value as Record<string, unknown>)[key]
  return typeof result === 'string' ? result : undefined
}

export async function authenticateProvider(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  console.log(`[PROVIDER_AUTH_START] id=${provider.id} code=${provider.code} type=${provider.type} strategy=${provider.adapterStrategy} authType=${provider.authType}`)

  // Extract fd from formData
  const fd: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    fd[key] = value as string
  }

  // Log credential field names (never values)
  console.log(`[PROVIDER_AUTH_FIELDS] fields=${Object.keys(fd).filter(k => !['password','apiToken','token'].includes(k)).join(',')}`)

  // For bearer_token: save token directly, validate via testConnection
  if (provider.authType === 'bearer_token') {
    const apiToken = fd.apiToken || fd.api_token || fd.token
    if (!apiToken) return { success: false, error: 'API token is required for bearer_token authentication', field: 'apiToken' }

    await prisma.provider.update({
      where: { id: providerId },
      data: {
        apiToken: encryptToken(apiToken),
        environment: fd.environment || provider.environment || 'staging',
      },
    })

    await recordHealthEvent(providerId, {
      eventType: 'CONNECTION_TEST',
      success: true,
      message: 'Bearer token saved',
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'PROVIDER_TOKEN_SAVED', entity: 'Provider', entityId: provider.code, details: `"${provider.name}" bearer token saved` },
    })

    revalidatePath(`/admin/providers/${providerId}`)
    return { success: true, message: 'API token saved. Use Test Connection to verify.' }
  }

  // Static-credential modes (STATIC_KEY_ID / STATIC_API_KEY / BEARER_TOKEN):
  // save the credential and VERIFY read-only — never fake a runtime login.
  const connector = await buildConnectorFromProvider(providerId).catch(() => null)
  const authProfile = connector?.authProfile
  if (authProfile && !authProfile.requiresRuntimeAuthentication) {
    const credential = fd.apiToken || fd.api_token || fd.token || fd.keyId || fd.key_id || fd.apiKey
    if (!credential) {
      return { success: false, error: `${authProfile.mode === 'STATIC_KEY_ID' ? 'KeyID' : 'API key'} is required`, field: 'apiToken' }
    }

    await prisma.provider.update({
      where: { id: providerId },
      data: {
        apiToken: encryptToken(credential),
        environment: fd.environment || provider.environment || 'staging',
      },
    })

    const verify = await runReadOnlyVerification(providerId)
    await recordHealthEvent(providerId, {
      eventType: 'CONNECTION_TEST',
      success: verify.success,
      message: verify.success ? `${provider.name} credentials saved and verified` : `Credential saved, verification failed: ${verify.error || ''}`,
    })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'PROVIDER_CREDENTIAL_SAVED', entity: 'Provider', entityId: provider.code, details: `"${provider.name}" ${authProfile.mode} credential saved (${verify.success ? 'verified' : 'unverified'})` },
    })
    revalidatePath(`/admin/providers/${providerId}`)

    if (!verify.success) {
      return { success: false, error: `Credential saved, but verification failed: ${verify.error || 'Unknown'}` }
    }
    return { success: true, message: `Credential saved and verified (${authProfile.actionLabel || 'Save & Verify'})` }
  }

  // For fd/auth types, run full adapter authentication
  const authResult = await authenticateProviderViaAdapter(provider.type, fd, {
    apiBaseUrl: provider.apiBaseUrl,
    apiToken: provider.apiToken,
    providerId: provider.id,
  })

  if (!authResult.success) {
    await recordHealthEvent(providerId, {
      eventType: 'AUTH_FAILURE',
      success: false,
      message: authResult.error || 'Authentication failed',
    })
    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'PROVIDER_AUTH_FAILED', entity: 'Provider', entityId: provider.code, details: `"${provider.name}" auth failed: ${authResult.error}` },
    })
    return { success: false, error: authResult.error, field: 'fd', code: authResult.code }
  }

  const accounts = authResult.accountInfo?.accounts || []
  const account = accounts.length > 0 ? accounts[0] : null
  const env = fd.environment || provider.environment || 'staging'
  const hasMultipleAccounts = accounts.length > 1

  // Save accounts to config always
  const configUpdate: any = {
    ...((provider.config as any) || {}),
    lastAuthenticatedAt: new Date().toISOString(),
    authMethod: provider.type.toLowerCase(),
    authAccounts: accounts,
    authEnvironmentAtAuth: env,
    // Preserve fd for subsequent testConnection calls
    ...(fd.username ? { username: fd.username } : {}),
    ...(fd.password ? { password: fd.password } : {}),
    ...(fd.apiKey ? { apiKey: fd.apiKey } : {}),
    ...(fd.clientId ? { clientId: fd.clientId } : {}),
  }

  const updateData: any = {
    environment: env,
    config: configUpdate,
  }

  if (!provider.apiBaseUrl && fd.apiBaseUrl) {
    updateData.apiBaseUrl = fd.apiBaseUrl
  }

  if (hasMultipleAccounts) {
    // Multiple accounts: don't save token or selection yet — admin must pick
  } else if (account) {
    // Single account: auto-select
    updateData.apiToken = encryptToken(authResult.token)
    configUpdate.selectedAccountId = account.account || ''
    configUpdate.selectedAccountName = account.accountName || ''
    // Persist the authenticated Choice account id so the purchase payload's
    // user_id is never a placeholder. account.userId is the API user id when
    // the provider returns it; account.account is the account identifier.
    configUpdate.userId = account.userId || account.account || ''
  }

  await prisma.provider.update({ where: { id: providerId }, data: updateData })
  invalidateProviderBalanceSnapshot(providerId).catch(() => {})

  // Safe diagnostics: log token storage without values
  const tokenStored = !!authResult.token && !hasMultipleAccounts
  const tokenSource = getJsonString(provider.responseMappings, 'tokenPath') ?? getJsonString(provider.config, 'tokenPath') ?? 'auto-detect'
  console.log(`[PROVIDER_AUTH_RESULT] success=true code=${provider.code} tokenExtracted=${!!authResult.token} tokenPersisted=${tokenStored} tokenSource=${tokenSource} multiAccount=${hasMultipleAccounts}`)

  await recordHealthEvent(providerId, {
    eventType: 'CONNECTION_TEST',
    success: true,
    message: `Authenticated successfully`,
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_AUTHENTICATED', entity: 'Provider', entityId: provider.code, details: `"${provider.name}" authenticated. ${accounts.length} account(s) found.` },
  })

  revalidatePath(`/admin/providers/${providerId}`)

  const authDiag = authResult.accountInfo?.authDiagnostics || null

  if (hasMultipleAccounts) {
    return {
      success: true,
      needsAccountSelection: true,
      accounts: accounts.map((a: any) => ({
        account: a.account,
        accountName: a.accountName,
        token: maskToken(a.token),
      })),
      message: `${accounts.length} accounts found. Select the correct account below.`,
      diagnostics: authDiag,
    }
  }

  return { success: true, message: 'Authenticated successfully', diagnostics: authDiag }
}

export async function selectProviderAccount(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  const accountId = formData.get('accountId') as string
  if (!accountId) return { success: false, error: 'No account selected' }

  const config = (provider.config as any) || {}
  const accounts = config.authAccounts || []
  const account = accounts.find((a: any) => a.account === accountId || a.token === accountId)

  if (!account) return { success: false, error: `Account "${accountId}" not found in stored accounts. Re-authenticate.` }

  // Clear old token then save selected account
  await prisma.provider.update({
    where: { id: providerId },
    data: {
      apiToken: encryptToken(account.token),
      config: {
        ...config,
        selectedAccountId: account.account,
        selectedAccountName: account.accountName,
        // Persist the authenticated Choice account id (never a placeholder).
        userId: account.userId || account.account || '',
      },
    },
  })
  invalidateProviderBalanceSnapshot(providerId).catch(() => {})

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_ACCOUNT_SELECTED', entity: 'Provider', entityId: provider.code, details: `Account "${account.accountName}" (${account.account}) selected for "${provider.name}"` },
  })

  revalidatePath(`/admin/providers/${providerId}`)
  return { success: true, message: `Account "${account.accountName}" selected. Token updated.` }
}

export async function clearProviderCredentials(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  await prisma.provider.update({
    where: { id: providerId },
    data: {
      apiToken: null,
      config: {},
      lastSuccessfulConnection: null,
      lastFailedConnection: null,
      errorCount: 0,
      lastError: null,
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_CREDENTIALS_CLEARED', entity: 'Provider', entityId: provider.code, details: `Credentials cleared for "${provider.name}"` },
  })

  revalidatePath(`/admin/providers/${providerId}`)
  return { success: true, message: 'Credentials cleared successfully' }
}

export async function getProviderAccountConfig(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return null
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      apiToken: true,
      config: true,
      apiBaseUrl: true,
      authUrl: true,
      environment: true,
      type: true,
      adapterStrategy: true,
    },
  })
  if (!provider) return null

  const config = (provider.config as any) || {}
  const accounts = config.authAccounts || []
  const envAtAuth = config.authEnvironmentAtAuth || provider.environment || 'staging'
  const currentEnv = provider.environment || 'staging'

  return {
    apiToken: provider.apiToken ? '••••••••' : null,
    apiBaseUrl: provider.apiBaseUrl,
    authUrl: provider.authUrl,
    environment: provider.environment,
    adapterStrategy: provider.adapterStrategy,
    envAtAuth,
    envMismatch: currentEnv !== envAtAuth,
    accounts: accounts.map((a: any) => ({
      account: a.account,
      accountName: a.accountName,
      token: maskToken(a.token),
    })),
    selectedAccountId: config.selectedAccountId || '',
    selectedAccountName: config.selectedAccountName || '',
    envWarning: config._envWarning || null,
    hasToken: !!provider.apiToken,
    hasCredentials: !!config.authMethod,
  }
}

function maskToken(token: string | null): string | null {
  if (!token || token.length < 8) return token
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

/**
 * Read-only credential verification for static-credential auth modes
 * (STATIC_KEY_ID / STATIC_API_KEY / BEARER_TOKEN). Builds the canonical
 * connector (which re-reads the freshly saved credential), calls its read-only
 * connection test, and updates lastSuccessfulConnection / lastFailedConnection.
 * Never logs or sends credential values.
 */
async function runReadOnlyVerification(providerId: string): Promise<{ success: boolean; error?: string }> {
  const connector = await buildConnectorFromProvider(providerId).catch(() => null)
  if (!connector) return { success: false, error: 'Provider connector unavailable' }
  try {
    const result = await connector.diagnoseConnection()
    const healthUpdate: any = {}
    if (result.success && !result.error) {
      healthUpdate.lastSuccessfulConnection = new Date()
      healthUpdate.errorCount = 0
      healthUpdate.lastError = null
    } else {
      healthUpdate.lastFailedConnection = new Date()
      healthUpdate.lastError = result.error?.message || 'Connection test failed'
    }
    await prisma.provider.update({ where: { id: providerId }, data: healthUpdate })
    return result.success
      ? { success: true }
      : { success: false, error: result.error?.message || 'Connection test failed' }
  } catch (e: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: { lastFailedConnection: new Date(), lastError: String(e?.message || 'Verification error').slice(0, 300) },
    }).catch(() => {})
    return { success: false, error: String(e?.message || 'Verification failed').slice(0, 300) }
  }
}

export async function testProviderConnection(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider) return { success: false, error: 'Provider not found' }

  try {
    const startTime = Date.now()
    const config = (provider.config as any) || {}

    // Template-driven providers use TemplateProviderAdapter
    if (isTemplateDrivenProvider(provider)) {
      const adapter = await buildAdapter(provider)
      if (!adapter) return { success: false, error: 'Failed to create adapter for template-driven provider', diagnostics: null }

      // Authenticate first to get the token, then test connection (which also calls GET_PLANS)
      const authResult = await adapter.authenticate({})
      const durationMs = Date.now() - startTime
      const diagnostics = {
        adapter: 'TemplateProviderAdapter',
        providerCode: provider.code,
        adapterStrategy: provider.adapterStrategy,
        providerType: provider.type,
        authType: provider.authType,
        authUrl: provider.authUrl || '(from endpointMappings)',
        apiBaseUrl: provider.apiBaseUrl || '(not set)',
        apiVersion: provider.apiVersion || '(not set)',
        tokenPlacement: provider.tokenPlacement,
        endpointMappings: provider.endpointMappings,
        config: { ...config, password: undefined, apiToken: undefined },
      }

      if (authResult.success && authResult.data?.token) {
        await prisma.provider.update({
          where: { id: providerId },
          data: {
            apiToken: encryptToken(authResult.data.token),
            lastSuccessfulConnection: new Date(),
            errorCount: 0,
            lastError: null,
          },
        })
        invalidateProviderBalanceSnapshot(providerId).catch(() => {})
        await advanceCertificationTo(providerId, 'AUTHENTICATED')
        await recordHealthEvent(providerId, { eventType: 'CONNECTION_TEST', success: true, message: 'Template provider authenticated', durationMs })

        // Verify token works by calling testConnection (GET_PLANS)
        const testResult = await adapter.testConnection()
        if (testResult.success) {
          await advanceCertificationTo(providerId, 'CONNECTED')
          return { success: true, message: `Connected. ${testResult.data?.message || ''}`, diagnostics }
        }
        return { success: true, message: `Authenticated. Token stored, but GET_PLANS: ${testResult.error?.message || 'failed'}`, diagnostics }
      }

      await prisma.provider.update({
        where: { id: providerId },
        data: { lastFailedConnection: new Date(), lastError: authResult.error?.message || 'Auth failed' },
      })
      await recordHealthEvent(providerId, { eventType: 'CONNECTION_TEST', success: false, message: authResult.error?.message || 'Auth failed', durationMs })
      return { success: false, error: authResult.error?.message || 'Authentication failed', diagnostics }
    }

    // Build connector from provider config
    const connector = await buildConnectorFromProvider(providerId)
    if (connector) {
      const diagResult = await connector.diagnoseConnection()
      const durationMs = Date.now() - startTime
      const healthUpdate: any = {}

      if (diagResult.success && !diagResult.error) {
        healthUpdate.lastSuccessfulConnection = new Date()
        healthUpdate.errorCount = 0
        healthUpdate.lastError = null
      } else {
        healthUpdate.lastFailedConnection = new Date()
        healthUpdate.lastError = diagResult.error?.message || 'Connection test failed'
      }

      await prisma.provider.update({ where: { id: providerId }, data: healthUpdate })

      await recordHealthEvent(providerId, {
        eventType: 'CONNECTION_TEST',
        success: diagResult.success,
        message: diagResult.success ? 'Connection test passed' : (diagResult.error?.message || 'Connection test failed'),
        durationMs,
      })

      const diag = diagResult.data

      const diagnostics = {
        adapter: 'Connector',
        providerCode: provider.code,
        adapterStrategy: provider.adapterStrategy,
        providerType: provider.type,
        authType: provider.authType,
        connectorClass: diag?.connectorClass || '—',
        method: diag?.method || '—',
        baseUrl: diag?.baseUrl || '—',
        authUrl: provider.authUrl || '—',
        path: diag?.path || '—',
        finalUrl: diag?.finalUrl || '—',
        tokenPlacement: diag?.tokenPlacement || '—',
        authHeaderPresent: diag?.authHeaderPresent ?? false,
        tokenReplaced: diag?.tokenReplaced ?? false,
        responseStatus: diag?.responseStatus ?? null,
        responseContentType: diag?.responseContentType || null,
        responseBody: diag?.responseBody || null,
        warnings: diag?.warnings || [],
        errorClassification: diag?.errorClassification || null,
        requestTimeoutMs: diag?.requestTimeoutMs || 15000,
        retryAttempted: diag?.retryAttempted || false,
        retryExplanation: diag?.retryExplanation || null,
        accountId: config.selectedAccountId || '—',
        accountName: config.selectedAccountName || '—',
        apiToken: provider.apiToken ? '••••••••' : '—',
        apiBaseUrl: provider.apiBaseUrl || '—',
        environment: provider.environment || '—',
        latencyMs: durationMs,
      }

      if (diagResult.success && !diagResult.error) {
        return {
          success: true,
          message: `Connected. | ${durationMs}ms`,
          latencyMs: durationMs,
          diagnostics,
        }
      }
      const classification = classifyError(diagResult.error, diag?.warnings)
      const errorMessages: Record<string, string> = {
        NETWORK_ERROR: 'Request failed — provider not reachable (network error)',
        HTTP_404: 'Wrong URL / Endpoint not found',
        HTTP_400: 'Provider rejected request (check token, fd, or request format)',
        NON_JSON_RESPONSE: 'Provider returned HTML or unexpected format (wrong endpoint?)',
        AUTH_ERROR: 'Authentication failed — check fd',
        TOKEN_MISSING: 'No API token configured',
        TOKEN_NOT_REPLACED: 'Token placeholder {{token}} not replaced in URL',
      }
      const errorMessage = errorMessages[classification] || diagResult.error?.message || 'Connection test failed'
      return {
        success: false,
        error: errorMessage,
        diagnostics,
      }
    }

    // Fall back to legacy adapter
    const adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl,
      apiToken: provider.apiToken,
      providerId: provider.id,
    })

    const result = await adapter.testConnection()
    const durationMs = Date.now() - startTime
    const healthUpdate: any = {}

    if (result.success) {
      healthUpdate.lastSuccessfulConnection = new Date()
      healthUpdate.errorCount = 0
      healthUpdate.lastError = null
    } else {
      healthUpdate.lastFailedConnection = new Date()
      healthUpdate.lastError = result.error?.message || 'Connection test failed'
    }

    await prisma.provider.update({ where: { id: providerId }, data: healthUpdate })

    await recordHealthEvent(providerId, {
      eventType: 'CONNECTION_TEST',
      success: result.success,
      message: result.success ? 'Connection test passed' : (result.error?.message || 'Connection test failed'),
      durationMs,
    })

    const runtimeInfo = `Runtime: LegacyAdapter (${adapter.name})`

    if (result.success) {
      return { success: true, message: `Connected. ${result.data?.message || ''}${runtimeInfo} | ${durationMs}ms`, latencyMs: result.data?.latencyMs }
    }
    return { success: false, error: result.error?.message || 'Connection test failed' }
  } catch (e: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: { lastFailedConnection: new Date(), lastError: e.message },
    })
    return { success: false, error: e.message || 'Connection test threw an error' }
  }
}

export async function getProviderAuthStatus(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { hasToken: false, isConnected: false, status: 'unknown' }
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: {
      apiToken: true,
      lastSuccessfulConnection: true,
      lastFailedConnection: true,
      errorCount: true,
      lastError: true,
      status: true,
      config: true,
      type: true,
    },
  })

  if (!provider) return { hasToken: false, isConnected: false, status: 'unknown' }

  // Template-driven providers may store token in config rather than apiToken field
  const configToken = (provider.config as any)?.apiToken || (provider.config as any)?.token || null
  const hasToken = !!provider.apiToken || !!configToken || !!provider.lastSuccessfulConnection

  let status: string
  if (provider.lastSuccessfulConnection && (!provider.lastFailedConnection || provider.lastSuccessfulConnection > provider.lastFailedConnection) && (provider.errorCount ?? 0) === 0) {
    status = 'connected'
  } else if (!hasToken) {
    status = 'not_configured'
  } else if (provider.lastSuccessfulConnection && (!provider.lastFailedConnection || provider.lastSuccessfulConnection > provider.lastFailedConnection)) {
    status = 'connected'
  } else if (provider.lastError?.includes('token') || provider.lastError?.includes('expired') || provider.lastError?.includes('401')) {
    status = 'token_expired'
  } else if (provider.lastFailedConnection) {
    status = 'failed'
  } else {
    status = 'configured'
  }

  return {
    hasToken,
    isConnected: status === 'connected',
    status,
    lastSuccessfulConnection: provider.lastSuccessfulConnection?.toISOString(),
    lastFailedConnection: provider.lastFailedConnection?.toISOString(),
    lastError: provider.lastError,
    errorCount: provider.errorCount,
    providerStatus: provider.status,
    type: provider.type,
    authMethod: (provider.config as any)?.authMethod || null,
    lastAuthenticatedAt: (provider.config as any)?.lastAuthenticatedAt || null,
  }
}
