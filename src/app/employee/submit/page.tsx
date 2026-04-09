'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, AlertCircle, Loader2, UploadCloud, RefreshCw, Camera } from 'lucide-react'
import { useSearchParams, useRouter } from 'next/navigation'
import imageCompression from 'browser-image-compression'

function SubmitClaimForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const resubmitId = searchParams.get('resubmit')

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [purpose, setPurpose] = useState('')
  const [loading, setLoading] = useState(false)
  const [progressStep, setProgressStep] = useState(0)
  const [result, setResult] = useState<any>(null)
  const [unreadable, setUnreadable] = useState<string | null>(null)

  const [resubmitClaim, setResubmitClaim] = useState<any>(null)
  const [manualMerchant, setManualMerchant] = useState('')
  const [manualAmount, setManualAmount] = useState('')
  const [manualCategory, setManualCategory] = useState('')

  useEffect(() => {
    if (resubmitId) {
      fetch(`/api/claims`)
        .then(r => r.json())
        .then(d => {
           if (d.claims) {
             const claim = d.claims.find((c: any) => c.id === resubmitId)
             if (claim) {
               setResubmitClaim(claim)
               setPurpose(claim.business_purpose || '')
               setManualMerchant(claim.merchant || '')
               setManualAmount(claim.amount?.toString() || '')
               setManualCategory(claim.category || '')
             }
           }
        })
    }
  }, [resubmitId])

  const processFile = async (rawFile: File) => {
    if (rawFile.size > 15 * 1024 * 1024) {
      toast.error('File too large (max 15MB)')
      return
    }

    let processedFile = rawFile
    
    // Client-Side Image Compression for Mobile
    if (rawFile.type.startsWith('image/')) {
        try {
            const options = {
              maxSizeMB: 1,
              maxWidthOrHeight: 1920,
              useWebWorker: true,
            }
            const compressedItem = await imageCompression(rawFile, options)
            processedFile = new File([compressedItem], rawFile.name, { type: rawFile.type })
            console.log(`Compressed from ${(rawFile.size/1024/1024).toFixed(2)}MB to ${(processedFile.size/1024/1024).toFixed(2)}MB`)
        } catch (error) {
            console.error("Compression err", error)
        }
        setPreview(URL.createObjectURL(processedFile))
    } else {
        setPreview(null)
    }
    setFile(processedFile)
  }

  const handleCameraCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0])
    }
  }

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles[0]) processFile(acceptedFiles[0])
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/jpeg': [], 'image/png': [], 'image/webp': [], 'application/pdf': [] },
    maxFiles: 1,
  })

  const steps = ['Uploading receipt...', 'Reading with AI...', 'Checking policy...', 'Generating verdict...']

  const handleSubmit = async () => {
    if (!file || purpose.length < 10) return

    setLoading(true)
    setResult(null)
    setUnreadable(null)
    setProgressStep(0)

    const interval = setInterval(() => setProgressStep(prev => Math.min(prev + 1, 3)), 1500)

    try {
      const formData = new FormData()
      formData.append('receipt', file)
      formData.append('business_purpose', purpose)
      
      if (resubmitId) {
        formData.append('parent_claim_id', resubmitId)
        if (manualMerchant) formData.append('manual_merchant', manualMerchant)
        if (manualAmount) formData.append('manual_amount', manualAmount)
        if (manualCategory) formData.append('manual_category', manualCategory)
      }

      const res = await fetch('/api/claims/analyze', { method: 'POST', body: formData })
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
    router.replace('/employee/submit')
  }

  const formatCurrency = (amt: number | null, curr: string | null) => {
    if (amt == null) return 'N/A'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: curr || 'USD' }).format(amt)
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto md:max-w-none">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Submit Claim</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Capture your receipt for AI screening.</p>
      </div>

      {resubmitClaim && !result && (
        <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-900/30 dark:bg-blue-950/20">
          <h3 className="font-semibold text-blue-800 dark:text-blue-300">Resubmitting Correction</h3>
          <p className="text-sm mt-1 text-blue-700 dark:text-blue-400">
             Previous Rejection: <strong>{resubmitClaim.admin_note || resubmitClaim.ai_reason}</strong>
          </p>
        </div>
      )}

      {!result && !unreadable && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Section A - Upload */}
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold mb-4">1. Receipt Scan</h2>
            
            {!file ? (
              <div className="space-y-4">
                <label className="flex w-full items-center justify-center gap-2 cursor-pointer bg-zinc-900 hover:bg-zinc-800 text-white rounded-md py-3 text-sm font-medium transition min-h-[48px] dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200">
                  <Camera className="w-5 h-5" /> Take Photo
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCameraCapture} />
                </label>
                
                <div className="text-center text-xs text-zinc-400 uppercase">Or</div>

                <div
                  {...getRootProps()}
                  className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 cursor-pointer transition min-h-[120px] ${
                    isDragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20' : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700'
                  }`}
                >
                  <input {...getInputProps()} />
                  <UploadCloud className="h-8 w-8 text-zinc-400 mb-2" />
                  <p className="text-sm font-medium text-center text-zinc-700 dark:text-zinc-300">Select File</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-zinc-200 overflow-hidden bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950 flex justify-center">
                  {preview ? (
                    <img src={preview} alt="Receipt preview" className="max-h-48 object-contain rounded" />
                  ) : (
                    <div className="h-32 flex items-center justify-center text-zinc-500">Document Selected</div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm truncate mr-4">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{file.name}</p>
                    <p className="text-zinc-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <button onClick={() => setFile(null)} className="text-sm text-red-600 hover:underline shrink-0 p-2 min-h-[48px]">Remove</button>
                </div>
              </div>
            )}
          </div>

          {/* Section B - Purpose & Overrides */}
          <div className="space-y-6">
            <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-semibold mb-4">2. Claim Details</h2>
              <textarea
                className="w-full rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 min-h-[120px] dark:border-zinc-800 dark:focus-visible:ring-zinc-300"
                placeholder="e.g. Client lunch to discuss Q3 renewal"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
              
              {resubmitId && (
                <div className="mt-4 space-y-3 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                   <p className="text-xs text-zinc-500 mb-2">Override Extracted Values (Optional)</p>
                   <div>
                     <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Amount</label>
                     <input type="number" step="0.01" className="w-full mt-1 rounded-md border border-zinc-200 bg-transparent px-3 min-h-[48px] text-sm dark:border-zinc-800" value={manualAmount} onChange={e => setManualAmount(e.target.value)} />
                   </div>
                   <div>
                     <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Category</label>
                     <input type="text" className="w-full mt-1 rounded-md border border-zinc-200 bg-transparent px-3 min-h-[48px] text-sm dark:border-zinc-800" value={manualCategory} onChange={e => setManualCategory(e.target.value)} />
                   </div>
                </div>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!file || purpose.length < 10 || loading}
              className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50 min-h-[48px]"
            >
              Submit Expense
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

      {/* Results Section */}
      {unreadable && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900/30 dark:bg-red-950/20 max-w-2xl mx-auto">
          <div className="flex items-start gap-4">
            <AlertCircle className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-800 dark:text-red-400 text-lg">Receipt Unreadable</h3>
              <p className="text-red-700 dark:text-red-300 mt-2">{unreadable}</p>
              <button
                onClick={handleReset}
                className="mt-4 px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 text-sm font-medium min-h-[48px] dark:bg-red-900/50 dark:text-red-200"
              >
                Clear & Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-6 max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-2 gap-4">
             {/* Summary Cards */}
             <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase">Amount</p>
              <p className="font-semibold text-lg mt-1">{formatCurrency(result.extracted.amount, result.extracted.currency)}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase">Category</p>
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
                <p className="mt-2 text-zinc-700 dark:text-zinc-300 font-medium">{result.verdict.reason}</p>
              </div>
            </div>
          </div>

          <div className="flex justify-center pt-4">
            <button
              onClick={handleReset}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-md min-h-[48px] bg-zinc-900 text-zinc-50 font-medium hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <RefreshCw className="h-4 w-4" /> Start New Claim
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SubmitClaimPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading interface...</div>}>
      <SubmitClaimForm />
    </Suspense>
  )
}
