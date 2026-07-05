import { redirect } from 'next/navigation'

export default function ImportedPlansRedirect() {
  redirect('/admin/provider-catalog')
}
