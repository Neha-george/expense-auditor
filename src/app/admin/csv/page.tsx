'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { FileUp, Loader2, PlayCircle, ShieldAlert, BadgeCheck, FileWarning, DollarSign } from 'lucide-react'

export default function BulkImportPage() {
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [rows, setRows] = useState<any[]>([])
  
  // Progress States
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [results, setResults] = useState<{
    approved: number,
    flagged: number,
    rejected: number,
    leakagePrevented: number,
    processedItems: any[]
  } | null>(null)

  const parseCSV = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      if (!text) return
      
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length < 2) {
         toast.error("CSV must contain headers and at least one data row.")
         return
      }

      // Safe split handling commas inside quotes using rudimentary regex matching
      const headers = lines[0].toLowerCase().split(',').map(h => h.trim())
      
      const parsed = lines.slice(1).map(line => {
        // Rudimentary CSV parse avoiding heavy libraries: split by comma but preserve quoted strings
        let p = '', inQuotes = false
        const cols = []
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '"') inQuotes = !inQuotes
            else if (line[i] === ',' && !inQuotes) {
                cols.push(p); p = '';
            } else {
                p += line[i]
            }
        }
        cols.push(p)

        const obj: any = {}
        headers.forEach((h, idx) => {
          if (cols[idx]) obj[h] = cols[idx].replace(/^"|"$/g, '').trim()
        })
        return obj
      }).filter(row => row.merchant && row.amount && row.category)

      setRows(parsed)
      setCsvFile(file)
    }
    reader.readAsText(file)
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => {
      if (files[0]) parseCSV(files[0])
    },
    accept: { 'text/csv': ['.csv'] },
    maxFiles: 1,
  })

  // Recursive Batch Processing 
  const runDryAudit = async () => {
    if (rows.length === 0) return
    setProcessing(true)
    setResults(null)
    setProgress({ current: 0, total: rows.length })

    let approved = 0
    let flagged = 0
    let rejected = 0
    let leakagePrevented = 0
    const processedItems: any[] = []

    const BATCH_SIZE = 10
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms))

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
       const chunk = rows.slice(i, i + BATCH_SIZE)
       
       let retries = 0
       let success = false
       
       while (!success && retries < 2) {
         try {
           const res = await fetch('/api/claims/bulk', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ rows: chunk })
           })

           if (res.status === 429) throw new Error('Rate Limit')
           
           const data = await res.json()
           if (data.results) {
              data.results.forEach((item: any) => {
                 processedItems.push(item)
                 if (item.verdict === 'approved') approved++
                 else {
                    if (item.verdict === 'flagged') flagged++
                    if (item.verdict === 'rejected') rejected++
                    leakagePrevented += (Number(item.amount) || 0)
                 }
              })
           }
           success = true
         } catch (err: any) {
           if (err.message === 'Rate Limit') {
              console.warn("429 Encountered. Backing off 3 seconds...")
              await delay(3000)
              retries++
           } else {
              console.error(err)
              success = true // Skip chunk on hard failure to prevent infinite loops
           }
         }
       }

       setProgress({ current: Math.min(i + BATCH_SIZE, rows.length), total: rows.length })
    }

    setResults({ approved, flagged, rejected, leakagePrevented, processedItems })
    setProcessing(false)
    toast.success("Dry Run Audit Complete")
  }

  const formatCurr = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Historical Bulk Audit</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Import legacy CSV expense datasets to simulate estimated AI leakage prevention.</p>
      </div>

      {!results ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 max-w-4xl">
          
          {!csvFile ? (
            <div
              {...getRootProps()}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 cursor-pointer transition-colors ${
                isDragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20' : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700'
              }`}
            >
              <input {...getInputProps()} />
              <FileUp className="h-10 w-10 text-zinc-400 mb-2" />
              <p className="font-medium text-zinc-700 dark:text-zinc-300">Drag & Drop Legacy CSV Dataset</p>
              <p className="text-xs text-zinc-500 mt-2 text-center max-w-md">
                Expected Columns: <code>employee_email, merchant, amount, currency, date, category, business_purpose</code>
              </p>
            </div>
          ) : (
            <div className="space-y-6">
               <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div>
                    <p className="font-medium">{csvFile.name}</p>
                    <p className="text-xs text-zinc-500">{rows.length} valid rows extracted</p>
                  </div>
                  {!processing && (
                    <button onClick={() => setCsvFile(null)} className="text-sm text-red-600 font-medium hover:underline">Remove</button>
                  )}
               </div>

               {processing ? (
                 <div className="p-6 text-center space-y-4">
                    <Loader2 className="h-8 w-8 text-blue-600 animate-spin mx-auto" />
                    <p className="font-medium">AI is bulk-auditing limits & policies...</p>
                    <div className="w-full bg-zinc-200 rounded-full h-2.5 dark:bg-zinc-700 max-w-md mx-auto overflow-hidden">
                      <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${(progress.current/progress.total)*100}%` }}></div>
                    </div>
                    <p className="text-sm text-zinc-500">Processed {progress.current} of {progress.total}</p>
                 </div>
               ) : (
                 <button
                    onClick={runDryAudit}
                    className="w-full h-12 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm transition"
                 >
                    <PlayCircle className="w-5 h-5" /> Start Dry Run Simulation
                 </button>
               )}
            </div>
          )}

        </div>
      ) : (
        <div className="space-y-8 animate-in fade-in duration-500">
          
          <div className="flex flex-col md:flex-row gap-6">
            <div className="flex-1 rounded-xl bg-gradient-to-br from-blue-900 to-indigo-900 p-8 text-white shadow-xl">
              <p className="text-blue-200 font-medium tracking-wide uppercase text-sm mb-2">Estimated Leakage Prevented</p>
              <h2 className="text-5xl font-extrabold flex items-baseline gap-2">
                {formatCurr(results.leakagePrevented)}
                <span className="text-lg font-normal text-blue-300">/ historically</span>
              </h2>
              <p className="mt-4 text-blue-100/80 text-sm max-w-sm">
                 If PolicyLens was active during this dataset, the AI auditor would have actively caught and flagged <strong>{results.flagged + results.rejected}</strong> out-of-policy claims globally.
              </p>
            </div>

            <div className="flex-1 grid grid-cols-2 gap-4">
               <div className="rounded-xl bg-white border border-green-200 p-5 shadow-sm flex flex-col justify-center dark:bg-zinc-900 dark:border-green-900/30">
                 <BadgeCheck className="w-6 h-6 text-green-600 mb-2" />
                 <p className="text-3xl font-bold">{results.approved}</p>
                 <p className="text-sm text-zinc-500 font-medium">Compliant Claims</p>
               </div>
               <div className="rounded-xl bg-white border border-amber-200 p-5 shadow-sm flex flex-col justify-center dark:bg-zinc-900 dark:border-amber-900/30">
                 <ShieldAlert className="w-6 h-6 text-amber-600 mb-2" />
                 <p className="text-3xl font-bold">{results.flagged + results.rejected}</p>
                 <p className="text-sm text-zinc-500 font-medium">Violations Caught</p>
               </div>
            </div>
          </div>

          <div className="flex justify-center">
             <button
               onClick={() => { setResults(null); setCsvFile(null); setRows([]); }}
               className="px-6 py-2 border border-zinc-300 rounded-md bg-white hover:bg-zinc-50 font-medium dark:bg-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-800"
             >
               Perform Another Audit
             </button>
          </div>

        </div>
      )}

    </div>
  )
}
