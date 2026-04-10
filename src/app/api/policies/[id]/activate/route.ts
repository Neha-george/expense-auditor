import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await params

    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError) {
      console.error('Policy activate auth error:', authError)
      return NextResponse.json({ error: 'Authentication service is temporarily unavailable. Please retry.' }, { status: 503 })
    }
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    if (profileError) {
      console.error('Policy activate profile lookup error:', profileError)
      return NextResponse.json({ error: 'Unable to validate user profile. Please retry.' }, { status: 503 })
    }

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    // Ensure target policy belongs to the caller org before mutating active flags.
    const { data: targetPolicy, error: targetError } = await admin
      .from('policy_documents')
      .select('id')
      .eq('id', resolvedParams.id)
      .eq('organisation_id', orgId)
      .maybeSingle()

    if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 })
    if (!targetPolicy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 })

    // Deactivate ALL policies belonging to THIS org only, then activate the chosen one.
    const { error: deactivateError } = await admin
      .from('policy_documents')
      .update({ is_active: false })
      .eq('organisation_id', orgId)

    if (deactivateError) return NextResponse.json({ error: deactivateError.message }, { status: 500 })

    const { error } = await admin
      .from('policy_documents')
      .update({ is_active: true })
      .eq('id', resolvedParams.id)
      .eq('organisation_id', orgId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Policy activate error:', err)
    return NextResponse.json({ error: err?.message || 'Activation failed' }, { status: 500 })
  }
}
