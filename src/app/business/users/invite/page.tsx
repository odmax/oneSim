'use client'

import { useState } from 'react'
import Link from 'next/link'
import { addTeamMember } from '@/lib/actions/business-users'
import CopyButton from '@/components/CopyButton'

export default function InviteUserPage() {
  const [created, setCreated] = useState<{ email: string; password: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    const formData = new FormData(e.currentTarget)
    const result = (await addTeamMember(formData)) as
      | { success: true; email: string; password: string; name: string }
      | { success: false; error: string }
    setSubmitting(false)

    if (result.success) {
      setCreated({ email: result.email, password: result.password, name: result.name })
      return
    }
    setError(result.error || 'Failed to create team member')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Add Team Member</h2>
        <p className="mt-1 text-sm text-gray-500">Create a new user with login credentials</p>
      </div>

      {created && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
          <h3 className="text-lg font-semibold text-emerald-800">Team Member Created</h3>
          <p className="mt-1 text-sm text-emerald-700">Share these credentials with {created.name || 'the new user'}.</p>
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Email</p>
              <div className="mt-1 flex items-center justify-between">
                <p className="font-mono text-sm text-gray-900">{created.email}</p>
                <CopyButton text={created.email} label="Copy Email" />
              </div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Password</p>
              <div className="mt-1 flex items-center justify-between">
                <p className="font-mono text-sm text-gray-900">{created.password}</p>
                <CopyButton text={created.password} label="Copy Password" />
              </div>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <Link href="/business/users" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Back to Team</Link>
            <button onClick={() => setCreated(null)} className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Add Another</button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!created && (
        <div className="max-w-2xl rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Full Name</label>
              <input id="name" name="name" type="text" required className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-emerald-500 focus:outline-none" placeholder="John Doe" />
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email Address</label>
              <input id="email" name="email" type="email" required className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-emerald-500 focus:outline-none" placeholder="john@company.com" />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">Password (min 8 characters)</label>
              <input id="password" name="password" type="password" required minLength={8} className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-emerald-500 focus:outline-none" placeholder="Create a password" />
            </div>
            <div>
              <label htmlFor="role" className="block text-sm font-medium text-gray-700">Permission Role</label>
              <select id="role" name="role" required className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-emerald-500 focus:outline-none">
                <option value="">Select a role</option>
                <option value="MEMBER">Member (Read-only)</option>
                <option value="ADMIN">Admin (Full access)</option>
              </select>
            </div>
            <div className="flex gap-4 pt-4">
              <button type="submit" disabled={submitting} className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50">
                {submitting ? 'Adding...' : 'Add Member'}
              </button>
              <Link href="/business/users" className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">Cancel</Link>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
