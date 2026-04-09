import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  // Deactivate ALL policies belonging to THIS org only, then activate the chosen one
  await admin
    .from('policy_documents')
    .update({ is_active: false })
    .eq('organisation_id', orgId)        // ← only deactivates within this org

  const { error } = await admin
    .from('policy_documents')
    .update({ is_active: true })
    .eq('id', resolvedParams.id)
    .eq('organisation_id', orgId)        // ← cross-tenant write guard

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
