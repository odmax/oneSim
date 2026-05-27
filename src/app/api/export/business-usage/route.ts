import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const data = searchParams.get('data')
  
  if (!data) {
    return new NextResponse('No data provided', { status: 400 })
  }
  
  try {
    const records = JSON.parse(data)
    const csv = [
      ['Date', 'ICCID', 'Customer', 'Package', 'Data Used (GB)'],
      ...records.map((r: any) => [r.date, r.iccid, r.customer, r.package, r.dataUsedGB])
    ].map(row => row.join(',')).join('\n')
    
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="business-usage-report.csv"'
      }
    })
  } catch (error) {
    return new NextResponse('Error generating CSV', { status: 500 })
  }
}
