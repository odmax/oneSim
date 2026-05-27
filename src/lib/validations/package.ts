import { z } from 'zod'

export const createPackageSchema = z.object({
  name: z.string().min(2, 'Package name is required'),
  description: z.string().optional(),
  dataGB: z.number().min(1, 'Data amount must be at least 1GB'),
  validityDays: z.number().min(1, 'Validity must be at least 1 day'),
  priceUSD: z.number().min(0.01, 'Price must be greater than 0'),
  localPrice: z.number().min(0.01, 'Local price must be greater than 0'),
  currency: z.string().default('USD'),
  providerId: z.string().optional(),
})

export const updatePackageSchema = createPackageSchema.partial().extend({
  id: z.string(),
  isActive: z.boolean().default(true),
})
