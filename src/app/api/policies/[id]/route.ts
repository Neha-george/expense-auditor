import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

async function requireAdmin() {
  const supabase = await createServerSupabase()
  const admin = createAdminSupabase()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError) {
    return {
      error: NextResponse.json(
        { error: 'Authentication service is temporarily unavailable. Please retry.' },
        { status: 503 }
      ),
    }
  }

  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (profileError) {
    return {
      error: NextResponse.json({ error: 'Unable to validate user profile. Please retry.' }, { status: 503 }),
    }
  }

  if (profile?.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  if (!profile.organisation_id) {
    return { error: NextResponse.json({ error: 'No organisation found' }, { status: 403 }) }
  }

  return { admin, organisationId: profile.organisation_id }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const resolvedParams = await params

    const { data: policy, error: policyError } = await auth.admin
      .from('policy_documents')
      .select('id, name, file_path, organisation_id')
      .eq('id', resolvedParams.id)
      .eq('organisation_id', auth.organisationId)
      .maybeSingle()

    if (policyError) return NextResponse.json({ error: policyError.message }, { status: 500 })
    if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 })
    if (!policy.file_path) return NextResponse.json({ error: 'Policy file missing' }, { status: 404 })

    const { data: signed, error: signedError } = await auth.admin.storage
      .from('policy-docs')
      .createSignedUrl(policy.file_path, 60 * 10)

    if (signedError || !signed?.signedUrl) {
      return NextResponse.json({ error: signedError?.message || 'Failed to create view URL' }, { status: 500 })
    }

    return NextResponse.json({ success: true, name: policy.name, url: signed.signedUrl })
  } catch (err: any) {
    console.error('Policy view error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to load policy' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const resolvedParams = await params

    const { data: policy, error: policyError } = await auth.admin
      .from('policy_documents')
      .select('id, file_path, organisation_id')
      .eq('id', resolvedParams.id)
      .eq('organisation_id', auth.organisationId)
      .maybeSingle()

    if (policyError) return NextResponse.json({ error: policyError.message }, { status: 500 })
    if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 })

    if (policy.file_path) {
      const { error: removeStorageError } = await auth.admin.storage
        .from('policy-docs')
        .remove([policy.file_path])

      if (removeStorageError) {
        console.warn('Policy file removal warning:', removeStorageError)
      }
    }

    const { error: deleteError } = await auth.admin
      .from('policy_documents')
      .delete()
      .eq('id', resolvedParams.id)
      .eq('organisation_id', auth.organisationId)

    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Policy delete error:', err)
    return NextResponse.json({ error: err?.message || 'Delete failed' }, { status: 500 })
  }
}
