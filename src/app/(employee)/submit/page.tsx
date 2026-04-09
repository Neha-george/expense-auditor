'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, AlertCircle, Loader2, UploadCloud, RefreshCw } from 'lucide-react'

export default function SubmitClaimPage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [purpose, setPurpose] = useState('')
  const [loading, setLoading] = useState(false)
  const [progressStep, setProgressStep] = useState(0)
  const [result, setResult] = useState<any>(null)
  const [unreadable, setUnreadable] = useState<string | null>(null)

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const selected = acceptedFiles[0]
    if (selected) {
      if (selected.size > 10 * 1024 * 1024) {
        toast.error('File too large (max 10MB)')
        return
      }
      setFile(selected)
      if (selected.type.startsWith('image/')) {
        setPreview(URL.createObjectURL(selected))
      } else {
        setPreview(null)
      }
    }
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/jpeg': [],
      'image/png': [],
      'image/webp': [],
      'application/pdf': [],
    },
    maxFiles: 1,
  })

  // Simulated progress steps for better UX
  const steps = [
    'Uploading receipt...',
    'Reading receipt with AI...',
    'Checking policy...',
    'Generating verdict...'
  ]

  const handleSubmit = async () => {
    if (!file || purpose.length < 10) return

    setLoading(true)
    setResult(null)
    setUnreadable(null)
    setProgressStep(0)

    // Simulate progress steps
    const interval = setInterval(() => {
      setProgressStep(prev => Math.min(prev + 1, 3))
    }, 1500)

    try {
      const formData = new FormData()
      formData.append('receipt', file)
      formData.append('business_purpose', purpose)

      const res = await fetch('/api/claims/analyze', {
        method: 'POST',
        body: formData,
      })

      clearInterval(interval)
      setProgressStep(3)

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to submit')

      if (data.unreadable) {
        setUnreadable(data.message)
      } else {
        setResult(data)
        toast.success('Claim processed successfully')
      }
    } catch (err: any) {
      clearInterval(interval)
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setPreview(null)
    setPurpose('')
    setResult(null)
    setUnreadable(null)
    setProgressStep(0)
  }

  const formatCurrency = (amt: number | null, curr: string | null) => {
    if (amt == null) return 'N/A'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: curr || 'USD' }).format(amt)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Submit Expense Claim</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Upload your receipt and get an instant policy check.</p>
      </div>

      {!result && !unreadable && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Section A - Upload */}
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold mb-4">1. Receipt Upload</h2>
            
            {!file ? (
              <div
                {...getRootProps()}
                className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 cursor-pointer transition-colors ${
                  isDragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20' : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700'
                }`}
              >
                <input {...getInputProps()} />
                <UploadCloud className="h-10 w-10 text-zinc-400 mb-2" />
                <p className="text-sm font-medium text-center text-zinc-700 dark:text-zinc-300">
                  {isDragActive ? 'Drop receipt here' : 'Drag & drop or click to select'}
                </p>
                <p className="text-xs text-zinc-500 mt-1">JPG, PNG, WebP, PDF (max 10MB)</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-zinc-200 overflow-hidden bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950">
                  {preview ? (
                    <img src={preview} alt="Receipt preview" className="max-h-48 mx-auto object-contain rounded" />
                  ) : (
                    <div className="h-32 flex items-center justify-center text-zinc-500">PDF Document</div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm truncate mr-4">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{file.name}</p>
                    <p className="text-zinc-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <button onClick={() => setFile(null)} className="text-sm text-red-600 hover:underline shrink-0">Remove</button>
                </div>
              </div>
            )}
          </div>

          {/* Section B - Purpose & Submit */}
          <div className="space-y-6">
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-semibold mb-4">2. Business Purpose</h2>
              <textarea
                className="w-full rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 min-h-[120px] dark:border-zinc-800 dark:focus-visible:ring-zinc-300"
                placeholder="e.g. Client lunch with Acme Corp to discuss Q3 renewal"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
              {purpose.length > 0 && purpose.length < 10 && (
                <p className="text-xs text-red-500 mt-1">Must be at least 10 characters.</p>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!file || purpose.length < 10 || loading}
              className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50"
            >
              Submit Claim
            </button>

            {loading && (
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 dark:border-blue-900/30 dark:bg-blue-950/20">
                <div className="flex items-center gap-3 text-blue-700 dark:text-blue-400 font-medium">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {steps[progressStep]}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Section D - Result */}
      {unreadable && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900/30 dark:bg-red-950/20 max-w-2xl mx-auto">
          <div className="flex items-start gap-4">
            <AlertCircle className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-800 dark:text-red-400 text-lg">Receipt Unreadable</h3>
              <p className="text-red-700 dark:text-red-300 mt-2">{unreadable}</p>
              <button
                onClick={handleReset}
                className="mt-4 px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 text-sm font-medium transition dark:bg-red-900/50 dark:text-red-200"
              >
                Clear & Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-6 max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Merchant</p>
              <p className="font-semibold text-lg mt-1">{result.extracted.merchant || 'Unknown'}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Amount</p>
              <p className="font-semibold text-lg mt-1">
                {formatCurrency(result.extracted.amount, result.extracted.currency)}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Date</p>
              <p className="font-semibold text-lg mt-1">{result.extracted.date || 'Unknown'}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Category</p>
              <p className="font-semibold text-lg mt-1 capitalize">{result.extracted.category}</p>
            </div>
          </div>

          <div className={`rounded-xl border p-6 shadow-sm ${
            result.verdict.verdict === 'approved' ? 'border-green-200 bg-green-50 dark:border-green-900/30 dark:bg-green-950/20' :
            result.verdict.verdict === 'flagged'  ? 'border-amber-200 bg-amber-50 dark:border-amber-900/30 dark:bg-amber-950/20' :
            'border-red-200 bg-red-50 dark:border-red-900/30 dark:bg-red-950/20'
          }`}>
            <div className="flex items-start gap-4">
              {result.verdict.verdict === 'approved' && <CheckCircle2 className="h-8 w-8 text-green-600 shrink-0" />}
              {result.verdict.verdict === 'flagged' && <AlertCircle className="h-8 w-8 text-amber-600 shrink-0" />}
              {result.verdict.verdict === 'rejected' && <XCircle className="h-8 w-8 text-red-600 shrink-0" />}
              
              <div>
                <h3 className={`text-xl font-bold capitalize ${
                  result.verdict.verdict === 'approved' ? 'text-green-800 dark:text-green-400' :
                  result.verdict.verdict === 'flagged'  ? 'text-amber-800 dark:text-amber-400' :
                  'text-red-800 dark:text-red-400'
                }`}>
                  {result.verdict.verdict}
                </h3>
                <p className="mt-2 text-zinc-700 dark:text-zinc-300 font-medium">
                  {result.verdict.reason}
                </p>
                {result.verdict.policy_reference && (
                  <div className="mt-4 text-sm bg-white/50 dark:bg-black/20 p-3 rounded border border-black/5 dark:border-white/5">
                    <strong>Policy Reference:</strong> {result.verdict.policy_reference}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-center pt-4">
            <button
              onClick={handleReset}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-md bg-zinc-900 text-zinc-50 font-medium hover:bg-zinc-800 transition dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <RefreshCw className="h-4 w-4" />
              Submit Another Claim
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
