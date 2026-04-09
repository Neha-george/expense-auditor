'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Building2, UserPlus } from 'lucide-react'

function OnboardingForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initCode = searchParams.get('invite_code') || ''
  
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'selection' | 'join' | 'create'>('selection')
  const [inviteCode, setInviteCode] = useState(initCode)
  const [orgName, setOrgName] = useState('')

  useEffect(() => {
    if (initCode) {
      setMode('join')
      handleJoin(initCode)
    }
  }, [initCode])

  const handleJoin = async (code: string) => {
    if (!code) return
    setLoading(true)
    
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join', inviteCode: code })
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        toast.error(data.error || 'Failed to join')
        if (data.error === 'Invalid or expired invite code') {
          router.push('/onboarding/request-access')
          return
        }
        setLoading(false)
        return
      }

      toast.success(`Successfully joined ${data.organisation.name}`)
      router.push('/employee/submit')
      router.refresh()
    } catch (e: any) {
      toast.error('An unexpected error occurred')
      setLoading(false)
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!orgName) return
    setLoading(true)

    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', orgName })
      })

      const data = await res.json()
      
      if (!res.ok) {
        toast.error(data.error || 'Failed to create organisation')
        setLoading(false)
        return
      }

      toast.success(`Successfully created ${data.organisation.name}`)
      // Admins need to upload policy to finish onboarding
      router.push('/admin/policies')
      router.refresh()
    } catch (e: any) {
      toast.error('An unexpected error occurred')
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
        <p className="text-sm text-zinc-500">Processing your request...</p>
      </div>
    )
  }

  if (mode === 'join') {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold">Join an Organisation</h2>
          <p className="mt-1 text-sm text-zinc-500">Enter your invite code below.</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); handleJoin(inviteCode) }} className="space-y-4">
          <input
            type="text"
            placeholder="e.g. GLOBALCORP"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            className="flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-950 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-300"
            required
          />
          <button type="submit" className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900">
            Join Now
          </button>
        </form>
        <button onClick={() => setMode('selection')} className="w-full text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          Back
        </button>
      </div>
    )
  }

  if (mode === 'create') {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold">Create an Organisation</h2>
          <p className="mt-1 text-sm text-zinc-500">You will be set as the initial Admin.</p>
        </div>
        <form onSubmit={handleCreate} className="space-y-4">
          <input
            type="text"
            placeholder="Organisation Name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            className="flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-950 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-300"
            required
          />
          <button type="submit" className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900">
            Create & Continue
          </button>
        </form>
        <button onClick={() => setMode('selection')} className="w-full text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Welcome to PolicyLens</h2>
        <p className="mt-1 text-sm text-zinc-500">How would you like to set up your account?</p>
      </div>
      
      <div className="space-y-4">
        <button
          onClick={() => setMode('join')}
          className="flex w-full items-center justify-between rounded-xl border border-zinc-200 p-4 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          <div className="flex items-center space-x-3">
            <UserPlus className="h-5 w-5 text-blue-500" />
            <div className="text-left">
              <p className="font-medium">Join an Organisation</p>
              <p className="text-xs text-zinc-500">I have an invite code</p>
            </div>
          </div>
        </button>
        
        <button
          onClick={() => setMode('create')}
          className="flex w-full items-center justify-between rounded-xl border border-zinc-200 p-4 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          <div className="flex items-center space-x-3">
            <Building2 className="h-5 w-5 text-indigo-500" />
            <div className="text-left">
              <p className="font-medium">Create an Organisation</p>
              <p className="text-xs text-zinc-500">I am setting this up for my company</p>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 py-12 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Suspense fallback={<div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>}>
          <OnboardingForm />
        </Suspense>
      </div>
    </div>
  )
}
