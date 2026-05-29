'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    })

    if (result?.error) {
      if (result.error === 'CredentialsSignin') {
        setError('Invalid email or password')
      } else if (result.error === 'pending') {
        setError('Your business is pending approval. Please wait for admin approval.')
      } else if (result.error === 'suspended') {
        setError('Your business account has been suspended. Please contact support.')
      } else {
        setError(result.error)
      }
      setLoading(false)
    } else {
      router.push('/dashboard')
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <Card className="w-full max-w-md mx-4 shadow-lg border-0 bg-[#1a1a2e]">
        <CardHeader className="space-y-4 pt-8">
          <div className="flex justify-center mb-2">
            <Image
              src="/brand/onesim-logo-white.svg"
              alt="OneSim Logo"
              width={160}
              height={54}
              className="object-contain"
              priority
            />
          </div>
          <div className="space-y-1 text-center">
            <CardDescription className="text-sm text-gray-300">
              Sign in to your account
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pb-8 px-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-white">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-white">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-11"
              />
            </div>
            <div className="text-right">
              <a href="/forgot-password" className="text-xs text-emerald-400 hover:text-emerald-300">Forgot password?</a>
            </div>
            {error && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 border border-red-100">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full h-11 text-base" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
