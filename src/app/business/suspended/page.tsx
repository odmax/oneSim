import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

export default async function SuspendedPage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const business = await prisma.business.findUnique({
    where: { id: session.user.businessId! },
    select: { name: true, status: true }
  })

  if (!business || business.status !== 'SUSPENDED') {
    redirect('/business/dashboard')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="rounded-lg border bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-red-600">
          <svg className="mx-auto h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-3.536-3.536m3.536 3.536l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mb-2 text-2xl font-bold text-gray-900">Account Suspended</h2>
        <p className="mb-4 text-gray-600">
          Your business <span className="font-semibold">{business.name}</span> has been suspended.
        </p>
        <p className="mb-6 text-sm text-gray-500">
          Please contact OneSIM support for more information about your account status.
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
