import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase, getOrgId } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
  try {
    // Use RLS-enabled client for auth + profile reads
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const exportCsv = searchParams.get('export') === 'true'

    // RLS handles row-level isolation; we still explicitly filter by org_id
    // for defence-in-depth (and to support the admin view).
    let query = supabase
      .from('claims')
      .select('*, profiles!claims_employee_id_fkey(full_name, email, department, location)')
      .eq('organisation_id', orgId)
      .order('created_at', { ascending: false })

    // Employees only see their own claims (RLS enforces this too)
    if (profile?.role !== 'admin') {
      query = query.eq('employee_id', user.id)
    }
    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    const { data: claims, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (exportCsv && profile?.role === 'admin') {
      const headers = [
        'id','employee','email','merchant','amount','currency','date',
        'category','business_purpose','ai_verdict','ai_reason',
        'policy_reference','status','created_at',
      ]
      const rows = claims!.map(c => [
        c.id, (c.profiles as any)?.full_name, (c.profiles as any)?.email,
        c.merchant, c.amount, c.currency, c.receipt_date,
        c.category, `"${c.business_purpose}"`, c.ai_verdict,
        `"${c.ai_reason}"`, `"${c.policy_reference}"`, c.status, c.created_at,
      ])
      const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="claims-export.csv"',
        },
      })
    }

    return NextResponse.json({ claims })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
