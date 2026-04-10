import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'
import { generatePolicyClause } from '@/lib/gemini'

function isQuotaOrRateLimitError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '')
  const lower = msg.toLowerCase()
  return lower.includes('429') || lower.includes('too many requests') || lower.includes('quota') || lower.includes('rate limit')
}

function buildLocalClauseDraft(params: {
  title: string
  why: string
  organisationName?: string | null
  tone: 'strict' | 'balanced' | 'lenient'
}) {
  const org = params.organisationName || 'the organisation'
  const tonePrefix = params.tone === 'strict'
    ? 'must'
    : params.tone === 'lenient'
    ? 'should'
    : 'must'

  return {
    title: params.title,
    clause_text: `For ${org}, expenses under "${params.title}" ${tonePrefix} include a clear business purpose, valid receipt evidence, and required approver sign-off before reimbursement. Claims missing these requirements ${tonePrefix} be flagged for manual review. Where limits or eligibility are unclear, the claim ${tonePrefix} be escalated to the finance/admin reviewer with supporting notes.`,
    rationale: `Fallback draft generated because AI quota is currently unavailable. This clause addresses: ${params.why}`,
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

    try {
      const clause = await generatePolicyClause({
        recommendationTitle: title,
        recommendationWhy: why,
        organisationName: org?.name || null,
        tone,
      })

      return NextResponse.json({ success: true, clause, source: 'ai' })
    } catch (genErr: any) {
      if (isQuotaOrRateLimitError(genErr)) {
        const fallbackClause = buildLocalClauseDraft({
          title,
          why,
          organisationName: org?.name || null,
          tone,
        })

        return NextResponse.json({
          success: true,
          clause: fallbackClause,
          source: 'fallback',
          warning: 'AI quota exceeded. Generated a local draft instead.',
        })
      }
      throw genErr
    }
  } catch (err: any) {
    console.error('Generate clause error:', err)
    return NextResponse.json({ error: 'Failed to generate clause. Please retry shortly.' }, { status: 500 })
  }
}
