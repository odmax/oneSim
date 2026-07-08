import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import TemplateClient from './TemplateClient'

export default async function IntegrationTemplatePage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')
  return <TemplateClient />
}
