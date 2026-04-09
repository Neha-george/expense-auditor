import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
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

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const { data, error } = await supabase
      .from('gl_account_mappings')
      .select('*')
      .eq('organisation_id', orgId)
      .order('category', { ascending: true })

    if (error) throw error

    return NextResponse.json({ mappings: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

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

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const body = await request.json()
    const { category, gl_code, gl_description } = body

    if (!category || !gl_code) {
      return NextResponse.json({ error: 'Category and GL code are required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('gl_account_mappings')
      .upsert({
        organisation_id: orgId,
        category,
        gl_code,
        gl_description,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'organisation_id,category'
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ mapping: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
