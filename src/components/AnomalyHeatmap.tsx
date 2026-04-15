'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, X, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

type HeatmapCell = {
  department: string
  category: string
  median: number
  current_avg: number
  z_score: number
  claim_count: number
}

type OutlierClaim = {
  id: string
  merchant: string | null
  amount: number
  status: string
  business_purpose: string | null
  receipt_date: string | null
  created_at: string
  requires_review: boolean
  z_score: number
}

type SelectedState = {
  department: string
  category: string
  median: number
  outliers: OutlierClaim[]
}

function zColor(zScore: number, claimCount: number) {
  if (claimCount === 0) return 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-500 dark:border-zinc-800'
  const abs = Math.abs(zScore)
  if (abs < 1) return 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
  if (abs <= 2.5) return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
  return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'
}

export default function AnomalyHeatmap() {
  const [cells, setCells] = useState<HeatmapCell[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SelectedState | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [flagging, setFlagging] = useState(false)

  const fetchCells = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/anomaly-heatmap')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load heatmap')
      setCells(data.cells || [])
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load anomaly heatmap')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchCells()
  }, [])

  const departments = useMemo(() => {
    return [...new Set(cells.map((c) => c.department))]
  }, [cells])

  const categories = useMemo(() => {
    return [...new Set(cells.map((c) => c.category))]
  }, [cells])

  const gridMap = useMemo(() => {
    const map = new Map<string, HeatmapCell>()
    for (const cell of cells) {
      map.set(`${cell.department}||${cell.category}`, cell)
    }
    return map
  }, [cells])

  const openCell = async (department: string, category: string) => {
    setDetailsLoading(true)
    setSelected({ department, category, median: 0, outliers: [] })
    try {
      const res = await fetch(`/api/admin/anomaly-heatmap?department=${encodeURIComponent(department)}&category=${encodeURIComponent(category)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load outliers')
      setSelected({
        department,
        category,
        median: Number(data?.selected?.median || 0),
        outliers: data?.outliers || [],
      })
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load outliers')
      setSelected(null)
    } finally {
      setDetailsLoading(false)
    }
  }

  const flagAllOutliers = async () => {
    if (!selected) return
    setFlagging(true)
    try {
      const res = await fetch('/api/admin/anomaly-heatmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: selected.department, category: selected.category }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to flag outliers')

      toast.success(data.updated > 0 ? `Flagged ${data.updated} outlier claim(s)` : data.message || 'No outliers to flag')
      await fetchCells()
      await openCell(selected.department, selected.category)
    } catch (err: any) {
      toast.error(err?.message || 'Failed to flag outliers')
    } finally {
      setFlagging(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Receipt Anomaly Heatmap (90 Days)</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Department x Category spend anomaly using z-score.</p>
      </div>

      {loading ? (
        <div className="flex h-44 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : cells.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
          Not enough baseline or claim data to render heatmap yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[780px]">
            <div className="grid" style={{ gridTemplateColumns: `220px repeat(${categories.length}, minmax(120px, 1fr))` }}>
              <div className="p-2 text-xs font-semibold uppercase text-zinc-500">Department / Category</div>
              {categories.map((cat) => (
                <div key={cat} className="p-2 text-center text-xs font-semibold uppercase text-zinc-500">{cat}</div>
              ))}

              {departments.map((dep) => (
                <>
                  <div key={`${dep}-label`} className="border-t border-zinc-200 p-2 text-sm font-medium dark:border-zinc-800">{dep}</div>
                  {categories.map((cat) => {
                    const cell = gridMap.get(`${dep}||${cat}`) || {
                      department: dep,
                      category: cat,
                      median: 0,
                      current_avg: 0,
                      z_score: 0,
                      claim_count: 0,
                    }

                    const clickable = cell.claim_count > 0
                    return (
                      <button
                        key={`${dep}-${cat}`}
                        type="button"
                        disabled={!clickable}
                        onClick={() => openCell(dep, cat)}
                        className={`m-1 rounded-md border px-2 py-3 text-left transition ${zColor(cell.z_score, cell.claim_count)} ${clickable ? 'hover:brightness-95' : 'cursor-default opacity-70'}`}
                      >
                        <p className="text-xs font-semibold">z {cell.z_score.toFixed(2)}</p>
                        <p className="text-[11px]">n {cell.claim_count}</p>
                        <p className="text-[11px]">avg {cell.current_avg.toFixed(0)}</p>
                      </button>
                    )
                  })}
                </>
              ))}
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => setSelected(null)} />
          <div className="h-full w-full max-w-lg overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold">Outliers: {selected.department} x {selected.category}</h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Top 5 by absolute z-score. Median baseline: {selected.median.toFixed(2)}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <X className="h-5 w-5" />
              </button>
            </div>

            <button
              type="button"
              onClick={flagAllOutliers}
              disabled={flagging || detailsLoading}
              className="mb-4 inline-flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {flagging ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
              Flag All Outliers
            </button>

            {detailsLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            ) : selected.outliers.length === 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                No outlier claims found for this cell.
              </div>
            ) : (
              <div className="space-y-3">
                {selected.outliers.map((o) => (
                  <div key={o.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{o.merchant || 'Unknown Merchant'}</p>
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${Math.abs(o.z_score) > 3 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>
                        z {o.z_score.toFixed(2)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">Amount: INR {o.amount.toFixed(2)} | Status: {o.status}</p>
                    {o.business_purpose && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{o.business_purpose}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
