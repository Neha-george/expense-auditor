import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { generateVerdict, embedText } from '@/lib/gemini'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'Org not found' }, { status: 403 })

    const payload = await request.json()
    const rows = payload.rows

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }

    const results = []

    for (const row of rows) {
      // Basic bounds check
      const amount = Number(row.amount) || 0
      const category = (row.category || 'other').toLowerCase()
      
      const [{ data: limitConfig }, { data: matches }] = await Promise.all([
         supabase.from('spend_limits')
           .select('monthly_limit, currency')
           .eq('seniority', 'mid') // Standard baseline for generic CSV dry-runs
           .eq('category', category)
           .single(),
         admin.rpc('match_policy_chunks', {
            query_embedding: JSON.stringify(await embedText(`${category} expense: ${row.business_purpose}`)),
            match_count: 4,
            p_organisation_id: orgId
         })
      ])

      const policyChunks: string[] = matches?.map((c: any) => c.content) ?? []

      if (policyChunks.length > 0) {
        const structuredLimit = limitConfig ? {
          limit: limitConfig.monthly_limit,
          currency: limitConfig.currency,
          currentSpend: 0 // Historical dry-run
        } : null

        const args = {
          merchant: row.merchant || 'Unknown',
          amount,
          currency: row.currency || 'INR',
          date: row.date || new Date().toISOString().split('T')[0],
          category,
          businessPurpose: row.business_purpose || '',
          employeeLocation: 'Unknown',
          employeeSeniority: 'mid',
          policyChunks,
          structuredLimit,
          previousRejectionContext: null
        }
        
        try {
          const verdictData = await generateVerdict(args)
          results.push({ ...row, verdict: verdictData.verdict, reason: verdictData.reason })
        } catch (e) {
          results.push({ ...row, verdict: 'flagged', reason: 'AI rate limit / failure' })
        }
      } else {
        results.push({ ...row, verdict: 'flagged', reason: 'No active policy found' })
      }
    }

    return NextResponse.json({ success: true, results })
  } catch (err: any) {
    console.error(err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
