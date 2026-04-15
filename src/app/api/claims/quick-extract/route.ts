import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'
import { generateContentWithBackoff } from '@/lib/gemini'

export const maxDuration = 15

const MAX_SIZE = 10 * 1024 * 1024

type QuickExtractResponse = {
  merchant: string | null
  amount: number | null
  currency: string
  date: string | null
  confidence: number
}

function sanitizeCurrency(value: unknown): string {
  const raw = String(value || 'INR').trim().toUpperCase()
  return raw.length === 3 ? raw : 'INR'
}

function sanitizeDate(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().split('T')[0]
}

function sanitizeAmount(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null
}

function normalizeConfidence(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

function parseJsonPayload(text: string): any {
  const cleaned = text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(cleaned)
}

async function runWithTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quick extract timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('receipt') as File | null
    if (!file) return NextResponse.json({ error: 'Receipt file required' }, { status: 400 })
    if (file.size > MAX_SIZE) return NextResponse.json({ error: 'File too large' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const header = buffer.toString('hex', 0, 4).toUpperCase()

    let mimeType = file.type || 'application/octet-stream'
    if (header.startsWith('FFD8FF')) mimeType = 'image/jpeg'
    else if (header.startsWith('89504E47')) mimeType = 'image/png'
    else if (header.startsWith('52494646')) mimeType = 'image/webp'
    else if (header.startsWith('25504446')) mimeType = 'application/pdf'

    if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
      return NextResponse.json({ error: 'Only image/pdf files are supported' }, { status: 400 })
    }

    const prompt = `You are a fast receipt extraction assistant.
Return ONLY valid JSON in this exact shape:
{
  "merchant": "string or null",
  "amount": number or null,
  "currency": "3-letter code, default INR",
  "date": "YYYY-MM-DD or null",
  "confidence": number between 0 and 1
}

Rules:
- Keep this lightweight and quick.
- If uncertain, return null for field and lower confidence.
- No markdown, no extra text.`

    const response = await runWithTimeout(
      generateContentWithBackoff([
        { inlineData: { data: buffer.toString('base64'), mimeType } },
        prompt,
      ]),
      3000
    )

    const parsed = parseJsonPayload(response.response.text() || '{}')

    const payload: QuickExtractResponse = {
      merchant: parsed?.merchant ? String(parsed.merchant).trim() : null,
      amount: sanitizeAmount(parsed?.amount),
      currency: sanitizeCurrency(parsed?.currency),
      date: sanitizeDate(parsed?.date),
      confidence: normalizeConfidence(parsed?.confidence),
    }

    return NextResponse.json(payload)
  } catch (err) {
    console.warn('Quick extract error:', err)
    return NextResponse.json(
      {
        merchant: null,
        amount: null,
        currency: 'INR',
        date: null,
        confidence: 0.2,
      } satisfies QuickExtractResponse,
      { status: 200 }
    )
  }
}
