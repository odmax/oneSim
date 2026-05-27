'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PackageFormProps {
  package?: {
    id: string
    name: string
    description?: string | null
    dataGB: number
    validityDays: number
    priceUSD: number
    localPrice: number
    currency: string
    isActive: boolean
  }
}

export function PackageForm({ package: pkg }: PackageFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (formData: FormData) => {
    setLoading(true)
    
    const data = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      dataGB: parseInt(formData.get('dataGB') as string),
      validityDays: parseInt(formData.get('validityDays') as string),
      priceUSD: parseFloat(formData.get('priceUSD') as string),
      localPrice: parseFloat(formData.get('localPrice') as string),
      currency: formData.get('currency') as string || 'USD',
    }

    try {
      if (pkg) {
        // Update
        await fetch(`/api/packages/${pkg.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
      } else {
        // Create
        await fetch('/api/packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
      }
      
      router.push('/admin/packages')
      router.refresh()
    } catch (error) {
      console.error('Error saving package:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Package Name</Label>
        <Input id="name" name="name" defaultValue={pkg?.name} required />
      </div>
      
      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input id="description" name="description" defaultValue={pkg?.description || ''} />
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dataGB">Data (GB)</Label>
          <Input id="dataGB" name="dataGB" type="number" defaultValue={pkg?.dataGB} required />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="validityDays">Validity (Days)</Label>
          <Input id="validityDays" name="validityDays" type="number" defaultValue={pkg?.validityDays} required />
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="priceUSD">Price (USD)</Label>
          <Input id="priceUSD" name="priceUSD" type="number" step="0.01" defaultValue={pkg?.priceUSD} required />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="localPrice">Local Price</Label>
          <Input id="localPrice" name="localPrice" type="number" step="0.01" defaultValue={pkg?.localPrice} required />
        </div>
      </div>
      
      <Button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save Package'}
      </Button>
    </form>
  )
}
