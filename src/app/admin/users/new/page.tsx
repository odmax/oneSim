'use client'

import { useState } from 'react'
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS } from '@/lib/auth/admin-permissions'
import { createAdminUser } from '@/lib/actions/admin-users'

const ROLES = [
  { id: 'CEO', label: 'CEO' },
  { id: 'SUPER_ADMIN', label: 'Super Admin' },
  { id: 'ADMIN', label: 'Admin' },
  { id: 'SALES_TEAM', label: 'Sales Team' },
  { id: 'OPERATIONS_MANAGER', label: 'Operations Manager' },
  { id: 'PRODUCT_MANAGER', label: 'Product Manager' },
  { id: 'SUPPORT_MANAGER', label: 'Support Manager' },
  { id: 'SUPPORT_AGENT', label: 'Support Agent' },
  { id: 'ANALYTICS_MANAGER', label: 'Analytics Manager' },
  { id: 'FINANCE_MANAGER', label: 'Finance Manager' },
  { id: 'READ_ONLY', label: 'Read Only' },
]

export default function NewAdminUserPage({ searchParams }: { searchParams?: { error?: string } }) {
  const [role, setRole] = useState('')
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])

  const handleRoleChange = (newRole: string) => {
    setRole(newRole)
    setSelectedPermissions(DEFAULT_PERMISSIONS[newRole] || [])
  }

  const togglePermission = (id: string) => {
    setSelectedPermissions(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id])
  }

  const groups = [...new Set(ADMIN_PERMISSIONS.map(p => p.group))]

  return (
    <div className="space-y-6 max-w-3xl">
      <a href="/admin/users" className="text-sm text-gray-500 hover:text-gray-700">← Back to Admin Users</a>
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Add Admin User</h2>
        <p className="mt-1 text-sm text-gray-500">Create a new internal staff account with role-based permissions</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action="/admin/users/new" method="POST" className="space-y-6">

          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Basic Info</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">Full Name *</label>
                <input id="name" name="name" type="text" required
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email *</label>
                <input id="email" name="email" type="email" required
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">Password *</label>
                <input id="password" name="password" type="password" required minLength={8}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
                <p className="mt-1 text-xs text-gray-400">Min 8 characters</p>
              </div>
            </div>
          </div>

          {/* Role */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Role</h3>
            <select name="role" value={role} onChange={e => handleRoleChange(e.target.value)} required
              className="block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
              <option value="">Select a role...</option>
              {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>

          {/* Permissions */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-2">
              <h3 className="text-base font-semibold text-gray-900">Permissions</h3>
              <div className="flex gap-2">
                <button type="button" onClick={() => setSelectedPermissions(ADMIN_PERMISSIONS.map(p => p.id))}
                  className="text-xs font-medium text-emerald-600 hover:text-emerald-700">Select All</button>
                <button type="button" onClick={() => setSelectedPermissions([])}
                  className="text-xs font-medium text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <input type="hidden" name="permissions" value={JSON.stringify(selectedPermissions)} />
            {groups.map(group => (
              <div key={group}>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">{group}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {ADMIN_PERMISSIONS.filter(p => p.group === group).map(p => (
                    <label key={p.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer text-sm transition-colors ${selectedPermissions.includes(p.id) ? 'border-emerald-200 bg-emerald-50' : 'border-gray-100 bg-white hover:bg-gray-50'}`}>
                      <input type="checkbox" checked={selectedPermissions.includes(p.id)} onChange={() => togglePermission(p.id)} className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Account Status */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Account Status</h3>
            <div className="flex items-center gap-3">
              <input id="isActive" name="isActive" type="checkbox" defaultChecked className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
              <label htmlFor="isActive" className="text-sm text-gray-700">Active on creation</label>
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" formAction={createAdminUser} className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Create Admin User
            </button>
            <a href="/admin/users" className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  )
}
