'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileDown, X, Check, Search, Filter, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { createClient } from '@/lib/supabase'

export default function AdminClaimsPage() {
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [selectedClaim, setSelectedClaim] = useState<any>(null)
  const [adminNote, setAdminNote] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [history, setHistory] = useState<any[]>([])

  useEffect(() => {
    if (!selectedClaim) { 
      setHistory([])
      return 
    }
    const rootId = selectedClaim.parent_claim_id || selectedClaim.id
    createClient().from('claims')
      .select('id, amount, status, created_at, ai_reason, admin_note, parent_claim_id')
      .or(`id.eq.${rootId},parent_claim_id.eq.${rootId}`)
      .order('created_at', { ascending: true })
      .then(({data}) => setHistory(data || []))
  }, [selectedClaim])

  const fetchClaims = async (status = 'all') => {
    setLoading(true)
    try {
      const res = await fetch(`/api/claims?status=${status}`)
      const data = await res.json()
      if (res.ok) {
        // Sort: requires_review=true floats to top
        const sorted = (data.claims || []).sort((a: any, b: any) => {
          if (a.requires_review && !b.requires_review) return -1
          if (!a.requires_review && b.requires_review) return 1
          return 0
        })
        setClaims(sorted)
      } else {
        toast.error(data.error || 'Failed to fetch claims')
      }
    } catch (err) {
      toast.error('Network error fetching claims')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchClaims(filter)
  }, [filter])

  const handleExport = () => {
    window.open(`/api/claims?export=true`, '_blank')
  }

  const handleAction = async (verdict: 'approved' | 'rejected') => {
    if (!selectedClaim) return

    const isOverride = selectedClaim.ai_verdict && selectedClaim.ai_verdict !== verdict
    if (isOverride && !adminNote.trim()) {
      toast.error('An override reason is required since your verdict differs from the AI verdict.')
      return
    }

    setActionLoading(true)
    
    try {
      const res = await fetch(`/api/claims/${selectedClaim.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, note: adminNote }),
      })
      
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Action failed')

      toast.success(`Claim ${verdict} successfully`)
      setSelectedClaim(null)
      setAdminNote('')
      fetchClaims(filter)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const tabs = ['all', 'flagged', 'pending', 'approved', 'rejected']

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'approved': return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800'
      case 'rejected': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-400 dark:border-red-800'
      case 'flagged':  return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-800'
      default: return 'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700'
    }
  }

  const getConfidenceMeter = (confidence: number | null) => {
    if (confidence === null || confidence === undefined) return null
    if (confidence > 0.9) return { label: `${Math.round(confidence * 100)}%`, color: 'text-green-600 dark:text-green-400', bar: 'bg-green-500' }
    if (confidence >= 0.7) return { label: `${Math.round(confidence * 100)}%`, color: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' }
    return { label: `${Math.round(confidence * 100)}%`, color: 'text-red-600 dark:text-red-400', bar: 'bg-red-500' }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Claims Queue</h1>
          <p className="text-zinc-500 dark:text-zinc-400">Review expenses, audit AI decisions, and manage approvals.</p>
        </div>
        <button
          onClick={handleExport}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 rounded-md text-sm font-medium hover:bg-zinc-50 dark:bg-zinc-950 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          <FileDown className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col dark:border-zinc-800 dark:bg-zinc-900">
        
       {/* Tabs */}
        <div className="border-b border-zinc-100 px-4 flex gap-6 overflow-x-auto dark:border-zinc-800">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`py-4 text-sm font-medium capitalize whitespace-nowrap relative ${
                filter === tab 
                  ? 'text-blue-600 dark:text-blue-400 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-blue-600' 
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-zinc-500 bg-zinc-50 border-b border-zinc-200 uppercase dark:bg-zinc-950 dark:text-zinc-400 dark:border-zinc-800">
              <tr>
                <th className="px-6 py-3">Employee</th>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Merchant</th>
                <th className="px-6 py-3">Amount</th>
                <th className="px-6 py-3">AI Verdict</th>
                <th className="px-6 py-3">Confidence</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-zinc-500">Loading claims...</td></tr>
              ) : claims.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                      <div className="w-14 h-14 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
                        {filter === 'all' ? <ShieldCheck className="w-7 h-7 text-zinc-400" /> : <SlidersHorizontal className="w-7 h-7 text-zinc-400" />}
                      </div>
                      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                        {filter === 'all' ? 'No claims submitted yet' : `No ${filter} claims`}
                      </h3>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs">
                        {filter === 'all' ? 'Once employees start submitting expenses, they will appear here for review.' : `No claims match the "${filter}" filter right now.`}
                      </p>
                      {filter !== 'all' && (
                        <button onClick={() => setFilter('all')} className="mt-4 px-4 py-2 text-sm font-medium border border-zinc-300 rounded-md hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 transition">
                          View all claims
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                claims.map(claim => (
                  <tr key={claim.id} className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${claim.requires_review ? 'bg-amber-50/40 dark:bg-amber-900/5' : ''}`}>
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{claim.profiles?.full_name || 'Unknown'}</div>
                      <div className="text-xs text-zinc-500">{claim.profiles?.department || 'No dept'}</div>
                      {claim.requires_review && (
                        <span className="inline-block mt-1 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">⚑ Review Required</span>
                      )}
                    </td>
                    <td className="px-6 py-4">{new Date(claim.receipt_date).toLocaleDateString()}</td>
                    <td className="px-6 py-4 font-medium">
                      <div>{claim.merchant}</div>
                      {claim.is_duplicate_warning && (
                        <span className="inline-block mt-1 text-[10px] font-bold uppercase tracking-wider text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded">⚠ Potential Duplicate</span>
                      )}
                    </td>
                    <td className="px-6 py-4">${Number(claim.amount).toFixed(2)}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full border ${getStatusColor(claim.ai_verdict)}`}>
                        {claim.ai_verdict || 'None'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {(() => {
                        const m = getConfidenceMeter(claim.confidence)
                        if (!m) return <span className="text-xs text-zinc-400">—</span>
                        return (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                              <div className={`h-full ${m.bar} rounded-full`} style={{ width: m.label }} />
                            </div>
                            <span className={`text-xs font-semibold ${m.color}`}>{m.label}</span>
                          </div>
                        )
                      })()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full border ${getStatusColor(claim.status)}`}>
                        {claim.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => { setSelectedClaim(claim); setAdminNote(claim.admin_note || ''); }}
                        className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded hover:bg-blue-50 dark:border-blue-900 dark:text-blue-400 dark:hover:bg-blue-900/30"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slide-over Sheet for Review */}
      {selectedClaim && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm transition-opacity" onClick={() => setSelectedClaim(null)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-white dark:bg-zinc-950 shadow-2xl flex flex-col animate-in slide-in-from-right duration-300 border-l border-zinc-200 dark:border-zinc-800">
            
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
              <h2 className="text-xl font-semibold">Review Claim</h2>
              <button onClick={() => setSelectedClaim(null)} className="p-2 -mr-2 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              
              <div className="aspect-video bg-zinc-100 dark:bg-zinc-900 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 flex items-center justify-center">
                 <img src={selectedClaim.receipt_url} alt="Receipt" className="max-w-full max-h-full object-contain" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-md border border-zinc-100 dark:border-zinc-800">
                  <p className="text-xs text-zinc-500 mb-1">Employee</p>
                  <p className="font-medium text-sm">{selectedClaim.profiles?.full_name}</p>
                  <p className="text-xs text-zinc-500 mt-1">{selectedClaim.profiles?.department} • {selectedClaim.profiles?.location}</p>
                </div>
                <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-md border border-zinc-100 dark:border-zinc-800">
                  <p className="text-xs text-zinc-500 mb-1">Expense Details</p>
                  <p className="font-medium text-sm">{selectedClaim.merchant} • ${Number(selectedClaim.amount).toFixed(2)}</p>
                  <p className="text-xs text-zinc-500 mt-1 capitalize">{selectedClaim.category}</p>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">Business Purpose</h3>
                <p className="text-sm text-zinc-700 dark:text-zinc-300 bg-white border border-zinc-200 dark:bg-zinc-950 dark:border-zinc-800 p-3 rounded-md">
                  {selectedClaim.business_purpose}
                </p>
              </div>

              {history.length > 1 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400">Resubmission Timeline</h3>
                  <div className="p-4 rounded-lg bg-blue-50/50 border border-blue-100 dark:bg-blue-900/10 dark:border-blue-900/30 space-y-0">
                    {history.map((c, i, arr) => (
                      <div key={c.id} className={`flex items-start gap-4 ${c.id === selectedClaim.id ? 'opacity-100 scale-[1.02]' : 'opacity-60'} transition-transform`}>
                        <div className="relative flex flex-col items-center mt-1">
                          <div className={`w-2.5 h-2.5 rounded-full ${c.id === selectedClaim.id ? 'bg-blue-600' : 'bg-zinc-400'}`} />
                          {i !== arr.length - 1 && <div className="w-px h-12 bg-zinc-300 dark:bg-zinc-700 my-1" />}
                        </div>
                        <div className="flex-1 pb-4">
                          <p className={`text-xs font-semibold ${c.id === selectedClaim.id ? 'text-blue-700 dark:text-blue-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                            Version {i + 1} {c.id === selectedClaim.id && '(Currently Viewing)'} <span className="text-zinc-500 font-normal ml-2">{new Date(c.created_at).toLocaleString()}</span>
                          </p>
                          {(c.status === 'rejected' || c.status === 'flagged') && (
                            <p className="text-xs mt-1 text-red-600 dark:text-red-400 bg-white dark:bg-black/20 p-2 rounded border border-red-100 dark:border-red-900/30 inline-block w-full">
                              ⚠ {c.admin_note || c.ai_reason}
                            </p>
                          )}
                          {c.status === 'approved' && (
                             <p className="text-xs mt-1 text-green-600 dark:text-green-400 font-medium">✓ Approved</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-sm font-semibold">AI Assessment</h3>
                <div className={`p-4 rounded-lg border ${
                    selectedClaim.ai_verdict === 'approved' ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-900/50' : 
                    selectedClaim.ai_verdict === 'flagged' ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-900/50' : 
                    'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-900/50'
                  }`}>
                  <div className="flex items-center gap-2 mb-2">
                     <span className={`px-2.5 py-0.5 text-xs font-semibold rounded-full border uppercase ${getStatusColor(selectedClaim.ai_verdict)}`}>
                      {selectedClaim.ai_verdict}
                    </span>
                  </div>
                  <p className="text-sm font-medium mt-2">{selectedClaim.ai_reason}</p>
                  {selectedClaim.policy_reference && (
                    <p className="mt-3 text-xs italic text-zinc-600 dark:text-zinc-400 border-l-2 pl-2 border-zinc-400">
                      {selectedClaim.policy_reference}
                    </p>
                  )}
                </div>
              </div>
              
              <div className="space-y-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                 <h3 className="text-sm font-semibold">Admin Override</h3>
                 <div>
                   <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                     Review Note <span className="text-zinc-400 font-normal">(Required if changing AI verdict)</span>
                   </label>
                   <p className="text-[10px] text-zinc-500 mt-0.5 mb-2 leading-tight max-w-sm">
                     If your verdict overrides the AI's decision, this note is permanently saved and used to train future decisions for your organisation.
                   </p>
                   <textarea
                     disabled={actionLoading}
                     value={adminNote}
                     onChange={e => setAdminNote(e.target.value)}
                     placeholder="E.g. Approved as exception for Q3 travel"
                     className="w-full rounded-md border border-zinc-200 p-3 text-sm focus:ring-2 focus:ring-zinc-950 dark:bg-zinc-950 dark:border-zinc-800 dark:focus:ring-zinc-300 min-h-[100px]"
                   />
                 </div>
              </div>

            </div>

            <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 flex justify-end gap-3">
              <button 
                onClick={() => handleAction('rejected')}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-md dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition"
              >
                Reject Claim
              </button>
              <button 
                onClick={() => handleAction('approved')}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-md transition"
              >
                Approve Claim
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
