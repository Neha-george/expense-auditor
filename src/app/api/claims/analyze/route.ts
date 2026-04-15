import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { extractReceiptData, extractReceiptDataBestEffort, extractReceiptDataFromText, extractReceiptDataLocally, generateVerdict, embedText } from '@/lib/gemini'
import { sendEmail, resubmissionTemplate, verdictTemplate, submissionConfirmationTemplate, adminFlaggedAlertTemplate } from '@/lib/email'

export const maxDuration = 60

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseLocation(locationRaw?: string | null) {
  const raw = (locationRaw || '').trim()
  if (!raw) return { city: null as string | null, country: null as string | null }

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1) return { city: parts[0], country: parts[0] }

  return {
    city: parts[0] || null,
    country: parts[parts.length - 1] || null,
  }
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function buildFastVerdict(params: {
  claimAmount: number
  claimCurrency: string
  policyChunks: string[]
  structuredLimit: { limit: number; currency: string; currentSpend: number } | null
}): {
  verdict: 'approved' | 'flagged' | 'rejected'
  reason: string
  policy_reference: string | null
  confidence: number
} {
  if (!params.policyChunks.length) {
    return {
      verdict: 'flagged',
      reason: 'No active policy clauses matched this claim. Flagged for manual review.',
      policy_reference: null,
      confidence: 0.55,
    }
  }

  const firstReference = params.policyChunks[0].slice(0, 220)

  if (params.structuredLimit) {
    const remaining = Number(params.structuredLimit.limit) - Number(params.structuredLimit.currentSpend)
    if (params.claimAmount > remaining) {
      return {
        verdict: 'rejected',
        reason: `Claim exceeds remaining monthly limit (${remaining.toFixed(2)} ${params.structuredLimit.currency}).`,
        policy_reference: firstReference,
        confidence: 0.9,
      }
    }
  }

  return {
    verdict: 'approved',
    reason: 'Claim aligns with available policy clauses and configured limits.',
    policy_reference: firstReference,
    confidence: 0.82,
  }
}

type FieldKey = 'merchant' | 'amount' | 'date'

function clampConfidence(value: number) {
  return Math.max(1, Math.min(99, Math.round(value)))
}

function buildFieldConfidence(params: {
  extracted: any
  manualMerchant: string | null
  manualAmount: string | null
}) {
  const overall = params.extracted?.confidence
  const overallBase = overall === 'high' ? 86 : overall === 'medium' ? 70 : 56

  const merchantValue = params.extracted?.merchant
  const amountValue = Number(params.extracted?.amount)
  const dateValue = params.extracted?.date

  const hasMerchant = Boolean(merchantValue) && merchantValue !== 'Unknown Merchant' && merchantValue !== 'Unknown'
  const hasAmount = Number.isFinite(amountValue) && amountValue > 0
  const hasDate = Boolean(dateValue) && !Number.isNaN(Date.parse(String(dateValue)))

  const fieldConfidence: Record<FieldKey, number> = {
    merchant: params.manualMerchant?.trim()
      ? 99
      : hasMerchant
      ? clampConfidence(overallBase + 4)
      : 22,
    amount: params.manualAmount?.trim()
      ? 99
      : hasAmount
      ? clampConfidence(overallBase + 6)
      : 22,
    date: hasDate
      ? clampConfidence(overallBase + 3)
      : 22,
  }

  const fieldSource: Record<FieldKey, 'manual' | 'ocr' | 'missing'> = {
    merchant: params.manualMerchant?.trim() ? 'manual' : hasMerchant ? 'ocr' : 'missing',
    amount: params.manualAmount?.trim() ? 'manual' : hasAmount ? 'ocr' : 'missing',
    date: hasDate ? 'ocr' : 'missing',
  }

  return { fieldConfidence, fieldSource }
}

