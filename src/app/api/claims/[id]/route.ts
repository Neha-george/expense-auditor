import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> } | { params: { id: string } }
) {
  try {
    const resolvedParams = await params;
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin')
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await request.json()
    const { verdict, note } = body

    if (!['approved', 'rejected'].includes(verdict))
      return NextResponse.json({ error: 'verdict must be approved or rejected' }, { status: 400 })

    const { data, error } = await admin
      .from('claims')
      .update({
        admin_verdict: verdict,
        admin_note: note,
        reviewed_by: user.id,
        status: verdict,
      })
      .eq('id', resolvedParams.id)
      .select().single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ claim: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
