'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, AlertCircle, Loader2, UploadCloud, RefreshCw, Camera, TrendingUp, PlusCircle, Layers, ArrowRight } from 'lucide-react'
import { useSearchParams, useRouter } from 'next/navigation'
import imageCompression from 'browser-image-compression'

async function checkImageQuality(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    // Only check images, skip PDFs
    if (!file.type.startsWith('image/')) return resolve(null)

    const img = new Image()
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)

      // Scale down image to max 500px for speedy processing
      const scale = Math.min(500 / img.width, 500 / img.height, 1)
      const w = canvas.width = Math.floor(img.width * scale)
      const h = canvas.height = Math.floor(img.height * scale)
      
      ctx.drawImage(img, 0, 0, w, h)
      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, w, h)
      } catch(e) {
        // Handle cross-origin issues or canvas poisoning safety mechanisms
        return resolve(null)
      }
      
      const data = imageData.data
      let sumLuminance = 0
      const grayscale = new Float32Array(w * h)

      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]
        sumLuminance += lum
        grayscale[i/4] = lum
      }

      const avgLuminance = sumLuminance / (w * h)
      if (avgLuminance < 40) return resolve("Image appears severely dark. AI reading might fail.")
      if (avgLuminance > 240) return resolve("Image appears highly overexposed/washed out.")

      // Quick Laplacian variance for blur detection
      let laplacianSum = 0
      let laplacianSqSum = 0
      let validPixels = 0

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          const val = 
            -4 * grayscale[i] +
            grayscale[i - 1] + grayscale[i + 1] +
            grayscale[i - w] + grayscale[i + w]
            
          laplacianSum += val
          laplacianSqSum += val * val
          validPixels++
        }
      }

      const mean = laplacianSum / validPixels
      const variance = (laplacianSqSum / validPixels) - (mean * mean)

      // Variance threshold tuned for downscaled receipts
      if (variance < 60) return resolve("Image appears blurry. Ensure text is sharp before submitting.")

      resolve(null)
    }
    img.onerror = () => resolve(null)
    img.src = objectUrl
  })
}

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
  const [qualityWarning, setQualityWarning] = useState<string | null>(null)
  const [budget, setBudget] = useState<Record<string, { limit: number; spent: number; currency: string }> | null>(null)
  const [isOnline, setIsOnline] = useState(true)

  // Feature 3: Batch queue
  type BatchItem = { id: string; file: File; preview: string | null; qualityWarning: string | null; status: 'pending' | 'uploading' | 'done' | 'error'; result?: any; error?: string }
  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([])
  const [batchSubmitting, setBatchSubmitting] = useState(false)

  // Feature 4: INR equivalent for foreign currencies
  const [inrEquivalent, setInrEquivalent] = useState<number | null>(null)

  // Fetch all category budgets once on mount
  useEffect(() => {
    fetch('/api/employee/budget')
      .then(r => r.json())
      .then(d => { if (d.budget) setBudget(d.budget) })
      .catch(() => {})
  }, [])

  // Feature 4: Fetch live INR equivalent when result has a foreign currency
  useEffect(() => {
    setInrEquivalent(null)
    const currency = result?.extracted?.currency
    const amount = result?.extracted?.amount
    if (!currency || !amount || currency === 'INR') return
    fetch(`https://open.er-api.com/v6/latest/${currency}`)
      .then(r => r.json())
      .then(d => {
        const rate = d?.rates?.INR
        if (rate && Number.isFinite(rate)) setInrEquivalent(Math.round(Number(amount) * rate))
      })
      .catch(() => {})
  }, [result])

  // Online/offline detection + queue flush
  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    setIsOnline(navigator.onLine)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    const flushQueue = async () => {
      const raw = localStorage.getItem('policylens-offline-queue')
      if (!raw) return
      const queue: any[] = JSON.parse(raw)
      if (queue.length === 0) return
      toast.info(`Syncing ${queue.length} offline claim(s)...`)
      const remaining: any[] = []
      for (const item of queue) {
        try {
          const fd = new FormData()
          Object.entries(item).forEach(([k, v]) => fd.append(k, v as string))
          const res = await fetch('/api/claims/analyze', { method: 'POST', body: fd })
          if (!res.ok) remaining.push(item)
          else toast.success('Offline claim synced!')
        } catch {
          remaining.push(item)
        }
      }
      if (remaining.length > 0) localStorage.setItem('policylens-offline-queue', JSON.stringify(remaining))
      else localStorage.removeItem('policylens-offline-queue')
    }

    window.addEventListener('online', flushQueue)
    window.addEventListener('policylens:flush-offline-queue', flushQueue as any)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', flushQueue)
      window.removeEventListener('policylens:flush-offline-queue', flushQueue as any)
    }
  }, [])

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
    
    // Check quality of the final processed file
    const warning = await checkImageQuality(processedFile)
    setQualityWarning(warning)
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

    // Offline: queue the text fields; receipt file must be re-uploaded when online
    if (!isOnline) {
      const queue = JSON.parse(localStorage.getItem('policylens-offline-queue') || '[]')
      queue.push({
        business_purpose: purpose,
        manual_merchant: manualMerchant,
        manual_amount: manualAmount,
        manual_category: manualCategory,
        _queued_at: new Date().toISOString(),
      })
      localStorage.setItem('policylens-offline-queue', JSON.stringify(queue))
      toast.warning('You are offline. Claim details saved. Re-attach receipt & it will auto-sync when you reconnect.')
      return
    }

    setLoading(true)
    setResult(null)
    setUnreadable(null)
    setProgressStep(0)

    const interval = setInterval(() => setProgressStep(prev => Math.min(prev + 1, 3)), 1500)

    try {
      const formData = new FormData()
      formData.append('receipt', file)
      formData.append('business_purpose', purpose)

      if (manualMerchant) formData.append('manual_merchant', manualMerchant)
      if (manualAmount) formData.append('manual_amount', manualAmount)
      if (manualCategory) formData.append('manual_category', manualCategory)
      
      if (resubmitId) {
        formData.append('parent_claim_id', resubmitId)
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
    setQualityWarning(null)
    setProgressStep(0)
    setInrEquivalent(null)
    router.replace('/employee/submit')
  }

  // Feature 3: Add current file to batch queue
  const handleAddToBatch = async () => {
    if (!file) return
    const id = `${Date.now()}-${Math.random()}`
    const item: BatchItem = {
      id,
      file,
      preview,
      qualityWarning,
      status: 'pending',
    }
    setBatchQueue(prev => [...prev, item])
    setFile(null)
    setPreview(null)
    setQualityWarning(null)
    toast.info('Receipt added to batch queue.')
  }

  // Feature 3: Submit all items in the batch queue sequentially
  const handleSubmitBatch = async () => {
    if (batchSubmitting || batchQueue.length === 0) return
    setBatchSubmitting(true)
    for (const item of batchQueue) {
      if (item.status === 'done') continue
      setBatchQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'uploading' } : i))
      try {
        const fd = new FormData()
        fd.append('receipt', item.file)
        fd.append('business_purpose', purpose.length >= 10 ? purpose : 'Batch submission')
        if (manualMerchant) fd.append('manual_merchant', manualMerchant)
        if (manualAmount) fd.append('manual_amount', manualAmount)
        if (manualCategory) fd.append('manual_category', manualCategory)
        const res = await fetch('/api/claims/analyze', { method: 'POST', body: fd })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed')
        setBatchQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done', result: data } : i))
      } catch (err: any) {
        setBatchQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error', error: err.message } : i))
      }
    }
    setBatchSubmitting(false)
    toast.success('Batch submission complete!')
  }

  const formatCurrency = (amt: number | null, curr: string | null) => {
    if (amt == null) return 'N/A'
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: curr || 'INR' }).format(amt)
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto md:max-w-none">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Submit Claim</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Capture your receipt for AI screening.</p>
      </div>

      {!isOnline && (
        <div className="flex items-center gap-3 rounded-lg px-4 py-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm dark:bg-amber-950/30 dark:border-amber-900/50 dark:text-amber-300">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <span><strong>You are offline.</strong> You can still fill in your claim details and they will be queued automatically. Re-attach your receipt when you reconnect to submit.</span>
        </div>
      )}

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
                  <button onClick={() => { setFile(null); setQualityWarning(null); }} className="text-sm text-red-600 hover:underline shrink-0 p-2 min-h-[48px]">Remove</button>
                </div>

                {/* Feature 3: Add to Batch button */}
                <button
                  onClick={handleAddToBatch}
                  className="flex items-center gap-2 w-full justify-center text-sm text-blue-600 hover:text-blue-700 border border-blue-200 rounded-md py-2 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/20 transition"
                >
                  <PlusCircle className="w-4 h-4" /> Add to Batch (queue another receipt)
                </button>
                
                {qualityWarning && (
                  <div className="flex items-start gap-2 p-3 text-sm rounded bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900/50 dark:text-amber-400">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <div>
                      <p className="font-semibold">Quality Warning</p>
                      <p>{qualityWarning}</p>
                    </div>
                  </div>
                )}
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
              
              <div className="mt-4 space-y-3 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <p className="text-xs text-zinc-500 mb-2">Override Extracted Values (Optional{resubmitId ? ' for resubmission' : ''})</p>
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Merchant</label>
                  <input
                    type="text"
                    className="w-full mt-1 rounded-md border border-zinc-200 bg-transparent px-3 min-h-[48px] text-sm dark:border-zinc-800"
                    value={manualMerchant}
                    onChange={e => setManualMerchant(e.target.value)}
                    placeholder="e.g. Office Stationery"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full mt-1 rounded-md border border-zinc-200 bg-transparent px-3 min-h-[48px] text-sm dark:border-zinc-800"
                    value={manualAmount}
                    onChange={e => setManualAmount(e.target.value)}
                    placeholder="e.g. 1578"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Category</label>
                  <input
                    type="text"
                    className="w-full mt-1 rounded-md border border-zinc-200 bg-transparent px-3 min-h-[48px] text-sm dark:border-zinc-800"
                    value={manualCategory}
                    onChange={e => setManualCategory(e.target.value)}
                    placeholder="e.g. office"
                  />
                </div>
              </div>
            </div>

            {/* Live Budget Meter */}
            {budget && (() => {
              const cat = (manualCategory || '').toLowerCase().trim()
              const info = cat && budget[cat] ? budget[cat] : null
              if (!info) return null
              const pct = Math.min(100, (info.spent / info.limit) * 100)
              const remaining = Math.max(0, info.limit - info.spent)
              const isOver = info.spent >= info.limit
              const isNear = !isOver && pct >= 80
              const barColor = isOver ? 'bg-red-500' : isNear ? 'bg-amber-500' : 'bg-emerald-500'
              const fmt = (v: number) =>
                new Intl.NumberFormat('en-IN', { style: 'currency', currency: info.currency || 'INR', maximumFractionDigits: 0 }).format(v)
              return (
                <div className={`rounded-xl border p-4 ${
                  isOver ? 'border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20'
                  : isNear ? 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20'
                  : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/20'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <TrendingUp className={`w-4 h-4 ${
                        isOver ? 'text-red-600' : isNear ? 'text-amber-600' : 'text-emerald-600'
                      }`} />
                      <span className="text-sm font-semibold capitalize">{cat} Budget</span>
                    </div>
                    <span className={`text-xs font-bold ${
                      isOver ? 'text-red-700 dark:text-red-400' : isNear ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                    }`}>
                      {isOver ? 'LIMIT EXCEEDED' : `${fmt(remaining)} remaining`}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                    <div
                      className={`h-2 rounded-full transition-all duration-500 ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-1.5 text-xs text-zinc-500">
                    <span>Spent: {fmt(info.spent)}</span>
                    <span>Limit: {fmt(info.limit)}</span>
                  </div>
                </div>
              )
            })()}

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

      {/* Feature 3: Batch Queue Display */}
      {batchQueue.length > 0 && !result && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-600" />
              <h2 className="text-lg font-semibold">Batch Queue ({batchQueue.length} receipts)</h2>
            </div>
            <button
              onClick={handleSubmitBatch}
              disabled={batchSubmitting || !isOnline}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none"
            >
              {batchSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {batchSubmitting ? 'Submitting...' : 'Submit All'}
            </button>
          </div>
          <div className="space-y-2">
            {batchQueue.map((item) => (
              <div key={item.id} className="flex items-center gap-3 p-3 rounded-lg border border-zinc-100 dark:border-zinc-800">
                {item.preview && <img src={item.preview} alt="preview" className="w-10 h-10 object-cover rounded border border-zinc-200" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.file.name}</p>
                  <p className="text-xs text-zinc-500">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <div className="shrink-0">
                  {item.status === 'pending' && <span className="text-xs text-zinc-400 capitalize">Pending</span>}
                  {item.status === 'uploading' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
                  {item.status === 'done' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                  {item.status === 'error' && <span title={item.error}><XCircle className="w-5 h-5 text-red-500" /></span>}
                </div>
                {item.status !== 'uploading' && item.status !== 'done' && (
                  <button onClick={() => setBatchQueue(prev => prev.filter(i => i.id !== item.id))} className="text-xs text-red-500 hover:underline shrink-0">Remove</button>
                )}
              </div>
            ))}
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
              {/* Feature 4: Live INR Equivalent */}
              {inrEquivalent != null && result.extracted.currency !== 'INR' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">≈ ₹{inrEquivalent.toLocaleString('en-IN')} INR</p>
              )}
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase">Category</p>
              <p className="font-semibold text-lg mt-1 capitalize">{result.extracted.category}</p>
            </div>
            {/* Feature 1: OCR Confidence Card */}
            <div className="col-span-2 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs text-zinc-500 uppercase mb-2">AI Extraction Quality</p>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${
                  result.extracted.confidence === 'high'   ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                  : result.extracted.confidence === 'medium' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                  : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'
                }`}>{(result.extracted.confidence || 'unknown').toUpperCase()} CONFIDENCE</span>
                {(['merchant', 'amount', 'date'] as const).map((field) => (
                  <div key={field} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {result.extracted[field] != null
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      : <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                    <span className="capitalize">{field}:</span>
                    <span className="font-medium text-zinc-800 dark:text-zinc-200">
                      {result.extracted[field] != null ? String(result.extracted[field]) : 'not detected'}
                    </span>
                  </div>
                ))}
              </div>
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
                
                {result.verdict.policy_reference && (
                  <div className="mt-3 p-3 bg-white/50 dark:bg-black/20 rounded border border-zinc-200/50 dark:border-zinc-800/50 text-sm">
                    <p className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-1">Aligning Policy Clause</p>
                    <p className="text-zinc-700 dark:text-zinc-300 italic">"{result.verdict.policy_reference}"</p>
                  </div>
                )}

                {Array.isArray(result.compared_policies) && result.compared_policies.length > 0 && (
                  <div className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                    <p className="font-medium">Compared Policies:</p>
                    <p>{result.compared_policies.join(', ')}</p>
                  </div>
                )}
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
