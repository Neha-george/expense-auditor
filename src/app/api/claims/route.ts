import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { extractReceiptData, extractReceiptDataFromText } from '@/lib/gemini'

type ClaimRow = {
  id: string
  organisation_id: string
  receipt_url?: string | null
  merchant?: string | null
  amount?: number | null
  category?: string | null
  currency?: string | null
  receipt_date?: string | null
  [key: string]: any
}

function needsExtractionBackfill(claim: ClaimRow) {
  return !claim.merchant || claim.amount == null || !claim.category
}

async function extractFromReceiptUrl(url: string) {
  let buffer: Buffer | null = null
  let mimeType = 'application/octet-stream'

  try {
    const response = await fetch(url)
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer()
      buffer = Buffer.from(arrayBuffer)
      mimeType = response.headers.get('content-type') || mimeType
    }
  } catch {
    // Fallback to storage download below.
  }

  if (!buffer) {
    const publicMarker = '/storage/v1/object/public/receipts/'
    const signedMarker = '/storage/v1/object/sign/receipts/'
    let path = ''

    if (url.includes(publicMarker)) {
      path = url.split(publicMarker)[1] || ''
    } else if (url.includes(signedMarker)) {
      path = url.split(signedMarker)[1] || ''
    }

    path = decodeURIComponent(path.split('?')[0] || '')
    if (!path) throw new Error('Unable to resolve receipt storage path')

    const admin = createAdminSupabase()
    const { data: downloaded, error: downloadError } = await admin.storage
      .from('receipts')
      .download(path)

    if (downloadError || !downloaded) {
      throw new Error(downloadError?.message || 'Receipt storage download failed')
    }

    const arrayBuffer = await downloaded.arrayBuffer()
    buffer = Buffer.from(arrayBuffer)
    mimeType = downloaded.type || mimeType
  }

  const headerHex = buffer.toString('hex', 0, 4).toUpperCase()

  if (headerHex.startsWith('25504446')) mimeType = 'application/pdf'
  else if (headerHex.startsWith('FFD8FF')) mimeType = 'image/jpeg'
  else if (headerHex.startsWith('89504E47')) mimeType = 'image/png'
  else if (headerHex.startsWith('52494646')) mimeType = 'image/webp'

  if (mimeType === 'application/pdf') {
    const pdf = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>
    const parsed = await pdf(buffer)
    return await extractReceiptDataFromText(parsed?.text || '')
  }

  return await extractReceiptData(buffer.toString('base64'), mimeType)
}

export async function GET(request: NextRequest) {
  try {
    // Use RLS-enabled client for auth + profile reads
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const exportCsv = searchParams.get('export') === 'true'

    // RLS handles row-level isolation; we still explicitly filter by org_id
    // for defence-in-depth (and to support the admin view).
    let query = supabase
      .from('claims')
      .select('*, profiles!claims_employee_id_fkey(full_name, email, department, location)')
      .eq('organisation_id', orgId)
      .order('created_at', { ascending: false })

    // Employees only see their own claims (RLS enforces this too)
    if (profile?.role !== 'admin') {
      query = query.eq('employee_id', user.id)
    }
    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    const { data: claims, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const resolvedClaims: ClaimRow[] = [...(claims || [])]

    // Best-effort backfill for legacy rows missing extracted receipt fields.
    const candidates = resolvedClaims.filter(needsExtractionBackfill).slice(0, 10)
    for (const claim of candidates) {
      if (!claim.receipt_url) continue

      try {
        const extracted: any = await extractFromReceiptUrl(claim.receipt_url)
        const updates: Record<string, any> = {}

        if (!claim.merchant && extracted?.merchant) updates.merchant = extracted.merchant
        if ((claim.amount == null) && Number.isFinite(Number(extracted?.amount))) updates.amount = Number(extracted.amount)
        if (!claim.category && extracted?.category) updates.category = extracted.category
        if (!claim.currency && extracted?.currency) updates.currency = extracted.currency
        if (!claim.receipt_date && extracted?.date) updates.receipt_date = extracted.date

        // Fill deterministic defaults if extraction still misses critical fields.
        if (!claim.merchant && !updates.merchant) updates.merchant = 'Unknown Merchant'
        if ((claim.amount == null) && updates.amount == null) updates.amount = 0
        if (!claim.category && !updates.category) updates.category = 'other'
        if (!claim.currency && !updates.currency) updates.currency = 'INR'
        if (!claim.receipt_date && !updates.receipt_date) updates.receipt_date = new Date().toISOString().split('T')[0]

        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await admin
            .from('claims')
            .update(updates)
            .eq('id', claim.id)
            .eq('organisation_id', orgId)

          if (!updateError) {
            Object.assign(claim, updates)
          }
        }
      } catch (enrichError: any) {
        console.warn(`Claim enrichment skipped for ${claim.id}:`, enrichError?.message)
      }
    }

    if (exportCsv && profile?.role === 'admin') {
      const headers = [
        'id','employee','email','merchant','amount','currency','date',
        'category','business_purpose','ai_verdict','ai_reason',
        'policy_reference','status','created_at',
      ]
      const rows = resolvedClaims.map(c => [
        c.id, (c.profiles as any)?.full_name, (c.profiles as any)?.email,
        c.merchant, c.amount, c.currency, c.receipt_date,
        c.category, `"${c.business_purpose}"`, c.ai_verdict,
        `"${c.ai_reason}"`, `"${c.policy_reference}"`, c.status, c.created_at,
      ])
      const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="claims-export.csv"',
        },
      })
    }

    return NextResponse.json({ claims: resolvedClaims })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
