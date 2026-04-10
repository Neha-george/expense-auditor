'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { toast } from 'sonner'
import { usePathname } from 'next/navigation'

interface RealtimeContextType {
  newClaimsCount: number
  latestClaim: any | null
  resetCount: () => void
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined)

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [newClaimsCount, setNewClaimsCount] = useState(0)
  const [latestClaim, setLatestClaim] = useState<any | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    // Only fetch for admins based on URL or generic. Since we want it globally available for admins.
    // If not matching admin paths, we can still run it safely as RLS will protect non-admins.
    if (!pathname?.startsWith('/admin')) return

    const supabase = createClient()
    
    const channel = supabase
      .channel('public:claims')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'claims' }, (payload) => {
        const newClaim = payload.new
        setLatestClaim(newClaim)
        setNewClaimsCount(prev => prev + 1)
        
        toast.info(
          `New Claim Submitted: $${Number(newClaim.amount || 0).toFixed(2)} from ${newClaim.merchant || 'Unknown'}`
        )
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [pathname])

  // Register Service Worker for PWA offline support
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => {})

    // Listen for the SW telling us to flush the offline queue
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'FLUSH_OFFLINE_QUEUE') {
        window.dispatchEvent(new CustomEvent('policylens:flush-offline-queue'))
      }
    }
    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, [])

  const resetCount = () => setNewClaimsCount(0)

  return (
    <RealtimeContext.Provider value={{ newClaimsCount, latestClaim, resetCount }}>
      {children}
    </RealtimeContext.Provider>
  )
}

export function useRealtime() {
  const context = useContext(RealtimeContext)
  if (!context) return { newClaimsCount: 0, latestClaim: null, resetCount: () => {} }
  return context
}
