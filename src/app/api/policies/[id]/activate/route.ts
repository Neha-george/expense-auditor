import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> } | { params: { id: string } }
) {
  // In Next.js 15, `params` is a Promise and needs to be awaited if we use it,
  // but for backward compatibility and as per the prompt's simplicity we will await it.
  const resolvedParams = await params;
  
  const supabase = await createServerSupabase()
  const admin = createAdminSupabase()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await admin
    .from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Deactivate all, then activate the selected one
  await admin.from('policy_documents').update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000') // using a valid uuid format to satisfy type checker or just simple neq
  await admin.from('policy_documents')
    .update({ is_active: true }).eq('id', resolvedParams.id)

  return NextResponse.json({ success: true })
}
