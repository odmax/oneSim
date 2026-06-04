const PRISMA_ERROR_MESSAGES: Record<string, string> = {
  P2000: 'Value is too long for the column.',
  P2002: 'A record with this value already exists. Duplicate not allowed.',
  P2003: 'Cannot delete because related records exist. Archive instead.',
  P2004: 'A database constraint failed.',
  P2005: 'Invalid value for the field.',
  P2011: 'A required field is missing.',
  P2014: 'This operation would break a required relation.',
  P2022: 'Database schema mismatch — a column is missing. Run the latest migration.',
  P2023: 'Inconsistent column data.',
  P2025: 'Record not found. It may have been deleted.',
}

export function handlePrismaError(error: any, defaultMessage = 'An unexpected error occurred. Please try again.'): { message: string; status?: number; code?: string } {
  // Pass through Next.js redirect errors
  if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error

  if (!error || !error.code) {
    // Not a Prisma error
    return { message: error?.message || defaultMessage, status: 500 }
  }

  const message = PRISMA_ERROR_MESSAGES[error.code]

  if (message) {
    console.error(`[Prisma ${error.code}] ${message}`, error.meta || '')
    return { message, code: error.code, status: error.code === 'P2002' ? 409 : error.code === 'P2003' ? 409 : error.code === 'P2025' ? 404 : 400 }
  }

  // Unknown Prisma error — log full details
  console.error(`[Prisma ${error.code}] Unhandled Prisma error:`, error?.message || error, error?.meta ? JSON.stringify(error.meta) : '')
  return { message: defaultMessage, code: error.code, status: 500 }
}

export function handleServerActionError(error: any, redirectBase: string, defaultError = 'operation_failed') {
  if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error

  const { message, code } = handlePrismaError(error)

  // Map Prisma codes to URL-safe error params
  const errorMap: Record<string, string> = {
    P2002: 'duplicate_record',
    P2003: 'related_records_exist',
    P2022: 'schema_mismatch',
    P2025: 'not_found',
  }

  const errorKey = code && errorMap[code] ? errorMap[code] : defaultError
  const { redirect } = require('next/navigation')
  redirect(`${redirectBase}?error=${errorKey}`)
}