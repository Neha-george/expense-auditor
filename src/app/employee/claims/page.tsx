'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, AlertCircle, ClipboardList, Trash2, CheckCircle2, Clock, ShieldCheck, BadgeDollarSign } from 'lucide-react'

export default function MyClaimsPage() {
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedClaim, setSelectedClaim] = useState<any>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const router = useRouter()

  const handleDeleteClaim = async (id: string) => {
    if (!confirm('Are you sure you want to delete this claim? This action cannot be undone.')) return
    
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/claims/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete claim')
      
      setClaims(prev => prev.filter(c => c.id !== id))
      if (selectedClaim?.id === id) setSelectedClaim(null)
    } catch (err) {
      console.error(err)
      alert('Error deleting claim. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }

  useEffect(() => {
    fetch('/api/claims')
      .then(res => res.json())
      .then(data => {
        setClaims(data.claims || [])
        setLoading(false)
      })
      .catch(err => {
        console.error(err)
        setLoading(false)
      })
  }, [])

  const formatDate = (dateStr: string) => {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    })
  }

  const formatCurrency = (amt: number | null, curr: string | null) => {
    if (amt == null) return 'N/A'
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: curr || 'INR' }).format(amt)
  }

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'approved': return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800'
      case 'rejected': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'
      case 'flagged':  return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
      default: return 'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700'
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">My Claims</h1>
        <p className="text-zinc-500 dark:text-zinc-400">View and track the status of your submitted expenses.</p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-zinc-500 bg-zinc-50 border-b border-zinc-200 uppercase dark:bg-zinc-950 dark:text-zinc-400 dark:border-zinc-800">
              <tr>
                <th className="px-6 py-4 font-medium whitespace-nowrap">Date</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap">Merchant</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap">Amount</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap">Category</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap hidden md:table-cell">Purpose</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap">AI Verdict</th>
                <th className="px-6 py-4 font-medium whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-zinc-500">Loading claims...</td></tr>
              ) : claims.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
                      <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
                        <ClipboardList className="w-8 h-8 text-zinc-400" />
                      </div>
                      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">No claims yet</h3>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs">Submit your first expense receipt to get AI-powered policy review.</p>
                      <button
                        onClick={() => router.push('/employee/submit')}
                        className="mt-5 px-5 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 transition"
                      >
                        Submit a Claim →
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                claims.map(claim => (
                  <tr 
                    key={claim.id} 
                    onClick={() => setSelectedClaim(claim)}
                    className="border-b border-zinc-100 hover:bg-zinc-50 cursor-pointer transition-colors dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                  >
                    <td className="px-6 py-4">{formatDate(claim.receipt_date)}</td>
                    <td className="px-6 py-4 font-medium text-zinc-900 dark:text-zinc-100">{claim.merchant || 'Unknown'}</td>
                    <td className="px-6 py-4">{formatCurrency(claim.amount, claim.currency)}</td>
                    <td className="px-6 py-4 capitalize">{claim.category}</td>
                    <td className="px-6 py-4 hidden md:table-cell truncate max-w-[200px]" title={claim.business_purpose}>
                      {claim.business_purpose}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${getStatusColor(claim.ai_verdict)}`}>
                        {claim.ai_verdict}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${getStatusColor(claim.status)}`}>
                        {claim.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Dialog */}
      {selectedClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-zinc-900 w-full max-w-3xl rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Claim Details</h2>
              <button onClick={() => setSelectedClaim(null)} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto grid md:grid-cols-2 gap-6">
              <div>
                <img src={selectedClaim.receipt_url} alt="Receipt" className="w-full rounded-lg border border-zinc-200 shadow-sm dark:border-zinc-800 object-contain max-h-[400px]" />
              </div>
              
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-2">Claim Info</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between border-b pb-2 border-zinc-100 dark:border-zinc-800">
                      <span className="text-zinc-500">Merchant</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{selectedClaim.merchant || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2 border-zinc-100 dark:border-zinc-800">
                      <span className="text-zinc-500">Amount</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(selectedClaim.amount, selectedClaim.currency)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2 border-zinc-100 dark:border-zinc-800">
                      <span className="text-zinc-500">Date</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatDate(selectedClaim.receipt_date)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-2 border-zinc-100 dark:border-zinc-800">
                      <span className="text-zinc-500">Category</span>
                      <span className="font-medium capitalize text-zinc-900 dark:text-zinc-100">{selectedClaim.category}</span>
                    </div>
                  </div>
                </div>

                {/* Status Timeline */}
                <div>
                  <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-3">Claim Progress</h3>
                  {(() => {
                    const status = selectedClaim.status
                    const aiVerdict = selectedClaim.ai_verdict
                    const adminVerdict = selectedClaim.admin_verdict

                    const steps = [
                      { label: 'Submitted', icon: ClipboardList, done: true },
                      { label: 'AI Reviewed', icon: ShieldCheck, done: !!aiVerdict },
                      { label: 'Admin Review', icon: Clock, done: !!adminVerdict, active: !adminVerdict && !!aiVerdict },
                      { label: 'Paid / Closed', icon: BadgeDollarSign, done: adminVerdict === 'approved' || status === 'approved' },
                    ]

                    return (
                      <div className="flex items-start gap-0">
                        {steps.map((step, idx) => {
                          const Icon = step.icon
                          const isLast = idx === steps.length - 1
                          return (
                            <div key={step.label} className="flex flex-col items-center flex-1">
                              <div className="flex items-center w-full">
                                <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 shrink-0 ${
                                  step.done ? 'bg-emerald-500 border-emerald-500' :
                                  step.active ? 'bg-amber-400 border-amber-400' :
                                  'bg-zinc-100 border-zinc-300 dark:bg-zinc-800 dark:border-zinc-600'
                                }`}>
                                  <Icon className={`w-3.5 h-3.5 ${ step.done || step.active ? 'text-white' : 'text-zinc-400' }`} />
                                </div>
                                {!isLast && (
                                  <div className={`h-0.5 flex-1 ${ step.done ? 'bg-emerald-400' : 'bg-zinc-200 dark:bg-zinc-700' }`} />
                                )}
                              </div>
                              <p className={`text-xs mt-1.5 text-center leading-tight ${
                                step.done ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                                : step.active ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                : 'text-zinc-400'
                              }`}>{step.label}</p>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>

                <div>
                  <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-2">Business Purpose</h3>
                  <p className="text-sm bg-zinc-50 p-3 rounded-md border border-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:border-zinc-800 dark:text-zinc-300">
                    {selectedClaim.business_purpose}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-2">AI Verdict</h3>
                  <div className={`p-4 rounded-md border ${
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
                      <p className="mt-2 text-xs italic text-zinc-600 dark:text-zinc-400 border-l-2 pl-2 border-zinc-400">
                        {selectedClaim.policy_reference}
                      </p>
                    )}
                  </div>
                </div>

                {selectedClaim.admin_verdict && (
                  <div>
                    <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-2">Admin Override</h3>
                    <div className="p-4 rounded-md border bg-zinc-50 dark:bg-zinc-900 dark:border-zinc-800">
                      <p className="text-sm"><span className="font-medium">Verdict:</span> <span className="capitalize">{selectedClaim.admin_verdict}</span></p>
                      {selectedClaim.admin_note && <p className="text-sm mt-1"><span className="font-medium">Note:</span> {selectedClaim.admin_note}</p>}
                    </div>
                  </div>
                )}

                {(selectedClaim.ai_verdict === 'flagged' || selectedClaim.ai_verdict === 'rejected' || selectedClaim.admin_verdict === 'rejected') && (
                  <div className="mt-4 p-4 rounded-lg bg-blue-50 border border-blue-200 dark:bg-blue-900/10 dark:border-blue-900/30">
                     <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-300 flex items-center gap-2">
                       <AlertCircle className="w-4 h-4" /> Checklist for Resubmission
                     </h3>
                     <p className="text-sm text-blue-700 dark:text-blue-400 mt-2">Before resubmitting, ensure you fix the following issue:</p>
                     <ul className="list-disc pl-5 mt-2 text-sm text-blue-800 dark:text-blue-300 font-medium">
                        <li>{selectedClaim.admin_note || selectedClaim.ai_reason}</li>
                     </ul>
                  </div>
                )}
              </div>
            </div>
            
            <div className="border-t border-zinc-200 p-4 flex justify-between items-center dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50">
               <div>
                  {(selectedClaim.ai_verdict === 'flagged' || selectedClaim.ai_verdict === 'rejected' || selectedClaim.admin_verdict === 'rejected') && (
                    <button 
                      onClick={() => router.push(`/employee/submit?resubmit=${selectedClaim.id}`)}
                      className="px-4 py-2 bg-zinc-900 text-white rounded-md text-sm font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      Resubmit Correction
                    </button>
                  )}
                  <button
                     onClick={() => handleDeleteClaim(selectedClaim.id)}
                     disabled={isDeleting}
                     className="ml-2 px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-md text-sm font-medium hover:bg-red-100 disabled:opacity-50 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-900/40"
                   >
                     {isDeleting ? 'Deleting...' : 'Delete'}
                   </button>
               </div>
               <button onClick={() => setSelectedClaim(null)} className="px-4 py-2 border border-zinc-300 rounded-md bg-white hover:bg-zinc-50 text-sm font-medium dark:bg-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-800">
                 Close
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