export async function POST(request: NextRequest) {
  try {
    // Standard (RLS) client for auth — admin client only for writes
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Fetch profile including org_id (RLS ensures this is the caller's own row)
    const { data: profile } = await supabase
      .from('profiles')
      .select('location, department, seniority, role, full_name, email, organisation_id')
      .eq('id', user.id)
      .single()

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'Organisation not configured' }, { status: 403 })

    // ── Rate Limiting (scoped to user, not just org) ──────────
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count } = await admin
      .from('request_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('endpoint', 'analyze')
      .gte('created_at', oneHourAgo)

    if ((count ?? 0) >= 30)
      return NextResponse.json({ error: 'Rate limit exceeded. Try again in an hour.' }, { status: 429 })

    await admin.from('request_logs').insert({ user_id: user.id, endpoint: 'analyze' })

    // ── File validation ───────────────────────────────────────
    const formData = await request.formData()
    const file = formData.get('receipt') as File
    const businessPurpose = formData.get('business_purpose') as string
    
    // Resubmission contextual properties
    const parentClaimId = formData.get('parent_claim_id') as string | null
    const manualMerchant = formData.get('manual_merchant') as string | null
    const manualAmount = formData.get('manual_amount') as string | null
    const manualCategory = formData.get('manual_category') as string | null
    const manualCurrency = formData.get('manual_currency') as string | null
    const manualDate = formData.get('manual_date') as string | null
    const quickExtractSuggestionRaw = formData.get('quick_extract_suggestion') as string | null

    if (!file) return NextResponse.json({ error: 'Receipt file required' }, { status: 400 })
    if (file.size > MAX_SIZE)
      return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })
    if (!businessPurpose?.trim())
      return NextResponse.json({ error: 'Business purpose is required' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())

    // Server-side MIME validation via magic bytes
    const hex = buffer.toString('hex', 0, 4).toUpperCase()
    let isValidType = false
    let actualType = file.type

    if (hex.startsWith('FFD8FF'))   { isValidType = true; actualType = 'image/jpeg' }
    else if (hex.startsWith('89504E47')) { isValidType = true; actualType = 'image/png' }
    else if (hex.startsWith('52494646')) { isValidType = true; actualType = 'image/webp' }
    else if (hex.startsWith('25504446')) { isValidType = true; actualType = 'application/pdf' }

    if (!isValidType)
      return NextResponse.json({ error: 'Only JPG, PNG, WebP, and PDF accepted.' }, { status: 400 })

    // ── Upload receipt to storage ─────────────────────────────
    const ext = actualType.split('/')[1]
    const fileName = `${orgId}/${user.id}/${Date.now()}.${ext}`

    const { error: uploadError } = await admin.storage
      .from('receipts')
      .upload(fileName, buffer, { contentType: actualType })
    if (uploadError) throw uploadError

    const { data: { publicUrl } } = admin.storage
      .from('receipts').getPublicUrl(fileName)

    // ── Step 1: Receipt extraction (image OCR + PDF text fallback) ─────────
    const imageBase64 = buffer.toString('base64')
    let extracted: any = null

    const hasCoreFields = (value: any) => {
      const amt = Number(value?.amount)
      return (
        Boolean(value?.merchant) &&
        value.merchant !== 'Unknown Merchant' &&
        value.merchant !== 'Unknown' &&
        Number.isFinite(amt) &&
        amt > 0 &&
        Boolean(value?.category)
      )
    }

    const tryGeminiExtraction = async () => {
      try {
        const res = await withTimeout(extractReceiptData(imageBase64, actualType), 45000, 'Gemini OCR extraction')
        console.log('[Gemini Result]', JSON.stringify(res))
        if (res && (hasCoreFields(res) || res.confidence === 'high')) return res
        if (res) console.warn('[Gemini] Result incomplete, seeking fallback...')
      } catch (e: any) {
        console.warn('[Gemini] Primary extraction failed/timeout:', e.message)
      }
      return null
    }

    const tryLocalExtraction = async () => {
      try {
        const local = await withTimeout(extractReceiptDataLocally(buffer, actualType), 12000, 'Local receipt extraction')
        console.log('[Local Result]', JSON.stringify(local))
        return local
      } catch (e: any) {
        console.warn('[Local] Fallback extraction failed:', e.message)
        return null
      }
    }

    // 1. Primary Attempt: Gemini (High accuracy, 15s timeout)
    extracted = await tryGeminiExtraction()

    // 2. Special Case: PDF text extraction (Highest accuracy for text-based PDFs)
    if (actualType === 'application/pdf' && !hasCoreFields(extracted)) {
      try {
        const pdf = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>
        const parsed = await pdf(buffer)
        if (parsed?.text?.trim()) {
          const textRes = await withTimeout(extractReceiptDataFromText(parsed.text), 8000, 'PDF text extraction')
          if (hasCoreFields(textRes)) {
            console.log('[PDF Text Result] Success')
            extracted = textRes
          }
        }
      } catch (pdfErr: any) {
        console.warn('[PDF Text] Fallback failed:', pdfErr.message)
      }
    }

    // 3. Fallback Attempt: Best Effort Gemini (if first pass was weak or failed)
    if (!hasCoreFields(extracted) && actualType !== 'application/pdf') {
      try {
        const bestEffort = await withTimeout(extractReceiptDataBestEffort(imageBase64, actualType), 45000, 'Gemini best-effort')
        console.log('[Gemini Best-Effort Result]', JSON.stringify(bestEffort))
        if (hasCoreFields(bestEffort)) extracted = bestEffort
      } catch (beErr: any) {
        console.warn('[Gemini Best-Effort] Failed/timeout:', beErr.message)
      }
    }

    // 4. Final Fallback: Local OCR (Tesseract)
    if (!hasCoreFields(extracted)) {
      const localRes = await tryLocalExtraction()
      if (localRes?.is_readable) {
        // Only override if local actually found something useful or if we have nothing at all
        if (!extracted || hasCoreFields(localRes)) {
          extracted = { ...extracted, ...localRes }
        }
      }
    }

    if (!extracted) {
      extracted = {
        is_readable: true,
        merchant: null,
        amount: null,
        currency: 'INR',
        date: null,
        category: null,
        confidence: 'low',
      }
    }

    extracted = {
      ...extracted,
      is_readable: extracted?.is_readable !== false,
      merchant: (manualMerchant && manualMerchant.trim()) || extracted?.merchant || 'Unknown Merchant',
      amount: manualAmount ? Number(manualAmount) : (Number.isFinite(Number(extracted?.amount)) ? Number(extracted.amount) : 0),
      currency: (manualCurrency && manualCurrency.trim().toUpperCase()) || extracted?.currency || 'INR',
      date: (manualDate && manualDate.trim()) || extracted?.date || new Date().toISOString().split('T')[0],
      category: (manualCategory && manualCategory.trim()) || extracted?.category || 'other',
    }

    const { fieldConfidence, fieldSource } = buildFieldConfidence({
      extracted,
      manualMerchant,
      manualAmount,
    })
    extracted.field_confidence = fieldConfidence
    extracted.field_source = fieldSource

    // Unreadable receipt → notify and return early
    if (!extracted.is_readable) {
      if (profile?.email) {
        await sendEmail({
          to: profile.email,
          subject: 'Receipt Resubmission Required - PolicyLens',
          html: resubmissionTemplate(profile.full_name, new Date().toISOString().split('T')[0], businessPurpose)
        })
      }
      return NextResponse.json({
        success: false,
        unreadable: true,
        message: 'The receipt image is unclear or unreadable. Please upload a clearer photo.',
      })
    }

    // ── Step 2: Resolve active policies for comparison ───────
    const { data: activePolicies, error: activePoliciesError } = await admin
      .from('policy_documents')
      .select('id, name')
      .eq('organisation_id', orgId)
      .eq('is_active', true)

    if (activePoliciesError) throw activePoliciesError

    const comparedPolicies = (activePolicies || []).map((p: any) => p.name)
    const activePolicyCount = activePolicies?.length ?? 0

    let policyChunks: string[] = []
    if (activePolicyCount > 0) {
      // ── Step 3: Embed for vector search ──────────────────────
      const searchQuery = `${extracted.category} expense: ${businessPurpose}`
      const queryEmbedding = await embedText(searchQuery)

      // ── Step 4: Org-isolated vector search across all active policies ───────
      const matchCount = Math.min(24, Math.max(4, activePolicyCount * 4))
      const { data: chunks } = await admin.rpc('match_policy_chunks', {
        query_embedding: JSON.stringify(queryEmbedding),
        match_count: matchCount,
        p_organisation_id: orgId,         // ← KEY: tenant isolation
      })
      policyChunks = chunks?.map((c: any) => c.content) ?? []

      if (policyChunks.length === 0 && activePolicies.length > 0) {
        const activePolicyIds = activePolicies.map((p: any) => p.id)
        const { data: fallbackChunks } = await admin
          .from('policy_chunks')
          .select('content')
          .eq('organisation_id', orgId)
          .in('document_id', activePolicyIds)
          .order('chunk_index', { ascending: true })
          .limit(16)

        policyChunks = fallbackChunks?.map((c: any) => c.content) ?? []
      }
    }

    // ── Step 5: Generate verdict ──────────────────────────────
    const location = parseLocation(profile?.location)
    const roleDepartment = profile?.department || 'unknown'
    const roleSeniority = profile?.seniority || 'mid'
    const roleCategory = manualCategory || extracted.category || 'other'
    const locationCountry = location.country || 'Unknown'
    const locationCity = location.city || 'Unknown'

    let verdictData: {
      verdict: string
      reason: string
      policy_reference: string | null
      confidence?: number
    } = {
      verdict: 'flagged',
      reason: 'No active policy found for your organisation. Flagged for manual review.',
      policy_reference: null,
    }

    let previousRejectionContext = null
    if (parentClaimId) {
      const { data: parentClaim } = await supabase
        .from('claims')
        .select('ai_reason, admin_note')
        .eq('id', parentClaimId)
        .single()
      
      if (parentClaim) {
        previousRejectionContext = parentClaim.admin_note || parentClaim.ai_reason || 'Unknown previous error.'
      }
    }

    if (policyChunks.length > 0) {
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0,0,0,0)

      const claimAmount = Number(manualAmount) || extracted.amount || 0
      const claimMerchant = manualMerchant || extracted.merchant || ''
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

      let currentRange = '0-50'
      if (claimAmount >= 50 && claimAmount < 200) currentRange = '50-200'
      else if (claimAmount >= 200 && claimAmount < 1000) currentRange = '200-1000'
      else if (claimAmount >= 1000) currentRange = '1000+'

      const [{ data: limitConfig }, { data: monthClaims }, { data: orgConfig }, { data: baselineRows }, { data: recentFeedback }] = await Promise.all([
        admin
          .from('spend_limits')
          .select('monthly_limit, currency')
          .eq('seniority', roleSeniority)
          .eq('category', roleCategory)
          .single(),
        admin
          .from('claims')
          .select('amount')
          .eq('employee_id', user.id)
          .eq('category', roleCategory)
          .in('status', ['approved', 'pending'])
          .gte('created_at', startOfMonth.toISOString()),
        admin
          .from('organisations')
          .select('auto_approve_threshold')
          .eq('id', orgId)
          .single(),
        admin
          .from('claims')
          .select('amount')
          .eq('organisation_id', orgId)
          .eq('employee_department', roleDepartment)
          .eq('employee_seniority', roleSeniority)
          .eq('category', roleCategory)
          .eq('status', 'approved')
          .eq('location_country', locationCountry)
          .eq('location_city', locationCity)
          .not('amount', 'is', null)
          .gte('created_at', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString())
          .limit(500),
        admin
          .from('verdict_feedback')
          .select('category, amount_range, original_ai_verdict, admin_verdict, admin_reason')
          .eq('organisation_id', orgId)
          .eq('category', roleCategory)
          .order('created_at', { ascending: false })
          .limit(30)
      ])

      // ── Duplicate Detection (30-day pre-inference check) ─────
      const { data: duplicateClaims } = await supabase
        .from('claims')
        .select('id, created_at, amount')
        .eq('employee_id', user.id)
        .ilike('merchant', `%${claimMerchant}%`)
        .gte('created_at', thirtyDaysAgo)
        .limit(5)

      const isDuplicate = duplicateClaims?.some(
        (c) => Math.abs(Number(c.amount) - claimAmount) < 5
      ) ?? false

      const duplicateDate = isDuplicate
        ? duplicateClaims?.find(c => Math.abs(Number(c.amount) - claimAmount) < 5)?.created_at
        : null

      const currentMonthlySpend = monthClaims?.reduce((sum, c) => sum + Number(c.amount || 0), 0) ?? 0

      const baselineAmounts = (baselineRows || [])
        .map((r: any) => Number(r.amount))
        .filter((v: number) => Number.isFinite(v) && v > 0)

      const baselineMedian = median(baselineAmounts)
      const baselineStddevRaw = standardDeviation(baselineAmounts)
      const baselineStddev = baselineStddevRaw > 0 ? baselineStddevRaw : 1
      const zScore = baselineAmounts.length >= 5
        ? (claimAmount - baselineMedian) / baselineStddev
        : 0

      // Store/recompute latest cohort baseline for fast lookup and trendability.
      if (baselineAmounts.length >= 5) {
        await admin
          .from('statistical_baselines')
          .upsert({
            organisation_id: orgId,
            department: roleDepartment,
            seniority: roleSeniority,
            category: roleCategory,
            location_country: locationCountry,
            median_amount: baselineMedian,
            stddev_amount: baselineStddevRaw,
            sample_size: baselineAmounts.length,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'organisation_id,department,seniority,category,location_country',
          })
      }

      const structuredLimit = limitConfig ? {
        limit: limitConfig.monthly_limit,
        currency: limitConfig.currency,
        currentSpend: currentMonthlySpend,
      } : null

      let sortedFeedback: any[] = []
      if (recentFeedback && recentFeedback.length > 0) {
        sortedFeedback = [...recentFeedback].sort((a, b) => {
          if (a.amount_range === currentRange && b.amount_range !== currentRange) return -1
          if (a.amount_range !== currentRange && b.amount_range === currentRange) return 1
          return 0
        }).slice(0, 10)
      }

      const args = {
        merchant: manualMerchant || extracted.merchant || 'Unknown',
        amount: Number(manualAmount) || extracted.amount || 0,
        currency: extracted.currency || 'INR',
        date: extracted.date || new Date().toISOString().split('T')[0],
        category: manualCategory || extracted.category || 'other',
        businessPurpose,
        employeeLocation: profile?.location || 'Unknown',
        employeeSeniority: roleSeniority,
        policyChunks,
        structuredLimit,
        overrideFeedback: sortedFeedback.length > 0 ? sortedFeedback : null,
        statisticalBaseline: baselineAmounts.length >= 5 ? {
          department: roleDepartment,
          locationCity,
          locationCountry,
          median: baselineMedian,
          stddev: baselineStddevRaw,
          zScore,
          sampleSize: baselineAmounts.length,
        } : null,
        previousRejectionContext: previousRejectionContext
          ? `${previousRejectionContext}${isDuplicate ? ` Additionally, a potential duplicate was detected from ${new Date(duplicateDate!).toLocaleDateString()}.` : ''}`
          : isDuplicate
          ? `NOTE: This employee submitted a similar claim for the same merchant (${claimMerchant}) on ${new Date(duplicateDate!).toLocaleDateString()}. Evaluate whether the business purpose justifies a second purchase. Flag as potential duplicate if insufficient justification.`
          : null
      }
      const deterministic = buildFastVerdict({
        claimAmount,
        claimCurrency: extracted.currency || 'INR',
        policyChunks,
        structuredLimit,
      })

      try {
        verdictData = await withTimeout(generateVerdict(args), 25000, 'Verdict generation')
      } catch (err: any) {
        console.warn('[Verdict Gen] Failed/timeout, using fallback:', err.message)
        verdictData = deterministic
      }

      // ── Compute requires_review ───────────────────────────────
      const confidence = (verdictData as any).confidence ?? 0.5
      const autoApproveThreshold = orgConfig?.auto_approve_threshold ?? 1000
      const requiresReview = confidence < 0.7 || claimAmount > autoApproveThreshold

      // Attach computed values for use in the insert below
      ;(verdictData as any)._confidence = confidence
      ;(verdictData as any)._requiresReview = requiresReview
      ;(verdictData as any)._isDuplicate = isDuplicate
    } // end if (policyChunks.length > 0)

    // ── Step 6: Save claim with organisation_id ───────────────
    const { data: claim, error: claimError } = await admin
      .from('claims')
      .insert({
        organisation_id: orgId,          // ← multi-tenancy
        employee_id: user.id,
        parent_claim_id: parentClaimId || null,
        receipt_url: publicUrl,
        merchant: manualMerchant || extracted.merchant,
        amount: manualAmount ? Number(manualAmount) : extracted.amount,
        currency: extracted.currency,
        receipt_date: extracted.date,
        category: manualCategory || extracted.category,
        employee_department: roleDepartment,
        employee_seniority: roleSeniority,
        location_country: locationCountry,
        location_city: locationCity,
        business_purpose: businessPurpose,
        ai_verdict: verdictData.verdict,
        ai_reason: verdictData.reason,
        policy_reference: verdictData.policy_reference,
        status: verdictData.verdict === 'approved' ? 'approved' : verdictData.verdict,
        confidence: (verdictData as any)._confidence ?? null,
        requires_review: (verdictData as any)._requiresReview ?? false,
        is_duplicate_warning: (verdictData as any)._isDuplicate ?? false,
      })
      .select().single()

    if (claimError) throw claimError

    if (quickExtractSuggestionRaw) {
      try {
        const suggestion = JSON.parse(quickExtractSuggestionRaw)

        const normalizeStr = (v: unknown) => String(v ?? '').trim().toLowerCase()
        const normalizeAmt = (v: unknown) => {
          const n = Number(v)
          return Number.isFinite(n) ? Number(n.toFixed(2)) : null
        }

        const suggested = {
          merchant: normalizeStr(suggestion?.merchant),
          amount: normalizeAmt(suggestion?.amount),
          currency: normalizeStr(suggestion?.currency || 'INR'),
          date: normalizeStr(suggestion?.date),
        }

        const finalValues = {
          merchant: normalizeStr(manualMerchant || extracted?.merchant),
          amount: normalizeAmt(manualAmount || extracted?.amount),
          currency: normalizeStr((manualCurrency || extracted?.currency || 'INR')),
          date: normalizeStr((manualDate || extracted?.date)),
        }

        const correctedFields: string[] = []
        const comparableFields = ['merchant', 'amount', 'currency', 'date'] as const
        let compared = 0

        for (const field of comparableFields) {
          const suggestionValue = suggested[field]
          const finalValue = finalValues[field]
          if (suggestionValue == null || suggestionValue === '' || finalValue == null || finalValue === '') continue
          compared += 1
          if (suggestionValue !== finalValue) correctedFields.push(field)
        }

        const correctionRate = compared > 0 ? correctedFields.length / compared : 0

        await admin.from('audit_logs').insert({
          organisation_id: orgId,
          actor_id: user.id,
          action: 'quick_extract_correction',
          entity_type: 'claim',
          entity_id: claim.id,
          metadata: {
            suggestion,
            final: {
              merchant: manualMerchant || extracted?.merchant || null,
              amount: manualAmount ? Number(manualAmount) : extracted?.amount ?? null,
              currency: (manualCurrency || extracted?.currency || 'INR')?.toUpperCase(),
              date: manualDate || extracted?.date || null,
            },
            corrected_fields: correctedFields,
            compared_fields: compared,
            correction_rate: correctionRate,
            suggestion_confidence: Number(suggestion?.confidence ?? 0),
          },
        })
      } catch (quickExtractLogErr: any) {
        console.warn('quick_extract_correction audit log failed:', quickExtractLogErr?.message)
      }
    }

    // ── Step 7: Fire-and-forget emails ───────────────────────
    if (profile?.email) {
      if (verdictData.verdict === 'approved' || verdictData.verdict === 'rejected') {
        const amt = Number(extracted.amount || 0)
        sendEmail({
          to: profile.email,
          subject: `Expense Claim ${verdictData.verdict.toUpperCase()} - PolicyLens`,
          html: verdictTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'INR', verdictData.verdict, verdictData.reason)
        })
      } else if (verdictData.verdict === 'flagged') {
        const amt = Number(extracted.amount || 0)
        sendEmail({
          to: profile.email,
          subject: 'Claim Submitted Successfully - PolicyLens',
          html: submissionConfirmationTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'INR')
        })
        // Alert only admins within this org
        admin
          .from('profiles')
          .select('email')
          .eq('role', 'admin')
          .eq('organisation_id', orgId)   // ← scoped to org
          .then(({ data: admins }) => {
            const emails = admins?.map((a: any) => a.email).filter(Boolean) ?? []
            if (emails.length > 0) {
              sendEmail({
                to: emails,
                subject: 'New Claim Flagged for Review - PolicyLens',
                html: adminFlaggedAlertTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'INR', verdictData.reason)
              })
            }
          })
      }
    }

    return NextResponse.json({
      success: true,
      claim,
      extracted,
      verdict: verdictData,
      compared_policies: comparedPolicies,
      policy_chunks_used: policyChunks.length,
    })
  } catch (err: any) {
    console.error('Analyze error:', err)
    return NextResponse.json({ error: err.message || 'Analysis failed' }, { status: 500 })
  }
}
