import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

export default async function PendingApprovalPage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Double-check business status
  const business = await prisma.business.findUnique({
    where: { id: session.user.businessId! },
    select: { status: true, name: true }
  })

  if (!business || business.status === 'APPROVED') {
    redirect('/business/dashboard')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="rounded-lg border bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-yellow-600">
          <svg className="mx-auto h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mb-2 text-2xl font-bold text-gray-900">Pending Approval</h2>
        <p className="mb-4 text-gray-600">
          Your business <span className="font-semibold">{business?.name}</span> is currently under review.
        </p>
        <p className="text-sm text-gray-500">
          You will gain full access once an admin approves your account. This usually takes 1-2 business days.
        </p>
        <form action="/api/auth/signout" method="POST" className="mt-6">
          <button
            type="submit"
            className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            Sign Out
          </button>
        </form>
      </div>
    </div>
  )
}
