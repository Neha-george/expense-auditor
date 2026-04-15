'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { toast } from 'sonner'
import { Loader2, Save } from 'lucide-react'

// Define the static structure for the grid
const SENIORITIES = ['junior', 'mid', 'senior', 'executive'] as const
const CATEGORIES = ['meals', 'travel', 'accommodation', 'transport', 'office', 'entertainment', 'other'] as const

type LimitsMap = Record<string, Record<string, number>>

export default function SpendLimitsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [orgId, setOrgId] = useState<string | null>(null)

  // Double map: Seniority -> Category -> Limit
  const [limits, setLimits] = useState<LimitsMap>(() => {
    const init: LimitsMap = {}
    SENIORITIES.forEach(s => {
      init[s] = {}
      CATEGORIES.forEach(c => {
        init[s][c] = 0
      })
    })
    return init
  })

  useEffect(() => {
    const fetchLimits = async () => {
      const supabase = createClient()
      
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from('profiles')
        .select('organisation_id')
        .eq('id', user.id)
        .single()
      
      if (!profile?.organisation_id) return
      setOrgId(profile.organisation_id)

      const { data: limitsData } = await supabase
        .from('spend_limits')
        .select('*')
        .eq('organisation_id', profile.organisation_id)
      
      if (limitsData && limitsData.length > 0) {
        setLimits(prev => {
          const next = JSON.parse(JSON.stringify(prev))
          limitsData.forEach(row => {
            if (next[row.seniority]) {
              next[row.seniority][row.category] = Number(row.monthly_limit || 0)
            }
          })
          return next
        })
      }
      
      setLoading(false)
    }

    fetchLimits()
  }, [])

  const handleSave = async () => {
    if (!orgId) return
    setSaving(true)
    
    const supabase = createClient()
    
    // Flatten map into upsert rows
    const rowsToUpsert = []
    for (const s of SENIORITIES) {
      for (const c of CATEGORIES) {
        rowsToUpsert.push({
          organisation_id: orgId,
          seniority: s,
          category: c,
          monthly_limit: limits[s][c],
          currency: 'INR'
        })
      }
    }

    // Upsert expects unique constraint on (organisation_id, seniority, category)
    const { error } = await supabase
      .from('spend_limits')
      .upsert(rowsToUpsert, { onConflict: 'organisation_id, seniority, category' })
      
    if (error) {
      toast.error('Failed to save limits: ' + error.message)
    } else {
      toast.success('Spend limits successfully updated!')
    }
    
    setSaving(false)
  }

  const handleChange = (seniority: string, category: string, val: string) => {
    const num = Math.max(0, Number(val) || 0)
    setLimits(prev => ({
      ...prev,
      [seniority]: {
        ...prev[seniority],
        [category]: num
      }
    }))
  }

  if (loading) {
    return <div className="p-8 text-center text-zinc-500">Loading limits...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Spend Limits</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Define strict monthly budgets (INR) per employee tier and expense category.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save Configuration
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-x-auto dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm text-left text-zinc-500 dark:text-zinc-400">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            <tr>
              <th className="px-6 py-4 font-semibold text-zinc-900 dark:text-zinc-100">Seniority</th>
              {CATEGORIES.map(c => (
                <th key={c} className="px-3 py-4 font-semibold">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {SENIORITIES.map(seniority => (
              <tr key={seniority} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/50">
                <td className="px-6 py-4 font-medium text-zinc-900 dark:text-zinc-100 capitalize">
                  {seniority}
                </td>
                {CATEGORIES.map(category => (
                  <td key={category} className="px-3 py-3">
                    <div className="relative flex items-center max-w-[100px]">
                      <span className="absolute left-3 text-zinc-400">$</span>
                      <input
                        type="number"
                        min="0"
                        value={limits[seniority][category] || ''}
                        onChange={(e) => handleChange(seniority, category, e.target.value)}
                        className="h-9 w-full rounded-md border border-zinc-200 pl-7 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
