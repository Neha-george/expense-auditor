import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { extractReceiptData, generateVerdict, embedText } from '@/lib/gemini'
import { sendEmail, resubmissionTemplate, verdictTemplate, submissionConfirmationTemplate, adminFlaggedAlertTemplate } from '@/lib/email'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

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
      .select('location, seniority, role, full_name, email, organisation_id')
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
    } catch {
      try {
        extracted = await extractReceiptData(imageBase64, actualType)
      } catch {
        return NextResponse.json({
          success: true,
          verdict: { verdict: 'flagged', reason: 'AI response parsing failed — flagged for manual review.', policy_reference: null }
        })
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
    let verdictData = {
      verdict: 'flagged',
      reason: 'No active policy found for your organisation. Flagged for manual review.',
      policy_reference: null as string | null,
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

      const [{ data: limitConfig }, { data: monthClaims }] = await Promise.all([
        supabase
          .from('spend_limits')
          .select('monthly_limit, currency')
          .eq('seniority', profile?.seniority ?? 'mid')
          .eq('category', manualCategory || extracted.category || 'other')
          .single(),
        supabase
          .from('claims')
          .select('amount')
          .eq('employee_id', user.id)
          .eq('category', manualCategory || extracted.category || 'other')
          .in('status', ['approved', 'pending'])
          .gte('created_at', startOfMonth.toISOString())
      ])

      const currentMonthlySpend = monthClaims?.reduce((sum, c) => sum + Number(c.amount || 0), 0) ?? 0

      const structuredLimit = limitConfig ? {
        limit: limitConfig.monthly_limit,
        currency: limitConfig.currency,
        currentSpend: currentMonthlySpend,
      } : null

      const args = {
        merchant: manualMerchant || extracted.merchant || 'Unknown',
        amount: Number(manualAmount) || extracted.amount || 0,
        currency: extracted.currency || 'USD',
        date: extracted.date || new Date().toISOString().split('T')[0],
        category: manualCategory || extracted.category || 'other',
        businessPurpose,
        employeeLocation: profile?.location || 'Unknown',
        employeeSeniority: profile?.seniority || 'mid',
        policyChunks,
        structuredLimit,
        previousRejectionContext
      }
      try {
        verdictData = await generateVerdict(args)
      } catch {
        try {
          verdictData = await generateVerdict(args)
        } catch {
          verdictData = { verdict: 'flagged', reason: 'AI response parsing failed — flagged for manual review.', policy_reference: null }
        }
      }
    }

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
        business_purpose: businessPurpose,
        ai_verdict: verdictData.verdict,
        ai_reason: verdictData.reason,
        policy_reference: verdictData.policy_reference,
        status: verdictData.verdict === 'approved' ? 'approved' : verdictData.verdict,
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
