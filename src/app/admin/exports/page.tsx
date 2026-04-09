'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { DownloadCloud, Settings2, FileText, CheckCircle2, Loader2, Save } from 'lucide-react'
import { createClient } from '@/lib/supabase'

const EXPENSE_CATEGORIES = ['meals', 'travel', 'accommodation', 'transport', 'office', 'entertainment', 'other']

export default function ExportsPage() {
  const [format, setFormat] = useState('quickbooks')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [mappings, setMappings] = useState<Record<string, { gl_code: string, gl_description: string }>>({})
  const [loading, setLoading] = useState(true)
  const [savingMapping, setSavingMapping] = useState<string | null>(null)

  useEffect(() => {
    fetchMappings()
  }, [])

  const fetchMappings = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/admin/gl-mappings')
      if (!res.ok) throw new Error('Failed to load mappings')
      const data = await res.json()
      
      const mapObj: Record<string, any> = {}
      data.mappings?.forEach((m: any) => {
        mapObj[m.category] = { gl_code: m.gl_code, gl_description: m.gl_description || '' }
      })
      setMappings(mapObj)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveMapping = async (category: string) => {
    const data = mappings[category] || { gl_code: '', gl_description: '' }
    if (!data.gl_code.trim()) {
      toast.error(`Please enter a GL code for ${category}`)
      return
    }

    try {
      setSavingMapping(category)
      const res = await fetch('/api/admin/gl-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, gl_code: data.gl_code, gl_description: data.gl_description })
      })
      if (!res.ok) throw new Error('Failed to save mapping')
      toast.success(`Saved mapping for ${category}`)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setSavingMapping(null)
    }
  }

  const handleExport = () => {
    let url = `/api/claims/export?format=${format}`
    if (fromDate) url += `&fromDate=${fromDate}`
    if (toDate) url += `&toDate=${toDate}`
    window.location.href = url
  }

  const handleMappingChange = (category: string, field: 'gl_code' | 'gl_description', value: string) => {
    setMappings(prev => ({
      ...prev,
      [category]: {
        ...(prev[category] || { gl_code: '', gl_description: '' }),
        [field]: value
      }
    }))
  }

  return (
    <div className="space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Accounting Exports</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Export approved claims ready for direct import into your ERP or accounting system.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Export Configuration */}
        <div className="space-y-6">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <DownloadCloud className="w-5 h-5 text-blue-600" />
              Generate Export File
            </h2>

            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium mb-2 text-zinc-900 dark:text-zinc-100">Export Format</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <button 
                    onClick={() => setFormat('quickbooks')}
                    className={`flex flex-col items-center justify-center p-4 rounded-lg border-2 text-sm transition-all ${
                      format === 'quickbooks' ? 'border-blue-600 bg-blue-50/50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-500' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-800 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <FileText className={`w-6 h-6 mb-2 ${format === 'quickbooks' ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'}`} />
                    <span className="font-semibold">QuickBooks IIF</span>
                  </button>
                  <button 
                    onClick={() => setFormat('xero')}
                    className={`flex flex-col items-center justify-center p-4 rounded-lg border-2 text-sm transition-all ${
                      format === 'xero' ? 'border-blue-600 bg-blue-50/50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-500' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-800 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <FileText className={`w-6 h-6 mb-2 ${format === 'xero' ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'}`} />
                    <span className="font-semibold">Xero CSV</span>
                  </button>
                  <button 
                    onClick={() => setFormat('bacs')}
                    className={`flex flex-col items-center justify-center p-4 rounded-lg border-2 text-sm transition-all ${
                      format === 'bacs' ? 'border-blue-600 bg-blue-50/50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-500' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-800 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <FileText className={`w-6 h-6 mb-2 ${format === 'bacs' ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'}`} />
                    <span className="font-semibold">Generic BACS</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1 text-zinc-900 dark:text-zinc-100">From Date (Optional)</label>
                  <input 
                    type="date" 
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-zinc-900 dark:text-zinc-100">To Date (Optional)</label>
                  <input 
                    type="date" 
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <button 
                  onClick={handleExport}
                  className="w-full flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition"
                >
                  <DownloadCloud className="w-5 h-5" />
                  Download Verified Claims File
                </button>
                <p className="text-xs text-zinc-500 mt-3 text-center">
                  Only claims internally approved and verified by an admin are included in these exports.
                </p>
              </div>

            </div>
          </div>
        </div>

        {/* Right Column: GL Code Mappings */}
        <div className="space-y-6">
          <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden dark:border-zinc-800 dark:bg-zinc-900 flex flex-col h-full">
            <div className="p-6 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-blue-600" />
                Chart of Accounts Mapping
              </h2>
              <p className="text-sm text-zinc-500 mt-1">
                Configure which General Ledger (GL) account code each expense category maps to in your ERP.
              </p>
            </div>
            
            <div className="p-0 overflow-y-auto max-h-[500px]">
              {loading ? (
                <div className="p-10 flex justify-center text-zinc-400">
                   <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : (
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-zinc-500 bg-zinc-50 border-b border-zinc-200 uppercase dark:bg-zinc-950 dark:text-zinc-400 dark:border-zinc-800 sticky top-0 z-10">
                    <tr>
                      <th className="px-6 py-3 font-semibold">Category</th>
                      <th className="px-6 py-3 font-semibold">GL Code</th>
                      <th className="px-6 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {EXPENSE_CATEGORIES.map(category => (
                      <tr key={category} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                        <td className="px-6 py-4 font-medium capitalize text-zinc-900 dark:text-zinc-100">
                          {category}
                        </td>
                        <td className="px-6 py-4">
                          <input 
                            type="text" 
                            placeholder="e.g. 60100"
                            value={mappings[category]?.gl_code || ''}
                            onChange={(e) => handleMappingChange(category, 'gl_code', e.target.value)}
                            className="w-full max-w-[120px] rounded-md border border-zinc-300 px-2 py-1 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-zinc-700 dark:bg-black dark:text-white"
                          />
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => handleSaveMapping(category)}
                            disabled={savingMapping === category}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-medium rounded-md text-xs transition-colors dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-100 disabled:opacity-50"
                          >
                            {savingMapping === category ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            
          </div>
        </div>
      </div>
    </div>
  )
}
