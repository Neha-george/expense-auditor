import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { extractReceiptData, generateVerdict, embedText } from '@/lib/gemini'
import { sendEmail, resubmissionTemplate, verdictTemplate, submissionConfirmationTemplate, adminFlaggedAlertTemplate } from '@/lib/email'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

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

    // ── Step 1: OCR ───────────────────────────────────────────
    const imageBase64 = buffer.toString('base64')
    let extracted: any
    try {
      extracted = await extractReceiptData(imageBase64, actualType)
    } catch (e1: any) {
      console.warn("OCR Attempt 1 failed:", e1.message)
      try {
        extracted = await extractReceiptData(imageBase64, actualType)
      } catch (e2: any) {
        console.error("OCR Attempt 2 failed:", e2.message)
        // Fallback so the frontend doesn't crash on undefined 'amount', and so the claim still saves in the DB
        extracted = {
          is_readable: true,
          merchant: manualMerchant || 'Unknown Merchant (OCR Failed)',
          amount: Number(manualAmount) || 0,
          currency: 'USD',
          date: new Date().toISOString().split('T')[0],
          category: manualCategory || 'other',
          confidence: 'low'
        }
      }
    }

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

    // ── Step 2: Embed for vector search ──────────────────────
    const searchQuery = `${extracted.category} expense: ${businessPurpose}`
    const queryEmbedding = await embedText(searchQuery)

    // ── Step 3: Org-isolated vector search ───────────────────
    const { data: chunks } = await admin.rpc('match_policy_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 4,
      p_organisation_id: orgId,         // ← KEY: tenant isolation
    })
    const policyChunks: string[] = chunks?.map((c: any) => c.content) ?? []

    // ── Step 4: Generate verdict ──────────────────────────────
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
        supabase
          .from('spend_limits')
          .select('monthly_limit, currency')
          .eq('seniority', roleSeniority)
          .eq('category', roleCategory)
          .single(),
        supabase
          .from('claims')
          .select('amount')
          .eq('employee_id', user.id)
          .eq('category', roleCategory)
          .in('status', ['approved', 'pending'])
          .gte('created_at', startOfMonth.toISOString()),
        supabase
          .from('organisations')
          .select('auto_approve_threshold')
          .eq('id', orgId)
          .single(),
        supabase
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
        supabase
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
        currency: extracted.currency || 'USD',
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
      try {
        verdictData = await generateVerdict(args)
      } catch {
        try {
          verdictData = await generateVerdict(args)
        } catch {
          verdictData = { verdict: 'flagged', reason: 'AI response parsing failed — flagged for manual review.', policy_reference: null, confidence: 0.5 }
        }
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

    // ── Step 5: Save claim with organisation_id ───────────────
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

    // ── Step 6: Fire-and-forget emails ───────────────────────
    if (profile?.email) {
      if (verdictData.verdict === 'approved' || verdictData.verdict === 'rejected') {
        const amt = Number(extracted.amount || 0)
        sendEmail({
          to: profile.email,
          subject: `Expense Claim ${verdictData.verdict.toUpperCase()} - PolicyLens`,
          html: verdictTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD', verdictData.verdict, verdictData.reason)
        })
      } else if (verdictData.verdict === 'flagged') {
        const amt = Number(extracted.amount || 0)
        sendEmail({
          to: profile.email,
          subject: 'Claim Submitted Successfully - PolicyLens',
          html: submissionConfirmationTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD')
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
                html: adminFlaggedAlertTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD', verdictData.reason)
              })
            }
          })
      }
    }

    return NextResponse.json({ success: true, claim, extracted, verdict: verdictData })
  } catch (err: any) {
    console.error('Analyze error:', err)
    return NextResponse.json({ error: err.message || 'Analysis failed' }, { status: 500 })
  }
}
