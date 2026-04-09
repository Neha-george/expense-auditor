import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'
import { generatePolicyClause } from '@/lib/gemini'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', profile.organisation_id)
      .single()

    const body = await request.json()
    const title = String(body?.title || '').trim()
    const why = String(body?.why || '').trim()
    const tone = (body?.tone === 'strict' || body?.tone === 'balanced' || body?.tone === 'lenient')
      ? body.tone
      : 'balanced'

    if (!title || !why) {
      return NextResponse.json({ error: 'title and why are required' }, { status: 400 })
    }

    const clause = await generatePolicyClause({
      recommendationTitle: title,
      recommendationWhy: why,
      organisationName: org?.name || null,
      tone,
    })

    return NextResponse.json({ success: true, clause })
  } catch (err: any) {
    console.error('Generate clause error:', err)
    return NextResponse.json({ error: err.message || 'Failed to generate clause' }, { status: 500 })
  }
}
