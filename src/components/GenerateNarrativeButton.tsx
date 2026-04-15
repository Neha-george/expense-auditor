'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { toast } from 'sonner'
import { ClipboardCopy, FileDown, Loader2, Sparkles, X } from 'lucide-react'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'

type NarrativePayload = {
  narrative: string
  month: string
  org_id: string
  generated_at: string
}

type CacheEnvelope = {
  expires_at: number
  payload: NarrativePayload
}

const CACHE_TTL_MS = 60 * 60 * 1000

function toMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function buildCacheKey(orgId: string, month: string) {
  return `policylens-narrative:${orgId}:${month}`
}

async function buildDocxBlob(payload: NarrativePayload): Promise<Blob> {
  const paragraphs = payload.narrative
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean)

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: 'PolicyLens Monthly Expense Narrative',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Month: ${payload.month}` }),
              new TextRun({ text: `  |  Generated: ${new Date(payload.generated_at).toLocaleString('en-IN')}` }),
            ],
          }),
          ...paragraphs.map(
            (p) =>
              new Paragraph({
                children: [new TextRun({ text: p })],
                spacing: { after: 240 },
              })
          ),
        ],
      },
    ],
  })

  return Packer.toBlob(doc)
}

export default function GenerateNarrativeButton() {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<NarrativePayload | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)

  const month = useMemo(() => toMonthKey(), [])
  const cacheKey = useMemo(() => (orgId ? buildCacheKey(orgId, month) : null), [orgId, month])

  useEffect(() => {
    const loadOrg = async () => {
      try {
        const supabase = createClient()
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (!user) return

        const { data: profile } = await supabase
          .from('profiles')
          .select('organisation_id')
          .eq('id', user.id)
          .single()

        setOrgId(profile?.organisation_id || null)
      } catch {
        setOrgId(null)
      }
    }

    void loadOrg()
  }, [])

  const loadCached = () => {
    if (!cacheKey) return null
    const raw = localStorage.getItem(cacheKey)
    if (!raw) return null

    try {
      const cache = JSON.parse(raw) as CacheEnvelope
      if (!cache?.payload || !cache?.expires_at) return null
      if (Date.now() > cache.expires_at) {
        localStorage.removeItem(cacheKey)
        return null
      }
      return cache.payload
    } catch {
      return null
    }
  }

  const saveCache = (result: NarrativePayload) => {
    if (!cacheKey) return
    const envelope: CacheEnvelope = {
      expires_at: Date.now() + CACHE_TTL_MS,
      payload: result,
    }
    localStorage.setItem(cacheKey, JSON.stringify(envelope))
  }

  const handleGenerate = async () => {
    const cached = loadCached()
    if (cached) {
      setPayload(cached)
      setOpen(true)
      toast.success('Loaded cached narrative report from the last hour.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/admin/narrative-report', {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to generate narrative report')

      const result: NarrativePayload = {
        narrative: String(data?.narrative || ''),
        month: String(data?.month || month),
        org_id: String(data?.org_id || orgId || ''),
        generated_at: String(data?.generated_at || new Date().toISOString()),
      }

      setPayload(result)
      setOpen(true)
      saveCache(result)
      toast.success('Narrative report generated.')
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate narrative report')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!payload?.narrative) return
    try {
      await navigator.clipboard.writeText(payload.narrative)
      toast.success('Narrative copied to clipboard.')
    } catch {
      toast.error('Clipboard copy failed.')
    }
  }

  const handleDownloadDocx = async () => {
    if (!payload) return
    try {
      const blob = await buildDocxBlob(payload)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `expense-narrative-${payload.month}.docx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success('DOCX report downloaded.')
    } catch {
      toast.error('Failed to generate DOCX file.')
    }
  }

  return (
    <>
      <button
        onClick={() => void handleGenerate()}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        Generate Narrative Report
      </button>

      {open && payload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Monthly Expense Narrative</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{payload.month} • Generated {new Date(payload.generated_at).toLocaleString('en-IN')}</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
              {payload.narrative
                .split(/\n\s*\n/g)
                .map((paragraph, idx) => (
                  <p key={idx} className="mb-4 text-sm leading-7 text-zinc-800 dark:text-zinc-200">
                    {paragraph}
                  </p>
                ))}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <button
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <ClipboardCopy className="h-4 w-4" />
                Copy
              </button>
              <button
                onClick={() => void handleDownloadDocx()}
                className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <FileDown className="h-4 w-4" />
                Download as .docx
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
