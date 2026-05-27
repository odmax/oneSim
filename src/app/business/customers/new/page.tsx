import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import Link from 'next/link'

export default async function NewCustomerPage({
  searchParams
}: {
  searchParams: { error?: string }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Get business ID for current user
  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id }
  })

  if (!businessUser) {
    redirect('/login')
  }

  const businessId = businessUser.businessId

  async function createCustomer(formData: FormData) {
    'use server'
    
    const name = formData.get('name') as string
    const email = formData.get('email') as string
    const phone = formData.get('phone') as string
    const country = formData.get('country') as string

    if (!name || !email || !country) {
      redirect('/business/customers/new?error=missing_required')
    }

    try {
      await prisma.customer.create({
        data: {
          businessId: businessId,
          name,
          email,
          phone: phone || null,
          country,
          status: 'ACTIVE'
        }
      })

      revalidatePath('/business/customers')
      redirect('/business/customers')
    } catch (error: any) {
      if (error?.code === 'P2002') {
        redirect('/business/customers/new?error=email_exists')
      }
      redirect('/business/customers/new?error=creation_failed')
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Add New Customer</h2>
        <p className="text-gray-600">Create an end customer to assign eSIMs to</p>
      </div>

      {searchParams.error && (
        <div className="mb-6 rounded-lg bg-red-50 p-4">
          <p className="text-sm text-red-800">
            {searchParams.error === 'missing_required' && 'Please fill in all required fields.'}
            {searchParams.error === 'email_exists' && 'A customer with this email already exists.'}
            {searchParams.error === 'creation_failed' && 'Failed to create customer. Please try again.'}
          </p>
        </div>
      )}

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form action={createCustomer} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Customer Name *
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              placeholder="John Doe"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email Address *
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="customer@company.com"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
              Phone Number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              placeholder="+1234567890"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="country" className="block text-sm font-medium text-gray-700">
              Country *
            </label>
            <input
              id="country"
              name="country"
              type="text"
              required
              placeholder="South Africa"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Create Customer
            </button>
            <Link
              href="/business/customers"
              className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
