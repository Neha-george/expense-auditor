'use client'

import Link from 'next/link'
import { AlertCircle } from 'lucide-react'

export default function RequestAccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 py-12 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
          <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
        </div>
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Invalid or Expired Invite</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          The invite code linking to your organisation could not be found or has expired.
        </p>
        
        <div className="mt-6 space-y-3">
          <button
            className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            onClick={() => window.location.href = 'mailto:admin@policylens.app?subject=Requesting New Invite Code'}
          >
            Request New Invite
          </button>
          
          <Link
            href="/onboarding"
            className="block w-full rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Go Back
          </Link>
        </div>
      </div>
    </div>
  )
}
