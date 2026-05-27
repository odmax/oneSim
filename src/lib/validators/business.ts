import { z } from 'zod';

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
});

export const addTeamMemberSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['ADMIN', 'MEMBER'], {
    errorMap: () => ({ message: 'Role must be ADMIN or MEMBER' }),
  }),
});

export const purchaseESIMSchema = z.object({
  packageId: z.string().min(1, 'Package is required'),
  quantity: z.number().min(1, 'Quantity must be at least 1').max(100, 'Maximum 100 eSIMs per purchase'),
});
