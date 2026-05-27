'use client'

import { getAdapterCredentialFields } from '@/lib/providers/adapter-manager'
import type { CredentialField } from '@/lib/providers/adapter-types'

function fieldsForAuthType(authType: string): CredentialField[] {
  switch (authType) {
    case 'credentials':
      return [
        { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Username' },
        { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Password' },
        { name: 'environment', label: 'Environment', type: 'select', required: false, placeholder: 'Select environment', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
      ]
    case 'basic':
      return [
        { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Username' },
        { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Password' },
      ]
    case 'api_key':
      return [
        { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API key' },
      ]
    case 'bearer_token':
      return [
        { name: 'apiToken', label: 'API Token / Key', type: 'password', required: true, placeholder: 'API token' },
      ]
    case 'custom':
    default:
      return [
        { name: 'apiToken', label: 'API Token / Key', type: 'password', required: false, placeholder: 'API token or key' },
        { name: 'apiBaseUrl', label: 'API Base URL', type: 'text', required: false, placeholder: 'https://api.example.com' },
      ]
  }
}

interface CredentialFieldsProps {
  type: string
  authType?: string | null
  authUrl?: string | null
  onChange?: (field: string, value: string) => void
  values?: Record<string, string>
}

export function CredentialFields({ type, authType, authUrl, onChange, values = {} }: CredentialFieldsProps) {
  const fields = authType ? fieldsForAuthType(authType) : getAdapterCredentialFields(type, authUrl)

  if (fields.length === 0) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
        No credential fields defined for provider type <strong>{type}</strong>. Select a provider type first.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={`cred-${field.name}`} className="block text-sm font-medium text-gray-700 mb-1">
            {field.label}
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {field.type === 'select' ? (
            <select
              id={`cred-${field.name}`}
              name={field.name}
              required={field.required}
              defaultValue={values[field.name] || field.options?.[0]?.value || ''}
              onChange={e => onChange?.(field.name, e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            >
              {field.options?.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <input
              id={`cred-${field.name}`}
              name={field.name}
              type={field.type}
              required={field.required}
              placeholder={field.placeholder || ''}
              defaultValue={values[field.name] || ''}
              onChange={e => onChange?.(field.name, e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
              autoComplete={field.type === 'password' ? 'new-password' : 'off'}
            />
          )}
          {field.type === 'password' && (
            <p className="mt-0.5 text-xs text-gray-400">Credentials are encrypted in transit and stored securely.</p>
          )}
        </div>
      ))}
    </div>
  )
}
