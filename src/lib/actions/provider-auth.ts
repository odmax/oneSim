'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { getAdapterForType, authenticateProviderViaAdapter, isTemplateDrivenProvider, buildAdapter } from '@/lib/providers/adapter-manager'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { classifyError } from '@/lib/providers/connectors/connector-interface'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import { encryptToken } from '@/lib/encryption'
import { registry } from '@/services/providerRegistry'

export async function authenticateProvider(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  const credentials: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    credentials[key] = value as string
  }

  const authResult = await authenticateProviderViaAdapter(provider.type, credentials, {
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
    return { success: false, error: authResult.error, field: 'credentials', code: authResult.code }
  }

  const accounts = authResult.accountInfo?.accounts || []
  const account = accounts.length > 0 ? accounts[0] : null
  const env = credentials.environment || provider.environment || 'staging'
  const hasMultipleAccounts = accounts.length > 1

  // Save accounts to config always
  const configUpdate: any = {
    ...((provider.config as any) || {}),
    lastAuthenticatedAt: new Date().toISOString(),
    authMethod: provider.type.toLowerCase(),
    authAccounts: accounts,
    authEnvironmentAtAuth: env,
  }

  const updateData: any = {
    environment: env,
    config: configUpdate,
  }

  if (!provider.apiBaseUrl && credentials.apiBaseUrl) {
    updateData.apiBaseUrl = credentials.apiBaseUrl
  }

  if (hasMultipleAccounts) {
    // Multiple accounts: don't save token or selection yet — admin must pick
  } else if (account) {
    // Single account: auto-select
    updateData.apiToken = encryptToken(authResult.token)
    configUpdate.selectedAccountId = account.account || ''
    configUpdate.selectedAccountName = account.accountName || ''
  }

  await prisma.provider.update({ where: { id: providerId }, data: updateData })

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
      },
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_ACCOUNT_SELECTED', entity: 'Provider', entityId: provider.code, details: `Account "${account.accountName}" (${account.account}) selected for "${provider.name}"` },
  })

  registry.invalidate(provider.code?.toLowerCase() || '')
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

  registry.invalidate(provider.code?.toLowerCase() || '')
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
        await recordHealthEvent(providerId, { eventType: 'CONNECTION_TEST', success: true, message: 'Template provider authenticated', durationMs })

        // Verify token works by calling testConnection (GET_PLANS)
        const testResult = await adapter.testConnection()
        if (testResult.success) {
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
        connectorClass: diag?.connectorClass || '—',
        method: diag?.method || '—',
        baseUrl: diag?.baseUrl || '—',
        authUrl: diag?.authUrl || '—',
        path: diag?.path || '—',
        finalUrl: diag?.finalUrl || '—',
        tokenPlacement: diag?.tokenPlacement || '—',
        authType: diag?.authType || '—',
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
        HTTP_400: 'Provider rejected request (check token, credentials, or request format)',
        NON_JSON_RESPONSE: 'Provider returned HTML or unexpected format (wrong endpoint?)',
        AUTH_ERROR: 'Authentication failed — check credentials',
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
