export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { refreshExchangeRates } from '@/lib/currency/exchange-rate-refresh'

export async function POST(req: NextRequest) {
  const enabled = process.env.EXCHANGE_RATE_REFRESH_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Exchange rate refresh is disabled' }, { status: 403 })

  const secret = process.env.EXCHANGE_RATE_JOB_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (!auth || auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const result = await refreshExchangeRates()
  return NextResponse.json(result)
}
