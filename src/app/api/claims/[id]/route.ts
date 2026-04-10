import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { sendEmail, verdictTemplate } from '@/lib/email'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await params
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin')
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const body = await request.json()
    const { verdict, note } = body

    if (!['approved', 'rejected'].includes(verdict))
      return NextResponse.json({ error: 'verdict must be approved or rejected' }, { status: 400 })

    const { data: currentClaim } = await supabase
      .from('claims')
      .select('ai_verdict, amount, category')
      .eq('id', resolvedParams.id)
      .eq('organisation_id', orgId)
      .single()

    if (!currentClaim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 })

    const isOverride = currentClaim.ai_verdict && currentClaim.ai_verdict !== verdict

    if (isOverride && (!note || !note.trim())) {
      return NextResponse.json({ error: 'Admin override reason is required when changing AI verdict.' }, { status: 400 })
    }

    // Update is scoped to both the claim id AND the org — prevents cross-tenant writes
    const { data, error } = await admin
      .from('claims')
      .update({
        admin_verdict: verdict,
        admin_note: note,
        reviewed_by: user.id,
        status: verdict,
      })
      .eq('id', resolvedParams.id)
      .eq('organisation_id', orgId)        // ← org-scoped write guard
      .select('*, profiles!claims_employee_id_fkey(full_name, email)')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (isOverride) {
      const amt = Number(currentClaim.amount || 0)
      let range = '0-50'
      if (amt >= 50 && amt < 200) range = '50-200'
      else if (amt >= 200 && amt < 1000) range = '200-1000'
      else if (amt >= 1000) range = '1000+'

      await admin.from('verdict_feedback').insert({
        organisation_id: orgId,
        claim_id: data.id,
        category: currentClaim.category,
        amount_range: range,
        original_ai_verdict: currentClaim.ai_verdict,
        admin_verdict: verdict,
        admin_reason: note
      })
    }

    if (data && data.profiles && (data.profiles as any).email) {
      const p = data.profiles as any
      const amt = Number(data.amount || 0)
      sendEmail({
        to: p.email,
        subject: `Expense Claim ${verdict.toUpperCase()} (Manual Review) - PolicyLens`,
        html: verdictTemplate(p.full_name, data.merchant ?? 'Unknown', amt, data.currency ?? 'INR', verdict, data.ai_reason ?? 'Manual review', note)
      })
    }

    return NextResponse.json({ claim: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
