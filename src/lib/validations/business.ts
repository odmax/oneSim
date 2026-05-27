import { z } from 'zod'

export const createBusinessSchema = z.object({
  name: z.string().min(2, 'Company name is required'),
  regNumber: z.string().optional(),
  taxId: z.string().optional(),
  contactEmail: z.string().email('Invalid email address'),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
  country: z.string().min(2, 'Country is required'),
})

export const updateBusinessStatusSchema = z.object({
  businessId: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'SUSPENDED']),
})
