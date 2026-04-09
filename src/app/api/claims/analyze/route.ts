import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { extractReceiptData, generateVerdict, embedText } from '@/lib/gemini'
import { sendEmail, resubmissionTemplate, verdictTemplate, submissionConfirmationTemplate, adminFlaggedAlertTemplate } from '@/lib/email'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Rate Limiting Check
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

    const { data: profile } = await admin
      .from('profiles')
      .select('location, seniority, role, full_name, email')
      .eq('id', user.id).single()

    const formData = await request.formData()
    const file = formData.get('receipt') as File
    const businessPurpose = formData.get('business_purpose') as string

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
    
    if (hex.startsWith('FFD8FF')) { isValidType = true; actualType = 'image/jpeg' }
    else if (hex.startsWith('89504E47')) { isValidType = true; actualType = 'image/png' }
    else if (hex.startsWith('52494646')) { isValidType = true; actualType = 'image/webp' }
    else if (hex.startsWith('25504446')) { isValidType = true; actualType = 'application/pdf' }

    if (!isValidType) {
      return NextResponse.json({ error: 'Only JPG, PNG, WebP, and PDF accepted. Actual type invalid.' }, { status: 400 })
    }

    // Upload receipt to storage
    const ext = actualType.split('/')[1]
    const fileName = `${user.id}/${Date.now()}.${ext}`

    const { error: uploadError } = await admin.storage
      .from('receipts')
      .upload(fileName, buffer, { contentType: file.type })
    if (uploadError) throw uploadError

    const { data: { publicUrl } } = admin.storage
      .from('receipts').getPublicUrl(fileName)

    // Step 1: OCR
    const imageBase64 = buffer.toString('base64')
    let extracted;
    try {
      extracted = await extractReceiptData(imageBase64, file.type)
    } catch(err) {
      // Retry once
      try {
        extracted = await extractReceiptData(imageBase64, file.type)
      } catch(err2) {
        return NextResponse.json({
          success: true,
          verdict: {
            verdict: 'flagged',
            reason: 'AI response parsing failed — flagged for manual review.',
            policy_reference: null
          }
        })
      }
    }

    // If unreadable → return early without saving
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
        message: 'The receipt image is unclear or unreadable. Please upload a clearer photo with better lighting.',
      })
    }

    // Step 2: Embed category + purpose for RAG search
    const searchQuery = `${extracted.category} expense: ${businessPurpose}`
    const queryEmbedding = await embedText(searchQuery)

    // Step 3: Vector search for relevant policy chunks
    const { data: chunks } = await admin.rpc('match_policy_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 4,
    })

    const policyChunks: string[] = chunks?.map((c: any) => c.content) ?? []

    // Step 4: Generate verdict
    let verdictData = { verdict: 'flagged', reason: 'No active policy found. Flagged for manual review.', policy_reference: null }

    if (policyChunks.length > 0) {
      try {
        verdictData = await generateVerdict({
          merchant: extracted.merchant ?? 'Unknown',
          amount: extracted.amount ?? 0,
          currency: extracted.currency ?? 'USD',
          date: extracted.date ?? new Date().toISOString().split('T')[0],
          category: extracted.category ?? 'other',
          businessPurpose,
          employeeLocation: profile?.location ?? 'Unknown',
          employeeSeniority: profile?.seniority ?? 'mid',
          policyChunks,
        })
      } catch (err) {
        // Retry logic for JSON parsing error
        try {
          verdictData = await generateVerdict({
            merchant: extracted.merchant ?? 'Unknown',
            amount: extracted.amount ?? 0,
            currency: extracted.currency ?? 'USD',
            date: extracted.date ?? new Date().toISOString().split('T')[0],
            category: extracted.category ?? 'other',
            businessPurpose,
            employeeLocation: profile?.location ?? 'Unknown',
            employeeSeniority: profile?.seniority ?? 'mid',
            policyChunks,
          })
        } catch (err2) {
           verdictData = { verdict: 'flagged', reason: 'AI response parsing failed — flagged for manual review.', policy_reference: null }
        }
      }
    }

    // Step 5: Save claim
    const { data: claim, error: claimError } = await admin
      .from('claims')
      .insert({
        employee_id: user.id,
        receipt_url: publicUrl,
        merchant: extracted.merchant,
        amount: extracted.amount,
        currency: extracted.currency,
        receipt_date: extracted.date,
        category: extracted.category,
        business_purpose: businessPurpose,
        ai_verdict: verdictData.verdict,
        ai_reason: verdictData.reason,
        policy_reference: verdictData.policy_reference,
        status: verdictData.verdict === 'approved' ? 'approved' : verdictData.verdict,
      })
      .select().single()

    if (claimError) throw claimError

    // Asynchronously send emails (don't block the request)
    if (profile?.email) {
      if (verdictData.verdict === 'approved' || verdictData.verdict === 'rejected') {
        const amt = Number(extracted.amount || 0);
        sendEmail({
          to: profile.email,
          subject: `Expense Claim ${verdictData.verdict.toUpperCase()} - PolicyLens`,
          html: verdictTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD', verdictData.verdict, verdictData.reason)
        })
      } else if (verdictData.verdict === 'flagged') {
        const amt = Number(extracted.amount || 0);
        sendEmail({
          to: profile.email,
          subject: 'Claim Submitted Successfully - PolicyLens',
          html: submissionConfirmationTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD')
        })

        // Alert admins
        admin.from('profiles').select('email').eq('role', 'admin').then(({ data: admins }) => {
          if (admins && admins.length > 0) {
            const adminEmails = admins.map((a: any) => a.email).filter(Boolean)
            if (adminEmails.length > 0) {
              sendEmail({
                to: adminEmails,
                subject: 'New Claim Flagged for Review - PolicyLens',
                html: adminFlaggedAlertTemplate(profile.full_name, extracted.merchant ?? 'Unknown', amt, extracted.currency ?? 'USD', verdictData.reason)
              })
            }
          }
        })
      }
    }

    return NextResponse.json({
      success: true,
      claim,
      extracted,
      verdict: verdictData,
    })
  } catch (err: any) {
    console.error('Analyze error:', err)
    return NextResponse.json({ error: err.message || 'Analysis failed' }, { status: 500 })
  }
}
